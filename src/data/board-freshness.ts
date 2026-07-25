// Day-board seed freshness registry (#474, specs/echo-marks.md § Mark-time).
//
// The mark-time Echo pass (runSetMark, ./api.ts) reads each SIBLING Day board
// from the persistent cache and stamps that board's cached `seed` as the echo
// write's `markSeed`. A cache read carries no freshness metadata — a sibling
// reshuffled on ANOTHER device since this device last saw it returns the OLD
// seed, `seededMarkGuard` (firestore.rules) denies that one write, and the
// whole atomic batch — the acted Mark included — rolls back. The player
// watches their square revert.
//
// This module is the trust signal that closes that vector: a sibling's cached
// seed is ECHO-TRUSTED only while a live `onSnapshot` watch on that board has
// delivered a fully SERVER-COMMITTED snapshot (`!fromCache &&
// !hasPendingWrites` — the same two-flag discipline as useData's
// pool-recovery gate) during its lifetime, and the seed it confirmed matches
// the cached one. `useMyDayBoards` (src/hooks/useData.ts) — mounted for every
// signed-in Player via ConfirmWinMoments — feeds the registry, so in the
// common case every sibling is trusted and echoes flow exactly as before.
// An untrusted sibling is simply SKIPPED at mark time; the open-time
// reconcile (spec § Open-time) self-heals the missing echo on that board's
// next open, which is the contract the spec already provides for
// cache-missed siblings.
//
// Fail-closed by construction: when the last watcher for a board unsubscribes
// the entry is DROPPED — a seed confirmed under a watch that no longer exists
// could go stale unobserved, so it stops being trusted. While a watch stays
// live, the trust is a LATCH: a later cache-origin snapshot (e.g. the network
// dropping) does not revoke it, because offline Marks must still echo (spec
// acceptance: "a Mark made offline … echoes ride the same durable batch").
// The residual — a remote reshuffle during THIS device's offline window —
// is accepted and documented in the spec's Residuals.
//
// The registry is deliberately Firestore-free (plain module state, keyed by
// `${dayIndex}:${uid}`) so the mock-Firestore unit suites and the emulator
// suites drive it the same way the hooks do.

type Entry = {
  /** Live `onSnapshot` subscriptions currently feeding this board. */
  watchers: number;
  /** Has a fully server-committed snapshot arrived while watched? */
  serverSeen: boolean;
  /** The board `seed` that snapshot confirmed (undefined: no/absent seed). */
  seed: number | undefined;
};

const entries = new Map<string, Entry>();

const keyOf = (dayIndex: number, uid: string) => `${dayIndex}:${uid}`;

/**
 * Register a live watch on a Day board. Returns an idempotent release
 * function; when the LAST watcher releases, the board's trust entry is
 * dropped entirely (fail closed — see module comment).
 */
export function beginDayBoardSeedWatch(dayIndex: number, uid: string): () => void {
  const key = keyOf(dayIndex, uid);
  const entry = entries.get(key) ?? { watchers: 0, serverSeen: false, seed: undefined };
  entry.watchers += 1;
  entries.set(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = entries.get(key);
    if (!current) return;
    current.watchers -= 1;
    if (current.watchers <= 0) entries.delete(key);
  };
}

/**
 * Feed one watched board snapshot into the registry. Only a fully
 * SERVER-COMMITTED snapshot (`!fromCache && !hasPendingWrites`) latches
 * trust and records the confirmed seed; cache-origin and local-optimistic
 * snapshots are ignored (a pending local reshuffle's new seed is trusted
 * only once the server acks it). A server-confirmed NONEXISTENT board
 * records `seed: undefined` — which can never match a stale cached board
 * that still claims a seed.
 */
export function recordDayBoardSeedSnapshot(
  dayIndex: number,
  uid: string,
  snap: {
    metadata?: { fromCache?: boolean; hasPendingWrites?: boolean };
    exists(): boolean;
    data(): unknown;
  },
): void {
  const entry = entries.get(keyOf(dayIndex, uid));
  if (!entry || entry.watchers <= 0) return;
  // Absent metadata (a test double) reads as untrusted — fail closed.
  if (!snap.metadata || snap.metadata.fromCache !== false || snap.metadata.hasPendingWrites !== false)
    return;
  const seed = snap.exists() ? (snap.data() as { seed?: unknown } | undefined)?.seed : undefined;
  entry.serverSeen = true;
  entry.seed = typeof seed === 'number' ? seed : undefined;
}

/**
 * The mark-time echo gate (#474): is this sibling board's cached seed safe to
 * stamp as `markSeed`? Trusted only while a live watch exists AND a
 * server-committed snapshot arrived under it; `seed` is the confirmed value
 * the caller must match against the cached one.
 */
export function trustedDayBoardSeed(
  dayIndex: number,
  uid: string,
): { trusted: boolean; seed: number | undefined } {
  const entry = entries.get(keyOf(dayIndex, uid));
  if (!entry || !entry.serverSeen) return { trusted: false, seed: undefined };
  return { trusted: true, seed: entry.seed };
}

/** Test-only: drop all registry state between cases. */
export function __resetBoardFreshnessForTests(): void {
  entries.clear();
}
