<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/gaycruisebingo/prds/gaycruisebingo.md
source_ref: b4757bb-dirty
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
**Status:** Draft
**Last Updated:** 2026-07-07

## Problem Statement

The printed Atlantis Cruise Bingo card (and its 12-card PDF) is fun but static: no shared state, no way to see who else "got" a square, no bragging, and no record of who won. On a nine-night cruise with a big friend group, the game wants to be social and live—phone-first, with the running commentary and receipts that make an inside joke escalate. Today, it lives in scattered group texts. The cost of not solving it is small in dollars but large in fun: the joke stays flat, the winners are unremembered, and the card is a one-and-done novelty instead of the running bit of the trip.

## Goals & Success Metrics

- **Goal:** Make play live and shared. **Metric:** a round is playable end-to-end (join → mark → bingo → leaderboard) with zero coordination beyond a shared link; ≥ 70% of signed-in players mark ≥ 1 square and ≥ 40% reach a BINGO during the sailing.
- **Goal:** Make it phone-native. **Metric:** installable PWA on iOS and Android; Lighthouse PWA + performance ≥ 90 on a mid-tier phone; primary actions reachable one-handed.
- **Goal:** Make it theirs. **Metric:** the prompt pool is community-editable, and the app reskins into the eight party themes; adding an item and switching themes each take < 5 seconds.
- **Goal:** Make it shareable. **Metric:** a valid retina Open Graph image on 100% of shareable URLs; ≥ 25 share events during the sailing.
- **Goal:** Remember the winners. **Metric:** a durable leaderboard and a "first to BINGO" hall of fame persist for the sailing and archive afterward.

## Non-Goals

