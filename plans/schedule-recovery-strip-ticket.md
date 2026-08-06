# Schedule: fold per-day fallbacks into a repair line inside the day's row

**Track:** admin/UI · **Phase:** 0 · **Size:** S · **Epic:** Daily Cards (admin console) **Refs:** #221 (Schedule surface), #249 (Unlock now), easy-mix deploy-race fallback, `specs/admin-console-ia.md` § Schedule. Presentation-only—no data model, callable, or gating change. (File keeps its original `recovery-strip` slug; the design iterated to the repair line described below.) **Target mockup:** `plans/daily-cards-wireframes.html` § `#frame-admin-schedule` (caption "Schedule—repair line inside the day that needs it"). This is the parity reference the built UI must match.

## Problem

In `src/components/admin/SchedulePanel.tsx`, `ResnapshotButton` and `UnlockNowButton` render as inline siblings between a Day's `.grow` content and the theme `<select>` (the `ScheduleRow` return). Because the fallbacks appear on only the one eligible Day, that row's dropdown shifts left and a bright button lands mid-row—the schedule reads lopsided (see the current build's Day 4). These are once-a-cruise recovery actions and should not compete with the primary per-row control (the theme dropdown).

## Design (matches the mockup)

Every Day row keeps one uniform shape: `info (grow) + theme <select>`, dropdown trailing on every row, never shifting. A Day that needs a fallback grows a **repair line** inside its own row (in the built card: a full-width line below the Tonight field): the anomaly stated in plain words, then the quiet fix button at the line's end.

- Easy-mix deploy race (`canResnapshot`): "Snapshot predates the easy-mix deploy" → `Re-snapshot`.
- Missed scheduler beat (`dayDueForManualUnlock`): "Missed the 8:00 unlock" → `Unlock now`.
- After a tap, the line carries the existing result/denial message (`Re-snapshotted with both pools.`, `Denied—cards already dealt.`, `Unlocked.`, …) in place of or beside the anomaly text.

Deliberately rejected: a labeled "Recovery" strip between rows (reads as an orphan element; adds a jargon label and icon for a once-a-cruise action) and a kebab menu (hides a panic-moment action behind a popover). The repair line attaches the action to its explanation with zero new chrome. See `#frame-admin-schedule` for exact placement, indent, and copy.

Server semantics are untouched: `resnapshotDayNow` / `unlockDayNow`, their eligibility checks, and their result messages stay exactly as built. This ticket changes placement and adds the anomaly wording only.

## Implementation guidance (from a dry-run against the current code)

- **Sticky mount is required.** `UnlockNowButton` deliberately keeps its "Unlocked." confirmation rendered after eligibility flips false (see its doc comment). A repair line gated purely on `canResnapshot || dueForManualUnlock` would unmount that confirmation on tutorial/early Days, where `canResnapshot` never turns true post-unlock. Keep the line mounted once it has ever been relevant for the row's lifetime (e.g. a `recoveryEverShown` state in `ScheduleRow`).
- **Structure:** outer row gets a scoped modifier (`row schedule-row`, column layout); the top line wraps info + select in a `.schedule-row-top` flex; the repair line is a full-width `<div>` after the Tonight field with `role="group"` and `aria-label={"Day N repair"}` so tests and screen readers have a stable handle. Anomaly text first, button(s) at the trailing edge; let long result messages wrap on narrow screens (flex-wrap) rather than truncate.
- **Existing tests survive:** `src/components/Admin.test.tsx` locates rows via `.closest('.row')` and queries buttons within the row—the repair line stays inside the row, so those queries keep passing untouched.
- **CSS goes in `src/index.css`,** scoped to `.schedule-row*` classes near the `.tonight-input` block. Do not touch the shared `.row`—it serves the leaderboard, prompt pool, and other admin lists.
- **Anomaly copy lives with the component** (two short strings); keep them in `SchedulePanel.tsx` beside the eligibility checks they describe.

## Files to modify

- `src/components/admin/SchedulePanel.tsx`—restructure `ScheduleRow` per the guidance above; add the two anomaly strings. Both button components' callable logic, gating, and messages stay untouched.
- `src/index.css`—scoped `.schedule-row` / `.schedule-row-top` / repair-line styles (column layout, full-width line, dim anomaly text, trailing button, wrap on narrow screens).
- `specs/admin-console-ia.md` § "Schedule / Prompt pool / Players"—update the layout description to the repair-line pattern, naming this ticket and the mockup frame, **with a matching test** (spec↔test alignment; the schedule assertions live in `src/components/Admin.test.tsx`).
- `src/components/Admin.test.tsx`—add a test: the fallback renders inside the `Day N repair` group with its anomaly text; the top line contains no buttons (theme select is the trailing control on every row); an ineligible Day renders no repair line; the result message still appears within the row after a click.
- `tests/e2e/d15-mockup-parity.spec.ts` (+ `-snapshots/`)—if the schedule frame is in the parity walk, refresh the 393×852 baseline once the built UI matches; otherwise note the frame is reference-only.

## Acceptance criteria

- **Given** the Schedule screen, **then** every row shows the theme dropdown in the same trailing position and no row places a control between the Day content and the dropdown.
- **Given** a re-snapshot-eligible Day, **then** its row shows a repair line reading "Snapshot predates the easy-mix deploy" with a quiet `Re-snapshot` button, and results/denials render in the line.
- **Given** a Day due for manual unlock, **then** its row shows "Missed the 8:00 unlock" with `Unlock now`, and the success confirmation remains visible after the unlock lands (sticky mount).
- **Given** an ineligible Day, **then** no repair line renders and the row is a single line.
- **Given** the built Schedule surface, **then** it matches `plans/daily-cards-wireframes.html` § `#frame-admin-schedule`.
- No behavioral change to eligibility, callables, or gating.

## Definition of Done

- `specs/admin-console-ia.md` updated **with a matching test** (spec↔test alignment).
- `npm run typecheck` · `npm test` · `npm run build` green locally; parity screenshots refreshed if the schedule frame is walked.
- Repo gates pass: `repo_lint` (incl. spec↔test alignment), `md-prose-wrap`, review-policy label gate.
- Conventional commits + `Closes #`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; driven to merge.
- Board discipline per `docs/agents/ticket-workflow.md` (claim → In progress; PR → In review; merge → Done).

## Decisions (surface, do not silently override)

- [x] **Pattern.** Repair line inside the day's row—chosen over a labeled between-rows strip (orphan element, jargon chrome) and a kebab menu (hides a panic action). Mockup shows it.
- [x] **Hint text.** The anomaly sentence *is* the hint; no separate tooltip-only copy. The two strings are specified in Design.
- [ ] **Parity scope.** Confirm whether `tests/e2e/d15-mockup-parity.spec.ts` walks `#frame-admin-schedule` (needs a snapshot refresh) or treats it as reference-only.
- [ ] **Anomaly copy.** Confirm the two strings ("Snapshot predates the easy-mix deploy", "Missed the 8:00 unlock") or supply preferred wording.
