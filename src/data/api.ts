import {
  addDoc,
  collection,
  collectionGroup,
  deleteField,
  doc,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  increment,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, EVENT_ID } from '../firebase';
import { honorDisplayName, markerDisplayName } from './attribution';
import { isReportHidden, isBanned, isExplicitWithheld } from './moderation';
import { adultContentRequired } from '../adultContent';
import { itemsCol } from './paths';
import { FREE_TEXT } from './seed';
import { normalizePool } from '../game/pool';
import {
  dealBoard,
  dayDealState,
  completedLines,
  countMarked,
  isBlackout,
  isPristine,
  foldDayStat,
  achievedItemIds,
  applyEchoes,
  firstLineCompletionAt,
  foldEchoStats,
  standingsFrozen,
  playerRowRootLag,
  tutorialDayIndexSet,
  ceremonialDayIndexSet,
  type DayStats,
  type DealItem,
  type EchoBucket,
  type StatWrite,
} from '../game/logic';
import { enqueueWinMoments } from './moments';
import { cellsToMap, cellsPatch, changedCells, cellsFromData } from '../game/cells';
import { cellsMergeSet } from './cellsMerge';
import { trustedDayBoardSeed } from './board-freshness';
import { pinDayFirstBingo } from './dayMeta';
import { directMarkAnalyticsRequest } from './markAnalytics';
import { stampEchoAnalyticsTransitions } from './echoAnalytics';
import type { Cell, ClaimMode, DayDef, EventDoc, ItemDoc, PlayerDoc, UserDoc } from '../types';

// Raw (converter-free) refs for writes, to keep partial merges simple.
const rawUser = (uid: string) => doc(db, 'users', uid);
const rawBoard = (uid: string) => doc(db, 'events', EVENT_ID, 'boards', uid);
// A Player's Day Card write ref: events/{EVENT_ID}/days/{dayIndex}/boards/{uid}
// (daily-cards-spec § "Data model"). `String(dayIndex)` is the canonical decimal
// segment the day-scoped firestore.rules gate accepts (#201).
const rawDayBoard = (dayIndex: number, uid: string) =>
  doc(db, 'events', EVENT_ID, 'days', String(dayIndex), 'boards', uid);
const rawPlayer = (uid: string) => doc(db, 'events', EVENT_ID, 'players', uid);
const rawItems = () => collection(db, 'events', EVENT_ID, 'items');
const rawItem = (id: string) => doc(db, 'events', EVENT_ID, 'items', id);
const rawEvent = () => doc(db, 'events', EVENT_ID);

/**
 * True only for a well-formed `https://` URL — the only photo shape the public
 * players row accepts from the self-writable users/{uid} profile. Rejects
 * non-strings, unparseable strings, and every other scheme (`http:`,
 * `javascript:`, `data:`, …), so a malformed saved photo can never be
 * denormalized into a public doc other clients render.
 */
function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The public displayName to denormalize for a Player: their SAVED users/{uid}
 * name when it is a real, trimmed-non-empty string within the 100-char cap the
 * public-doc rules enforce (markers, moments, proofs), else the auth value, else
 * 'Anonymous'. Single source of truth for the join-side attribution (`joinAndDeal`)
 * and the per-Prompt Tally marker (`setMark`), so both resolve the name the SAME
 * validated way — a malformed self-written profile never flows into a public doc.
 */
export function resolveDisplayName(
  profile: { displayName?: unknown } | null | undefined,
  authFallback: string | null | undefined,
): string {
  const saved =
    typeof profile?.displayName === 'string' &&
    profile.displayName.trim().length > 0 &&
    profile.displayName.length <= 100
      ? profile.displayName
      : null;
  return saved ?? authFallback ?? 'Anonymous';
}

/** Deterministic 32-bit seed from a uid so a player's board is stable. */
export function seedFromUid(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function eventEasyMixRatio(eventData: Partial<EventDoc> | null | undefined): number {
  return typeof eventData?.settings?.easyMixRatio === 'number' ? eventData.settings.easyMixRatio : 0.5;
}

function dayEasyMixRatio(day: DayDef, eventData: Partial<EventDoc> | null | undefined): number {
  return typeof day.snapshotEasyMixRatio === 'number' ? day.snapshotEasyMixRatio : eventEasyMixRatio(eventData);
}

/**
 * The create-only bootstrap payload for a `users/{uid}` profile row: the
 * Google-sourced identity defaults `ensureUserProfile` writes on first sign-in.
 * Extracted as the ONE source of truth for the bootstrap shape so the attestation
 * transaction can write the SAME payload when it wins the create race on an absent
 * row (Codex P2, PR #112) — no duplicated shape to drift out of sync.
 */
function bootstrapProfile(u: User, now: number = Date.now()) {
  return {
    displayName: u.displayName ?? 'Anonymous',
    photoURL: u.photoURL ?? null,
    createdAt: now,
  };
}

/**
 * Create the global user profile on first sign-in — create-only, it must NEVER
 * overwrite an existing row. The transaction's read of `users/{uid}` is part of
 * the commit's optimistic-concurrency check: the exists-check no-ops when the doc
 * is already there, and if a user-initiated save (data/profile.ts) writes the doc
 * AFTER this read saw it absent, the stale read makes Firestore re-run the whole
 * function, which then re-reads the now-existing doc and no-ops. That is what
 * closes #77 — AuthContext publishes the User (and the app renders, so a fast
 * profile save can race) before this settles, so the create must not clobber a
 * save that landed first. Do NOT regress to a non-merge `setDoc`: that was the
 * original bug — it replaced the whole row with the Google-sourced defaults.
 * Pinned by src/data/auth-profile-race.test.ts.
 */
export async function ensureUserProfile(u: User): Promise<void> {
  const ref = rawUser(u.uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return;
    tx.set(ref, bootstrapProfile(u));
  });
}

/**
 * Persist the honor-system 18+ self-attestation (ADR 0001) for a User: stamp
 * `users/{uid}.attestedAdultAt` with the ms-epoch time of their FIRST attestation.
 * This records the User's OWN statement — not identity verification — and is
 * covered by the EXISTING `users/{uid}` owner self-write (firestore.rules already
 * shape-checks `attestedAdultAt` as a number), so it ships with NO rules change.
 *
 * Create-only for the field, inside a transaction like `ensureUserProfile`: an
 * existing EARLIER stamp is NEVER overwritten, so re-attesting — a fresh sign-in
 * after a prior one, or the returning-User re-prompt — keeps the first timestamp
 * (the no-overwrite case in specs/w1-attestation.md).
 *
 * The row may be ABSENT: during first-time sign-in this transaction can win the
 * create race with `ensureUserProfile` on the not-yet-written `users/{uid}` row.
 * Writing ONLY `attestedAdultAt` then would leave a PARTIAL profile — the
 * create-only `ensureUserProfile` retry sees `exists()` and no-ops, so
 * displayName/photoURL/createdAt would be missing forever (Codex P2, PR #112). So
 * on an absent row we write the FULL `bootstrapProfile` payload `ensureUserProfile`
 * would have written PLUS the stamp (one create, the shared bootstrap shape); on a
 * PRESENT row we merge ONLY the stamp so no other field is clobbered. The
 * transaction's read makes this race-safe: a concurrent `ensureUserProfile` create
 * invalidates this attempt's read set and Firestore re-runs onto the now-present
 * row, which then takes the merge-only branch.
 */
export async function attestAdult(u: User, now: number = Date.now()): Promise<void> {
  const ref = rawUser(u.uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      // Won the create race on an absent row — write the complete profile, not a
      // stamp-only stub, so the create-only bootstrap retry cannot strand it.
      tx.set(ref, { ...bootstrapProfile(u, now), attestedAdultAt: now });
      return;
    }
    const existing = (snap.data() as Partial<UserDoc>).attestedAdultAt;
    if (typeof existing === 'number') return; // keep the FIRST attestation, never overwrite
    tx.set(ref, { attestedAdultAt: now }, { merge: true });
  });
}

/**
 * Read a User's settled 18+ attestation for the re-prompt gate (#23): the
 * ms-epoch `attestedAdultAt` when present, else `null` for a profile that is
 * DEFINITIVELY without one (missing doc or missing field). A single point read of
 * `users/{uid}`; AuthContext calls it once per auth change AFTER `ensureUserProfile`
 * has settled the row, and treats a THROWN read (offline / permission) as UNKNOWN
 * — never a re-prompt — so only a definite `null` gates a signed-in User. An
 * UNKNOWN is not a silent stall either: AuthContext surfaces the failure through
 * its retryable deal-error panel, whose Retry re-runs this read (#112 round 2).
 */
export async function readAdultAttestation(uid: string): Promise<number | null> {
  const snap = await getDoc(rawUser(uid));
  const v = snap.exists() ? (snap.data() as Partial<UserDoc>).attestedAdultAt : undefined;
  return typeof v === 'number' ? v : null;
}

/**
 * Read a User's 18+ attestation from the PERSISTENT LOCAL CACHE only — the
 * offline-safe, render-path read for the cold-boot gate (#115). Unlike
 * `readAdultAttestation` (a server point read that offline never resolves — a
 * transaction-free `getDoc` still awaits the network round trip when the doc is
 * absent from cache), this is `getDocFromCache`: it resolves SYNCHRONOUSLY from
 * the IndexedDB cache (ADR 0006) with no network, so a returning User's already-
 * cached row settles the gate while offline.
 *
 * Returns the ms-epoch `attestedAdultAt` when the cached row carries one, or
 * `null` for a cached row that DEFINITIVELY lacks it (present-but-unstamped, or a
 * cached "not found"). It REJECTS on a genuine cache MISS (the row was never
 * fetched into this device's cache). AuthContext maps those three outcomes to the
 * knownFirstBingoAt / hasServerData tri-state discipline: a stamp settles the gate
 * TRUE offline; a definite `null` or a cache miss stays UNKNOWN (never re-prompted
 * offline, never settled `true`), so cache-first can neither block render nor fail
 * the age gate OPEN. The authoritative present/absent determination — the one that
 * can settle a definite re-prompt — comes from the server `readAdultAttestation`
 * on the online/reconnect path, never from this cache read.
 */
export async function readAdultAttestationFromCache(uid: string): Promise<number | null> {
  const snap = await getDocFromCache(rawUser(uid));
  const v = snap.exists() ? (snap.data() as Partial<UserDoc>).attestedAdultAt : undefined;
  return typeof v === 'number' ? v : null;
}

/**
 * Read a User's 18+ attestation from the SERVER ONLY — the AUTHORITY read that
 * gates the deal (Codex #117 round 6). `readAdultAttestation` above wraps `getDoc`,
 * whose Web API MAY silently RETURN CACHED DATA when the server is unreachable, so
 * it is NOT server-truth and must never establish deal authority: a stale cached
 * stamp could authorize creating board/player rows for a User whose server row no
 * longer carries the 18+ stamp. `getDocFromServer` forces a server round trip and
 * REJECTS when the server cannot be reached — so AuthContext treats a thrown read
 * as "authority NOT established" (no `attestedAuthoritative`, no deal; fall to the
 * deferred/offline path), and only a server-returned stamp (or a same-session
 * optimistic attest) authorizes the deal. The provisional offline RENDER still uses
 * the cache-first `readAdultAttestationFromCache`; only the deal-authority gate is
 * server-only.
 */
export async function readAdultAttestationFromServer(uid: string): Promise<number | null> {
  const snap = await getDocFromServer(rawUser(uid));
  const v = snap.exists() ? (snap.data() as Partial<UserDoc>).attestedAdultAt : undefined;
  return typeof v === 'number' ? v : null;
}

/**
 * True when THIS device already has the User's Event board in the persistent
 * cache — i.e. they are a RETURNING, already-boarded Player (Codex #117 round 9,
 * finding A). Cache-only (`getDocFromCache`, no network) and never rejects: a
 * genuine cache MISS (a first-time User with no board yet) resolves `false`.
 * AuthContext uses it to scope the "bootstrap failed" retryable error to the
 * BOARDLESS case: a returning User with a cached board renders it (they need no
 * deal), while a first-time User whose online bootstrap failed on an
 * optimistic-only attestation gets a Retry instead of being stranded on
 * "Dealing…".
 */
export async function hasCachedBoard(uid: string): Promise<boolean> {
  try {
    return (await getDocFromCache(rawBoard(uid))).exists();
  } catch {
    return false; // not in this device's cache → no local board
  }
}

/**
 * Cache-only probe for whether this device has an ACTUAL dealt CARD for the
 * current User — a legacy `events/{EVENT_ID}/boards/{uid}` OR any day card
 * `events/{EVENT_ID}/days/{d}/boards/{uid}`, both of which carry a `uid` field.
 *
 * This is the mode-agnostic "there is a card to render offline" signal the
 * deal-failure recovery path uses (#403): a transient connection failure while
 * re-running `joinAndDeal` must NOT tear a cached card down for the full-screen
 * DealError. It scans the `boards` collection GROUP from the persistent cache and
 * matches this uid in memory — no `where` clause, so no server index is involved,
 * and it is evaluated purely against local cache (a `getDocsFromCache` never
 * touches the network). The cached `boards` set is tiny: a device only ever loads
 * ITS OWN boards (nothing subscribes to other Players' boards — the Leaderboard
 * reads `players`, not `boards`).
 *
 * Deliberately stronger than a cached `players/{uid}` row (Codex #408, P2): the
 * player row can be cached from the Leaderboard query or another tab/device while
 * NO board was ever loaded here, and swallowing on the row alone would strand the
 * Player on Board's indefinite "Dealing…" state with the retry surface gone. A
 * cached CARD is what guarantees `Board` has something to render.
 *
 * SCOPED to the ACTIVE event (Codex #408 round 2, P2): the collection group spans
 * every `events/{id}/**` tree, so a cached board from a PRIOR `EVENT_ID` (a past
 * cruise) for the same uid must not read as a current card — that would swallow a
 * first-deal failure for the NEW event and leave the Player with no retry. Match
 * the current `events/${EVENT_ID}/` ancestor path AND the uid. Cache miss / read
 * error → `false`, exactly like `hasCachedBoard`.
 */
export async function hasCachedCard(uid: string): Promise<boolean> {
  try {
    const prefix = `events/${EVENT_ID}/`;
    const snap = await getDocsFromCache(collectionGroup(db, 'boards'));
    return snap.docs.some(
      (d) => d.ref.path.startsWith(prefix) && (d.data() as { uid?: unknown }).uid === uid,
    );
  } catch {
    return false; // no local card for the active event in this device's cache
  }
}

/**
 * Deal a frozen board + create the player row the first time a user joins.
 *
 * Returns `true` when it dealt a NEW board (an actual join), `false` when the
 * board already existed and it early-returned a no-op. The caller gates the
 * `join_event` analytic on this so a reconnect that re-runs the deal for an
 * already-boarded Player records nothing (Codex #117 round 8, finding B) —
 * `runDeal` re-fires on every online/authority flip, and an existing-board no-op
 * is not a join.
 *
 * IDEMPOTENT under overlap (#409, the Codex finding on #408): `withTimeout`
 * rejects runDeal's race but cannot cancel the underlying joinAndDeal, so a
 * timed-out deal keeps running while a Retry starts a second one. Both the
 * daily identity seed and the legacy board create therefore run inside a
 * `runTransaction` that re-reads the row/board it is about to write — the same
 * pattern `dealDayCard` and `reshuffleBoard` already use. Two overlapping
 * joins serialize server-side: the loser's transaction retries against the
 * committed state, sees the join already happened, and degrades to an
 * identity-only merge (daily) or a no-op (legacy) — it can no longer re-stamp
 * `joinedAt`, re-zero aggregates off a stale read (a stale `reshufflesUsed: 0`
 * over a real spend is a write firestore.rules DENIES outright — the monotonic
 * counter — which failed the whole join), or double-report an actual join.
 * The deal path is online-gated in AuthContext, so the transaction's
 * online-only nature changes nothing for the offline story (it rejects fast
 * where the old plain write would hang until the #403 timeout).
 */
