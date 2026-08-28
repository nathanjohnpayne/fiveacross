<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/gaycruisebingo/prds/gaycruisebingo.md
source_ref: 9a5ae82
project: gaycruisebingo
document_class: prd
document_slug: gaycruisebingo
sync_direction: central-to-repo
-->

---
tags:
  - gaycruisebingo
  - prd
---
# Gay Cruise Bingo

**Author:** Nathan Payne
**Status:** Active—Phase 0 live at gaycruisebingo.com with the fast-follow social layer; parts of Phase 1 deployed (server auto-hide, moderation email, flag-gated Vision); Phase 1.5 "Daily Cards" specced 2026-07-11 with its backlog heading to project #7
**Last Updated:** 2026-08-17

## Problem Statement

The printed Atlantis Cruise Bingo card (and its 12-card PDF) is fun but static: no shared state, no way to see who else "got" a square, no bragging, and no record of who won. On a nine-night cruise with a big friend group, the game wants to be social and live—phone-first, with the running commentary and receipts that make an inside joke escalate. Today, it lives in scattered group texts. The cost of not solving it is small in dollars but large in fun: the joke stays flat, the winners are unremembered, and the card is a one-and-done novelty instead of the running bit of the trip.

## Goals & Success Metrics

- **Goal:** Make play live and shared. **Metric:** a round is playable end-to-end (join → mark → bingo → leaderboard) with zero coordination beyond a shared link; ≥ 70% of signed-in players mark ≥ 1 square and ≥ 40% reach a BINGO during the sailing.
- **Goal:** Make it phone-native. **Metric:** installable PWA on iOS and Android; Lighthouse PWA + performance ≥ 90 on a mid-tier phone; primary actions reachable one-handed.
- **Goal:** Make it theirs. **Metric:** the prompt pool is community-editable, and the app reskins into the eight party themes; adding an item and switching themes each take < 5 seconds.
- **Goal:** Make it shareable. **Metric:** one-tap on-device share cards for BINGO and the leaderboard; ≥ 25 share events during the sailing.
- **Goal:** Remember the winners. **Metric:** a durable leaderboard and a "first to BINGO" hall of fame persist for the sailing and archive afterward.

## Non-Goals

