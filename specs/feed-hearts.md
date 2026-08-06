---
spec_id: feed-hearts
status: accepted
---

# Feed hearts: Instagram-style likes on Proofs and Moments (`feed-hearts`)

A Player hearts posts in the Feed—many posts, each post only once—with a Lucide heart that pops like Instagram's and a count that ticks as it moves. Guarded by `src/components/feed-hearts.test.tsx` (derivation, HeartButton contract, CSS pins) and `tests/rules/feed-hearts.test.ts` (the write gate).

## Glossary

**Heart**—one Player's like on a Feed post. A reaction, never evidence and never score: hearts touch no stats, no leaderboard, no win logic (ADR 0001 untouched). *Avoid:* like (the UI verb is heart), favorite, reaction (reserved—a future multi-emoji system would be a different thing).

**Post**—a Proof or a Moment card in the Feed. Tally Cards are derived aggregates keyed by (Prompt, Day), not documents, and take no hearts.

## Data model

One flat collection, `events/{eventId}/hearts/{heartId}`, mirroring doubts/moments. `HeartDoc` (src/types.ts): `uid`, `targetKind` (`'proof' | 'moment'`), `targetId`, `targetCreatedAt`, `createdAt`—exactly these five fields; no display name is denormalized (nothing to misattribute, so the write needs no identityKnown gate).

**The slot id IS the once-only guarantee.** `heartId = ${uid}_${targetKind}_${targetId}` (`heartDocId`, src/data/hearts.ts)—the Doubt slot's shape. The rules bind the id to the payload (no squatting another Player's slot), so one Player can never hold more than one doc per post and counts cannot inflate no matter how writes race. Because the SLOT—not an update denial—carries the guarantee, the owner may create **and overwrite** their own slot under the same full validation; a foreign update is structurally impossible (the slot id embeds the owner's uid, the writer's payload uid must equal their own). Toggle = create to heart, owner-delete to unheart; re-heart is a fresh create (or overwrite) at the same slot.

**`targetCreatedAt` is the incarnation stamp** (Codex P2 on #425). Moment ids are deterministic and a deleted Moment can be recreated at the same id, so a Heart binds to the specific document it was given to: the rules `get()` the declared target and require its live `createdAt` to equal the Heart's stamp (a phantom id fails the read outright—no hearts against garbage), and the display filters by it, so a recreated post starts at zero hearts and a stranded heart can never resurface on a lookalike. The owner-overwrite above is the re-bind path: the viewer's stale slot reads unhearted on the new incarnation, and their next tap overwrites it with the fresh stamp in place.

Writes additionally require: own `uid`, `keys().hasOnly` the five contract fields, a known `targetKind`, and `createdAt` in the shared +60s/−24h clock window. Read is signed-in public. Admin delete is the moderation lever (delete, never edit—no admin update exists).

## Reads and derivation

ONE flat subscription (`useAllHearts`, src/hooks/useData.ts) feeds the whole Feed, mirroring `useAllDoubts`; per-card state is the pure `heartState(hearts, kind, id, targetCreatedAt, viewerUid, bannedUids)` → `{ count, hearted }`, incarnation-scoped as above. Ban semantics: a banned Player's hearts vanish from everyone else's counts, but their OWN heart stays visible to themselves—the own-content exception, load-bearing so a banned viewer's button reads true and their retap doesn't silently re-assert the same slot forever.

Writes are fire-and-forget (`setHeart`) and carry the INTENDED state, never a re-derived one: HeartButton keeps a per-tap optimistic override (`pending`), so a quick double tap before the first latency-compensated echo alternates off the SHOWN state—create then delete, matching the user's final intent—instead of both taps reusing the same stale prop (Codex P2 on #425). The override yields the moment the underlying prop next moves: the echo confirming it, or a rules rollback reverting it (the button honestly snaps back). Offline both legs queue durably (ADR 0006). Analytics (`heart_post`, params `targetKind`/`on`) fires only once the write persists—the `demand_proof` posture.

## UI and motion

`HeartButton` (src/components/ProofFeed.tsx) renders on every Proof and Moment card: an outline Lucide heart (30px control, 44px overlay tap target) that fills with the Theme's `--primary` when hearted, count beside it (hidden at zero), `aria-pressed` carrying state and the count labeled once ("N hearts"), never per-digit.

Motion (index.css § "feed hearts", inside the motion-polish vocabulary and covered by its universal reduced-motion kill switch):

- **`heart-pop`**—the like burst: the icon squeezes then slams back with `--ease-pop`, Instagram's bounce. Armed on the TAP (not the echoed doc, so a slow write still pops instantly), released on its own `animationend` by name. Like-only: unhearting is a quiet correction, the same asymmetry as unmarking a Square.
- **`heart-ring`**—a theme-colored ring flashing outward from the button, riding the same `.heart-burst` state.
- **`heart-tick`**—the count slides up on every change. The number span is keyed by value, so ANY movement remounts it and replays the tick: the viewer's own tap and other Players' hearts arriving on the live stream both animate.

## Deliberate non-features

No heart notification, no who-hearted list (the count is ambient warmth, not a roster—unlike a Tally, whose who-list is the point), no hearts on Tally Cards, no server-side counter (counts are client-derived from the live collection, ADR 0001), no exactly-once analytics (offline drains count late or not at all—accurate-but-delayed beats inflated), and no cascade-delete of hearts when a post dies (no cross-writer cleanup, the doubts posture): a deleted post's hearts are dead docs the incarnation filter structurally ignores forever.

## Test coverage

`src/components/feed-hearts.test.tsx`: `heartDocId` binding, `heartState` counting/keying/incarnation-scoping/ban semantics with the own-content exception, HeartButton's pressed/label/burst/quiet-unheart/keyed-count contract plus the double-tap intent alternation and the optimistic override yielding to echo and rollback, and the CSS pins (keyframes exist, token-only fill, defined ahead of the kill switch). `tests/rules/feed-hearts.test.ts`: the full write gate against the emulator—bound slot, forged uid, phantom/wrong-kind targets, unknown kind, extra fields, stale/forged incarnation stamps, clock window, owner-overwrite-still-one-doc, no cross-Player update, owner/admin delete, re-heart, public read.
