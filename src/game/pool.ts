/**
 * Pool vocabulary normalization (#565) — the app-side single source for
 * resolving a persisted pool value to the canonical id. The canonical Pool ids
 * are `main`, `easy` (the Easy Mix source / a whole easy Day's content) and
 * `closing` (the final Day's card); the pre-rename PERSISTED values are
 * `embark` and `farewell`, and BOTH live Events' docs still carry them.
 *
 * `itemConverter` / `eventConverter` coerce on read (`migratePool` in
 * src/data/converters.ts delegates here), but several data paths deliberately
 * hydrate RAW documents — the snapshot deal/reshuffle item reads, the admin
 * claim-resolution transaction's event re-read (Codex P1/P2 on PR #648) — so
 * the pool-sensitive helpers in src/game must ALSO normalize at comparison
 * time rather than trusting their input's vocabulary. Same posture as the
 * Functions mirror (`functions/src/poolVocab.ts`, kept separate because the
 * two packages are deliberately decoupled).
 */
export type PoolId = 'main' | 'easy' | 'closing';

/**
 * Resolve a persisted pool value to the canonical id. Missing/unknown values
 * resolve to `'main'` — the default pre-Phase-1.5 items have always read as,
 * and the fail-safe direction for every consumer.
 */
export function normalizePool(raw: unknown): PoolId {
  if (raw === 'easy' || raw === 'embark') return 'easy';
  if (raw === 'closing' || raw === 'farewell') return 'closing';
  return 'main';
}
