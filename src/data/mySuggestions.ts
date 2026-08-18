/**
 * A submitter's own view of THEIR Community Prompts (#559): the local,
 * per-device tracker of suggestions made from this browser, merged against
 * the live pending/active queries to answer "pending / scheduled / approved
 * / not selected".
 *
 * Why local tracking at all, rather than one authoritative read: a REJECTED
 * item is unreadable by its own submitter — `firestore.rules`' item read
 * rule carves out `status == 'pending'` only, deliberately not `pending ||
 * rejected` (specs/community-prompt-targeting.md, and pinned by
 * tests/rules/community-prompt-targeting.test.ts's "a rejected row hidden
 * from its own submitter"). So "not selected" can never come from reading
 * the row — it can only be INFERRED, by a submission this device already
 * knows about disappearing from both the live pending query and the live
 * active pool. `localStorage`, `gcb.*`-namespaced and fail-open on a storage
 * error, mirrors the established one-device-memory pattern (NoticeBanner's
 * dismissal key, ItemPool's `explicitTagSeenKey`).
 *
 * Scoped deliberately to THIS device: a submission made elsewhere (another
 * browser, a cleared localStorage) never enters this tracker, but its
 * `pending` state is still visible everywhere via the live query — this
 * module only adds the FOLLOW-UP (did it get scheduled / approved / turned
 * down), which is honest to lose on a device the player never checks back
 * on.
 */
import type { ItemDoc } from '../types';
import { isDayTargetable, submitterStatus, type SubmitterStatus, type TargetableDay } from './communityPrompts';

export interface TrackedSuggestion {
  id: string;
  text: string;
  submittedAt: number;
  // The last status/target THIS device actually observed the submission
  // hold — 'pending' is never stored here, only a genuinely resolved
  // ('scheduled' | 'approved') state (#559, Codex P2, PR #845 round 7). See
  // `deriveMySubmissions`'s doc comment for why this exists: without it, two
  // DIFFERENT gaps both misreport as `'not_selected'` — a submission
  // transiently missing from both live queries between the pending listener
  // dropping it and the active listener picking it up (an admin approving
  // while the panel is open), and a submission an admin later hard-hides
  // AFTER approval (`hideItem`, which is unreadable to the submitter same as
  // a rejection, but is not one). Once observed active, the submission keeps
  // reporting its last-known state instead of flashing/settling into
  // "not selected" for either reason.
  lastKnownStatus?: SubmitterStatus;
  lastKnownDayIndex?: number;
}

/** Cap on locally-tracked submissions per Player per Event — plenty for the
 *  "did my recent suggestions land" question this tracker exists to answer,
 *  and keeps the key from growing without bound on a long-running device. */
const TRACKED_LIMIT = 20;

function storageKey(eventId: string, uid: string): string {
  return `gcb.mySuggestions.${eventId}.${uid}`;
}

function isTrackedSuggestion(v: unknown): v is TrackedSuggestion {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { text?: unknown }).text === 'string' &&
    typeof (v as { submittedAt?: unknown }).submittedAt === 'number'
  );
}

/** This device's tracked suggestions for `uid` on `eventId`, oldest first.
 *  try/catch falls OPEN to an empty list (private mode / storage
 *  unavailable) — the same posture NoticeBanner's dismissal read takes,
 *  never a thrown error blocking the Prompts panel from rendering. */
export function loadTrackedSuggestions(eventId: string, uid: string): TrackedSuggestion[] {
  try {
    const raw = localStorage.getItem(storageKey(eventId, uid));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTrackedSuggestion) : [];
  } catch {
    return [];
  }
}

/** Record a fresh submission from THIS device. Idempotent on `id` (a retried
 *  call — e.g. React StrictMode's double-invoke — never duplicates the
 *  entry); silently drops on a storage error, same fallback as the read. */
