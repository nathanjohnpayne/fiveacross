import { doc, getDoc, getDocFromCache, getDocFromServer, setDoc, writeBatch } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import { markerDisplayName } from './attribution';
import { hasBingo, isBlackout } from '../game/logic';
import type { Cell, MomentDoc, MomentKind } from '../types';

// Moments (ADR 0002): a broadcast of a big social beat — a BINGO, a Blackout, or
// the First to BINGO — posted to the Feed for everyone. Unlike a Proof, a Moment
// carries NO attached evidence: it marks *that* something happened, not what it
// looked like, so its payload is EXACTLY the MomentDoc contract — no media, no
// `mediaURL`/`storagePath`, no `proofId`. A bare Mark broadcasts nothing here
// (ADR 0002): only these three edges do. Writes mirror the mark path's
// offline-queueable, fire-and-forget style (setMark in src/data/api.ts): a
// `setDoc` pends durably in the persistent cache when offline (ADR 0006) and the
// promise is intentionally not awaited — `void … .catch(console.error)` so a
// broadcast never blocks the celebration UI, and an ONLINE rejection is logged
// (never silently swallowed) rather than surfaced as a retry.

// Raw (converter-free) moment ref for writes, matching api.ts's rawPlayer/rawBoard
// and proofs.ts's rawProof — the read side attaches `momentConverter` via
// `momentsCol`/`momentRef` (src/data/paths.ts).
const rawMoment = (id: string) => doc(db, 'events', EVENT_ID, 'moments', id);

/**
 * The RETRACTION TOMBSTONE ref for a Moment id (#377). Same id as the Moment it
 * retracts, in a sibling collection — so "is this win spent?" is one lookup at a
 * known path on both the client (cache-only, below) and the rules (`exists()` in
 * the moments create rule).
 *
 * Not to be confused with Firestore's own cached-deletion tombstone (a
 * `getDocFromCache` snapshot with `exists() === false`), which is a local SDK
 * artifact; this is a real, server-side, publicly readable doc.
 */
const rawMomentRetraction = (id: string) => doc(db, 'events', EVENT_ID, 'momentRetractions', id);

/** The two Moment kinds a Player can retract (#377) — the PER-CARD wins. The
 *  ceremonial `first_bingo` singleton is deliberately not retractable: it is the
 *  event-wide honor, admin-delete-only, and a per-Player retraction path would
 *  hand one Player a lever on an Event-level record. */
type RetractableKind = 'bingo' | 'blackout';

/**
 * The tombstone payload — exactly the keys the rules' `hasOnly` allows. `dayIndex`
 * is present iff the retraction knows its Day (a daily Event), and then rides on
 * BOTH tombstone forms — the day-suffixed per-card id where the rules bind it to
 * the id, and the day-LESS legacy id where it is pure provenance recording WHICH
 * Day spent the legacy slot (the rules validate it against the schedule either
 * way). A legacy single-board Event's tombstone carries no `dayIndex` at all.
 */
interface RetractionTombstone {
  uid: string;
  kind: RetractableKind;
  dayIndex?: number;
  createdAt: number;
}

/**
 * The event-singleton doc id for the ceremonial "First to BINGO" Moment. Because
 * the moments rules block does NOT constrain `momentId` (see firestore.rules
 * § moments), the doc id is CALLER-CHOSEN — the strongest dedup the rules allow.
 * A fixed per-event id makes "First to BINGO" structurally ONCE per Event: the
 * first writer's create wins, and any later writer hits the doc-exists `update`
 * rule, which is DENIED for everyone — a Moment is fully immutable (see
 * firestore.rules § moments, PR #99 finding 4) — so their write is denied and
 * swallowed (see `broadcast`). This is the honest, ceremonial, self-reported honour (ADR 0001):
 * under an offline/latency race two Players may each briefly believe they are
 * first and each optimistically show their own local Moment, but exactly one
 * create reaches the server and both clients converge on it. The value cannot
 * collide with a per-Player id (`${uid}-bingo` / `${uid}-blackout` use a hyphen
 * before the kind; this uses an underscore and no uid prefix).
 */
export const FIRST_BINGO_MOMENT_ID = 'first_bingo';

/**
 * The identity a Moment is attributed to — the SAME resolved public identity a
 * Mark's Tally marker and a Proof carry (ADR 0002), so the Feed, the leaderboard,
 * and the Tally never diverge. Board resolves it once via `resolveDisplayName`
 * (the saved player-row name, else auth, else 'Anonymous').
 */
export interface MomentActor {
  uid: string;
  displayName: string;
  photoURL: string | null;
}

// --- The pending-Moment queue (issue #104): a win awaiting its gate ---------
//
// A win Moment broadcasts off the MARK that completed it (setMark's synchronous
// transition verdict, consumed in Board.doMark) — not off snapshot diffing. But
// the broadcast still has GATES: a KNOWN saved identity for all three kinds (never
// stamp a returning Player's stale auth name into an IMMUTABLE Moment), plus a
// SERVER-CONFIRMED roster for the ceremonial First-to-BINGO. When a win crosses
// while a gate is still closed, its broadcast must WAIT for the gate to open.
//
// Round-4 of PR #99 kept that waiting state in a COMPONENT ref in Board.tsx, so a
// Player who left the Card route before the gate opened lost the Moment forever
// (the ref died with the unmount, and the returning board baselined the already
// standing win). This queue lifts that state to MODULE scope — keyed by app+uid,
// the same durability pattern `markChains` uses in api.ts — so it survives Board
// unmounts and route changes: whichever Board mount next sees the gate open drains
// it. The deterministic Moment doc id keeps a held-then-fired broadcast idempotent,
// and the writer's write-once cache pre-check + create-only rule are the structural
// once-only backstop besides. Plain per-Day win transitions also persist to
// localStorage per Event + Player: an Echo can complete a sibling Day while that
// card is not displayed, and its transition must survive a reload until the card's
// normal drain revalidates it. The ceremonial candidate remains memory-only.
export interface PendingMomentFlags {
  bingo: boolean;
  blackout: boolean;
  firstBingo: boolean;
}
// The STORED entry carries INTERNAL fields beyond the public triple (PR #110
// round 2 finding 3; Codex finding 2 on fix/d15-blackout-day-naming):
//   - `firstBingoGeneration`: the action generation at which the ceremonial
//     candidate was enqueued. A candidate can be held for a long time (roster
//     gate, unmounts), and the drain must fire it only if the uid's generation
//     is UNCHANGED since its enqueue (`firstBingoCandidateCurrent`): an
//     interleaved OBSERVED BINGO FALL bumps the generation and thereby kills
//     stale candidates (round 4 narrowed the bump — a no-drop unmark or a
//     blackout-only fall preserves a valid candidate; every in-app bingo-fall
//     bump also clears the candidate, so the stamp is belt-and-braces against
//     future bump sites rather than a reachable kill today).
//   - `blackoutDayIndexes`: the Day(s) blackout-completing Marks happened on,
//     captured at ENQUEUE time (Codex finding 2): a blackout can sit pending
//     for a while (the identity gate, `drainMoments`'s first check, blocks
//     EVERY kind — not just the ceremonial one), and a Player who switches the
//     VIEWED Day during that window must not have the eventual drain stamp the
//     Moment with whatever Day happens to be on screen when it fires. A SET
//     of Days, not a single first-write-wins stamp (#267): blackout is
//     per-card (daily-cards-spec § "Scoring and social surfaces"), the
//     deterministic id is per-(Player, Day) — `${uid}-blackout-d${dayIndex}`
//     — so a second Day's card blacking out while an earlier Day's Moment is
//     still pending must queue its OWN Day rather than be swallowed.
// `peekPendingMoments` projects the public triple, keeping these internal.
interface StoredPendingFlags extends PendingMomentFlags {
  firstBingoGeneration: number;
  blackoutDayIndexes?: number[];
  // The Day(s) bingo-completing Marks happened on. A SET since #372, for the
  // same reason `blackoutDayIndexes` became one in #267: bingo is now PER-CARD
  // (`${uid}-bingo-d${dayIndex}`), so a second Day's card bingoing while an
  // earlier Day's Moment is still pending must queue its OWN Day rather than be
  // swallowed by a first-write-wins stamp. Pre-#372 this was a single
  // `bingoDayIndex` because the once-per-Player `${uid}-bingo` id meant only the
  // first queued Day could ever actually post — which was the #372 bug.
  bingoDayIndexes?: number[];
  // The ceremonial candidate's OWN Day (#262; Codex P3 on #286 round 2),
  // stamped at enqueueFirstBingoMoment time. Deliberately SEPARATE from
  // `bingoDayIndex`: the candidate is enqueued AFTER an async witness read,
  // and a snapshot/gate drain can legitimately fire (and clear) the plain
  // bingo — day included — inside that window, so the ceremony must not
  // borrow the bingo's day at drain time.
  firstBingoDayIndex?: number;
}
const pendingMoments = new Map<string, StoredPendingFlags>();
const hydratedPending = new Set<string>();
const pendingStorageKeys = new Set<string>();

function pendingStorageKey(uid: string): string {
  return `gcb:pending-moments:${EVENT_ID}:${uid}`;
}

function pendingStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function safeDayIndexes(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every((day) => Number.isSafeInteger(day) && day >= 0)) return undefined;
  return [...new Set(value)];
}

