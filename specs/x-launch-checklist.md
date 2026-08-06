---
spec_id: x-launch-checklist
status: accepted
---

# Launch runbook: cross-device matrix, one-handed reachability, and the printed-card fallback

The pre-launch gate (issue #48, depends on #47's green e2e round). The Event opens **2026-07-15** (its seeded `sailStart`; the Event runs through `sailEnd` **2026-07-24**—`scripts/seed.mjs`'s `EVENT_SEED`, pinned by the codified check below). This document is the runbook Nathan runs through in the days before the Event opens: a device-matrix template with the exact steps to run on real hardware, a one-handed reachability check on the tab Nav, the printed-card fallback documentation, and the operational runbook (seed/roster, domain, share-link, day-of contacts). **Scope boundary:** this spec is authored documentation and a structure for the human sign-off—it does not and cannot perform the physical device testing itself. Every checkbox below that requires touching a real iPhone or Android phone is explicitly a human sign-off, left unchecked for Nathan to tick during the pre-launch pass.

## Device matrix (template—human-run, before the Event opens)

At least one recent iOS device (Safari, installed as a PWA) and one recent Android device (Chrome, installed as a PWA). Each row below is a real device the human runs the four checks against; add more rows for additional devices/browsers as available, but the two below are the minimum bar from the issue.

| # | Device | OS · Browser | Checks |
|---|---|---|---|
| 1 | _(fill in—e.g. "Nathan's iPhone 15")_ | iOS Safari, PWA installed | Install prompt · Offline play · Native share sheet · Safe-area insets |
| 2 | _(fill in—e.g. "co-admin's Pixel 8")_ | Android Chrome, PWA installed | Install prompt · Offline play · Native share sheet · Safe-area insets |

### What to test and how, per check

**Install prompt.** The app's install affordance is `src/components/InstallPrompt.tsx` (mounted at `main.tsx`, outside the auth gate, so it is testable before signing in). Since #219 (`specs/d15-pwa-toasts.md`) the toast no longer offers on app-load—mark a Square first to make it eligible. Behavior then differs by platform because iOS Safari never fires `beforeinstallprompt`:

- **iOS Safari**—open `https://gaycruisebingo.com`, sign in, and mark a Square. Since no native prompt event exists, the toast shows the manual hint copy verbatim: *"Add to Home Screen: tap Share, then "Add to Home Screen," for one-tap access."* Tap the browser's Share icon → "Add to Home Screen" → Add. Confirm a Gay Cruise Bingo icon appears on the Home Screen, and that launching from it opens **standalone** (no Safari address bar/tab chrome)—`InstallPrompt.tsx`'s `isStandalone()` check (via `navigator.standalone`) is what then hides the toast permanently on subsequent opens.
- **Android Chrome**—open the same URL, sign in, and mark a Square. Confirm the toast shows *"Full screen, works offline at sea."* with an **Install** button (Chrome captured `beforeinstallprompt`). Tap Install, confirm Chrome's own native install dialog appears, accept it, and confirm the app installs and later opens standalone (`display-mode: standalone`). Either path fires the `install_pwa` GA4 + PostHog event (`src/analytics.ts`) exactly once (`InstallPrompt.tsx`'s `trackedInstallRef` guard)—visible in GA4 DebugView or the PostHog live events stream if you have a browser session open to check, though this is optional polish, not a blocking sign-off.

