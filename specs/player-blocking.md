---
spec_id: player-blocking
status: accepted
---

# Player blocking: reciprocal, per Event, rules-enforced on the records and on Hearts, client-hidden on every shared read

A Player blocks another Player, and from then on neither sees the other in this Event. The block is reciprocal, per Event, stored per Player, self-serviceable, and reversible only by the Player who made it. It is a visibility control, never a scoring one (ADR 0001, ADR 0011), and it is the App Store and Google Play precondition for an application with a shared user-generated feed ([#689](https://github.com/nathanjohnpayne/fiveacross/issues/689)). Ships in three parts, in order and not stacked: this spec's records, rules and data provider; then client-side hiding across every shared surface; then the block and unblock UI. Decisions are the owner's of 2026-09-24, recorded on #689 and in ADR 0016. Guarded by `tests/rules/player-blocking.test.ts` (every rules arm, both enforcement postures), `src/data/blocks.test.ts` (the batches and the pure derivations) and `src/hooks/useBlocks.test.tsx` (the provider).

## Glossary

**Block**: a Player's per-Event, reciprocal, self-serviceable hide of another Player. Display-only on shared reads, enforced by rules on the block records and on Hearts. Distinct from a **Ban** (Admin-issued, Event-wide hide of one Player's content, `EventDoc.bannedUids`) and from **Membership revocation** (removes admission). *Avoid:* mute, ban, ignore.

**Direction record**: `events/{eventId}/blocks/{ownerUid}_{targetUid}`, the blocker's own list entry. **Pair record**: `events/{eventId}/blockPairs/{lo}_{hi}`, the direction-free fact that a block stands between two Players. **Hidden set**: the uids a viewer hides and is hidden from, derived by that viewer's client from the pair records naming them.

## The enforcement bar, stated first

**Rules enforce the block records and a Heart aimed across a block. Every shared read is hidden client-side.** This is enforcement bar A, ruled by the owner on 2026-09-24. Firestore rules are not filters: a `list` is admitted or denied as a whole, so a per-document predicate on the author uid of the proofs, moments, markers, doubts or hearts list arms would deny every reader's whole listen (the #294/#314 "intermittent" failure), and every client listener today is a whole-collection or status/itemId/eventId query. Two rules-side alternatives were examined and rejected: a block conjunct that bites only on point gets (any document a blocked Player can list they can also read through a list, so it would spend budget to look like enforcement without being any), and query-constraint enforcement through `where(uid, 'not-in', hidden)` (`not-in` is capped at 10 values and a reader's hidden set includes everyone who blocked them, which other Players control, so eleven blockers would make one Player's Feed unqueryable: a griefing vector).

**Accepted residual, recorded here and in ADR 0016.** A blocked Player who queries Firestore directly with their own credentials still receives the other Player's proofs, moments, tally markers, doubts and hearts, and can fetch their avatar and proof media. The app never shows them. Closing this for reads needs reader-scoped, server-built projections for each surface, which is a separate epic the owner has not commissioned. #689's acceptance line "enforcement holds against a direct Firestore read" is therefore met for the block records and for Hearts, and deliberately not for the list reads.

## Data model

Two records per block, both under the Event, both at ids computable from the two uids so no rule and no client ever needs a query to find them. `BlockDoc` and `BlockPairDoc` live in `src/domainTypes.d.ts`; the refs in `src/data/paths.ts` (`blockRef`, `blockPairRef`, `blocksCol`, `blockPairsCol`, `blockPairId`).

- **Direction record** `blocks/{ownerUid}_{targetUid}` = `{ ownerUid, targetUid, eventId, createdAt }`. Readable by its owner alone (get and list; the one client query is `where('ownerUid', '==', me)`). No Admin read or delete path.
- **Pair record** `blockPairs/{lo}_{hi}` (lo < hi in string order) = `{ uids: [lo, hi], eventId }`. No direction, no timestamp, no names. Readable by either party (get, and list by `where('uids', 'array-contains', me)`); a third Player and an Admin cannot read it. The Hearts rule checks it with one `exists()`.

`_` joins both ids, as it does the doubts and hearts slot ids: it appears in no Firebase-minted uid, and the direction create arm refuses a `targetUid` containing one so the ordered pair id cannot collide across two pairs. Rejected shapes: a single pair document carrying a `blockers` field (rules cannot redact fields, so it would leak direction to the blocked Player); mirrored per-Player hidden arrays (needs a server fan-out through `functions/**`). Neither collection has a `{path=**}` rule, so a collectionGroup listen is denied.

**Invariant I: the pair record exists if and only if at least one direction record exists.** Every client write is one atomic `writeBatch`, and every rules arm checks the batch's result with `existsAfter`, so no committed state can violate it:

- Direction create: `ownerUid == auth.uid`, a non-empty `targetUid` that is not the caller and contains no `_`, `eventId` equal to the path, the id bound to `auth.uid + '_' + targetUid`, `createdAt` in the shared +60s/−24h window, and `existsAfter(pair)`.
- Direction update: only an idempotent re-block. `affectedKeys().hasOnly(['createdAt'])`, a near-now `createdAt`, and `existsAfter(pair)`. This is what lets `blockPlayer` be a blind set that never fails "already blocked" when the own-blocks listener has not loaded or another device blocked first.
- Direction delete: owner only, and `existsAfter(pair) == existsAfter(the other direction)`.
- Pair create/update: `auth.uid in uids`, `uids == [lo, hi]` matching the id, keys exactly `{uids, eventId}`, `eventId` equal to the path, and `existsAfter(the caller's own direction record)`. The content is deterministic, so a re-set is a no-op update.
- Pair delete: `auth.uid in uids`, and neither direction `existsAfter`.

Every arm conjoins `admitted(eventId)`, consistent with `specs/event-membership.md` § The enforced-path inventory; a blocked Player remains a member, and the block predicate sits beside `admitted()`, never inside it. There is deliberately no `eventOpenForPlay` conjunct: blocking is a safety action and stays available on a closing or archived Event. The target need not be a member or a Player (checking would spend a `get()` and buy nothing); self-block is denied; a Player may block an Admin (decision 4), which is a social hide only.

**Rules `get()` and `exists()` read documents regardless of their read rules.** The blocked Player cannot read the direction record that names them, yet their Heart on the blocker's post is still denied. `tests/rules/player-blocking.test.ts` pins this.

## Client write flows (`src/data/blocks.ts`)

`blockPlayer({ me, target, eventId })` commits `{ set direction, set pair }`. Idempotent under the arms above. `unblockPlayer({ me, target, eventId })` first tries `{ delete direction, delete pair }`; on `permission-denied`, which the rules issue exactly when the other direction still stands, it retries `{ delete direction }` and returns `{ stillHidden: true }`. Any other error rethrows. The retry succeeding is how the unblocker learns the block was mutual; reciprocity makes that inherent, and the UI copy (part 3) says so. Both capture the acted Event once, as `setHeart` does, so a hostname change cannot move the write.

## Direction disclosure is inherent, not a solved requirement

#689 asks that the block list not be readable by the blocked Player. The direction records are owner-only, so the list itself is not. But the blocked Player's client must learn the blocker's uid in order to hide them reciprocally, so it receives every pair record naming them, and a pair whose counterpart is not among the viewer's own direction records identifies someone who blocked them. No client-side reciprocal design avoids this; the only rules-level alternative is the same projection epic as the read residual. Accepted by the owner. The block confirmation copy (part 3) must not overclaim: "they won't get a notification, but their app will stop showing you, so they may be able to tell."

## Per-path enforcement

| Path | Mechanism | Residual |
|---|---|---|
| `blocks`, `blockPairs` | Rules (this spec) | The pair is readable by both parties (direction disclosure above) |
| Hearts create and update | Rules: `heartTargetAccepts` reads the target once for the incarnation stamp and adds `!exists(pair)` on its author | None. A server-authored Moment (`uid: 'system'`) never names a pair |
| Doubt create | Unchanged, open by decision 5 | A blocked Player can raise a Doubt on the blocker through a direct write; the blocker's app never shows it while third parties' do |
| Feed, proofs, moments, tally markers, who-lists, doubts, hearts counts | Client-hidden (part 2) through `useHiddenUids()` | Direct list reads return everything |
| Leaderboard rows, podium, last-call line, share cards, archived standings | Client-hidden at render, after ranks are computed (part 2); rank gaps kept, podium entries withheld without promotion (decision 6) | Rank gaps and server-aggregate counts reveal presence |
| Most-Loved award, `draftEventArchive`, Functions aggregators, the tally aggregate, Day snapshots | Stay raw: server-parity mirrors must never receive a hidden set | Hiding is display-only and retroactive at render |
| Avatars, `users/{uid}`, proof media and its download URLs | Display-only (decision 3): D9 in `specs/event-membership.md` keeps them globally readable, Storage has no spare access budget, and a minted download URL is a bearer capability | Reachable by a direct read |
| Community Prompts and `suggestedBy` | Not filtered (filtering would change dealing) | Attribution visible |
| Admin console, moderation surfaces, Notices, the banned roster | Never filtered (decision 4): moderation reach is unchanged, a Notice is never hidden | None |
| Old installed clients | Nothing until they update | They never write blocks and do not hide |

**Rules budget deltas.** Hearts create/update: the existing target `get()` is hoisted into `heartTargetData` and the pair `exists()` rides beside it, so in the accounting of `specs/event-membership.md` § The rules-evaluation budget the arm's own reads go from one to two and its worst enforced case from 4 / 3 to 5 / 4 (textual / distinct), well inside the ten-per-operation limit; the incarnation-stamp check is byte-equivalent to the inline pair of reads it replaces, and `tests/rules/player-blocking.test.ts` lands a Heart under `'enforced'` with no pair present. Doubts and the Mark batch are unchanged, and the Mark budget pins in `tests/rules/membership-mark-batch-budget.test.ts` stay green unmodified. The new arms spend at most the admission read plus two `existsAfter` calls.

## Doubts and ADR 0001

A Doubt is the honor-system verification channel. If a block denied Doubt creation, a Player who blocked every co-member would become un-doubtable, because blocking is a few taps each with no cap. #689 asks only that doubts not be *seen* across a block. So Doubt create stays open in the rules (decision 5); part 2 hides the Doubt button across a block and hides the pair's doubts from both parties while third parties still see them. ADR 0016 states the interaction and ADR 0001 points at it. `raiseDoubt` keeps its benign permission-denied branch unchanged.

## The hidden-set provider (`src/hooks/useBlocks.tsx`)

A leaf module that imports nothing from `useData` or `AuthContext`, so it can be mounted in the app shell without an import cycle and the suites that close-mock `../hooks/useData` keep working unmodified. `HiddenUidsProvider({ uid, enabled })` owns one `onSnapshot` with `includeMetadataChanges` on the array-contains pair query, keyed on `eventScopeKey(EVENT_ID, 'block-pairs', uid)` so an Event or account switch drops the old set first. `useHiddenUids()` returns `{ hidden, ready }`; the context default is `{ hidden: ∅, ready: true }`, so a tree without the provider renders exactly as today. `useMyBlocks(uid)` is the ownerUid-equality listener the Blocked-players panel (part 3) reads. Part 2 mounts the provider in `AuthContext.tsx` around `children`, inside the attestation gate, with `enabled` following `admissionAllowsEventWatchers`.

**Readiness.** Signed out: ready and empty, no listener. Signed in and not enabled: not ready, no listener, so a late admission flip cannot render a counterpart before the first pair snapshot lands. Signed in and enabled: ready on the first snapshot, cache or server. Content hooks (part 2) report loading until ready, so a blocked Player never flashes in on a cold start.

**The optimistic-unblock flash.** In the mutual case the first unblock attempt's pending local delete would remove the pair from the listener until the server denies it, indefinitely while offline. The provider keeps `lastCommitted`, the set from the latest snapshot with `hasPendingWrites == false`, and publishes `current ∪ (hasPendingWrites ? lastCommitted : ∅)` (`computeHiddenSet`, pure and unit-tested). A pending block hides immediately; a pending unblock reveals nobody until the server acks it; a denied unblock never flashes. A pending unblock made offline therefore stays hidden until reconnect.

**Fail mode.** If the pair listener errors, the provider logs `console.error` and resolves ready with the last set, so the app renders unfiltered rather than blank: the same admission failure would deny the content listeners too. The listener uses an explicit error callback rather than `useColSub`, which swallows errors.

## Frozen and denormalised content

Day snapshots, podium and last-call Moments, `DayMeta.firstBingo`, the tally aggregate, archive standings and the Most-Loved award record stay exactly as written. Hiding happens at render, so a block that lands mid-Event hides content retroactively and an unblock restores it. No record is rewritten, and no server aggregator becomes block-aware.

## Rollout

Deploy `firestore.rules` first: the new collections are additive and the Hearts conjunct denies nothing until a pair exists. Deploy hosting after: a new client on old rules would get `permission-denied` on every block write. Old installed clients never write blocks and keep working; they simply do not hide until updated. No backfill and no migration. Rollback: reverting hosting removes the UI and the hiding, and leftover records are inert; reverting the rules alone re-opens cross-block Hearts and breaks nothing else. `firestore.indexes.json` is unchanged: both client queries are single-field.

## Out of scope

Reader-scoped server projections; any change to the read posture of `users/{uid}`, avatars or proof-media Storage (#806 territory); the `block_player` and `unblock_player` analytics events (part 3 or a follow-up); a report-a-Player flow or a combined Report and Block action (follow-up ticket); a per-Player block cap or an Admin-visible block-count signal; hiding Community Prompts by block; block-aware Functions aggregators; deleting block records on membership revocation or account deletion; any per-Moment control on MomentCard.

## Test coverage

- `tests/rules/player-blocking.test.ts`, run with `membershipEnforcement` `'off'` and `'enforced'`: the block batch and its idempotent re-block; a direction without its pair and a pair without the caller's direction denied; forged owner, self-block, unbound id, a `_` in the target, extra and wrong fields, and a bad clock denied; pair uids that mismatch the id, are unordered or omit the caller denied; the update arm limited to `createdAt`; the orphan-pair delete denied and the batch unblock allowed; the mutual case (the second party joins the pair, the pair delete is denied while the other direction stands, the direction-only delete lands, and the last direction takes the pair with it); blocking on an archived Event; blocking an Admin; a non-admitted caller denied every arm under enforcement; owner-only direction reads (get and list) against the blocked Player, a third Player and an Admin; pair reads for the two parties only, unfiltered lists and both collectionGroup queries denied; a Heart denied in both directions across a pair, including the direction the denied Player cannot read, a third Player's and a server-authored Moment's allowed, a standing Heart's refresh denied, and hearting restored by an unblock; the refactored target read still denying a phantom or wrong-kind target; and Doubt create across a pair succeeding both ways.
- `src/data/blocks.test.ts`: `blockPairId` ordering; the exact batch contents of `blockPlayer` under the captured Event; the `unblockPlayer` fallback fired only on `permission-denied`, its `stillHidden` result, and other errors rethrown without a second attempt; the self-block guard; `hiddenUidsFromPairs` on malformed rows; `computeHiddenSet` for the settled, pending-block and pending-unblock cases.
- `src/hooks/useBlocks.test.tsx`: signed out ready and empty with no listener; not enabled means not ready with no listener; the query shape and `includeMetadataChanges`; the pending-write union; an account switch and an Event switch resetting the set and ignoring the old listener; the error path; the context default without a provider; `useMyBlocks`.