export async function joinAndDeal(u: User): Promise<boolean> {
  // Decide the MODE from the Event before touching any board (#246): the Phase 1.5
  // day-scoped firestore.rules removed the top-level events/{eventId}/boards/{uid}
  // path entirely, so reading OR writing the legacy board when the Event carries a
  // `days[]` schedule is a DENIED operation. When the schedule is present there is
  // no event-level board at all — a Player's Day Cards are dealt lazily, one per
  // Day, on first open (`dealDayCard`) — so join only ensures the Player's identity
  // row exists (name/avatar + zeroed cruise aggregates) for the leaderboard and the
  // per-Day stat folds. Legacy events (no `days[]`) keep the exact pre-1.5 behavior.
  //
  // FAIL CLOSED on a read ERROR (CodeRabbit #247): a genuine event-read failure
  // must NOT be guessed as legacy mode — that would misroute a real daily event
  // down the legacy `events/{eventId}/boards/{uid}` path the day-scoped rules deny.
  // So the read is NOT `.catch`-swallowed: a transient failure propagates and
  // runDeal surfaces the retryable dealError, exactly like any other deal failure.
  // A readable-but-empty/missing event (no `days[]`) is a legitimate legacy signal;
  // the threshold/ban fields then fall open on the absent keys as before.
  const joinEventSnap = await getDoc(rawEvent());
  const joinEventData = joinEventSnap.exists() ? (joinEventSnap.data() as Partial<EventDoc>) : null;
  const daily = Array.isArray(joinEventData?.days) && joinEventData.days.length > 0;

  if (daily) {
    // Daily mode: no legacy board to read/deal. Ensure the Player row carries its
    // identity + zeroed cruise aggregates. The identity is resolved the SAME
    // validated way as the legacy branch below (saved profile → auth fallback).
    //
    // This must NOT early-return merely because a row EXISTS: `App` renders `Board`
    // while `runDeal()` is still in flight, so the lazy Day-Card effect can call
    // `dealDayCard()` concurrently — and that write creates `players/{uid}` with
    // ONLY a `dayStats` bucket. If that write wins the race, an `exists()`-only
    // guard would return early and the row would be stranded WITHOUT
    // uid/displayName/photoURL/joinedAt (a nameless leaderboard entry — Codex #247
    // P2). So the identity fields are ALWAYS merged, and the zeroed aggregates are
    // seeded only for fields the row doesn't already carry — so a concurrent
    // `dayStats` write (or real earlier progress) is never reset to 0. The return
    // value reports whether this was a genuine first join (no identity yet), so the
    // `join_event` analytic still fires exactly once.
    // The saved profile read stays OUTSIDE the transaction: it is advisory
    // identity input (validated + fallback-guarded either way), lives on a doc
    // this write never touches, and re-reading it on a contention retry would
    // add a round trip for no correctness gain.
    const profileSnap = await getDoc(rawUser(u.uid)).catch(() => null);
    const profile = profileSnap?.exists() ? (profileSnap.data() as Partial<UserDoc>) : null;
    const savedPhoto = profile && isHttpsUrl(profile.photoURL) ? profile.photoURL : null;
    const displayName = resolveDisplayName(profile, u.displayName);
    const photoURL =
      profile?.customPhoto === true ? (savedPhoto ?? u.photoURL ?? null) : (u.photoURL ?? null);
    // The row read + conditional seed run as ONE transaction (#409): the
    // per-field guards below are only sound against the row state the write
    // actually lands on. Two overlapping joins (a timed-out deal still in
    // flight + its Retry) previously both read "no row" and both wrote —
    // re-stamping `joinedAt` and, worse, racing a guard computed from a stale
    // read (e.g. `reshufflesUsed: 0` over a spend committed in between, which
    // the monotonic rule denies and which then failed the WHOLE join). Under
    // the transaction the loser retries, re-reads the committed row, and its
    // guards degrade it to an identity-only merge with `alreadyJoined` true.
    return await runTransaction(db, async (tx) => {
      const existingPlayer = await tx.get(rawPlayer(u.uid));
      const existing = existingPlayer.exists() ? (existingPlayer.data() as Partial<UserDoc & { joinedAt: number; bingoCount: number; squaresMarked: number; firstBingoAt: number | null; blackout: boolean; reshufflesUsed: number }>) : null;
      const alreadyJoined = existing != null && typeof existing.joinedAt === 'number';
      // Identity always merged; aggregates only for fields not already present, so a
      // racing `dealDayCard` dayStats write is never clobbered back to zero.
      const seed: Record<string, unknown> = { uid: u.uid, displayName, photoURL };
      if (existing?.joinedAt == null) seed.joinedAt = Date.now();
      if (typeof existing?.bingoCount !== 'number') seed.bingoCount = 0;
      if (typeof existing?.squaresMarked !== 'number') seed.squaresMarked = 0;
      if (existing?.firstBingoAt === undefined) seed.firstBingoAt = null;
      if (typeof existing?.blackout !== 'boolean') seed.blackout = false;
      // The cruise-wide Reshuffle allowance (#378), seeded like the aggregates
      // above and guarded the same way: written ONLY when the row does not already
      // carry a number, so a returning Player's real spend is never reset to 0 —
      // which firestore.rules would deny outright (the counter is monotonic), and
      // which would fail the whole join write, not just this field.
      if (typeof existing?.reshufflesUsed !== 'number') seed.reshufflesUsed = 0;
      tx.set(rawPlayer(u.uid), seed, { merge: true });
      return !alreadyJoined; // a genuine first join (no prior identity) is the analytic-worthy event
    });
  }

  const existing = await getDoc(rawBoard(u.uid));
  if (existing.exists()) return false;

  // Denormalize the Player's SAVED identity, not the raw Google one (Codex P2
  // on PR #67, the join-side half): a Player who customized their users/{uid}
  // profile must not get their Google name/avatar re-published into the public
  // players row at join. Prefer the saved displayName, and the saved photoURL
  // only when it is a deliberate custom avatar (customPhoto) — otherwise the
  // profile photo is just a stale copy of the Google one, so the live auth
  // value wins. One extra read, join-path only (returning Players early-return
  // above), fetched alongside the pool; best-effort — a missing or unreadable
  // profile falls back to the auth values rather than blocking the deal.
  const [profileSnap, snap] = await Promise.all([
    getDoc(rawUser(u.uid)).catch(() => null),
    getDocs(query(itemsCol(), where('status', '==', 'active'))),
  ]);
  const profile = profileSnap?.exists() ? (profileSnap.data() as Partial<UserDoc>) : null;
  // Validate before denormalizing (Codex P2 on PR #66 round 3): users/{uid} is
  // self-writable — firestore.rules only shape-checks its attestedAdultAt — so
  // a malformed saved profile must not flow into the public players row (nor
  // fail the join against the rules' shape checks). The saved name is validated
  // by `resolveDisplayName` (real, trimmed-non-empty, within the 100-char cap
  // the rules enforce on every public displayName — markers, moments, proofs),
  // the SAME guard the Tally marker write uses; a saved photo only counts when
  // it is a well-formed https:// URL AND the profile's customPhoto flag is
  // EXACTLY boolean true (round 4: a malformed truthy value like 'false' or 1
  // must not publish the saved photo — the contract is customPhoto: true, and
  // everything else in this doc is untrusted junk). Anything malformed falls
  // back per-field to the auth values, exactly like a missing profile.
  const savedPhoto = profile && isHttpsUrl(profile.photoURL) ? profile.photoURL : null;
  const displayName = resolveDisplayName(profile, u.displayName);
  const photoURL =
    profile?.customPhoto === true ? (savedPhoto ?? u.photoURL ?? null) : (u.photoURL ?? null);

  // The ADR 0004 Phase 0 community auto-hide threshold, read from the event doc so
  // a frozen card is dealt from the SAME pool a Player sees live (useItems): a
  // Prompt whose reportCount has reached a POSITIVE reportHideThreshold is hidden
  // everywhere, so it must never land on a new Player's board (Codex P2, PR #107
  // finding 1). One extra event-doc read, join-path only (returning Players
  // early-return above) and fetched in the SAME Promise.all as the pool + profile,
  // so it adds no latency. A missing/unreadable event doc, or an unset/non-positive
  // threshold, falls open to no filtering via `isReportHidden` — exactly the live
  // pool's behavior.
  // Reuse the `joinEventData` already read up top for the mode decision — no
  // second event round trip.
  const eventData = joinEventData;
  const threshold =
    typeof eventData?.settings?.reportHideThreshold === 'number'
      ? eventData.settings.reportHideThreshold
      : undefined;
  // The Admin ban roster (#108), read from the SAME event-doc fetch as the threshold
  // so the frozen card is dealt from the SAME pool a Player sees live (`useItems`):
  // a Prompt authored by a banned uid is hidden everywhere, so it must never land on
  // a new Player's board. A missing/unreadable event doc, or a malformed value,
  // falls open to no filtering via `isBanned` — exactly the live pool's behavior.
  const bannedUids = Array.isArray(eventData?.bannedUids) ? eventData.bannedUids : [];

  // Filter the active pool by the SAME predicates the live pool uses, AFTER the
  // status==='active' query and the free-space drop. Filtering here (before
  // dealBoard) keeps the MIN_POOL thin-pool guard honest: dealBoard needs >= 24
  // prompts AFTER the community hide AND the ban, so a pool padded past the floor by
  // heavily-reported or banned-author Prompts still fails fast rather than dealing a
  // card that hides squares the moment it renders.
  //
  // `isExplicitWithheld` joins them for the publish race (Phase 4b round 4): an
  // admin's approval write and the Cloud Function that publishes the 18+ posture
  // are two writes with an invocation between them, so a deal landing in that
  // window would otherwise freeze an explicit Prompt onto the card of a Player
  // this Event has not yet asked to acknowledge anything — and a Board freezes on
  // deal, so unlike the live pool that one does not resolve itself when the
  // posture catches up. Reads the module accessor, not the hook: this is not a
  // component, and it wants the posture at deal time.
  const adultRequired = adultContentRequired();
  const pool: DealItem[] = snap.docs
    .map((d) => d.data())
    .filter(
      (it) =>
        !it.isFreeSpace &&
        (it.pool ?? 'main') === 'main' &&
        !isReportHidden(it.reportCount, threshold) &&
        !isExplicitWithheld(it.spicy, adultRequired) &&
        !isBanned(it.createdBy, bannedUids),
    )
    // spicy is coerced to a strict boolean (CodeRabbit, PR #135): a legacy or
    // malformed item doc missing the field, or carrying a truthy non-boolean
    // like the string 'false', must read as tame rather than skew the
    // stratified deal.
    .map((it) => ({ id: it.id, text: it.text, spicy: it.spicy === true }));

  // The target spicy share for stratified composition (w1-seed-and-composition),
  // read defensively from the same already-fetched event doc as `threshold` above
  // — an event doc seeded before this field existed has no key to read, so
  // `dealBoard`'s own default (0.4) applies when it is absent.
  const spicyRatio =
    typeof eventData?.settings?.spicyRatio === 'number' ? eventData.settings.spicyRatio : undefined;

  const seed = seedFromUid(u.uid);
  const cells = dealBoard(pool, FREE_TEXT, seed, spicyRatio ?? 0.4);

  // The create runs as a transaction that RE-CHECKS board existence (#409),
  // mirroring `dealDayCard`: the plain existence probe above is only a fast
  // path (it spares returning Players the pool fetch), so a second joinAndDeal
  // overlapping this one — the timed-out-deal + Retry window — must not also
  // pass it and double-commit. The loser's transaction retries against the
  // winner's committed board, sees it exists, and returns `false` (no re-deal,
  // no `joinedAt` re-stamp, no duplicate `join_event`). The pool/profile reads
  // stay outside: a query cannot run in a transaction, and the deal is
  // deterministic from the uid, so a retry recomputes identical cells.
  return await runTransaction(db, async (tx) => {
    const latestBoard = await tx.get(rawBoard(u.uid));
    if (latestBoard.exists()) return false;
    const now = Date.now();
    // dayIndex: 0 honors the now-required BoardDoc.dayIndex — today there is one
    // Board per Player per Event, read as Day 0; the day-scoped board path is #204.
    tx.set(rawBoard(u.uid), { uid: u.uid, dayIndex: 0, seed, createdAt: now, cells });
    tx.set(
      rawPlayer(u.uid),
      {
        uid: u.uid,
        displayName,
        photoURL,
        joinedAt: now,
        bingoCount: 0,
        squaresMarked: 0,
        firstBingoAt: null,
        blackout: false,
      },
      { merge: true },
    );
    return true; // dealt a NEW board — an actual join
  });
}

/**
 * Deal a Player's Day Card for one Day, lazily, on first open at/after the Day's
 * `unlockAt` (daily-cards-spec § "Unlock mechanics"). The pool is drawn ONLY
 * from that Day's frozen `snapshotItemIds` Day Snapshot — never a live
 * `status: 'active'` query — so a Prompt approved mid-cruise can only "get in"
 * for a Day whose snapshot has not yet been stamped, never an already-dealt one.
 *
 * Returns `true` only when it dealt a NEW Day Card. It is a no-op (`false`) when:
 *   - the Day is still `locked` (`now < unlockAt`),
 *   - the Day is unlocked but its snapshot is not yet stamped (`waking` —
 *     scheduler lag; the client shows the wait state rather than dealing from an
 *     unfrozen pool), or
 *   - a Day Card already exists for this Player+Day (mirrors `joinAndDeal`'s
 *     existing-board early return; re-opening never re-deals).
 */
