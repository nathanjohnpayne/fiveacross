---
spec_id: d15-coach-overlay
status: accepted
---

# First-open coach overlay (`d15-coach-overlay`)

Implements `plans/daily-cards-spec.md` § "First-open coach overlay" (#214). A once-per-Event scrim over the Player's first dealt card that decodes the Board's badge notation — the Tally count, the 👀 Doubt badge, the ＋ add-proof affordance, and the free space — so a first-time Player isn't left guessing what the small icons on a marked Square mean. Deliberately narrower than the Welcome Aboard banner (`TutorialBanner`, #213, `d15-tutorial-banners`), which carries the game's rules and narrative; this overlay explains only the notation on a marked Square, and the two copy sets never repeat each other. Depends on `d15-day-switcher` (#205, the Day-scoped board view this overlay mounts over) and `d15-more-menu` (#208, the More → "How to play" entry point; since #270 that row opens the Welcome Aboard WALKTHROUGH panel first — daily-cards-spec § "More menu" item 4 — with this overlay's replay one tap further, behind its "Show the badge legend" button). Guarded by `src/components/CoachOverlay.test.tsx` and `src/components/d15-more-menu.test.tsx` (RTL jsdom).

## Contract

- `src/components/CoachOverlay.tsx` (new) — default export `CoachOverlay({ eventId, forceOpen, onDismiss }: CoachOverlayProps)`. `eventId` defaults to the real `EVENT_ID` (`../firebase`), overridable so tests never touch the real key. Renders a `.sheet-backdrop`/`.sheet` scrim (same modal family as the proof-capture sheet) with a four-row legend (Tally count, 👀 Doubt badge, ＋ add-proof, free space) and a CTA button, copy verbatim: **"Got it—deal me in."** When `forceOpen` is falsy, renders nothing if `localStorage['gcb.coachOverlay.<eventId>.dismissedAt']` is already set; when truthy, always renders and never consults that key before rendering. Tapping the CTA (either mode) writes that key to the current timestamp, hides the overlay for the rest of that mount, and calls `onDismiss()` if supplied — storage access is wrapped in try/catch, mirroring `InstallPrompt.tsx`'s `DISMISS_KEY` fallback.
- `src/components/Board.tsx` (modified) — mounts `<CoachOverlay />` whenever the Board renders with cells. Because the gate itself is per-Event, not per-Day, this unconditional mount naturally shows the overlay only over the very first Board-with-cells render for that Event — whichever Board that turns out to be, not hardcoded to the opening Day — and never again once dismissed.
- `src/components/More.tsx` (modified) — the "How to play" row opens the Welcome Aboard walkthrough panel (#270, daily-cards-spec § "More menu": the row "replays the Welcome Aboard walkthrough"), whose "Show the badge legend" button then renders `<CoachOverlay forceOpen onDismiss={closePanel} />` (`CoachOverlay` supplies its own complete backdrop/dialog, replacing the panel chrome).
- `src/index.css` (modified) — `.coach-overlay*` legend-row styling, theme-token-driven, layered on the existing `.sheet-backdrop`/`.sheet`/`.btn` chrome.

## Resolved defaults (no open decisions)

- **Dismissal key shape**: `gcb.coachOverlay.<eventId>.dismissedAt`, per-Event (not global) — mirrors `ThemeContext`'s `gcb.theme` device-scoped convention, keyed additionally by Event id so a Player joining a future Event (a new `EVENT_ID` build) sees the overlay again even though they dismissed a prior Event's.
- **Mount gate**: "first Board this Player has ever seen render with cells," not `DayDef.tutorial` — an unconditional mount whenever `Board` has `cells.length > 0`, relying entirely on the per-Event localStorage flag (not Day-specific bookkeeping) to show it at most once.
- **Replay dismissal**: writes the stored per-Event timestamp — the ticket's own text accepts either behavior as long as the once-per-event auto-show is unaffected by replays; writing is the simplest single dismiss handler shared by both modes.
- **"How to play" row**: opens the walkthrough panel (#270), with the `CoachOverlay` replay (`forceOpen`) one tap further behind "Show the badge legend" — the walkthrough carries the narrative, the overlay decodes the notation; they complement rather than repeat (daily-cards-spec § "First-open coach overlay").

## Acceptance criteria

- **Given** a Player's first dealt card for an Event renders **When** the Card tab mounts **Then** the coach overlay scrims it with the four-row legend and the CTA.
- **Given** the Player taps "Got it—deal me in." **When** the overlay dismisses **Then** it never auto-shows again for that Event (persisted via localStorage), but does not affect a different Event's dismissal state.
- **Given** a Player opens More → How to play **When** they tap it **Then** the overlay replays regardless of prior dismissal.
- Overlay shows at most once per Event automatically.
- Overlay copy names only the badge legend, not the game's rules (no duplication with the Welcome Aboard banner).
- Replay from More → How to play works after dismissal.

## Test coverage

`src/components/CoachOverlay.test.tsx` (RTL jsdom): renders the four legend rows + the CTA; the Doubt badge row restates the never-a-gate invariant; tapping the CTA dismisses the overlay and writes the per-Event localStorage key; a second mount with that Event's dismissal key already set does not render; a mount under a DIFFERENT Event id renders even though a prior Event's key is set; `forceOpen` renders regardless of a set dismissal flag and its dismissal still writes the stored timestamp.

`src/components/d15-more-menu.test.tsx`: the "How to play" row reopens the real `CoachOverlay` even when this Event's dismissal flag is already set; dismissing that replay closes it without clearing the stored per-Event flag.
