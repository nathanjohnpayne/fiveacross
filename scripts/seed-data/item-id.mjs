// Deterministic Prompt doc id (content hash of the text only) so re-running a
// seed upserts the same prompt docs instead of creating duplicates (boards
// sample distinct ids, so dupes would surface the same prompt on multiple
// squares). Shared by every per-Event seed module and by scripts/seed.mjs —
// the id IS the cross-run identity of a seeded Prompt, so it lives in exactly
// one place.
import { createHash } from 'node:crypto';

export function seedItemDocId(text) {
  return `seed-${createHash('sha1').update(text).digest('hex').slice(0, 20)}`;
}
