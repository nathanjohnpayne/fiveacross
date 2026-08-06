---
spec_id: w2-leaderboard
status: accepted
---

# w2-leaderboard—bingos→squares→earliest-first-bingo ranking, pinned First to BINGO, presentational filters

The Leaderboard is the for-fun ranking of Players—bingos, then squares marked, then earliest first-bingo—with a pinned First to BINGO. Per ADR 0001 it is a social artefact, not a tamper-proof record: stats are client-authoritative and the First to BINGO honour is self-reported. The tie-break order and the pin already existed pre-ticket (`comparePlayers`/`sortPlayers` in `src/game/logic.ts`, the inline pin calculation in `src/components/Leaderboard.tsx`) but carried no dedicated test and no way to narrow the view. This ticket (issue #35) verifies that order under test, extracts the pin into a clearly-documented first-class calculation, and adds presentational all/with-BINGO/Blackout filters that narrow the visible rows without ever touching how they are ranked.

## Carried over unchanged (verified, not rewritten)

- `comparePlayers`/`sortPlayers` (`src/game/logic.ts:114-128`)—bingos desc, then squares desc, then earliest `firstBingoAt`. Untouched by this ticket: #35 adds verification tests, not new behavior, per the issue's own scope note and ADR 0001 (no server-side recompute, no tamper-proof framing). (Issue #93 later amended the both-null tie—see the verification finding below.)
- `useLeaderboard` (`src/hooks/useData.ts:133-136`)—subscribes to the `players` collection and returns `sortPlayers(data)`. Untouched: filters are presentational and run over the set this hook already subscribes to, so no filter needs a scoped query (per the issue's implementation notes) and `useData.ts` is not extended.
- The composite Firestore index (`firestore.indexes.json:4-11`, `bingoCount` DESC, `squaresMarked` DESC, `firstBingoAt` ASC) already backs `useLeaderboard`'s sort and needs no change for a client-side filter.

## The change—`Leaderboard.tsx` gains presentational filters; the pin stays pinned

- `src/components/Leaderboard.tsx`—adds an All / With BINGO / Blackout filter row (`LeaderboardFilter` union + a `matchesFilter` predicate) above the ranked list. Filtering is a plain `Array.prototype.filter` over the already-`sortPlayers`-ordered `players` array—never a `.sort`—so the PRD tie-break order is always preserved; only which rows are visible changes. "With BINGO" matches `bingoCount > 0` (the same stat the row itself already displays as "N bingo(s)"); "Blackout" matches the `blackout` flag. An empty filtered result renders a distinct "No one matches this filter yet." message with the filter row still interactive, rather than reusing the global "No players yet" state (which specifically means no Players have joined the Event at all).
- `src/index.css`—a new `.lb-filters` / `.lb-filter-btn` block, visually modeled on the existing `.seg` / `.seg-btn` segmented control (`ProofSheet`'s proof-type picker) but under its own class names, so this ticket's ownership of `index.css` this wave cannot collide with that surface's own styling.
- `src/hooks/useData.ts`—untouched. Every filter runs entirely client-side over the set `useLeaderboard` already subscribes to; there is no new query and no new index.
- `src/game/logic.ts`—untouched. `comparePlayers`/`sortPlayers` gain a dedicated verification suite (below), not new behavior.

## Design decisions

- **The First to BINGO pin is computed from the FULL roster, never the filtered subset.** `Leaderboard` derives `firstBingoUid` (the earliest `firstBingoAt` across every Player) from the unfiltered `players` array before applying any filter, exactly as the pre-ticket inline calculation did. If the pin were instead derived from the currently-visible (filtered) rows, selecting a filter could hand the "1st BINGO" badge to a *different* Player than the one who actually got there first—e.g. selecting "Blackout" would crown the earliest Blackout achiever instead of the true earliest bingo, which is wrong. Computing it from the full roster means only visibility of the pinned row can change with the filter, never who holds the pin. `src/components/w2-leaderboard.test.tsx` pins this directly with a fixture where the pin holder is rank #2, not rank #1 (fewer bingos than the top-ranked Player, but an earlier `firstBingoAt`), so the pin and the rank are demonstrably independent signals.
- **Rank numbers renumber within the visible/filtered subset.** Each visible row's rank badge is its 1-based position among the *currently shown* rows (as the pre-ticket code already did via `players.map((p, i) => ...)`), not its position in the full unfiltered roster. This matches ordinary "leaderboard with a filter" UX (a Blackout-only view shows "1, 2, 3…" for the Blackout achievers, not their original global rank numbers) and is consistent with "filters change only the visible subset, never the order": the *relative sequence* of the remaining rows is untouched by filtering (a plain `.filter` cannot reorder), which is what "never reorder" means here—only the numeric label attached to each row is recomputed for the smaller list being shown.
- **Filter predicates read the same fields the row already displays.** "With BINGO" reads `bingoCount` (shown as "N bingo(s)") rather than `firstBingoAt`, so the filter and the visible copy always agree about what "has a BINGO" means, even though the two fields are set/cleared together by `computeMark` (`src/data/api.ts`, out of scope for this ticket).

## Verification finding: a `comparePlayers` arithmetic quirk (found during #35 verification, fixed by issue #93)

While writing the exhaustive tie-break table for #35, `comparePlayers(a, b)` for two Players who both have `firstBingoAt: null` and are otherwise tied turned out to return `NaN`, not `0`: the tie-break fell through to `(a.firstBingoAt ?? Infinity) - (b.firstBingoAt ?? Infinity)`, and `Infinity - Infinity` is `NaN`. A `NaN` comparator result leaves `Array.prototype.sort` formally free to order that pair however the engine likes—harmless in practice (V8 treats a `NaN` result like "equal", no swap) but engine-dependent rather than guaranteed, and the only case that reaches this branch is exactly the common one of a roster with multiple no-bingo-yet Players. #35 kept `src/game/logic.ts` untouched per its file boundary and pinned the `NaN` honestly in `src/game/w2-leaderboard.test.ts` rather than mis-asserting a clean `0`. Issue #93 then made the fix: `comparePlayers` now short-circuits the both-nullish tie to an explicit `0` before the `?? Infinity` fallback, so the comparator never returns `NaN` and the full rule is bingos desc → squares desc → earliest `firstBingoAt`, a nullish `firstBingoAt` sorting last, and two no-bingo Players tying at a stable `0`. The formerly-NaN-pinning test now asserts that `0`.

## Claim → test

Every claim below maps to a real assertion against the actual `comparePlayers`/`sortPlayers`/`Leaderboard`—no vacuous coverage.

### Unit—`comparePlayers`/`sortPlayers` tie-break table (bingos desc, squares desc, earliest first-bingo, null last, both-null stable 0)

Runner: `npm test` (Vitest). Test: `src/game/w2-leaderboard.test.ts`.

- Higher `bingoCount` ranks first regardless of squares or `firstBingoAt`.
- Once `bingoCount` ties, higher `squaresMarked` ranks first.
- Once `bingoCount` AND `squaresMarked` both tie, the earlier `firstBingoAt` ranks first.
- A `null` `firstBingoAt` sorts LAST among an equal `bingoCount`/`squaresMarked` tie—in both argument orders, both against a small numeric value and against `Number.MAX_SAFE_INTEGER`, so there is no Infinity-adjacent surprise.
- Two Players who BOTH have a `null` `firstBingoAt` and are otherwise tied compare as exactly `0`, in both argument orders—the stable, engine-independent tie issue #93 introduced (previously `Infinity - Infinity = NaN`, pinned honestly until the fix).
- `sortPlayers` never mutates its input array or the input's own order, and always returns a new array.
- `sortPlayers` is a stable sort: fully-tied Players (including two Players who both have a `null` `firstBingoAt`, the explicit-`0` tie above) keep their original relative order regardless of input order.
- A seven-Player roster, shuffled on input, recovers the full canonical order through every tie-break level in one pass: most bingos; then the `bingoCount`-1 tier ordered by squares, then by earliest `firstBingoAt`, with the `null`-`firstBingoAt` Player in that same tier sorting after both numeric ones; then the `bingoCount`-0 tier ordered by squares.

### RTL—the pin tracks earliest-bingo (not rank), the BLACKOUT suffix, and the filters

Runner: `npm test` (Vitest, jsdom). Test: `src/components/w2-leaderboard.test.tsx`. `useLeaderboard` is stubbed with a pre-ranked fixture (the sec-xss-proofsheet.test.tsx / w2-tally.test.tsx precedent for isolating a presentational component from its read hook) so these tests exercise the real `Leaderboard` filter/pin logic, not a re-derivation of `sortPlayers` itself.

- The "1st BINGO" pin (the `leader` row class + the `.badge` text) lands on the Player with the earliest `firstBingoAt` in the fixture, even though a different, higher-ranked Player (more bingos) is listed first—proving the pin tracks earliest-bingo, not rank position.
- The "· BLACKOUT" suffix renders only for a Player whose `blackout` flag is set.
- The default filter is "All": every Player renders, in ranked order.
- Selecting "With BINGO" hides the Player with `bingoCount === 0` and keeps the remaining Players in their original relative order.
- Selecting "Blackout" narrows to only the Player(s) with `blackout: true`.
- Switching back to "All" restores the full, still-unreordered roster.
- The active filter button carries `aria-pressed="true"`, and exactly one filter is active at a time.
- A filter with no matches renders a distinct "No one matches this filter yet." message while the filter row stays interactive—never the global empty-roster state.
- The global animated "Tallying the leaderboard…" state and the global "No players yet" (empty-roster) state both render with no filter row at all, unaffected by the filter feature.

## Acceptance criteria

- **Given** Players with equal bingo counts, **when** the Leaderboard renders, **then** they order by squares marked, then by earliest first-bingo—`src/game/w2-leaderboard.test.ts` (the full tie-break table).
- **Given** at least one Player has a first-bingo, **when** the Leaderboard renders, **then** the earliest is pinned as First to BINGO—`src/game/w2-leaderboard.test.ts` (null-last unit coverage) + `src/components/w2-leaderboard.test.tsx` (the pin lands on the earliest first-bingo Player even when they are not rank #1).
- The tie-break order is asserted by a unit test over `comparePlayers`—`src/game/w2-leaderboard.test.ts`.
- Filters change only the visible subset, never the order—`src/components/w2-leaderboard.test.tsx` ("With BINGO" / "Blackout" narrow while preserving the remaining rows' relative order; see "Design decisions" above for what "order" means when rank numbers are renumbered for the visible subset).
- Stats stay client-authoritative; no anti-cheat recompute is added (ADR 0001)—`src/game/logic.ts` and `src/hooks/useData.ts` are unmodified; `Leaderboard.tsx` reads Player-written stats exactly as before.

## Out of scope

- No new Firestore query or index: filters are entirely client-side over `useLeaderboard`'s existing subscription.
- No server-side stat recompute—and #35 itself changed no `comparePlayers`/`sortPlayers` behavior: its `NaN`-on-double-null finding was documented and pinned rather than fixed, because fixing it was a behavior change to a function that ticket's scope kept "under verification, not change." Issue #93 has since made exactly that fix—the both-nullish tie is now an explicit stable `0` (see the verification finding above).
- Board, ProofSheet, ProofFeed, ItemPool, and the write paths in `src/data/**` are untouched; this ticket is read/presentation-only on top of Player-written stats.
