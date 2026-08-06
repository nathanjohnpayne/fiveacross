# Echo Marks: a Mark carries to every card that has the same Prompt

**Track:** play/core · **Phase:** 0 · **Size:** L · **Epic:** Daily Cards (play) **Refs:** ADR 0001 (client-authoritative marks—this stays entirely client-side; no server function), ADR 0003 (boards freeze at deal), daily-cards-spec (per-day boards), `specs/reshuffle.md`, the Notice copy that promises this mechanic ("once a thing has happened, it's happened—if it's on three of your cards, that's three squares", `plans/admin-messages-ticket.md`). **No wireframe changes**—this is game logic; the only visual is an optional subtle echo indicator on auto-marked Squares (decision below). **Suggested runner:** Claude Opus 4.8, high reasoning effort (cross-board stat folds, rules-guard interplay, Moment-queue and reshuffle interactions; the seams are enumerated but the composition is intricate).

## Problem

A Player who has achieved a Prompt ("Poppers spill" happened) must today re-mark it by hand on every Day Card that carries it. The dealer avoids cross-day repeats only best-effort—with ~115 active Prompts and up to 10×24 dealt Squares per Player, repeats are inevitable in the back half of the cruise—and the final-days Notice explicitly promises "if it's on three of your cards, that's three squares." The game should keep that promise mechanically: achieve a Prompt once and every card that carries it lights up, with scores following.

## Design

**Concept: an Echo Mark.** When a Player's Mark on Prompt P reaches `confirmed`, the same Prompt auto-marks (`echo: true`) on every other board of theirs that carries P and isn't already marked. Echoes are real Marks for scoring (squares, bingos, blackouts, `firstBingoAt`)—the Player did the thing; the cards just agree.

Three propagation moments cover all cases with no migration:

1. **Mark-time.** After a manual Mark lands confirmed, echo P onto the Player's other existing Day Boards (unlocked days only—those are the only boards that exist).
2. **Deal-time.** `joinAndDeal` (and the post-Reshuffle re-deal) reads the Player's prior boards, computes their achieved set, and pre-marks any dealt Prompt already achieved—the new card arrives already echoing.
3. **Open-time reconcile (lazy backfill).** When a Player opens a Day Board, reconcile it against their achieved set and write any missing echoes. This self-heals all pre-feature boards without a migration script and mops up any write that was dropped offline.

**Achieved set** = every `itemId` with a confirmed (non-pending) Mark on any of the Player's boards, derived by reading their own `days/{d}/boards/{uid}` docs (≤10 reads, own data, client-side per ADR 0001). No new collection.

**Scoring.** Fold each echoed board through the existing pure mark fold (`computeMark`'s logic, refactored to be callable per-board without UI concerns) and aggregate the deltas into ONE `players/{uid}` write: `squaresMarked` += new echoes, `bingoCount` += newly completed lines across boards, `blackout` if any board completes, `firstBingoAt` stamped only if previously null (same UNKNOWN-vs-null discipline `computeMark` documents). All board + player + Tally writes ride one offline-queueable batch, the same pattern `setMark` uses today.

**Interactions (each is a known seam—handle explicitly):**

- **`markSeed` guard:** every echoed board write must carry *that board's own* current `markSeed`/seed per the stale-write rules gate; never reuse the source board's.
- **Tally (ADR 0002):** each echo writes its per-`(itemId, dayIndex)` Tally marker in the same batch—the mark⇒tally invariant the rules tests assert must hold for echoes too.
- **Moments:** echo-caused bingos/blackouts route through the existing pending-win confirm queue (`enqueueWinMoments` / `ConfirmWinMoments`)—the Player consents before the Feed hears about a wave of auto-wins. Never broadcast directly from the echo path.
- **Reshuffle pristine-ness:** echoes must NOT make a card "non-pristine" (they produced nothing the Player did on that card). The pristine check counts only non-echo Marks—this is why `Cell.echo` must be persisted, not inferred. After a Reshuffle's re-deal, deal-time echo runs again.
- **Claim modes:** only `confirmed` marks echo. In `admin_confirmed` mode, echo fires when the claim is confirmed (extend `confirmClaim` in `data/admin.ts`), not at pending time. Echoed cells are born `confirmed`—they need no second admin pass (the underlying achievement was already confirmed once). Flagged as a decision.
- **Unmark:** unmarking a manual Mark does not cascade to its echoes, and unmarking an echo is allowed (Player disagrees with it on that card)—both simply re-fold that one board's stats, exactly like today. No cascade deletes. (Matches the codebase's existing "deliberately NO cascade" stance—see the `api.ts` comment near the zero-mark card fold.)
- **Doubts:** unchanged—a Doubt targets a mark on a card; echoes are doubtable like any mark.

