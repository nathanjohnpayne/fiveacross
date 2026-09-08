import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventDoc } from '../types';

// specs/post-sailing-archive.md, RTL layer (#1149, epic #134). The Admin console's
// three actions and the states they move between:
//
//   Close play → the quiesce (reversible, gameplay shut, nothing permanent)
//   Reopen play → lifting it, unconditionally, on the Event in front of the Admin
//   Archive → both writes in order, and the only irreversible one
//
// The write functions are `vi.fn()`s because what is under test is the console's
// SEQUENCING and its cleanup decision, not Firestore: `src/data/post-sailing-archive.test.ts`
// pins what each write does, and `tests/rules/post-sailing-archive.test.ts` pins
// what the boundary accepts.

const H = vi.hoisted(() => ({
  event: null as EventDoc | null,
  /** The order the writes were issued in, so the quiesce-first contract is
   *  asserted on the SEQUENCE rather than on each call alone. */
  writes: [] as string[],
  beginArchive: vi.fn(),
  abandonArchive: vi.fn(),
  archiveEvent: vi.fn(),
}));

vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));
vi.mock('../data/admin', () => ({
  beginArchive: (...args: unknown[]) => {
    H.writes.push('begin');
    return H.beginArchive(...args);
  },
  abandonArchive: (...args: unknown[]) => {
    H.writes.push('abandon');
    return H.abandonArchive(...args);
  },
  archiveEvent: (...args: unknown[]) => {
    H.writes.push('archive');
    return H.archiveEvent(...args);
  },
}));

// eslint-disable-next-line import/first -- the component must load AFTER the mocks above.
import ArchiveEvent from './admin/ArchiveEvent';

function mkEvent(over: Partial<EventDoc> = {}): EventDoc {
  return { name: 'Test Event', status: 'active', ...over } as EventDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.event = mkEvent();
  H.writes = [];
  H.beginArchive.mockResolvedValue({ result: 'closing', token: 'quiesce-1', created: true });
  H.abandonArchive.mockResolvedValue('reopened');
  H.archiveEvent.mockResolvedValue('archived');
});

const renderConsole = () => render(<ArchiveEvent event={H.event} />);

describe('ArchiveEvent — the three lifecycle actions (#1149)', () => {
  it('offers Close play and Archive on a LIVE Event, and no way back yet', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
  });

  it('takes the quiesce and nothing else when Close play is pressed', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    // Reversible on purpose: gameplay is shut, and nothing permanent happened.
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
  });

  it('offers Reopen play and Archive on a CLOSING Event, and no second Close play', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 'quiesce-1' });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive the Event now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
  });

  it('reopens UNCONDITIONALLY from the closing-state surface', async () => {
    // A deliberate act on the Event in front of the Admin, not an automatic
    // cleanup of a call that already failed — the token binding exists to stop a
    // STALE handler, and there is no stale handler at this button.
    H.event = mkEvent({ archiving: true, archiveToken: 'quiesce-1' });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(H.abandonArchive).toHaveBeenCalledWith();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is open again/);
  });

  it('runs BOTH writes in order, and binds the flip to the generation the first one left', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    // The order IS the guarantee: gameplay is shut before anything is frozen.
    expect(H.writes).toEqual(['begin', 'archive']);
    expect(H.archiveEvent).toHaveBeenCalledWith('quiesce-1');
    expect(await screen.findByRole('status')).toHaveTextContent(/Archived/);
  });

  it('retires the controls once the Event is archived', () => {
    H.event = mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000, archiving: false });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Archive the Event now' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^Archived /)).toBeInTheDocument();
  });

  it('does not run the second write when the quiesce could not be taken', async () => {
    H.beginArchive.mockResolvedValue({ result: 'already-archived', token: null, created: false });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/Already archived/);
  });
});

// #1142 item 6. `beginArchive` is idempotent: called on an Event already closing
// it preserves the stored generation and reports `'closing'` all the same, so a
// call that merely JOINED another Admin's in-flight quiesce comes back holding a
// token that matches perfectly. An automatic reopen keyed on the token alone
// would then succeed at exactly the write the binding exists to refuse.
describe('ArchiveEvent — only the CREATOR of a quiesce reopens it (#1142 item 6)', () => {
  beforeEach(() => {
    H.archiveEvent.mockRejectedValue(new Error('permission-denied'));
  });

  it('reopens play when the flip fails under a quiesce this call opened', async () => {
    H.beginArchive.mockResolvedValue({ result: 'closing', token: 'quiesce-1', created: true });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    // Conditional on the SAME generation besides, so a quiesce that moved
    // between the flip returning and this cleanup running declines too.
    expect(H.abandonArchive).toHaveBeenCalledWith('quiesce-1');
    expect(H.writes).toEqual(['begin', 'archive', 'abandon']);
  });

  it('LEAVES the Event shut when the flip fails under a quiesce it merely JOINED', async () => {
    // That Event was already closing when this Admin arrived, and **Reopen
    // play** sits beside the button they pressed.
    H.event = mkEvent({ archiving: true, archiveToken: 'quiesce-1' });
    H.beginArchive.mockResolvedValue({ result: 'closing', token: 'quiesce-1', created: false });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.archiveEvent).toHaveBeenCalledTimes(1));
    expect(H.abandonArchive).not.toHaveBeenCalled();
    // The failure is surfaced rather than swallowed.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Archive failed/);
  });

  it('says why play stayed closed when the cleanup finds a newer quiesce in force', async () => {
    H.beginArchive.mockResolvedValue({ result: 'closing', token: 'quiesce-1', created: true });
    H.abandonArchive.mockResolvedValue('quiesce-changed');
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/Play was left closed/);
  });
});