export function trackSuggestion(eventId: string, uid: string, suggestion: TrackedSuggestion): void {
  try {
    const existing = loadTrackedSuggestions(eventId, uid).filter((s) => s.id !== suggestion.id);
    const next = [...existing, suggestion].slice(-TRACKED_LIMIT);
    localStorage.setItem(storageKey(eventId, uid), JSON.stringify(next));
  } catch {
    /* nothing to persist */
  }
}

export type MySubmissionStatus = SubmitterStatus | 'not_selected';

export interface MySubmissionView {
  id: string;
  text: string;
  submittedAt: number;
  status: MySubmissionStatus;
  dayIndex?: number;
}

/**
 * Merge this device's tracked submissions with the two live queries a
 * submitter can actually read (`pendingMine`, `activeMine` — both already
 * scoped to `createdBy === uid` by the caller) into one state per
 * submission, oldest first.
 *
 * `pendingMine` is the union source for `'pending'`, not just the tracked
 * set: it is a live, cross-device, authoritative query, so a pending
 * submission made on ANOTHER device still shows up here exactly as it does
 * today (this module only ADDS the local follow-up, never narrows the
 * existing pending visibility). A tracked id absent from BOTH queries is the
 * one case this module exists for — `'not_selected'`, inferred rather than
 * read.
 *
 * `ready` gates that inference (Codex P2, PR #845): the two live queries do
 * not resolve their FIRST snapshot in lockstep — a cold load, an offline
 * cache, or `useMyPendingItems` simply finishing after `useItems` all leave
 * one query's result incomplete while the other has already settled. Reading
 * absence from an INCOMPLETE pair would flash a still-pending (or still-
 * loading) submission as `'not_selected'`. While `ready` is false, a tracked
 * id resolved by neither query is OMITTED from the result entirely — never
 * defaulted to a guessed state — and reappears correctly once both queries
 * have delivered their first snapshot.
 *
 * Once `ready`, absence from BOTH queries still isn't automatically
 * `'not_selected'` (Codex P2, PR #845 round 7): two DIFFERENT gaps can put a
 * genuinely-approved submission there too. (1) `pendingMine`/`activeMine`
 * are independent listeners — if an admin approves while this panel is
 * open, the pending-removal snapshot can land before the active-addition
 * one, leaving the id in NEITHER query for one transient render. (2) an
 * admin can hard-hide an ALREADY-approved Prompt (`hideItem`) later, which
 * leaves the `status == 'active'` query permanently — hidden is unreadable
 * to the submitter same as rejected, but is a different fact. Falling back
 * to `t.lastKnownStatus` (set by `refreshLastKnownStatuses` below, once this
 * device has actually SEEN the submission active) turns both gaps into
 * "still shows its last known state" instead of a false demotion — case (1)
 * self-heals on the next snapshot; case (2) has no way to distinguish from
 * the client at all, and "still approved" is the honest last-known fact.
 * Only a submission NEVER observed active falls all the way to
 * `'not_selected'`.
 *
 * Two more gaps in that fallback, both Codex P2, PR #845 round 8:
 *
 * (a) The FIRST-time version of the round-7 race (above) — an admin
 * approving a submission this device has NEVER before seen active has no
 * `lastKnownStatus` to fall back to at all, so the same one-render overlap
 * (pending-removal landing before active-addition) still reads as
 * `'not_selected'` for a submission that is about to resolve. `graceIds`
 * (the caller's own one-render memory of "this id just vacated the pending
 * query and has not yet shown up active" — see `ItemPool.tsx`) reports
 * `'pending'` for exactly that window instead of guessing; a genuine
 * rejection has no active snapshot ever arriving, so the caller's grace
 * naturally expires on the next unrelated render and this still resolves to
 * `'not_selected'` — it only smooths the transient overlap, never suppresses
 * a real rejection indefinitely.
 *
 * (b) A cached `'scheduled'` fallback is a promise about a SPECIFIC Day,
 * true only while that Day is still targetable — the same rule
 * `submitterStatus` itself enforces for a live row. A submission observed
 * scheduled and then hard-hidden BEFORE its Day's cutoff would otherwise
 * replay that cached label forever, since a hidden row can never be
 * re-observed to naturally correct it. Re-deriving the fallback against the
 * CURRENT `days`/`now` (not just replaying the cached label verbatim) keeps
 * the promise honest: once the named Day stops being targetable, the
 * fallback downgrades to `'approved'` — still-approved is the honest
 * last-known fact, exactly as a live `submitterStatus` read would report for
 * any other Day-cutoff-passed row.
 */
