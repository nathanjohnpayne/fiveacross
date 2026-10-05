import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockDoc } from '../types';

// Actual panel, own-direction hook and unblock writer; only Firebase transport,
// session publication and the unrelated roster are controlled. No observed hook stub.
type Snapshot = { docs: Array<{ data: () => BlockDoc; metadata: { hasPendingWrites: boolean } }>; metadata: { fromCache: boolean; hasPendingWrites: boolean } };
type Subscription = { next: (snapshot: Snapshot) => void; fail: (error: Error) => void; stop: ReturnType<typeof vi.fn>; target: unknown };
const H = vi.hoisted(() => ({
  eventId: 'event-a', online: true,
  session: { uid: 'bob' as string | null, db: { memory: true } as object | null, generation: 0, authGeneration: 0, recoveryRequired: false, failed: false },
  subs: [] as Subscription[], retryBridge: vi.fn(),
  transactions: [] as Array<{ db: unknown; paths: string[] }>, commit: null as (() => Promise<void>) | null,
}));
vi.mock('../firebase', () => ({ db: { persistent: true }, get EVENT_ID() { return H.eventId; }, auth: { get currentUser() { return H.session.uid ? { uid: H.session.uid } : null; } } }));
vi.mock('../hooks/usePrivateFirestore', () => ({ usePrivateFirestore: () => H.session }));
vi.mock('../privateFirestore', () => {
  const capture = (allowRecovery = false) => {
    const { uid, db, generation } = H.session;
    const assertCurrent = () => { if (!db || uid !== H.session.uid || generation !== H.session.generation || !H.online || (!allowRecovery && H.session.recoveryRequired)) throw new Error('Private lease retired.'); };
    return { uid, db, assertCurrent, guard: async <T,>(operation: () => Promise<T>) => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
  };
  return { capturePrivateFirestore: capture, retryPrivateFirestoreSession: H.retryBridge, awaitPrivateFirestore: async (uid: string) => { const lease = capture(); if (lease.uid !== uid) throw new Error('Wrong actor.'); lease.assertCurrent(); return lease; } };
});
vi.mock('../hooks/useData', () => ({ useLeaderboard: () => ({ players: [{ uid: 'alice', displayName: 'Alice' }], hasServerData: true }) }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  collection: (database: unknown, ...segments: string[]) => ({ database, path: segments.join('/'), withConverter() { return this; } }),
  doc: (database: unknown, ...segments: string[]) => ({ database, path: segments.join('/'), withConverter() { return this; } }),
  query: (...args: unknown[]) => ({ args }), where: (...args: unknown[]) => ({ args }), waitForPendingWrites: vi.fn(),
  onSnapshot: (target: unknown, _options: unknown, next: Subscription['next'], fail: Subscription['fail']) => { const stop = vi.fn(); H.subs.push({ target, next, fail, stop }); return stop; },
  runTransaction: async (db: unknown, update: (tx: { delete: (ref: { path: string }) => void }) => Promise<void>) => {
    const paths: string[] = []; await update({ delete: ref => paths.push(ref.path) }); H.transactions.push({ db, paths }); if (H.commit) await H.commit();
  },
}));
import BlockedPlayersPanel from './BlockedPlayersPanel';
const row: BlockDoc = { ownerUid: 'bob', targetUid: 'alice', eventId: 'event-a', createdAt: 1 };
function answer(rows: BlockDoc[] = [], fromCache = false, pending = false): Snapshot {
  return { docs: rows.map(data => ({ data: () => data, metadata: { hasPendingWrites: pending } })), metadata: { fromCache, hasPendingWrites: pending } };
}
function online(value: boolean) { H.online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); H.online = true; H.eventId = 'event-a';
  H.session = { uid: 'bob', db: { memory: true }, generation: 0, authGeneration: 0, recoveryRequired: false, failed: false };
  H.subs = []; H.transactions = []; H.commit = null;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => H.online);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Blocked players private availability composition', () => {
  it('explains recovery before listening and requires a committed first answer after recovery', () => {
    H.session.recoveryRequired = true;
    const view = render(<BlockedPlayersPanel uid="bob" />);
    const link = screen.getByRole('link', { name: 'Open device recovery' });
    expect(new URL(link.getAttribute('href')!, window.location.href).searchParams.get('device-cache-recovery')).toBe('1');
    expect(screen.queryByText('Loading…')).toBeNull(); expect(H.subs).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Unblock/ })).toBeNull();
    H.session = { ...H.session, recoveryRequired: false, generation: 1 };
    view.rerender(<BlockedPlayersPanel uid="bob" />);
    expect((H.subs[0].target as { args: Array<{ database: unknown; path: string }> }).args[0]).toMatchObject({ database: H.session.db, path: 'events/event-a/blocks' });
    act(() => H.subs[0].next(answer([row], true))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => H.subs[0].next(answer([row], false, true))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => H.subs[0].next(answer([row]))); expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeEnabled();
  });

  it('withholds own rows offline on cold start and after a confirmed online answer', () => {
    H.online = false; const view = render(<BlockedPlayersPanel uid="bob" />);
    expect(screen.getByText(/Reconnect to see your blocked players/)).toBeInTheDocument(); expect(H.subs).toHaveLength(0);
    act(() => online(true)); act(() => H.subs[0].next(answer([row])));
    expect(screen.getByText('Alice')).toBeInTheDocument();
    act(() => online(false)); expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unblock Alice' })).toBeNull(); expect(H.subs[0].stop).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('bounds silent/cache first answers and retries only the current local listener', () => {
    render(<BlockedPlayersPanel uid="bob" />); const old = H.subs[0];
    act(() => old.next(answer([row], true))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => vi.advanceTimersByTime(9_999)); expect(screen.getByText('Loading…')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByText(/Couldn’t load your blocked players/)).toBeInTheDocument();
    expect(old.stop).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(H.retryBridge).not.toHaveBeenCalled(); expect(H.subs).toHaveLength(2);
    act(() => old.next(answer([row]))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => H.subs[1].next(answer())); expect(screen.getByText('You haven’t blocked anyone.')).toBeInTheDocument();
  });

  it('a denial closes its listener and cannot qualify a later stale callback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); render(<BlockedPlayersPanel uid="bob" />); const old = H.subs[0];
    act(() => old.next(answer([row]))); act(() => old.fail(Object.assign(new Error('denied'), { code: 'permission-denied' })));
    expect(screen.queryByText('Alice')).toBeNull(); expect(screen.getByText(/Check your access/)).toBeInTheDocument();
    expect(old.stop).toHaveBeenCalledOnce(); act(() => old.next(answer([row]))); expect(screen.queryByText('Alice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); act(() => H.subs[1].next(answer([row])));
    expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeEnabled();
  });

  it('retains saved rows only during server-backed pending updates, never from first pending/cache data', () => {
    render(<BlockedPlayersPanel uid="bob" />); const sub = H.subs[0];
    act(() => sub.next(answer([row], false, true))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => sub.next(answer([row]))); act(() => sub.next(answer([], false, true)));
    expect(screen.getByText('Alice')).toBeInTheDocument();
    act(() => sub.next(answer([row], true))); expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it.each(['UID', 'Event', 'generation'] as const)('retires the old %s listener and deadline before admitting the new scope', scope => {
    const view = render(<BlockedPlayersPanel uid="bob" />); const old = H.subs[0];
    act(() => vi.advanceTimersByTime(9_000));
    if (scope === 'UID') H.session = { ...H.session, uid: 'carol', generation: 1 };
    if (scope === 'Event') H.eventId = 'event-b';
    if (scope === 'generation') H.session = { ...H.session, db: { replacement: true }, generation: 1 };
    view.rerender(<BlockedPlayersPanel uid={H.session.uid} />);
    act(() => old.next(answer([row]))); expect(screen.queryByText('Alice')).toBeNull();
    act(() => vi.advanceTimersByTime(1_000)); expect(screen.queryByText(/Couldn’t load/)).toBeNull();
    act(() => H.subs[1].next(answer())); expect(screen.getByText('You haven’t blocked anyone.')).toBeInTheDocument();
    expect(old.stop).toHaveBeenCalledOnce();
  });

  it.each(['confirmation', 'error', 'unmount'] as const)('cancels the first-answer deadline on %s', end => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); const timers = vi.spyOn(globalThis, 'setTimeout'); const clear = vi.spyOn(globalThis, 'clearTimeout'); const view = render(<BlockedPlayersPanel uid="bob" />); const sub = H.subs[0];
    const firstDeadline = timers.mock.results[timers.mock.calls.findIndex(call => call[1] === 10_000)]?.value;
    expect(firstDeadline).toBeDefined();
    if (end === 'confirmation') act(() => sub.next(answer()));
    if (end === 'error') act(() => sub.fail(new Error('unavailable')));
    if (end === 'unmount') view.unmount();
    expect(clear).toHaveBeenCalledWith(firstDeadline);
    act(() => vi.advanceTimersByTime(10_000));
    if (end === 'confirmation') expect(screen.getByText('You haven’t blocked anyone.')).toBeInTheDocument();
  });

  it('bounds an unready memory bridge without opening a direction listener', () => {
    H.session.db = null; const view = render(<BlockedPlayersPanel uid="bob" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument(); expect(H.subs).toHaveLength(0);
    act(() => vi.advanceTimersByTime(10_000)); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(H.retryBridge).toHaveBeenCalledOnce();
    H.session = { ...H.session, db: { memory: true }, generation: 1 };
    view.rerender(<BlockedPlayersPanel uid="bob" />); act(() => H.subs[0].next(answer()));
    expect(screen.getByText('You haven’t blocked anyone.')).toBeInTheDocument();
  });

  it('signed out does not expose an empty private-list result or subscribe', () => {
    H.session = { ...H.session, uid: null, db: null }; render(<BlockedPlayersPanel uid={null} />);
    expect(screen.getByText('Sign in to see your blocked players.')).toBeInTheDocument(); expect(H.subs).toHaveLength(0);
    expect(screen.queryByText('You haven’t blocked anyone.')).toBeNull();
  });

  it('uses the separate bridge Retry when the memory transport itself failed', () => {
    H.session = { ...H.session, uid: null, db: null, failed: true }; render(<BlockedPlayersPanel uid="bob" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(H.retryBridge).toHaveBeenCalledOnce(); expect(H.subs).toHaveLength(0);
  });

  it.each(['UID', 'Event', 'generation'] as const)('retires confirmation, outcome and focus from a held old %s action', async scope => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); let release!: () => void;
    H.commit = () => new Promise<void>(resolve => { release = resolve; });
    const view = render(<BlockedPlayersPanel uid="bob" />); act(() => H.subs[0].next(answer([row])));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Alice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' })); await act(async () => {});
    if (scope === 'UID') H.session = { ...H.session, uid: 'carol', db: { memory: true }, generation: 1 };
    if (scope === 'Event') H.eventId = 'event-b';
    if (scope === 'generation') H.session = { ...H.session, db: { memory: true }, generation: 1 };
    view.rerender(<BlockedPlayersPanel uid={H.session.uid} />); act(() => H.subs[1].next(answer([{ ...row, ownerUid: H.session.uid!, eventId: H.eventId }])));
    await act(async () => { release(); });
    expect(screen.queryByText(/Couldn’t unblock Alice/)).toBeNull(); expect(screen.queryByText(/Unblocked Alice/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yes, unblock' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeEnabled();
    expect(document.activeElement).not.toBe(document.body); expect(view.container.contains(document.activeElement)).toBe(true);
  });

  it('a healthy same-UID publication keeps the current pending action and panel state', async () => {
    let release!: () => void; H.commit = () => new Promise<void>(resolve => { release = resolve; });
    const view = render(<BlockedPlayersPanel uid="bob" />); act(() => H.subs[0].next(answer([row])));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Alice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' })); await act(async () => {});
    H.session = { ...H.session }; view.rerender(<BlockedPlayersPanel uid="bob" />);
    expect(H.subs).toHaveLength(1); expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeDisabled();
    await act(async () => { release(); }); expect(screen.getByText('Unblocked Alice.')).toHaveFocus();
  });

  it('keeps actual unblock waiting/error/focus through a held memory transaction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); let reject!: (error: Error) => void;
    H.commit = () => new Promise<void>((_, fail) => { reject = fail; });
    render(<BlockedPlayersPanel uid="bob" />); act(() => H.subs[0].next(answer([row])));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock Alice' })); expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unblock' })); await act(async () => {});
    expect(H.transactions).toEqual([{ db: H.session.db, paths: ['events/event-a/blocks/bob_alice', 'events/event-a/blockPairs/alice_bob'] }]);
    expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeDisabled();
    act(() => H.subs[0].next(answer([], false, true))); expect(screen.getByText('Alice')).toBeInTheDocument();
    await act(async () => { reject(Object.assign(new Error('unavailable'), { code: 'unavailable' })); });
    expect(screen.getByText(/Couldn’t unblock Alice/)).toHaveFocus(); expect(screen.getByRole('button', { name: 'Unblock Alice' })).toBeEnabled();
  });
});
