import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EventDoc, ItemDoc } from '../types';

// specs/admin-async-feedback.md (#411), component layer (RTL-jsdom). Drives the
// REAL Admin console with the data boundary stubbed. Proves the moderation
// actions' reliability affordance: disable-while-pending, an inline
// role=alert failure pill on rejection (retry clears it), a rejected add
// keeps the draft, and a rejected inline save keeps the editor open. The
// actions' write-path wiring itself is pinned by the pre-existing suites
// (Admin.test.tsx / w2-admin-console / w2-ban-console) — this file owns only
// the pending/error behavior layered on top.

const H = vi.hoisted(() => ({
  user: { uid: 'admin-uid' } as { uid: string } | null,
  event: {} as unknown as EventDoc,
  claims: [] as unknown[],
  flagged: [] as unknown[],
  items: [] as ItemDoc[],
  pendingItems: [] as ItemDoc[],
  deleteItem: vi.fn(),
  setItemSpicy: vi.fn(),
  confirmClaim: vi.fn(),
  unbanUser: vi.fn(),
  adminAddItem: vi.fn(),
  adminUpdateItemText: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
// #559: ReviewQueue (mounted via Admin) now imports `track`, reaching
// `../analytics` — mocked directly so the real module's own `../firebase`
// (analyticsReady) dependency never has to be satisfied here.
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...a: unknown[]) => makeRef('doc', a),
    collection: (...a: unknown[]) => makeRef('collection', a),
    query: (...a: unknown[]) => ({ query: a }),
    where: (...a: unknown[]) => ({ where: a }),
    onSnapshot: vi.fn(() => () => {}),
  };
});
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  return {
    ...actual,
    useEventDoc: () => ({ data: H.event, loading: false, hasServerData: true }),
    usePendingClaims: () => ({ claims: H.claims }),
    usePendingItems: () => ({ items: H.pendingItems, loading: false }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: H.items, loading: false }),
  };
});
vi.mock('../data/admin', () => ({
  confirmClaim: (...a: unknown[]) => H.confirmClaim(...a),
  rejectClaim: vi.fn(),
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: (...a: unknown[]) => H.deleteItem(...a),
  clearItemReports: vi.fn(),
  approveItem: vi.fn(),
  rejectItem: vi.fn(),
  bulkApproveItems: vi.fn(),
  setItemSpicy: (...a: unknown[]) => H.setItemSpicy(...a),
  adminAddItem: (...a: unknown[]) => H.adminAddItem(...a),
  adminUpdateItemText: (...a: unknown[]) => H.adminUpdateItemText(...a),
  setClaimMode: vi.fn(),
  setEventTheme: vi.fn(),
  setDayTheme: vi.fn(),
  setDayTonight: vi.fn(),
  setPhotoProofSource: vi.fn(),
  setStripPhotoExif: vi.fn(),
  setVisionGate: vi.fn(),
  setReportHideThreshold: vi.fn(),
  setEasyMixRatio: vi.fn(),
  banUser: vi.fn(),
  unbanUser: (...a: unknown[]) => H.unbanUser(...a),
  unlockDayNow: vi.fn(),
  resnapshotDayNow: vi.fn(),
}));
vi.mock('../data/proofs', () => ({ deleteProof: vi.fn() }));
// Admin pickers read the EDITION-SCOPED list, not the registry (#555).
vi.mock('../theme/themes', () => {
  const THEMES = [{ id: 'neon-playground', emoji: '🎉', label: 'Neon' }];
  return { THEMES, themesForEdition: () => THEMES, themesForEditionIncluding: () => THEMES };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));

import Admin from './Admin';
import { UNSAVED_WORK_ATTRIBUTE } from '../swClientBridge';

const renderAdmin = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Admin />
    </MemoryRouter>,
  );

const item = (id: string, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: `u-${id}`,
    createdAt: 1,
    isFreeSpace: false,
    status: 'active',
    reportCount: 0,
    spicy: false,
    pool: 'main',
    ...over,
  }) as ItemDoc;

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'admin-uid' };
  H.event = {
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'admin_confirmed',
    defaultTheme: 'neon-playground',
    bannedUids: [],
    days: [],
  } as unknown as EventDoc;
  H.claims = [];
  H.flagged = [];
  H.items = [];
  H.pendingItems = [];
});