export async function dealDayCard(u: User, dayIndex: number): Promise<boolean> {
  const [existing, eventSnap] = await Promise.all([
    getDoc(rawDayBoard(dayIndex, u.uid)),
    getDoc(rawEvent()).catch(() => null),
  ]);
  // Existing Day Card → no-op, exactly like joinAndDeal's board-exists guard.
  if (existing.exists()) return false;

  const eventData = eventSnap?.exists() ? (eventSnap.data() as Partial<EventDoc>) : null;
  const days = Array.isArray(eventData?.days) ? (eventData.days as DayDef[]) : [];
  const day = days[dayIndex];
  // No such Day (unmigrated/out-of-range event) → nothing to deal.
  if (!day) return false;

  // The single deal gate (dayDealState): only 'ready' — unlocked AND snapshot
  // stamped — proceeds. 'locked' and 'waking' both return a no-op here; the
  // client renders the matching preview/wait state from the same helper.
  const state = dayDealState({
    unlockAt: day.unlockAt,
    snapshotItemIds: day.snapshotItemIds,
    now: Date.now(),
    hasBoard: false,
  });
  if (state !== 'ready') return false;

  const snapshotIds = day.snapshotItemIds ?? [];

  // Resolve the frozen snapshot ids to their Prompt text/spicy by reading those
  // specific item docs — NOT a live `status: 'active'` collection query. Pool
  // MEMBERSHIP is the snapshot alone; this only hydrates the text/spicy the deal
  // needs. A snapshot id whose doc is missing or is the free space is dropped.
  const itemSnaps = await Promise.all(snapshotIds.map((id) => getDoc(rawItem(id)).catch(() => null)));
  // The Day Snapshot freezes membership, but it must not bypass the same
  // approval→hostname-stamp race guard as the legacy deal. Capture the posture
  // once: false→true while these reads run may withhold extra Prompts for this
  // attempt, which is safe; the server flag is monotone so true cannot lower.
  const adultRequired = adultContentRequired();
  const pool: DealItem[] = itemSnaps
    .filter((s): s is NonNullable<typeof s> => !!s && s.exists())
    .map((s) => ({ id: s.id, data: s.data() as Partial<ItemDoc> }))
    .filter(
      ({ data }) =>
        data.isFreeSpace !== true && !isExplicitWithheld(data.spicy, adultRequired),
    )
    .map(({ id, data }) => ({
      id,
      text: String(data.text ?? ''),
      spicy: data.spicy === true,
      // Carry the pool so a main-day deal can stratify the easy half from main
      // (specs/easy-mix.md). This is a RAW hydration (no itemConverter), so
      // normalize here — the live docs persist the legacy 'embark' spelling
      // (#565; Codex P1 on PR #648) — and `dealBoard` normalizes again at
      // comparison time as defense in depth. Absent → 'main'.
      pool: normalizePool(data.pool),
    }));

  // No repeats across the cruise: exclude every Prompt already on ANY OTHER Day
  // Card this Player holds (daily-cards-spec § "No repeats across the cruise") —
  // NOT just lower indexes. A mid-cruise joiner opens the LATEST unlocked Day
  // first (the Board's default), so an earlier Day can be dealt AFTER a later
  // one; reading only days 0..dayIndex-1 would let that later card's Prompts
  // repeat. `dealBoard`'s exclusion resets on its own once the pool is exhausted,
  // so we always pass the full cross-cruise history.
  // Canonical DayDef.index values, NOT array positions (Phase 4b P1 on #447):
  // day-board paths key on d.index everywhere, so a schedule whose indexes
  // aren't exactly 0..n must not read the wrong sibling docs for the exclusion
  // set or the deal-time achieved set.
  const otherBoardRefs = days
    .map((d) => d.index)
    .filter((i) => i !== dayIndex)
    .map((i) => rawDayBoard(i, u.uid));
  const otherCards = await Promise.all(otherBoardRefs.map((ref) => getDoc(ref).catch(() => null)));
  const excludeIds = new Set<string>();
  const otherCardCells: Cell[][] = [];
  for (const snap of otherCards) {
    if (!snap || !snap.exists()) continue;
    const cells = cellsFromData((snap.data() as { cells?: unknown }).cells);
    otherCardCells.push(cells);
    for (const c of cells) if (c.itemId) excludeIds.add(c.itemId);
  }
  // Echo Marks (specs/echo-marks.md, #446): the preflight reads give the
  // no-repeat exclusion its current card view. The transaction re-reads these
  // refs and derives the achieved set it commits against, so a concurrent unmark
  // cannot leave a permanent stale Echo on a newly dealt card.

  // Tutorial pools (embark/farewell) are seeded all-tame → deal unstratified so
  // no spicy target is forced against an all-tame snapshot. Main days keep the
  // event's stratified spicy share.
  const stratify = day.pool === 'main';
  const spicyRatio =
    typeof eventData?.settings?.spicyRatio === 'number' ? eventData.settings.spicyRatio : 0.4;
  // Easy mix (specs/easy-mix.md): the share of the 24 squares dealt from the embark
  // pool on a main day, read defensively like spicyRatio (default 0.5). Inert unless
  // the Day's snapshot actually carries embark items, so Days 1–3 (main-only
  // snapshots) are untouched; `dealBoard` also ignores it on the unstratified path.
  const easyMixRatio = dayEasyMixRatio(day, eventData);

  // Per-Day seed: mix the Player's stable seed with the Day index so each Day
  // Card has its own deterministic layout rather than repeating Day 0's.
  const seed = (seedFromUid(u.uid) ^ Math.imul(dayIndex + 1, 0x9e3779b1)) >>> 0;
  const cells = dealBoard(pool, day.freeText ?? FREE_TEXT, seed, spicyRatio, {
    excludeIds,
    stratify,
    easyMixRatio,
  });
  const boardRef = rawDayBoard(dayIndex, u.uid);
  const playerRef = rawPlayer(u.uid);
  // The deal-time echo's win transitions, captured OUTSIDE the transaction
  // callback (a retry recomputes them) and acted on only after a successful
  // commit — a card can arrive with echo-completed lines, and those wins route
  // through the existing pending-Moment queue like every echo win. `pinAs`
  // carries the saved player-row name for the Day-honor pin (Codex P2 on
  // #447), resolved inside the transaction where the row was read; null when
  // the pin is gated off (no known identity, or the post-freeze narrowing).
  let dealtEcho: {
    bingoTransition: boolean;
    blackoutTransition: boolean;
    pinAs: string | null;
    at: number;
  } | null = null;
  const dealt = await runTransaction(db, async (tx) => {
    dealtEcho = null;
    const [latestEventSnap, latestBoardSnap, playerSnap, ...latestOtherCardSnaps] = await Promise.all([
      tx.get(rawEvent()),
      tx.get(boardRef),
      tx.get(playerRef),
      ...otherBoardRefs.map((ref) => tx.get(ref)),
    ]);
    if (latestBoardSnap.exists()) return false;

    const latestEventData = latestEventSnap.exists() ? (latestEventSnap.data() as Partial<EventDoc>) : null;
    const latestDays = Array.isArray(latestEventData?.days) ? (latestEventData.days as DayDef[]) : [];
    const latestDay = latestDays[dayIndex];
    if (
      !latestDay ||
      latestDay.unlockAt !== day.unlockAt ||
      latestDay.snapshotEasyMixRatio !== day.snapshotEasyMixRatio ||
      !sameStringArray(latestDay.snapshotItemIds, snapshotIds)
    ) {
      return false;
    }

    const now = Date.now();
    // Echo Marks: pre-mark every dealt Prompt the Player has already achieved
    // (specs/echo-marks.md § Deal-time). `applyEchoes` is idempotent and
    // returns the ORIGINAL cells untouched when nothing echoes, so a Player
    // with no repeated Prompts deals byte-identically to today.
    const achieved = achievedItemIds(
      latestOtherCardSnaps
        .filter((snap) => snap.exists())
        .map((snap) => cellsFromData((snap.data() as { cells?: unknown }).cells)),
    );
    const rawEchoRes = applyEchoes(cells, achieved, now);
    const echoRes = {
      ...rawEchoRes,
      cells: stampEchoAnalyticsTransitions({
        cells: rawEchoRes.cells,
        changed: changedCells(cells, rawEchoRes.cells),
        eventId: EVENT_ID,
        uid: u.uid,
        dayIndex,
        boardSeed: seed,
        trigger: 'deal',
      }),
    };
    tx.set(boardRef, { uid: u.uid, dayIndex, seed, createdAt: now, cells: cellsToMap(echoRes.cells), easyMixRatio });
    if (echoRes.changed) {
      // The echoed card's REAL opening bucket, folded with the cruise root
      // aggregates in the ONE player write this transaction already makes.
      // Post-freeze, a non-ceremonial Day seeds the zeroed bucket instead —
      // the standings are settled and a late deal must not move them (the
      // echoed CELLS still land; the same cells-yes/stats-no narrowing as a
      // post-freeze manual Mark).
      const tutorialSet = tutorialDayIndexSet(latestDays);
      const ceremonialSet = ceremonialDayIndexSet(latestDays);
      const frozen = standingsFrozen({ frozenAt: latestEventData?.frozenAt, days: latestDays });
      const playerData = playerSnap.exists() ? (playerSnap.data() as Partial<PlayerDoc>) : undefined;
      const statsAllowed = !frozen || ceremonialSet.has(dayIndex);
      // The Day-honor pin identity (Codex P2 on #447): the saved player-row
      // name, never the auth value — an unknown identity skips the pin (the
      // honors strip's roster-derived fallback covers it), same gate as
      // Board's own pin path. Narrowed post-freeze like the stats.
      const savedName = typeof playerData?.displayName === 'string' ? playerData.displayName : undefined;
      dealtEcho = {
        bingoTransition: echoRes.bingoTransition,
        blackoutTransition: echoRes.blackoutTransition,
        pinAs: echoRes.bingoTransition && statsAllowed ? honorDisplayName(undefined, savedName) : null,
        at: now,
      };
      if (!statsAllowed) {
        tx.set(
          playerRef,
          { dayStats: { [dayIndex]: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } },
          { merge: true },
        );
      } else {
        const priorDayStats = playerData?.dayStats as DayStats | undefined;
        const write = foldEchoStats({
          priorDayStats,
          echoes: [
            {
              dayIndex,
              bingoCount: echoRes.bingoCount,
              squaresMarked: echoRes.squaresMarked,
              blackout: echoRes.blackout,
            },
          ],
          now,
          isTutorialDay: (i) => tutorialSet.has(i),
          isCeremonialDay: (i) => ceremonialSet.has(i),
          priorBlackout: playerData?.blackout === true,
        });
        if (frozen) {
          // A post-freeze CEREMONIAL deal records its bucket ONLY (Codex P2
          // on #447 round 2): the mark/reconcile paths never move root fields
          // after the freeze — root blackout included — so neither may a
          // farewell card that arrives echo-marked.
          tx.set(playerRef, { dayStats: { [dayIndex]: write.dayStats[dayIndex] } }, { merge: true });
        } else {
          tx.set(playerRef, write, { merge: true });
        }
      }
    } else {
      // Seed this Day's per-Day stat bucket (players/{uid}.dayStats[dayIndex]) so the
      // cruise-wide aggregates and the per-Day breakdown share one shape; the Mark
      // path folds real progress in later.
      tx.set(
        playerRef,
        { dayStats: { [dayIndex]: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } },
        { merge: true },
      );
    }
    return true; // dealt a NEW Day Card
  });
  if (dealt && dealtEcho) {
    const echo = dealtEcho as {
      bingoTransition: boolean;
      blackoutTransition: boolean;
      pinAs: string | null;
      at: number;
    };
    if (echo.bingoTransition || echo.blackoutTransition) {
      enqueueWinMoments({
        uid: u.uid,
        bingoTransition: echo.bingoTransition,
        blackoutTransition: echo.blackoutTransition,
        dayIndex,
      });
    }
    // The write-once Day-honor pin for a card that ARRIVED winning (Codex P2
    // on #447) — fired after the commit so a retried transaction can't pin
    // twice (the create-once rule backstops besides).
    if (echo.pinAs) {
      void pinDayFirstBingo(dayIndex, { uid: u.uid, displayName: echo.pinAs, photoURL: null }, echo.at);
    }
  }
  return dealt;
}

/** The cruise-wide Reshuffle allowance (#378). Mirrors `reshuffleAllowance()` in
 *  firestore.rules — the server is the authority; this is the client's copy for
 *  the chip's remaining count and its pre-flight guard. */
export const RESHUFFLE_ALLOWANCE = 3;

/**
 * The seed for a Reshuffled Day Card. Deterministic — same (uid, Day, spend) →
 * same card — so a reshuffle is reproducible in tests exactly like the first
 * deal, but mixed with `nextUsed` so each successive reshuffle of the same Day
 * draws a DIFFERENT layout rather than re-dealing the card it just replaced
 * (`dealBoard` is a pure function of its seed).
 *
 * `currentSeed` is the escape hatch for the astronomically unlikely collision:
 * an identical seed would deal the identical card AND read as a non-reshuffle to
 * firestore.rules (which discriminates on `seed` changing), so the Player would
 * spend an allowance for the same 24 squares. Nudging until it differs costs
 * nothing and makes "the card always changes" a guarantee rather than a
 * probability.
 */
export function reshuffleSeed(
  uid: string,
  dayIndex: number,
  nextUsed: number,
  currentSeed: number,
): number {
  let seed =
    (seedFromUid(uid) ^
      Math.imul(dayIndex + 1, 0x9e3779b1) ^
      Math.imul(nextUsed + 1, 0x85ebca6b)) >>>
    0;
  while (seed === currentSeed) seed = (seed + 0x9e3779b1) >>> 0;
  return seed;
}

/**
 * Trade a PRISTINE Day Card for a fresh deal from the SAME Day Snapshot (#378,
 * specs/reshuffle.md). Returns the resulting spend (1..3).
 *
 * The whole transaction is two writes: replace the Day's Board doc with a fresh
 * stratified deal, and increment the Player's cruise-wide `reshufflesUsed`.
 * Nothing else — and that is the point of the pristine constraint, not an
 * omission. A card with zero Marks has produced nothing: no Tally entries to
 * retract, no Proofs to pull from the Feed, no Doubts to dissolve, no stats to
 * re-fold, no Moments at risk. So there is deliberately NO cascade code here. A
 * Player who wants out of a card they HAVE marked unmarks it themselves through
 * the existing, tested Mark path (which already removes its Tally entries), which
 * returns the card to pristine — the cascade performed by the player, visibly,
 * through mechanics that already exist.
 *
 * ONLINE-ONLY, unlike every other write in this file — and enforced by
 * `runTransaction`, NOT by the `online` gate on the chip and NOT by awaiting a
 * batch. That distinction is the whole point, and getting it wrong is subtle
 * enough that the first cut of this function did (Codex P1 on #383):
 *
 * `setMark` is deliberately a fire-and-forget `writeBatch` because a batch QUEUES
 * durably offline (ADR 0006) — a Mark made in a ship-wifi dead zone must survive.
 * A reshuffle needs the exact opposite, and a batch cannot give it: offline, the
 * batch is still persisted and applied OPTIMISTICALLY to the local cache while its
 * commit promise merely pends forever. Awaiting it does not prevent the queue; it
 * just never resolves. So the Player would see the replacement card, start marking
 * it, and only later — when the drain hits a server that now denies the write
 * (another tab marked the old card; the Day rolled) — have it rolled back
 * underneath them, with any offline Mark computed against a card that never
 * existed. `navigator.onLine` cannot close that window either: it reports the
 * link, not reachability, and captive ship wifi reads as online (see useOnline).
 *
 * `runTransaction` is the primitive whose failure mode matches the contract: it
 * REQUIRES a server round trip and REJECTS offline rather than buffering, so a
 * reshuffle either lands atomically against fresh server state or fails loudly and
 * changes nothing. Its re-read on contention is a bonus: two tabs racing a
 * reshuffle re-run against the committed counter instead of double-spending, and
 * the rules' `getAfter()` pairing works inside a transaction exactly as in a batch.
 */