- **Real verification / anti-cheat.** The proof system is flavor, not enforcement; integrity is never guaranteed even in stricter claim modes. (Not the point of the product.)
- ~~**Full multi-tenant "rooms" product.** The schema is event-scoped, so future cruises are cheap, but v1 ships a single active event with no room-browsing or join-code UI. (Avoids data-model and UX scope before it's needed.)~~ **Superseded 2026-08-17** by the Five Across platform PRD (`projects/fiveacrossbingo/prds/fiveacrossbingo.md`) Phase 5, which makes self-service, organizer-driven event creation an explicit goal. This non-goal deferred the work "before it's needed"; that condition has now expired on its own terms. Gay Cruise Bingo itself remains a single-Event edition **by product choice** (`fiveacrossbingo.md` § Launch Edition: Gay Cruise Bingo), not by platform limitation. What the original line ruled out that is *still* ruled out—no public directory of other organizers' events, no join-code room-hopping, no cross-event browsing for a player who is not a member—survives in `fiveacrossbingo.md` § Non-Goals, "A public event marketplace." See also `specs/path-addressing-and-root.md` in the application repository, which decides how historical events are addressed once the root becomes a create-Event page.
- **Payments, tickets, or Atlantis affiliation.** No commerce and no implication of endorsement by Atlantis Events; avoid their marks. (Out of scope and a trademark risk.)
- **Native App Store / Play Store apps.** PWA only. (A store build buys nothing for a one-cruise audience.)
- **Heavy pre-moderation.** Moderation is reactive (report / hide / admin takedown) plus automated flagging for illegal/extreme content only—not a review queue that gates posting. (Friction would kill the vibe.) *Phase 1.5 narrows this for Prompts only: new pool submissions queue for admin approval before they can be dealt; proofs and marks remain reactive.*
- **Non-Google login.** Google is the only identity provider in v1. (Lowest-friction path; everyone already has an account.)

## Background & Context

The printed card and a 12-card print-ready PDF already exist and are the offline fallback if wifi or the app fails. The domain `gaycruisebingo.com` is registered at Cloudflare; the Firebase project is `gaycruisebingo` (project number 849798007162, org `nathanpayne.com`). The cruise sails from Trieste → Barcelona, July 15–24, 2026. The audience is an adult gay-cruise friend group, so the content is deliberately raunchy, and the app is 18+.

Prior art in this account: `friends-and-family-billing` is a comparable Firebase + React web app whose repo docs (APP_SUMMARY, QUICKSTART, FIREBASE_IMPLEMENTATION) are the format precedent for this project's imported documentation.

## Proposal

### Overview

One active event holds a community-editable pool of prompts (seeded from the 33 printed items). Each player who signs in with Google is dealt a frozen, randomized 5×5 card (24 sampled prompts + a free center, "Complain about Circuit Music"). Players tap squares as things happen; a BINGO is five in a line (rows, columns, diagonals; center counts). Each square shows a **tally** of who else got that prompt—the "see who else got it" the printed card can't do—and big moments (first BINGO, blackout) broadcast to a live **feed** everyone watches. A skeptic can **doubt** a mark ("pics or it didn't happen"); attaching proof satisfies it. A leaderboard ranks players by bingos, then squares, then earliest first-bingo, with a pinned "first to BINGO." The whole UI reskins into any of the eight Atlantis party themes. Marking is an honor system by default—the group, not the server, is the verification—with an event-level setting to require proof (**proof-to-mark**) or route marks through admin confirmation (**admin-confirmed**, renamed from the misleading `verified`).

### User Experience

Nathan seeds the event and drops the link in the group chat. A friend taps "Continue with Google," confirms 18+ (recorded as a one-time attestation), and lands on their neon card. Someone gets propositioned by a septuagenarian, taps the square—and sees three friends already got that one—then optionally snaps a blurry photo, records a sound, or types a "name names" callout as proof; it posts to a live feed visible to everyone. A skeptic taps "ask for proof," and the doubt count climbs until the receipts land. Three squares later, they hit a diagonal. The screen goes full BINGO, the moment broadcasts to the feed, and a personalized retina image—rendered right on the phone—is ready to drop back into the chat. The leaderboard reshuffles; escalation ensues. Navigation is a bottom tab bar: Card, Feed, Ranks, Prompts, and (for admins) Admin.

### Technical Approach

React single-page app (Vite) in TypeScript, end-to-end, hosted on Firebase Hosting with Firebase Auth (Google), Firestore (data, with an on-device persistent cache so marks survive flaky ship wifi and sync on reconnect), Cloud Storage (proof/avatar media), and GA4 (analytics). The data model is event-scoped (`events/{eventId}/…`), so additional cruises are new event documents.

Phase 0 (pre-cruise MVP) is deliberately Cloud Functions-free: each player writes their own board, marks, and denormalized stats, and the leaderboard is a client-side sort. This is intentional, not a gap—the game is honor-system by design (no cheater is in the threat model; the live feed and the group are the verification), so self-written stats are a feature and no server authority over marks is needed. Phase 0 also carries the social core: the per-prompt **tally** (public, attributed marker records—"who else got this"), broadcast **moments** (first-bingo + blackout) merged into the feed, **doubts** (social proof-demands a proof satisfies), on-device **share cards** handed to the native share sheet, a client-side auto-hide once a report count crosses the event threshold, a persisted 18+ attestation, and the offline cache above. Marking supports three event-level claim modes—a friction/vibe knob, not a trust hierarchy: `honor` (default), `proof_required` (proof-to-mark), and `admin_confirmed` (marks go pending and create a claim an admin confirms; renamed from the misleading `verified`). Phase 1 adds a `functions/` package only for what genuinely needs a server: Cloud Vision SafeSearch flagging tuned for extreme/illegal content—not raciness—plus `sharp` thumbnails and server-authoritative moderation (flip `status`), and App Check (reCAPTCHA Enterprise). Dropped from the original plan: the Cloud Run Playwright OG service and crawler-facing public `share` pages (replaced by on-device share cards—the audience shares images into a private group chat, not links to a public crawler), and server-side stat recomputation as anti-cheat (pointless under the honor model—it would only re-derive stats from the same player-written board).

### Phase 1.5—Daily Cards (specced 2026-07-11)

A pre-embarkation redesign that makes the card daily. Each cruise day has a date, port, and party theme and unlocks a fresh themed Board at 8:00 a.m. ship time (`Europe/Rome`—the whole itinerary is CEST). A scheduled function stamps a per-Day snapshot of the approved pool at unlock, so admin-approved player submissions enter every not-yet-unlocked Day; players deal lazily from the snapshot, with no prompt repeating across a player's cruise until the pool exhausts. Locked future Days show full themed chrome, the party's dress-code tease, and blank squares behind a lock. The two non-party days become tutorial days with curated pools and their own themes: **Welcome Aboard** (embark, live pre-cruise, teaches the game with easy on-ship squares) and **So Long, Farewell** (disembark, a reflective goodbye card). Scoring: one cruise-long leaderboard that sums all cards, a pinned "First to BINGO per Day," and a two-beat finale—last-call standings Moment at 20:00 on the final sea day, then a freeze + podium when the farewell card unlocks (farewell marks are ceremonial). The Feed gains **Tally Cards** (a live, aggregated entry per Prompt per Day—"Nathan Payne, Sterling Tadlock +12 got 'Balcony or porthole photo'"—bumped to the top as players mark, with claim-from-the-feed buttons). Chrome changes: the header shows today's port + theme beside the title; the tab bar becomes Card / Feed / Ranks / More (the More tab wears the player's avatar); a More menu absorbs profile, theme (new auto-match-the-day default), text size (S/M/L with an always-fits guard), schedule, suggest-a-square, tutorial replay, install, bug report, the 18+ advisory, admin, and sign out. The claim sheet resolves repo issue #190 (camera or library, with a 🖼️ Feed badge on library picks) and introduces a new Proof & Claims admin panel that surfaces the photo-source policy, EXIF stripping, the Vision gate toggle, and the report threshold. Iconography standardizes on Lucide for Chrome, emoji for camp. The model is event-scoped and admin-editable end-to-end, so future cruises reuse it wholesale.

