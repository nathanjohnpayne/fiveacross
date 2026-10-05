import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Actual Admin → real ReviewQueue/PromptPool → hideItem/rejectItem updateDoc,
// observed by the real private all-items/pending-items listeners. Only SDK
// transport and unrelated private queues are controlled.
const H = vi.hoisted(() => ({
  db: { name: 'private-memory' }, legacyDb: { name: 'legacy-persistent' },
  event: { name: 'Cruise', status: 'active', admins: ['alice'], days: [], bannedUids: [] },
  item: { id: 'prompt', text: 'A real prompt', status: 'active', pool: 'main', spicy: false, createdBy: 'seed', createdAt: 1, reportCount: 1 },
  listeners: [] as { target: { path: string; pendingOnly?: boolean }; next: (snapshot: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
  rejectWrite: null as ((error: Error) => void) | null,
  write: vi.fn(), nativeRemoval: false,
  queue: null as Promise<void> | null, settleQueue: null as (() => void) | null,
}));
vi.mock('../firebase', () => ({ db: H.legacyDb, EVENT_ID: 'event', auth: { currentUser: { uid: 'alice' } }, functions: {}, storage: {}, analytics: null }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'alice' } }) }));
vi.mock('../hooks/useOnline', () => ({ useOnline: () => true }));
vi.mock('../hooks/usePrivateFirestore', () => ({ usePrivateFirestore: () => ({ db: H.db, uid: 'alice', generation: 1, failed: false, recoveryRequired: false }) }));
vi.mock('../privateFirestore', () => ({ capturePrivateFirestore: () => ({
  db: H.db, uid: 'alice', generation: 1, assertCurrent: () => {},
  guard: async <T,>(operation: () => Promise<T>) => operation(),
}) }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const ref = (database: unknown, ...parts: string[]) => ({ firestore: database, path: parts.join('/'), withConverter() { return this; } });
  return { ...actual, doc: ref, collection: ref,
    where: (...args: unknown[]) => ({ args }),
    query: (target: { path: string }, ..._constraints: unknown[]) => ({ ...target, pendingOnly: true }),
    onSnapshot: (target: { path: string; pendingOnly?: boolean }, _options: unknown, next: (snapshot: unknown) => void, error: () => void) => {
      const stop = vi.fn(); H.listeners.push({ target, next, error, stop }); return stop;
    },
    updateDoc: (...args: unknown[]) => H.write(...args),
    deleteDoc: (target: unknown) => H.write(target, { status: 'deleted' }),
    waitForPendingWrites: async (database: unknown) => { expect(database).toBe(H.db); await H.queue; },
    getDocsFromServer: async (target: { firestore: unknown; path: string; pendingOnly?: boolean }) => {
      expect(target.firestore).toBe(H.db);
      expect(target.path).toBe('events/event/items');
      // The server never accepted the held mutation in these rejection cases.
      // A queue drain alone cannot promote its optimistic empty query echo.
      const rows = target.pendingOnly && H.item.status !== 'pending' ? [] : [H.item];
      return { docs: rows.map((row) => ({ id: row.id, data: () => ({ ...row }) })), metadata: { fromCache: false, hasPendingWrites: false } };
    },
  };
});
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  const confirmed = { loading: false, failed: false, hasServerData: true, fromCache: false, hasPendingWrites: false };
  return { ...actual,
    usePendingClaims: () => ({ ...confirmed, claims: [] }),
    useReportedProofs: () => ({ ...confirmed, flagged: [] }),
    useLeaderboard: () => ({ ...confirmed, players: [] }),
    useDayMetasStatus: () => ({ metas: new Map(), loaded: true, serverConfirmed: true, failed: false, scheduleUnusable: false }),
  };
});
vi.mock('../hooks/useAdultContent', () => ({ useAdultContent: () => false }));
vi.mock('./admin/AdultContentConfirm', () => ({ useAdultContentFlipConfirm: () => ({ guard: async (_spicy: unknown, _reason: unknown, operation: () => Promise<void>) => operation(), dialog: null }) }));
vi.mock('../theme/themes', () => ({ themesForEditionIncluding: () => [] }));
vi.mock('./admin/AdminHub', () => ({ default: () => null }));
vi.mock('./admin/SchedulePanel', () => ({ default: () => null }));
vi.mock('./admin/PlayersPanel', () => ({ default: () => null }));
vi.mock('./admin/MessagesPanel', () => ({ default: () => null }));
import Admin from './Admin';


