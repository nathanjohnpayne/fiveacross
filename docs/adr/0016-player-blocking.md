---
status: accepted
implemented: false
---

# Player blocking is a per-pair, per-viewer, display-only narrowing, enforced by rules only on its own records and on Hearts

## Context

The App Store and Google Play require a block for an application with a shared user-generated feed, so [#689](https://github.com/nathanjohnpayne/fiveacross/issues/689) is a hard gate on any native expansion and ships value to the PWA on its own. Two of the repository's standing commitments constrain how it can be built. ADR 0002 makes every Mark public in its Prompt's Tally and every Proof and Moment public in the Feed, and every shared read arm in `firestore.rules` is a bare `admitted(eventId)` with no author pin, read by whole-collection or status/itemId/eventId listeners. ADR 0001 makes the Feed and the Doubt the group's only verification, so nothing may quietly remove a Player from the group's ability to check them.

Firestore rules are not filters. A per-document author predicate on those list arms would deny every reader's whole listen, and the query-constraint route (`not-in` over the hidden set) caps at ten values that other Players control. The only way to make blocked reads rules-enforced is a reader-scoped server projection of each surface, which is a separate epic.

## Decision

Blocking is **a per-pair, per-viewer narrowing of ADR 0002's attribution and of standings display, applied at render**, with rules enforcing exactly two things: the privacy and integrity of the block records (`blocks/{owner}_{target}`, owner-only; `blockPairs/{lo}_{hi}`, readable by the two parties), including Invariant I through `existsAfter` on every commit (with a client reconciler for the one orphan state concurrent unblocks can leave); and a Heart aimed across a pair, denied on the same target read the incarnation-stamp check already spends. Everything else a blocked pair shares is hidden by the client from the pair record both of them can read. The owner ruled this enforcement bar (A) on 2026-09-24, with the residual stated plainly: a blocked Player querying Firestore directly still receives the other Player's proofs, moments, markers, doubts and hearts, and can fetch their avatar and media. `specs/player-blocking.md` is the contract.

**Blocks never gate Doubt creation.** A Doubt is the ADR 0001 verification channel. Blocking is a few taps each with no cap, so a block that denied Doubt creation would let a Player who blocks every co-member become un-doubtable: block-to-evade-doubt. #689 asks only that doubts not be seen across a block, so the rules leave Doubt create open, the UI hides the Doubt button across a block, and the pair's doubts are hidden from both parties while third parties still see them. The residual is that a blocked Player can raise a Doubt on the blocker through a direct write that the blocker's own app never shows.

**Scoring, records and the award stay real.** `useLeaderboard`, `players/{uid}`, the tally aggregate, `EventDoc.archive.standings`, every Functions aggregator, the Most-Loved award record and every Day snapshot are untouched and never receive a hidden set. Leaderboard rows are hidden after ranks are computed, keeping rank gaps; podium entries are withheld without promotion. A block never rewrites who was first to BINGO, and there is no rules-level Tally lockdown. A block that lands mid-Event hides retroactively at render, and an unblock restores everything.

**Direction disclosure is inherent.** Reciprocal client-side hiding requires the blocked Player's client to receive the pair record naming the blocker, so a blocked Player can enumerate who blocked them; an unblocker whose direction-only retry succeeds learns the block was mutual. Accepted, and the copy is worded so it does not overclaim.

**Admins are blockable as a social hide only.** The Admin console, moderation surfaces and Notices never apply block filtering, so moderation reach is unchanged. Avatars, profiles and proof media stay globally readable under `specs/event-membership.md` D9 and are hidden in the display only. Only the blocker can reverse a block.

## Consequences

- Rules, hosting and the client provider are coupled in one direction: deploy `firestore.rules` first (additive collections; the Hearts conjunct denies nothing until a pair exists), hosting second. Old clients never write blocks and simply do not hide until updated. No backfill.
- The Hearts arm costs one more `exists()`; Doubts and the Mark batch are unchanged. No collectionGroup rule exists for either block collection.
- Every surface that renders another Player must read the viewer's hidden set. The `useHiddenUids()` leaf provider is the one source, and server-parity mirrors (`proofFeedVisible`, `buildMostLovedPhotoAward`, `draftEventArchive`) must never be fed it: a union input there would promote someone else.
- Reader-scoped server projections remain the only way to meet "holds against a direct Firestore read" for list reads, and are not commissioned. A store reviewer reading "rules-enforced" as covering reads should be pointed at the spec's enforcement table.
- A report-a-Player flow, a block cap and block-aware server aggregators are follow-ups, not part of this decision.

## Considered alternatives

- **Block conjuncts on the read arms** (biting on point gets only): rejected, because any document a blocked Player can list they can also read through a list, so it spends rules budget to look like enforcement without being any.
- **Query-constraint enforcement** (`where(uid, 'not-in', hidden)` with a rule proving the constraint): rejected, because `not-in` caps at ten values and other Players control the reader's hidden set, so eleven blockers break one Player's Feed; doubts also carry two uid fields and a query allows one `not-in`.
- **A single pair document with a `blockers` field**: rejected, because rules cannot redact fields, so the blocked Player would read the direction.
- **Denying Doubt create across a pair, or only when the doubter is the blocker**: rejected in favour of keeping the verification channel open; the block-to-evade-doubt risk outweighs a direct-write doubt the blocker never sees.
