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
  confirmClaim: vi.fn(),
  unbanUser: vi.fn(),
  adminAddItem: vi.fn(),
  adminUpdateItemText: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
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
  setItemSpicy: vi.fn(),
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