**Offline play (ADR 0006—the durable Mark queue, not the printed fallback; see below for the distinction).** After the app has loaded once online and you're signed in with a dealt Board: turn on Airplane Mode (or disable wifi), confirm the last-seen Board, Feed, and Ranks still render from the Workbox shell precache + Firestore's `persistentLocalCache` (ADR 0006). Tap an unmarked, non-free Square—confirm it renders `marked` immediately (optimistic/latency-compensated). Reload the page **while still offline**—confirm the Mark survived the reload (it's queued in IndexedDB, not just in-memory state). Reconnect wifi and confirm the Mark syncs—**check the Board (the Square stays `marked`) and its Tally count (tap the Square to see the who-marked-it list; your name appears), NOT the Feed.** A bare Mark deliberately posts nothing to the Feed—`setMark` writes only the Board/Player cells + the per-Prompt Tally marker (`src/data/api.ts`), and the Feed (`ProofFeed.tsx`) renders only Proofs and Moments (ADR 0002), so a tester waiting for Feed activity here would mis-read a correct offline sync as a failure. If you want to also see the Feed react, complete a BINGO/Blackout (that posts a Moment) or attach a Proof to a Mark (that posts a Proof)—but the truest proof of the ADR 0006 offline Mark queue is the Board/Tally sync above, which is what this check gates on. Sign-in itself needs connectivity (dealing a Board reads the Prompt pool transactionally), so always start this check already signed in and dealt.

**Native share sheet.** On a Board with a BINGO (or Blackout), tap Share on the celebration screen and confirm the OS's native share sheet opens with an **image attached**—`Celebration.tsx`'s Share button calls `navigator.share({ files })` via `ShareCard.tsx`'s on-device renderer (`specs/w2-share-cards.md`), not a text/URL share. Repeat on the Ranks tab's "Share leaderboard" button. If the device/browser doesn't support file sharing, confirm the graceful fallback still produces something useful (a text/URL share, then clipboard, then a file download—`shareCardBlob`'s fallback chain) rather than a silent no-op.

**Safe-area insets.** On a notched or Dynamic-Island iPhone (this is the platform that actually has non-zero safe-area insets—Android devices with gesture nav mostly report zero and are a lighter check): confirm the bottom tab bar (`.tabs`, `src/index.css`) doesn't sit under the home indicator—it pads `env(safe-area-inset-bottom)` beneath its own content. If the Install banner is still showing, confirm it stacks cleanly above the tab bar rather than overlapping it (`body:has(.tabs) .install-prompt` in `src/index.css`). Confirm the top identity bar (`Nav.tsx`'s `.nav`) isn't obscured by the notch/Dynamic Island or status bar—`body`'s own `padding: env(safe-area-inset-top) ...` (`src/index.css:18`) reserves that space for the whole app shell.

### Sign-off checklist (human—tick each box after running the check on real hardware)

- [ ] iOS—install prompt (Add to Home Screen hint shown; installs and launches standalone)
- [ ] iOS—offline play (Board/Feed/Ranks render from cache; an offline Mark survives a reload and syncs on reconnect)
- [ ] iOS—native share sheet (BINGO Share Card and Leaderboard Share Card both hand an image to the OS share sheet)
- [ ] iOS—safe-area insets (tab bar and install banner clear the home indicator; no overlap; top bar clears the notch/Dynamic Island)
- [ ] Android—install prompt (Install button appears, native install dialog completes, app opens standalone)
- [ ] Android—offline play
- [ ] Android—native share sheet
- [ ] Android—safe-area insets (if the device has gesture nav / a display cutout)

## One-handed reachability (tab Nav)

The bottom tab bar is the app's primary navigation, defined once in `src/components/tabs.ts` (the frozen mount-point contract—see that file's header comment) and rendered by `TabBar.tsx`/`Nav.tsx`. The tabs, in order, are **Card** (`/`), **Feed** (`/feed`), **Ranks** (`/leaderboard`), **Prompts** (`/items`), and **Admin** (`/admin`, visible only to a signed-in Event Admin)—pinned by the codified check below so this section cannot silently drift from the real tab contract. `.tabs` is `position: fixed; bottom: 0` with each `.tab` sized to a minimum 44px tap target, called out in `src/index.css`'s own comment as the Apple HIG one-handed-reachability guidance.

