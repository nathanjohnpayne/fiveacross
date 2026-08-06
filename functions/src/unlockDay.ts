/**
 * Phase 1.5 daily scheduler core (issue #202, daily-cards-spec § "Unlock
 * mechanics" / "Security rules and functions (shape only)" / "Scoring and social
 * surfaces"). Owns the scheduled TRIGGERS and the snapshot / freeze WRITES only:
 *
 *   1. Snapshot at unlock — for every Day whose `unlockAt` has passed and which
 *      carries no `snapshotItemIds` yet, stamp the Day with the ids of every
 *      `status: 'active'` item in that Day's pool at that moment. Idempotent: a
 *      Day that already carries a snapshot (even an empty one) is never
 *      re-stamped, so retries and a second same-day run are no-ops.
 *   2. The finale two-beat finish — at 20:00 on Day 9 post exactly one
 *      `last_call` Moment (frozenAt untouched); at 08:00 on Day 10 (the farewell
 *      Day's `unlockAt`) set `EventDoc.frozenAt` and post exactly one `podium`
 *      Moment. The standings / podium CONTENT is #212 / #217; these Moments carry
 *      only the minimal payload those tickets render.
 *   3. A manual admin "unlock now" fallback (`manualUnlockNow`) that forces the
 *      SAME idempotent snapshot for one Day on demand, so function lag / failure
 *      can never leave a Day dealing from an unfrozen pool — and can never
 *      diverge from the scheduled path's semantics.
 *
 * Every decision is a pure, injectable function so the whole flow is unit-testable
 * without a Functions runtime (mirrors `autohide.ts`'s split between decision
 * logic and the thin `index.ts` trigger seam). The Firestore surface is passed in
 * — this module imports no `firebase-admin` / `firebase-functions`, so it never
 * touches a live backend under test. Best-effort throughout: a single Day or beat
 * failing is logged and skipped, never crashing the scheduled run (ADR 0001;
 * mirrors `autohide.ts` / `notify.ts`).
 */

// --- Minimal domain shapes (local, so this module stays decoupled from the app
// package — mirrors autohide.ts's ReportableDoc approach). --------------------

/** The subset of a `DayDef` the scheduler reads/writes. */
export interface DayLike {
  index: number;
  pool: string; // canonical 'main' | 'easy' | 'closing'; legacy docs persist 'embark' | 'farewell' (normalizePool)
  unlockAt: number; // ms epoch
  snapshotItemIds?: string[];
  snapshotEasyMixRatio?: number;
}

/** The subset of an `EventDoc` the scheduler reads. */
export interface EventLike {
  days?: DayLike[];
  frozenAt?: number | null;
  admins?: string[];
  /** ADR 0004 Phase 0 community auto-hide threshold (mirrors the live deal pool). */
  settings?: { reportHideThreshold?: number; easyMixRatio?: number };
  /** ADR 0004 Phase 0 event-scoped ban roster (#108; mirrors the live deal pool). */
  bannedUids?: string[];
  /** The frozen Most-Loved Photo award (#560) — the guard reads presence only
   *  (`!= null` = already computed, the beat's idempotence key), so the type
   *  stays `unknown` rather than restating the shared shape here. */
  mostLovedPhoto?: unknown;
}

/** The finale Moment kinds this ticket posts. */
import {
  lastCallStandingsCopy,
  buildPodiumPayload,
  buildMostLovedPhotoAward,
  type FinalePlayer,
  type FinaleDay,
  type FinaleDayStat,
  type FinaleDayHonorDoc,
  type MostLovedProofLike,
  type MostLovedHeartLike,
} from './finaleContent';
import { normalizePool } from './poolVocab';
// Declaration-only shared contract (the daily-engagement-email precedent) —
// the persisted award shape both compiler roots agree on.

export type FinaleMomentKind = 'last_call' | 'podium';

// --- Pure decisions -------------------------------------------------------------

/**
 * A Day is due for a snapshot iff its `unlockAt` has passed AND it carries no
 * snapshot yet. `snapshotItemIds == null` (absent/undefined) is the ONLY
 * unstamped state: an empty array `[]` is a valid stamp (a Day whose pool had no
 * active items at unlock) and must NOT be re-stamped — that is the idempotency
 * guarantee.
 */
export function isDueForSnapshot(day: DayLike, now: number): boolean {
  return day.unlockAt <= now && day.snapshotItemIds == null;
}

/** The Days due for a snapshot at `now`, in schedule order. */
export function daysDueForSnapshot(days: DayLike[], now: number): DayLike[] {
  return days.filter((d) => isDueForSnapshot(d, now));
}

/**
 * The shape of an active item doc the snapshot reads. Mirrors the fields the live
 * deal pool (`src/data/api.ts` joinAndDeal) inspects, so a frozen Day Card draws
 * from the SAME pool a Player sees live.
 */
export interface SnapshotItem {
  id: string;
  pool?: string;
  isFreeSpace?: boolean;
  reportCount?: number;
  createdBy?: string;
  createdAt?: number;
  approvedAt?: number;
}