describe('AsyncButton affordance on moderation actions (specs/admin-async-feedback.md)', () => {
  it('a rejected delete shows the inline alert pill; retrying after the failure clears it on success', async () => {
    H.items = [item('i1', { text: 'Doomed prompt' })];
    H.deleteItem.mockRejectedValueOnce(new Error('permission-denied')).mockResolvedValueOnce(undefined);
    renderAdmin('/more/admin/pool');

    const row = screen.getByText('Doomed prompt').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByTitle('Delete'));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');

    // The button re-enabled — a retry fires the write again and clears the pill.
    fireEvent.click(within(row).getByTitle('Delete'));
    await waitFor(() => expect(within(row).queryByRole('alert')).toBeNull());
    expect(H.deleteItem).toHaveBeenCalledTimes(2);
  });

  it('disables the control while its write is pending — a double-tap fires exactly one write', async () => {
    H.items = [item('i1', { text: 'Slow prompt' })];
    let settle!: () => void;
    H.deleteItem.mockImplementationOnce(() => new Promise<void>((resolve) => (settle = resolve)));
    renderAdmin('/more/admin/pool');

    const row = screen.getByText('Slow prompt').closest('.row') as HTMLElement;
    const del = within(row).getByTitle('Delete') as HTMLButtonElement;
    fireEvent.click(del);
    expect(del.disabled).toBe(true);
    fireEvent.click(del); // ignored while pending
    await act(async () => {
      settle();
      await Promise.resolve();
    });
    expect(H.deleteItem).toHaveBeenCalledTimes(1);
    expect(del.disabled).toBe(false);
  });

  it('a rejected claim Confirm alerts inline in the Review queue', async () => {
    H.claims = [{ id: 'c1', displayName: 'Alice', itemText: 'Do a thing' } as never];
    H.confirmClaim.mockRejectedValueOnce(new Error('offline'));
    renderAdmin('/more/admin/queue');

    const row = screen.getByText('Alice').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');
  });

  it('a rejected spicy correction alerts, reverts the checkbox, and retries cleanly', async () => {
    H.pendingItems = [item('i1', { text: 'Fragile classification', status: 'pending' })];
    let rejectWrite!: (error: Error) => void;
    H.setItemSpicy
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (rejectWrite = reject)),
      )
      .mockResolvedValueOnce(1);
    renderAdmin('/more/admin/queue');

    const row = screen.getByText('Fragile classification').closest('.row') as HTMLElement;
    const checkbox = within(row).getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => {
      rejectWrite(new Error('offline'));
      await Promise.resolve();
    });

    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() => expect(within(row).queryByRole('alert')).toBeNull());
    expect(checkbox.checked).toBe(true);
    expect(H.setItemSpicy).toHaveBeenNthCalledWith(1, 'i1', true, 'test-event');
    expect(H.setItemSpicy).toHaveBeenNthCalledWith(2, 'i1', true, 'test-event');
  });

  it('retires a successful spicy overlay after its snapshot echo so a later Admin correction wins', async () => {
    H.pendingItems = [item('i1', { text: 'Shared classification', status: 'pending' })];
    H.setItemSpicy.mockResolvedValueOnce(1);
    const view = renderAdmin('/more/admin/queue');

    const row = screen.getByText('Shared classification').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() =>
      expect(H.setItemSpicy).toHaveBeenCalledWith('i1', true, 'test-event'),
    );
    expect(within(row).getByRole('checkbox')).toBeChecked();

    H.pendingItems = [
      item('i1', {
        text: 'Shared classification',
        status: 'pending',
        spicy: true,
        spicyRevision: 1,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(row).getByRole('checkbox')).toBeChecked());

    H.pendingItems = [
      item('i1', {
        text: 'Shared classification',
        status: 'pending',
        spicy: false,
        spicyRevision: 2,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(row).getByRole('checkbox')).not.toBeChecked());
  });

  it('does not mistake another Admin matching the pending choice for this write’s snapshot echo', async () => {
    H.pendingItems = [item('i1', { text: 'Contended classification', status: 'pending' })];
    let settleWrite!: () => void;
    H.setItemSpicy.mockImplementationOnce(
      () => new Promise<number>((resolve) => (settleWrite = () => resolve(3))),
    );
    const view = renderAdmin('/more/admin/queue');

    const row = screen.getByText('Contended classification').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(within(row).getByRole('checkbox')).toBeChecked();

    // Another Admin briefly writes the same value, then changes it back while
    // this tab's transaction is still pending. Neither snapshot acknowledges
    // this tab's write, so its exact approval choice must remain overlaid.
    H.pendingItems = [
      item('i1', {
        text: 'Contended classification',
        status: 'pending',
        spicy: true,
        spicyRevision: 1,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    H.pendingItems = [
      item('i1', {
        text: 'Contended classification',
        status: 'pending',
        spicy: false,
        spicyRevision: 2,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    expect(within(row).getByRole('checkbox')).toBeChecked();

    await act(async () => {
      settleWrite();
      await Promise.resolve();
    });
    expect(within(row).getByRole('checkbox')).toBeChecked();

    // Now this write's authoritative echo can retire the overlay; a correction
    // that follows it must be visible rather than masked by stale local state.
    H.pendingItems = [
      item('i1', {
        text: 'Contended classification',
        status: 'pending',
        spicy: true,
        spicyRevision: 3,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    H.pendingItems = [
      item('i1', {
        text: 'Contended classification',
        status: 'pending',
        spicy: false,
        spicyRevision: 4,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(row).getByRole('checkbox')).not.toBeChecked());
  });

  it('retires against a newer revision when the local echo preceded write settlement', async () => {
    H.pendingItems = [item('i1', { text: 'Overtaken classification', status: 'pending' })];
    let settleWrite!: () => void;
    H.setItemSpicy.mockImplementationOnce(
      () => new Promise<number>((resolve) => (settleWrite = () => resolve(1))),
    );
    const view = renderAdmin('/more/admin/queue');

    const row = screen.getByText('Overtaken classification').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(within(row).getByRole('checkbox')).toBeChecked();

    // This request's true echo arrives first. Before its transaction Promise
    // settles, an Admin on the previous bundle writes false without advancing
    // the revision. No further snapshot is required: equality is at-or-after
    // this write, so settlement at revision 1 must reveal the newer false row.
    H.pendingItems = [
      item('i1', {
        text: 'Overtaken classification',
        status: 'pending',
        spicy: true,
        spicyRevision: 1,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    H.pendingItems = [
      item('i1', {
        text: 'Overtaken classification',
        status: 'pending',
        spicy: false,
        spicyRevision: 1,
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    expect(within(row).getByRole('checkbox')).toBeChecked();

    await act(async () => {
      settleWrite();
      await Promise.resolve();
    });

    await waitFor(() => expect(within(row).getByRole('checkbox')).not.toBeChecked());
  });

  it('drops a rejected spicy overlay so the next authoritative snapshot is visible', async () => {
    H.pendingItems = [item('i1', { text: 'Remote correction', status: 'pending' })];
    H.setItemSpicy.mockRejectedValueOnce(new Error('offline'));
    const view = renderAdmin('/more/admin/queue');

    const row = screen.getByText('Remote correction').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');
    expect(within(row).getByRole('checkbox')).not.toBeChecked();

    H.pendingItems = [
      item('i1', { text: 'Remote correction', status: 'pending', spicy: true }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={['/more/admin/queue']}>
        <Admin />
      </MemoryRouter>,
    );
    await waitFor(() => expect(within(row).getByRole('checkbox')).toBeChecked());
  });

  it('clears a failed spicy correction when the row changes to Easy, then allows a fresh retry', async () => {
    H.pendingItems = [item('i1', { text: 'Reclassified prompt', status: 'pending' })];
    H.setItemSpicy.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(1);
    renderAdmin('/more/admin/queue');

    const row = screen.getByText('Reclassified prompt').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');

    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'easy' } });
    expect(within(row).queryByRole('checkbox')).toBeNull();
    expect(within(row).queryByRole('alert')).toBeNull();

    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'main' } });
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() => expect(H.setItemSpicy).toHaveBeenCalledTimes(2));
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('does not surface a late spicy-write failure after the row has changed to Easy', async () => {
    H.pendingItems = [item('i1', { text: 'Pending reclassification', status: 'pending' })];
    let rejectWrite!: (error: Error) => void;
    H.setItemSpicy.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectWrite = reject)),
    );
    renderAdmin('/more/admin/queue');

    const row = screen.getByText('Pending reclassification').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'easy' } });
    await act(async () => {
      rejectWrite(new Error('offline'));
      await Promise.resolve();
    });

    expect(within(row).queryByRole('checkbox')).toBeNull();
    expect(within(row).queryByRole('alert')).toBeNull();

    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'main' } });
    expect(within(row).getByRole('checkbox')).not.toBeDisabled();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('a rejected Unban alerts inline in Players', async () => {
    H.event = { ...H.event, bannedUids: ['ghost-uid'] } as unknown as EventDoc;
    H.unbanUser.mockRejectedValueOnce(new Error('offline'));
    renderAdmin('/more/admin/players');

    const row = screen.getByText('ghost-uid').closest('.row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Unban' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Failed—try again.');
  });

  it('a rejected curated add keeps the draft text and shows the add-specific alert', async () => {
    H.adminAddItem.mockRejectedValueOnce(new Error('offline'));
    renderAdmin('/more/admin/pool');

    const input = screen.getByLabelText('New prompt text') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Fragile prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Didn’t add—try again.');
    expect(input.value).toBe('Fragile prompt'); // draft kept for a one-tap retry
  });

  it('a half-typed curated add holds back the automatic post-deploy reload', async () => {
    // Codex P2 round 5, PR #720. Same class as Admin → Messages: the draft
    // lives only in React state, and this bar is neither a modal nor the claim
    // sheet, so `midInteraction` (src/swClientBridge.ts) had nothing to see.
    renderAdmin('/more/admin/pool');
    const input = await screen.findByLabelText('New prompt text');
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;
    expect(document.querySelector(marker)).toBeNull();
    fireEvent.change(input, { target: { value: 'Half a prompt' } });
    expect(document.querySelector(marker)).not.toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(document.querySelector(marker)).toBeNull();
  });

  it('a retained inline prompt edit holds back the automatic post-deploy reload', async () => {
    // Codex P2 round 6, PR #720. Round 5 marked the ADD bar and left the inline
    // editor beside it unmarked, which is the same class one level down: an
    // automatic reload eats an in-progress correction, and the sharpest case is
    // the draft this very file's `#411` behaviour deliberately RETAINS after a
    // rejected save — the editor sits open holding the only copy of an edit
    // that has already failed once.
    H.items = [item('i1', { text: 'Original wording' })];
    H.adminUpdateItemText.mockRejectedValueOnce(new Error('offline'));
    renderAdmin('/more/admin/pool');
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;

    // An editor merely OPENED is not a draft — it must not pin the tab.
    fireEvent.click(screen.getByTitle('Edit text'));
    expect(document.querySelector(marker)).toBeNull();

    const edit = screen.getByLabelText('Edit prompt text') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: 'Sharper wording' } });
    expect(document.querySelector(marker)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Didn’t save—try again.');
    expect(document.querySelector(marker)).not.toBeNull(); // the retained draft still counts

    // Cancelling discards it deliberately, so the reload is released.
    fireEvent.click(screen.getByTitle('Cancel'));
    expect(document.querySelector(marker)).toBeNull();
  });

  it('an inline edit that differs only in whitespace is not unsaved work', async () => {
    // Codex P2 round 6, PR #720. `save` writes only when `draft.trim()` differs
    // from the stored text, so a padding-only draft commits nothing AND resets
    // nothing — a marker keyed on the raw string would never come back off.
    H.items = [item('i1', { text: 'Original wording' })];
    renderAdmin('/more/admin/pool');
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;

    fireEvent.click(screen.getByTitle('Edit text'));
    const edit = screen.getByLabelText('Edit prompt text') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: '  Original wording  ' } });
    expect(document.querySelector(marker)).toBeNull();
    // Clearing the field loses nothing either: the save is a no-op close.
    fireEvent.change(edit, { target: { value: '   ' } });
    expect(document.querySelector(marker)).toBeNull();
  });

  it('the inline save guards re-entry — a double Enter while pending issues exactly one write', async () => {
    H.items = [item('i1', { text: 'Original wording' })];
    let settle!: () => void;
    H.adminUpdateItemText.mockImplementationOnce(() => new Promise<void>((resolve) => (settle = resolve)));
    renderAdmin('/more/admin/pool');

    fireEvent.click(screen.getByTitle('Edit text'));
    const edit = screen.getByLabelText('Edit prompt text') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: 'Sharper wording' } });
    fireEvent.keyDown(edit, { key: 'Enter' });
    fireEvent.keyDown(edit, { key: 'Enter' }); // ignored while pending
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      settle();
      await Promise.resolve();
    });
    expect(H.adminUpdateItemText).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Edit prompt text')).toBeNull(); // editor closed on success
  });

  it('a rejected inline text save keeps the editor open with the draft and the save-specific alert', async () => {
    H.items = [item('i1', { text: 'Original wording' })];
    H.adminUpdateItemText.mockRejectedValueOnce(new Error('offline'));
    renderAdmin('/more/admin/pool');

    fireEvent.click(screen.getByTitle('Edit text'));
    const edit = screen.getByLabelText('Edit prompt text') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: 'Sharper wording' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Didn’t save—try again.');
    expect((screen.getByLabelText('Edit prompt text') as HTMLInputElement).value).toBe('Sharper wording');
  });
});
