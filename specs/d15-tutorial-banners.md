---
spec_id: d15-tutorial-banners
status: accepted
---

# Opening/closing tutorial banners + "Warm-up" tag (`d15-tutorial-banners`)

> **Vocabulary note (#565/#566):** this spec's persisted-contract language was updated for the neutral vocabulary — Day/Event fields `place`/`placeEmoji` and `startsOn`/`endsOn` (legacy `port`/`portEmoji`, `sailStart`/`sailEnd` coerced on read by `eventConverter`), and Pool values `easy`/`closing` (both live Events still PERSIST the legacy `embark`/`farewell` spellings; reads normalize via `migratePool`/`normalizePool`, rules accept both, and writes keep emitting the legacy values until the post-Event cleanup).


Implements `plans/daily-cards-spec.md` § "Embark (tutorial) view" and § "Farewell view" (the banners only—the closing view's podium banner is #217's content, this ticket owns only the goodbye banner beneath it), plus the "Warm-up" tag mentioned in both sections and in § "Tutorial days" under Scoring. Depends on `d15-day-switcher` (#205, the Day-scoped board view this ticket's banners mount inside), `d15-two-themes` (#206, the `welcome-aboard` / `so-long-farewell` Themes the tutorial views retint to), and `d15-tutorial-seed` (#207, `DayDef.tutorial` and the `pool: 'embark' | 'farewell'` this ticket branches on). Guarded by `src/components/TutorialBanner.test.tsx` and `src/components/DaySwitcher.test.tsx` / `src/components/Board.test.tsx` (RTL jsdom).

## Contract

- `src/components/TutorialBanner.tsx` (new)—default export `TutorialBanner({ day }: { day: DayDef })`: renders nothing when `!day.tutorial`; renders the opening banner when `day.pool === 'embark'`; renders the closing banner when `day.pool === 'farewell'`. Branches on `day.pool` rather than `day.index` so the banner tracks the seeded itinerary data instead of assuming the tutorial Days sit at fixed positions. Also exports `WarmUpTag`, a small shared "Warm-up" pill used at both mount points below.
  - **Opening banner**: the three-beat "How this works" copy, verbatim from the spec, plus the warm-up caption underneath. That caption is TWO pieces: the Edition's flavor clause (`tutorialWarmupNote`, whole-string per Edition per #608—"all on the ship" has no occasion-neutral skeleton) followed by a DERIVED schedule sentence, "The real chaos starts `<day>` at `<hour>`" (`chaosLine`, `src/unlockCopy.ts`, #670). Both halves of that sentence come from the first `pool: 'main'` Day's own `unlockAt`, read in the Event timezone—selected on the pool, never re-derived as `!tutorial`, since a schedule can open with a competitive easy Day that is not tutorial and carries the `unlockAt: 0` open sentinel (Bodega Bay's Friday), which a `!tutorial` predicate would pick and read as long unlocked—it originally hardcoded "tomorrow at 8" and so contradicted any schedule opening at another hour, exactly as the locked-Day caption did (#669). The day part adapts ("later today" / "tomorrow" / "Saturday" / "Sat, Aug 15") and the hour follows the same spoken-hour rules as the locked-Day caption (bare inside a morning, meridiem spelled out otherwise). The sentence is DROPPED entirely—leaving the flavor clause alone—when there is no schedule, no main Day, or the first main Day has already unlocked; that last case is the ordinary state of the More → How to play replay mid-Event, where a promise about chaos that started days ago is worse than silence. It also stays LIVE while mounted: `nextChaosBoundary` names the next instant the sentence could change—Event-zone midnight ("tomorrow"→"later today") or the unlock itself (retire)—and the caption re-renders there and re-arms, with a `visibilitychange` catch-up for a backgrounded tab whose timer fired late or never. Both mount points are routinely left open across those boundaries. Dismissible—tapping anywhere on the banner (or pressing Enter/Space while it's focused, `role="button"`) hides it for the rest of that mount. Dismissal is plain component state, not persisted (localStorage or otherwise): the spec explicitly does not require it to survive beyond the session the way the first-open coach overlay's dismissal does, since it's replayable from More → How to play (#208).
  - **Closing banner**: the goodbye copy, verbatim. No dismiss affordance and no interactive role—`role="note"`, plain markup.
- `src/components/Board.tsx` (modified)—mounts `<TutorialBanner day={viewedDay} />` above the grid inside `.board-area`, and a `.board-header` div carrying `<WarmUpTag />` above it, both gated on `viewedDay?.tutorial`. The locked-Day preview (`LockedDayPreview`) also renders `<WarmUpTag />` next to its day-locked title when `day.tutorial`, since the closing Day can still be in its locked state before its standard 08:00 unlock.
- `src/components/DaySwitcher.tsx` (modified)—renders `<WarmUpTag />` on a Day chip when `d.tutorial`, alongside the existing weekday/port/theme/glyph markup.
- `src/index.css` (modified)—`.warm-up-tag`, `.board-header`, and `.tutorial-banner*` styling, theme-token-driven (`var(--ink)`, `var(--primary)`, `var(--cell)`, `var(--dim)`) so the banner and tag retint with the viewed Day like the rest of `.board-area`.

## Resolved defaults (no open decisions)

- **Opening vs. closing dispatch**: `day.pool` (`'easy'` | `'closing'`), not `day.index`—both tutorial Days are flagged `tutorial: true`, so a second signal is needed to pick the banner; `pool` is the existing field that already distinguishes them one-to-one.
- **Dismissal persistence**: session-only, plain `useState`—no localStorage key. The ticket body is explicit that this banner's dismissal need not persist "beyond the session the way the coach overlay's does."
- **Board-header slot**: since #212 (the daily-honor pin) has not landed yet, this ticket establishes the `.board-header` slot's DOM position—a single row above `.bingo-head`, rendered only when the viewed Day is a tutorial Day. #212 will mount its own pin in the same position for the eight main Days; the two are mutually exclusive on `DayDef.tutorial`, so they cannot collide independently of each other.

## Acceptance criteria

- **Given** a Player views the Welcome Aboard Day for the first time in a session **When** the card renders **Then** the three-beat banner and warm-up caption show above the grid, and tapping the banner dismisses it for that session.
- **Given** a Player views the So Long, Farewell Day **When** the card renders **Then** the non-dismissible goodbye banner shows beneath wherever the podium banner mounts.
- **Given** either tutorial Day **When** its chip or board header renders **Then** it shows a "Warm-up" tag instead of a daily-honor pin.
- Opening banner copy matches the spec verbatim (three beats + caption).
- Closing banner copy matches the spec verbatim.
- Neither banner renders on any of the eight main Days.
- The opening banner is dismissible per session; the closing banner is not.

## Test coverage

`src/components/TutorialBanner.test.tsx` (RTL jsdom): the opening banner renders all three beats + the warm-up caption on the Welcome Aboard Day and dismisses on tap; the closing banner renders the goodbye copy on the So Long, Farewell Day with no dismiss affordance; neither banner renders on a non-tutorial Day; `WarmUpTag` renders the "Warm-up" label.

`src/components/DaySwitcher.test.tsx`: the "Warm-up" tag renders on exactly the two tutorial Day chips (index 0 and the last index) and never on the eight main Days.

`src/components/Board.test.tsx`: an unlocked, dealt Welcome Aboard Day mounts both the opening banner and the "Warm-up" `.board-header` tag; an unlocked main Day mounts neither.
