import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventDoc } from '../types';

// specs/post-sailing-archive.md, RTL layer (#1149, epic #134). The Admin console's
// two actions and the states they move between:
//
//   Close play → the quiesce (reversible, gameplay shut, nothing permanent)
//   Reopen play → lifting it, unconditionally, on the Event in front of the Admin
//
// THE IRREVERSIBLE FLIP IS NOT ON THIS SURFACE (Phase 4b P1 on PR #1157).
// `archiveEvent(token)` ships and is pinned at the data layer by
// `src/data/post-sailing-archive.test.ts`; the console's **Archive** action
// arrives with #1151, together with the pending-claim drain gate and the
// snapshot that make it safe to press. So this file asserts the flip is
// UNREACHABLE from the console — the mock stays wired precisely so a re-added
// button that called it would be caught here — rather than asserting how it
// sequences.
//
// The write functions are `vi.fn()`s because what is under test is the console's
// own behaviour, not Firestore: `src/data/post-sailing-archive.test.ts` pins what
// each write does, and `tests/rules/post-sailing-archive.test.ts` pins what the
// boundary accepts.

const H = vi.hoisted(() => ({
  event: null as EventDoc | null,
  /** The order the writes were issued in, so "no flip from here" is asserted on
   *  the SEQUENCE rather than on one spy alone. */
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
  H.beginArchive.mockResolvedValue({ result: 'closing', token: 1, created: true });
  H.abandonArchive.mockResolvedValue('reopened');
  H.archiveEvent.mockResolvedValue('archived');
});

const renderConsole = () => render(<ArchiveEvent event={H.event} />);

describe('ArchiveEvent — the two lifecycle actions (#1149)', () => {
  it('offers Close play on a LIVE Event, and no way back yet', () => {
    renderConsole();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
  });

  it('takes the quiesce and nothing else when Close play is pressed', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    // Reversible on purpose: gameplay is shut, and nothing permanent happened.
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(H.writes).toEqual(['begin']);
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
  });

  it('offers Reopen play on a CLOSING Event, and no second Close play', () => {
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    expect(screen.getByRole('button', { name: 'Reopen play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
  });

  it('reopens UNCONDITIONALLY from the closing-state surface', async () => {
    // A deliberate act on the Event in front of the Admin, not an automatic
    // cleanup of a call that already failed — the token binding exists to stop a
    // STALE handler, and there is no stale handler at this button.
    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen play' }));
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));
    expect(H.abandonArchive).toHaveBeenCalledWith();
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is open again/);
  });

  it('clears the action message when someone else moves the Event on (Codex P2, PR #1157)', async () => {
    // The message is a sentence about the state the action left the Event in.
    // It stays through the transition this Admin caused, and goes the moment
    // another Admin moves the Event somewhere the sentence no longer describes.
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    // The subscription delivers the closing state this Admin produced: still true.
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: true, archiveToken: 1 })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    // Another Admin archives it: "Reopen play to put it back" is now false.
    view.rerender(
      <ArchiveEvent event={mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 })} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('records the state observed when the action RESOLVES, not the render it started in', async () => {
    // Codex P2, PR #1157 round 7. Another Admin closes the Event while this
    // Close play is still pending: the prop reaches `closing` and the phase
    // effect runs before any result exists. Reporting against the render the
    // click happened in would leave `from: 'open'`, and a later reopen would
    // then match it and keep "Play is closed" beside the open controls.
    let settle: (value: { result: 'closing'; token: number; created: boolean }) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: true, archiveToken: 1 })} />);
    settle({ result: 'closing', token: 1, created: false });
    expect(await screen.findByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: false })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing after a completed ROUND TRIP back to the starting phase', async () => {
    // Phase 4b P2, PR #1157 run 3. Close play commits, another Admin observes
    // it and reopens, and only then does beginArchive() settle: the Event is
    // back where the action started, but equality with the starting phase is
    // not evidence the message is true — the phase moved during the action.
    let settle: (value: { result: 'closing'; token: number; created: boolean }) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: true, archiveToken: 1 })} />);
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: false })} />);
    settle({ result: 'closing', token: 1, created: true });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('shows nothing when the Event has moved somewhere the outcome does not describe', async () => {
    let settle: (value: { result: 'closing'; token: number; created: boolean }) => void = () => {};
    H.beginArchive.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    // Another Admin archives it outright while the close is in flight.
    view.rerender(
      <ArchiveEvent event={mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 })} />,
    );
    settle({ result: 'closing', token: 1, created: true });
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears the closed message when someone else REOPENS the Event underneath it', async () => {
    const view = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await screen.findByRole('status');
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: true, archiveToken: 1 })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Play is closed/);
    view.rerender(<ArchiveEvent event={mkEvent({ archiving: false })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
  });

  it('retires the controls once the Event is archived, and still names the state', () => {
    // The flip can reach the document without this surface (an Admin-SDK edit
    // today, #1151's console action next), so the archived state is rendered
    // even though nothing here can produce it.
    H.event = mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000, archiving: false });
    renderConsole();
    expect(screen.queryByRole('button', { name: 'Close play' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen play' })).not.toBeInTheDocument();
    expect(screen.getByText(/^Archived /)).toBeInTheDocument();
  });
});

// Phase 4b P1 on PR #1157. The exposed Archive control could flip an Event whose
// Claim queue still held an `admin_confirmed` Claim, after which Confirm and
// Reject both fail — `resolve()` writes the claimant's Board and Player row, and
// the freeze denies both — and the console cannot reopen a state it never took.
// The drain gate that refuses to archive over a pending Claim belongs to #1151,
// so the one-way door ships with it rather than ahead of it.
describe('ArchiveEvent — the irreversible flip is not reachable from the console (#1157)', () => {
  it.each([
    ['live', mkEvent()],
    ['closing', mkEvent({ archiving: true, archiveToken: 1 })],
    ['archived', mkEvent({ status: 'archived', archivedAt: 1_700_000_000_000 })],
  ])('offers no Archive control on a %s Event', (_state, event) => {
    H.event = event;
    renderConsole();
    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });

  it('never calls archiveEvent, whichever control the Admin presses', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Close play' }));
    await waitFor(() => expect(H.beginArchive).toHaveBeenCalledTimes(1));

    H.event = mkEvent({ archiving: true, archiveToken: 1 });
    renderConsole();
    await userEvent.click(screen.getAllByRole('button', { name: 'Reopen play' })[0]!);
    await waitFor(() => expect(H.abandonArchive).toHaveBeenCalledTimes(1));

    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(H.writes).toEqual(['begin', 'abandon']);
  });
});