export async function reshuffleBoard(params: {
  uid: string;
  dayIndex: number;
  // The `seed` of the card the Player was LOOKING AT when they confirmed. The
  // transaction refuses to deal unless the stored board still carries it, which is
  // what makes a retry re-decide rather than re-fire (Codex P2 on #383): Firestore
  // retries the loser of a concurrent pair, and on retry the board it re-reads is
  // the WINNER's replacement — pristine, and paired with an incremented counter, so
  // every eligibility check passed and a second allowance was silently consumed.
  // Pinning to the confirmed seed turns that retry into a refusal, which is the
  // documented contract ("a concurrent second reshuffle is denied, not merged").
  expectedSeed: number;
}): Promise<number> {
  const { uid, dayIndex, expectedSeed } = params;
  // The Event schedule and the Day Snapshot's items are read outside: neither is
  // written here, and neither changes under a retry, so re-reading them per attempt
  // would cost a round trip and buy nothing. Everything that CAN change — this
  // Board, the counter, and the peer cards the exclusion set is built from — is
  // read inside.
  const eventSnap = await getDoc(rawEvent());
  const eventData = eventSnap.exists() ? (eventSnap.data() as Partial<EventDoc>) : null;
  const days = Array.isArray(eventData?.days) ? (eventData.days as DayDef[]) : [];
  const day = days[dayIndex];
  if (!day) throw new Error('reshuffleBoard: no such Day.');

  // The Day must be OPEN and its Snapshot stamped. `dayDealState` is the one gate
  // the deal path reads, so a reshuffle asks it the same question — with
  // `hasBoard: false` because that flag exists to make an already-dealt Day a
  // no-op, and re-dealing an already-dealt Day is precisely what this does. What
  // we need from it is the locked/waking half: never reroll a locked preview, and
  // never deal from an unfrozen pool.
  const state = dayDealState({
    unlockAt: day.unlockAt,
    snapshotItemIds: day.snapshotItemIds,
    now: Date.now(),
    hasBoard: false,
  });
  if (state !== 'ready') throw new Error(`reshuffleBoard: Day is ${state}.`);

  // Hydrate the SAME frozen Day Snapshot the original deal drew from — never a
  // live `status: 'active'` query. The reshuffled card must come from the same
  // pool everyone else's Day 2 card came from; a Prompt approved since unlock
  // must not be able to sneak onto a rerolled card.
  const snapshotIds = day.snapshotItemIds ?? [];
  const itemSnaps = await Promise.all(
    snapshotIds.map((id) => getDoc(rawItem(id)).catch(() => null)),
  );
  // A reshuffle is another frozen-card publish path. During the asynchronous
  // window between approving the first explicit Prompt and publishing the 18+
  // hostname posture, it must fail closed exactly like the first Day deal.
  const adultRequired = adultContentRequired();
  const pool: DealItem[] = itemSnaps
    .filter((s): s is NonNullable<typeof s> => !!s && s.exists())
    .map((s) => ({ id: s.id, data: s.data() as Partial<ItemDoc> }))
    .filter(
      ({ data }) =>
        data.isFreeSpace !== true && !isExplicitWithheld(data.spicy, adultRequired),
    )
    .map(({ id, data }) => ({
      id,
      text: String(data.text ?? ''),
      spicy: data.spicy === true,
      // Same pool-carrying as the first deal — a reshuffle inherits the easy mix from
      // the same frozen snapshot for free (specs/easy-mix.md). RAW hydration, so
      // normalize the legacy persisted spelling here too (#565).
      pool: normalizePool(data.pool),
    }));

  // The peer cards whose Prompts the replacement must avoid. Their refs are built
  // here; they are READ inside the transaction (below) so a retry rebuilds the
  // exclusion set from committed state.
  // Canonical DayDef.index values, not array positions (Phase 4b P1 on #447)
  // — the same fix as dealDayCard's sibling refs.
  const peerRefs = days
    .map((d) => d.index)
    .filter((i) => i !== dayIndex)
    .map((i) => rawDayBoard(i, uid));

  // Same composition rules as the first deal (daily-cards-spec § "Unlock
  // mechanics"): tutorial pools are all-tame so they deal unstratified; main Days
  // keep the Event's stratified spicy share. A reshuffled card is an ORDINARY card
  // — it must be indistinguishable from one dealt at unlock.
  const stratify = day.pool === 'main';
  const spicyRatio =
    typeof eventData?.settings?.spicyRatio === 'number' ? eventData.settings.spicyRatio : 0.4;
  // Same easy-mix share as the first deal — a reshuffled card must be
  // indistinguishable from one dealt at unlock (specs/easy-mix.md).
  const easyMixRatio = dayEasyMixRatio(day, eventData);

  // Everything contended happens in here, and it REJECTS offline rather than
  // queueing — see the doc comment above for why that failure mode is the feature.
  // Reads before writes (Firestore's transaction contract); eligibility is judged
  // against what the transaction itself read, so a retry re-judges rather than
  // committing a verdict formed against stale state.
  const boardRef = rawDayBoard(dayIndex, uid);
  const playerRef = rawPlayer(uid);
  // The re-deal echo's win transitions (specs/echo-marks.md § Deal-time),
  // captured per attempt and acted on only after the transaction commits.
  // `pinAs` mirrors dealDayCard's Day-honor pin identity (Codex P2 on #447).
  let reshuffleEcho: {
    bingoTransition: boolean;
    blackoutTransition: boolean;
    pinAs: string | null;
    at: number;
  } | null = null;
  const spend = await runTransaction(db, async (tx) => {
    // Firestore can invoke this callback more than once. Do not let a discarded
    // attempt's echo transition escape if a later attempt does not commit.
    reshuffleEcho = null;
    // Every read first (Firestore's transaction contract), and every one of them
    // re-runs on a retry — which is the point: a retry must re-decide from
    // committed state, never re-fire a verdict formed against a snapshot that has
    // since lost a race.
    const [boardSnap, playerSnap, ...peerSnaps] = await Promise.all([
      tx.get(boardRef),
      tx.get(playerRef),
      ...peerRefs.map((ref) => tx.get(ref)),
    ]);

    if (!boardSnap.exists()) throw new Error('reshuffleBoard: no Day Card to reshuffle.');
    const board = boardSnap.data() as {
      cells?: unknown;
      seed?: number;
      easyMixRatio?: number;
    };
    const priorBoardCells = cellsFromData(board.cells);

    // The card must still be the one the Player confirmed. This is what makes a
    // retry a REFUSAL rather than a second spend: when two tabs confirm the same
    // card, Firestore retries the loser against the winner's replacement — which is
    // itself pristine and freshly counted, so every other check below would pass and
    // quietly burn a second allowance.
    if (board.seed !== expectedSeed) {
      throw new Error('reshuffleBoard: the card changed underneath this confirm.');
    }

    // Pristine is the eligibility window. Checked here as well as in the rules
    // because a rules denial reaches the Player as a bare PERMISSION_DENIED — a
    // button that looks broken; this turns the same contract into a refusal the
    // caller can explain. `isPristine` (not `countMarked`) is the predicate the
    // rules mirror — see its doc comment for why a pending Mark is not pristine.
    if (!isPristine(priorBoardCells)) {
      throw new Error('reshuffleBoard: the card is no longer pristine.');
    }

    const player = playerSnap.exists() ? (playerSnap.data() as Partial<PlayerDoc>) : undefined;
    const used = typeof player?.reshufflesUsed === 'number' ? player.reshufflesUsed : 0;
    if (used >= RESHUFFLE_ALLOWANCE) {
      throw new Error('reshuffleBoard: no reshuffles left.');
    }

    // No-repeat exclusion computed from KEPT cards only (the ticket's decision):
    // every OTHER Day Card this Player holds is excluded, but the card being
    // DISCARDED is not — its Prompts return to the eligible pool and may legitimately
    // land on the replacement. Excluding them would be worse than pointless: it would
    // shrink the drawable pool on every reroll and make a "fresh" card systematically
    // avoid 24 perfectly good Prompts the Player never actually played.
    //
    // Built from the transaction's OWN reads (Codex P2 on #383): two tabs
    // reshuffling DIFFERENT Days for the same Player contend on the shared counter,
    // so the loser retries — and a peer set captured before the transaction would
    // still describe the winner's OLD card, letting this deal duplicate Prompts the
    // winner just placed on their new, still-kept one.
    const excludeIds = new Set<string>();
    for (const snap of peerSnaps) {
      if (!snap.exists()) continue;
      const peerCells = cellsFromData((snap.data() as { cells?: unknown }).cells);
      for (const c of peerCells) if (c.itemId) excludeIds.add(c.itemId);
    }

    const nextUsed = used + 1;
    const seed = reshuffleSeed(uid, dayIndex, nextUsed, board.seed ?? 0);
    const boardEasyMixRatio = typeof board.easyMixRatio === 'number' ? board.easyMixRatio : easyMixRatio;
    const cells = dealBoard(pool, day.freeText ?? FREE_TEXT, seed, spicyRatio, {
      excludeIds,
      stratify,
      easyMixRatio: boardEasyMixRatio,
    });

    // Echo Marks (specs/echo-marks.md § Reshuffle): the replacement card
    // re-echoes from the SAME peer reads the exclusion set was built from —
    // the transaction's own, so a retry re-derives from committed state. The
    // discarded card could only carry ECHO Marks (pristine = zero non-echo
    // Marks), so its stat bucket may be non-zero; the replacement's bucket is
    // re-derived from the re-echoed cells so a traded-away echo bingo never
    // survives as a phantom stat. A no-echo reshuffle (empty achieved set,
    // zeroed prior bucket) keeps the exact two-write shape of today.
    const now = Date.now();
    const achieved = achievedItemIds(
      peerSnaps.filter((s) => s.exists()).map((s) => cellsFromData((s.data() as { cells?: unknown }).cells)),
    );
    // Pending claims are not confirmed achievements, so they must not echo onto
    // the replacement card. They are still marked carriers for the shared Tally
    // marker and must keep that marker alive when an echo is traded away.
    const peerMarkedItems = new Set<string>();
    for (const snap of peerSnaps) {
      if (!snap.exists()) continue;
      for (const cell of cellsFromData((snap.data() as { cells?: unknown }).cells)) {
        if (!cell.free && cell.marked && cell.itemId) peerMarkedItems.add(cell.itemId);
      }
    }
    const rawEchoRes = applyEchoes(cells, achieved, now);
    const statsAllowed = !standingsFrozen({ frozenAt: eventData?.frozenAt, days }) ||
      ceremonialDayIndexSet(days).has(dayIndex);
    const savedName = typeof player?.displayName === 'string' ? player.displayName : undefined;
    // Net-new echo count (#721, Codex round 1 finding 4): `echoRes` is derived
    // against the freshly-dealt REPLACEMENT card, so `echoedItemIds` is every
    // Prompt the replacement arrives echoing — including one the DISCARDED
    // card already wore, if the same itemId happens to land on the
    // replacement again (a pristine reshuffleable card can only carry echoes,
    // so `priorBoardCells` is entirely free/unmarked/echoed). That re-applied
    // echo adds nothing to `dayStats[dayIndex].squaresMarked` — the bucket is
    // RE-DERIVED from the replacement's cells, not incremented — so counting
    // it here would break the reconciliation identity (specs/w2-ga4-events.md
    // § Reconciliation): the event would report an echo the bucket never
    // moved for. Report only the ACTUAL increase over what this Day's board
    // already carried marked, floored at zero (a reshuffle can only add
    // echoes back or keep the same count — a pristine card cannot lose a
    // non-echo Mark it never had — but the floor keeps this robust even if
    // that invariant is ever relaxed).
    const priorMarkedCount = countMarked(priorBoardCells);
    const netNewEchoCount = Math.max(0, rawEchoRes.squaresMarked - priorMarkedCount);
    const echoRes = {
      ...rawEchoRes,
      cells: stampEchoAnalyticsTransitions({
        cells: rawEchoRes.cells,
        changed: changedCells(cells, rawEchoRes.cells),
        eventId: EVENT_ID,
        uid,
        dayIndex,
        boardSeed: seed,
        trigger: 'reshuffle',
        limit: netNewEchoCount,
      }),
    };
    reshuffleEcho = echoRes.changed
      ? {
          bingoTransition: echoRes.bingoTransition,
          blackoutTransition: echoRes.blackoutTransition,
          pinAs: echoRes.bingoTransition && statsAllowed ? honorDisplayName(undefined, savedName) : null,
          at: now,
        }
      : null;
    // Orphaned-marker cleanup (Codex P2 on #447): the discarded card can only
    // carry ECHO Marks, and an echo whose SOURCE was since unmarked may be the
    // Prompt's LAST carrier — its single Tally marker was deliberately kept
    // alive by that unmark (the marker-preservation rule) because this echo
    // still stood. Trading the card away removes that last carrier, so the
    // marker must go with it: delete the marker for every discarded echo whose
    // Prompt no peer board still holds confirmed. A Prompt still achieved on a
    // peer keeps its marker (and re-echoes onto the replacement).
    for (const discarded of priorBoardCells) {
      if (
        discarded.echo === true &&
        discarded.marked &&
        !discarded.free &&
        discarded.itemId &&
        !peerMarkedItems.has(discarded.itemId)
      ) {
        tx.delete(doc(db, 'events', EVENT_ID, 'tally', discarded.itemId, 'markers', uid));
      }
    }
    const priorDayStats = player?.dayStats as DayStats | undefined;
    const priorBucket = priorDayStats?.[dayIndex];
    const bucketDirty =
      priorBucket != null &&
      (priorBucket.bingoCount > 0 || priorBucket.squaresMarked > 0 || priorBucket.firstBingoAt != null);
    const tutorialSet = tutorialDayIndexSet(days);
    const ceremonialSet = ceremonialDayIndexSet(days);
    const statWrite =
      (echoRes.changed || bucketDirty) && statsAllowed
        ? foldEchoStats({
            priorDayStats,
            echoes: [
              {
                dayIndex,
                bingoCount: echoRes.bingoCount,
                squaresMarked: echoRes.squaresMarked,
                blackout: echoRes.blackout,
              },
            ],
            now,
            isTutorialDay: (i) => tutorialSet.has(i),
            isCeremonialDay: (i) => ceremonialSet.has(i),
            // Root blackout: preserve one standing on ANOTHER board — unless
            // the DISCARDED card itself stood blackout, in which case the
            // latch would wrongly survive trading away the only blackout.
            // (An echo-only blackout card being reshuffled while a SECOND
            // board also stands blackout drops the flag until that board's
            // next fold re-asserts it — accepted, vanishingly rare.)
            priorBlackout: player?.blackout === true && !isBlackout(priorBoardCells),
          })
        : null;

    // All three writes in the ONE transaction: the rules' `getAfter()` pairing
    // requires the counter write to be present alongside the Board replace, so
    // these can never be split. An explicit counter value, NOT `increment(1)` —
    // the rules assert `after == before + 1` against `before`, and the
    // transaction's re-read is what keeps that value fresh under contention.
    //
    // The per-spend MARKER (#463): rules evaluate each batched document
    // independently, so the +1 alone could vouch for any number of Board
    // replaces in one batch. The server therefore also requires the CREATE of
    // `reshuffles/{uid}-{nextUsed}` naming this Day — the token this spend
    // consumes exactly once. Create-only and immutable server-side; the id is
    // fresh per spend because the counter is monotonic.
    tx.set(doc(db, 'events', EVENT_ID, 'reshuffles', `${uid}-${nextUsed}`), {
      uid,
      n: nextUsed,
      dayIndex,
      createdAt: now,
    });
    tx.set(boardRef, {
      uid,
      dayIndex,
      seed,
      createdAt: now,
      cells: cellsToMap(echoRes.cells),
      easyMixRatio: boardEasyMixRatio,
    });
    // Post-freeze, even a ceremonial Day's re-derive narrows to its bucket
    // (Codex P2 on #447 round 2) — no root field moves once the standings
    // are settled, mirroring the mark/reconcile paths.
    const frozenNarrowed =
      statWrite && standingsFrozen({ frozenAt: eventData?.frozenAt, days })
        ? { dayStats: { [dayIndex]: statWrite.dayStats[dayIndex] } }
        : statWrite;
    tx.set(playerRef, { reshufflesUsed: nextUsed, ...(frozenNarrowed ?? {}) }, { merge: true });
    return nextUsed;
  });
  if (spend > 0 && reshuffleEcho) {
    const echo = reshuffleEcho as {
      bingoTransition: boolean;
      blackoutTransition: boolean;
      pinAs: string | null;
      at: number;
    };
    if (echo.bingoTransition || echo.blackoutTransition) {
      enqueueWinMoments({
        uid,
        bingoTransition: echo.bingoTransition,
        blackoutTransition: echo.blackoutTransition,
        dayIndex,
      });
    }
    if (echo.pinAs) {
      void pinDayFirstBingo(dayIndex, { uid, displayName: echo.pinAs, photoURL: null }, echo.at);
    }
  }
  return spend;
}

/**
 * Fold a single Mark toggle into the next Board cells plus the denormalized
 * Player stats it implies. Pure (no Firestore, no clock) and exported so the
 * write path (`setMark`) and its unit test share one source of truth — and,
 * critically, so the write never needs a server read to compute the next state.
 */
