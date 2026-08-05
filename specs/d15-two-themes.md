---
spec_id: d15-two-themes
status: accepted
---

# Two new Themes: welcome-aboard / so-long-farewell (`d15-two-themes`)

Implements `plans/daily-cards-spec.md` § "Theme reference" and its "Proposed palettes for the two new themes" — the two tutorial-Day Themes (`welcome-aboard` for the opening Day, `so-long-farewell` for the closing Day) as full `ThemeMeta` entries plus `[data-theme]` token blocks in `src/theme/themes.css`. `ThemeMeta.description` itself (the field, and the eight existing Themes' copy) was added by `d15-schema-contract` (#200/#204); this ticket only appends the two new entries and their CSS blocks.

## Contract

- `src/theme/themes.ts` — `THEMES` gains two entries, appended after `seriously-pink` so no existing index shifts and `neon-playground` stays first/default:
  - `welcome-aboard` — label "Welcome Aboard", description verbatim from the spec's Theme reference table: "You made it. Learn the game, find the soft-serve, wave goodbye to land."
  - `so-long-farewell` — label "So Long, Farewell", description verbatim: "Last one. Mark your goodbyes—then go book next year."
  - Both names are confirmed (spec Resolved decisions #3) — not renamed.
- `src/theme/themes.css` — two new `[data-theme]` blocks, palettes verbatim from the spec's "Proposed palettes for the two new themes" (nautical navy/cyan/brass for `welcome-aboard`, dusk plum/coral/peach for `so-long-farewell`). Both palettes clear the existing 4.5:1 WCAG AA contrast suites as proposed — see "Contrast verification" below — so neither needed the deepen-within-family fallback the spec allows.
- Purely cosmetic: no gameplay branches on `ThemeId` in this ticket.

## Acceptance criteria

- **Given** the `welcome-aboard` and `so-long-farewell` `[data-theme]` blocks, **when** `w1-themes.test.tsx` runs, **then** both clear the same WCAG AA 4.5:1 pairs the existing eight Themes clear, with no suite changes needed beyond the new blocks (that suite iterates `THEMES` and parses `themes.css` at test time, so it picks up the two new entries automatically).
- **Given** the `.tally-badge` / `.doubt-badge` overlays, **when** `a11y-badge-contrast.test.tsx` runs against the two new Themes, **then** both clear 4.5:1 (same auto-pickup mechanism).
- **Given** any `THEMES` entry, **when** its `description` is read, **then** it is non-empty and matches the spec's Theme reference table verbatim (covered by `d15-schema-contract.test.ts`'s existing description-presence check, which also iterates `THEMES`).
- `ThemeMeta.description` exists and is populated for all ten Themes.
- `themes.css` new tokens pass the 4.5:1 contrast suites with zero suite edits.
- Theme names remain exactly "Welcome Aboard" / "So Long, Farewell".

## Test coverage

`src/theme/d15-two-themes.test.ts` (Vitest, pure-logic unit): asserts both new `THEMES` entries exist with the exact label/description text above, asserts both `[data-theme]` blocks exist in `themes.css` with the exact token values from the spec's proposed palettes, and re-verifies (independent of `w1-themes.test.tsx`) that every `TEXT_PAIRS` combination for the two new Themes clears the 4.5:1 floor — so this spec's contrast claim doesn't just ride the existing suite's auto-pickup, it has its own direct assertion.
