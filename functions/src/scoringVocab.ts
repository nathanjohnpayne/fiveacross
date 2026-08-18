/**
 * Scoring Policy resolution (ADR 0011) — the Functions mirror of
 * `src/game/scoring.ts`, kept local so the scheduler stays decoupled from the
 * app package exactly like `poolVocab.ts` mirrors `src/game/pool.ts`.
 *
 * Functions read RAW Firestore documents — no `eventConverter` runs on this
 * side — so a Day's Scoring Policy MUST be resolved here rather than assumed
 * present. Legacy Event docs carry no `scoring` key at all, and both live
 * Events are legacy docs.
 *
 * `tests/functions/finale-parity.test.ts` feeds one fixture schedule to this
 * module and to `src/game/scoring.ts` and fails if either side moves alone: a
 * mirror without a parity test is how the podium implementations diverged in
 * the first place.
 */
import { normalizePool } from './poolVocab';

/** Whether a Day's Marks count toward the Event standings. */
export type ScoringPolicy = 'competitive' | 'ceremonial';

/** The shape `scoringForDay` reads — structural and `unknown`-typed, because a
 *  raw Firestore map is exactly as valid an input here as a typed Day. */
export interface ScoringSource {
  scoring?: unknown;
  pool?: unknown;
}

/**
 * Resolve a Day's Scoring Policy. An explicitly stored `'competitive'` or
 * `'ceremonial'` wins; anything else — absent, null, or malformed — falls back
 * to the pool derivation (closing → ceremonial), which is what every scoring
 * path in this package hard-coded before ADR 0011. Byte-identical to
 * `scoringForDay` in `src/game/scoring.ts`, INCLUDING the malformed-value
 * fallback direction: a malformed value must not be read as ceremonial, which
 * would drop a competitive Day's real play out of the standings.
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
