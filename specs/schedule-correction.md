---
spec_id: schedule-correction
status: accepted
---

# Schedule correction: unified day themes + two-event Tonight lines (`schedule-correction`)

Implements `plans/daily-cards-spec.md` § "Itinerary and schedule" (corrected 2026-07-17) and `plans/schedule-correction-ticket.md`. The published July 2026 itinerary differs from what was seeded: some days run two parties under one **unified day theme**, ports moved (Sea Day is Day 3, Valletta Day 4, Palermo Day 5, Naples Day 6, Rome Day 7, Villefranche Day 8, Marseille Day 9), and five unified themes are new. This is **display metadata only** — the correction re-labels the cards and never touches boards, cells, marks, tallies, proofs, doubts, moments, dayStats, Event totals, snapshots, pools, unlock times, dates, or day indexes. Theme is cosmetic by design, so already-dealt Day 1–3 cards keep their exact prompts and marks and simply re-render under corrected chrome.

## Model

Each `DayDef` keeps ONE `theme: ThemeId` (drives chrome, palette, chips, honors emoji) and gains `tonight: string[]` — EXACTLY two signature events with emoji, rendered as a "Tonight:" line in the day bar and the locked-day tease. The two events are parties when the day has them, else the night's headline show/concert plus its party, sourced from the VB26 vacation guide's Entertainment Preview. Day 10's line is editorial (the closing morning publishes no events).

## Corrected itinerary

| Day | Date | Port | Unified theme (ThemeId) | Tonight (two events) |
|-----|------|------|-------------------------|----------------------|
| 1 | 2026-07-15 | 🇮🇹 Trieste | 🛳️ Welcome Aboard (`welcome-aboard`) | ⛵ Sail-Away Party · 🎉 Welcome Party |
| 2 | 2026-07-16 | 🇭🇷 Split | 🌍 Uniforms Without Borders (`uniforms-without-borders`) | 🪖 Dog Tag T-Dance · ✈️ Duty Free |
| 3 | 2026-07-17 | 🌊 Sea Day | 💖 Neon Pink Playground (`neon-pink-playground`) | 💖 Seriously Pink T-Dance · 🌈 Neon Playground |
| 4 | 2026-07-18 | 🇲🇹 Valletta | 💦 Sporty Splash (`sporty-splash`) | 💦 Splash T-Dance · 🏋️ Get Sporty |
| 5 | 2026-07-19 | 🇮🇹 Palermo (Sicily) | 🌌 Under the Stars (`under-the-stars`) | 🎭 AirOtic · 🌌 Under the Stars |
| 6 | 2026-07-20 | 🇮🇹 Naples (Pompeii) | 🏛️ Glamiators (`glamiators`) | 🎤 Solea Pfeiffer · 🏛️ Glamiators |
| 7 | 2026-07-21 | 🇮🇹 Rome (Civitavecchia) | 🏺 Dance Classics (`atlantis-classics`) | 🎭 Persephone · 🏺 Dance Classics |
| 8 | 2026-07-22 | 🇫🇷 Villefranche (Nice) | 🤍 Summer White (`summer-white`) | 🎤 HAYLA · 🤍 Summer White Party |
| 9 | 2026-07-23 | 🇫🇷 Marseille | 🪩 Revival! Classic Disco (`revival-disco`) | 🪩 Revival! Classic Disco T-Dance · 🎉 Last Dance |
| 10 | 2026-07-24 | 🇪🇸 Barcelona | 👋 So Long, Farewell (`so-long-farewell`) | 🧳 Disembark in Barcelona · 👋 Until next year |