/** The item pools a Day's snapshot draws from (specs/easy-mix.md § "Snapshot carries
 *  both pools"). A MAIN day freezes BOTH the main pool AND the easy pool, so the
 *  easy-mix squares live in the one snapshot and every deal / reshuffle inherits the
 *  mix for free. Curated Days (easy/closing) freeze only their own pool, unchanged.
 *  Vocabulary-normalized on BOTH sides (#565): the returned set is canonical, and
 *  `activeSnapshotIds` normalizes each item's pool before matching, so a Day or
 *  item persisting the legacy values ('embark'/'farewell') behaves identically.
 */
export function snapshotPoolsFor(dayPool: string): string[] {
  const pool = normalizePool(dayPool);
  return pool === 'main' ? ['main', 'easy'] : [pool];
}

function eventEasyMixRatio(event: EventLike | undefined): number {
  return typeof event?.settings?.easyMixRatio === 'number' ? event.settings.easyMixRatio : 0.5;
}

/** The pool + moderation + cutoff context a snapshot is filtered against. */
export interface SnapshotFilter {
  pool: string;
  /**
   * The set of item pools this snapshot admits. When present it is authoritative
   * (a main day passes `['main', 'easy']` — see `snapshotPoolsFor`); when absent it
   * defaults to `[pool]`, so a caller that only sets `pool` keeps the pre-easy-mix
   * single-pool behavior.
   */
  pools?: string[];
  /**
   * The Day's canonical unlock moment (`day.unlockAt`), NOT the run clock: an item
   * that only entered the pool AFTER unlock must not slip into a delayed/manual run's
   * snapshot and retroactively change an already-open Day's pool.
   */
  cutoff: number;
  reportHideThreshold?: number;
  bannedUids?: readonly string[];
}

/**
 * ADR 0004 Phase 0 community auto-hide — local mirror of `src/data/moderation.ts`'s
 * `isReportHidden` (this module stays decoupled from the app package, like
 * `autohide.ts`). True iff `reportCount` has REACHED a POSITIVE threshold; fails
 * OPEN for a missing/non-positive threshold.
 */
function isReportHidden(reportCount: number, threshold: number | undefined): boolean {
  return typeof threshold === 'number' && threshold > 0 && reportCount >= threshold;
}

/**
 * ADR 0004 Phase 0 event-scoped ban — local mirror of `src/data/moderation.ts`'s
 * `isBanned`. True iff `uid` is on the roster; fails OPEN for a missing/malformed
 * roster.
 */
function isBanned(uid: string | undefined, bannedUids: readonly string[] | undefined): boolean {
  return !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid);
}

/**
 * The ids that make up a Day's snapshot: the `status: 'active'` items in that Day's
 * pool that the LIVE deal pool would also deal. Items are pre-filtered to `active`
 * by the query; this applies the SAME predicates `src/data/api.ts` applies before
 * `dealBoard`, so a frozen card can never surface content the live pool hides:
 *
 *   - pool split, defaulting a missing `pool` to `'main'` so legacy (pre-Phase-1.5)
 *     active items — read as `'main'` by `itemConverter` — land in a main snapshot;
 *   - drop `isFreeSpace` sentinels (the free center is dealt separately; the create
 *     rule does not constrain the flag, so a raw client write could carry it);
 *   - drop community-hidden (`isReportHidden`) and banned-author (`isBanned`) items;
 *   - drop items that entered the pool AFTER the Day's `unlockAt` cutoff — a snapshot
 *     is the active pool AS OF the unlock moment, even when the run is delayed. An
 *     item's pool-entry time is `approvedAt` (Phase 1.5 approval flow) falling back to
 *     `createdAt` (legacy items created directly `active`); a doc missing both is kept
 *     (fail open), matching the moderation predicates' open-failure posture. A
 *     NON-POSITIVE cutoff (the `unlockAt: 0` "live pre-cruise" sentinel) applies no
 *     cutoff at all (#289) — see inside.
 */
export function activeSnapshotIds(items: SnapshotItem[], filter: SnapshotFilter): string[] {
  const { pool, cutoff, reportHideThreshold, bannedUids } = filter;
  // The admitted pools: the explicit set when given (a main day → main + embark), else
  // just the single `pool` (pre-easy-mix behavior). Order of `items` is preserved, so
  // the deal path can re-split by pool while the main items keep their relative order.
  const pools = filter.pools ?? [pool];
  // A non-positive cutoff is an "always unlocked" sentinel (seeds have used
  // `unlockAt: 0` for the live-pre-cruise embark Day), NOT a real instant —
  // treating it as one excludes EVERY item (all `createdAt` > epoch) and stamps
  // an empty snapshot, which `isDueForSnapshot` then reads as already-stamped,
  // permanently starving the Day (#289, the 2026-07-14 embark incident). Fail
  // OPEN: no cutoff, the snapshot is simply the active pool at run time.
  const cutoffApplies = cutoff > 0;
  // Membership is tested in NORMALIZED vocabulary on both sides (#565): the
  // admitted set and each item's persisted pool may independently be legacy
  // ('embark'/'farewell') or canonical ('easy'/'closing') during the rename
  // transition, and a mixed Event must still resolve to the same one pool.
  const normalizedPools = pools.map(normalizePool);
  return items
    .filter((it) => normalizedPools.includes(normalizePool(it.pool)))
    .filter((it) => !it.isFreeSpace)
    .filter((it) => !isReportHidden(it.reportCount ?? 0, reportHideThreshold))
    .filter((it) => !isBanned(it.createdBy, bannedUids))
    .filter((it) => {
      if (!cutoffApplies) return true;
      const enteredAt = it.approvedAt ?? it.createdAt;
      return enteredAt == null || enteredAt <= cutoff;
    })
    .map((it) => it.id);
}