const emitItems = (pending: boolean, status = H.item.status) => {
  for (const listener of H.listeners.filter((l) => l.target.path.endsWith('/items'))) {
    const rows = status === 'deleted' || (listener.target.pendingOnly && status !== 'pending') ? [] : [{ ...H.item, status }];
    // Native query removal may have no mutated documents even before write ACK.
    const queryPending = H.nativeRemoval && rows.length === 0 ? false : pending;
    listener.next({ docs: rows.map((row) => ({ id: row.id, data: () => row })), metadata: { fromCache: false, hasPendingWrites: queryPending } });
  }
};
const confirmSources = () => {
  for (const listener of H.listeners.filter((l) => l.target.path === 'events/event')) {
    listener.next({ exists: () => true, data: () => H.event, metadata: { fromCache: false, hasPendingWrites: false } });
  }
  emitItems(false);
};
const mount = async (section: 'queue' | 'pool') => {
  render(<MemoryRouter initialEntries={['/more/admin/' + section]}><Admin /></MemoryRouter>);
  await act(async () => { confirmSources(); });
  // Event confirmation mounts the item subscriptions in the next render.
  await act(async () => { emitItems(false); });
};

beforeEach(() => {
  vi.clearAllMocks(); H.listeners = []; H.rejectWrite = null; H.item.status = 'active'; H.item.reportCount = 1; H.nativeRemoval = false; H.queue = null; H.settleQueue = null;
  H.write.mockImplementation(async (target: { path: string }, fields: { status: string }) => {
    expect(target.path).toBe('events/event/items/prompt');
    H.queue = new Promise<void>((resolve) => { H.settleQueue = resolve; });
    const held = new Promise<void>((_resolve, reject) => { H.rejectWrite = (error) => { H.settleQueue!(); H.queue = null; reject(error); }; });
    emitItems(true, fields.status);
    await held;
  });
});

describe('Admin moderation retains committed private rows during held writes (#1411)', () => {
  it.each(['queue', 'pool'] as const)('%s keeps the actual Hide button and its denial visible through its own pending echo', async (section) => {
    await mount(section);
    const hide = screen.getByRole('button', { name: 'Hide' });
    await userEvent.click(hide);
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    expect(H.write).toHaveBeenCalledWith(expect.objectContaining({ path: 'events/event/items/prompt' }), { status: 'hidden' });
    expect(screen.getByRole('button', { name: 'Hide' })).toBe(hide);
    expect(hide).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    await act(async () => { emitItems(false); H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed—try again.');
    expect(screen.getByRole('button', { name: 'Hide' })).toBe(hide);
    expect(hide).toBeEnabled();
    expect(H.write).toHaveBeenCalledOnce();
  });

  it('ReviewQueue keeps Reject through a controlled pending:true query-removal echo', async () => {
    H.item.status = 'pending'; H.item.reportCount = 0;
    await mount('queue');
    const reject = screen.getByTitle('Reject');
    await userEvent.click(reject);
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    expect(H.write).toHaveBeenCalledWith(expect.objectContaining({ path: 'events/event/items/prompt' }), expect.objectContaining({ status: 'rejected', approvedBy: 'alice' }));
    expect(screen.getByTitle('Reject')).toBe(reject);
    expect(reject).toBeDisabled();
    await act(async () => { emitItems(false); H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed—try again.');
    expect(screen.getByTitle('Reject')).toBe(reject);
    expect(reject).toBeEnabled();
    expect(H.write).toHaveBeenCalledOnce();
  });
  it.each(['Reject', 'Delete'] as const)('%s retains its control through the native empty-query pending:false echo before ACK', async (action) => {
    H.nativeRemoval = true;
    H.item.status = action === 'Reject' ? 'pending' : 'active';
    H.item.reportCount = 0;
    await mount(action === 'Reject' ? 'queue' : 'pool');
    const button = screen.getByTitle(action);
    await userEvent.click(button);
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    // The matching native query has disappeared but the actual write remains
    // held. No pending metadata bit is invented to keep this control alive.
    expect(H.queue).not.toBeNull();
    expect(screen.getByTitle(action)).toBe(button);
    expect(button).toBeDisabled();
    // Drain/denial settles BEFORE any rollback listener delivery. Only a fresh
    // authoritative read can safely retire the captured empty local echo.
    await act(async () => { H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed—try again.');
    expect(screen.getByTitle(action)).toBe(button);
    expect(button).toBeEnabled();
    expect(H.write).toHaveBeenCalledOnce();
  });

});
