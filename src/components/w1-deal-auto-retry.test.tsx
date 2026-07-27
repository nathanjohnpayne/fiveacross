import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { MIN_POOL } from '../game/logic';
import type { ItemDoc } from '../types';

// Covers specs/w1-deal-auto-retry.md: the pool-recovery auto-retry (#70). These are
// RTL-jsdom integration tests against the REAL AuthProvider + REAL PoolRecoveryWatcher
// — the watcher is mounted at the shell inside AuthProvider, so the only way to arm it
// is a genuine pool-shortfall deal failure from the real deal machinery. That is the
// point: the design constraints (context-level mount, real below→above transition,
// fire-once/no-loop, the #117 online/authority gate) are all properties of the whole
// wired system, not a prop-driven panel — the PR #66 round-2 watcher lived on the
// DealError panel and its prop-level tests could not see the unmount-on-navigation hole.

const POOL_ERR = 'dealBoard needs at least 24 prompts, received 5.'; // isPoolShortfall → true
const CONN_ERR = 'network request failed'; // classified 'connection' → never arms the watcher

const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  ensureUserProfile: vi.fn(),
  attestAdult: vi.fn(),
  readAdultAttestation: vi.fn(),
  readAdultAttestationFromCache: vi.fn(),
  hasCachedBoard: vi.fn(),
  hasCachedCard: vi.fn(),
  joinAndDeal: vi.fn(),
  track: vi.fn(),
  // A tiny external store standing in for the live pool subscription: the mocked
  // useItems reads the current snapshot and registers a forceUpdate so `pushPool`
  // can deliver a new snapshot to the mounted watcher exactly like onSnapshot would,
  // without re-rendering the whole tree (which would reset AuthProvider state).
  // `fromCache` + `hasPendingWrites` are the CURRENT snapshot's per-snapshot metadata
  // (the F1 gate the watcher reads: fully server-committed iff both are false);
  // `serverSeen` is the lifetime `hasServerData` latch (true once any server-backed
  // snapshot has arrived) — faithful to useColSub, though the watcher no longer keys off it.
  pool: { items: [] as ItemDoc[], fromCache: true, hasPendingWrites: false },
  serverSeen: false,
  poolListeners: new Set<() => void>(),
  // Every `enabled` arg the watcher passes to useItems — proves the subscription is
  // opened (true) only while armed, and never opened for a non-pool failure.
  useItemsEnabled: [] as (boolean | undefined)[],
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: vi.fn().mockResolvedValue(null),
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: vi.fn(),
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
}));
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {} }));
// AuthProvider also mounts ConfirmWinMoments (#41); stub it — this suite is about the
// pool-recovery watcher, which is real below.
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
// The #479 retraction fall observer mounts beside it — same stub, same reason.
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
vi.mock('../data/api', () => ({
  ensureUserProfile: mocks.ensureUserProfile,
  attestAdult: mocks.attestAdult,
  readAdultAttestationFromServer: mocks.readAdultAttestation,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: mocks.hasCachedBoard,
  hasCachedCard: mocks.hasCachedCard,
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));
// The watcher's live pool subscription, driven by the external store above.
vi.mock('../hooks/useData', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useItems: (enabled?: boolean) => {
      mocks.useItemsEnabled.push(enabled);
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        mocks.poolListeners.add(force);
        return () => {
          mocks.poolListeners.delete(force);
        };
      }, []);
      return {
        items: mocks.pool.items,
        loading: false,
        hasServerData: mocks.serverSeen,
        fromCache: mocks.pool.fromCache,
        hasPendingWrites: mocks.pool.hasPendingWrites,
      };
    },
  };
});

const FAKE_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };

// The auth-state callback AuthProvider registers; emitting a User drives sign-in.
let emitAuth: (u: unknown) => unknown = () => {};

function Harness() {
  const { dealError, dealErrorReason, dealing, retryDeal } = useAuth();
  return (
    <div>
      {dealError ? <p role="alert">{dealError}</p> : null}
      <span data-testid="reason">{dealErrorReason ?? 'none'}</span>
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      {/* The manual Retry (same retryDeal the auto-retry uses), so a test can start a
          deal in flight and then observe a crossing that lands during it (F2). */}
      <button onClick={() => retryDeal()}>retry</button>
    </div>
  );
}

const mount = (children: ReactNode = <Harness />) =>
  render(<AuthProvider>{children}</AuthProvider>);
const signInUser = () => act(async () => void (await emitAuth(FAKE_USER)));