/** 20:00 Day 9 sits 12h after Day 9's 08:00 `unlockAt`; 08:00 Day 10 → freeze. */
export const LAST_CALL_LEAD_MS = 12 * 60 * 60 * 1000;

export interface FinaleTimes {
  lastCallAt: number;
  farewellUnlockAt: number;
  lastCallDayIndex: number;
  podiumDayIndex: number;
}

/**
 * Resolve the finale clock boundaries from the Day schedule. The farewell Day
 * (pool `'farewell'`, Day 10) anchors the freeze/podium at its own `unlockAt`
 * (08:00 disembark morning, the standard rule). The last-call beat is Day 9's
 * 08:00 `unlockAt` + 12h = 20:00 Day 9 (a same-day forward offset, so no
 * midnight/DST cross); if Day 9 is somehow absent it falls back to
 * `farewellUnlockAt - 12h` (the 08:00→08:00 gap less the last night). Returns
 * `null` when there is no farewell Day (a non-Phase-1.5 event), so callers skip
 * the finale entirely.
 *
 * NO DST CAVEAT (#552). This used to warn that the 12h wall gap assumed the
 * event window did not cross a `Europe/Rome` DST switch, and that the 20:00 cron
 * landed inside `[lastCallAt, farewellUnlockAt)` under standard time. Both
 * halves are retired. Every boundary here is derived from the Day schedule's own
 * `unlockAt` values — absolute instants — so there is no local-time shift to
 * reason about; and the scheduler is a single fixed-offset UTC trigger that
 * sweeps often enough to land inside any beat's window rather than a wall-clock
 * cron aimed at one. Do not reintroduce a timezone assumption here: the whole
 * point of #552 is that this file's arithmetic is timezone-free.
 */
export function finaleTimes(days: DayLike[]): FinaleTimes | null {
  const farewell = days.find((d) => normalizePool(d.pool) === 'closing');
  if (!farewell) return null;
  const dayNine = days.find((d) => d.index === farewell.index - 1);
  const lastCallAt = dayNine ? dayNine.unlockAt + LAST_CALL_LEAD_MS : farewell.unlockAt - LAST_CALL_LEAD_MS;
  return {
    lastCallAt,
    farewellUnlockAt: farewell.unlockAt,
    lastCallDayIndex: farewell.index - 1,
    podiumDayIndex: farewell.index,
  };
}

export interface FinaleDecision {
  postLastCall: boolean;
  freeze: boolean;
  postPodium: boolean;
  computeMostLoved: boolean;
}

/**
 * Given the finale boundaries, `now`, and the current state (`frozenAt`, whether the
 * `last_call` / `podium` Moments already exist, whether the Most-Loved award is
 * already persisted), decide which beats fire:
 *
 *   - `postLastCall`: `now` is in `[lastCallAt, farewellUnlockAt)` and no last-call
 *     Moment exists yet. The upper bound means once the freeze time arrives the
 *     podium supersedes it; the already-posted guard makes a same-window retry a no-op.
 *   - `freeze`: `now` has reached the farewell unlock and the event is not yet frozen
 *     (the actual flip is transactional and exactly-once).
 *   - `postPodium`: `now` has reached the farewell unlock and no podium Moment exists
 *     yet. DECOUPLED from the freeze flip on purpose (Codex #228): if an earlier run
 *     froze but its podium write failed transiently, the freeze guard now blocks
 *     re-freezing, but the podium retry stays open until the Moment actually lands.
 *     Concurrent double-posts collapse onto the one deterministic-id doc.
 *   - `computeMostLoved` (#560): `now` has reached the farewell unlock, the Event
 *     is not yet frozen, and no `mostLovedPhoto` award is persisted yet. It is
 *     deliberately coupled to the freeze transaction: that transaction reads the
 *     moderation state and the Proof/Heart collections, then writes both frozen
 *     fields together. A retry therefore cannot rebuild an award from a later ban
 *     roster, report threshold, or Proof visibility state.
 */
export function finaleActions(
  times: FinaleTimes,
  now: number,
  state: {
    frozenAt?: number | null;
    lastCallPosted: boolean;
    podiumPosted: boolean;
    mostLovedComputed: boolean;
  },
): FinaleDecision {
  const atFreeze = now >= times.farewellUnlockAt;
  return {
    postLastCall: now >= times.lastCallAt && now < times.farewellUnlockAt && !state.lastCallPosted,
    freeze: atFreeze && state.frozenAt == null,
    postPodium: atFreeze && !state.podiumPosted,
    computeMostLoved: atFreeze && state.frozenAt == null && !state.mostLovedComputed,
  };
}