function restorePending(uid: string): void {
  const key = pendingKey(uid);
  if (hydratedPending.has(key)) return;
  hydratedPending.add(key);
  const store = pendingStore();
  if (!store) return;
  const storageKey = pendingStorageKey(uid);
  pendingStorageKeys.add(storageKey);
  try {
    const parsed = JSON.parse(store.getItem(storageKey) ?? 'null') as {
      v?: unknown;
      flags?: Partial<StoredPendingFlags>;
      generation?: unknown;
    } | null;
    if (!parsed || parsed.v !== 1 || !parsed.flags) return;
    const bingoDayIndexes = safeDayIndexes(parsed.flags.bingoDayIndexes);
    const blackoutDayIndexes = safeDayIndexes(parsed.flags.blackoutDayIndexes);
    const flags: StoredPendingFlags = {
      bingo: parsed.flags.bingo === true,
      blackout: parsed.flags.blackout === true,
      firstBingo: false,
      firstBingoGeneration: 0,
      ...(bingoDayIndexes ? { bingoDayIndexes } : {}),
      ...(blackoutDayIndexes ? { blackoutDayIndexes } : {}),
    };
    if (!flags.bingo && !flags.blackout) return;
    pendingMoments.set(key, flags);
  } catch {
    // A corrupt or blocked store is a cache miss; the live queue still works.
  }
}

function persistPending(uid: string): void {
  const key = pendingKey(uid);
  const store = pendingStore();
  if (!store) return;
  const storageKey = pendingStorageKey(uid);
  pendingStorageKeys.add(storageKey);
  try {
    const flags = pendingMoments.get(key);
    if (!flags || (!flags.bingo && !flags.blackout)) {
      store.removeItem(storageKey);
      return;
    }
    const plainWins = {
      bingo: flags.bingo,
      blackout: flags.blackout,
      firstBingo: false,
      firstBingoGeneration: 0,
      ...(flags.bingoDayIndexes ? { bingoDayIndexes: flags.bingoDayIndexes } : {}),
      ...(flags.blackoutDayIndexes ? { blackoutDayIndexes: flags.blackoutDayIndexes } : {}),
    };
    store.setItem(
      storageKey,
      JSON.stringify({ v: 1, flags: plainWins }),
    );
  } catch {
    // Storage is a durability enhancement, never a gate on the in-memory queue.
  }
}

// The per-uid ACTION GENERATION (Codex P1 on PR #110): a monotonically increasing
// token bumped by every OBSERVED BINGO FALL (`dropPendingWins` with fell.bingo —
// round 4 narrowed it from every-unmark: only what changes whether the bingo
// stands may stale the ceremonial machinery).
// Board's ceremonial First-to-BINGO enqueue crosses an async gap (the durable-
// witness cache read), and the pending win can change inside that gap: the player
// unmarks and loses the bingo, the unmark verdict drops the queued flags — and a
// stale continuation that re-enqueued on the uid check alone would let a later
// drain publish the IMMUTABLE event-level singleton for a win that no longer
// stands. The continuation therefore captures the generation BEFORE the await and
// enqueues ONLY if it is unchanged after (round 2 finding 2 corrected the round-1
// dual check: the pending-flag recheck was over-tight — a concurrent drain can
// legitimately FIRE the plain bingo mid-read, and that clear must not forfeit the
// ceremony; whether the win still STANDS is the drain's fire-time revalidation,
// not the continuation's). The token also stamps each ceremonial candidate at
// enqueue (round 2 finding 3 — see `firstBingoCandidateCurrent`). Kept in a
// SEPARATE map from the flags: the flags entry is deleted when empty, and a
// deleted-then-recreated entry must not reset the token to a value a stale
// continuation already captured.
const pendingGenerations = new Map<string, number>();

// The generation at which THIS device actually WROTE a given bingo Moment doc
// (#332): stamped inside `writeMomentOnce` at the moment the plain-bingo write
// proceeds past the cache pre-check — i.e. only when the doc was NOT already
// cached, so a regain (whose pre-check finds the genuine prior doc and skips the
// write) never records one. `hasPriorBingoWitness` consults it to tell "a prior
// win's doc" from "this very win's doc, drained into the cache while the witness
// read was in flight" — the birth-time-witness race that suppressed ~2/8
// ceremonial First-to-BINGO Moments under concurrent gate-open drains.
//
// Keyed by (uid, MOMENT DOC ID), not by uid alone (#372). Under the once-per-
// Player `${uid}-bingo` id a uid key was unambiguous — there was only ever one
// bingo doc to stamp. Per-card ids mean a Player owns one doc PER DAY while the
// generation only bumps on a bingo FALL, so two bingos on different Days share a
// generation: a uid-keyed stamp from the Day-3 write would make a genuine Day-3
// prior win read as "this very win's write" during the Day-5 witness read, and
// wrongly mint a second ceremony. Keying on the doc id keeps each stamp bound to
// the exact doc it describes. Cleared with `pendingGenerations` in
// `resetPendingMoments`.
const selfBingoWriteGenerations = new Map<string, number>();
function selfWriteKey(uid: string, momentId: string): string {
  return `${pendingKey(uid)}#${momentId}`;
}

// Key by app + uid (mirrors `markChains` in api.ts). The moment writers always
// use the module `db` singleton, so the app segment is effectively constant here;
// keying on uid is what actually isolates two identities sharing a browser (a
// held win for one account must never drain under the other), and the app prefix
// keeps the shape identical to the mark-chain key for anyone reading both.
function pendingKey(uid: string): string {
  const appName = (db as unknown as { app?: { name?: string } }).app?.name ?? 'default';
  return `${appName}/${uid}`;
}

function ensurePending(uid: string): StoredPendingFlags {
  const key = pendingKey(uid);
  restorePending(uid);
  let flags = pendingMoments.get(key);
  if (!flags) {
    flags = { bingo: false, blackout: false, firstBingo: false, firstBingoGeneration: 0 };
    pendingMoments.set(key, flags);
  }
  return flags;
}

function readPending(uid: string): StoredPendingFlags | undefined {
  restorePending(uid);
  return pendingMoments.get(pendingKey(uid));
}

/**
 * Enqueue the per-Player win Moment(s) a mark just COMPLETED — driven by
 * `setMark`'s transition verdict (Board.doMark), never by a snapshot diff. Only a
 * rising edge enqueues; a no-op call (neither transition) leaves the queue
 * untouched so it never resurrects a drained-or-absent flag.
 *
 * `dayIndex` (optional) is the Day the completing Mark happened on — captured
 * HERE, at enqueue time, not re-read from render state at drain time (Codex
 * finding 2 on fix/d15-blackout-day-naming). BOTH per-card kinds accumulate one
 * entry per distinct Day — blackout since #267, bingo since #372 — so a win on a
 * second Day queues its own Day rather than being swallowed by an earlier
 * pending one (see `StoredPendingFlags.bingoDayIndexes` /
 * `.blackoutDayIndexes`).
 */
export function enqueueWinMoments(params: {
  uid: string;
  bingoTransition: boolean;
  blackoutTransition: boolean;
  dayIndex?: number;
}): void {
  const { uid, bingoTransition, blackoutTransition, dayIndex } = params;
  if (!bingoTransition && !blackoutTransition) return;
  const flags = ensurePending(uid);
  if (bingoTransition) {
    flags.bingo = true;
    if (dayIndex !== undefined) {
      flags.bingoDayIndexes ??= [];
      if (!flags.bingoDayIndexes.includes(dayIndex)) flags.bingoDayIndexes.push(dayIndex);
    }
  }
  if (blackoutTransition) {
    flags.blackout = true;
    if (dayIndex !== undefined) {
      flags.blackoutDayIndexes ??= [];
      if (!flags.blackoutDayIndexes.includes(dayIndex)) flags.blackoutDayIndexes.push(dayIndex);
    }
  }
  persistPending(uid);
}

/**
 * Enqueue the ceremonial First-to-BINGO candidate for a just-completed bingo. Kept
 * separate from `enqueueWinMoments` because the caller gates it on the durable
 * prior-win witness first (`hasPriorBingoWitness`, PR #99 round 2 finding D): a
 * regained line whose owner already has a `${uid}-bingo` Moment must not re-claim
 * the event singleton. The roster gate (no OTHER Player has an earlier bingo) is
 * applied at DRAIN time, where the confirmed roster lives. The candidate is
 * STAMPED with the current action generation (PR #110 round 2 finding 3): the
 * drain fires it only while that stamp is current (`firstBingoCandidateCurrent`).
 */
export function enqueueFirstBingoMoment(uid: string, dayIndex?: number): void {
  const flags = ensurePending(uid);
  flags.firstBingo = true;
  flags.firstBingoGeneration = pendingActionGeneration(uid);
  // The candidate's own Day (#262; Codex P3 on #286 round 2) — a re-enqueue is
  // a NEW candidate (new generation), so it overwrites rather than first-wins.
  flags.firstBingoDayIndex = dayIndex;
  persistPending(uid);
}

/**
 * The pending flags for `uid` (a stable empty triple when nothing is queued),
 * PROJECTED to the public triple — the internal candidate-generation stamp stays
 * internal. The drainer reads this, applies the identity/roster gates plus the
 * fire-time revalidation, broadcasts, then clears each fired kind via
 * `clearPendingMoment`.
 */
