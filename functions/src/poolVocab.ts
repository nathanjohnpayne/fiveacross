/**
 * Pool vocabulary normalization (#565). The canonical Pool ids are `main`,
 * `easy` (the Easy Mix source / a whole easy Day's content) and `closing`
 * (the final Day's card); the pre-rename PERSISTED values are `embark` and
 * `farewell`, and both live Events' docs still carry them (the client coerces
 * on read via `migratePool` in src/data/converters.ts — this is the Functions
 * mirror, kept local so the scheduler stays decoupled from the app package,
 * like `autohide.ts`).
 *
 * Functions read RAW Firestore documents, so every pool comparison in this
 * package must go through `normalizePool` on BOTH sides — the Day's `pool`
 * and each item's `pool` — or a mixed-vocabulary Event (legacy-seeded items
 * plus a post-rename admin-added Prompt, or vice versa) would silently split
 * one pool into two: an easy item missing from a main Day's snapshot, or a
 * closing Day whose freeze never fires.
 */
export type PoolId = 'main' | 'easy' | 'closing';

/**
 * Resolve a persisted pool value to the canonical id. Missing/unknown values
 * resolve to `'main'` — the same default `itemConverter` applies to pre-Phase-
 * 1.5 items, and the fail-safe direction for every consumer here.
 */
export function normalizePool(raw: unknown): PoolId {
  if (raw === 'easy' || raw === 'embark') return 'easy';
  if (raw === 'closing' || raw === 'farewell') return 'closing';
  return 'main';
}