/** An event admin is any uid on the event's `admins` roster (mirrors `isAdmin` in firestore.rules). */
export function isEventAdmin(event: EventLike | undefined, uid: string | undefined): boolean {
  return !!uid && Array.isArray(event?.admins) && event.admins.includes(uid);
}

/** Thrown by `manualUnlockNow` for a non-admin caller; mapped to an HttpsError at the trigger seam. */
export class UnlockPermissionError extends Error {}

// --- Injectable admin-SDK Firestore surface (minimal) ---------------------------

interface DocSnapshot {
  readonly exists: boolean;
  readonly id: string;
  /** Server-assigned document creation time, present on Admin SDK snapshots. */
  readonly createTime?: { toMillis(): number };
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnapshot>;
  set(data: Record<string, unknown>): Promise<unknown>;
}
interface QueryRef {
  where(field: string, op: string, value: unknown): QueryRef;
  get(): Promise<{ docs: DocSnapshot[] }>;
}
interface CollectionRef extends QueryRef {
  doc(id?: string): DocRef;
}
interface Transaction {
  get(ref: DocRef): Promise<DocSnapshot>;
  get(ref: QueryRef): Promise<{ docs: DocSnapshot[] }>;
  update(ref: DocRef, data: Record<string, unknown>): void;
}
/** The minimal admin-SDK Firestore surface the scheduler uses. */
export interface AdminFirestore {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
  runTransaction<T>(updateFunction: (tx: Transaction) => Promise<T>): Promise<T>;
}

export type SnapshotResult = 'stamped' | 'already-stamped' | 'not-due' | 'no-event' | 'no-day';

export interface UnlockDeps {
  /** Current time; defaults to `Date.now`. */
  now?: () => number;
}

function snapshotItemsFrom(snap: { docs: DocSnapshot[] }): SnapshotItem[] {
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      pool: data.pool as string | undefined,
      isFreeSpace: data.isFreeSpace as boolean | undefined,
      reportCount: data.reportCount as number | undefined,
      createdBy: data.createdBy as string | undefined,
      createdAt: data.createdAt as number | undefined,
      approvedAt: data.approvedAt as number | undefined,
    };
  });
}

async function queryActiveItems(db: AdminFirestore, eventId: string): Promise<SnapshotItem[]> {
  return snapshotItemsFrom(
    await db.collection(`events/${eventId}/items`).where('status', '==', 'active').get(),
  );
}

async function hasMoment(db: AdminFirestore, eventId: string, kind: FinaleMomentKind): Promise<boolean> {
  const snap = await db.collection(`events/${eventId}/moments`).where('kind', '==', kind).get();
  return snap.docs.length > 0;
}

