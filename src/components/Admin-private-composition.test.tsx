import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth, User } from 'firebase/auth';
import { createPrivateFirestoreSessions } from '../auth/privateFirestoreSession';

// Actual Admin → GameSettings → ArchiveEvent → beginArchive/transaction and
// actual useAdminEventDoc. Only SDK transport and unrelated queue inputs are
// controlled; no independent Event-hook answer can hide this composition race.
const H = vi.hoisted(() => ({
  primary: { currentUser: { uid: 'alice' } as { uid: string; token?: string } | null },
  idToken: null as ((user: User | null) => void) | null,
  manager: null as ReturnType<typeof createPrivateFirestoreSessions> | null,
  db: { name: 'private-memory' }, legacyDb: { name: 'legacy-persistent' },
  event: { name: 'Cruise', status: 'active', admins: ['alice'], days: [], bannedUids: [] },
  listeners: [] as { next: (snapshot: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
  rejectWrite: null as ((error: Error) => void) | null,
  transaction: vi.fn(), staged: vi.fn(),
}));
vi.mock('../firebase', () => ({ db: H.legacyDb, EVENT_ID: 'event', auth: H.primary, functions: {}, storage: {}, analytics: null }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.primary.currentUser }) }));
vi.mock('../hooks/useOnline', () => ({ useOnline: () => true }));

vi.mock('../privateFirestore', () => ({
  privateFirestoreSessions: () => H.manager!,
  capturePrivateFirestore: () => H.manager!.capture(),
}));
vi.mock('firebase/app', () => ({ initializeApp: () => ({}), deleteApp: async () => {} }));
vi.mock('firebase/auth', () => ({
  inMemoryPersistence: {}, initializeAuth: () => ({}), updateCurrentUser: async () => {},
  beforeAuthStateChanged: () => () => {},
  onIdTokenChanged: (_auth: unknown, callback: (user: User | null) => void) => { H.idToken = callback; return () => {}; },
}));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const ref = (_database: unknown, ...parts: string[]) => ({ path: parts.join('/'), withConverter() { return this; } });
  return { ...actual, doc: ref, collection: ref, initializeFirestore: () => H.db, memoryLocalCache: () => ({}), terminate: async () => {},
    onSnapshot: (_target: unknown, _options: unknown, next: (snapshot: unknown) => void, error: () => void) => {
      const stop = vi.fn(); H.listeners.push({ next, error, stop }); return stop;
    },
    runTransaction: (...args: unknown[]) => H.transaction(...args),
  };
});
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  const confirmed = { loading: false, failed: false, hasServerData: true, fromCache: false, hasPendingWrites: false };
  return { ...actual,
    usePendingClaims: () => ({ ...confirmed, claims: [] }),
    usePendingItems: () => ({ ...confirmed, items: [] }),
    useReportedProofs: () => ({ ...confirmed, flagged: [] }),
    useAllItems: () => ({ ...confirmed, items: [] }),
    useNotices: () => ({ notices: [] }),
    useLeaderboard: () => ({ ...confirmed, players: [] }),
    useDayMetasStatus: () => ({ metas: new Map(), loaded: true, serverConfirmed: true, failed: false, scheduleUnusable: false }),
  };
});
vi.mock('../hooks/useAdultContent', () => ({ useAdultContent: () => false }));
vi.mock('./admin/AdultContentConfirm', () => ({ useAdultContentFlipConfirm: () => ({ guard: async (operation: () => Promise<void>) => operation(), dialog: null }) }));
vi.mock('../theme/themes', () => ({ themesForEditionIncluding: () => [] }));
vi.mock('./admin/ReviewQueue', () => ({ default: () => null }));
vi.mock('./admin/AdminHub', () => ({ default: () => null }));
vi.mock('./admin/SchedulePanel', () => ({ default: () => null }));
vi.mock('./admin/PromptPool', () => ({ default: () => null }));
vi.mock('./admin/PlayersPanel', () => ({ default: () => null }));
import Admin from './Admin';

const snapshot = (pending = false, event = H.event) => ({ exists: () => true, data: () => event, metadata: { fromCache: false, hasPendingWrites: pending } });
const emit = (pending = false, event = H.event) => H.listeners.at(-1)!.next(snapshot(pending, event));
const renderAdmin = () => render(<MemoryRouter initialEntries={['/more/admin/settings']}><Admin /></MemoryRouter>);

beforeEach(async () => {
  vi.clearAllMocks(); H.listeners = []; H.rejectWrite = null;
  H.primary.currentUser = { uid: 'alice', token: 'initial' };
  H.manager = createPrivateFirestoreSessions({ primaryAuth: H.primary as unknown as Auth, options: {}, recovered: () => true, online: () => true });
  H.idToken!(H.primary.currentUser as User);
  await waitFor(() => expect(H.manager!.getSnapshot().db).not.toBeNull());
  H.transaction.mockImplementation(async (database: unknown, operation: (transaction: unknown) => Promise<unknown>) => {
    expect(database).toBe(H.db);
    const transaction = {
      get: async () => snapshot(),
      update: (target: { path: string }, fields: unknown) => { H.staged(target, fields); emit(true, { ...H.event, admins: [] }); return transaction; },
    };
    const result = await operation(transaction);
    await new Promise<void>((_resolve, reject) => { H.rejectWrite = reject; });
    return result;
  });
});