**Check steps.** Hold the phone in one hand (the hand you'd actually be holding a phone in on a pool deck or in a crowded dance-floor line), thumb only—no repositioning grip, no second hand bracing the phone. Tap through all five tabs (four if signed in as a non-admin) in order, confirming every tap lands on the first try without stretching or shifting grip. Run this on the **widest device in the matrix**—a Pro Max iPhone or a large Android is the hard case, because the far-side tab (Admin, or Prompts for a non-admin) sits furthest from the thumb's arc: the wider the screen, the harder that far tab is to reach one-handed. A pass on a small iPhone mini/SE-class device does **not** imply a pass on a large phone—it's the reverse, so the widest device is the one that has to sign off. If the matrix has both a small and a large phone, run the check on both, but the large one is the gate.

- [ ] One-handed reachability checked on the tab Nav across the device-matrix hardware (human sign-off)

## Printed 12-card PDF fallback—total connectivity failure only

**This is not the same fallback as the offline Mark queue above.** Per [ADR 0006](../docs/adr/0006-offline-resilience.md), ordinary unreliable-network dead zones—a Player loses signal for a few minutes, marks a Square, walks back into range—are already covered by the app itself: the Workbox shell precache plus Firestore's durable IndexedDB Mark queue handle that case with zero fallback needed. The printed cards are the fallback for the case where the app is **entirely unusable for the group**—wifi is down/unreachable for a meaningful stretch of the Event, or the app itself is broken and can't be fixed in time. Reaching for the printed cards over a normal dead zone defeats the point of the offline-durable Mark queue this ADR exists to provide; they're a last resort, not a day-one companion to the app.

**What exists.** Per the PRD (`docs/projects/gaycruisebingo/prds/gaycruisebingo.md` § Background & Context and § Appendix): "The printed card and a 12-card print-ready PDF already exist and are the offline fallback if wifi or the app fails"—these predate the app itself (the app is the live, social evolution of an already-existing printed bingo card tradition for this friend group) and are described as a "12-card PDF (neon)" plus "the single interactive HTML card." The Prompt pool seeded into the app (`scripts/seed.mjs`'s `ITEMS`, 32 entries) traces back to the same 33 printed items the PRD's Appendix lists (32 plus the free space, "Complain about Circuit Music", which the app also treats as synthetic—never a stored Prompt/Item).

**How the 12 cards map to Players.** With 12 physical card layouts and a friend group larger than 12 in the common case, the printed fallback is necessarily a many-to-one mapping: assign each of the 12 printed layouts to a specific person or a small sub-group in advance (a couple or room-mates sharing one physical card and marking it jointly is the expected pattern for a friend-group party game, mirroring how the printed cards worked before the app existed). _Fill in before the Event opens:_ the actual card→person/group assignment for this Event's roster.

- Card 1 → _______________
- Card 2 → _______________
- Card 3 → _______________
- Card 4 → _______________
- Card 5 → _______________
- Card 6 → _______________
- Card 7 → _______________
- Card 8 → _______________
- Card 9 → _______________
- Card 10 → _______________
- Card 11 → _______________
- Card 12 → _______________

**Where the artifact lives—flagged gap.** This repo has no committed reference to the PDF or its source (searched for `*.pdf`, any `public/**` asset, and any doc/link naming a Drive/Canva/print-shop location—none exist; the only in-repo mentions are the PRD's prose description and `SignIn.tsx`'s two "Lost signal at sea? The printed cards and PDF still work." reassurance lines, neither of which points anywhere). **This is a real gap, flagged for Nathan, not built around:** per this ticket's scope, building a PDF generator is out of scope (no trivial existing hook exists—no PDF library, no card-rendering-to-print pipeline anywhere in this codebase), and the printed cards predate the app as a physical/design artifact that most likely lives outside this repo entirely (e.g. a design-tool export or a physical print run already in hand). Before relying on this fallback:

- [ ] **Human action needed:** confirm where the print-ready PDF/source file currently lives (a design-tool link, a cloud-drive folder, or physical printed stock already on hand) and either (a) commit the PDF itself (or a durable link to it) somewhere in this repo—`public/` is the natural spot for a static asset, alongside `og-default.png`—so it's never lost/stranded outside the project, or (b) confirm the physical printed copies are packed and their location is known before departure.
- [ ] **Human action needed:** confirm the 12-card→Player/group assignment above is filled in before the Event opens.

## Runbook

### 1. Seed the Event + admin roster

`scripts/seed.mjs` (Firebase Admin SDK, bypasses security rules) creates `events/med-2026` and the 32-Prompt pool. It's idempotent in the sense that re-running it never creates duplicates (deterministic content-hash doc ids + `merge: true`), but it is **NOT** a safe no-op against a live Event—see the reseed warning below. Full steps live in `docs/app/README.md` §4—the short version:

1. Get each Admin's Auth uid (they must have signed in once first): `curl -s -X POST "https://identitytoolkit.googleapis.com/v1/projects/gaycruisebingo/accounts:query" -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" -d '{"returnUserInfo":true}' | jq -r '.userInfo[] | "\(.localId)  \(.email)"'`.
2. `ADMIN_UID=<uid>[,<uid>,...] GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/seed.mjs`—`ADMIN_UID` is a **comma-separated list** of uids (`scripts/seed.mjs`'s `adminRoster()` splits on commas, trims, and drops empties); the target roster is 2–4 Admins including Nathan's own seed uid (issue #15's recommendation: "start minimal"). **`ADMIN_UID` is the COMPLETE `events/med-2026.admins` roster, NOT an incremental add**—see the roster warning below. Passing it writes the whole `admins` array; omitting it entirely (empty/unset) writes no `admins` field at all, leaving whatever roster is already there untouched.
3. Admin is the only privileged role in this app (`CONTEXT.md`)—verify the roster in the Admin console (`/admin` tab, visible only to a signed-in Admin) before the Event opens.

> **⚠️ `ADMIN_UID` REPLACES the whole admin roster—it does not add to it.** When `ADMIN_UID` is non-empty, `eventWritePayload` puts the parsed array into the event-doc payload (`scripts/seed.mjs` `...(admins.length ? { admins } : {})`) and the seed writes it with `set(..., { merge: true })`. Firestore's `merge` **REPLACES** an array field wholesale—it does **not** union/append—so `ADMIN_UID=<new-uid>` on its own does not add a new Admin, it **overwrites the roster to contain only that one uid**, silently removing Nathan and every existing co-admin from `/admin` (potentially right before the Event opens). Safe operational rule: **to add, remove, or rotate an Admin, pass the COMPLETE desired roster every time**—e.g. to add a co-admin, run `ADMIN_UID=<nathan-uid>,<existing-uid>,<new-uid> ... node scripts/seed.mjs` with ALL of them listed, never just the delta. And because this rides the same `{ merge: true }` event-doc write as the settings clobber, changing the roster via reseed carries the SAME before-live-changes caution as the settings warning below: do it before any live `/admin` config change, not after.

> **⚠️ Reseeding clobbers live Event settings—reseed BEFORE any live config change, never after.** The seed's event-doc write (`scripts/seed.mjs`, the `eventRef.set(eventWritePayload(...), { merge: true })` call) spreads the ENTIRE `EVENT_SEED` payload on every run—`name`, `sailStart`/`sailEnd`, `status`, `defaultTheme`, `claimMode`, and `settings.reportHideThreshold`. A `{ merge: true }` write only touches the leaf paths present in the payload, but those seed-baked fields are all present, so a reseed **resets each of them back to its seed default**—including `claimMode` and `defaultTheme`, the exact knobs an Admin changes in `/admin`. Concretely: if an Admin has switched the Event to `proof_required` or picked a different theme in the console, then someone reruns the seed just to refresh the Prompt pool, those live choices are **silently reset** to `honor` / `neon-playground`. Only the `admins` roster is safe to omit; the rest are not. **There is no prompt-only reseed path**—the script always writes the event doc before the `items` subcollection, with no flag to skip it (verified against the current `scripts/seed.mjs`). So: do all Prompt-pool reseeding **before** making any live `/admin` config change, and after the launch config is set in the console, do **not** rerun the seed. If you must add Prompts after go-live, add them through the in-app Prompts tab (`/items`) rather than reseeding, or re-apply the intended `claimMode`/`defaultTheme` in `/admin` immediately after any reseed.

- [ ] Admin roster confirmed (2–4 uids including Nathan's, per #15) and re-verified in `/admin` (human sign-off)
- [ ] No reseed run after the launch `claimMode`/`defaultTheme` were set in `/admin` (or, if one was, those settings were re-applied in the console afterward) (human sign-off)

### 2. Domain

`gaycruisebingo.com` is **already connected and live**—issue #45 (Cloudflare → Firebase Hosting custom domain + SSL) is closed, and `docs/app/README.md` §6 confirms the DNS records (`A` apex → `199.36.158.100`, `TXT` apex → `hosting-site=gaycruisebingo`) are in place with SSL auto-provisioned. No cutover action is needed for this launch; this runbook step is a **verification**, not a setup task. HTTPS loading alone doesn't catch every way the #45 cutover state can regress (a proxied record still serves, and a dropped hosting-config deploy still serves the shell)—so verify all three:

- [ ] Load `https://gaycruisebingo.com` directly (not `.web.app`) and confirm it serves over HTTPS with a valid cert and no browser warning (human sign-off, day before the Event opens)
- [ ] Confirm the Cloudflare apex records are **DNS-only / unproxied** (grey cloud, not orange)—the `A` apex → `199.36.158.100` and `TXT` apex → `hosting-site=gaycruisebingo` from `docs/app/README.md` §6. A proxied (orange-cloud) record can still serve traffic but breaks Firebase's cert renewal (the ACME challenge) and fronts the app with Cloudflare's own cache/headers instead of Hosting's.
- [ ] Confirm the response still carries the expected headers—the app's own `noindex` and Hosting's `Cache-Control`. `curl -sI https://gaycruisebingo.com` (or DevTools → Network on `/`) should show `cache-control: no-cache` on the HTML shell (`firebase.json`'s catch-all + `/index.html` rules), and `curl -s https://gaycruisebingo.com | grep robots` should show `<meta name="robots" content="noindex" />` (`index.html`, kept intact through the #45 cutover per that issue). Spot-check a hashed asset too (`curl -sI https://gaycruisebingo.com/assets/<hashed>.js`) for `cache-control: public, max-age=31536000, immutable`. These prove the live domain is served by Firebase Hosting with its config intact, not fronted by a proxy that dropped them.

### 3. Share-the-link flow

The zero-coordination join path the PRD's headline metric depends on (`specs/x-e2e-happy-path.md` pins this same path against the emulator): drop `https://gaycruisebingo.com` in the group chat. A Player taps the link, confirms the 18+ acknowledgment (`SignIn.tsx`), taps "Continue with Google," and lands on their own dealt Board—no admin action, no invite code, no second step. Nothing else is required to onboard a Player; re-sharing the same link at any point during the Event (e.g. for a Player who lost the message) works identically.

### 4. Day-of contacts (template—fill in before the Event opens)

| Role | Name | Contact (cabin / phone / app) |
|---|---|---|
| Admin (primary) | Nathan | _______________ |
| Admin (co-host) | _______________ | _______________ |
| Admin (co-host) | _______________ | _______________ |
| "The app is down, help" first call | _______________ | _______________ |

- [ ] Day-of contacts filled in and shared with all Admins before the Event opens (human sign-off)

## Definition of Done (mirrors issue #48)

Authored-and-shipped in this PR:

- [x] Launch runbook written (this document)—seed/roster, domain verification, share-link flow, day-of contacts template
- [x] Printed 12-card PDF fallback documented (total-failure only, ADR 0006-framed)—with the PDF-location gap explicitly flagged above for human action

**Opening readiness gate (human—2026-07-15).** Do NOT mark launch-ready until EVERY box below is ticked. This gate covers the whole runbook, not just the device matrix—the operational sign-offs (admin roster, domain, contacts) and the PDF-location actions are launch-blocking too, and marking ready with any of them blank ships a half-checked runbook:

- [ ] iOS + Android device matrix run and signed off (real hardware—the 8 device-check boxes above)
- [ ] One-handed reachability checked on the tab Nav, **gated on the widest device in the matrix** (real hardware)
- [ ] Admin roster confirmed and re-verified in `/admin` (the § Runbook step 1 sign-off)
- [ ] No reseed run after live `/admin` config was set—or the settings were re-applied afterward (the § Runbook step 1 reseed sign-off)
- [ ] `gaycruisebingo.com` verified—HTTPS + valid cert, apex records DNS-only/unproxied, and `noindex` + `Cache-Control` headers intact (the three § Runbook step 2 sign-offs)
- [ ] Day-of contacts filled in and shared with all Admins (the § Runbook step 4 sign-off)
- [ ] Printed-PDF location confirmed (committed to the repo or physical stock packed) AND the 12-card→Player assignment filled in (the two § Printed 12-card PDF fallback actions)
- [ ] **Ready for the Event opening 2026-07-15**—tick ONLY once every box above is ticked

## The codified check

This spec pins two invariants the runbook above depends on and would otherwise silently drift from: the seeded Event window (`2026-07-15` → `2026-07-24`, referenced throughout this doc and by the opening date itself) and the exact tab Nav contract the device-matrix and reachability sections document by name—every tab FACT the runbook quotes: id, **label**, **route path** (`/`, `/feed`, `/leaderboard`, `/items`, `/admin`), and the admin-only gating. `src/test/x-launch-checklist.test.ts` asserts all of them directly against `scripts/seed.mjs`'s `EVENT_SEED` and `src/components/tabs.ts`'s `TABS`—so a later route rename (e.g. `/leaderboard` → `/ranks`) breaks this spec's own test instead of leaving the runbook quoting a dead URL, and likewise for a stale Event window or a renamed tab.
