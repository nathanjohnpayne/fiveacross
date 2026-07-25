---
spec_id: reshuffle
status: accepted
---

# Reshuffle a hard Day Card: pristine-only, 3 per cruise, rules-bound counter (`reshuffle`)

Implements [`plans/reshuffle-ticket.md`](../plans/reshuffle-ticket.md) and `plans/daily-cards-spec.md` § "Reshuffle" (#378), against the wireframes' [`#frame-reshuffle`](../plans/daily-cards-wireframes.html) (day-bar chip + confirm sheet) and `#frame-launch-intro` (one-time announcement). Depends on the day-scoped Board path (#204) and per-Day dealing (`d15-dealing`). Guarded by `src/game/reshuffle.test.ts` (the pristine predicate + seed), `src/data/reshuffle.test.ts` (the deal source, exclusion, and batch shape), `src/components/reshuffle-chip.test.tsx` (the chip-visibility matrix), `src/components/reshuffle-sheet.test.tsx` + `src/components/reshuffle-intro.test.tsx` (RTL), `tests/rules/reshuffle.test.ts` (the write gate), and `tests/e2e/reshuffle.spec.ts` (parity screens).

## Glossary

**Reshuffle** — trading a pristine Day Card for a fresh deal; 3 per cruise (CONTEXT.md). *Avoid:* re-deal (that's pool recovery), mulligan.

**Pristine** — a Day Card with zero PLAYER-marked Squares. The free centre is always marked and never counts. A `status: 'pending'` Square (an admin_confirmed-mode Claim awaiting resolution) **is** a Mark for this purpose and makes the card non-pristine, even though `countMarked` discounts it for scoring.

**Allowance** — the cruise-wide budget of 3, held on `PlayerDoc.reshufflesUsed`. Non-refundable and monotonic.

## Contract

**A Reshuffle replaces the Board, increments the counter, and mints the spend marker — and does nothing else.** `reshuffleBoard` (`src/data/api.ts`) writes exactly three docs in one transaction: the Day's Board (fresh seed, fresh deal), `players/{uid}.reshufflesUsed`, and the per-spend marker `reshuffles/{uid}-{n}` (#463 — see "One spend authorises one Board" below). There is deliberately NO cascade code: a pristine card has produced no Tally entries, Proofs, Doubts, stats, or Moments to unwind. A Player who wants out of a card they have marked unmarks it through the existing Mark path — which already removes its Tally entries — returning the card to pristine.

**The new card is an ordinary card.** It draws from the SAME frozen `snapshotItemIds` Day Snapshot (never a live `status: 'active'` query), with the same stratification rules as the first deal — `stratify` off for all-tame tutorial pools, the Event's `spicyRatio` on main Days.

**Discarded prompts return to the eligible pool.** The cross-cruise no-repeat exclusion is computed from KEPT cards only: every OTHER Day Card the Player holds is excluded, the discarded one is not.

**The chip renders only when every gate holds** (`src/components/Board.tsx`): card pristine, counter known and under the allowance, Day unlocked, card is the caller's own, and online. It reappears if the Player unmarks everything. It never renders on a locked-Day preview — `DayBar`'s chip prop is optional and `LockedDayPreview` passes none.

**Online-only, enforced by `runTransaction` — not by the chip's `online` gate and not by awaiting a batch.** A `writeBatch` still QUEUES offline and applies optimistically to the local cache while its commit promise pends forever, so a Player whose connection dropped after the `online` check would see the replacement card, mark it, and have it rolled back on drain. `navigator.onLine` cannot close that window either — it reports the link, not reachability, and captive ship wifi reads as online. `runTransaction` requires a server round trip and REJECTS offline rather than buffering, so a reshuffle either lands atomically against fresh server state or changes nothing.

**The Board rule binds the pair** (`firestore.rules`): a write that does not carry an existing Board's `seed` through unchanged — a differing value, or the key being **dropped or added** — is a Reshuffle, and is permitted only for the owner, only on an unlocked canonical Day, only when the EXISTING Board is pristine, only when `getAfter(players/{uid}).reshufflesUsed == get(...).reshufflesUsed + 1` and `<= 3`, and only when the batch also CREATES that spend's marker (next paragraph). A seed-preserving write (a Mark, a merge of `cells`) and a create (the first deal) are unaffected.

**One spend authorises one Board — reified as a marker doc** (#463 finding 1). Rules evaluate each document in a batch independently, and every Board write reads the SAME player doc, so the counter pairing alone let a single `+1` vouch for EVERY Board reshuffle in one `writeBatch` (confirmed on the emulator: three boards + one `0→1` was allowed — the budget of 3 laundered into up to 30). The batch-wide token each spend consumes exactly once is therefore a document: a Board reshuffle additionally requires the **create**, in the same batch, of `reshuffles/{uid}-{n}` (`n` = the counter value the batch pays for) whose payload names THIS Board's `dayIndex`. The path is pinned by the post-batch counter, so every board in a batch resolves the same marker — and the `dayIndex` binding means it can vouch for only one of them. `!exists()` on the Board side requires the marker to be NEW in the batch, so a pre-created marker vouches for nothing; the marker's own rules are create-only (immutable, owner-only, id bound to `{uid}-{n}`, `n` bound to the post-batch counter via `getAfter`), so a marker can only ever be minted for the spend its batch is actually paying, and owner delete is denied so a spent marker cannot be re-minted.

**Prompt content is bound on every non-Reshuffle cells write** (#463 finding 2). Classifying on `seed` alone left a free re-deal: a full `cells` replacement that KEEPS the stored seed — 24 new prompts, `markSeed` echoed — was never a Reshuffle and sailed through the Mark arm (confirmed on the emulator at `reshufflesUsed: 3`). Every legitimate non-Reshuffle cells write — a Mark, an Echo, a proof attach/detach — patches marking state and carries each cell's prompt (`itemId` + its denormalized `text`) through unchanged, so the rules now require exactly that (`boardPromptsCarried`, unrolled 25× like `boardPristine`). A same-seed prompt rewrite is denied outright rather than reclassified as a paid Reshuffle: `reshuffleSeed()` guarantees a real Reshuffle never keeps its seed (it nudges past collisions), so no legitimate caller lands in that shape — and a flat deny leaves nothing to launder through.

**A Mark carries the seed it was computed from.** `setMark` writes `markSeed` beside `cells` when it knows the Board seed. Rules require non-Reshuffle cell changes on seeded Boards to keep `markSeed == resource.seed`, which rejects a queued stale Mark from the pre-Reshuffle card after another tab has replaced that card. Seedless legacy Boards remain markable; a determined current client can still rewrite its own `cells` under ADR 0001, but an offline stale write can no longer silently undo the replacement card while preserving the spent allowance.

**Board delete is admin-only** (`firestore.rules`). It was previously covered by the blanket owner `allow write`, which made the allowance trivially bypassable: delete the Board, then CREATE a fresh one — a create has no `resource`, so it is not a Reshuffle and skips both the pristine check and the counter. No app path deletes a Board and no test asserts one, so this narrows self-write by exactly one operation that had no legitimate caller.

**The counter is monotonic** (`firestore.rules`): `reshufflesUsed` may only hold or rise by exactly 1, never fall, never exceed 3; a create must start at 0. **Removal is a decrement**: a write that drops the field (a non-merge replacement, or `deleteField()`) is denied, because `usedCount()` reads a missing key as 0 and would hand back three fresh reshuffles. Absence is tolerated only where it is already the truth — a create, or a legacy row that never carried the key. Admins are bound by all of this too.

**A confirm is pinned to the card it was made against.** `reshuffleBoard` takes the `seed` the Player was looking at and refuses if the stored Board no longer carries it. This is what makes a contended retry a refusal rather than a second spend: Firestore retries the loser of a concurrent pair, and the Board it re-reads is the winner's replacement — itself pristine and freshly counted, so every other check would pass.

**The launch intro shows exactly once.** `LaunchIntro` self-gates on `gcb.seen.reshuffleIntro` (localStorage), queued behind the coach overlay so the two scrims never stack. Not replayable.

## Decisions

**Why monotonic rather than "deny counter writes outside the pairing"** (the ticket's original wording). That check is not expressible. It would have to live on `players/{uid}`, which is cruise-wide and carries no `dayIndex`, so it cannot know which Day's Board to inspect. The only day-agnostic formulation — unroll all 10 Days, asking whether any Board's seed changed — costs 3 access calls per Day (`exists` + `get` + `getAfter`) against Firestore's ceiling of 20 for a batched write. Measured against the emulator: it short-circuits cheaply on a Day-0 reshuffle and **denies a legitimate Day-5 or Day-9 one**, i.e. it would have passed CI and then silently broken mid-cruise.

Monotonic is equivalent for the property that matters. Every Board reshuffle still requires a paired +1 (Board-side), so the cap of 3 holds exactly; monotonicity closes the only real exploit — resetting the counter to 0 for unlimited reshuffles. Recorded on #378.

**Why `isPristine` is not `countMarked(cells) === 0`.** `countMarked` scores the leaderboard and therefore discounts a `status: 'pending'` Square. Eligibility is a different question: the Player has tapped it, a Claim is queued against it, and trading the card away would strand that Claim. The client predicate must also agree with the rules' `boardPristine()`, which can only see `marked`/`free`, not `status` semantics — a disagreement would render a chip whose write the server denies.

## Residuals (accepted)

**An unpaired counter increment is permitted.** A client can write `reshufflesUsed: n+1` with no Board write. It burns their own allowance and changes no card — self-harm, not an exploit. This is the one deviation from the ticket's literal wording; see Decisions above. The same class covers the marker-side twin (#463): a counter bump plus its paired `reshuffles/{uid}-{n}` marker with no Board write, or a marker whose `dayIndex` names a Day the Player never reshuffles, likewise burns the spend and replaces nothing.

**Boards remain self-writable by design for MARKS and STATS** (ADR 0001). A determined client can still rewrite its own cells' *marking state* under the honor system — that is the trust model, not a gap. What the Reshuffle rules bound is the FEATURE's counter: the ways a Board could be *replaced* without spending an allowance — delete-then-create; dropping or adding `seed`; N Boards riding one batched `+1` (#463 finding 1); a same-seed full-prompt rewrite (#463 finding 2) — are closed, because an allowance that is trivially launderable is not an allowance. What stays open, deliberately, is marking-state self-writes on the Player's own card (including forging `marked`/`free`/`echo` flags, which can at most launder the Player's own pristine-eligibility — equivalent to unmarking by hand and reshuffling, at the same allowance cost). This is not an anti-cheat boundary on marking, and treating it as one would misread ADR 0001.

**A concurrent second reshuffle is denied, not merged** — enforced by the confirmed-seed precondition above, NOT by the counter check alone. The counter alone is insufficient and the first cut got this wrong: a transaction retry re-reads the *winner's* replacement board and an already-incremented counter, all of which pass, and quietly spends a second allowance.

**`gcb.seen.reshuffleIntro` diverges from the repo's `gcb.<feature>.dismissedAt` key convention.** Kept as the ticket specifies so the spec, the test, and the deployed key cannot drift.

## Acceptance criteria

- Given a pristine Day 2 card and `reshufflesUsed = 1`, when I confirm a reshuffle, then I get a new 24-prompt card from the same snapshot, the chip shows ×1, and nothing else changed — Feed, tallies, stats identical (`src/data/reshuffle.test.ts`, `tests/e2e/reshuffle.spec.ts`).
- Given one marked square, then the chip does not render (`src/components/reshuffle-chip.test.tsx`) and a forced write is denied by rules (`tests/rules/reshuffle.test.ts`); after unmarking it, the chip renders again.
- Given `reshufflesUsed = 3`, then the chip never renders and a forced write is denied.
- Given a locked Day, or an offline client, then the chip does not render; a forced write on a locked Day is denied by rules.
- Given a non-owner, then a forced Board write is denied by rules.
- Given a counter write that decrements, jumps by 2, or exceeds 3, then it is denied by rules.
- Given my first app open after deploy, the intro overlay shows exactly once and never again (`src/components/reshuffle-intro.test.tsx`).
- Given I tap "Keep my card", then nothing is written (`src/components/reshuffle-sheet.test.tsx`).