export function computeMark(params: {
  cells: Cell[];
  index: number;
  nextMarked: boolean;
  claimMode: ClaimMode;
  // `undefined` means the caller's first-bingo state is UNKNOWN (the player row
  // has not loaded yet AND nothing is cached); `null` is a KNOWN "no first
  // bingo yet". The two are folded differently below — see the firstBingoAt
  // handling — because stamping `now` over an UNKNOWN prior value can clobber a
  // real, earlier server timestamp (Codex P2, PR #75).
  currentFirstBingoAt: number | null | undefined;
  now: number;
}): {
  cells: Cell[];
  // firstBingoAt is OPTIONAL on purpose: it is omitted from the player payload
  // when the prior value is UNKNOWN, so the `{ merge: true }` write preserves
  // whatever stamp the server already holds instead of overwriting it.
  player: { squaresMarked: number; bingoCount: number; firstBingoAt?: number | null; blackout: boolean };
  bingo: boolean;
  blackout: boolean;
  // The win TRANSITION this mark crossed — the synchronous verdict the Feed
  // Moment broadcast rides (issue #104). `bingo`/`blackout` above are the
  // STANDING state (a bingo/blackout holds NOW); these are the EDGE (this mark
  // newly COMPLETED one). `bingoTransition` is a no-bingo → bingo crossing
  // (`previousBingoCount === 0 && bingoCount > 0`); `blackoutTransition` is a
  // not-blackout → blackout crossing. An unmark can only remove a line, so it
  // never sets either. doMark broadcasts the per-Player bingo/blackout Moment
  // from THESE (not from snapshot diffing), so a broadcast is tied to the mark
  // that caused the win rather than to a component-lifetime edge ref that dies
  // on unmount (the #104 fix). Computed here — inside the folded next-state — so
  // the write path is the single source of truth for "this mark won".
  bingoTransition: boolean;
  blackoutTransition: boolean;
  // The false→true or true→false edge on THIS cell, derived from the SAME
  // freshest cache `runSetMark` folds. It decides whether the client writes a
  // direct-analytics REQUEST token at all; a server trigger still validates
  // the final committed before/after edge, so a stale tab can never turn its
  // cache verdict into an analytics event by itself.
  markTransition: boolean;
} {
  const { cells, index, nextMarked, claimMode, currentFirstBingoAt, now } = params;
  const wasMarked = cells.find((c) => c.index === index)?.marked === true;
  const next: Cell[] = cells.map((c) => {
    if (c.index !== index) return c;
    // A manual toggle STRIPS the Echo flag. Any manual unmark persists an
    // opt-out so a standing sibling Echo cannot restore the Player's choice;
    // manually marking it again clears that opt-out.
    const {
      echo: _echo,
      echoOptOut: _echoOptOut,
      echoAnalyticsId: _echoAnalyticsId,
      echoAnalyticsTrigger: _echoAnalyticsTrigger,
      ...manual
    } = c;
    return {
      ...manual,
      marked: nextMarked,
      markedAt: nextMarked ? now : null,
      status: claimMode === 'admin_confirmed' && nextMarked ? 'pending' : 'confirmed',
      ...(!nextMarked && !c.free && c.itemId !== null ? { echoOptOut: true } : {}),
    };
  });

  const bingoCount = completedLines(next).length;
  const previousBingoCount = completedLines(cells).length;
  const squaresMarked = countMarked(next);
  const blackout = isBlackout(next);

  const player: {
    squaresMarked: number;
    bingoCount: number;
    blackout: boolean;
    firstBingoAt?: number | null;
  } = { squaresMarked, bingoCount, blackout };
  // firstBingoAt is the one denormalized field that depends on prior SERVER
  // state, not purely on `next` — but only in the "bingo was already standing"
  // direction. Clearing is prior-independent: whenever the new state holds NO
  // bingo, firstBingoAt must be null no matter what the server had, so a mark
  // that removes the last bingo always writes the clear — even when the prior
  // value is UNKNOWN (`undefined`: the caller's player row has not loaded and
  // nothing is cached), or a stale stamp would keep crediting a non-winner.
  // A transition from NO bingo to a standing bingo is also prior-independent:
  // the folded board itself proves this is the first current line, so stamp
  // `now` even if the player row is unknown. The only unknown-state write we
  // omit is a further mark while a bingo already stood, where stamping `now`
  // could clobber the server's earlier first-bingo timestamp.
  if (bingoCount === 0) {
    player.firstBingoAt = null;
  } else if (currentFirstBingoAt === undefined && previousBingoCount === 0) {
    player.firstBingoAt = now;
  } else if (currentFirstBingoAt !== undefined) {
    player.firstBingoAt = currentFirstBingoAt ?? now;
  }

  return {
    cells: next,
    player,
    bingo: bingoCount > 0,
    blackout,
    // The rising edges, derived from the SAME folded state (no extra scan of a
    // caller-held snapshot): a bingo transition needs the prior board to hold no
    // line and this fold to hold one; a blackout transition needs the prior
    // board to be not-full and this fold to be full. `nextMarked` need not be
    // checked — an unmark can only reduce the mask, so neither count/mask can
    // rise on it.
    bingoTransition: previousBingoCount === 0 && bingoCount > 0,
    blackoutTransition: blackout && !isBlackout(cells),
    markTransition: wasMarked !== nextMarked,
  };
}

/**
 * Toggle a Square and write the Board + the Player's denormalized stats.
 *
 * Client-authoritative (ADR 0001) and offline-queueable (ADR 0006). Deliberately
 * a plain batched write, NOT a `runTransaction`: a transaction needs a server
 * round-trip and REJECTS while offline, so a Mark made in a ship-wifi dead zone
 * would be dropped instead of queuing durably in the persistent local cache. A
 * Board is single-writer by design — only its owner writes `boards/{uid}` and
 * `players/{uid}` (firestore.rules) — but that does NOT make the caller's
 * render-time `cells` snapshot safe to fold onto blind: two Marks issued in
 * quick succession (two fast taps, or another of the owner's own tabs) fire
 * before the live listener has re-rendered the caller with the first Mark, so
 * both would fold onto the SAME stale `cells` and the second write's full-array
 * replacement would silently clobber the first — no other writer is needed for
 * that race, just the same owner acting twice before their own echo lands.
 * Two mechanisms close it together: `getDocFromCache` — a cache-only read
 * (works offline, no server round trip) that sees this client's own
 * just-applied mutations and, via the shared persistent multi-tab cache,
 * another tab's already-synced ones — folds onto the freshest LOCAL knowledge
 * of the Board (and, for `firstBingoAt`, the Player row) rather than a
 * potentially-stale prop; and the per-board serialization chain below, which
 * keeps OVERLAPPING calls from both reading that cache before either has
 * issued its batch (Codex P1, PR #75). Each
 * falls back to its caller-supplied param only when nothing is cached yet
 * (this write is the first local knowledge of the doc, e.g. a test double
 * with no cache). Both docs go in one `writeBatch` so they queue and apply
 * atomically. A bare Mark writes ONLY these two docs — nothing to the Feed
 * (moments/proofs), per ADR 0002.
 *
 * `commit()` is intentionally not awaited: offline it resolves only on a server
 * ack that may never come in this tab's lifetime, while the write lands in the
 * local cache synchronously (latency compensation) and the live listener
 * reflects it at once — awaiting would stall the Mark on the network. The caller
 * gets the win-detection result synchronously from the local compute.
 */
// Overlapping Marks must not interleave between the cache read and the local
// batch application: Board.toggle fires doMark without awaiting, so two fast
// taps can otherwise BOTH pass getDocFromCache before either commit()'s
// latency compensation applies, folding onto the same cached board and
// clobbering each other exactly like the stale-prop race the cache read
// closed (Codex P1, PR #75). setMark therefore serializes per board: each
// call's read runs only after the previous call has issued its batch.
const markChains = new Map<string, Promise<unknown>>();

function markChainKey(database: Firestore, uid: string): string {
  return `${(database as unknown as { app?: { name?: string } }).app?.name ?? 'default'}/${uid}`;
}

const pendingMarkerRepairs = new Set<string>();
const markerRepairKey = (uid: string, itemId: string) => `${uid}:${itemId}`;
const markerRepairStorageKey = (repairKey: string) => `gcb:echo-marker-repair:${EVENT_ID}:${repairKey}`;

function markerRepairStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function rememberMarkerRepair(repairKey: string): void {
  pendingMarkerRepairs.add(repairKey);
  try {
    markerRepairStore()?.setItem(markerRepairStorageKey(repairKey), '1');
  } catch {
    // Storage is an enhancement over the in-memory candidate (private mode etc.).
  }
}

function forgetMarkerRepair(repairKey: string): void {
  pendingMarkerRepairs.delete(repairKey);
  try {
    markerRepairStore()?.removeItem(markerRepairStorageKey(repairKey));
  } catch {
    // Storage is best-effort; the in-memory candidate is already cleared.
  }
}

function hasMarkerRepair(repairKey: string): boolean {
  if (pendingMarkerRepairs.has(repairKey)) return true;
  try {
    if (markerRepairStore()?.getItem(markerRepairStorageKey(repairKey)) === '1') {
      pendingMarkerRepairs.add(repairKey);
      return true;
    }
  } catch {
    // A disabled store means only this session's candidate can be trusted.
  }
  return false;
}

/** Test-only. */
export function __resetPendingMarkerRepairsForTests(): void {
  for (const repairKey of [...pendingMarkerRepairs]) forgetMarkerRepair(repairKey);
}

// The shared marker-attribution helper (`markerDisplayName`) lives in the
// Firestore-free ./attribution module so proofs.ts can share it without
// pulling this file's firebase/firestore import surface into its tests
// (Codex P2, PR #87 round 2).

