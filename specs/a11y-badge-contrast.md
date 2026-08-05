---
spec_id: a11y-badge-contrast
status: accepted
---

# a11y-badge-contrast — marked-Square overlay badges keep their white numerals at WCAG AA on every Theme

Two small circular overlay badges sit on a marked Square and fill their numeric text with a literal `#fff`, independent of the active Theme: `.tally-badge` (the per-Prompt Mark count, bottom-right, [w2-tally](w2-tally.md)) and `.doubt-badge` (the open-Doubt count, top-left, [w2-doubts](w2-doubts.md)). Their backgrounds are Theme-derived, so on the lightest Themes the composited backdrop rose close enough to white that the white numerals fell under the contrast floor. This spec is those two badges' WCAG contrast contract; the fix darkens each background just enough to keep `#fff` legible on **every** Theme in the registry.

## Scope and relationship to w1-themes

[specs/w1-themes.md](w1-themes.md) § WCAG AA contrast contract governs the Theme **tokens** — the foreground/background pairs `src/index.css` assigns as flat custom-property `color` values (`--ink`/`--dim`/`--primary`/`--secondary`/`--accent` on their surfaces). It deliberately does **not** reach into `src/index.css`'s composited overlays, and it explicitly enumerates the hardcoded-`#fff` spots it leaves as a tracked follow-up (`.cell.marked` + its `::after`, `.celebrate .big`, `.signin h1`). These two overlay badges are the same class of hardcoded-`#fff` defect on a *composited* background, and were not in that contract's token inventory. This spec covers them; it does not re-open the w1-themes token audit.

## The floor: 4.5:1 (informational numeric text)

Each badge shows a **count** — real, information-bearing text, not a decorative glyph — so it is held to WCAG 2.1 **1.4.3 Contrast (Minimum), 4.5:1** (normal text), the same floor w1-themes applies to the equally small leaderboard rank numerals, rather than the looser 3:1 non-text / UI-component floor (1.4.11). The fix clears 4.5:1 on every Theme with margin. The suite iterates `THEMES` and re-derives the ratios from `themes.css` at test time, so the worst case is computed rather than recorded here — the count in this spec went stale twice (the tutorial Themes, then the Bodega ones), so it now states the rule instead of a number. As of #555 the binding case is still `get-sporty` at 4.92:1.

## The defect and the fix

Every ratio below is `#fff` against the badge's **composited** background, computed (not hand-transcribed) from `themes.css`'s `--primary`/`--secondary` and `index.css`'s badge declarations.

| Theme | `.doubt-badge` (mix weight 78% → 45%) | `.tally-badge` (scrim α 0.40 → 0.55) |
|---|---|---|
| neon-playground | 2.54 → **6.51** | 4.12 → **6.51** |
| get-sporty | 1.77 → **4.92** | 2.97 → **4.92** |
| duty-free | 4.31 → **9.47** | 6.55 → **9.47** |
| glamiators | 3.83 → **8.71** | 4.32 → **6.79** |
| summer-white | 8.17 → **13.77** | 10.48 → **13.41** |
| dog-tag | 4.53 → **9.71** | 5.00 → **7.65** |
| revival-disco | 5.63 → **11.22** | 6.33 → **9.21** |
| seriously-pink | 3.08 → **7.49** | 4.87 → **7.49** |

(`.tally-badge` figures are the worse of the two gradient ends — see below.)

### `.doubt-badge` — an opaque darkened-`--secondary` chip

Background: `color-mix(in srgb, var(--secondary) 45%, #000)` (was `78%`). The mix is **opaque**, so its result *is* the painted background — nothing beneath bleeds through and no gradient compositing applies. At 78% the chip stayed too light for white text wherever `--secondary` is light: get-sporty (`--secondary: #eaffef`) hit **1.77:1** and neon-playground's cyan (`#00e6ff`) **2.54:1**, both under even the 3:1 floor. Dropping the `--secondary` weight to 45% darkens the chip uniformly (dark-`--secondary` Themes only gain contrast), keeping a visible secondary tint — the "social-heat tone distinct from the neutral Tally count" [w2-doubts](w2-doubts.md) calls for — while landing every Theme ≥ 4.5:1. A per-Theme token was rejected: it would add a hand-tuned value per Theme — a list that grows with every Edition — for a defect a single weight change fixes structurally.

### `.tally-badge` — a translucent black scrim, so alpha compositing matters

Background: `rgba(0, 0, 0, 0.55)` (was `0.4`), painted over the marked-cell gradient `linear-gradient(145deg, var(--primary), var(--secondary))`. Because the scrim is **translucent**, its composited color depends on the gradient point beneath the badge — this is the alpha-compositing case the token-only view misses. The badge sits bottom-right (the `--secondary` end), and on get-sporty the near-white `--secondary` (`#eaffef`) bled through a 0.4 scrim to **2.97:1**. Raising the scrim to 0.55 darkens the composite everywhere and clears 4.5:1. Luminance along a straight sRGB line is convex, so it peaks at an endpoint; checking `#fff` against the scrim over **both** `--primary` and `--secondary` bounds the entire gradient (and keeps the badge safe wherever it lands should the 145° angle ever change). The scrim stays translucent so the colorful Square still glows through.

### `.proofbtn` remains exempt

The sibling `.proofbtn` scrim (`rgba(0, 0, 0, 0.35)`, bottom-left over the `--primary` end) is out of scope and left unchanged: it renders a `＋` action glyph, not information-bearing numeric text, so the 3:1 UI-component floor is the applicable bar, and it clears it on every Theme (worst 3.15:1, get-sporty). If it is ever repurposed to carry a count, it joins this contract.

## Acceptance criteria

- **Given** any Theme in the registry, **when** a Square is marked, **then** the `#fff` text of both `.tally-badge` and `.doubt-badge` meets WCAG 2.1 AA 4.5:1 against its composited background.
- **Given** `.tally-badge`'s translucent scrim over the marked-cell gradient, **when** contrast is evaluated, **then** it holds at both gradient ends (`--primary` and `--secondary`), bounding the whole gradient.
- **Given** `.doubt-badge`'s opaque `--secondary`/`#000` mix, **when** `--secondary` is a light color (get-sporty, neon-playground), **then** the chip is dark enough for white text while still reading as a secondary-derived tint.

## Test coverage

`src/theme/a11y-badge-contrast.test.tsx` (Vitest, jsdom project):

- Parses `--primary`/`--secondary` from `themes.css` and the badge `color` + background declarations from `index.css` at test time (no hand-transcribed color table), so a Theme retint, a mix-weight tweak, or a scrim-alpha change re-derives the ratios.
- Asserts each badge fills its text with `#fff` over the expected background form (the parse premise), then that `#fff` meets 4.5:1 for every `ThemeId` — `.doubt-badge` against the opaque mix, `.tally-badge` against the scrim composited over **both** gradient ends.
- Asserts `.cell.marked`'s background is a `--primary`→`--secondary` gradient, so the two-endpoint check stays valid.

The WCAG relative-luminance / contrast-ratio math and the sRGB `color-mix` / alpha-composite helpers live in `src/theme/contrast.ts`, shared with `src/theme/w1-themes.test.tsx` so both suites compute from one implementation.