**Goal:** give players a reason to return every morning. **Metric:** ≥ 50% of active players open at least five of the ten Day Cards; each 8 a.m. unlock produces a spike in markings within two hours.

Resolved decisions (2026-07-11): farewell unlocks at 08:00 on Day 10 (standard rule, no special case); cruise-wide First to BINGO excludes tutorial days; tutorial theme names/palettes as specced; #190 photo source defaults to camera-or-library with the transparency badge (camera-only as an event-level override); winners announced via the two-beat finale.

Canonical spec: `plans/daily-cards-spec.md` in the app repo, with `plans/daily-cards-wireframes.html` (22 iPhone 15 Pro frames; the `data-lucide` attributes are the icon spec). Phase 1.5 tickets are filed on project #7 under `phase-1.5`.

## Dependencies & Risks

| Dependency / Risk | Impact | Mitigation |
|---|---|---|
| Sailing is ~8 days out (embark July 15) | High | Ship a ruthless Phase 0 by embarkation; land the fast-follow social layer (moments, share cards, doubts) and Phase 1 (server moderation) as live updates during the cruise. |
| Public app + user-generated photos/audio/names + adult content | Medium-High | Persisted one-time 18+ attestation, report/hide with a Phase-0 client-side auto-hide at threshold, multi-admin takedown console (round-the-clock coverage), `noindex`, Storage MIME/size limits, and Phase-1 Cloud Vision flagging for extreme/illegal content only. |
| Custom domain from Cloudflare → Firebase Hosting SSL can take up to ~24h | Medium | Do the domain connection first; set Cloudflare records to DNS-only (unproxied) so Firebase can issue the cert. |
| ~~Playwright OG rendering cost/latency~~ (dropped) |—| Replaced by on-device share cards (client render → native share sheet); no server render, no public share pages. See ADR 0005. |
| Phase 0 stats are client-trusted | None (by design) | Intentional under the honor model—the feed and the group are the verification, not the server (ADR 0001). `recomputeStats`-as-anti-cheat is dropped. |
| Firebase Blaze plan required for Phase 1 (Functions, Cloud Run, Vision) | Low | Phase 0 runs on Spark; set a budget alert before enabling Blaze features. |

