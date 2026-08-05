---
spec_id: admin-console-ia
status: accepted
---

# admin-console-ia — hub-and-detail IA, sticky dismissal, Easy mix slider

Implements `plans/admin-redesign-ticket.md` (issue #404), matching `plans/daily-cards-wireframes.html` frames `#frame-admin-hub` / `#frame-admin-queue` / `#frame-admin-settings` / `#frame-admin-schedule`. The tabbed, six-section Admin scroll (taller than a phone viewport, dismissible only by a CLOSE button at the very bottom) becomes a compact hub of section cards with live badges, each opening a detail surface, under one shared navigation-and-dismissal contract. **UI-only**: every write path stays exactly as built — this is a re-housing, not a rebuild. The hub shipped with five doors; a sixth, **Messages**, was added by `admin-messages` (#439) — the door/route/mapping/coverage additions below are kept in sync there.

## Contract

### Routes

- `src/App.tsx` — the More tab alone mounts with a splat (`/more/*`); the other three tab routes are unchanged, and the TAB SET itself is untouched (`src/components/tabs.ts` stays the frozen four-entry contract).
- `src/components/More.tsx` — the admin console is ROUTE-driven, not panel-state-driven: the Admin row navigates to `/more/admin`, and More renders `<Admin />` as an overlay whenever the location is under `/more/admin`. The other More panels (schedule / suggest / how-to-play / coach) stay local state.
- `src/components/Admin.tsx` — `adminSectionFromPath(pathname)`: `'hub'` for `/more/admin`, a section id for `/more/admin/queue|settings|schedule|pool|players|messages` (`messages` added by #439), `null` outside the admin; an unknown section segment resolves to `'hub'` (a stale deep link lands on the hub, not a dead end). Because hub → detail navigations are real pushes, the browser/PWA back button walks detail → hub → More with no extra code.
- A non-admin at any `/more/admin` URL gets the same sheet chrome with the "Admins only." body — dismissible, never a redirect loop (`Admin` self-guards exactly as before).

### Navigation & dismissal (every admin surface)

- `src/components/admin/AdminSheet.tsx` — the one chrome component every admin surface renders inside. Sticky header, always visible: `‹ Admin` back on the left (details only — the hub renders a width-balancing spacer), the section title (the dialog's accessible name, focused on open and on every hub ↔ detail transition), and **Done** on the right. Done closes the entire admin from any depth (`navigate('/more')`); backdrop tap, Escape, and a swipe-down on the header (a downward pointer drag > 80px on the grab area, which sets `touch-action: none`) do the same. Content scrolls UNDER the header: `position: sticky` inside the `.more-panel` scrollport, safe-area padded (`env(safe-area-inset-top)` on the header, `env(safe-area-inset-bottom)` on the body), so Done is visible without scrolling on any surface at any viewport height.
- Dialog semantics keep the `MorePanel` conventions (role=dialog, aria-modal, Tab/Shift+Tab trap) plus the who-list refinement: focus restores to the opener on unmount.

### Hub (`/more/admin`)

`src/components/admin/AdminHub.tsx` — section cards (reusing the More menu's exported `MoreRow` chrome), each with a live subtitle and, where a queue waits behind it, a badge:

- **Review queue** — badge = reports + approvals + claims total, where claims count ONLY in `admin_confirmed` claim mode; subtitle enumerates the parts ("Reports N · Approvals N · Claims N — one inbox, oldest first"), or "All clear".
- **Game settings** — static subtitle enumerating the dials.
- **Schedule** — subtitle: day count + next locked unlock formatted in the Event's own IANA timezone (the `ScheduleList` convention).
- **Prompt pool** — badge = pending-approvals count (the same number the More menu's Admin row badges, derived from the console's own subscription so they can never disagree).
- **Players** — subtitle: banned-roster count.
- **Messages** (#439, `megaphone`, no badge) — subtitle: "Post a Notice to everyone · pin to the Feed + Card banner"; opens the admin messaging compose + sent-history surface (`specs/admin-messages.md`).

### Section mapping (nothing dropped, nothing duplicated)

Every control of the pre-redesign console exists in exactly one new home:

| Built before (tab · section) | New home |
|---|---|
| Moderation · Report queue | **Review queue** (Reports group) |
| Approvals tab (incl. Approve all) | **Review queue** (Approvals group) |
| Moderation · Pending claims | **Review queue** (Claims group, admin-confirmed mode only) |
| Moderation · Proof & Claims (claim mode, photo source, EXIF, AI screen, auto-hide) | **Game settings** › Claims & proof |
| Moderation · Easy mix | **Game settings** › Easy mix — as the slider below |
| Moderation · Default theme | **Game settings** › Appearance |
| Schedule tab (rows, tonight editor, Unlock now, Re-snapshot) | **Schedule** — content unchanged; the Unlock-now/Re-snapshot fallbacks fold into a per-Day repair line (#413, below) instead of sitting inline between the Day content and the dropdown |
| Moderation · Prompts (+ curated add form) | **Prompt pool** |
| Moderation · Banned players | **Players** |

The Proof & Claims panel's "Pending claims" count-plus-jump-link row (`#admin-pending-claims`, `d15-admin-proof-claims`) is superseded by the hub's Review-queue badge — its function (find the claims queue) is now the IA itself.

### Review queue (`/more/admin/queue`)

`src/components/admin/ReviewQueue.tsx` — Reports, Approvals, and (admin-confirmed mode only) Pending claims as one triage surface, **each group oldest-first** (`createdAt` asc). The Reports group's oldest-first order supersedes `w2-admin-console`'s most-reported-first sort — triage order is now arrival order, uniform across the three groups. Row affordances are exactly the pre-redesign ones: hide/restore/delete/Clear-reports/Ban-author on report rows (the ADR 0004 queue-membership and auto-hide-lift rules are unchanged), spicy-toggle/Approve/Reject (+ Approve all) on approvals, Confirm/Reject on claims. Empty state: "All clear. Go enjoy the boat." — the `gcb` Edition's value; the string is Edition-scoped since #608 (`src/editions.ts`).

### Game settings (`/more/admin/settings`)

`src/components/admin/GameSettings.tsx` — Easy mix (below), then Claims & proof (claim mode / photo source / EXIF strip / AI image screen / auto-hide stepper — every caption and write path per `d15-admin-proof-claims`), then Appearance › default theme (the old Default-theme section verbatim).

### Easy mix slider

`EasyMixSlider` (in `GameSettings.tsx`) replaces the prior Easy mix admin control: a native `<input type=range>` over the full **0–100% range in 5% steps**, `datalist` detents at 0/25/50/75/100 with matching labels under the track, and a value bubble translating the ratio to squares — `"{pct}% · {round(24·pct/100)} of 24 squares"` — which is also the input's `aria-valuetext`, updating live while dragging. Sublabel: "Applies from the next 8:00 unlock · reshuffles inherit it." Commits `settings.easyMixRatio` once on release (pointer/key up, plus blur for assistive-tech value changes that fire neither), optimistic like the other settings writes, deduped against the last REQUESTED ratio (not the async-stale prop). A stored off-grid ratio is normalized to the 5% grid for display (the native range coerces off-grid DOM values itself, so the label must agree with the thumb) and an untouched release never rewrites the stored value. The setting's deal-time semantics are `specs/easy-mix.md`, unchanged.

### Schedule / Prompt pool / Players

`src/components/admin/SchedulePanel.tsx`, `PromptPool.tsx`, `PlayersPanel.tsx` — the old Schedule tab, Prompts section (+ curated add), and Banned players section, content and write paths unchanged, under the new chrome.

**Schedule — per-Day repair line (#413, mockup `plans/daily-cards-wireframes.html` § `#frame-admin-schedule`).** Every Day row keeps one uniform shape: a top line of `info (grow) + theme <select>`, the dropdown trailing on every row and never shifting. The once-an-Event recovery fallbacks no longer render inline between the Day content and the dropdown (which lopsided the one eligible row). A Day that needs one grows a full-width **repair line** inside its own row — a `role="group"` `aria-label="Day N repair"` element below the Tonight field — stating the anomaly in plain words with the quiet fix button at the trailing edge, and carrying the button's own result/denial message beside the anomaly after a tap: the easy-mix deploy race (`canResnapshot`) reads "Snapshot predates the easy-mix deploy" → `Re-snapshot`; a missed scheduler beat (`dayDueForManualUnlock`) reads "Missed the 8:00 unlock" → `Unlock now`. `canResnapshot` is provenance-gated (#415): every post-easy-mix stamp freezes `snapshotEasyMixRatio` with a main Day's snapshot, so the deploy-race line shows only when a stamped main Day 4+ **lacks** that field — the structural mark of a pre-easy-mix snapshot — and a successful re-snapshot self-heals (the ratio appears on the echo, the affordance retires; sticky mount keeps its confirmation). Once a fallback is **tapped**, its anomaly text latches for the row's lifetime (#418, the mockup's resolved state) so the result reads beside its context ("Missed the 8:00 unlock" — "Unlocked."); an externally resolved Day (no tap) latches nothing and retires cleanly. The line is mounted stickily — once a fallback has ever been relevant for the row's lifetime it stays, so `UnlockNowButton`'s "Unlocked." confirmation survives eligibility flipping false. An ineligible Day renders no repair line. The line's controls are the **quiet variant** (#416, the mockup's two drawn states): the button is compact — the line's own text size — sentence case in the markup, hairline `var(--border)` border, transparent, no glow (never the app's primary all-caps pill; the global `.btn` is untouched), and the result/denial message renders as plain near-ink text (`.schedule-row-result`, ink @ .85), not a second pill; long denials wrap. Presentation-only: `resnapshotDayNow` / `unlockDayNow`, their eligibility checks, and their result messages are exactly as built. `#frame-admin-schedule` is a visual reference (not a `toHaveScreenshot` baseline in the parity walk).

### Orchestration

`src/components/Admin.tsx` shrinks to the orchestrator: it owns the same subscriptions the tabbed console held (`useEventDoc`, `usePendingClaims`, `useReportedProofs`, `useAllItems`, plus the Approvals tab's `usePendingItems`), derives the badge math once, resolves the section from the URL, and renders it inside `AdminSheet`.

## Acceptance criteria

- Given any admin surface on a phone-height viewport, Done is visible without scrolling and closes admin in one tap; backdrop, Escape, and a swipe-down on the header do the same.
- Given 2 reports + 3 approvals + 2 claims in admin-confirmed mode, the hub's Review-queue badge reads 7 and the detail shows the three groups oldest-first with working actions; outside admin-confirmed mode the claims group and its badge contribution vanish.
- Given the slider set to 25% and released, `settings.easyMixRatio` is written as 0.25, and the bubble read "25% · 6 of 24 squares" while dragging.
- Given browser back from `/more/admin/settings`, the app lands on the hub (`/more/admin`), not the Card tab.
- Every control in the mapping table exists in exactly one new home — nothing dropped, nothing duplicated.

## Test coverage

- `src/components/admin-console-ia.test.tsx` (RTL-jsdom) — hub renders its section cards (six since #439) with correct badge math, and the Messages door routes to `/more/admin/messages`; card → detail → back → hub; Done from a detail closes admin entirely (lands on `/more`); the sticky header is present on every surface; the Review queue shows the claims group only in admin-confirmed mode and orders groups oldest-first; the slider commits on release with the correct ratio, dedups a repeat release, and renders the squares bubble while dragging; Escape, backdrop, and header swipe-down dismiss.
- `src/components/Admin.test.tsx`, `w2-admin-console.test.tsx`, `w2-ban-console.test.tsx`, `w3-claim-modes.test.tsx`, `d15-more-menu.test.tsx` — the pre-existing per-section behavior pins, re-anchored to the new surfaces (each renders `<Admin />` at its section route under a `MemoryRouter`). `Admin.test.tsx`'s "Admin Schedule repair line (#413)" block pins the repair-line pattern: a re-snapshot-eligible and a due-for-unlock Day each grow a `Day N repair` group carrying the right anomaly text and fallback button, the top line holds no buttons (theme select is the trailing control), an ineligible Day renders no repair line, and a fallback's result message stays inside the row after a tap; its quiet-variant test (#416) pins sentence-case DOM labels and the result rendering as `.schedule-row-result` plain text, never `.pill`; its provenance/persistence tests (#415/#418) pin that a ratio-bearing snapshot draws no deploy-race line, a tapped fallback keeps anomaly + result after the event-doc echo retires its button, and an untapped externally-resolved Day retires cleanly.
- `tests/e2e/d15-mockup-parity.spec.ts` — hub + settings + queue structural walk and screenshots at 393×852; a taller-than-viewport detail (Prompt pool) still shows Done without scrolling.
- No new rules/functions tests — nothing server-side changes.