**Brand-mark paraphrase.** The `w1-themes` non-goal keeps the "Atlantis" mark out of user-facing copy (the same reason `summer-white`'s guide blurb ships as "The pinnacle white party"). So the ThemeId `atlantis-classics` keeps its id (ids are not user-facing) but its label is "Dance Classics" and its description drops the mark; the guide's "Atlantis Welcome Party" and "Atlantis Classics" ship in `tonight` as "🎉 Welcome Party" and "🏺 Dance Classics". Every `tonight` line is asserted markless.

## Contract

- `src/types.ts` — `ThemeId` gains five unified ids (`uniforms-without-borders`, `neon-pink-playground`, `sporty-splash`, `under-the-stars`, `atlantis-classics`); `DayDef` gains a required `tonight: string[]`. The five superseded party ThemeIds (`get-sporty`, `duty-free`, `dog-tag`, `seriously-pink`, `neon-playground`) stay valid — they still back the theme switcher, saved player preferences, and `neon-playground` stays the app default.
- `src/theme/themes.ts` — `THEMES` gains five `ThemeMeta` entries, appended after the two tutorial themes so no existing index shifts and `neon-playground` stays first/default. Descriptions track the spec's Theme reference, paraphrased where a brand mark would otherwise leak.
- `src/theme/themes.css` — five new `[data-theme]` blocks, palettes verbatim from the spec's proposed palettes. All five clear the existing 4.5:1 WCAG AA text and on-color suites as-proposed (those suites iterate `THEMES` / parse `themes.css` at test time, so they pick up the new blocks automatically).
- `src/components/Board.tsx` — `DayBar` renders a "Tonight:" line from `day.tonight`, shared by the dealt board and `LockedDayPreview` so the two can't drift. A defensive guard renders no line when `tonight` is missing or empty, so legacy Event docs and cast fixtures never throw.
- `src/data/seed.ts` + `scripts/seed.mjs` — the canonical ten-Day schedule updated to the corrected itinerary above (ports, unified themes, `tonight`). Dates, pools, tutorial flags, `unlockAt`, and `freeText` are unchanged; the two literals stay in sync (the `d15-tutorial-seed` guard asserts `EVENT_SEED.days` deep-equals `DAYS`).
- `src/data/admin.ts` — `setDayTonight(days, dayIndex, tonight)`, the same surgical merge-onto-current-array transaction as `setDayTheme`.
- `src/components/Admin.tsx` — the Schedule editor renders a "2 parties" pill on multi-party days and an editable "Tonight:" text field per Day; both the theme dropdown and the tonight field are disabled on already-unlocked/past Days (the server lock is `firestore.rules` `daySchedUnchanged`, which clamps `theme`/`unlockAt`; the editor's disable is the courtesy). The already-unlocked Days 1–3 are corrected by the owner migration, not the editor.
- `scripts/migrate-schedule-2026-07-17.mjs` — a one-time owner-run Admin-SDK migration (dry-run by default). Its pure planning core (`planScheduleMigration`, `diffDay`, `correctDay`) is import-safe and unit-tested. Filed as `.mjs` (not the ticket's `.mts`) to match every existing Admin-SDK script and because no TypeScript runner is installed.

## Migration

Because Days 1–3 are already unlocked, the Admin Schedule editor and `firestore.rules` correctly refuse to change their `theme`, so the correction lands via the service account (bypasses rules; no rules change). The script:

- **Dry-runs by default** — it prints a full before/after diff of only `theme` / `port` / `portEmoji` / `tonight` and writes nothing unless `--apply` is passed.
- **Preserves game state** — the Day written back is the LIVE Day with only those four fields overwritten from the target, so `unlockAt`, `date`, `pool`, `tutorial`, `freeText`, and any scheduler-stamped `snapshotItemIds` are carried through byte-for-byte.
- **Fails closed** — it refuses to run if any Day's immutable field (`index`, `date`, `pool`, `tutorial`, `unlockAt`, `freeText`) has drifted from the target, if the Day count mismatches, or if the write would change any field outside the allowed four.
- **Is idempotent** — a second run reports "already correct" and writes nothing.

## Acceptance criteria

- **Given** the corrected seed, **when** the mapping is read, **then** Days 1–10 carry the ports, unified themes, and two-event `tonight` lines in the table above, `EVENT_SEED.days` stays in sync with `DAYS`, and no `tonight` line contains the Atlantis mark.
- **Given** any day card, **when** it renders, **then** the "Tonight:" line shows its two events; **and** the locked-day preview shows the same tease.
- **Given** the five new `[data-theme]` blocks, **when** the contrast suites run, **then** all five clear the same 4.5:1 pairs the existing themes clear, with no suite edits.
- **Given** the live event after the migration, **then** every board, mark, tally, proof, and stat is unchanged (the migration touches only `theme`/`port`/`portEmoji`/`tonight`), and Day 4's 08:00 unlock deals exactly as it would have.
- **Given** a player whose saved theme is a superseded ThemeId (e.g. `get-sporty`), **then** their choice still works, and Auto—match the day resolves to the new unified ThemeIds.

## Test coverage

- `src/data/schedule-correction.test.ts` — the corrected day → theme/port/portEmoji/tonight mapping asserted against the seed, exactly-two-entries per day, the no-Atlantis-mark guard on every `tonight` line, and the migration planning core (corrects the old live schedule with no forbidden change, preserves the scheduler snapshot and every immutable field, is idempotent, and refuses on immutable-field drift / date shift / count mismatch).
- `src/components/d15-day-card-render.test.tsx` — the "Tonight:" line renders with both events on the dealt card and on the locked-day preview tease.
- `src/components/Admin.test.tsx` — the "2 parties" pill on a two-party day (and its absence on a show+party day and a tutorial day), the editable Tonight field invoking `setDayTonight`, and its disabled state on an unlocked Day.
- `src/theme/d15-two-themes.test.ts` — the tutorial themes' fixed positions after the five unified themes were appended.
- `src/theme/w1-themes.test.tsx` + `src/theme/a11y-badge-contrast.test.tsx` + `src/theme/theme-on-color-contrast.test.tsx` — WCAG AA contrast for the five new themes (automatic, via `THEMES` iteration and `themes.css` parsing).

## Out of scope (later tickets)

Theme-flavored main-day items (the shared main pool is decided), push notifications at unlock, and any structured party/show field on `DayDef` (the "2 parties" pill infers party-vs-show from the `tonight` strings, best-effort admin chrome that never affects dealing or scoring).