async function postFinaleMoment(
  db: AdminFirestore,
  eventId: string,
  kind: FinaleMomentKind,
  dayIndex: number,
  now: number,
  // #266: the beat's CONTENT — the last-call standings line, or the podium
  // payload — merged into the Moment doc so the Feed renders the real finale
  // instead of a generic placeholder. Optional: a content-build failure still
  // posts the minimal beat (content is best-effort; the beat itself is not).
  extra?: Record<string, unknown>,
): Promise<void> {
  // Write at the DETERMINISTIC `kind` id, not an auto-id: the public Feed read
  // (`hasCanonicalMomentId`, src/hooks/useData.ts) only renders these singleton
  // finale beats when `moment.id === moment.kind`, so an auto-id moment would exist
  // in Firestore but never surface (Codex #228 P1). The deterministic id also makes
  // a retry overwrite the one doc rather than fan out duplicates. No human
  // author — a `system` uid keeps the MomentDoc shape intact without
  // impersonating a Player.
  await db.collection(`events/${eventId}/moments`).doc(kind).set({
    kind,
    uid: 'system',
    displayName: '',
    photoURL: null,
    createdAt: now,
    dayIndex,
    ...(extra ?? {}),
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeDayStats(value: unknown): Record<number, FinaleDayStat> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<number, FinaleDayStat> = {};
  for (const [key, raw] of Object.entries(value)) {
    const dayIndex = Number(key);
    if (!Number.isInteger(dayIndex) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const stat = raw as Record<string, unknown>;
    if (typeof stat.bingoCount !== 'number' || !Number.isFinite(stat.bingoCount)) continue;
    if (typeof stat.squaresMarked !== 'number' || !Number.isFinite(stat.squaresMarked)) continue;
    out[dayIndex] = {
      bingoCount: stat.bingoCount,
      squaresMarked: stat.squaresMarked,
      firstBingoAt: typeof stat.firstBingoAt === 'number' && Number.isFinite(stat.firstBingoAt) ? stat.firstBingoAt : null,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The canonical roster as `FinalePlayer[]` (#266) — the same shape the content
 *  builders and client-side podium consume. Ban filtering is applied only to the
 *  rendered view/copy, so reversible bans do not permanently erase finale data. */
async function readFinaleRoster(
  db: AdminFirestore,
  eventId: string,
): Promise<FinalePlayer[]> {
  const snap = await db.collection(`events/${eventId}/players`).get();
  return snap.docs
    .map((d) => {
      const data = (d.data() ?? {}) as Partial<FinalePlayer>;
      const uid = d.id || (typeof data.uid === 'string' && data.uid ? data.uid : '');
      return {
        uid,
        displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : 'Anonymous',
        bingoCount: finiteNumber(data.bingoCount, 0),
        squaresMarked: finiteNumber(data.squaresMarked, 0),
        firstBingoAt: typeof data.firstBingoAt === 'number' && Number.isFinite(data.firstBingoAt) ? data.firstBingoAt : null,
        dayStats: sanitizeDayStats(data.dayStats),
      };
    })
    .filter((p) => p.uid !== '');
}

function visibleFinaleRoster(roster: readonly FinalePlayer[], bannedUids: readonly string[]): FinalePlayer[] {
  if (bannedUids.length === 0) return [...roster];
  return roster.filter((p) => !bannedUids.includes(p.uid));
}

/** Every pinned per-Day honor doc (#266) — days/{i}/meta/{i}, present ones only. */
async function readDayHonors(
  db: AdminFirestore,
  eventId: string,
  days: readonly FinaleDay[],
): Promise<FinaleDayHonorDoc[]> {
  const honors = await Promise.all(
    days.map(async (d) => {
      try {
        const snap = await db.doc(`events/${eventId}/days/${d.index}/meta/${d.index}`).get();
        const firstBingo = (snap.data() as { firstBingo?: FinaleDayHonorDoc['firstBingo'] } | undefined)?.firstBingo;
        return firstBingo ? ({ dayIndex: d.index, firstBingo } as FinaleDayHonorDoc) : null;
      } catch {
        return null;
      }
    }),
  );
  return honors.filter((h): h is FinaleDayHonorDoc => h !== null);
}

// --- Snapshot stamping ----------------------------------------------------------

/**
 * Idempotently stamp one Day's `snapshotItemIds`. Reads the event, locates the
 * Day by its `index`, and — if the Day is due (`unlockAt` passed) and unstamped —
 * queries the Day's active pool items inside the same transaction that writes
 * the snapshot. That query is part of the transaction's read set, so a seed
 * replacement racing a scheduled unlock makes Firestore retry rather than
 * stamping ids from the pre-reseed pool. The transaction also re-confirms the
 * Day is still unstamped and due (a concurrent run or manual path may have
 * won the race). Returns what it did.
 */
export async function stampDaySnapshot(
  db: AdminFirestore,
  eventId: string,
  dayIndex: number,
  deps: UnlockDeps = {},
): Promise<SnapshotResult> {
  const now = (deps.now ?? Date.now)();
  const eventRef = db.doc(`events/${eventId}`);
  const pre = (await eventRef.get()).data() as EventLike | undefined;
  if (!pre) return 'no-event';
  const days = Array.isArray(pre.days) ? pre.days : [];
  const day = days.find((d) => d.index === dayIndex);
  if (!day) return 'no-day';
  if (day.unlockAt > now) return 'not-due';
  if (day.snapshotItemIds != null) return 'already-stamped';

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);
    const ev = snap.data() as EventLike | undefined;
    if (!ev) return 'no-event';
    const arr = Array.isArray(ev.days) ? [...ev.days] : [];
    const i = arr.findIndex((d) => d.index === dayIndex);
    if (i < 0) return 'no-day';
    if (arr[i].unlockAt > now) return 'not-due';
    if (arr[i].snapshotItemIds != null) return 'already-stamped'; // re-confirm: never overwrite an existing snapshot
    // Read the active pool THROUGH this transaction. A concurrent seed batch
    // that changes any selected item makes the transaction retry, so the
    // frozen ids and the committed pool always describe one Firestore state.
    const items = snapshotItemsFrom(
      await tx.get(db.collection(`events/${eventId}/items`).where('status', '==', 'active')),
    );
    // Filter the frozen pool by the SAME predicates the live deal path applies, AS OF
    // this Day's unlock moment — so a delayed/manual run can never freeze in content
    // the live pool hides, nor items approved after the Day opened (Codex #228).
    const snapshotItemIds = activeSnapshotIds(items, {
      pool: arr[i].pool,
      // A main day freezes BOTH pools (main + embark) so the easy mix rides the one
      // snapshot (specs/easy-mix.md); tutorial days freeze only their own pool.
      pools: snapshotPoolsFor(arr[i].pool),
      cutoff: arr[i].unlockAt,
      reportHideThreshold: ev.settings?.reportHideThreshold,
      bannedUids: ev.bannedUids,
    });
    arr[i] = {
      ...arr[i],
      snapshotItemIds,
      ...(arr[i].pool === 'main' ? { snapshotEasyMixRatio: eventEasyMixRatio(ev) } : {}),
    };
    tx.update(eventRef, { days: arr });
    return 'stamped';
  });
}

/**
 * Transactionally set `frozenAt` to the scheduled cutoff iff it is not already set.
 * Exactly-once: only the run that flips it from unset returns `true`, so a retry or
 * a racing run no-ops. The stamped value is the farewell Day's `unlockAt` (the 08:00
 * freeze cutoff), NOT the run clock (Codex #228): a delayed or manual recovery run
 * must not push the freeze boundary later and let post-08:00 marks into the standings.
 */
async function freezeStandings(db: AdminFirestore, eventId: string, frozenAt: number): Promise<boolean> {
  const eventRef = db.doc(`events/${eventId}`);
  return db.runTransaction(async (tx) => {
    const ev = (await tx.get(eventRef)).data() as EventLike | undefined;
    if (!ev || ev.frozenAt != null) return false;
    tx.update(eventRef, { frozenAt });
    return true;
  });
}

// --- Most-Loved Photo award (#534/#560) -------------------------------------------

/** Map a proofs collection read onto the pure builder's input shape. Defensive
 *  field-by-field reads, mirroring `snapshotItemsFrom`: a malformed doc gets
 *  values the eligibility predicates simply exclude (`''` never equals
 *  `'photo'`/`'active'`), never a throw. */
function mostLovedProofsFrom(snap: { docs: DocSnapshot[] }): MostLovedProofLike[] {
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      uid: typeof data.uid === 'string' ? data.uid : '',
      displayName: typeof data.displayName === 'string' ? data.displayName : '',
      type: typeof data.type === 'string' ? data.type : '',
      status: typeof data.status === 'string' ? data.status : '',
      reportCount: finiteNumber(data.reportCount, 0),
      createdAt: finiteNumber(data.createdAt, 0),
      itemText: typeof data.itemText === 'string' ? data.itemText : '',
      dayIndex:
        typeof data.dayIndex === 'number' && Number.isFinite(data.dayIndex) ? data.dayIndex : null,
    };
  });
}

/** Map a hearts collection read onto the pure builder's input shape. A missing
 *  `targetCreatedAt` defaults to -1 so a malformed heart can never
 *  incarnation-match a proof whose own missing `createdAt` defaulted to 0.
 *  `createTime` is Firestore's server-assigned document-creation instant; the
 *  client-set `createdAt` remains Feed ordering data, but is not trustworthy
 *  enough to freeze eligibility because the rules intentionally tolerate clock
 *  drift. A missing/malformed metadata value becomes NaN, which the pure
 *  builder rejects rather than letting an unverifiable heart into the award. */
function mostLovedHeartsFrom(snap: { docs: DocSnapshot[] }): MostLovedHeartLike[] {
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    const serverCreatedAt = d.createTime?.toMillis();
    return {
      uid: typeof data.uid === 'string' ? data.uid : '',
      targetKind: typeof data.targetKind === 'string' ? data.targetKind : '',
      targetId: typeof data.targetId === 'string' ? data.targetId : '',
      targetCreatedAt: finiteNumber(data.targetCreatedAt, -1),
      createdAt: finiteNumber(data.createdAt, 0),
      serverCreatedAt:
        typeof serverCreatedAt === 'number' && Number.isFinite(serverCreatedAt)
          ? serverCreatedAt
          : Number.NaN,
    };
  });
}