export function peekPendingMoments(uid: string): PendingMomentFlags {
  const flags = readPending(uid);
  return flags
    ? { bingo: flags.bingo, blackout: flags.blackout, firstBingo: flags.firstBingo }
    : { bingo: false, blackout: false, firstBingo: false };
}

/**
 * The Day(s) still-pending blackouts were ENQUEUED on (Codex finding 2 on
 * fix/d15-blackout-day-naming; per-card set per #267) — empty when nothing is
 * queued or the enqueue carried no Day (a legacy, non-daily caller). The drain
 * reads this instead of whatever Day happens to be VIEWED at fire time: a
 * blackout can sit pending behind the identity gate for a while, and the
 * Player may have switched Days in that window.
 */
export function pendingBlackoutDayIndexes(uid: string): number[] {
  return [...(readPending(uid)?.blackoutDayIndexes ?? [])];
}

/**
 * The Day(s) still-pending bingos were ENQUEUED on (#262; per-card set per
 * #372) — empty when nothing is queued or the enqueue carried no Day (a legacy,
 * non-daily caller). The twin of `pendingBlackoutDayIndexes`, for the same
 * reason: the drain reads the ENQUEUE-time Day rather than whatever Day happens
 * to be VIEWED at fire time, because a bingo can sit pending behind the identity
 * gate while the Player switches Days.
 */
export function pendingBingoDayIndexes(uid: string): number[] {
  return [...(readPending(uid)?.bingoDayIndexes ?? [])];
}

/** The still-pending ceremonial candidate's OWN Day (#262; Codex P3 on #286
 *  round 2) — `undefined` when no candidate is queued or it carried no Day. */
export function pendingFirstBingoDayIndex(uid: string): number | undefined {
  return readPending(uid)?.firstBingoDayIndex;
}

/**
 * Remove ONE drained Day from the pending blackout queue (#267; Codex P2 on
 * #275): the drain adjudicates per-Day — only the Day whose own board is the
 * rendered, blacked-out one may fire — so a fired Day leaves the queue while
 * sibling queued Days stay pending. The `blackout` flag clears only when the
 * queue empties (the flag means "something is still owed").
 */
export function removePendingBlackoutDay(uid: string, dayIndex: number): void {
  const key = pendingKey(uid);
  const flags = readPending(uid);
  if (!flags?.blackoutDayIndexes) return;
  flags.blackoutDayIndexes = flags.blackoutDayIndexes.filter((d) => d !== dayIndex);
  if (flags.blackoutDayIndexes.length === 0) {
    flags.blackoutDayIndexes = undefined;
    flags.blackout = false;
    if (!flags.bingo && !flags.firstBingo) pendingMoments.delete(key);
  }
  persistPending(uid);
}

/**
 * Remove ONE drained Day from the pending BINGO queue (#372) — the exact twin of
 * `removePendingBlackoutDay`, and needed for the same reason now that bingo is
 * per-card: `bingoNow` witnesses exactly ONE board, so only the queued Day that
 * IS that board may fire against it, and a fired Day must leave the queue while
 * sibling queued Days stay pending. The `bingo` flag clears only when the queue
 * empties (the flag means "something is still owed").
 */
export function removePendingBingoDay(uid: string, dayIndex: number): void {
  const key = pendingKey(uid);
  const flags = readPending(uid);
  if (!flags?.bingoDayIndexes) return;
  flags.bingoDayIndexes = flags.bingoDayIndexes.filter((d) => d !== dayIndex);
  if (flags.bingoDayIndexes.length === 0) {
    flags.bingoDayIndexes = undefined;
    flags.bingo = false;
    if (!flags.blackout && !flags.firstBingo) pendingMoments.delete(key);
  }
  persistPending(uid);
}

/**
 * True when a ceremonial candidate is queued AND was enqueued at the CURRENT
 * action generation — no OBSERVED BINGO FALL has interleaved since (PR #110
 * round 2 finding 3; round 4 narrowed the bump to actual bingo falls). A stale candidate (generation moved) must be KILLED by the
 * drain, never fired: the win context it was enqueued for no longer describes the
 * board. The complementary protection for falls this tab NEVER observed (no bump)
 * is the drain-time witness re-check in Board's drain — see specs/w2-feed-moments.md
 * § PR #110 hardening.
 */
export function firstBingoCandidateCurrent(uid: string): boolean {
  const flags = readPending(uid);
  if (!flags?.firstBingo) return false;
  return flags.firstBingoGeneration === pendingActionGeneration(uid);
}

/**
 * The current action generation for `uid` (see `pendingGenerations` above).
 * Board's doMark captures this immediately before the async durable-witness read
 * and re-reads it in the continuation: a mismatch means the BINGO the action
 * described has since been OBSERVED TO FALL (an unmark verdict or a passive
 * falling edge — PR #110 round 4 narrowed the bump to actual bingo falls), so
 * the ceremonial enqueue is refused (Codex P1, PR #110).
 */
export function pendingActionGeneration(uid: string): number {
  restorePending(uid);
  return pendingGenerations.get(pendingKey(uid)) ?? 0;
}

/**
 * Record what an unmark verdict or a passive falling-edge snapshot showed FELL:
 * clears the corresponding still-held flags — a bingo fall also drops the
 * ceremonial candidate, which cannot outlive the win it accompanies — and bumps
 * the action generation ON AN ACTUAL BINGO FALL ONLY (Codex P2, PR #110 round 4).
 * The generation's sole consumers are the CEREMONIAL machinery — the birth-time
 * witness continuation and the candidate stamp — so only an event that changes
 * whether the bingo stands may stale them: a non-falling unmark (another line
 * still standing) cannot un-witness anything, and bumping on it suppressed a
 * legitimate First-to-BINGO whose witness read was still in flight (the round-4
 * finding). A blackout-only fall does not bump either — bumping there would
 * reintroduce the same bug shape (an unrelated blackout fall staling a valid
 * bingo ceremony); no consumer reads the generation for blackout. Two callers,
 * both observers of reality: Board.doMark's unmark path (the local verdict) and
 * Board's cells effect on a PASSIVE falling-edge snapshot (bingo/blackout
 * true→false in listener data — a cross-tab unmark or a rules rollback that
 * produces no local verdict; PR #110 finding 3). Distinct from
 * `clearPendingMoment` (a drain FIRE-clear, or a decided-and-lost ceremony),
 * which never bumps: a fire means the win stood and was published.
 */
export function dropPendingWins(
  uid: string,
  // `blackoutDayIndex` (#267, Codex P2 on #275 round 2) and `bingoDayIndex`
  // (#372, the same treatment now that bingo is per-card): a fall is witnessed by
  // ONE board — the fallen one — so a day-scoped caller drops just that Day from
  // the queue, leaving sibling Days' still-valid pending wins intact. A legacy
  // (day-less) fall keeps the full clear.
  fell: { bingo?: boolean; blackout?: boolean; bingoDayIndex?: number; blackoutDayIndex?: number },
): void {
  const key = pendingKey(uid);
  restorePending(uid);
  if (fell.bingo) {
    pendingGenerations.set(key, (pendingGenerations.get(key) ?? 0) + 1);
  }
  const flags = pendingMoments.get(key);
  if (!flags) return;
  if (fell.bingo) {
    const days = flags.bingoDayIndexes;
    if (fell.bingoDayIndex !== undefined && days && days.length > 0) {
      // Day-scoped fall (#372): only the witnessed board's Day drops; the flag
      // stays owed while sibling Days remain queued. Without this, a Day-1
      // unmark would wipe a still-standing Day-2 bingo out of the queue — a bug
      // that could not exist before per-card bingo, because the once-per-Player
      // id meant only one Day could ever be queued at all.
      flags.bingoDayIndexes = days.filter((d) => d !== fell.bingoDayIndex);
      if (flags.bingoDayIndexes.length === 0) {
        flags.bingoDayIndexes = undefined;
        flags.bingo = false;
      }
    } else {
      flags.bingo = false;
      flags.bingoDayIndexes = undefined; // the fallen bingo's Day no longer applies
    }
    // The CEREMONIAL candidate stays event-wide and singular, so ANY observed
    // bingo fall still drops it outright — deliberately NOT day-scoped like the
    // plain bingo above. The generation bump (above) is likewise unconditional,
    // and `firstBingoCandidateCurrent` reads it at drain, so day-scoping only
    // this drop would be inert anyway. Consequence (accepted, and strictly
    // fail-safe): a Day-1 unmark can kill a Day-2 ceremonial candidate. It can
    // only ever LOSE a ceremony, never publish a wrong one — the same
    // conservative posture PR #110 round 4 settled on for the singleton.
    flags.firstBingo = false;
    flags.firstBingoDayIndex = undefined;
  }
  if (fell.blackout) {
    const days = flags.blackoutDayIndexes;
    if (fell.blackoutDayIndex !== undefined && days && days.length > 0) {
      // Day-scoped fall: only the witnessed board's Day drops; the flag stays
      // owed while sibling Days remain queued.
      flags.blackoutDayIndexes = days.filter((d) => d !== fell.blackoutDayIndex);
      if (flags.blackoutDayIndexes.length === 0) {
        flags.blackoutDayIndexes = undefined;
        flags.blackout = false;
      }
    } else {
      flags.blackout = false;
      flags.blackoutDayIndexes = undefined; // the fallen blackout's Day no longer applies
    }
  }
  if (!flags.bingo && !flags.blackout && !flags.firstBingo) pendingMoments.delete(key);
  persistPending(uid);
}