## Resolved Decisions

Settled in the 2026-07-07 design review; full rationale in the `gaycruisebingo` repo's ADRs (`docs/adr/0001-0006`).

- [x] **18+ gate:** keep the soft one-time acknowledgment, and **persist it** as a timestamped attestation on the user profile—an unrecorded gate isn't doing its job.
- [x] **Claim modes are event-level only**—`honor` (default) + optional proof, with **no** per-prompt proof requirement. They're a friction/vibe knob, not a trust hierarchy (ADR 0001); `verified` is renamed **admin-confirmed**.
- [x] **Proofs are public** in the feed to everyone—the feed is the source of truth (ADR 0001). Marks stay private on the board but are public in aggregate via the per-prompt **tally** (ADR 0002).
- [x] **Admins:** a 2-4 person roster for round-the-clock moderation coverage—seed Nathan's uid, add co-admins post-sign-in via console. **Skip** a dedicated dispute-override tool.
- [x] **Share set:** "I got BINGO" + leaderboard only (no per-square proof cards), generated **on-device** and dropped into the chat; the Cloud Run OG path is dropped (ADR 0005).

The review also added three mechanics not in the original PRD—the per-prompt **tally** (ADR 0002), broadcast **moments** in the feed, and the **doubt** ("ask for proof") social pressure a proof satisfies—plus first-class **offline** resilience (ADR 0006). Scope was re-drawn: the tally is embarkation-critical; moments, share cards, and doubts are fast-follow (ideally by departure), cheap to ship mid-cruise via the auto-updating PWA. The glossary lives in `CONTEXT.md`.

## Shipped since the design review (2026-07-07 → 07-11)

Post-review work that landed beyond the PRD's original scope, by area (issue numbers reference the app repo):