/**
 * Atomically freeze standings and persist the Most-Loved Photo award (#560).
 *
 * The Event's ban roster/report threshold, every eligible Proof's visibility,
 * and every Heart's server creation time are read inside the same transaction
 * that stamps `frozenAt` and `mostLovedPhoto`. That coupling is essential: a
 * retry after an award-read/write failure must not rebuild an ostensibly frozen
 * award from mutable moderation state. If any read fails, neither frozen field
 * is written and the next tick retries the whole snapshot together. The podium
 * remains its own best-effort beat.
 *
 * `cutoff` is the SCHEDULED freeze instant (`times.farewellUnlockAt`), never the
 * run clock: post-cutoff Hearts remain excluded even if this transaction starts
 * late. The atomic transaction also collapses concurrent scheduler/manual runs
 * onto the first successful freeze.
 */
async function freezeStandingsAndPersistMostLovedAward(
  db: AdminFirestore,
  eventId: string,
  cutoff: number,
  now: number,
): Promise<boolean> {
  const eventRef = db.doc(`events/${eventId}`);
  const proofsRef = db.collection(`events/${eventId}/proofs`);
  const heartsRef = db.collection(`events/${eventId}/hearts`);
  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    const event = eventSnap.data() as EventLike | undefined;
    if (!event || event.frozenAt != null || event.mostLovedPhoto != null) return false;

    // Firestore requires all transaction reads before its write. Reading every
    // award input through `tx` gives the Event update a single, retry-safe view.
    const [proofsSnap, heartsSnap] = await Promise.all([tx.get(proofsRef), tx.get(heartsRef)]);
    const award = buildMostLovedPhotoAward(mostLovedProofsFrom(proofsSnap), mostLovedHeartsFrom(heartsSnap), {
      bannedUids: event.bannedUids ?? [],
      reportHideThreshold: event.settings?.reportHideThreshold,
      cutoff,
      computedAt: now,
    });
    tx.update(eventRef, {
      frozenAt: cutoff,
      mostLovedPhoto: award as unknown as Record<string, unknown>,
    });
    return true;
  });
}

