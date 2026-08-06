# Share Cards: text-message-first redesign (BINGO, Blackout, Leaderboard)

**Track:** social/share · **Phase:** 0 · **Size:** M · **Epic:** Social core **Refs:** ADR 0005 (on-device share images), `specs/w2-share-cards.md` (the shipped v1 this supersedes visually), `specs/theme-on-color-contrast.md`. Presentation-only—the render pipeline, share sheet fallback chain, eager pre-render, analytics, and validity gates are all untouched. **Target mockups (the parity reference):** `plans/daily-cards-wireframes.html` § "Share Cards—text-message-first redesign"—frames `#frame-share-bingo`, `#frame-share-blackout`, `#frame-share-leaderboard`, drawn at half scale (300×375 = the rendered 600×750) in three day themes. The built cards must match these compositions. **Suggested runner:** Claude Sonnet 5, medium reasoning effort (well-scoped presentational change with a pinned mockup and an existing 39-test harness; see Validation).

## Problem

The shipped Share Cards (`src/components/ShareCard.tsx`, 600×750 @3x) are data-dense: the BINGO card renders all 25 board cells *with their prompt text*, a modest title, and a small player name; the Leaderboard card is a uniform list. In an iMessage/WhatsApp bubble the image displays ~300px wide—prompt text turns to gray noise, the brag disappears, and the card reads like a report, not a flex. These images exist to be dropped into a group chat (ADR 0005); the thumbnail *is* the product.

## Design (matches the three frames)

One rule drives everything: **readable at bubble size**. The word and the name are the picture; the board is shape, not data.

- **BINGO** (`#frame-share-bingo`): context line ("Gay Cruise Bingo · Day 4 · Valletta"), giant `BINGO!`, giant player name in accent, then the board as a **textless** 5×5 of squares—marked squares filled with the theme gradient, the **winning line additionally outlined + glowing**, free centre in accent, unmarked squares near-invisible. One stat line ("Bingo #2 · 16 squares · 💦 Splash T-Dance night"), hairline footer branding.
- **Blackout** (`#frame-share-blackout`): identical composition, title `BLACKOUT`, every square lit, stat "All 24 squares · <night>".
- **Leaderboard** (`#frame-share-leaderboard`): title `LEADERBOARD`, **top three as a podium** (rank baked into the bars, ★ First-BINGO pin above its holder, names + bingo counts), ranks 4–5 as compact rows, "Through Day N of 10" dating the snapshot, footer branding. Caps at five rows (the caller already shapes rows; the renderer splits podium/rows).
- Canvas stays **600×750 @ pixelRatio 3** (4:5 is right for chat bubbles). A 2px theme-primary border keeps the card popping against both light and dark chat backgrounds.
- Theming: cards keep inheriting the live `[data-theme]`; gradient fills keep `--on-gradient` for any on-gradient glyphs and `--ink` borders (`specs/theme-on-color-contrast.md`). Textless squares eliminate the per-cell text-contrast problem entirely.
- **Pending squares keep their semantics**: a marked-but-unconfirmed square (admin_confirmed mode) renders faded/dashed, never as a solid win—same rule the current card enforces, now in textless form.

## Implementation notes (from the current code)

- `src/components/ShareCard.tsx`—changes confined to `buildBingoCardNode` / `buildLeaderboardCardNode` (the DOM builders) plus small data additions. `rasterize`, `mountOffscreen`, `shareCardBlob`, `isUserCancelledShare`, the 25-cell validity gate, and `PIXEL_RATIO`/dimensions stay byte-identical.
- **Winning line needs no new caller data**: derive it inside the builder with `completedLines(cells)` from `src/game/logic.ts` (pure, already exported); light every cell on any completed line. Blackout is already distinguished by `kind`.
- **New optional fields, composed by callers**: `contextLine?: string` (day + port) and `statLine?: string` on both card data types; `Celebration.tsx` and `Leaderboard.tsx` build them from data they already hold (`useEventDoc` days, player stats). Absent fields render nothing—the renderer stays dumb.
- CSS: rework the `.share-card-*` block in `src/index.css` (~2555–2690). The off-screen host and class-inheritance approach are unchanged.
- Eager pre-render (Celebration at mount, Leaderboard warm on hover/press) is untouched—same functions, new insides.

## Validation (tests are the gate—see the frames for what "right" looks like)

- `src/components/w2-share-cards.test.tsx` (39 tests) is the harness; most assert the pipeline and fallback chain and must keep passing untouched. Update only the DOM-composition assertions:
  - Board squares are **textless** (no prompt text in any `.share-card-cell`; the old assertions that cell text renders flip to asserting its absence).
  - Cells on a completed line carry the line class (fixture board + `completedLines` as the oracle); blackout renders all 24 lit; the free centre keeps its accent class.
  - A `pending` square keeps a distinct class and is never rendered as a plain win square.
  - Leaderboard: first three rows render in the podium (rank text preserved from `row.rank`, no renumbering), remainder as rows; ★ pin only on `firstToBingo`; renderer renders exactly the rows given.
  - `contextLine`/`statLine` render when provided, are absent otherwise.
  - Unchanged and re-asserted: the 25-cell validity gate throws; `shareCardBlob`'s outcomes; `share_click` fires once per tap from the callers.
- `specs/w2-share-cards.md`—update the composition description to the new design and point it at the three frames (spec↔test alignment keeps the spec honest against the updated test file).
- Manual/visual: render each card in at least three themes (one light—summer-white—to catch ink-on-light regressions) and eyeball at 300px width; the parity bar is the three wireframe frames.
- `tests/e2e/d15-mockup-parity.spec.ts` walks app screens, not share images; no baseline refresh expected. Flag if that changed.

## Acceptance criteria

- **Given** a BINGO, **then** the generated PNG matches `#frame-share-bingo`: giant title + name, textless board with the winning line lit brighter than other marks, context + stat lines, at 600×750 @3x.
- **Given** a Blackout, **then** it matches `#frame-share-blackout` (all squares lit, title swap, stat "All 24 …").
- **Given** a Leaderboard share, **then** it matches `#frame-share-leaderboard`: podium top-3 with ranks and ★ pin, compact rows 4–5, "Through Day N" line.
- **Given** any of the ten day themes, **then** text and fills keep their contrast contracts (no ink-on-light or on-gradient regressions); pending squares never read as wins.
- **Given** the share flow, **then** behavior is unchanged: same functions, same fallback chain, same analytics, same validity gate.

## Definition of Done

- `specs/w2-share-cards.md` updated **with matching tests** (spec↔test alignment); `npm run typecheck` · `npm test` · `npm run build` green locally.
- Repo gates pass (`repo_lint`, `md-prose-wrap`, review-policy label gate); conventional commits + `Closes #`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; board discipline per `docs/agents/ticket-workflow.md`.

## Decisions (surface, do not silently override)

- [ ] **Stat-line copy.** Frames show "Bingo #2 · 16 squares · <night>" and "Through Day 5 of 10". Confirm or supply preferred wording; callers own the strings.
- [ ] **Multiple completed lines.** Lighting *all* completed lines (as specced, via `completedLines`) vs. only the newest line (needs the pre-mark board to diff; more caller plumbing). Specced: all lines—simpler and reads as a bigger flex.
- [ ] **Leaderboard row cap.** Frames show 5 (podium + 2). The current caller may pass more; confirm the renderer should truncate at 5 or render what it is given (specced: render what it is given; caller shapes to 5).