// A promise whose settlement the test drives, to hold a deal in flight (F2).
function deferred<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((settle = res), (fail = rej)));
  return { promise, settle, fail };
}

// n ACTIVE non-free Prompts (each counts toward MIN_POOL), plus `free` Free-Space docs
// that must NOT count (the free centre is excluded from the floor).
function mkItems(activeCount: number, free = 0): ItemDoc[] {
  const items: ItemDoc[] = [];
  for (let i = 0; i < activeCount; i++) {
    items.push({
      id: `p${i}`,
      text: `prompt ${i}`,
      createdBy: 'x',
      createdAt: i,
      isFreeSpace: false,
      status: 'active',
      reportCount: 0,
      spicy: false,
      pool: 'main',
    });
  }
  for (let i = 0; i < free; i++) {
    items.push({
      id: `free${i}`,
      text: 'Complain about Circuit Music',
      createdBy: 'x',
      createdAt: 1000 + i,
      isFreeSpace: true,
      status: 'active',
      reportCount: 0,
      spicy: false,
      pool: 'main',
    });
  }
  return items;
}

// Deliver a pool snapshot to the mounted watcher (the onSnapshot analogue). A snapshot
// with `fromCache === false` latches the lifetime `hasServerData`, mirroring useColSub.
async function deliverPool(items: ItemDoc[], fromCache: boolean, hasPendingWrites: boolean) {
  await act(async () => {
    mocks.pool = { items, fromCache, hasPendingWrites };
    if (!fromCache) mocks.serverSeen = true;
    mocks.poolListeners.forEach((fn) => fn());
    await Promise.resolve();
  });
}

// A fully SERVER-COMMITTED snapshot (`serverBacked=true`) or a CACHE-only replay
// (`serverBacked=false`) — both with no local pending write. The watcher treats only a
// server-committed snapshot as a baseline/trigger; a cache snapshot is ignored (F1).
async function pushPool(activeCount: number, serverBacked: boolean, free = 0) {
  await deliverPool(mkItems(activeCount, free), !serverBacked, false);
}

// A LOCAL OPTIMISTIC prompt-add echo: the listener is current (`fromCache === false`) but
// the write is not yet server-acked (`hasPendingWrites === true`). The watcher must treat
// this as neither a baseline nor a trigger (F1 round 2), because a rejected write or a
// still-thin server read would otherwise spend the recovery edge before the server commit.
async function pushLocalPool(activeCount: number, free = 0) {
  await deliverPool(mkItems(activeCount, free), false, true);
}

function setNavigatorOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: v });
}

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  mocks.pool = { items: [], fromCache: true, hasPendingWrites: false };
  mocks.serverSeen = false;
  mocks.poolListeners.clear();
  mocks.useItemsEnabled = [];
  setNavigatorOnline(true);
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  // Signed-in User reads as already attested (server stamp) so the deal is authorized
  // (online && attestedAuthoritative && attested). The cache read misses (jsdom has no
  // persistent Firestore cache), so the server read is what settles the gate.
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.readAdultAttestation.mockResolvedValue(1);
  mocks.hasCachedBoard.mockResolvedValue(false);
  // No cached card by default (#403): a connection failure surfaces its retry
  // surface here rather than being swallowed, so the watcher assertions hold.
  mocks.hasCachedCard.mockResolvedValue(false);
  mocks.attestAdult.mockResolvedValue(undefined);
  mocks.signInWithPopup.mockResolvedValue({});
  mocks.signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  setNavigatorOnline(true);
});