// --- Finale beats ---------------------------------------------------------------

/**
 * Run the finale two-beat check for one event. Best-effort: each beat is
 * independently try/caught so one failing (e.g. a Moment write) never blocks the
 * other or crashes the run. Guards make it safe to call on any day and any number
 * of times — a non-finale day, or a re-run, simply posts nothing.
 */
export async function runFinaleBeats(db: AdminFirestore, eventId: string, deps: UnlockDeps = {}): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const event = (await db.doc(`events/${eventId}`).get()).data() as EventLike | undefined;
  if (!event) return;
  const times = finaleTimes(Array.isArray(event.days) ? event.days : []);
  if (!times) return;

  const [lastCallPosted, podiumPosted] = await Promise.all([
    hasMoment(db, eventId, 'last_call'),
    hasMoment(db, eventId, 'podium'),
  ]);
  const { postLastCall, freeze, postPodium, computeMostLoved } = finaleActions(times, now, {
    frozenAt: event.frozenAt,
    lastCallPosted,
    podiumPosted,
    mostLovedComputed: event.mostLovedPhoto != null,
  });

  if (postLastCall) {
    try {
      // #266: the going-into-the-final-night standings line ("X leads by 2
      // bingos—standings freeze at 8 a.m."), built from the ban-filtered
      // roster. Content is best-effort: a roster read failure posts the
      // minimal beat rather than skipping it.
      let extra: Record<string, unknown> | undefined;
      try {
        const roster = await readFinaleRoster(db, eventId);
        extra = {
          line: lastCallStandingsCopy(visibleFinaleRoster(roster, event.bannedUids ?? [])),
          lastCall: {
            players: roster.map((p) => ({
              uid: p.uid,
              displayName: p.displayName,
              bingoCount: p.bingoCount,
              squaresMarked: p.squaresMarked,
            })),
          },
        };
      } catch (err) {
        console.error('runFinaleBeats: last_call content build failed', eventId, err);
      }
      await postFinaleMoment(db, eventId, 'last_call', times.lastCallDayIndex, now, extra);
    } catch (err) {
      console.error('runFinaleBeats: last_call post failed', eventId, err);
    }
  }
  // Freeze and podium are INDEPENDENT best-effort beats (Codex #228): the podium
  // retries on its own guard, while the freeze transaction atomically captures the
  // Most-Loved eligibility state when that award is still owed. Both are idempotent,
  // so a re-run or a race is safe.
  if (freeze) {
    try {
      if (computeMostLoved) {
        await freezeStandingsAndPersistMostLovedAward(db, eventId, times.farewellUnlockAt, now);
      } else {
        // Defensive compatibility for an Event that already has a persisted
        // award but lacks the historical freeze stamp. The normal new-event path
        // always takes the atomic branch above.
        await freezeStandings(db, eventId, times.farewellUnlockAt);
      }
    } catch (err) {
      console.error('runFinaleBeats: freeze failed', eventId, err);
    }
  }
  if (postPodium) {
    try {
      // #266: the podium payload — champion, cruise-wide First to BINGO, and
      // the pinned daily honors — computed AT the freeze from the ban-filtered
      // roster + day-meta pins. Best-effort like the last-call content.
      let extra: Record<string, unknown> | undefined;
      try {
        const days = (Array.isArray(event.days) ? event.days : []) as FinaleDay[];
        const [roster, honors] = await Promise.all([
          readFinaleRoster(db, eventId),
          readDayHonors(db, eventId, days),
        ]);
        extra = { podium: buildPodiumPayload(roster, days, honors) as unknown as Record<string, unknown> };
      } catch (err) {
        console.error('runFinaleBeats: podium content build failed', eventId, err);
      }
      await postFinaleMoment(db, eventId, 'podium', times.podiumDayIndex, now, extra);
    } catch (err) {
      console.error('runFinaleBeats: podium post failed', eventId, err);
    }
  }
}

// --- Orchestration --------------------------------------------------------------

/**
 * One scheduled sweep for one event: stamp every due Day's snapshot (each
 * best-effort, so one Day failing never blocks the rest), then run the finale
 * beats. Returns how many Days it stamped on this run. The scheduled trigger in
 * `index.ts` calls this per active event.
 */
export async function runScheduledUnlock(
  db: AdminFirestore,
  eventId: string,
  deps: UnlockDeps = {},
): Promise<{ stamped: number }> {
  const now = (deps.now ?? Date.now)();
  const event = (await db.doc(`events/${eventId}`).get()).data() as EventLike | undefined;
  if (!event) return { stamped: 0 };
  const days = Array.isArray(event.days) ? event.days : [];
  let stamped = 0;
  for (const day of daysDueForSnapshot(days, now)) {
    try {
      if ((await stampDaySnapshot(db, eventId, day.index, deps)) === 'stamped') stamped++;
    } catch (err) {
      console.error('runScheduledUnlock: stampDaySnapshot failed', eventId, day.index, err);
    }
  }
  await runFinaleBeats(db, eventId, deps);
  return { stamped };
}