- **Product analytics—PostHog alongside GA4 (#96).** `track()` dual-dispatches every named event to both sinks; PostHog additionally autocaptures clicks, SPA pageviews/pageleaves, and heatmaps, and records **unmasked session replay** by owner decision (owner is the sole viewer; disclosed in ConsentNotice; identity is uid-only, and captured URLs are reduced to path-only so auth-handler query params never reach analytics, #198). Served through the first-party reverse proxy `d.gaycruisebingo.com` (#151); init skipped on local-dev hosts (#196). GA4 gained `login_failed` (#165).
- **In-app bug reporting (#157).** Private admin inbox with screenshot evidence (desktop fallback #169), capture hardening (#167), runtime-identity pinning (#160), an agent-ready import runbook (#177), and repeat-deploy hardening (#189).
- **Claim flow (#184).** Every claim now opens the Proof sheet; honor mode adds the one-tap 🎖️ Cross My Heart pledge (stricter modes show it disabled as a teach). This is the flow Phase 1.5's claim-sheet changes build on.
- **Prompt pool (#188).** Canonical pool refreshed to the revised 80-playable list (24 spicy / 56 tame) with stratified ~40%-spicy Board composition (#135), a seed drift check (#139), and MIN_POOL auto-recovery re-dealing (#124).
- **Moderation & trust.** Server-authoritative report auto-hide replaced the client-side threshold (#127); admin ban console with rules-owned `bannedUids` and presentational filtering (#119, #122; ADR 0004); Resend-backed admin moderation email (#120); Cloud Vision `moderateProof` deployed behind an off-by-default `ENABLE_VISION_MODERATION` flag, pinned us-east1 (#128, #138).
- **PWA & runtime.** Update-reload banner on new deploys (#179); service worker no longer intercepts `/__/auth/handler` (#183); canonical-origin redirect + same-origin `authDomain` (#161–#165); offline cold boot without awaiting network bootstrap (#117) + stalled-bootstrap timeout (#148); startup progress (#145).
- **Themes & a11y.** WCAG AA contrast hardening across all eight themes—the `--on-gradient` token and computed-from-CSS contrast suites (#123, #130) plus badge-numeral floors (#125). These suites auto-cover Phase 1.5's two new themes.
- **Ops.** Synthetic uptime probe asserting the app actually mounts (#192); launch-checklist runbook, cross-device matrix, and printed-PDF fallback doc (#121); Phase 2 hardening backlog (#137).
- **Reconciliation.** The Cloud Run OG renderer, share function, and `/s` rewrite were fully removed per ADR 0005 (#118)—the PRD's "dropped" is now physically true.

## Appendix

- **Repo:** `nathanjohnpayne/fiveacross`—see `README.md`, `docs/architecture/`, and `DEPLOYMENT.md`. Phase 1 backend deploy steps live in the repo's Phase 1 guide.
- **Domain docs:** `CONTEXT.md` (glossary / ubiquitous language) and `docs/adr/0001-0006` (design decisions) in the app repo.
- **Fallback:** printed 12-card PDF (neon) and the single interactive HTML card.
- **Original printed seed (33, historical):** Threesome · Foursome · Fivesome · Propositioned by septuagenarians · Suite orgy · Domestic violence · Dance-floor blowjob · Locked in a bathroom · Loses passport · Make OnlyFans content on a boat · Make LinkedIn content on a boat · Make out with Patti LuPone · Scabies · 3 loads in one day · Bang a Dutch person · Passaround party Norwegian · Complain about Circuit Music (free space) · Poppers spill · 30-year age gap · Dance-floor k-hole · Cafeteria k-hole · Make out with a woman · 3-way kiss · Cause an international incident · Wear a sissy skirt · Loudly announce you're going to bed early · Karaoke "Fergalicious" · Eat carbs · Become Dick Deck famous · Post butthole pic to Telegram · Use a condom · Mirror-hall selfie · Snort powder off a cock. The **current canonical pool is 80 playable prompts** (24 spicy / 56 tame, #188), seeded per the app repo's `src/data/seed.ts` and `specs/seed-and-composition.md`; Phase 1.5 adds two curated 28-item tutorial pools (embark/farewell) in `plans/daily-cards-spec.md`.
- **Themes (8 + 2):** Get Sporty · Duty Free · Glamiators · Neon Playground (default) · Summer White · Dog Tag T-Dance · Revival Disco · Seriously Pink; Phase 1.5 adds the tutorial themes Welcome Aboard (embark) and So Long, Farewell (disembark).
- **Analytics events:** `login`, `login_failed`, `join_event`, `add_item`, `report_item`, `mark_square`, `attach_proof`, `demand_proof`, `bingo`, `blackout`, `theme_change`, `share_click`, `install_pwa`—every named event dual-dispatches to GA4 **and** PostHog (#96), with PostHog autocapture/replay on top (see Shipped log).
- **Phase 1.5 sources:** `plans/daily-cards-spec.md` (canonical spec, incl. resolved decisions) and `plans/daily-cards-wireframes.html` (22 themed iPhone 15 Pro frames) in the app repo.
