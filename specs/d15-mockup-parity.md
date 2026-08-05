# Spec: d15-mockup-parity — the shipped app matches the Phase 1.5 wireframes

Covers the Phase 1.5 parity catalog's regression net: `plans/daily-cards-wireframes.html` (the hand-drawn mockup, with `plans/daily-cards-spec.md` as its prose source of truth) is the parity reference for every player-facing Phase 1.5 screen, and this spec pins the shipped app to it so parity cannot silently regress.

## What "parity" means here

The wireframe HTML is a hand-drawn frame with placeholder data — it is **never pixel-diffed against the app**. Parity is asserted in two layers, both at the wireframes' own canvas (393×852, iPhone 15 Pro):

1. **Structural** — exact player-facing copy (the Welcome Aboard banner beats/caption, locked-preview captions, the library-badge note, the seeded tutorial free-space overrides, the player-voice Ranks footnote), Lucide glyph classes on rendered SVGs (`lucide-grid-3x3` / `radio` / `trophy`, claim-sheet `camera` / `mic` / `pen-line`), tab-bar presence and order with the visible More label, day-chip lock states and Warm-up/Goodbye tags on a single-line strip, locked-day preview chrome (viewed-day `data-theme` retint, exact `Unlocks 8:00 a.m.` badge, dress-code tease, caption), claim-sheet controls (Cross My Heart, Photo/Sound/Callout segments, Take photo + Library with the 🖼️ note, the 🔥 social-heat line), admin settings defaults (EXIF strip **ON**, reached hub → Game settings per `admin-console-ia`, with the Done-visible-without-scrolling contract checked on a taller-than-viewport detail), the tally-card names line built from two distinct seeded Players (never a repeated name), and the Feed photo proof **actually loading** (`naturalWidth > 0` — the "empty media area under the 🖼️ badge" prod symptom).
2. **Visual** — `toHaveScreenshot` baselines per screen (card, locked preview, claim sheet, feed, more menu, and — per `admin-console-ia` — the admin hub, Game settings, and Review queue) over the emulator-seeded fixture. These are baselines of the APP itself and are the going-forward regression net.

## Determinism contract

Visual baselines only work if every run paints identical pixels:

- The browser clock is frozen at `PARITY_NOW` (Fri 2026-07-17 14:00 CEST, mid-Event on the fixture schedule) via Playwright's `page.clock.install`, so the date-driven header, chip weekdays, relative times ("bumped 1h ago"), and proof clock labels never drift.
- **Unlocked** Days carry real-past `unlockAt`s — `firestore.rules` gates the deal on `request.time`, the SERVER clock, which the page freeze cannot touch. No player-visible string renders those stamps. **Locked** Days carry absolute 08:00-CEST stamps so their "Unlocks 8:00 a.m. · …" copy is identical every run; their locked state is judged against the frozen PAGE clock, so they stay locked previews forever.
- The signed-in player's board is re-written with the app's own `dealBoard` under a FIXED seed (the popup join mints a random uid, whose seed-derived deal would repaint every run), and their display name is pinned.
- Residual volatile chrome (the autogen account identity in the More profile row, the build-hash version footer) is masked.
- Baselines are `-darwin` suffixed; the e2e layer is local-only (not CI), matching the repo's testing posture.

## Fixture (tests/e2e/support/parity.ts)

`seedEmulatorEvent({ withStorage: true })` plus: the two curated tutorial pools, the frozen five-Day schedule (embark ✓, get-sporty ✓, duty-free = today, glamiators locked, farewell locked with its `freeText` override), two distinct seeded Players (Nathan Payne / Sterling Tadlock) with day-bucketed stats, a pinned day-meta First-to-BINGO honor, a shared per-Prompt Tally (both Players marked the same Prompt today — the "A, B got …" line), and one Feed proof of each type with REAL bytes in the Storage emulator (a decodable 1×1 JPEG for the photo — the `<img>` must report a natural size — and a WebM stub for the audio chrome).

## Out of scope

- The wireframe file itself (never rendered or diffed by the suite).
- Install-nudge / update-banner toasts (unit-covered in `d15-pwa-toasts`; their triggers — `beforeinstallprompt`, a waiting service worker — are not deterministic under the e2e harness).
- The `+N` names truncation, Got-it-too from a real second session, and finale/podium visuals (covered functionally in `d15-tally-cards` / `d15-finale-podium`).

## Test coverage

`tests/e2e/d15-mockup-parity.spec.ts` — one structural walk (join → card → coach overlay → day switcher → locked preview → claim sheet + heat line → feed → who-list → ranks → more → admin) and one visual-baseline pass, both over the parity fixture. Rules-side, the Feed's `collectionGroup('markers')` read is pinned in `tests/rules/d15-tally-cards.test.ts` (#294).
