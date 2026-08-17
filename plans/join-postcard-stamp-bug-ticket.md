# Bug: join postcard renders an empty stamp box in production

**Track:** play/UI · **Severity:** cosmetic, but on the entry surface of the live Bodega Bay event — every new player sees it before sign-in. Ship as a hotfix-sized PR. **Size:** XS **Refs:** `plans/daily-cards-wireframes.html` § `#frame-vacay-join` (the parity target — its CSS comment and caption now carry the spacing contract), fiveacrossbingo PRD § Brand Identity and Expression. **Suggested runner:** Claude Sonnet 5, low reasoning effort (conditional-render fix with a pinned parity target and enumerated root-cause candidates).

## Problem

The Vacay join screen's postcard has a dashed "stamp corner" that has now shipped in three states, two of them wrong:

1. **Empty dashed box** (first report) — read as a rendering bug.
2. **Oversized emoji overflowing a fixed-size box**, with postcard text running beneath the stamp (second report, after the postage emoji was added).
3. **Empty dashed box again** (current production) — a regression: the box renders with no postage in it. This is the exact state the wireframe now forbids.

## The invariant (from the parity target — do not re-derive)

`#frame-vacay-join`'s CSS comment and caption specify the whole contract:

- The stamp box is **content-sized**: padding wraps the Day-emoji postage (`line-height: 1`); never a fixed width/height the glyph can overflow.
- The postcard **reserves its stamp corner** (right padding) so text wraps short of the stamp and never runs beneath it.
- The Day's emoji **is** the postage. **If no Day emoji resolves, render no stamp element at all and drop the reserved padding.** An empty dashed box must be unreachable, not merely unlikely.

## Likely root causes (check in this order)

- The stamp element renders unconditionally while the emoji expression resolves to `undefined`/`''` — e.g. the current Day lookup returns nothing pre-unlock, post-trip, or while the event doc is loading, and the JSX still emits the bordered element around empty content.
- The emoji is sourced from a field the Bodega seed does not populate (e.g. reading a dedicated `stampEmoji` that was never seeded, instead of the Day's existing emoji field the schedule/day chips already use — reuse their exact source).
- The stamp is a CSS `::before`/`::after` with a border but content supplied separately, so the border survives when the content path fails.

Also verify state 2's fix actually landed (content-sized box + reserved padding); if production still has fixed dimensions, fix both in this pass.

## Fix requirement

One conditional and two CSS rules, per the invariant: render the stamp element only when the resolved Day emoji is a non-empty string; size the box by padding around the glyph; apply the postcard's reserved right padding only when the stamp renders. No new props, no model changes; source the emoji from the same field the Day chips render.

## Validation

- **RTL:** with a Day that has an emoji → the stamp element exists and its text content is that emoji (non-whitespace); with no resolvable Day emoji (locked/loading/absent-field fixtures) → **no stamp element in the DOM** and no reserved-padding class/style on the postcard. These two tests make state 1/3 unreachable.
- **Visual:** join screen at 393px in the Bodega theme matches `#frame-vacay-join` — postage inside the box, text never under the corner; check the light `fog-froth-farewells` theme too.
- Spec↔test alignment: add the assertions to the join screen's existing spec/test pair (or the vacay join spec if one landed with the build); update `tests/e2e/d15-mockup-parity.spec.ts` baselines only if the join frame is in its walk.

## Acceptance criteria

- **Given** the live Bodega join screen on any Day, **then** the stamp shows the Day's emoji inside a box that wraps it, or no box at all — an empty dashed rectangle can no longer render.
- **Given** the stamp renders, **then** postcard text never runs beneath it at any viewport ≥ 320px.
- **Given** the fix, **then** production is verified by loading `bodega-bay.vacaybingo.com` fresh (not just the emulator) — this is a live-event hotfix.

## Definition of Done

Tests above green; `npm run typecheck` · `npm test` · `npm run build` green; repo gates pass; conventional commit + `Closes #`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}` (XS — under-threshold self-review path applies); board discipline per `docs/agents/ticket-workflow.md`; deployed and eyeballed in production during the event.