export function deriveMySubmissions(
  tracked: readonly TrackedSuggestion[],
  pendingMine: readonly ItemDoc[],
  activeMine: readonly ItemDoc[],
  days: readonly TargetableDay[],
  now: number,
  ready: boolean,
  graceIds: ReadonlySet<string> = new Set(),
): MySubmissionView[] {
  const seen = new Set<string>();
  const views: MySubmissionView[] = [];

  for (const it of pendingMine) {
    seen.add(it.id);
    views.push({ id: it.id, text: it.text, submittedAt: it.createdAt, status: 'pending' });
  }

  for (const t of tracked) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const active = activeMine.find((it) => it.id === t.id);
    if (!active && !ready) continue;
    if (!active && graceIds.has(t.id)) {
      views.push({ id: t.id, text: t.text, submittedAt: t.submittedAt, status: 'pending' });
      continue;
    }
    let fallbackStatus: MySubmissionStatus = t.lastKnownStatus ?? 'not_selected';
    let fallbackDayIndex = t.lastKnownDayIndex;
    if (!active && fallbackStatus === 'scheduled') {
      const day = typeof fallbackDayIndex === 'number' ? days.find((d) => d.index === fallbackDayIndex) : undefined;
      if (!day || !isDayTargetable(day, now)) {
        fallbackStatus = 'approved';
        fallbackDayIndex = undefined;
      }
    }
    views.push({
      id: t.id,
      // The authoritative text once approved (Codex P2, PR #845): an admin
      // may edit a submission's wording before or after approval, and the
      // active document carries whatever text will actually be dealt — the
      // locally tracked original is a fallback ONLY for the unreadable
      // (not-selected) case, where no authoritative copy is available at all.
      text: active ? active.text : t.text,
      submittedAt: t.submittedAt,
      status: active ? submitterStatus(active, days, now) : fallbackStatus,
      dayIndex: active
        ? typeof active.targetDayIndex === 'number'
          ? active.targetDayIndex
          : undefined
        : fallbackDayIndex,
    });
  }

  return views.sort((a, b) => a.submittedAt - b.submittedAt);
}

/**
 * Refresh each tracked entry's `lastKnownStatus`/`lastKnownDayIndex` from the
 * CURRENT `activeMine` query, for the caller to persist (`trackSuggestion`)
 * whenever an entry actually changes. Deliberately does nothing for an entry
 * NOT currently found in `activeMine` — a transiently-absent or
 * genuinely-hidden entry keeps whatever it last recorded, which is the whole
 * point (see `deriveMySubmissions`'s doc comment). Returns the SAME array
 * reference when nothing changed, so a caller can cheaply skip persisting
 * with a straight `!==` check.
 */
export function refreshLastKnownStatuses(
  tracked: readonly TrackedSuggestion[],
  activeMine: readonly ItemDoc[],
  days: readonly TargetableDay[],
  now: number,
): readonly TrackedSuggestion[] {
  let changed = false;
  const next = tracked.map((t) => {
    const active = activeMine.find((it) => it.id === t.id);
    if (!active) return t;
    const status = submitterStatus(active, days, now);
    const dayIndex = typeof active.targetDayIndex === 'number' ? active.targetDayIndex : undefined;
    if (t.lastKnownStatus === status && t.lastKnownDayIndex === dayIndex) return t;
    changed = true;
    return { ...t, lastKnownStatus: status, lastKnownDayIndex: dayIndex };
  });
  return changed ? next : tracked;
}