/**
 * The manual admin "unlock now" fallback: force the SAME idempotent snapshot for
 * one Day on demand (function lag / failure). Denies a non-admin caller by
 * throwing `UnlockPermissionError`; on success runs the identical
 * `stampDaySnapshot` the scheduled path uses, so the two can never diverge.
 */
export async function manualUnlockNow(
  db: AdminFirestore,
  callerUid: string | undefined,
  eventId: string,
  dayIndex: number,
  deps: UnlockDeps = {},
): Promise<SnapshotResult> {
  const event = (await db.doc(`events/${eventId}`).get()).data() as EventLike | undefined;
  if (!isEventAdmin(event, callerUid)) {
    throw new UnlockPermissionError('Only an event admin can unlock a Day.');
  }
  return stampDaySnapshot(db, eventId, dayIndex, deps);
}

// --- Guarded re-snapshot (the easy-mix deploy-race fallback) ---------------------

export type ResnapshotResult =
  | 'resnapshotted'
  | 'has-boards'
  | 'not-recoverable'
  | 'not-due'
  | 'no-event'
  | 'no-day';

/**
 * The easy-mix deploy-race fallback (specs/easy-mix.md § "Deploy race"): OVERWRITE one
 * Day's `snapshotItemIds` with the current active pool — main + embark for a main day —
 * but ONLY while ZERO Day Cards have been dealt for that Day.
 *
 * If the 08:00 scheduler fired on the pre-easy-mix build, Day 4's snapshot would carry
 * the main pool alone (no embark ids), so no card could mix. Re-stamping BEFORE anyone
 * deals lets the intended mix take effect. This recovery is therefore limited to
 * Day 4 and later: already-unlocked Days 1-3 are intentionally left main-only.
 * This is the ONE place a snapshot is
 * overwritten rather than idempotently preserved (`stampDaySnapshot` never overwrites),
 * so the zero-boards guard is load-bearing: a dealt card's pool is frozen by its
 * membership in the snapshot it drew from, and rewriting the snapshot under existing
 * cards would let a later deal or reshuffle diverge from the cards already out. Once any
 * board exists the re-stamp is DENIED (`'has-boards'`).
 *
 * Admin-gated exactly like `manualUnlockNow` (a non-admin caller trips
 * `UnlockPermissionError`). The zero-boards check is read inside the same transaction
 * that overwrites the Day, so a concurrent card deal that creates a board forces the
 * transaction to retry and then return `'has-boards'` instead of splitting one Day
 * across two snapshots.
 */
export async function resnapshotDayIfNoBoards(
  db: AdminFirestore,
  callerUid: string | undefined,
  eventId: string,
  dayIndex: number,
  deps: UnlockDeps = {},
): Promise<ResnapshotResult> {
  const now = (deps.now ?? Date.now)();
  const eventRef = db.doc(`events/${eventId}`);
  const pre = (await eventRef.get()).data() as EventLike | undefined;
  if (!isEventAdmin(pre, callerUid)) {
    throw new UnlockPermissionError('Only an event admin can re-snapshot a Day.');
  }
  const days = Array.isArray(pre?.days) ? pre!.days : [];
  const day = days.find((d) => d.index === dayIndex);
  if (!day) return 'no-day';
  if (day.index < 3) return 'not-recoverable';
  if (day.unlockAt > now) return 'not-due';

  const items = await queryActiveItems(db, eventId);
  const snapshotItemIds = activeSnapshotIds(items, {
    pool: day.pool,
    pools: snapshotPoolsFor(day.pool),
    cutoff: day.unlockAt,
    reportHideThreshold: pre?.settings?.reportHideThreshold,
    bannedUids: pre?.bannedUids,
  });

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);
    const ev = snap.data() as EventLike | undefined;
    if (!ev) return 'no-event';
    const arr = Array.isArray(ev.days) ? [...ev.days] : [];
    const i = arr.findIndex((d) => d.index === dayIndex);
    if (i < 0) return 'no-day';
    if (arr[i].index < 3) return 'not-recoverable';
    if (arr[i].unlockAt > now) return 'not-due';
    // Transactional guard: a re-snapshot is permitted ONLY while no card has been
    // dealt. Reading the boards query here serializes the overwrite against a
    // concurrent deal creating `events/{id}/days/{i}/boards/{uid}`.
    if ((await tx.get(db.collection(`events/${eventId}/days/${dayIndex}/boards`))).docs.length > 0) {
      return 'has-boards';
    }
    // OVERWRITE — the deliberate difference from stampDaySnapshot's never-overwrite
    // guard. The transactional zero-boards check above is what makes this safe.
    arr[i] = {
      ...arr[i],
      snapshotItemIds,
      ...(arr[i].pool === 'main' ? { snapshotEasyMixRatio: eventEasyMixRatio(ev) } : {}),
    };
    tx.update(eventRef, { days: arr });
    return 'resnapshotted';
  });
}