// --- Retraction of a PUBLISHED win (#377) ------------------------------------
//
// `dropPendingWins` above covers only the PRE-publish case: a win completed then
// unmarked before its gate opens never posts. After publish there was no path at
// all — the Feed went on claiming a bingo the card no longer supported, forever.
// (`moments/{momentId}` has no update path, and although the rules already let an
// owner delete their own Moment, nothing in the client ever called it.)
//
// Retraction is DELETE + TOMBSTONE, in one atomic batch, never a bare delete. The
// deterministic per-card id is the strongest anti-gaming primitive in the system:
// `${uid}-bingo-d${dayIndex}` posts exactly once per (Player, Day), create-only
// and immutable. A bare delete breaks that bound — retract-then-re-mark recreates
// the same id with a fresh `createdAt`, and the Feed sorts by `createdAt` desc, so
// mark/unmark/re-mark would bounce one win back to the TOP of the Feed
// repeatedly: an engagement-farming loop introduced by the very feature meant to
// keep the Feed honest. The tombstone spends the (Player, Day) win instead —
// retracted once, never repostable (firestore.rules § momentRetractions).
//
// **Accepted cost, decided in #377:** a genuine mis-unclick (unmark by accident,
// then re-mark) loses that Day's Moment permanently. It fails in the safe
// direction — silence, never a false claim — and an admin can delete the tombstone
// for a real correction.
//
// **Scope, stated plainly:** retraction does nothing against deliberate gaming — a
// player claiming squares they did not earn simply does not unclick. Its value is
// Feed TRUTH for honest self-correction, and it must not cost the once-per-card
// bound to get it.
//
// **Why it is a two-step INTENT → DRAIN, not a write at the fall (Codex P1, round 1
// on PR #467).** A retraction is IRREVERSIBLE, and the fall observers only ever see
// LOCAL evidence: `setMark` is fire-and-forget (ADR 0006), returning a locally
// folded verdict while its batch is still pending, and the passive falling edge can
// arrive as a latency-compensated cache snapshot. If that unmark is then REJECTED —
// a pre-#458 cells-array straggler whose per-cell patch the canonical-map gate
// denies, a Day-unlock or seed guard — Firestore rolls the board back to its
// still-winning state, but a retraction batch fired at fall time is already
// authorized and would irreversibly silence a STANDING win.
//
// So an observed fall only records an INTENT (`enqueueRetraction`). The write
// happens in `drainRetractions`, which Board calls ONLY from a fully
// SERVER-COMMITTED board snapshot (`!fromCache && !hasPendingWrites`): if the win
// no longer stands there, the server agrees it fell and the retraction commits; if
// it DOES stand (the rollback, or a regain), the intent is dropped and nothing is
// spent. Offline there is no server-committed snapshot, so the intent simply waits
// — the correct posture for a permanent action taken on unverified state.
//
// The intent map is MODULE scope, uid-keyed like the pending-Moment queue above, so
// it survives Board unmounts and route changes. Deliberately memory-only (no
// localStorage, unlike the pending queue): an intent lost to a full page reload
// leaves the Moment standing until the next observed fall — the same bounded,
// silence-not-falsehood residual the pending queue already documents, and the safe
// direction for an irreversible write.

// Queued retraction intents, keyed by uid → a set of `${kind}:${day}` tokens
// (`legacy` for the day-less form). A Set because a Player can hold intents for
// several Days and both kinds at once, exactly like the per-Day pending queues.
const pendingRetractions = new Map<string, Set<string>>();

const DAY_LESS = 'legacy';
const retractionToken = (kind: RetractableKind, dayIndex?: number): string =>
  `${kind}:${dayIndex ?? DAY_LESS}`;
const requeueRetraction = (uid: string, kind: RetractableKind, dayIndex?: number): void => {
  if (kind === 'bingo') enqueueRetraction(uid, { bingo: true, bingoDayIndex: dayIndex });
  else enqueueRetraction(uid, { blackout: true, blackoutDayIndex: dayIndex });
};

/**
 * Record that an observed fall INVALIDATED a (possibly published) win — the
 * published-side twin of `dropPendingWins`, called with the SAME `fell` verdict at
 * the SAME two fall-observer sites (Board's unmark verdict and its passive falling
 * edge), so the pre- and post-publish halves of one fall can never drift apart.
 *
 * Enqueuing writes NOTHING and is freely reversible — that is the point. The
 * irreversible half waits for `drainRetractions` and server-committed evidence.
 */
export function enqueueRetraction(
  uid: string,
  fell: { bingo?: boolean; blackout?: boolean; bingoDayIndex?: number; blackoutDayIndex?: number },
): void {
  if (!fell.bingo && !fell.blackout) return;
  const key = pendingKey(uid);
  let intents = pendingRetractions.get(key);
  if (!intents) {
    intents = new Set();
    pendingRetractions.set(key, intents);
  }
  if (fell.bingo) intents.add(retractionToken('bingo', fell.bingoDayIndex));
  if (fell.blackout) intents.add(retractionToken('blackout', fell.blackoutDayIndex));
}

/** The queued retraction intents for `uid`, as raw `${kind}:${day}` tokens.
 *  Exported for tests and for Board's own assertions; app code drains. */
export function peekRetractions(uid: string): string[] {
  return [...(pendingRetractions.get(pendingKey(uid)) ?? [])];
}

/**
 * Adjudicate the queued intents for ONE board against SERVER-COMMITTED truth.
 * Board calls this only from a snapshot that is neither `fromCache` nor
 * `hasPendingWrites` — i.e. the server's own view of the card.
 *
 * Per kind, for the intent whose Day IS this board's:
 *   - the win still STANDS → the fall did not survive the server (a rejected
 *     unmark rolled back, or the Player re-marked). Drop the intent; write nothing.
 *   - the win does NOT stand → the server agrees. Commit the retraction.
 *
 * An intent for ANOTHER Day is untouched: this board is not evidence about that
 * card, and it drains when its own board next arrives server-committed.
 */
export function drainRetractions(
  uid: string,
  board: { dayIndex?: number; bingoStands: boolean; blackoutStands: boolean },
): void {
  const key = pendingKey(uid);
  const intents = pendingRetractions.get(key);
  if (!intents) return;
  const consider = (kind: RetractableKind, stands: boolean) => {
    const token = retractionToken(kind, board.dayIndex);
    if (!intents.has(token)) return;
    intents.delete(token);
    if (stands) return; // the server says the win is fine — spend nothing
    void retractWin(uid, kind, board.dayIndex).then((consumed) => {
      if (!consumed) requeueRetraction(uid, kind, board.dayIndex);
    });
  };
  consider('bingo', board.bingoStands);
  consider('blackout', board.blackoutStands);
  if (intents.size === 0) pendingRetractions.delete(key);
}

/** Drop every queued retraction intent. Exported for test isolation only (module
 *  state persists across unmounts by design); not used by app code. */
export function resetRetractions(): void {
  pendingRetractions.clear();
}

/** The tombstone/Moment id for a (Player, kind, Day) win — the writer's own
 *  deterministic scheme (`broadcastBingo` / `broadcastBlackout`). */
const winMomentId = (uid: string, kind: RetractableKind, dayIndex?: number): string =>
  dayIndex === undefined ? `${uid}-${kind}` : `${uid}-${kind}-d${dayIndex}`;

type MomentProbe =
  | { status: 'exists'; data: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'unknown' };

/** Probe a candidate Moment through the server-only read path. A miss is
 *  authoritative enough to consume the intent without minting a tombstone; a read
 *  failure is not, so the caller keeps the intent for a later drain. */