describe('pool-recovery auto-retry (#70)', () => {
  it('edge-trigger: below-floor deal error → the pool crosses the floor upward → exactly ONE auto-retry', async () => {
    mocks.joinAndDeal
      .mockRejectedValueOnce(new Error(POOL_ERR)) // initial deal fails on the thin pool
      .mockResolvedValueOnce(true); // the auto-retry deals a NEW board
    mount();
    await signInUser();

    // The initial deal failed with the pool-shortfall guard → the watcher is armed.
    expect(await screen.findByRole('alert')).toHaveTextContent(/24 a card needs/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('reason')).toHaveTextContent('pool-shortfall');
    // Armed → it opened the pool subscription (enabled true), never disabled.
    expect(mocks.useItemsEnabled).toContain(true);
    expect(mocks.useItemsEnabled).not.toContain(false);

    // A CACHE-ONLY healthy snapshot is ignored — no server truth, so it neither
    // baselines nor triggers (a stale IndexedDB must not fake a recovery).
    await pushPool(MIN_POOL + 5, false);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // First SERVER-CONFIRMED snapshot is the baseline (below-floor), never a trigger.
    await pushPool(MIN_POOL - 1, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // The pool crosses the floor upward (server-confirmed) → exactly one auto-retry,
    // which deals the board and clears the error.
    await pushPool(MIN_POOL + 2, true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mocks.track).toHaveBeenCalledWith('join_event');

    // The deal succeeded → the error cleared → the watcher disarmed. A later snapshot
    // must not deal again.
    await pushPool(MIN_POOL + 9, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);
  });

  it('seeded-baseline: even when ARMED, the first server-confirmed snapshot is a baseline — a first HEALTHY snapshot does NOT auto-retry, only a later crossing does', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR)).mockResolvedValueOnce(true);
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
    expect(mocks.useItemsEnabled).toContain(true); // armed on the pool-shortfall failure

    // The FIRST server-confirmed snapshot happens to already be healthy (the pool
    // recovered in the window before the watcher subscribed). It is the baseline, not a
    // trigger — no auto-retry fires from a first snapshot, even a healthy one.
    await pushPool(MIN_POOL + 3, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeInTheDocument(); // still up; manual Retry remains

    // Only a genuine below→above crossing from that baseline fires: dip, then cross.
    await pushPool(MIN_POOL - 1, true);
    await pushPool(MIN_POOL + 1, true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
  });

  it('excludes Free-Space docs from the floor — a below→above crossing needs MIN_POOL real Prompts', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR)).mockResolvedValueOnce(true);
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await pushPool(MIN_POOL - 1, true); // baseline below
    // 23 real Prompts + a Free-Space doc = MIN_POOL docs but only 23 toward the floor:
    // still below, so no crossing, no retry.
    await pushPool(MIN_POOL - 1, true, 1);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // 24 real Prompts (plus free) actually crosses the floor → the auto-retry fires.
    await pushPool(MIN_POOL, true, 2);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
  });

  it('no-fire-on-initial-load: a NON-pool (connection) failure never arms the watcher, so a healthy first snapshot does NOT auto-retry', async () => {
    mocks.joinAndDeal.mockRejectedValue(new Error(CONN_ERR)); // connection failure, not a thin pool
    mount();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
    expect(screen.getByTestId('reason')).toHaveTextContent('connection');
    // The watcher never armed: no pool subscription was ever opened for a non-pool
    // failure (PoolRecoveryWatcher renders null when the reason isn't pool-shortfall).
    expect(mocks.useItemsEnabled).not.toContain(true);

    // A healthy first pool snapshot arriving must NOT trigger an auto-retry — the
    // classic useItems()-starts-empty misfire the design forbids.
    await pushPool(MIN_POOL + 6, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('a PERMANENT (permission-denied) failure classifies as reason "permanent", never "connection", and never arms the watcher (#434)', async () => {
    // #434 (Codex #438): a rules/permission failure is NOT a transient connection
    // blip, so App must never swap in a cached card for it. AuthContext now marks it
    // reason "permanent" (the generic message copy is unchanged) — distinct from the
    // "connection" class the cached-card fallback renders for.
    mocks.joinAndDeal.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    mount();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i); // generic message, unchanged
    expect(screen.getByTestId('reason')).toHaveTextContent('permanent');
    // Not pool-shortfall, so the pool-recovery watcher never arms.
    expect(mocks.useItemsEnabled).not.toContain(true);
  });

  it('fire-once + no-loop: a failed auto-retry does not spin, but a second genuine below→above recovery fires again (once each)', async () => {
    mocks.joinAndDeal.mockRejectedValue(new Error(POOL_ERR)); // every deal fails on the thin pool
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    await pushPool(MIN_POOL - 1, true); // baseline below
    await pushPool(MIN_POOL + 1, true); // recovery #1 → auto-retry
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));

    // The auto-retry failed again; the error is still up and the pool is still healthy.
    // The latch must hold — no spin — across further at/above-floor snapshots.
    await pushPool(MIN_POOL + 4, true);
    await pushPool(MIN_POOL + 7, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);

    // Only a genuine NEW recovery (dip below the floor, then cross it again) re-fires.
    await pushPool(MIN_POOL - 2, true); // dip re-arms the below baseline
    await pushPool(MIN_POOL + 1, true); // recovery #2 → auto-retry #2
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(3));

    // ...and still exactly once per recovery, not per snapshot.
    await pushPool(MIN_POOL + 3, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(3);
  });

  it('F1 (Codex P2 3553033594): a CACHE/local snapshot after a server below-floor baseline is NOT a crossing — only a server-backed above-floor snapshot fires', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR)).mockResolvedValueOnce(true);
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // A server-backed below-floor baseline. This latches the lifetime `hasServerData`
    // true for the rest of the subscription — the exact condition that made the old
    // latched gate wrong.
    await pushPool(MIN_POOL - 1, true);

    // A CACHE/local snapshot now shows above-floor (a local prompt-add echo, or an
    // IndexedDB replay). Because `hasServerData` is already latched, a latch-gated
    // detector would read this as a server crossing and CONSUME the edge. It must not:
    // the SERVER pool has not crossed the floor, so no retry, and the edge survives.
    await pushPool(MIN_POOL + 3, false);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // The real SERVER above-floor confirmation now fires the retry — exactly once,
    // proving the cache snapshot neither triggered nor spent the edge.
    await pushPool(MIN_POOL + 3, true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
  });

  it('F1 round 2 (Codex P2 3553182524): a LOCAL optimistic above-floor snapshot (fromCache false, hasPendingWrites true) is NOT a crossing — only the server-committed confirmation fires', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR)).mockResolvedValueOnce(true);
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // A fully server-committed below-floor baseline.
    await pushPool(MIN_POOL - 1, true);

    // This client adds the FINAL prompt: Firestore emits an OPTIMISTIC local snapshot —
    // `fromCache === false` (the listener is current, so it is not a cache read) but
    // `hasPendingWrites === true` (the write is not yet server-acked). A `fromCache`-only
    // gate would treat this as a server crossing and fire the retry BEFORE the commit; it
    // must NOT — no retry, and the edge is not consumed.
    await pushLocalPool(MIN_POOL + 1);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // The server ACKS the write → a fully server-committed above-floor snapshot (both
    // flags false) → the retry fires exactly once, proving the optimistic echo neither
    // triggered nor spent the edge.
    await pushPool(MIN_POOL + 1, true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
  });

  it('F2 (Codex P2 3553033597): a crossing observed while a deal is in flight is NOT consumed — it fires once the deal settles, and a failed auto-retry still needs a fresh crossing', async () => {
    const inFlight = deferred<boolean>();
    mocks.joinAndDeal
      .mockRejectedValue(new Error(POOL_ERR)) // base: calls after the queue fail on the thin pool
      .mockRejectedValueOnce(new Error(POOL_ERR)) // call 1: the initial deal fails
      .mockReturnValueOnce(inFlight.promise); // call 2: the manual Retry stays in flight
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    await pushPool(MIN_POOL - 1, true); // server-backed below-floor baseline

    // The player presses manual Retry just before the final prompt-add — the deal reads
    // the still-below pool and is left in flight.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('dealing')).toHaveTextContent('dealing');

    // The final prompt-add now lands as a SERVER above-floor snapshot WHILE that deal is
    // still in flight. The crossing must NOT be consumed (no auto-retry yet).
    await pushPool(MIN_POOL + 2, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);

    // The in-flight manual deal fails (it read the below-floor pool); `dealing` clears
    // and the error stays up. The PRESERVED crossing now fires the auto-retry — exactly
    // once — against the still-standing server above-floor snapshot (this retry, call 3,
    // also fails on the pool-shortfall).
    await act(async () => {
      inFlight.fail(new Error(POOL_ERR));
      await inFlight.promise.catch(() => {});
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(3));

    // No loop: the edge was consumed by that fire, so a further server above-floor
    // snapshot does not re-fire.
    await pushPool(MIN_POOL + 5, true);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(3);

    // Only a genuine fresh below→above crossing fires again (call 4).
    await pushPool(MIN_POOL - 1, true);
    await pushPool(MIN_POOL + 1, true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(4));
  });

  it('#117 coordination: the auto-retry goes through retryDeal, so it does NOT deal while offline', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // The device drops offline while the pool-shortfall error is still up.
    setNavigatorOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await Promise.resolve();
    });

    // The pool recovers (server-confirmed, in this controlled harness) and the watcher
    // fires — but retryDeal, the same path the manual button uses, gates the deal on
    // `online`, so offline it re-runs the cache-first bootstrap and creates NO board.
    await pushPool(MIN_POOL - 1, true); // baseline below
    await pushPool(MIN_POOL + 2, true); // crossing → watcher fires retryDeal
    await act(async () => {
      await Promise.resolve();
    });
    // No second joinAndDeal: the auto-retry inherited #117's write-safety gate rather
    // than dealing unconditionally.
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
    // It routed through the cache-first bootstrap (retryDeal's offline branch) instead.
    expect(mocks.readAdultAttestationFromCache).toHaveBeenCalled();
  });
});