- **Real verification / anti-cheat.** The proof system is flavor, not enforcement; integrity is never guaranteed even in stricter claim modes. (Not the point of the product.)
- **Full multi-tenant "rooms" product.** The schema is event-scoped, so future cruises are cheap, but v1 ships a single active event with no room-browsing or join-code UI. (Avoids data-model and UX scope before it's needed.)
- **Payments, tickets, or Atlantis affiliation.** No commerce and no implication of endorsement by Atlantis Events; avoid their marks. (Out of scope and a trademark risk.)
- **Native App Store / Play Store apps.** PWA only. (A store build buys nothing for a one-cruise audience.)
- **Heavy pre-moderation.** Moderation is reactive (report / hide / admin takedown) plus automated flagging for illegal/extreme content only — not a review queue that gates posting. (Friction would kill the vibe.)
- **Non-Google login.** Google is the only identity provider in v1. (Lowest-friction path; everyone already has an account.)

## Background & Context

The printed card and a 12-card print-ready PDF already exist and are the offline fallback if wifi or the app fails. The domain `gaycruisebingo.com` is registered at Cloudflare; the Firebase project is `gaycruisebingo` (project number 849798007162, org `nathanpayne.com`). The cruise sails from Trieste → Barcelona, July 15–24, 2026. The audience is an adult gay-cruise friend group, so the content is deliberately raunchy, and the app is 18+.

Prior art in this account: `friends-and-family-billing` is a comparable Firebase + React web app whose repo docs (APP_SUMMARY, QUICKSTART, FIREBASE_IMPLEMENTATION) are the format precedent for this project's imported documentation.

## Proposal

### Overview

One active event holds a community-editable pool of prompts (seeded from the 33 printed items). Each player who signs in with Google is dealt a frozen, randomized 5×5 card (24 sampled prompts + a free center, "Complain about Circuit Music"). Players tap squares as things happen; a BINGO is five in a line (rows, columns, diagonals; center counts). A leaderboard ranks players by bingos, then squares, then earliest first-bingo, with a pinned "first to BINGO." The whole UI reskins into any of the eight Atlantis party themes. Marking is an honor system by default, with an event-level setting to require proof or require peer/admin confirmation.

### User Experience

Nathan seeds the event and drops the link in the group chat. A friend taps "Continue with Google," confirms 18+, and lands on their neon card. Someone gets propositioned by a septuagenarian, taps the square, and optionally snaps a blurry photo, records a sound, or types a "name names" callout as proof; it posts to a live feed visible to everyone. Three squares later, they hit a diagonal. The screen goes full BINGO, and a personalized retina image is ready to drop back into the chat. The leaderboard reshuffles; escalation ensues. Navigation is a bottom tab bar: Card, Feed, Ranks, Prompts, and (for admins) Admin.

### Technical Approach

React single-page app (Vite) in TypeScript, end-to-end, hosted on Firebase Hosting with Firebase Auth (Google), Firestore (data), Cloud Storage (proof/avatar media), and GA4 (analytics). The data model is event-scoped (`events/{eventId}/…`), so additional cruises are new event documents.

Phase 0 (pre-cruise MVP) is deliberately Cloud Functions-free: each player writes their own board and denormalized stats, and the leaderboard is a client-side sort — trivially spoofable, which is fine for an honor-system party game and dramatically simpler to deploy. Phase 1 adds a `functions/` package (Cloud Vision SafeSearch flagging tuned for extreme/illegal content — not raciness — plus `sharp` thumbnails, authoritative server-side stat recomputation, and a crawler-facing `share` page), a Cloud Run Playwright service for retina OG images, and App Check (reCAPTCHA Enterprise). Marking supports three event-level claim modes: `honor` (default), `proof_required`, and `verified` (marks go pending and create a claim that an admin confirms).

## Dependencies & Risks

| Dependency / Risk | Impact | Mitigation |
|---|---|---|
| Sailing is ~8 days out (embark July 15) | High | Ship a ruthless Phase 0 by embarkation; land Phase 1 (proof, dynamic OG, moderation) as live updates during the cruise. |
| Public app + user-generated photos/audio/names + adult content | Medium-High | One-time 18+ acknowledgment, report/hide, admin takedown console, `noindex`, Storage MIME/size limits, and Cloud Vision flagging for extreme/illegal content only. |
| Custom domain from Cloudflare → Firebase Hosting SSL can take up to ~24h | Medium | Do the domain connection first; set Cloudflare records to DNS-only (unproxied) so Firebase can issue the cert. |
| Playwright OG rendering cost/latency (~2s/image, full Chromium) | Low-Medium | Run on Cloud Run (not in the request path), cache PNGs a day at the CDN, pre-generate on win/leaderboard change. |
| Phase 0 stats are client-trusted | Low | Phase 1 `recomputeStats` makes stats server-authoritative; then lock player-stat writes to admins in rules. |
| Firebase Blaze plan required for Phase 1 (Functions, Cloud Run, Vision) | Low | Phase 0 runs on Spark; set a budget alert before enabling Blaze features. |

## Open Questions

- [ ] Keep the soft one-time 18+ acknowledgment (recommended) or ship with no gate at all?
- [ ] Confirm the launch default claim mode is `honor` + optional proof; should individual squares be able to require proof even in honor mode?
- [ ] Are proofs shown publicly in the feed to all players, or only on the owner's card? (Affects exposure and how central the feed is.)
- [ ] Who are the admins at launch (uids/emails), and do we want a "settle a dispute" override?
- [ ] OG image set for v1 — just "I got BINGO" + leaderboard, or also per-square proof cards?

## Appendix

- **Repo:** `nathanjohnpayne/gaycruisebingo` — see `README.md`, `docs/architecture/`, and `DEPLOYMENT.md`. Phase 1 backend deploy steps live in the repo's Phase 1 guide.
- **Fallback:** printed 12-card PDF (neon) and the single interactive HTML card.
- **Seed pool (33):** Threesome · Foursome · Fivesome · Propositioned by septuagenarians · Suite orgy · Domestic violence · Dance-floor blowjob · Locked in a bathroom · Loses passport · Make OnlyFans content on a boat · Make LinkedIn content on a boat · Make out with Patti LuPone · Scabies · 3 loads in one day · Bang a Dutch person · Passaround party Norwegian · Complain about Circuit Music (free space) · Poppers spill · 30-year age gap · Dance-floor k-hole · Cafeteria k-hole · Make out with a woman · 3-way kiss · Cause an international incident · Wear a sissy skirt · Loudly announce you're going to bed early · Karaoke "Fergalicious" · Eat carbs · Become Dick Deck famous · Post butthole pic to Telegram · Use a condom · Mirror-hall selfie · Snort powder off a cock.
- **Themes (8):** Get Sporty · Duty Free · Glamiators · Neon Playground (default) · Summer White · Dog Tag T-Dance · Revival Disco · Seriously Pink.
- **GA4 events:** `login`, `join_event`, `add_item`, `report_item`, `mark_square`, `attach_proof`, `bingo`, `blackout`, `theme_change`, `share_click`, `install_pwa`.