afterEach(() => { H.manager?.stop(); });

describe('Admin retains its confirmed private Event during its own held write (#1411)', () => {
  it('keeps the actual Close-play action mounted and shows its server rejection after a pending Event echo', async () => {
    renderAdmin();
    await act(async () => { emit(); });
    const close = screen.getByRole('button', { name: 'Close play' });
    const archive = screen.getByRole('button', { name: 'Archive…' });
    expect(archive).toBeEnabled();
    await userEvent.click(close);
    await waitFor(() => expect(H.rejectWrite).not.toBeNull());
    // Real manager + private hooks: hourly token refresh must not retire this
    // held action or remount the component which owns its eventual error.
    const beforeRefresh = H.manager!.getSnapshot();
    await act(async () => {
      H.primary.currentUser = { uid: 'alice', token: 'refreshed' };
      H.idToken!(H.primary.currentUser as User);
    });
    expect(H.manager!.getSnapshot()).toBe(beforeRefresh);
    expect(H.staged).toHaveBeenCalledWith(expect.objectContaining({ path: 'events/event' }), { archiving: true, archiveToken: 1 });
    expect(screen.getByRole('button', { name: 'Close play' })).toBe(close);
    expect(close).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBe(archive);
    expect(archive).toBeDisabled();
    expect(screen.queryByText('Loading Admin…')).not.toBeInTheDocument();
    // Rollback restores the server snapshot; the SAME action must retain its
    // awaiting/error state, rather than a newly mounted control losing it.
    await act(async () => { emit(); H.rejectWrite!(new Error('permission-denied')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Closing play failed—try again.');
    expect(screen.getByRole('button', { name: 'Close play' })).toBe(close);
    expect(close).toBeEnabled();
    expect(H.transaction).toHaveBeenCalledOnce();
  });

  it('keeps the actual Notice draft and private Event listener mounted during a same-UID refresh', async () => {
    render(<MemoryRouter initialEntries={['/more/admin/messages']}><Admin /></MemoryRouter>);
    await act(async () => { emit(); });
    const title = screen.getByRole('textbox', { name: 'Notice title' });
    const body = screen.getByRole('textbox', { name: 'Notice body' });
    await userEvent.type(title, 'Tomorrow'); await userEvent.type(body, 'Meet at breakfast.');
    const listenerCount = H.listeners.length; const listener = H.listeners.at(-1)!;
    await act(async () => {
      H.primary.currentUser = { uid: 'alice', token: 'refreshed' };
      H.idToken!(H.primary.currentUser as User);
    });
    expect(screen.getByRole('textbox', { name: 'Notice title' })).toBe(title);
    expect(title).toHaveValue('Tomorrow'); expect(body).toHaveValue('Meet at breakfast.');
    expect(listener.stop).not.toHaveBeenCalled(); expect(H.listeners).toHaveLength(listenerCount);
    expect(screen.queryByText('Loading Admin…')).not.toBeInTheDocument();
  });

  it('withholds Archive for pending Event metadata even when no action is busy', async () => {
    renderAdmin(); await act(async () => { emit(); });
    const close = screen.getByRole('button', { name: 'Close play' });
    const archive = screen.getByRole('button', { name: 'Archive…' });
    expect(archive).toBeEnabled();
    await act(async () => { emit(true, { ...H.event, admins: [] }); });
    expect(screen.getByRole('button', { name: 'Close play' })).toBe(close);
    expect(close).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBe(archive);
    expect(archive).toBeDisabled();
    expect(H.transaction).not.toHaveBeenCalled();
  });

  it('a pending-first private Event never qualifies the actual Admin console', async () => {
    renderAdmin(); await act(async () => { emit(true); });
    expect(screen.queryByRole('button', { name: 'Close play' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading Admin|Admin is unavailable/);
    expect(H.transaction).not.toHaveBeenCalled();
    await act(async () => { emit(); });
    expect(screen.getByRole('button', { name: 'Close play' })).toBeEnabled();
  });

  it('a terminal private Event denial retires the confirmed console', async () => {
    renderAdmin(); await act(async () => { emit(); });
    expect(screen.getByRole('button', { name: 'Close play' })).toBeInTheDocument();
    await act(async () => { H.listeners.at(-1)!.error(); });
    expect(screen.queryByRole('button', { name: 'Close play' })).toBeNull();
    expect(screen.getByText('Admin is unavailable. Reload and try again.')).toBeInTheDocument();
    expect(H.transaction).not.toHaveBeenCalled();
  });
});