**Data change:** `Cell.echo?: boolean` (absent = manual). Optional subtle UI: echoed Squares show a small link glyph/dimmer check so a Player understands why a card lit up on arrival (decision below).

## Files to modify

- `src/types.ts`—`Cell.echo?: boolean`. HOT shared file.
- `src/game/logic.ts`—pure helpers: `achievedItemIds(boards)`, `applyEchoes(board, achievedSet)` returning next cells + per-board deltas; unit-testable, no Firebase.
- `src/data/api.ts`—mark-time propagation folded into `setMark`'s flow (read sibling boards, batch echoes + single aggregated player write); deal-time echo in `joinAndDeal` + the Reshuffle re-deal path; open-time reconcile helper.
- `src/data/admin.ts`—`confirmClaim` triggers echo for the confirmed Prompt.
- `src/components/Board.tsx`—call the open-time reconcile; route echo wins through the existing pending-Moment queue; optional echo indicator on cells.
- `firestore.rules`—verify the day-board write gate accepts the echo batch (multi-board writes by the owner, each with its own `markSeed`); extend only if the current gate assumes single-board writes. HOT/protected-adjacent; keep small.
- `CONTEXT.md`—glossary: **Echo Mark**.
- `specs/echo-marks.md` (new)—this design, **with matching tests**.

## Validation (tests are the gate)

- **`logic.ts` unit:** achieved-set derivation (pending excluded, free centre excluded); `applyEchoes` marks only unmarked carriers, is idempotent, computes correct per-board bingo/blackout deltas; a board without P is untouched.
- **API/emulator:** manual mark on P → sibling board carrying P gains `echo: true` cell, Tally marker written, ONE player write with correct aggregate deltas; deal-time: new card arrives pre-echoed; open-time: a stale pre-feature board reconciles on open; `markSeed` respected on every echoed board (stale write rejected by rules); admin_confirmed: no echo while pending, echo on confirm.
- **Moments:** echo-caused win lands in the pending confirm queue, not directly in the Feed.
- **Reshuffle:** an echo-only card still counts as pristine; re-deal re-echoes.
- **Offline (`tests/offline/`):** mark P offline → echoes + stat deltas survive reload and sync on reconnect in the same batch discipline.
- **Regression:** a Player with no repeated Prompts across boards behaves byte-identically to today.

## Acceptance criteria

- **Given** Prompt P confirmed on any of my cards, **then** every other card of mine carrying P shows it marked (`echo`), immediately (mark-time) or on arrival (deal-time) or on open (reconcile).
- **Given** echoes complete new lines, **then** `bingoCount`/`squaresMarked`/`blackout`/`firstBingoAt` update in one aggregated write, and the wins enter the existing confirm-to-Feed queue.
- **Given** admin_confirmed mode, **then** nothing echoes until the claim confirms.
- **Given** a Reshuffle, **then** prior echoes never cost pristine-ness and the fresh card re-echoes.
- **Given** no repeated Prompts, **then** behavior is unchanged.

## Definition of Done

- `specs/echo-marks.md` + matching tests (spec↔test alignment); `npm run typecheck` · `npm test` · `npm run build` · rules + offline suites green.
- Repo gates pass (`repo_lint`, `md-prose-wrap`, review-policy label gate). `types.ts` + `firestore.rules` are hot; expect the review threshold—split rules into its own commit if the PR runs long.
- Conventional commits + `Closes #`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; board discipline per `docs/agents/ticket-workflow.md`.

## Decisions (surface, do not silently override)

- [ ] **Name.** "Echo Mark" (specced; glossary-ready, explains itself in UI copy). Alternatives: carry-over, sync mark.
- [ ] **Echo indicator UI.** Subtle glyph/dimmer check on echoed Squares (specced: yes, minimal) vs. indistinguishable from manual marks.
- [ ] **Echoes skip admin re-confirmation** in admin_confirmed mode (specced: yes—the achievement was confirmed once). Alternative: every echoed cell raises its own claim (strict, noisy).
- [ ] **Tally for echoes** (specced: yes, preserves the mark⇒tally invariant and the "who got it" truth per card). Alternative: manual marks only.
- [ ] **Unmark independence** (specced: no cascades either direction). Alternative: unmarking the source retracts its echoes.
