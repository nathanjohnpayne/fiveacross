# 0002: Application Architecture

## Status

Accepted — the initial architecture for the Five Across web application, then shipping only as its Gay Cruise Bingo Edition. Living document; supersede with a new ADR for any material change (framework, backend model, or data-ownership shift). The canonical product intent lives in the PRD (`nathanjohnpayne/docs` → `projects/gaycruisebingo/prds/gaycruisebingo.md`); this record captures the technical decision.

## Date

2026-07-07

## Context

Five Across is a phone-first, install-to-home-screen web app that makes a printed party bingo card into a live multiplayer game for a specific Event (Trieste → Barcelona, July 15–24, 2026). The dominant constraint is time: the first usable build had to exist by the Event's opening Day, roughly a week out, so the architecture optimizes for the least infrastructure to babysit before a hard date while leaving room to grow. Secondary constraints: it must feel native on both iOS and Android, it hosts user-generated media (photos, audio, named callouts) on a public domain with adult content, and it should stay reusable for future Events without a rewrite.

## Decision

Build a React single-page application with Vite, TypeScript end-to-end, served from Firebase Hosting, backed by Firebase Auth (Google), Cloud Firestore, Cloud Storage, and GA4. TypeScript is used across the whole stack so one shared set of document types (`Event`, `Item`, `Board`, `Player`, `Proof`, `Claim`) describes Firestore documents, the functions that write them, and the React components that read them — the highest-leverage guardrail against a schemaless database.

The system is delivered in two phases with a deliberate data-ownership split.

Phase 0 (the MVP shipped before the Event opened) is Cloud Functions-free: each player writes their own board and their own denormalized stats, and the leaderboard is a client-side sort over the players collection. This is trivially spoofable, which is acceptable for an honor-system party game and removes an entire backend from the launch critical path. It deploys as static hosting plus Firestore/Storage rules, and runs on the Spark plan.

Phase 1 (shipped as live updates during and after the Event) adds a `functions/` package and a Cloud Run service, and requires the Blaze plan. Cloud Functions provide image moderation (Cloud Vision SafeSearch, tuned to flag only extreme/illegal content — never raciness, which is expected here), `sharp` thumbnails, and a crawler-facing `share` page. (An earlier revision of this record also planned authoritative server-side stat recomputation; that was removed under ADR 0001 by #40 — stats stay client-authoritative in every phase.) A Cloud Run container runs Playwright/Chromium to render retina (2400×1260) Open Graph images; it is kept off the request path and its output is cached at the CDN. App Check (reCAPTCHA Enterprise) protects Storage, Firestore, and callable endpoints.

Marking supports three event-level claim modes so integrity is a configuration choice rather than a code change: `honor` (tap to mark; proof optional), `proof_required` (a proof attachment is required to mark), and `verified` (a mark goes `pending` and creates a claim that an admin confirms before it counts).

The Firestore model is event-scoped so additional Events are new documents under `events/`, not a schema change:

```
users/{uid}                      # global profile (cross-event)
events/{eventId}                 # name, sailDates, claimMode, defaultTheme, admins[], settings
events/{eventId}/items/{itemId}  # community-editable prompt pool
events/{eventId}/players/{uid}   # membership + denormalized stats (leaderboard source)
events/{eventId}/boards/{uid}    # a player's frozen 5x5 cells (owner-private)
events/{eventId}/proofs/{id}     # Phase 1: photo/audio/text proof, reportable
events/{eventId}/claims/{id}     # Phase 1: pending claims for 'verified' mode
```

Boards freeze at deal time (24 sampled prompts + a synthetic free center), so prompts added later feed future deals only and existing games stay meaningful. Security rules keep a player's board owner-private, allow any signed-in user to add prompts (with size/rate limits) and to report content, and restrict moderation actions to admins listed on the event document. Storage rules constrain proof/avatar uploads by owner, MIME type, and size.

The domain (`gaycruisebingo.com`, registered at Cloudflare) points at Firebase Hosting via A records set to Firebase's IPs with Cloudflare left in DNS-only (unproxied) mode so Firebase can provision and renew the SSL certificate.

## Consequences

Positive: the launch surface is tiny (static SPA + rules), so there is no backend to operate before the deadline; the phased split lets the richer Phase 1 features land without reworking Phase 0; the event-scoped schema makes a second Event cheap; and TypeScript end-to-end turns schema drift into compile errors during live-ops edits.

Negative / accepted trade-offs: stats are client-trusted and therefore spoofable in every phase — accepted under the honor-system trust model (ADR 0001; the earlier plan to mitigate via `recomputeStats` plus admin-locked stat writes was removed by #40 as anti-cheat); SPA link unfurling requires the crawler-facing `share` rewrite because crawlers do not run JavaScript; and Playwright OG rendering is heavy, which is why it lives on Cloud Run with CDN caching rather than in a function on the request path.

Follow-ups: wire the `.mergepath-project-docs.yml` PRD mirror so the canonical PRD materializes under `docs/projects/gaycruisebingo/prds/`; and write the implementation spec at `specs/gaycruisebingo.md`. (The former follow-up to tighten `players` into server-owned stats once `recomputeStats` deployed was dropped by #40 under ADR 0001.)