export async function setMark(params: {
  uid: string;
  cells: Cell[];
  index: number;
  nextMarked: boolean;
  claimMode: ClaimMode;
  // `undefined` = UNKNOWN (player row still loading, no cache); `null` = a known
  // "no first bingo yet". Board.tsx passes `undefined` while useMyPlayer is
  // loading so a cache-miss Mark can't restamp an earlier server value.
  currentFirstBingoAt: number | null | undefined;
  // The marker's attributed name for the per-Prompt Tally write (ADR 0002).
  // Board.tsx resolves it from the saved player-row identity + auth via
  // `resolveDisplayName` (the SAME validated pattern joinAndDeal uses). Optional
  // so direct callers (the offline durability harness) can omit it and fall back
  // to the cached player row's already-denormalized name — see `markerDisplayName`.
  displayName?: string;
  // The viewed Day the Mark belongs to (#216, #212), stamped onto the Tally
  // marker so the Feed can group markers into a per-`(itemId, dayIndex)` Tally
  // Card, and used to credit the fold to `dayStats[dayIndex]` (daily-cards-spec
  // § "Scoring and social surfaces"). Optional: when omitted, the cached
  // Board's own `dayIndex` is used for the fold, falling back to Day 0 — the
  // single-Board legacy shape — and the Tally marker stays a legacy per-Prompt
  // entry (Square-badge only, no day-scoped Feed card).
  dayIndex?: number;
  // The Event's tutorial (embark/farewell) Day indexes, so the persisted
  // cruise-wide `firstBingoAt` can exclude them (spec § "Resolved decisions" #2).
  // Optional: absent (legacy / no schedule) excludes nothing — the Leaderboard
  // and day-meta surfaces apply the exclusion at render time regardless.
  tutorialDayIndexes?: number[];
  // The CEREMONIAL (farewell) Day indexes (#265): those buckets never enter the
  // summed root totals — the farewell card unlocks at the freeze and its marks
  // must never move the standings, while its per-Day bucket (daily honor) still
  // records. Optional: absent excludes nothing.
  ceremonialDayIndexes?: number[];
  // #265, spec § "Scoring": once the event's `frozenAt` has passed, marks stop
  // moving the standings entirely — the board cells and the Tally marker still
  // write (past Days stay markable all cruise), but the player-stats fold is
  // skipped. Client-side per the ADR 0001 client-authoritative stats model.
  statsFrozen?: boolean;
  // Daily-cards mode gate (#246): when the Event carries a `days[]` schedule the
  // Mark writes the DAY-SCOPED board at events/{eventId}/days/{dayIndex}/boards/{uid}
  // — one board per Player per Day — instead of the single legacy
  // events/{eventId}/boards/{uid}. Absent/false keeps the pre-1.5 single-board
  // path byte-identical, so legacy events (and every mock-Firestore unit test that
  // doesn't set it) are untouched.
  daily?: boolean;
  // The Board seed the caller rendered. Normal Mark writes stamp it as `markSeed`
  // so rules can reject a queued stale Mark after another tab reshuffles the card.
  boardSeed?: number;
  // Echo Marks (specs/echo-marks.md, #446): the Event's full Day-index list, so
  // a Mark that lands CONFIRMED can auto-mark the same Prompt on the Player's
  // sibling Day Cards in the SAME offline-queueable batch (each echoed board
  // write carrying THAT board's own markSeed), with the stat deltas folded into
  // the ONE aggregated player write. Optional and daily-mode-only: absent or
  // empty (legacy events, existing unit tests) leaves the write byte-identical
  // to today. Sibling boards are read from the PERSISTENT CACHE only (the same
  // offline-safe read discipline as the base fold above); a cache-missed
  // sibling simply isn't echoed here — the open-time reconcile self-heals it.
  // Neither is a sibling whose cached seed is not server-confirmed under a
  // live watch (#474, src/data/board-freshness.ts): a stale cached seed
  // stamped as markSeed would have the rules deny that one write and roll
  // back the whole batch, acted Mark included.
  echoDayIndexes?: number[];
  database?: Firestore;
}): Promise<{
  cells: Cell[];
  bingo: boolean;
  blackout: boolean;
  bingoTransition: boolean;
  blackoutTransition: boolean;
  // The local false→true / true→false verdict on the acted cell. It gates
  // whether this write carries a direct-analytics request token; the durable
  // `mark_square`/`unmark_square` record is derived later from server state.
  markTransition: boolean;
  // A committed server acknowledgement for this specific batch. It stays
  // separate from the immediate UI verdict because offline writes must queue
  // without holding the Board interaction open.
  committed: Promise<void>;
}> {
  const { uid } = params;
  const database = params.database ?? db;
  const chainKey = markChainKey(database, uid);
  const prev = markChains.get(chainKey) ?? Promise.resolve();
  const next = prev.then(
    () => runSetMark(params, database),
    () => runSetMark(params, database),
  );
  // The stored tail never rejects, so one failed Mark cannot poison the chain.
  markChains.set(
    chainKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function runSetMark(
  params: {
    uid: string;
    cells: Cell[];
    index: number;
    nextMarked: boolean;
    claimMode: ClaimMode;
    currentFirstBingoAt: number | null | undefined;
    displayName?: string;
    dayIndex?: number;
    tutorialDayIndexes?: number[];
    // #265: ceremonial-bucket exclusion + the standings-freeze gate — see
    // setMark's params above (this inner runner receives them verbatim).
    ceremonialDayIndexes?: number[];
    statsFrozen?: boolean;
    daily?: boolean;
    boardSeed?: number;
    echoDayIndexes?: number[];
  },
  database: Firestore,
): Promise<{
  cells: Cell[];
  bingo: boolean;
  blackout: boolean;
  bingoTransition: boolean;
  blackoutTransition: boolean;
  markTransition: boolean;
  committed: Promise<void>;
}> {
  const { uid } = params;
  // Daily-cards mode (#246): route the Mark to the DAY-SCOPED board
  // events/{eventId}/days/{dayIndex}/boards/{uid} — one board per Player per Day,
  // so each Day's marks fold into their own bucket and can never sum into one
  // (the pre-1.5 single-board double-count). `String(dayIndex)` is the canonical
  // decimal segment the day-scoped firestore.rules gate accepts (#201). In daily
  // mode the caller (Board) always passes the viewed `dayIndex`, so the board path
  // is known up front without reading the cache. Legacy mode is unchanged.
  const boardRef = params.daily === true
    ? doc(database, 'events', EVENT_ID, 'days', String(params.dayIndex ?? 0), 'boards', uid)
    : doc(database, 'events', EVENT_ID, 'boards', uid);
  const playerRef = doc(database, 'events', EVENT_ID, 'players', uid);

  let baseCells = params.cells;
  let markSeed = params.boardSeed;
  let baseFirstBingoAt = params.currentFirstBingoAt;
  // The already-denormalized public name on the player row is the fallback
  // attribution for the Tally marker when the caller omits `displayName`.
  let cachedPlayerName: unknown;
  // The Day this Mark credits (daily-cards-spec § "Scoring and social surfaces"):
  // the caller's explicit `dayIndex`, else the cached Board's own `dayIndex`, else
  // Day 0 (the single-Board legacy shape). And the Player's existing per-Day
  // breakdown, folded onto below so the cruise-wide root aggregate re-derives.
  let dayIndex = params.dayIndex ?? 0;
  let priorDayStats: DayStats | undefined;
  // The prior root `blackout`, preserved through the echo fold (Codex P2 on
  // #447): echoes only add Marks, so a blackout standing on an untouched board
  // must never be stripped by an aggregated write that folds only touched ones.
  let priorRootBlackout = false;
  const [cachedBoard, cachedPlayer] = await Promise.allSettled([
    getDocFromCache(boardRef),
    getDocFromCache(playerRef),
  ]);
  // Nothing cached yet for either doc falls back to the caller-supplied param
  // (e.g. the very first local knowledge of it, or a test double with no
  // cache) — that is the pre-fix behavior, unchanged.
  if (cachedBoard.status === 'fulfilled' && cachedBoard.value.exists()) {
    const boardData = cachedBoard.value.data() as {
      cells: unknown;
      dayIndex?: number;
      seed?: number;
    };
    baseCells = cellsFromData(boardData.cells);
    if (typeof boardData.seed === 'number') {
      markSeed = boardData.seed;
    }
    // The Board's own dayIndex is authoritative for which bucket this Mark
    // credits; the explicit param only seeds the fallback when nothing is cached.
    if (typeof boardData.dayIndex === 'number' && params.dayIndex === undefined) {
      dayIndex = boardData.dayIndex;
    }
  }
  if (cachedPlayer.status === 'fulfilled' && cachedPlayer.value.exists()) {
    // A cached Player row is KNOWN state: the cached value always wins over the
    // caller's prop, and even a row that predates the firstBingoAt field is a
    // known "no first bingo yet" (null), never UNKNOWN. Only a genuine cache
    // MISS (below) leaves baseFirstBingoAt as the caller's param, which may be
    // `undefined` (UNKNOWN) so computeMark omits the field and the server value
    // survives (Codex P2, PR #75).
    const cachedData = cachedPlayer.value.data() as {
      firstBingoAt?: number | null;
      displayName?: unknown;
      dayStats?: DayStats;
      blackout?: boolean;
    };
    baseFirstBingoAt = cachedData.firstBingoAt ?? null;
    cachedPlayerName = cachedData.displayName;
    priorDayStats = cachedData.dayStats;
    priorRootBlackout = cachedData.blackout === true;
  }

  const now = Date.now();
  const computed = computeMark({
    ...params,
    cells: baseCells,
    currentFirstBingoAt: baseFirstBingoAt,
    now,
  });
  const { player, bingo, blackout, bingoTransition, blackoutTransition, markTransition } = computed;
  const cells = computed.cells;
  // This token is deliberately NOT the analytics identity. A Firestore
  // trigger reads the committed board before/after pair and writes the
  // durable event only when the server really observed this cell edge. That
  // means an offline queue survives a reload, while a stale tab's true→true
  // rewrite carries a new request but produces no false second event.
  const analyticsRequestToken = markTransition
    ? directMarkAnalyticsRequest({
        cellIndex: params.index,
        marked: params.nextMarked,
        mode: params.claimMode,
      })
    : undefined;

  const toggled = cells.find((c) => c.index === params.index);
  const echoDayIndexes =
    params.daily === true ? (params.echoDayIndexes ?? []).filter((d) => d !== dayIndex) : [];
  // An unmark can remove the acted board's last blackout while a no-cascade
  // sibling Echo still stands. Preserve the root latch when the local sibling
  // view proves that other board remains blackout.
  let siblingBlackout = false;
  if (!params.nextMarked && priorRootBlackout && echoDayIndexes.length > 0) {
    const siblingSnaps = await Promise.allSettled(
      echoDayIndexes.map((d) =>
        getDocFromCache(doc(database, 'events', EVENT_ID, 'days', String(d), 'boards', uid)),
      ),
    );
    siblingBlackout = siblingSnaps.some(
      (snap) =>
        snap.status === 'fulfilled' &&
        snap.value.exists() &&
        isBlackout(cellsFromData((snap.value.data() as { cells?: unknown }).cells)),
    );
  }

  // Fold this Mark's per-Board result into the Player's per-Day `dayStats` and
  // re-derive the cruise-wide root totals (bingos/squares summed over every Day
  // Card, First to BINGO restricted to main-game Days). `foldDayStat` carries the
  // #75 unknown-state omit through unchanged, so the merge still preserves a
  // server stamp when local state is unknown. For a single Day-0 Board (no other
  // buckets) the aggregate equals that Board's totals — the legacy shape.
  const playerWrite = foldDayStat({
    priorDayStats,
    dayIndex,
    bucket: player,
    blackout: player.blackout || siblingBlackout,
    isTutorialDay: params.tutorialDayIndexes
      ? (i: number) => params.tutorialDayIndexes!.includes(i)
      : undefined,
    isCeremonialDay: params.ceremonialDayIndexes
      ? (i: number) => params.ceremonialDayIndexes!.includes(i)
      : undefined,
  });

  // --- Echo Marks: mark-time propagation (specs/echo-marks.md, #446) --------
  // A Mark that lands CONFIRMED auto-marks the same Prompt on every OTHER Day
  // Card of the Player's that carries it and hasn't been tapped. Sibling boards
  // are read from the PERSISTENT CACHE (the same offline-safe discipline as the
  // base fold above, and serialized with every other Mark by the markChains
  // chain, so overlapping calls can't fold onto stale sibling state); a
  // cache-missed sibling is simply skipped — the open-time reconcile self-heals
  // it — and so is a sibling whose cached seed is not ECHO-TRUSTED (#474, the
  // board-freshness registry check below). Only confirmed Marks echo: an
  // admin_confirmed-mode Mark starts `pending` and echoes from `confirmClaim`
  // instead. Unmarks never cascade.
  const echoItemId =
    params.nextMarked && params.claimMode !== 'admin_confirmed' && toggled && !toggled.free
      ? toggled.itemId
      : null;
  const echoBoards: Array<{
    dayIndex: number;
    /** ONLY the newly echoed cells — the per-cell merge patch (#457). */
    cellsPatch: Record<string, Cell>;
    markSeed: number | undefined;
    bucket: EchoBucket;
    bingoTransition: boolean;
    blackoutTransition: boolean;
  }> = [];
  if (echoItemId && echoDayIndexes.length > 0) {
    const achieved = new Set([echoItemId]);
    const sibSnaps = await Promise.allSettled(
      echoDayIndexes.map((d) =>
        getDocFromCache(doc(database, 'events', EVENT_ID, 'days', String(d), 'boards', uid)),
      ),
    );
    sibSnaps.forEach((snap, i) => {
      if (snap.status !== 'fulfilled' || !snap.value.exists()) return;
      const sib = snap.value.data() as { cells?: unknown; seed?: number };
      const sibDay = echoDayIndexes[i];
      // #474: a cache read carries no freshness metadata, and a sibling
      // reshuffled on ANOTHER device since this device last saw it returns
      // the OLD seed here — stamping it as markSeed would have
      // `seededMarkGuard` deny that ONE write and roll back the WHOLE batch,
      // acted Mark included (the visible-revert incident class). Only echo a
      // sibling whose cached seed a LIVE server-committed snapshot has
      // confirmed (the board-freshness registry, fed by useMyDayBoards);
      // anything else is skipped and the open-time reconcile self-heals it,
      // exactly like a cache-missed sibling.
      const trust = trustedDayBoardSeed(sibDay, uid);
      const sibSeed = typeof sib.seed === 'number' ? sib.seed : undefined;
      if (!trust.trusted || trust.seed !== sibSeed) return;
      const sibCells = cellsFromData(sib.cells);
      const rawRes = applyEchoes(sibCells, achieved, now);
      const res = {
        ...rawRes,
        cells: stampEchoAnalyticsTransitions({
          cells: rawRes.cells,
          changed: changedCells(sibCells, rawRes.cells),
          eventId: EVENT_ID,
          uid,
          dayIndex: sibDay,
          boardSeed: sibSeed,
          trigger: 'mark',
        }),
      };
      if (!res.changed) return;
      echoBoards.push({
        dayIndex: sibDay,
        cellsPatch: cellsPatch(changedCells(sibCells, res.cells)),
        markSeed: sibSeed,
        bucket: {
          dayIndex: sibDay,
          bingoCount: res.bingoCount,
          squaresMarked: res.squaresMarked,
          blackout: res.blackout,
        },
        bingoTransition: res.bingoTransition,
        blackoutTransition: res.blackoutTransition,
      });
    });
  }
  // The batch's player write (specs/echo-marks.md § Scoring, revised by #491):
  // the ACTED day's fold only. The echoed sibling buckets deliberately do NOT
  // ride the batch any more — they were derived from PERSISTENT-CACHE sibling
  // cells, and in the trust-latch window #482 keeps open (offline with the
  // watch still mounted) those cells can be stale, so folding them here would
  // overwrite `dayStats[siblingDay]` — and the re-summed roots — BACKWARDS
  // over another device's committed Marks when the batch drains. Sibling
  // buckets and roots are instead re-derived from SERVER-COMMITTED state after
  // the batch's ack (`reconcileEchoStatsFromServer` below). What the echo case
  // still latches through the batch is the prior root `blackout` (Codex P2 on
  // #447) plus any locally visible echo blackout: a mark only ADDS cells, so
  // the latch can never wrongly hold, and the post-ack reconcile re-derives it
  // from server truth anyway. No echoes → the existing fold, byte-identical to
  // today.
  const aggregatedWrite =
    echoBoards.length > 0
      ? {
          ...playerWrite,
          blackout:
            playerWrite.blackout || priorRootBlackout || echoBoards.some((b) => b.bucket.blackout),
        }
      : playerWrite;

  const batch = writeBatch(database);
  // Per-cell merge (#457): write ONLY the toggled cell, keyed by index, so a
  // concurrent write to any OTHER cell — another device, a queued echo —
  // merges instead of being clobbered by a full-array replacement.
  batch.set(
    boardRef,
    ...cellsMergeSet(cellsPatch(changedCells(baseCells, cells)), {
      ...(typeof markSeed === 'number' ? { markSeed } : {}),
      ...(analyticsRequestToken ? { directAnalyticsRequest: analyticsRequestToken } : {}),
    }),
  );
  // Echoed sibling boards ride the SAME batch, each carrying ITS OWN board's
  // markSeed — the stale-write rules gate (`seededMarkGuard`) is per-board,
  // and reusing the source board's seed would be rejected (specs/echo-marks.md).
  for (const echoBoard of echoBoards) {
    batch.set(
      doc(database, 'events', EVENT_ID, 'days', String(echoBoard.dayIndex), 'boards', uid),
      ...cellsMergeSet(echoBoard.cellsPatch, {
        ...(typeof echoBoard.markSeed === 'number' ? { markSeed: echoBoard.markSeed } : {}),
      }),
    );
  }
  // The standings freeze (#265): post-freeze marks keep the card honest, and
  // ONLY the ceremonial (farewell) Day still records its PER-DAY bucket — the
  // farewell card unlocks AT the freeze and its daily honor reads
  // dayStats[farewell] (Codex P2 on #278 round 1) — while a post-freeze mark
  // on any OTHER Day writes no player stats at all: main-day buckets feed the
  // podium's daily honors and the pins' derived fallback, so letting them
  // drift post-freeze would still move the settled honors (Codex P2 on #278
  // round 2). The ROOT aggregates never move once frozen either way.
  if (params.statsFrozen) {
    // Post-freeze, only ceremonial (farewell) Day buckets may still record —
    // the same narrowing as ever, applied across the aggregated write: echoed
    // main-day buckets are dropped with the root aggregates (the standings are
    // settled), exactly like the acted day's own bucket.
    const ceremonialBuckets: Record<number, StatWrite> = {};
    for (const [k, v] of Object.entries(aggregatedWrite.dayStats)) {
      if (params.ceremonialDayIndexes?.includes(Number(k))) ceremonialBuckets[Number(k)] = v;
    }
    if (Object.keys(ceremonialBuckets).length > 0) {
      batch.set(playerRef, { dayStats: ceremonialBuckets }, { merge: true });
    }
  } else {
    batch.set(playerRef, aggregatedWrite, { merge: true });
  }

  // Per-Prompt Tally (ADR 0002, the embarkation-critical differentiator): every
  // Mark — proofed or not — self-publishes an ATTRIBUTED entry to its Prompt's
  // Tally, in the SAME offline-queueable batch as the board + player writes (never
  // a second unserialized path or a transaction; the whole Mark path is
  // offline-durable by design). The Tally lives in its OWN subcollection, never in
  // the cells array a bare Mark rewrites, and the marker doc id IS the marker uid
  // so firestore.rules keeps a forged attribution out. Marking adds the entry;
  // unmarking deletes exactly that Player's entry, mirroring the cell toggle so the
  // Tally never drifts from the Board. The free centre Square (no itemId) never
  // tallies. A bare Mark still posts NOTHING to the Feed (moments/proofs) — the
  // Tally is a separate surface (ADR 0002).
  const tallyItemId = toggled && !toggled.free ? toggled.itemId : null;
  let markerRepairCandidate: string | null = null;
  if (tallyItemId) {
    const markerRef = doc(database, 'events', EVENT_ID, 'tally', tallyItemId, 'markers', uid);
    if (params.nextMarked) {
      // Day-scoped Tally Cards (#216): stamp the viewed `dayIndex` and the Prompt
      // TEXT onto the marker so the Feed can group markers of the SAME
      // `(itemId, dayIndex)` into one live card and label it without a pool read.
      // Both are ADDITIVE fields the marker create rule already permits (it
      // validates uid/displayName/markedAt, not the full key set), so no
      // firestore.rules change — and the marker path stays the per-Prompt
      // `tally/{itemId}/markers/{uid}`, so the Square badge (`useTally`) and the
      // Doubt `exists()` gate are untouched. The Feed re-sort time is DERIVED
      // (`max(marker.markedAt)`), never a client write to the admin-only parent
      // tally doc. `dayIndex` is omitted (not `undefined`, which Firestore
      // rejects) when the caller has no Day context.
      batch.set(markerRef, {
        uid,
        displayName: markerDisplayName(params.displayName, cachedPlayerName),
        markedAt: now,
        itemText: toggled!.text,
        ...(typeof params.dayIndex === 'number' ? { dayIndex: params.dayIndex } : {}),
      });
      // A normal mark recreates the marker ITSELF, superseding any persisted
      // repair candidate for this Prompt (#454 finding 1): a stale candidate
      // left behind here could later combine with an ADMIN delete's cache
      // tombstone and let the open-time reconcile resurrect a moderated
      // marker. Forgetting is the conservative direction — at worst it costs
      // a repair, never resurrects one wrongly (the same posture as the
      // rejected-commit cleanup below).
      forgetMarkerRepair(markerRepairKey(uid, tallyItemId));
    } else {
      // Echo Marks (specs/echo-marks.md): the marker slot is ONE per
      // (Prompt, Player) — the doc id IS the marker uid, rules-enforced — so
      // deleting it while the Prompt is still CONFIRMED on another of the
      // Player's boards would strip the mark⇒tally invariant (and the Doubt
      // gate's `exists()` target) from every still-standing carrier. Keep the
      // marker while any cached sibling board still holds the Prompt marked —
      // pending claims publish their marker before they can echo — and delete
      // only when this was the last carrier. Sibling state
      // is the cache's view (the same read discipline as the echo pass); an
      // unknowable sibling reads as "no carrier", matching today's delete.
      let stillAchievedElsewhere = false;
      let siblingKnowledgeIncomplete = false;
      if (echoDayIndexes.length > 0) {
        const sibSnaps = await Promise.allSettled(
          echoDayIndexes.map((d) =>
            getDocFromCache(doc(database, 'events', EVENT_ID, 'days', String(d), 'boards', uid)),
          ),
        );
        siblingKnowledgeIncomplete = sibSnaps.some((snap) => snap.status !== 'fulfilled');
        stillAchievedElsewhere = sibSnaps.some(
          (snap) =>
            snap.status === 'fulfilled' &&
            snap.value.exists() &&
            cellsFromData((snap.value.data() as { cells?: unknown }).cells).some(
              (c) => !c.free && c.marked && c.itemId === tallyItemId,
            ),
        );
      }
      if (!stillAchievedElsewhere) {
        batch.delete(markerRef);
        const repairKey = markerRepairKey(uid, tallyItemId);
        if (siblingKnowledgeIncomplete) {
          rememberMarkerRepair(repairKey);
          markerRepairCandidate = repairKey;
        } else {
          forgetMarkerRepair(repairKey);
        }
      }
    }
  }

  const committed = batch.commit();
  // #491: the echoed sibling buckets did not ride the batch (see the
  // aggregated-write comment above) — once the server ACKS the batch (which
  // proves this device is online and every echoed cell is committed), re-derive
  // each echoed Day's bucket and the re-summed roots from SERVER state, the
  // one view that already contains every other device's committed Marks.
  // Fire-and-forget like every post-ack continuation here; a reload that loses
  // it is healed by the stats-lag check in `runReconcileEchoes` on that
  // board's next open.
  if (echoBoards.length > 0) {
    const echoedDayIndexes = echoBoards.map((b) => b.dayIndex);
    void committed
      .then(() =>
        reconcileEchoStatsFromServer({
          uid,
          dayIndexes: echoedDayIndexes,
          tutorialDayIndexes: params.tutorialDayIndexes,
          ceremonialDayIndexes: params.ceremonialDayIndexes,
          statsFrozen: params.statsFrozen,
          database,
        }),
      )
      .catch(() => undefined);
  }
  void committed.catch((err: unknown) => {
    if (markerRepairCandidate) forgetMarkerRepair(markerRepairCandidate);
    // A rejection here is NOT the offline case. Offline, commit() PENDS — it
    // neither resolves nor rejects in this tab's lifetime — while the write sits
    // durably in the persistent cache and drains on reconnect (ADR 0006). So a
    // rejection is always a genuine ONLINE failure: a permission-denied after an
    // auth-state change, or a malformed update the rules reject. Firestore's
    // latency compensation ROLLS BACK the optimistic local write on rejection,
    // so the live onSnapshot listener re-renders the Board without the Mark and
    // the optimistic UI self-corrects on its own. The Mark UX stays
    // client-authoritative (ADR 0001), so we do not surface a retry/toast here —
    // but the failure must not vanish silently (the prior code discarded it), so
    // log it with the Mark context for observability.
    console.error(
      '[setMark] batch.commit() rejected — online write failure; Firestore will roll back the optimistic Mark and the live listener will un-mark the UI',
      { uid, index: params.index, nextMarked: params.nextMarked },
      err,
    );
    // #387: a rejected Mark batch means the player WATCHED their square revert
    // — the exact symptom of the 2026-07-17 rules/stale-bundle skew, which was
    // invisible outside sampled replay console logs. Surface it as a
    // first-class analytics event so the next skew (any rules deploy that
    // tightens the mark-write contract while stale PWA shells linger) shows up
    // in PostHog immediately, queryable and alertable. Dynamic import keeps
    // this Firestore-only module free of an eager analytics/firebase-singleton
    // dependency (test doubles mock ../firebase with only { db, EVENT_ID });
    // both the import and the call are guarded — observability must never
    // throw out of a fire-and-forget commit handler.
    void import('../analytics')
      .then(({ track }) =>
        track('mark_rejected', {
          code: (err as { code?: string } | null)?.code ?? 'unknown',
          index: params.index,
          marked: params.nextMarked,
          dayIndex,
          daily: params.daily === true,
        }),
      )
      .catch(() => {});
  });

  // Echo-caused wins route through the EXISTING pending-Moment queue, keyed to
  // each echoed board's OWN Day: the queue's per-day witness posts a queued win
  // only when that Day's board renders standing, so a wave of auto-wins reaches
  // the Feed through the same gates as any win — never directly from the echo
  // path (specs/echo-marks.md § Moments). The acted board's own transition
  // stays doMark's job, off the returned verdict below, unchanged.
  //
  // An echo bingo also pins its Day's write-once First to BINGO honor (Codex
  // P2 on #447): the stats fold stamps dayStats[d].firstBingoAt, so the
  // create-once meta pin must go to the same win or a LATER manual winner
  // would capture the permanent honor. Identity-gated like Board's own pin
  // path — never stamp 'Anonymous' onto a permanent public honor (the honors
  // strip's roster-derived fallback covers a skipped pin) — and narrowed
  // post-freeze exactly like the stats. The event-level ceremonial
  // First-to-BINGO candidate is deliberately NOT minted from the echo path
  // (spec § Moments — conservative: a ceremony can be lost, never wrongly
  // posted).
  const pinName = honorDisplayName(params.displayName, cachedPlayerName);
  for (const echoBoard of echoBoards) {
    if (echoBoard.bingoTransition || echoBoard.blackoutTransition) {
      // Commit-ack gated like the pin below and the reconcile path (Phase 4b
      // P1 on #447): a batch the rules reject (a stale markSeed)
      // rolls the echo back, and a pre-ack Moment could drain into the Feed
      // for a board state that never committed. Offline the commit pends and
      // the Moment enqueues on reconnect's ack — the acted board's own
      // verdict-driven Moments (doMark) are untouched.
      void committed
        .then(() =>
          enqueueWinMoments({
            uid,
            bingoTransition: echoBoard.bingoTransition,
            blackoutTransition: echoBoard.blackoutTransition,
            dayIndex: echoBoard.dayIndex,
          }),
        )
        .catch(() => undefined);
    }
    if (
      echoBoard.bingoTransition &&
      pinName &&
      (!params.statsFrozen || params.ceremonialDayIndexes?.includes(echoBoard.dayIndex))
    ) {
      // A meta pin is permanent, while a stale sibling markSeed can reject this
      // whole batch. Wait for the board batch's server acknowledgement so a
      // rejected Echo can never keep the honor it appeared to earn locally.
      void committed
        .then(() => pinDayFirstBingo(echoBoard.dayIndex, { uid, displayName: pinName, photoURL: null }, now))
        .catch(() => undefined);
    }
  }

  // The transition verdict rides back to doMark synchronously (from the local
  // fold above, computed BEFORE the fire-and-forget commit), which broadcasts
  // the matching Feed Moment off it — the win is tied to the mark that caused
  // it, not to a Board snapshot-diff that dies on unmount (issue #104).
  return {
    cells,
    bingo,
    blackout,
    bingoTransition,
    blackoutTransition,
    markTransition,
    committed,
  };
}

/**
 * SERVER-DERIVED stat reconcile for echo-touched Days (#491). An echo write is
 * built from PERSISTENT-CACHE cells, and in the trust-latch window #482
 * deliberately keeps open (offline with the watch still mounted) those cells
 * can be stale: another device's Marks on a sibling Day are missing from them,
 * so a batch-time `foldEchoStats` bucket would overwrite `dayStats[d]` — and
 * the re-summed root totals — BACKWARDS in the leaderboard when the batch
 * drains. The cells themselves commute per-cell (#457); the denormalized
 * bucket does not. So no echo batch carries a sibling Day's bucket: after the
 * batch's server acknowledgement (which proves this device is online and the
 * echoed cells are committed), this helper re-reads the player row and each
 * touched board inside ONE Firestore TRANSACTION (server-consistent reads,
 * retried on contention — Codex P1 on #495: plain server reads followed by a
 * detached merge could themselves be overtaken by a write landing between
 * read and write) and commits the buckets and re-summed roots from that
 * server-committed view — a view that already contains every device's
 * committed Marks, so the write can only move stats forward to server truth.
 * A previously unstamped bingo is stamped with the CELLS-derived completion
 * time of the Day's earliest line (`firstLineCompletionAt`), so a delayed
 * offline drain or a reload heal records when the line completed, not when
 * this reconcile ran (Codex P2 on #495).
 *
 * Fail closed: any transaction failure skips the write entirely — a missing
 * bucket merely UNDERSTATES this player until the stats-lag heal in
 * `runReconcileEchoes` catches it on that board's next open, while a
 * stale-derived bucket would regress stats other devices already committed.
 * Post-freeze the standard narrowing applies: only ceremonial Day buckets
 * write, never roots (#265). Returns the committed fold (null when nothing
 * was written) so the reconcile heal can repair a Day honor pin off the
 * freshly committed stamp.
 */
async function reconcileEchoStatsFromServer(params: {
  uid: string;
  /** The echo-touched Days whose buckets to re-derive from server state. */
  dayIndexes: number[];
  tutorialDayIndexes?: number[];
  ceremonialDayIndexes?: number[];
  statsFrozen?: boolean;
  database: Firestore;
}): Promise<{ dayStats: Record<number, StatWrite> } | null> {
  const { uid, database } = params;
  const days = params.statsFrozen
    ? params.dayIndexes.filter((d) => params.ceremonialDayIndexes?.includes(d))
    : params.dayIndexes;
  if (days.length === 0) return null;
  const playerRef = doc(database, 'events', EVENT_ID, 'players', uid);
  return runTransaction(database, async (tx) => {
    const [playerSnap, ...boardSnaps] = await Promise.all([
      tx.get(playerRef),
      ...days.map((d) =>
        tx.get(doc(database, 'events', EVENT_ID, 'days', String(d), 'boards', uid)),
      ),
    ]);
    const playerData = playerSnap.exists() ? (playerSnap.data() as Partial<PlayerDoc>) : undefined;
    const buckets: EchoBucket[] = [];
    boardSnaps.forEach((snap, i) => {
      if (!snap.exists()) return;
      const data = snap.data() as { uid?: string; cells?: unknown };
      if (data.uid !== uid) return;
      const cells = cellsFromData(data.cells);
      buckets.push({
        dayIndex: days[i],
        bingoCount: completedLines(cells).length,
        squaresMarked: countMarked(cells),
        blackout: isBlackout(cells),
        // The stamp for a previously unstamped bingo: when the line COMPLETED
        // per the committed cells, not when this reconcile happens to run.
        bingoAt: firstLineCompletionAt(cells),
      });
    });
    if (buckets.length === 0) return null;
    const write = foldEchoStats({
      priorDayStats: playerData?.dayStats as DayStats | undefined,
      echoes: buckets,
      now: Date.now(),
      isTutorialDay: params.tutorialDayIndexes
        ? (i: number) => params.tutorialDayIndexes!.includes(i)
        : undefined,
      isCeremonialDay: params.ceremonialDayIndexes
        ? (i: number) => params.ceremonialDayIndexes!.includes(i)
        : undefined,
      priorBlackout: playerData?.blackout === true,
    });
    // Post-freeze: ceremonial buckets only, never roots — `days` was already
    // narrowed to ceremonial above, so `write.dayStats` carries nothing else.
    tx.set(playerRef, params.statsFrozen ? { dayStats: write.dayStats } : write, { merge: true });
    return write;
  });
}

/**
 * Open-time echo reconcile (specs/echo-marks.md § Open-time, #446): bring ONE
 * opened Day Board up to date against the Player's achieved set — every Prompt
 * with a confirmed Mark on ANY of their boards — writing any missing echoes.
 * This is the lazy backfill that self-heals pre-feature boards without a
 * migration script and mops up any echo write that was dropped offline.
 *
 * Same discipline as the Mark path, deliberately: every read is CACHE-ONLY
 * (offline-safe; Board calls this only once the opened board and player row
 * are live, so both are cached), the call is SERIALIZED through the same
 * per-player `markChains` chain as `setMark` (an overlapping Mark can't fold
 * onto sibling state this reconcile is mid-way through changing), and the
 * board + aggregated player write ride ONE offline-queueable batch, the
 * echoed board write carrying its own `markSeed`. Echo-caused wins are
 * enqueued into the existing pending-Moment queue under this board's own Day;
 * the board's next snapshot (this batch's own latency-compensated echo) runs
 * Board's standard drain, so nothing posts directly from here. Idempotent: an
 * already-reconciled board is a no-op with zero writes.
 */
export async function reconcileEchoes(params: {
  uid: string;
  /** The opened board's Day — the ONLY board this call writes. */
  dayIndex: number;
  /** The Event's full Day-index list (the sibling boards the achieved set reads). */
  dayIndexes: number[];
  tutorialDayIndexes?: number[];
  ceremonialDayIndexes?: number[];
  statsFrozen?: boolean;
  database?: Firestore;
}): Promise<{ changed: boolean; bingoTransition: boolean; blackoutTransition: boolean; complete: boolean }> {
  const database = params.database ?? db;
  const chainKey = markChainKey(database, params.uid);
  const prev = markChains.get(chainKey) ?? Promise.resolve();
  const next = prev.then(
    () => runReconcileEchoes(params, database),
    () => runReconcileEchoes(params, database),
  );
  markChains.set(
    chainKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function runReconcileEchoes(
  params: {
    uid: string;
    dayIndex: number;
    dayIndexes: number[];
    tutorialDayIndexes?: number[];
    ceremonialDayIndexes?: number[];
    statsFrozen?: boolean;
  },
  database: Firestore,
): Promise<{ changed: boolean; bingoTransition: boolean; blackoutTransition: boolean; complete: boolean }> {
  const { uid, dayIndex } = params;
  const boardRef = doc(database, 'events', EVENT_ID, 'days', String(dayIndex), 'boards', uid);
  const playerRef = doc(database, 'events', EVENT_ID, 'players', uid);
  const siblingDays = params.dayIndexes.filter((d) => d !== dayIndex);
  const [boardSnap, playerSnap, ...sibSnaps] = await Promise.allSettled([
    getDocFromCache(boardRef),
    getDocFromCache(playerRef),
    ...siblingDays.map((d) =>
      getDocFromCache(doc(database, 'events', EVENT_ID, 'days', String(d), 'boards', uid)),
    ),
  ]);
  // COMPLETENESS (Codex P2 on #447): a REJECTED cache read is an unknowable
  // doc — this device may simply never have loaded the sibling that carries
  // the source Mark — so a pass with any rejected read must not count as a
  // settled reconcile. The caller (Board) drops its once-per-board guard on
  // `complete: false` and retries on a later open, when more of the Player's
  // boards may be cached. (A fulfilled exists-false read IS knowledge: the
  // cache holds a tombstone for a board that does not exist.)
  const complete =
    boardSnap.status === 'fulfilled' &&
    playerSnap.status === 'fulfilled' &&
    sibSnaps.every((s) => s.status === 'fulfilled');
  const none = { changed: false, bingoTransition: false, blackoutTransition: false, complete };
  // No cached board to reconcile (or it isn't this Player's) → no-op; the next
  // open retries once the subscription has cached it.
  if (boardSnap.status !== 'fulfilled' || !boardSnap.value.exists()) return { ...none, complete: false };
  const board = boardSnap.value.data() as { uid?: string; cells?: unknown; seed?: number };
  if (board.uid !== uid) return { ...none, complete: false };
  const boardCells = cellsFromData(board.cells);

  const allBoards: Cell[][] = [boardCells];
  for (const snap of sibSnaps) {
    if (snap.status !== 'fulfilled' || !snap.value.exists()) continue;
    allBoards.push(cellsFromData((snap.value.data() as { cells?: unknown }).cells));
  }
  const achieved = achievedItemIds(allBoards);
  const now = Date.now();
  const rawRes = applyEchoes(boardCells, achieved, now);
  const res = {
    ...rawRes,
    cells: stampEchoAnalyticsTransitions({
      cells: rawRes.cells,
      changed: changedCells(boardCells, rawRes.cells),
      eventId: EVENT_ID,
      uid,
      dayIndex,
      boardSeed: board.seed,
      trigger: 'open_reconcile',
    }),
  };

  const cachedPlayerData =
    playerSnap.status === 'fulfilled' && playerSnap.value.exists()
      ? (playerSnap.value.data() as Partial<PlayerDoc>)
      : undefined;

  // Marker self-heal (Codex P2 on #447 round 2): an unmark on a device that
  // could not see a sibling carrier deletes the Prompt's single Tally marker
  // out from under a still-standing echo — and that echo needs its marker back
  // for the mark⇒tally invariant and the Doubt gate. The proof of that wrong
  // delete is a CACHED TOMBSTONE: the deleting device holds the marker as
  // known-absent in its own cache, so when it later opens the sibling (caching
  // the standing confirmed cell), this repair re-creates the marker. Strictly
  // tombstone-gated — a REJECTED marker read (simply not cached, the common
  // case) proves nothing and never writes, so an existing marker's Day can
  // never be moved by a repair.
  // Marked PENDING carriers repair too (#454 finding 2): a pending Claim's
  // marker legitimately exists from pending time (setMark writes it with the
  // pending Mark), so an unknowable-sibling unmark that deleted it must be
  // repairable for the pending cell as well — otherwise the Claim drops out of
  // the public Tally and loses its Doubt target, and confirmation never
  // recreates the marker. Only the free centre and unmarked cells are out.
  const carrierCells = res.cells.filter((c) => !c.free && c.marked && c.itemId);
  const markerReads = await Promise.allSettled(
    carrierCells.map((c) =>
      getDocFromCache(doc(database, 'events', EVENT_ID, 'tally', c.itemId as string, 'markers', uid)),
    ),
  );
  const markerRepairs = carrierCells.filter((c, i) => {
    const read = markerReads[i];
    const repairKey = markerRepairKey(uid, c.itemId as string);
    if (read.status === 'fulfilled' && read.value.exists()) {
      forgetMarkerRepair(repairKey);
      return false;
    }
    return read.status === 'fulfilled' && !read.value.exists() && hasMarkerRepair(repairKey);
  });

  // REPAIR-PIN for an echo win whose ack-gated pin died in a reload (Phase 4b
  // P1 on #447 round 5): an offline echo batch drains durably after a reload,
  // but the in-memory `committed.then(pin)` continuation did not survive to
  // fire. When the opened board STANDS a bingo whose per-Day stamp the server
  // already accepted (`dayStats[d].firstBingoAt` in the cached player row),
  // re-attempt the pin with that stamp — the pin is CREATE-ONCE (cache
  // pre-check + the deny-all update rule), so a pin that already landed makes
  // this a no-op and a later manual winner can never be displaced; a wrong
  // pin cannot be minted because the stamp only exists if the fold committed.
  // The Moment half of that reload loss is NOT re-derived — that would be the
  // snapshot-diff machinery #104 removed; the pending-Moment queue documents
  // reload loss as its accepted, fail-safe residual (specs/w2-feed-moments.md).
  if (!res.bingoTransition && (!params.statsFrozen || params.ceremonialDayIndexes?.includes(dayIndex))) {
    const priorStamp = cachedPlayerData?.dayStats?.[dayIndex]?.firstBingoAt;
    if (typeof priorStamp === 'number' && completedLines(res.cells).length > 0) {
      const pinName = honorDisplayName(undefined, cachedPlayerData?.displayName);
      if (pinName) {
        void pinDayFirstBingo(dayIndex, { uid, displayName: pinName, photoURL: null }, priorStamp).catch(
          () => undefined,
        );
      }
    }
  }

  // #491: the stats-lag heal. This board's `dayStats` bucket can sit BEHIND
  // its own committed cells — an echo batch no longer carries sibling buckets
  // (they are server-derived after the ack, and that in-memory continuation
  // does not survive a reload), so an offline echo that drained across a
  // reload leaves the cells standing with no bucket update. The board's own
  // open is the heal point: when the cache-derived bucket EXCEEDS the cached
  // player row's, re-derive `dayStats[d]` and the roots from server state.
  // Strictly one-directional (exceeds, never merely differs): a derived view
  // BELOW the row only means this device's cache is behind the server, and a
  // write from that view is exactly the regression #491 removes.
  // #496 widens the predicate with a second, ROW-INTERNAL lag signal (see
  // `rootLag` below) for the case where the buckets converged but the roots
  // did not. Both signals route into the SAME server-derived transactional
  // reconcile, so neither can write anything but server truth.
  if (!res.changed) {
    const rowBucket = cachedPlayerData?.dayStats?.[dayIndex];
    // Post-freeze a non-ceremonial Day's bucket never writes again, so its lag
    // can never converge — skip the heal entirely rather than re-reading the
    // server on every open (CodeRabbit on #495).
    const healEligible = !params.statsFrozen || params.ceremonialDayIndexes?.includes(dayIndex) === true;
    const bucketLag =
      healEligible &&
      (res.squaresMarked > (rowBucket?.squaresMarked ?? 0) ||
        res.bingoCount > (rowBucket?.bingoCount ?? 0));
    // #496: the ROOT-total half of the same lag, which the per-Day comparison
    // above cannot see. Compound case (Codex on #495): an offline echo
    // overwrote a cell another device had already marked, so every
    // `dayStats[d]` bucket CONVERGED, while the acted-day batch wrote root
    // totals re-summed from the STALE cached buckets — and the post-ack
    // server-derived transaction that would have fixed the roots died in a
    // reload. Every bucket then matches its board and `bucketLag` never fires,
    // yet the roots stay understated.
    //
    // The tell is ROW-INTERNAL (`playerRowRootLag`, src/game/logic.ts — shared
    // with Board's #506 guard re-arm so the two predicates cannot drift), so it
    // needs no cache-freshness assumption; see the helper for the per-field
    // one-directional rule (Codex P1 on #503) and the dominance requirement.
    // Same ceremonial exclusion (#265) the roots were summed with, so a
    // farewell-Day bucket can never look like root lag. #505 adds the third
    // root dimension the fold rewrites — `firstBingoAt` — with the tutorial
    // exclusion the fold's own root derivation uses, so an understated or
    // missing root stamp heals and a legacy earlier stamp blocks the heal.
    // Post-freeze the reconcile writes ceremonial BUCKETS only, never roots
    // (#265) — a root lag could not converge, so re-reading the server on every
    // open would be pure churn (the same reasoning as `healEligible`).
    const rootLag =
      !params.statsFrozen &&
      playerRowRootLag(
        cachedPlayerData,
        params.ceremonialDayIndexes ? (i: number) => params.ceremonialDayIndexes!.includes(i) : undefined,
        params.tutorialDayIndexes ? (i: number) => params.tutorialDayIndexes!.includes(i) : undefined,
      );
    if (bucketLag || rootLag) {
      try {
        const healed = await reconcileEchoStatsFromServer({
          uid,
          dayIndexes: [dayIndex],
          tutorialDayIndexes: params.tutorialDayIndexes,
          ceremonialDayIndexes: params.ceremonialDayIndexes,
          statsFrozen: params.statsFrozen,
          database,
        });
        // A heal that had to mint the Day's `firstBingoAt` stamp is the lost
        // continuation of an offline echo win whose tab died before the ack —
        // the pin half of that continuation is lost too, and the repair-pin
        // block above ran BEFORE the stamp existed. Re-attempt the create-once
        // pin off the freshly committed stamp (Codex P1 on #495); identity
        // gate and no-op-if-pinned semantics match every other pin path.
        const healedStamp = healed?.dayStats?.[dayIndex]?.firstBingoAt;
        if (typeof healedStamp === 'number') {
          const pinName = honorDisplayName(undefined, cachedPlayerData?.displayName);
          if (pinName) {
            void pinDayFirstBingo(
              dayIndex,
              { uid, displayName: pinName, photoURL: null },
              healedStamp,
            ).catch(() => undefined);
          }
        }
        // Analytics recovery is independent of stats repair: the persisted
        // cell IDs above are replayed on every open, whether or not this pass
        // happened to observe a stale player bucket.
      } catch {
        // Offline again or a transient read failure: the heal must RETRY, so
        // this pass may not settle Board's once-per-board guard (Codex P2 on
        // #495) — report incomplete and let a later open re-run it.
        return { ...none, complete: false };
      }
    }
    if (markerRepairs.length === 0) return none;
  }

  const batch = writeBatch(database);
  if (res.changed) {
    // Per-cell merge (#457): only the newly echoed cells ride the write. The
    // player stats write no longer rides this batch — the bucket and roots are
    // re-derived from SERVER state after the ack (#491, below), so a reconcile
    // fold built over a stale cached player row can never march the leaderboard
    // backwards.
    batch.set(
      boardRef,
      ...cellsMergeSet(cellsPatch(changedCells(boardCells, res.cells)), {
        ...(typeof board.seed === 'number' ? { markSeed: board.seed } : {}),
      }),
    );
  }
  for (const cell of markerRepairs) {
    batch.set(doc(database, 'events', EVENT_ID, 'tally', cell.itemId as string, 'markers', uid), {
      uid,
      displayName: markerDisplayName(undefined, cachedPlayerData?.displayName),
      markedAt: cell.markedAt ?? now,
      itemText: cell.text,
      dayIndex,
    });
  }
  const committed = batch.commit();
  void committed.catch((err: unknown) => {
    // Same posture as setMark: offline PENDS durably (never lands here); a
    // rejection is a genuine online failure, rolled back by latency
    // compensation, and must not vanish silently.
    console.error('[reconcileEchoes] batch.commit() rejected — online write failure', { uid, dayIndex }, err);
  });
  if (res.changed) {
    // #491: bucket + roots from SERVER state once the ack proves the echoed
    // cells committed — same discipline as the mark-time echo path.
    void committed
      .then(() =>
        reconcileEchoStatsFromServer({
          uid,
          dayIndexes: [dayIndex],
          tutorialDayIndexes: params.tutorialDayIndexes,
          ceremonialDayIndexes: params.ceremonialDayIndexes,
          statsFrozen: params.statsFrozen,
          database,
        }),
      )
      .catch(() => undefined);
  }
  if (markerRepairs.length > 0) {
    void committed.then(() => markerRepairs.forEach((cell) => forgetMarkerRepair(markerRepairKey(uid, cell.itemId as string)))).catch(() => undefined);
  }

  if (res.bingoTransition || res.blackoutTransition) {
    // Commit-ack gated, exactly like the day-honor pin below (Phase 4b P1 on
    // #447): a batch the rules reject (a stale markSeed) rolls the
    // echo back, and a Moment enqueued before the ack would let the next board
    // render post a win that never committed. Offline the commit pends and the
    // Moment enqueues on reconnect's ack — the same durability the pin has.
    void committed
      .then(() =>
        enqueueWinMoments({
          uid,
          bingoTransition: res.bingoTransition,
          blackoutTransition: res.blackoutTransition,
          dayIndex,
        }),
      )
      .catch(() => undefined);
  }
  // The write-once Day-honor pin for a reconcile-completed first line (Codex
  // P2 on #447) — same identity gate and post-freeze narrowing as the
  // mark-time echo pin; an unknown identity skips (the roster-derived honors
  // fallback covers it).
  if (res.bingoTransition && (!params.statsFrozen || params.ceremonialDayIndexes?.includes(dayIndex))) {
    const pinName = honorDisplayName(undefined, cachedPlayerData?.displayName);
    if (pinName) {
      void committed
        .then(() =>
          pinDayFirstBingo(
            dayIndex,
            { uid, displayName: pinName, photoURL: null },
            now,
          ),
        )
        .catch(() => undefined);
    }
  }
  return {
    changed: res.changed,
    bingoTransition: res.bingoTransition,
    blackoutTransition: res.blackoutTransition,
    complete,
  };
}

// --- Phase 0 client-side rate limiting (add / report a Prompt, #28) ---
//
// No Cloud Functions exist yet (ADR 0004's Phase 0 posture), so this guard is
// CLIENT-SIDE and PRESENTATIONAL ONLY — it throttles the honest common case
// (a double-tap, a fast re-submit) so the pool doesn't get spammed by an
// enthusiastic or fat-fingered Player. It is trivially bypassable by a
// motivated caller (a second tab, a raw network call) and is NOT a security
// boundary; server-authoritative rate limiting (a Function or rules-enforced
// quota) is a Phase 1 concern — the same deferral ADR 0004 makes for the
// reactive-moderation hide. Module-scope state is fine for a client-only
// guard, same as `markChains` above — `Date.now()` is allowed in app code.
// Keyed by a caller-supplied string (`ItemPool.tsx` keys by
// `${action}:${uid}`) rather than one global bucket, so two different
// signed-in identities sharing a browser never share a throttle window.
export const ITEM_RATE_LIMIT_MS = 3_000;
const lastItemActionAt = new Map<string, number>();

/**
 * True when `key` last succeeded more than `ITEM_RATE_LIMIT_MS` ago (or
 * never) — and, in that case ONLY, stamps `now` as the new last-fired time so
 * a call inside the window is judged against that SAME stamp rather than
 * resetting its own clock (which would let a fast-enough drip of attempts
 * dodge the limit forever). Call once per user action, before the guarded
 * write — see the `addItem`/`reportItem` doc comments below for why the
 * write functions themselves never also call this.
 */
export function checkItemRateLimit(key: string, now: number = Date.now()): boolean {
  const last = lastItemActionAt.get(key);
  if (last !== undefined && now - last < ITEM_RATE_LIMIT_MS) return false;
  lastItemActionAt.set(key, now);
  return true;
}

/**
 * Milliseconds remaining until `key` will next satisfy `checkItemRateLimit`
 * — i.e., until `ITEM_RATE_LIMIT_MS` has elapsed since `key`'s last
 * SUCCESSFUL action — or `0` when there is no wait (no prior success, or the
 * window has already elapsed). Read-only: unlike `checkItemRateLimit`, this
 * never stamps `lastItemActionAt`, so a caller can call it on every blocked
 * attempt without itself consuming or resetting the window.
 *
 * `ItemPool.tsx` calls this the moment a blocked attempt lands, to arm its
 * disabled-timer for the ACTUAL time left rather than re-arming a full
 * `ITEM_RATE_LIMIT_MS` window on every blocked attempt. The guard's own
 * window is anchored to the last SUCCESSFUL call (a blocked call never moves
 * `last` — see above), so a retry late in the window (say, 2.9s into a 3s
 * window) has only ~100ms left; re-arming a full window from THAT retry
 * would keep the control disabled long after `checkItemRateLimit` itself
 * would allow the next attempt (Codex P2, PR #92).
 */
export function itemRateLimitRemainingMs(key: string, now: number = Date.now()): number {
  const last = lastItemActionAt.get(key);
  if (last === undefined) return 0;
  const remaining = ITEM_RATE_LIMIT_MS - (now - last);
  return remaining > 0 ? remaining : 0;
}

/**
 * Add a prompt to the community pool.
 *
 * No rate limit is enforced HERE — the caller (`ItemPool.tsx`) checks
 * `checkItemRateLimit` before invoking this, so the guard lives at the one
 * real call site rather than inside the write itself (checking again in here
 * would consume the SAME window a second time and silently drop the write
 * the caller's own check just approved).
 *
 * `spicy` defaults to `false`: a user-added Prompt is tame unless the ItemPool
 * 🔞 toggle was checked when they submitted it.
 */
export async function addItem(uid: string, text: string, spicy = false): Promise<void> {
  const t = text.trim();
  if (!t) return;
  await addDoc(rawItems(), {
    text: t.slice(0, 80),
    createdBy: uid,
    createdAt: Date.now(),
    isFreeSpace: false,
    // Phase 1.5 approval flow (daily-cards-spec § "Item pools and the approval
    // flow", #210): a main-pool player submission now lands `pending`, invisible
    // everywhere except the Admin Approvals queue and (as "pending review") its
    // own submitter, until an admin approves (→ 'active') or rejects it. Curated
    // pools (embark/farewell) are seeded/edited by admins directly — this path is
    // the main pool's ONLY writer, so it is the only one the gate applies to.
    status: 'pending',
    reportCount: 0,
    spicy,
    // Honor the now-required ItemDoc.pool: a player prompt-submission lands in
    // the main game pool. Embark/farewell pools are seeded directly (#207).
    pool: 'main',
  });
}

/**
 * Report a prompt (increments the report counter; auto-hide handled by
 * admin/threshold). Same rate-limit posture as `addItem` above — throttled by
 * the caller, not in here.
 */
export async function reportItem(id: string): Promise<void> {
  await updateDoc(rawItem(id), { reportCount: increment(1) });
}

/** Let a player set a display theme preference on their player row. */
export async function savePlayerTheme(uid: string, theme: string): Promise<void> {
  await setDoc(rawPlayer(uid), { theme }, { merge: true });
}

/**
 * Clear a player's saved cross-device theme pick (More menu § "Theme" —
 * picking Auto). Without this, `players/{uid}.theme` keeps the last concrete
 * pick, so `ThemeProvider`'s cross-device-adopt effect re-applies it on the
 * next load/device and Auto silently stops following the day (Codex P2 on
 * #232). Deletes the field rather than writing a sentinel so a stale reader
 * never mistakes "explicitly cleared" for a real ThemeId.
 */
export async function clearPlayerTheme(uid: string): Promise<void> {
  await setDoc(rawPlayer(uid), { theme: deleteField() }, { merge: true });
}