async function serverMomentData(id: string): Promise<MomentProbe> {
  try {
    const snap = await getDocFromServer(rawMoment(id));
    return snap.exists()
      ? { status: 'exists', data: (snap.data() as Record<string, unknown>) ?? {} }
      : { status: 'missing' };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Does a tombstone already exist at `id`? Server-first through the normal
 * `getDoc` path — retraction only ever commits right after a server-committed
 * board snapshot (`drainRetractions`), so the device is online and the answer is
 * authoritative; offline `getDoc` falls back to the cache. Needed since the
 * sibling-form spend (Codex round 2 on PR #467): a retraction writes BOTH
 * tombstone forms, tombstones are permanent with NO update path, so blindly
 * re-setting one minted by an EARLIER retraction (same kind, another Day) would
 * be a doc-exists update and deny the whole batch. An unreadable doc reads as
 * missing and the set is included best-effort — at worst the batch is denied and
 * logged, never a silent half-retraction (the batch is all-or-nothing).
 */
async function tombstoneExists(id: string): Promise<boolean> {
  try {
    return (await getDoc(rawMomentRetraction(id))).exists();
  } catch {
    return false;
  }
}

/**
 * Delete the fallen win's Moment doc(s) and mint its tombstones ATOMICALLY. A
 * batch, not separate writes: a crash (or a rules denial) between them would
 * otherwise leave the win deleted-but-not-spent — i.e. freely repostable, the
 * exact loop this closes — or spent-but-still-displayed. `writeBatch` commits
 * all-or-nothing.
 *
 * The batch spends BOTH id forms of the win (Codex round 2 on PR #467): the same
 * (Player, Day) win is addressable as `${uid}-${kind}-d${dayIndex}` by a current
 * bundle AND as legacy `${uid}-${kind}` by a stale (or same-day-deduping) one, so
 * a tombstone at only the form that happened to hold the Moment left the other
 * freely creatable — retract the legacy Moment, re-mark, and the current bundle
 * reposts the SAME win under the day-scoped id. The owner-delete rule enforces
 * the pairing server-side (getAfter on the sibling form), so this is the only
 * shape the rules accept; a form's set is skipped when its tombstone already
 * exists (getAfter accepts a pre-existing sibling). A day-less caller (legacy
 * single-board Event) has no sibling form — one tombstone, no `dayIndex`.
 *
 * Fire-and-forget and offline-queueable like every other write in this module
 * (ADR 0006): the batch pends durably in the persistent cache when offline and
 * drains on reconnect, and an ONLINE rejection is logged rather than surfaced.
 */
async function commitRetraction(
  uid: string,
  kind: RetractableKind,
  momentIds: string[],
  dayIndex?: number,
): Promise<boolean> {
  const tombstone: RetractionTombstone = {
    uid,
    kind,
    createdAt: Date.now(),
    // Only when the Day is known — never an explicit `undefined`, which
    // Firestore rejects outright.
    ...(dayIndex !== undefined ? { dayIndex } : {}),
  };
  const tombstoneIds = [winMomentId(uid, kind)];
  if (dayIndex !== undefined) tombstoneIds.push(winMomentId(uid, kind, dayIndex));
  const batch = writeBatch(db);
  for (const momentId of momentIds) batch.delete(rawMoment(momentId));
  for (const id of tombstoneIds) {
    if (!(await tombstoneExists(id))) batch.set(rawMomentRetraction(id), tombstone);
  }
  return batch.commit().then(
    () => true,
    (err: unknown) => {
      console.error('[moments] retraction rejected', { momentIds, kind, uid }, err);
      return false;
    },
  );
}

/**
 * Retract one kind's published Moment for one board — the irreversible half, only
 * ever reached from `drainRetractions` (i.e. with the server's own confirmation
 * that the win fell). Fire-and-forget: it must never block the UI.
 *
 * Nothing is retracted unless a Moment for that (Player, Day) is ACTUALLY found
 * by a server-first probe. That check is load-bearing, not an optimization: minting a
 * tombstone for a win that never published would SPEND the (Player, Day) slot
 * without a Moment ever having existed — permanently silencing a legitimate
 * future win. A read failure is not evidence of absence, so the intent is
 * requeued and retried on a later server-committed board snapshot.
 *
 * BOTH id forms are probed, because both can legitimately hold the live Moment for
 * a given (Player, Day):
 *
 *   - the PER-CARD id (`${uid}-${kind}-d${dayIndex}`) — what a current client
 *     writes on a daily Event (bingo since #372, blackout since #267);
 *   - the LEGACY day-less id (`${uid}-${kind}`) — what pre-#267/#372 clients
 *     wrote, and what a current client still writes on a legacy single-board
 *     Event. On a DAILY Event it is retracted only when its payload's `dayIndex`
 *     names the fallen Day: the writers' legacy same-day dedupe means a Day's live
 *     Moment can genuinely live at that day-less id, but a legacy doc stamped for
 *     a DIFFERENT Day describes a different card and must survive this fall.
 *
 * A day-less caller (a legacy Event has one card for the whole Event, so per-Player
 * IS per-card there) retracts the day-less id unconditionally and probes no
 * day-scoped form — there is no Day to scope to.
 *
 * The Moment probes decide only which Moment DOCS the batch deletes. The
 * tombstones are NOT conditioned on which form held the Moment: whenever the Day
 * is known the batch spends BOTH forms (Codex round 2 on PR #467; enforced by the
 * owner-delete rule) — see commitRetraction.
 */
async function retractWin(uid: string, kind: RetractableKind, dayIndex?: number): Promise<boolean> {
  const momentIds: string[] = [];
  let hasUnknownProbe = false;
  if (dayIndex !== undefined) {
    const perCardId = winMomentId(uid, kind, dayIndex);
    const perCard = await serverMomentData(perCardId);
    if (perCard.status === 'exists') momentIds.push(perCardId);
    if (perCard.status === 'unknown') hasUnknownProbe = true;
  }
  const legacyId = winMomentId(uid, kind);
  const legacyProbe = await serverMomentData(legacyId);
  if (legacyProbe.status === 'unknown') hasUnknownProbe = true;
  const legacy = legacyProbe.status === 'exists' ? legacyProbe.data : undefined;
  // On a daily Event the legacy doc must NAME this Day to be the one that fell.
  // A doc with NO `dayIndex` at all (a true pre-#262 Moment) therefore never
  // matches and always survives — deliberately conservative: nothing on the doc
  // says which card it describes, and a wrong retraction is permanent.
  if (legacy && (dayIndex === undefined || legacy.dayIndex === dayIndex)) momentIds.push(legacyId);
  if (momentIds.length === 0) return !hasUnknownProbe;
  // ONE batch for however many docs hold this win, spending BOTH id forms when
  // the Day is known — see commitRetraction for why the sibling form must be
  // spent even when no Moment sits at it.
  return commitRetraction(uid, kind, momentIds, dayIndex);
}

/**
 * Clear one DRAINED kind so a later drain cannot re-fire it: the drain either
 * published the Moment (the win stood at fire time) or decided-and-lost the
 * ceremony against a confirmed roster. Not for falls — a win that no longer
 * stands is dropped via `dropPendingWins`, which also bumps the action
 * generation. The map entry is deleted once empty to keep it from growing per uid.
 */
export function clearPendingMoment(uid: string, kind: keyof PendingMomentFlags): void {
  const key = pendingKey(uid);
  const flags = readPending(uid);
  if (!flags) return;
  flags[kind] = false;
  if (kind === 'blackout') flags.blackoutDayIndexes = undefined; // fired — nothing left to protect
  // Each kind clears ITS OWN Day (#286 round 2, Codex P3): the ceremonial
  // candidate carries `firstBingoDayIndex` stamped at ITS enqueue, so the plain
  // bingo's fire-clear can never strip the ceremony's Day chip — including the
  // async-witness window where the candidate is enqueued only after the plain
  // bingo already fired and deleted the entry.
  if (kind === 'bingo') flags.bingoDayIndexes = undefined; // fired — nothing left to protect
  if (kind === 'firstBingo') flags.firstBingoDayIndex = undefined;
  if (!flags.bingo && !flags.blackout && !flags.firstBingo) pendingMoments.delete(key);
  persistPending(uid);
}

/**
 * Drop the ENTIRE pending queue and its action generations. Exported for test
 * isolation only: both maps are module state that (by design) persist across
 * component unmounts, so a suite that exercises the hold→drain path must reset
 * them between cases. Not used by app code. (A continuation captured before a
 * reset sees generation 0 again, but its flag recheck fails against the cleared
 * flags — the dual check covers the wraparound.)
 */
export function resetPendingMoments(): void {
  pendingMoments.clear();
  pendingGenerations.clear();
  selfBingoWriteGenerations.clear();
  hydratedPending.clear();
  const store = pendingStore();
  if (store) {
    for (const key of pendingStorageKeys) {
      try {
        store.removeItem(key);
      } catch {
        // Test/reset support must not fail when storage is unavailable.
      }
    }
  }
  pendingStorageKeys.clear();
}

/** Test-only: model a page reload while keeping durable pending entries. */
export function __resetPendingMomentsMemoryForTests(): void {
  pendingMoments.clear();
  pendingGenerations.clear();
  selfBingoWriteGenerations.clear();
  hydratedPending.clear();
}

/**
 * Write one Moment, fire-and-forget and offline-queueable (ADR 0002 + ADR 0006).
 *
 * `id` is deterministic so the dedup is STRUCTURAL, not a race we hope to win:
 * the moments rules block allows `create` (own-uid, valid kind/displayName/
 * createdAt) but DENIES `update` entirely (a Moment is immutable; moderation is
 * delete-only, with a status field deferred to #37/#41), so re-broadcasting an
 * already written id lands on the `update` rule and is denied — for admins exactly
 * like everyone else, so a second first-BINGO for the same Player, or a duplicate
 * First-to-BINGO, can never post. The Board edge
 * refs (`wasBingo`/`wasBlackout`) are the first line (no re-fire within a session
 * or across a reload); the write-once cache pre-check (`writeMomentOnce`, round 3
 * finding C) skips a duplicate whose Moment is already in the local cache before
 * it can optimistically overwrite it; the create-only id is the structural
 * backstop for whatever remains (fresh devices, multiple tabs, the
 * First-to-BINGO race).
 *
 * The payload is EXACTLY `Omit<MomentDoc, 'id'>` (the id is the doc id): no media
 * and no `proofId` ever reach a Moment. `displayName` is bounded through the
 * shared `markerDisplayName` helper to the rules' non-empty ≤100-char contract so
 * a broadcast can never be rejected for a malformed name (the auth-fallback name
 * `resolveDisplayName` yields is not itself length-capped). `dayIndex` is
 * optional and, when supplied, is stamped onto the payload — the per-card
 * Blackout is the one caller that passes it today (daily-cards-spec § "Scoring
 * and social surfaces": "a per-card blackout posts a Moment naming the day",
 * e.g. "blacked out Day 4 · Glamiators"), so the Feed can render the Day chip.
 */
function broadcast(id: string, kind: MomentKind, who: MomentActor, dayIndex?: number): void {
  void writeMomentOnce(id, kind, who, dayIndex);
}

/**
 * The write-once step behind every broadcast (round 3 finding C, PR #99). The
 * create-only rules DENY a duplicate deterministic-id write server-side — but
 * Firestore applies latency compensation FIRST: the duplicate setDoc briefly
 * overwrites the LOCAL cache copy, and its refreshed `createdAt` pins the old
 * Moment to the top of the Feed until the server's denial rolls it back —
 * indefinitely while offline, where no denial ever arrives. So, extending the
 * round-2 witness pattern to ALL broadcasts: check the local cache for the
 * deterministic id first, and if the Moment already exists there, SKIP the write
 * entirely. That is the designed once-only path doing its job, not an error —
 * logged at debug level (the rules-denial path below keeps its error log). On a
 * cache miss (fresh device / cold cache) the write proceeds: a duplicate from a
 * cold cache still resolves server-side via the create-only rule, and the
 * visible-flash window only exists when the doc IS cached — exactly the case
 * this pre-check catches. `dayIndex` (optional) is threaded straight through to
 * the payload builder, which omits the field entirely rather than writing an
 * explicit `undefined` — Firestore's `setDoc` rejects that outright.
 */
async function writeMomentOnce(
  id: string,
  kind: MomentKind,
  who: MomentActor,
  dayIndex?: number,
): Promise<void> {
  const ref = rawMoment(id);
  try {
    const cached = await getDocFromCache(ref);
    if (cached.exists()) {
      console.debug('[moments] broadcast skipped — Moment already in local cache', {
        id,
        kind,
        uid: who.uid,
      });
      return;
    }
  } catch {
    // Not in the local cache — no duplicate to protect; proceed with the write.
  }
  // RETRACT-ONCE pre-check (#377), the exact twin of the write-once one above and
  // for the same latency-compensation reason. The rules DENY a create whose
  // tombstone exists, but Firestore applies the optimistic write LOCALLY first: a
  // re-marked, already-retracted win would flash back to the TOP of the Feed until
  // the server's denial rolled it back — and indefinitely while OFFLINE, where no
  // denial ever arrives. That flash is precisely the engagement-farming loop the
  // tombstone exists to close, so the retraction must be honored client-side too.
  //
  // Cache-only and best-effort, matching every other pre-check here: the tombstone
  // is in the local cache on the device that WROTE it (latency compensation) —
  // which is the device a re-mark realistically comes from — and a cache miss just
  // falls through to the server, which denies. Never a gate on correctness, only
  // on the visible flash.
  //
  // A cached HIT is then RE-READ through the normal `getDoc` path before it may
  // suppress anything (Codex P2, round 1 on PR #467). Nothing subscribes to
  // `momentRetractions`, so a cache hit is never invalidated on its own: when an
  // ADMIN deletes a tombstone to correct an accidental retraction, the device that
  // wrote it would otherwise keep suppressing that win forever — across reloads
  // too, since the cache is persistent — silently contradicting the documented
  // admin escape hatch. The extra read is on the RARE path only (a re-mark of a
  // win this device retracted), and `getDoc` falls back to the cache offline, so
  // the offline flash suppression this pre-check exists for is untouched.
  try {
    if ((await getDocFromCache(rawMomentRetraction(id))).exists()) {
      const live = await getDoc(rawMomentRetraction(id));
      if (live.exists()) {
        console.debug('[moments] broadcast skipped — this win was retracted (#377)', {
          id,
          kind,
          uid: who.uid,
        });
        return;
      }
    }
  } catch {
    // No cached tombstone, or the confirmation read failed — nothing this device
    // knows to be spent; the server's create rule is the decider either way.
  }
  // #332: about to genuinely write this bingo doc (the pre-check above found no
  // cached doc, so this is NOT a regain re-broadcast). Stamp the current action
  // generation SYNCHRONOUSLY before setDoc can land in the local cache: any
  // in-flight `hasPriorBingoWitness` read that later finds this doc can then
  // recognize it as this win's own write rather than prior-win evidence.
  // Stamped against the DOC ID being written (#372), so the per-card ids each
  // carry their own stamp — see `selfBingoWriteGenerations`.
  if (kind === 'bingo') {
    selfBingoWriteGenerations.set(selfWriteKey(who.uid, id), pendingActionGeneration(who.uid));
  }
  const payload: Omit<MomentDoc, 'id'> = {
    kind,
    uid: who.uid,
    displayName: markerDisplayName(who.displayName, undefined),
    photoURL: who.photoURL,
    createdAt: Date.now(),
    // Included only when the caller supplied one — never an explicit `undefined`
    // (Firestore's setDoc rejects that field value outright).
    ...(dayIndex !== undefined ? { dayIndex } : {}),
  };
  await setDoc(ref, payload).catch((err: unknown) => {
    // Not the offline case: offline the write PENDS in the persistent cache and
    // drains on reconnect (ADR 0006). A rejection is either a genuine online
    // failure (permission/auth) OR the once-only backstop for a COLD-cache
    // duplicate — a re-broadcast of an already-claimed deterministic id hitting
    // the deny-all `update` rule. Either way it must not vanish silently; log
    // with context.
    console.error('[moments] broadcast rejected', { id, kind, uid: who.uid }, err);
  });
}

/**
 * Whether THIS device holds a durable witness that `uid` already won a BINGO in
 * this Event: the player's own immutable `${uid}-bingo` Moment doc, read from the
 * LOCAL persistent cache (ADR 0006). `firstBingoAt` on the player row is BY DESIGN
 * volatile (computeMark clears it when the last line falls), and the schema
 * deliberately has no durable first-win field — but the Moment collection is its
 * own memory: the bingo Moment is create-only and immutable, so its presence
 * proves a prior win even after the line was unmarked. Board consults this before
 * queueing a ceremonial First-to-BINGO candidate on a bingo edge (Codex P2, PR #99
 * round 2 finding D): a regained line must not mint the event singleton.
 *
 * Cache-only ON PURPOSE: `getDocFromCache` never touches the network, so the check
 * is instant and offline-safe, and a same-session broadcast is visible immediately
 * via latency compensation. It resolves `false` on a cache miss (fresh device /
 * cold cache — getDocFromCache rejects when the doc is not cached) and NEVER
 * rejects; the caller then falls back to the roster check, an accepted narrowed
 * residual documented in specs/w2-feed-moments.md.
 */
export async function hasPriorBingoWitness(
  uid: string,
  // Day-aware exclusion (Codex P1 on #288): the `${uid}-bingo` doc is
  // once-per-Player and a TUTORIAL Day's bingo writes it too — but the
  // cruise-wide First to BINGO is anchored to MAIN-GAME Days only (spec §
  // "Scoring and social surfaces"), so a warm-up win must not read as a
  // "prior win" that permanently disqualifies the player's first REAL bingo
  // from the ceremony. A witness whose payload Day is in `excludeDayIndexes`
  // resolves false. A day-LESS witness on a daily Event (pre-#286 data) stays
  // a witness — conservative: the roster gate (already main-game-aware via
  // the tutorial-excluded firstBingoAt fold) remains the fallback.
  //
  // `dayIndexes` (#372) is the Event's scheduled Day indexes. Per-card bingo
  // means there is no longer ONE `${uid}-bingo` doc to read: the witness lives
  // at whichever `${uid}-bingo-d${d}` the Player actually won. Given the
  // schedule, probe each non-excluded Day's own id. This makes the tutorial
  // exclusion EXACT rather than inferential — a warm-up win writes its own
  // day-scoped id, which simply is not probed. Omitted on a legacy (non-daily)
  // Event, which keeps the day-less path as the only witness.
  opts?: {
    excludeDayIndexes?: ReadonlySet<number>;
    dayIndexes?: readonly number[];
    // #332: the caller's captured action generation. When THIS device's own
    // plain-bingo write happened at that same (unchanged) generation, a found
    // bingo doc is this very win's drain landing mid-read — not prior-win
    // evidence — so the check falls through to the singleton consult exactly
    // like the tutorial branch. Callers that don't capture a generation (the
    // confirm pipeline) omit it and keep the pre-#332 read. Applies to the
    // per-card ids too (#372): the same race lands on `${uid}-bingo-d${day}`.
    selfWriteGeneration?: number;
    // The Day THIS action's bingo lands on (#372, Codex P2 on #386) — the ONLY
    // doc this action could have written, and therefore the only one
    // `selfWriteGeneration` may excuse. The generation alone is too coarse to
    // identify the doc: it bumps only on a bingo FALL, so a Day-3 win and a
    // later Day-5 win with no fall between them share a generation, and the
    // Day-3 doc — genuine prior-win evidence this device wrote earlier in the
    // session — would be waved through as "the Day-5 action's own write",
    // clearing the ceremony gate for a player who is not witness-clean. Omit on
    // a legacy (day-less) Event, where the single `${uid}-bingo` id is
    // unambiguous.
    selfWriteDayIndex?: number;
  },
): Promise<boolean> {
  // Shared singleton consult (cache-only, Codex P1 on #288 round 5): the
  // headline honor already claimed — by this player or anyone else — reads as
  // witnessed; an uncached/absent singleton reads witness-clean, leaving the
  // drain-time roster gate as the decider.
  const singletonWitness = async (): Promise<boolean> => {
    try {
      const singleton = await getDocFromCache(rawMoment(FIRST_BINGO_MOMENT_ID));
      return singleton.exists();
    } catch {
      return false; // singleton not cached — witness-clean, roster gate decides
    }
  };
  // The one doc THIS action could have written (#372, Codex P2 on #386): its own
  // Day's per-card id, or the day-less id on a legacy Event. Any OTHER bingo doc
  // is by definition not this action's write, however the generations line up.
  const selfWriteId =
    opts?.selfWriteDayIndex !== undefined ? `${uid}-bingo-d${opts.selfWriteDayIndex}` : `${uid}-bingo`;
  // Was this exact doc written by THIS device, for THIS action (#332, keyed per
  // doc id since #372)? Then it is this win's own drain, not prior evidence.
  // BOTH conditions are load-bearing: the id pins WHICH doc this action writes,
  // the generation pins WHEN — so a same-Day regain (whose fall bumped the
  // generation) still reads as the prior win it is.
  const isSelfWrite = (momentId: string): boolean =>
    opts?.selfWriteGeneration !== undefined &&
    momentId === selfWriteId &&
    selfBingoWriteGenerations.get(selfWriteKey(uid, momentId)) === opts.selfWriteGeneration;

  // Per-card witnesses (#372) — cache-only and bounded by the schedule (ten Days
  // on the seeded sailing), so this is ten local reads at worst, no network.
  let sawSelfWrite = false;
  for (const day of opts?.dayIndexes ?? []) {
    if (opts?.excludeDayIndexes?.has(day)) continue;
    const perCardId = `${uid}-bingo-d${day}`;
    try {
      const perCard = await getDocFromCache(rawMoment(perCardId));
      if (perCard.exists()) {
        // The #332 race, now on the day-scoped id: a concurrent drain can write
        // THIS win's own per-card bingo while this read is in flight. Skip it
        // rather than read it as a prior win; a sibling Day may still be real
        // evidence, so keep probing.
        if (isSelfWrite(perCardId)) {
          sawSelfWrite = true;
          continue;
        }
        return true;
      }
    } catch {
      // Not cached — no witness for this Day on this device; keep probing.
    }
  }
  // The LEGACY day-less witness (`${uid}-bingo`) still counts, and must: every
  // Player who bingoed before #372 shipped owns one, and it is durable proof of
  // a prior win. Its tutorial-exclusion and #332 logic are unchanged below.
  try {
    const snap = await getDocFromCache(rawMoment(`${uid}-bingo`));
    if (snap.exists()) {
      if (opts?.excludeDayIndexes) {
        const witnessedDay = (snap.data() as { dayIndex?: number } | undefined)?.dayIndex;
        if (typeof witnessedDay === 'number' && opts.excludeDayIndexes.has(witnessedDay)) {
          // A tutorial-Day win is not a prior MAIN-GAME win — but the shared
          // `${uid}-bingo` id means a later main-game win could never write its
          // own witness, so before treating the player as witness-clean consult
          // the first_bingo SINGLETON itself: if the headline honor is already
          // claimed — by this player (their earlier main-game ceremony; a
          // lost-and-regained line must stay suppressed) or by anyone else (a
          // candidate is pointless) — the ceremony gate reads as witnessed.
          // Absent → genuinely witness-clean.
          return singletonWitness();
        }
      }
      // #332 birth-time-witness race: a concurrent drain (typically gate-open)
      // can broadcast THIS win's own plain bingo while this read is in flight,
      // and the just-written doc must not read as a prior win and suppress the
      // ceremonial enqueue. `writeMomentOnce` stamps the generation only when it
      // genuinely writes (its cache pre-check found no existing doc), so a
      // regain — whose doc predates the action — never takes this branch: its
      // re-broadcast is skipped by the pre-check and leaves no stamp.
      if (isSelfWrite(`${uid}-bingo`)) {
        return singletonWitness();
      }
      return true;
    }
  } catch {
    // Not in the local cache — no day-less witness on this device.
  }
  // No evidence anywhere — but if the ONLY bingo doc found was this very win's
  // own write (#332 × #372), defer to the singleton exactly as the day-less
  // path does, rather than declaring witness-clean off our own drain.
  if (sawSelfWrite) return singletonWitness();
  return false;
}

/**
 * A Player's BINGO — PER CARD (#372), the exact twin of `broadcastBlackout`
 * since #267. Broadcast on the transition INTO having a bingo on a given Day's
 * board (`setMark`'s `bingoTransition` verdict), never on every completed line.
 *
 * `dayIndex` NAMES the Day the bingo happened on AND scopes the deterministic
 * dedup id to that Day (`${uid}-bingo-d${dayIndex}`): re-marking the SAME card
 * can never double-post, while a second Day's bingo posts its own Moment.
 *
 * The pre-#372 id was `${uid}-bingo` — once-per-Player for the whole cruise — so
 * only a Player's FIRST bingo ever reached the Feed: every later one re-targeted
 * that immutable doc, hit the deny-all `update` rule, and was swallowed as the
 * designed once-only path. Harmless while a Player had ONE board for the whole
 * Event (per-Player was per-card there), but daily cards (#246) gave each Day its
 * own board and its own bingo transition, so from then on the celebration fired
 * on every Day while the Feed silently received nothing — the #372 report.
 * Exactly the wall blackout hit, fixed the same way.
 *
 * A legacy single-Board caller omits `dayIndex` and keeps the once-per-Player id
 * (a legacy Event has one card the whole Event, so per-Player IS per-card).
 * Board's live-mark path captures the Day at ENQUEUE time via `enqueueWinMoments`
 * and threads it through `pendingBingoDayIndexes` to the drain — never re-derived
 * from whatever Day is on screen when a held bingo finally fires.
 */
export function broadcastBingo(who: MomentActor, dayIndex?: number): void {
  if (dayIndex === undefined) {
    broadcast(`${who.uid}-bingo`, 'bingo', who);
    return;
  }
  // Legacy same-day dedupe, mirroring broadcastBlackout's (Codex P2 on #275
  // round 2): a card that already posted under the pre-#372 day-less id (a
  // day-stamped payload at `${uid}-bingo`, the #262-era shape) must not post a
  // SECOND, day-stamped Moment for the SAME Day. This is the live-data case, not
  // a hypothetical: every Player who has bingoed before this ships already owns
  // a `${uid}-bingo` doc. Same cache-only posture as writeMomentOnce — the check
  // protects the visible-flash window (the doc IS cached on the device that
  // posted it); a cold cache proceeds and the residual duplicate is a distinct
  // id the create rule cannot dedup across (accepted, matching the existing
  // broadcast dedup model).
  void (async () => {
    try {
      const legacy = await getDocFromCache(rawMoment(`${who.uid}-bingo`));
      if (legacy.exists() && (legacy.data() as { dayIndex?: number }).dayIndex === dayIndex) {
        console.debug('[moments] per-card bingo skipped — legacy day-less Moment already covers this Day', {
          uid: who.uid,
          dayIndex,
        });
        return;
      }
    } catch {
      // No legacy Moment in the local cache — nothing to dedupe against.
    }
    await writeMomentOnce(`${who.uid}-bingo-d${dayIndex}`, 'bingo', who, dayIndex);
  })();
}

/**
 * A Player's Blackout — PER CARD (#267, daily-cards-spec § "Scoring and
 * social surfaces": "Blackout remains per-card; a per-card blackout posts a
 * Moment naming the day"). `dayIndex` NAMES the Day the blackout happened on
 * ("blacked out Day 4 · Glamiators") AND scopes the deterministic dedup id to
 * that Day (`${uid}-blackout-d${dayIndex}`): re-marking the SAME card can
 * never double-post, while a second Day's blackout posts its own Moment — the
 * pre-#267 `${uid}-blackout` id was once-per-Player, so only the first card's
 * blackout ever reached the Feed. A legacy single-Board caller omits
 * `dayIndex` and keeps the legacy once-per-Player id (a legacy Event has one
 * card the whole Event, so per-Player IS per-card there). Board's live-mark
 * path captures the Day at ENQUEUE time via `enqueueWinMoments` and threads
 * it through `pendingBlackoutDayIndexes` to the drain — NOT re-derived from
 * whatever Day happens to be on screen when a held blackout finally fires
 * (Codex finding 2, fix/d15-blackout-day-naming).
 */
export function broadcastBlackout(who: MomentActor, dayIndex?: number): void {
  if (dayIndex === undefined) {
    broadcast(`${who.uid}-blackout`, 'blackout', who);
    return;
  }
  // Legacy same-day dedupe (Codex P2 on #275 round 2): a card that already
  // posted under the pre-#267 day-less id (a day-stamped payload at
  // `${uid}-blackout`, the #250-era shape) must not post a SECOND, day-stamped
  // Moment for the SAME card. Same cache-only posture as writeMomentOnce: the
  // check protects the visible-flash window (the doc IS cached on the device
  // that posted it); a cold cache proceeds and the residual duplicate is a
  // distinct id the create rule cannot dedup across — accepted, matching the
  // existing broadcast dedup model.
  void (async () => {
    try {
      const legacy = await getDocFromCache(rawMoment(`${who.uid}-blackout`));
      if (legacy.exists() && (legacy.data() as { dayIndex?: number }).dayIndex === dayIndex) {
        console.debug('[moments] per-card blackout skipped — legacy day-less Moment already covers this Day', {
          uid: who.uid,
          dayIndex,
        });
        return;
      }
    } catch {
      // No legacy Moment in the local cache — nothing to dedupe against.
    }
    await writeMomentOnce(`${who.uid}-blackout-d${dayIndex}`, 'blackout', who, dayIndex);
  })();
}

/**
 * The Event's First to BINGO (once per Event). Ceremonial and self-reported (ADR
 * 0001): Board only calls this when, as far as the caller's known-players view
 * shows, no other Player has bingoed yet. The event-singleton id (above) makes it
 * structurally once-per-Event even under the honest race.
 */
export function broadcastFirstBingo(who: MomentActor, dayIndex?: number): void {
  // Payload-only `dayIndex` (#262), same as broadcastBingo — the singleton id
  // is untouched.
  broadcast(FIRST_BINGO_MOMENT_ID, 'first_bingo', who, dayIndex);
}

/**
 * The broadcast decision for a CONFIRM-PATH win (issue #41, the deferred #99
 * finding 6). In `admin_confirmed` mode a Mark starts pending and only becomes a
 * win when an Admin resolves the Claim — and that confirm can land while the
 * winning Player is off the Card route (Board unmounted) or offline, so Board's
 * live edge detection never fires. `ConfirmWinMoments` (an always-mounted,
 * route-independent listener) watches the Player's OWN confirmed Claims and, when
 * the confirm's board write reflects a standing win, emits the SAME Moment the
 * live edge would have — attributed to the WINNER (the claim owner), never the
 * confirming Admin. This pure function is that emit decision, factored out so the
 * invariant is directly unit-testable.
 *
 * TRANSITION-GATED, exactly like the live mark path (Codex #116 finding 1): the
 * live path broadcasts off a mark's `bingoTransition` / `blackoutTransition`
 * (no-win → win), NOT off `hasBingo` on the current board. The confirm path must
 * match, or a player who ALREADY holds a standing BINGO and has a DIFFERENT pending
 * Claim confirmed (one that completes no NEW line) would wrongly re-post a BINGO.
 * So we recompute the win against the board with the JUST-CONFIRMED cells forced
 * back to their pre-confirm PENDING state (`confirmedIndexes`) and emit only what
 * CROSSES the threshold: no bingo before → bingo after (same for blackout). A
 * confirmed square that completes no line emits nothing.
 *
 * The rest MIRRORS Board's drain fire-time gates so both paths agree:
 *   - a board must actually stand (`cells.length > 0`): `isBlackout([])` is
 *     vacuously true, so an empty/non-attributable board emits nothing (the same
 *     round-3-finding-B length gate Board applies);
 *   - `firstBingo` is the ceremonial event singleton — raised only on a bingo
 *     TRANSITION, claimed ONLY against a SERVER-CONFIRMED roster showing no OTHER
 *     Player already has a `firstBingoAt` (PR #99 finding 2), and SUPPRESSED when
 *     the durable prior-win witness exists (`hasPriorBingoWitness`, finding D) so a
 *     regained line never re-mints it;
 *   - while the roster is unconfirmed a crossed first-win is HELD, not guessed
 *     (`firstBingoHeld`): the caller keeps the candidate and re-decides once the
 *     roster confirms, exactly as Board holds the candidate.
 *
 * Exactly-once across the two emit paths is STRUCTURAL, not timing: the writers'
 * deterministic doc ids (`${uid}-bingo` / `${uid}-blackout` / the `first_bingo`
 * singleton) are create-only and a Moment is fully immutable, so if the live edge
 * already posted a win this confirm-path emit is a denied/skipped no-op — never a
 * duplicate, and NEVER a false singleton (the roster gate is the same on both
 * paths). This preserves #110's suppressed-or-correct guarantee.
 */
export interface ConfirmBroadcastPlan {
  bingo: boolean;
  blackout: boolean;
  firstBingo: boolean;
  // The ceremonial first-win CROSSED but the roster is not yet server-confirmed:
  // HOLD (do not fire, do not drop) and re-decide when the roster confirms.
  firstBingoHeld: boolean;
}

export function planConfirmBroadcasts(params: {
  cells: Cell[];
  // The cell indices whose pending→confirmed flip this emit adjudicates. The win
  // is measured as the CROSSING these flips caused: the "before" board treats them
  // as still pending, the "after" board is `cells` as it stands now.
  confirmedIndexes: number[];
  uid: string;
  roster: { uid: string; firstBingoAt: number | null }[];
  rosterConfirmed: boolean;
  hasPriorBingo: boolean;
}): ConfirmBroadcastPlan {
  const { cells, confirmedIndexes, uid, roster, rosterConfirmed, hasPriorBingo } = params;
  const none = { bingo: false, blackout: false, firstBingo: false, firstBingoHeld: false };
  if (cells.length === 0 || confirmedIndexes.length === 0) return none;

  // "before" = the just-confirmed cells forced back to pending (their pre-confirm
  // state: still `marked`, but excluded from the win mask). The transition is the
  // difference THIS confirm made — never a win that already stood.
  const flipped = new Set(confirmedIndexes);
  const before = cells.map((c) => (flipped.has(c.index) ? { ...c, status: 'pending' as const } : c));
  const bingoTransition = !hasBingo(before) && hasBingo(cells);
  const blackoutTransition = !isBlackout(before) && isBlackout(cells);

  // The ceremonial First-to-BINGO is a candidate only when this confirm CROSSED
  // into a bingo the Player has no durable prior-win witness for. Then the roster
  // decides: unconfirmed → HELD; confirmed → claim iff no other Player bingoed first.
  const firstCandidate = bingoTransition && !hasPriorBingo;
  const othersBingoed = roster.some((p) => p.uid !== uid && p.firstBingoAt != null);
  const firstBingo = firstCandidate && rosterConfirmed && !othersBingoed;
  const firstBingoHeld = firstCandidate && !rosterConfirmed;

  return { bingo: bingoTransition, blackout: blackoutTransition, firstBingo, firstBingoHeld };
}

// --- Confirm-path listener state (issue #41), uid-keyed like the pending queue --
//
// The `ConfirmWinMoments` listener holds per-Player working state: which Claims it
// has observed PENDING (the fresh-confirm witness — a confirm counts as fresh only
// if this listener saw the Claim pending while mounted, so a Claim already
// confirmed at first sight is baselined as history), which confirmed Claims it has
// already enqueued, the confirms whose board flip has not yet landed, and a
// first_bingo candidate parked at the roster gate. Codex #116 finding 4: this state
// is lifted to MODULE scope keyed by uid (mirroring the pending-Moment queue above)
// so an ACCOUNT SWITCH parks the work instead of discarding it — switching back
// resumes a held win (including a roster-held first_bingo) for the original uid
// rather than baselining the now-confirmed Claim away. Same reload residual as the
// pending queue: module state is per-page-load.
export interface ConfirmListenerState {
  // Claim ids this listener has observed in the PENDING state — the witness that a
  // later `confirmed` is a fresh transition, not history (Codex #116 finding 3).
  seenPending: Set<string>;
  // Confirmed Claim ids already enqueued for emit, so a repeat snapshot never
  // re-enqueues one.
  handled: Set<string>;
  // Enqueued confirms whose board flip has not yet been adjudicated: claimId → the
  // Claim's cellIndex + proofId + its Day (#274 — a daily Claim adjudicates
  // against ITS day-scoped board; `null` = a legacy single-board Claim). The
  // proofId makes board reflection claim-SPECIFIC (Codex #116 R4 finding 2):
  // `confirmClaim` resolves the cell by proofId, so a DIFFERENT claim's
  // confirm at the same index must not count as this one's.
  awaiting: Map<
    string,
    { cellIndex: number; proofId: string | null; dayIndex: number | null; createdAt: number }
  >;
  // A first_bingo candidate parked at the roster gate, with its winner actor
  // captured; its prior-win eligibility was fixed at detection (never re-read).
  // `heldCeremonyDay` (#274) is the Day the held win stood on — the fall-clear
  // re-check reads THAT board, and the eventual publish names it.
  heldCeremony: MomentActor | null;
  heldCeremonyDay?: number | null;
  // A witness read is in flight — serializes the async decision and drives the
  // drain-until-empty loop (Codex #116 finding 2).
  inFlight: boolean;
}

const confirmStates = new Map<string, ConfirmListenerState>();

/** The per-uid confirm-listener state (created empty on first access), keyed the
 *  SAME way as the pending-Moment queue so the two never cross identities. */
export function getConfirmState(uid: string): ConfirmListenerState {
  const key = pendingKey(uid);
  let state = confirmStates.get(key);
  if (!state) {
    state = { seenPending: new Set(), handled: new Set(), awaiting: new Map(), heldCeremony: null, inFlight: false };
    confirmStates.set(key, state);
  }
  return state;
}

/** Drop all confirm-listener state. Exported for test isolation only (module state
 *  persists across unmounts by design); not used by app code. */
export function resetConfirmStates(): void {
  confirmStates.clear();
}
