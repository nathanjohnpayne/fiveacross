/**
 * Scoring Policy resolution (ADR 0011) — the app-side single source for
 * answering "do this Day's Marks move the standings?".
 *
 * A Day's **Pool identity** (which Prompts it deals), its **Tutorial framing**
 * (whether it is eligible for the Event-wide First to BINGO) and its **Scoring
 * Policy** are three independent facts. `d15-finale` originally tied all three
 * together — the closing pool meant the card was ceremonial, and the freeze
 * fired at that Day's `unlockAt`. That holds for a ten-day cruise whose last
 * card opens on the morning everyone goes home, and breaks immediately for a
 * weekend Event whose final morning is real competitive play ending at
 * check-out. So the policy is now STATED on the Day.
 *
 * Legacy Event docs carry no `scoring` key, so it is DERIVED from pool on read:
 * the closing pool means ceremonial, everything else competitive. That is
 * exactly the rule the old `pool === 'closing'` comparisons implemented, so
 * both live Events read byte-identically and no data migration is needed.
 *
 * Kept beside `normalizePool` (src/game/pool.ts) and used the same way: several
 * data paths deliberately hydrate RAW documents — the snapshot deal/reshuffle
 * item reads, the admin claim-resolution transaction's event re-read — so
 * scoring-sensitive helpers must resolve at COMPARISON time rather than trust
 * that their input came through `eventConverter`. `functions/src/scoringVocab.ts`
 * is the deliberately-decoupled Functions mirror, pinned by
 * `tests/functions/finale-parity.test.ts`.
 */
import { normalizePool } from './pool';

/** Whether a Day's Marks count toward the Event standings (CONTEXT.md §
 *  Scoring Policy). `ceremonial` Days still keep their own daily honour — the
 *  exclusion applies to the summed root totals and the podium, never to the
 *  per-Day bucket. */
export type ScoringPolicy = 'competitive' | 'ceremonial';

/** The shape `scoringForDay` reads. Deliberately structural and `unknown`-typed:
 *  callers pass a converter-resolved `DayDef`, a raw Firestore map, or a test
 *  fixture, and all three must resolve the same way. */
export interface ScoringSource {
  scoring?: unknown;
  pool?: unknown;
}

/**
 * Resolve a Day's Scoring Policy. An explicitly stored `'competitive'` or
 * `'ceremonial'` wins; anything else — absent (every doc written before ADR
 * 0011), null, or a malformed value — falls back to the pool derivation the
 * old `pool === 'closing'` comparisons hard-coded.
 *
 * A malformed stored value falls back rather than failing closed on purpose:
 * "ceremonial" is the standings-INERT state, so treating an unreadable value as
 * ceremonial would silently drop a competitive Day's real play out of the
 * standings. The pool derivation is a known-good answer for every Event that
 * exists today, which is a better floor than either constant.
 */
export function scoringForDay(day: ScoringSource | null | undefined): ScoringPolicy {
  const raw = day?.scoring;
  if (raw === 'competitive' || raw === 'ceremonial') return raw;
  return normalizePool(day?.pool) === 'closing' ? 'ceremonial' : 'competitive';
}

/** True when this Day's Marks never move the standings. */
export function isCeremonialDay(day: ScoringSource | null | undefined): boolean {
  return scoringForDay(day) === 'ceremonial';
}
