# Gay Cruise Bingo—Ticket Backlog

Decomposition of the locked design into a complete, parallelizable ticket backlog. This is the ticket → issue map and the coverage matrix. The dependency DAG, waves, and hot-file plan live in [`gaycruisebingo-parallelization.md`](gaycruisebingo-parallelization.md); the Sprint 0 stub is [`gaycruisebingo-sprint-0.md`](gaycruisebingo-sprint-0.md).

## Binding sources (design supersedes the scaffold)

- **PRD** (canonical, 2026-07-07 design review): `~/GitHub/docs/projects/gaycruisebingo/prds/gaycruisebingo.md`.
- **Glossary / ubiquitous language**: [`CONTEXT.md`](../CONTEXT.md). Every ticket uses these exact terms (Event, Prompt, Board, Square, Free Space, Mark, BINGO, Blackout, Tally, Feed, Moment, Doubt, Proof, Claim, Claim Mode, Share Card, Leaderboard, First to BINGO, Player, Admin).
- **ADRs 0001–0006** (accepted, binding): [`docs/adr/`](../docs/adr/). Each ticket cites the ADR(s) it implements and must obey them.
- **Scaffold** (`src/`, `functions/`, `cloud-run/`, `*.rules`, `firebase.json`, `scripts/seed.mjs`) predates the ADRs and diverges—each ticket states exists / missing / contradicts.

## Field & label legend

- **Status** (board column): `Backlog` (new) · `Ready` (unblocked Wave-0) · `In progress` (claimed) · `In review` (PR open) · `Done` (merged).
- **Project fields**: `Track` · `Phase` (0 / 1 / 2 / hardening) · `Wave` (0–4) · `Size` (S/M/L) · `ADR` (which ADR it implements).
- **Labels**: `track:*` · `phase-0` / `phase-1` / `phase-2` / `hardening` · `wave-0…4` · `size:S|M|L` · `needs-phase-4` (protected-path / likely >300-line PR—keep small, expect external review) · `reconciliation` · `decision-needed` (repo's existing label; = the task's "needs-human-decision") · `agent-action` · `epic`.
- **Phase-4 reality** (from `.github/review-policy.yml`): the merge-blocking label is `needs-external-review`, applied automatically when a PR is ≥ 300 changed lines or touches `src/auth/**`, `**/*secret*`, `**/*credential*`, or `.github/**`. `firestore.rules` / `storage.rules` / `functions/` are **not** protected paths today (they only escalate at ≥300 lines)—the `needs-phase-4` label here is a planning marker meaning "keep this PR small / expect Phase 4." `w3-security-hardening` proposes adding those globs to `external_review_paths`.

## Definition of Done (every ticket)

1. A real spec under `specs/<feature>.md` **with a matching test** (checker `scripts/ci/check_spec_test_alignment` matches basename → a test under `tests/**` or `src/**/*.test.*`; design-only specs use frontmatter `tested: false` + `reason:`).
2. Local green `npm run typecheck` · `npm test` · `npm run build` (there is **no** `lint` script and app tests are **not** CI-run—these are agent-run gates, recorded in the commit's `Verified:` trailer).
3. Tests at the right layer (unit / RTL-jsdom / rules-emulator / functions / Playwright e2e). No ticket Done without green tests + a spec↔test match.
4. Conventional-commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body `Closes #<issue>`; authored as `nathanjohnpayne`, reviewed under `nathanpayne-{agent}` per REVIEW_POLICY.md; driven to merge.
5. Board discipline per [`docs/agents/ticket-workflow.md`](../docs/agents/ticket-workflow.md): claim → `In progress` + self-assign; PR open → `In review`; merge → `Done`.

## Ticket table

Issue numbers are filled in after creation (see the slug → issue map at the bottom, written by the driver). Deps use slugs; `Blocks` is the inverse (see the DAG).

| Ref (slug) | Title | Epic | Track | Phase | Wave | Size | ADR | Depends on | Init status |
|---|---|---|---|---|---|---|---|---|---|
| **epic-foundation** | Epic: Foundation & test harness | — | foundation | 0 | 0 | — | — | — | Backlog |
| **epic-identity** | Epic: Identity, 18+ attestation & profile | — | identity | 0 | 1 | — | — | — | Backlog |
| **epic-play** | Epic: Core play—Board, Prompts, Themes, PWA | — | play | 0 | 1 | — | — | — | Backlog |
| **epic-social** | Epic: Social core—Tally, Doubts, Proof, Feed/Moments, Leaderboard, Claims, Share Cards | — | feed | 0 | 2 | — | — | — | Backlog |
| **epic-moderation** | Epic: Moderation, analytics & scaffold reconciliation | — | moderation | 0 | 2 | — | — | — | Backlog |
| **epic-backend** | Epic: Phase 1 backend & infra | — | backend | 1 | 4 | — | — | — | Backlog |
| **epic-launch** | Epic: Launch, e2e & cross-cutting | — | launch | hardening | 3 | — | — | — | Backlog |
| **epic-phase2-hardening** | Epic: Phase 2—Hardening (Cloud Vision, App Check, archive) | — | backend | 2 | 4 | — | — | — | Backlog |
| w0-test-harness | Wire the test harness (vitest jsdom + RTL, emulator rules tests, Playwright e2e, CI) | foundation | foundation | 0 | 0 | L | 0001,0002 | — | **Ready** |
| w0-type-contract | Reconcile the domain type contract (rename `verified`→`admin_confirmed`, drop `blackoutEnabled`, add Tally/Doubt/Moment/attestation types) | foundation | foundation | 0 | 0 | M | 0001,0002,0004 | — | **Ready** |
| w0-app-shell | App shell & bottom-tab navigation (stable route mount points) | foundation | foundation | 0 | 0 | M | — | — | **Ready** |
| w0-firestore-rules | Firestore rules baseline + rules-emulator tests (self-writable allowed; Tally/Doubts/Moments/attestation) | foundation | security | 0 | 0 | L | 0001,0002,0004 | w0-test-harness | Backlog |
| w0-storage-rules | Storage rules review + emulator tests (proof/avatar MIME + size caps) | foundation | security | 0 | 0 | S | 0004 | w0-test-harness | Backlog |
| w0-offline-persistence | Firestore offline persistence (`persistentLocalCache` + multi-tab) so Marks queue durably | foundation | offline | 0 | 0 | M | 0006 | w0-test-harness | Backlog |
| w1-auth-google | Google sign-in + AuthContext hardening (surface join/deal errors) | identity | identity | 0 | 1 | M | 0001 | w0-app-shell | Backlog |
| w1-adult-attestation | Persist the 18+ attestation as a timestamped profile attestation | identity | identity | 0 | 1 | M | 0001 | w1-auth-google, w0-type-contract, w0-firestore-rules | Backlog |
| w1-profile-avatar | Profile: display name + custom avatar upload | identity | identity | 0 | 1 | M | 0002 | w1-auth-google, w0-storage-rules | Backlog |
| w1-event-seed | Reconcile the Event/pool seed script (`scripts/seed.mjs`): drop `blackoutEnabled`, admin roster, threshold, align `claimMode` | identity | foundation | 0 | 1 | S | 0003,0004 | w0-type-contract | Backlog |
| w1-board-deal-join | Board render + deal/freeze-at-join (24 + Free Space; guard pool<24; NO re-deal) | play | play | 0 | 1 | L | 0003 | w0-app-shell, w0-type-contract, w0-firestore-rules | Backlog |
| w1-board-mark-win | Mark a Square + BINGO/Blackout detection + celebration (offline-durable Marks) | play | play | 0 | 1 | L | 0001,0006 | w1-board-deal-join, w0-offline-persistence | Backlog |
| w1-prompt-pool | Prompt pool: add / report / rate-limit + before-the-Event framing | play | prompts | 0 | 1 | M | 0003,0004 | w0-app-shell, w0-firestore-rules | Backlog |
| w1-themes | 8 Atlantis Themes: switcher + persistence + WCAG contrast | play | themes | 0 | 1 | M | — | w0-app-shell | Backlog |
| w1-pwa | PWA: manifest / SW / install prompt / iOS safe-area / Lighthouse ≥ 90 | play | pwa | 0 | 1 | M | 0006 | w0-app-shell | Backlog |
| w2-tally | Per-Prompt **Tally**: every Mark publishes an attributed public record + tap-to-see-who | social | tally | 0 | 2 | L | 0001,0002 | w1-board-mark-win, w0-firestore-rules, w0-type-contract | Backlog |
| w2-proof-capture | **Proof** capture (photo/audio/text) + on-device downscale + Storage upload | social | proof | 0 | 2 | L | 0002,0004 | w1-board-mark-win, w0-storage-rules | Backlog |
| w2-doubts | **Doubts** (ask-for-proof): count on Square + Tally, satisfied by a Proof | social | doubts | 0 | 2 | M | 0001,0002 | w2-tally, w2-proof-capture | Backlog |
| w2-feed-moments | **Feed** = Proofs + **Moments** (first-BINGO / Blackout / First to BINGO; bare Marks post nothing) | social | feed | 0 | 2 | L | 0002 | w2-proof-capture, w1-board-mark-win | Backlog |
| w2-leaderboard | **Leaderboard**: bingos→squares→earliest-first-bingo, pinned First to BINGO, filters | social | leaderboard | 0 | 2 | M | 0001 | w1-board-mark-win | Backlog |
| w2-share-cards | On-device **Share Cards** (BINGO + Leaderboard) → native share sheet | social | share | 0 | 2 | M | 0005 | w1-board-mark-win, w2-leaderboard | Backlog |
| w2-admin-console | Admin & moderation console: reactive auto-hide at `reportHideThreshold` (client Phase 0) + report queue + ban | moderation | moderation | 0 | 2 | L | 0004 | w1-prompt-pool, w2-proof-capture, w0-firestore-rules | Backlog |
| w2-ga4-events | GA4 events + DebugView + consent notice (complete the 12-event set) | moderation | analytics | 0 | 2 | M | — | w0-app-shell | Backlog |
| recon-share-og | Reconciliation: remove `cloud-run/og-renderer` + `share` function + `/s` rewrite; keep static `og-default.png` | moderation | reconciliation | 0 | 2 | M | 0005 | w2-share-cards | Backlog |
| recon-recompute-stats | Reconciliation: remove `recomputeStats` as anti-cheat + fix `phase-1-deploy.md` stat-locking guidance | moderation | reconciliation | 0 | 2 | S | 0001 | — | Backlog |
| w3-claim-modes | Claim Modes (honor / proof_required / **admin_confirmed**) + Claims + admin confirm/reject | social | claims | 0 | 3 | L | 0001 | w2-admin-console, w2-proof-capture, w0-type-contract | Backlog |
| w3-security-hardening | Security & rules hardening: noindex, acceptable-use page, self-writable-by-design docs, protected-path policy | moderation | security | hardening | 3 | M | 0001,0002,0004 | w0-firestore-rules | Backlog |
| w4-phase1-functions | Phase 1 functions: server-authoritative hide (flip `status` at threshold) + keep Vision extreme-only + sharp thumbs | backend | backend | 1 | 4 | L | 0004 | w2-admin-console, w0-firestore-rules | Backlog |
| w4-app-check | App Check enforcement (reCAPTCHA Enterprise): provision key + enforce | phase2-hardening | backend | 2 | 4 | M | 0004 | w1-auth-google | Backlog |
| w4-infra-domain | Infra: Cloudflare → Firebase Hosting custom domain + SSL (DNS-only) + headers | backend | infra | hardening | 4 | M | — | — | Backlog |
| w4-infra-blaze-budget | Infra: Blaze upgrade + budget alert before enabling Phase 1 | backend | infra | 1 | 4 | S | — | — | Backlog |
| p2-vision-proof | Cloud Vision (proof): re-enable the gated `moderateProof` SafeSearch scanner + thumbnails | phase2-hardening | proof | 2 | 4 | M | 0004 | w2-proof-capture, w4-infra-blaze-budget | Backlog |
| p2-vision-moderation | Cloud Vision (moderation): auto-hide extreme/illegal Vision flags (extend shipped autohide) | phase2-hardening | moderation | 2 | 4 | M | 0004 | p2-vision-proof, w2-admin-console | Backlog |
| p2-archive | Post-Event archive: freeze the Event + durable Leaderboard / First-to-BINGO hall of fame | phase2-hardening | launch | 2 | 4 | M | 0001,0003 | w2-leaderboard, w2-feed-moments | Backlog |
| x-e2e-happy-path | E2E happy-path (join → mark → BINGO → leaderboard) + offline-mark test against the emulator | launch | launch | hardening | 3 | M | 0006 | w1-board-mark-win, w2-leaderboard, w0-test-harness | Backlog |
| x-launch-checklist | Cross-device matrix + launch checklist + printed-PDF fallback | launch | launch | hardening | 4 | M | — | x-e2e-happy-path | Backlog |
| x-multi-event-schema | Multi-event schema readiness (P2, design-only) | launch | schema | hardening | 4 | S | 0003 | — | Backlog |
| x-decisions-needed | Decisions needed: open operational/config choices blocking specific tickets | — | launch | 0 | 0 | S | — | — | Backlog |

## Per-ticket specs

Each expands into a full templated issue body (`scripts/gh-projects/examples/gaycruisebingo/bodies/<slug>.md`). Compact form here: **scope** · **current state** · **key files** · **key tests/ACs**.

### Wave 0—Foundation (unblocks everything)

**w0-test-harness**—Stand up the four test layers the DoD needs. Scope: switch Vitest to a jsdom project (currently `environment:'node'` in `vite.config.ts`) + add `@testing-library/react` for component tests; add `@firebase/rules-unit-testing` + an `emulators` block in `firebase.json` + an `emulator`/`test:rules` npm script; add Playwright + `playwright.config.ts` + `test:e2e`; add a GitHub Actions job that runs `typecheck`/`test`/`build` + rules tests (none exists today). Extend `src/game/logic.test.ts` with the missing `dealBoard(<24)` throw test. Current: only Vitest-unit in node env; no jsdom/RTL, no rules-unit-testing, no Playwright, no app CI. Files: `vite.config.ts`, `firebase.json`, `package.json`, `playwright.config.ts` (new), `.github/workflows/app-ci.yml` (new), `tests/rules/*.test.ts` (new), `src/game/logic.test.ts`. Enables the ADR-0001/0002 rules assertions used by `w0-firestore-rules`.

**w0-type-contract** *(reconciliation)*—Own the shared type contract so downstream tickets don't collide on `src/types.ts`. Scope: rename `ClaimMode` value `'verified'`→`'admin_confirmed'` across `types.ts` + all call sites (`Board.tsx`, `ProofSheet.tsx`, `Admin.tsx`, `data/api.ts`, `data/proofs.ts`, `data/admin.ts`, `logic.test.ts`) with a read-migration that still accepts a legacy `'verified'` value; remove dead `EventDoc.settings.blackoutEnabled` (types only—`seed.mjs` handled by `w1-event-seed`); add `TallyEntry`/`TallyDoc`, `DoubtDoc`, `MomentDoc`, and `UserDoc.attestedAdultAt?`; fix the `Cell.status` comment (drop "verified"). Current: `types.ts:4` `'verified'`, `:26` `blackoutEnabled`, no Tally/Doubt/Moment/attestation types. ADR 0001 (rename), 0004 (drop dead config), 0002 (new social types). Tests: unit that the migration reads legacy `'verified'` as `admin_confirmed`.

**w0-app-shell**—Formalize `App.tsx` routes + a `Nav.tsx` bottom tab-bar (Card / Feed / Ranks / Prompts / Admin-if-admin) as **stable mount points** so feature tickets fill their tab without editing `App.tsx`/`Nav.tsx`. One-handed reachability + iOS safe-area aware. Current: routes exist in `App.tsx`; `Nav.tsx` is a top brand bar. Files: `App.tsx`, `Nav.tsx`, `index.css`. HOT-file owner (see parallelization doc).

**w0-firestore-rules** *(needs-phase-4)*—Reconcile `firestore.rules` to the ADRs and prove it with emulator tests. Scope: keep self-writable `boards/{uid}` + `players/{uid}` and **assert they are ALLOWED** (ADR 0001—a lock-down "fix" is a misread); add rules for the new `tally`, `doubts`, `moments` collections and `users.attestedAdultAt`; keep `items` report-only increment; keep `claims`; validate `settings.reportHideThreshold`. Tests (`@firebase/rules-unit-testing`): self-writable board/player writes ALLOWED (ADR 0001), a Mark publishes to the Tally (ADR 0002), report increments only, proof payload constraints hold. Current: rules have no `tally`/`doubt`/`moment`/attestation, no threshold. Keep the PR < 300 lines. Files: `firestore.rules`, `tests/rules/*.test.ts`.

**w0-storage-rules** *(needs-phase-4)*—Emulator tests for `storage.rules` (`okImage` < 8 MB, `okAudio` < 12 MB, `/avatars/{uid}.jpg`, `/proofs/{eventId}/{uid}/…`, inert `/og/**`). Verify the proof-object pinning matches the Firestore proof-create regex. Current: rules exist; no storage tests. Files: `storage.rules`, `tests/rules/storage.test.ts` (new).

**w0-offline-persistence**—ADR 0006 data layer. Scope: replace `getFirestore(app)` with `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })` in `src/firebase.ts`; add an integration test that a write made while offline persists across a simulated reload and syncs on reconnect. Current: `firebase.ts:21` `getFirestore` (no cache); Workbox shell precache already present. Files: `src/firebase.ts`, `tests/offline/*.test.ts` (new). HOT-file owner of `firebase.ts`.

### Wave 1—Identity & core play

**w1-auth-google** *(needs-phase-4—`src/auth/**` is a protected path)*—Google sign-in via `AuthContext` (exists); **surface** the `joinAndDeal` errors that `App.tsx:21` currently swallows (esp. the ADR-0003/0004 `dealBoard(<24)` guard) as a retry/toast. `track('login')`. Files: `src/auth/AuthContext.tsx`, `src/App.tsx`, `src/components/SignIn.tsx`.

**w1-adult-attestation** *(needs-phase-4)*—Replace the ephemeral 18+ checkbox (`SignIn.tsx:6,24-30`, never persisted) with a persisted `users/{uid}.attestedAdultAt` timestamp (type from `w0-type-contract`); gate first entry; re-prompt if absent (PRD resolved decision + risk mitigation). Files: `SignIn.tsx`, `AuthContext.tsx`, `data/api.ts`, `firestore.rules` (attestation self-write—coordinate w/ `w0-firestore-rules`).

**w1-profile-avatar**—Custom avatar upload via existing `uploadAvatar` (`storage.ts`, `avatars/{uid}.jpg`) + `downscaleImage` (exists); `UserDoc.customPhoto`; profile edit surface. Files: `components/Avatar.tsx`, `data/storage.ts`, a profile component.

**w1-event-seed** *(reconciliation)*—Reconcile `scripts/seed.mjs`: drop `blackoutEnabled` from the seeded `settings` (ADR 0004), align the `claimMode` comment to `admin_confirmed`, confirm `reportHideThreshold` (currently 4), document the `ADMIN_UID` roster flow (2–4 admins incl. Nathan's seed uid). Current: `seed.mjs:71` seeds `blackoutEnabled: true`; admins from `ADMIN_UID` env. Blocked on the roster decision (see `x-decisions-needed`). Files: `scripts/seed.mjs`.

**w1-board-deal-join**—Render the Board + deal/freeze-at-join. `joinAndDeal` (`api.ts:59-90`) already freezes at join and reads the active non-free pool; Free Space center is "Complain about Circuit Music"; **no re-deal / square-swap** (ADR 0003). Surface the `dealBoard(<24)` guard to the user (ADR 0004). Files: `components/Board.tsx`, `data/api.ts`, `game/logic.ts`.

**w1-board-mark-win**—Client-authoritative Mark via `setMark` (`api.ts`, transactional; exists) + `hasBingo`/`isBlackout` + `Celebration.tsx`. Fix the false offline comment (`Board.tsx:65`). A **bare Mark posts nothing to the Feed** (ADR 0002). Add the offline test: mark offline → reload → still queued → syncs (ADR 0006 + PRD metric). Honor mode marks instantly. Files: `Board.tsx`, `Celebration.tsx`, `data/api.ts`.

**w1-prompt-pool**—`ItemPool.tsx` (add + report exist; future-cards note at `:40-42`). Strengthen the before-the-Event framing ("get your prompts in before we sail", ADR 0003); add a client rate-limit on add/report; keep the pool dense (~30–50). Files: `components/ItemPool.tsx`, `data/api.ts`.

**w1-themes**—8 Atlantis Themes (Neon Playground default) already in `theme/themes.ts` + `themes.css` (8 `[data-theme]` blocks) + `ThemeSwitcher`/`ThemeContext` (localStorage `gcb.theme`). Verify WCAG AA contrast across all 8; switch < 5 s (PRD). No Atlantis marks (PRD non-goal). Files: `theme/*`, `components/ThemeSwitcher.tsx`.

**w1-pwa**—Finalize the installable PWA: `vite-plugin-pwa` is wired (manifest + Workbox); add the install prompt (+ the missing `install_pwa` GA4 event), iOS safe-area CSS (`env(safe-area-inset-*)`; `viewport-fit=cover` present), and hit Lighthouse PWA + perf ≥ 90 on a mid-tier phone (PRD metric). Files: `vite.config.ts`, `index.html`, `index.css`, an install-prompt component, `analytics.ts`.

### Wave 2—Social core

**w2-tally** *(core differentiator, launch-critical)*—Greenfield per ADR 0002. Every Mark (proofed or not) publishes an **attributed** entry to its Prompt's Tally (`tally/{itemId}` marker list with uid + displayName). The Square shows a count + tap-to-see-who list. No anonymity. Wire into `setMark` (extends the Wave-1 mark write set—sequenced after `w1-board-mark-win`). Files: `data/api.ts`, `data/paths.ts`, a Tally UI on the Square, `hooks/useData.ts`, `firestore.rules` (from `w0`). Test: a Mark writes a Tally entry (rules + unit).

**w2-proof-capture**—Proof capture is largely scaffolded: `ProofSheet.tsx` (photo / audio via MediaRecorder / text), `attachProof` (`proofs.ts`, transactional), `downscaleImage` + `uploadProofMedia` (`storage.ts`) all exist. Complete/verify: a Proof posts to the Feed (ADR 0002); `proof_required` mode requires a Proof to Mark; offline—the Mark queues and media attaches on reconnect (ADR 0006). Files: `ProofSheet.tsx`, `data/proofs.ts`, `data/storage.ts`.

**w2-doubts**—Greenfield. A Player publicly asks another to back up a specific marked Prompt ("pics or it didn't happen"); the Doubt count shows on the marked Square + the Tally entry; attaching a Proof satisfies it. Social pressure, **never a gate** (ADR 0001). Add the missing `demand_proof` GA4 event. Files: `doubts` collection + `DoubtDoc` (type from `w0`), `data/*`, Square/Tally UI, `firestore.rules` (from `w0`).

**w2-feed-moments**—`ProofFeed.tsx` → the Feed (proofs, report, owner-delete, flagged badge exist). Add **Moments**: broadcast a Moment doc on first BINGO, Blackout, and First to BINGO, merged newest-first into the Feed. A **bare Mark posts nothing** (ADR 0002). Files: `components/ProofFeed.tsx` (rename surface to Feed), `moments` collection + `MomentDoc`, `data/*`, `hooks/useData.ts`.

**w2-leaderboard**—`Leaderboard.tsx` (sorted, "1st BINGO" pin, BLACKOUT suffix) already uses `comparePlayers`/`sortPlayers` (correct tie-break: bingos → squares → earliest first-bingo). Client-authoritative stats (ADR 0001). Add filters; verify the tie-break order (PRD metric). Composite index already present. Files: `components/Leaderboard.tsx`, `hooks/useData.ts`.

**w2-share-cards**—Replace the text-only share in `Celebration.tsx` (currently `navigator.share({title,text,url})`) with an **on-device image** (canvas / `html-to-image` → blob) handed to `navigator.share({ files })`. BINGO celebration = primary surface, Leaderboard = second; **BINGO + Leaderboard cards only** (ADR 0005). Sharing is Phase 0. `share_click` exists; target ≥ 25 share events (PRD). New dep: `html-to-image`. Files: `Celebration.tsx`, `Leaderboard.tsx`, a share-card renderer, `package.json`.

**w2-admin-console**—`Admin.tsx` already hides/restores/deletes items + proofs, resolves pending claims, and shows the `visionFlag` pill. Add the **Phase-0 client-side presentational auto-hide**: every client filters content whose `reportCount ≥ event.settings.reportHideThreshold` (currently typed-but-dead) in the read hooks (`useProofFeed`/`useItems`/`useAllItems`); surface the report queue (`useReportedProofs` exists); add admin ban. Bypassable by design (ADR 0004 Phase 0). Files: `components/Admin.tsx`, `hooks/useData.ts`, `data/admin.ts`.

**w2-ga4-events**—`analytics.ts` `track()` exists with 10 of 12 PRD events. Wire the missing `demand_proof` (with `w2-doubts`) + `install_pwa` (with `w1-pwa`); verify all 12 in DebugView; add a lightweight consent notice for the 18+ audience. Files: `analytics.ts`, consent component.

**recon-share-og** *(reconciliation)*—Net-removal per ADR 0005 (after `w2-share-cards` lands the replacement): delete `cloud-run/og-renderer/`, the `share` function (`functions/src/index.ts:101`), the `firebase.json` `/s/**`→`share` rewrite, and the inert `storage.rules` `/og/**` block. Keep `public/og-default.png` + the `index.html` static OG. Update docs. Build stays green with no dangling refs. Files: `cloud-run/**`, `functions/src/index.ts`, `firebase.json`, `storage.rules`.

**recon-recompute-stats** *(reconciliation, needs-phase-4—`functions/`)*—Remove `recomputeStats` (`functions/src/index.ts:68`) as anti-cheat (ADR 0001—self-writable players are intentional); if kept at all, relabel as explicit consistency/repair only. Fix `docs/app/phase-1-deploy.md` guidance that says to lock player-stat writes to admins-only. Files: `functions/src/index.ts`, `docs/app/phase-1-deploy.md`.

### Wave 3—Remaining social + hardening

**w3-claim-modes**—Event-level Claim Mode (friction/vibe knob, **not** trust—ADR 0001). `honor` marks instantly; `proof_required` needs a Proof; `admin_confirmed` (renamed from `verified`) makes the Mark pending + creates a Claim (`claims` collection exists) for an Admin to confirm/reject (`Admin.tsx` resolve UI + `resolve()` recompute exist). Depends on the admin console + proof capture + the rename. Files: `data/api.ts`, `data/admin.ts`, `components/Admin.tsx`, `components/Board.tsx`.

**w3-security-hardening** *(needs-phase-4)*—Verify `noindex` (`index.html:25`); add an acceptable-use / community-guidelines page (18+, reporting); **document self-writable-by-design** in the rules comments (ADR 0001) and Tally-publishes-marks (ADR 0002) so a future reviewer doesn't "fix" them; **propose adding `firestore.rules` / `storage.rules` / `functions/**` to `.github/review-policy.yml` `external_review_paths`** (the protected-path gap). No public unauthenticated pages (ADR 0005). Files: `firestore.rules` (comments), `index.html`, an acceptable-use page, `.github/review-policy.yml`.

### Wave 4—Phase 1 backend & infra

**w4-phase1-functions** *(needs-phase-4, phase-1, Blaze)*—`moderateProof` (sharp thumbnail + Cloud Vision extreme/illegal-only; **not** raciness) already satisfies ADR-0004 Phase 1—keep it. Add server-authoritative hide: a Function that flips `proof`/`item` `status:'hidden'` when `reportCount ≥ threshold` (Phase 1 makes the Phase-0 client hide authoritative), plus the Phase-1 rules update making `status` server-set. Do **not** re-add `recomputeStats` as anti-cheat. Files: `functions/src/index.ts`, `firestore.rules`.

**w4-app-check** *(needs-phase-4, phase-1, decision-needed)*—`firebase.ts` already scaffolds `initializeAppCheck` with `ReCaptchaEnterpriseProvider` gated on `VITE_RECAPTCHA_SITE_KEY`. Provision the reCAPTCHA Enterprise key (GCP), set the env, enable enforcement for Firestore + Storage. Decision: key + enforcement timing. Files: `firebase.ts` (already wired), env/config, Firebase console.

**w4-infra-domain** *(needs-phase-4)*—Connect `gaycruisebingo.com` (Cloudflare → Firebase Hosting), DNS-only / unproxied so Firebase issues the cert (PRD risk: up to ~24 h); verify hosting headers. Deploy via `op-firebase-deploy`. Phase 0 hosting runs on Spark.

**w4-infra-blaze-budget** *(needs-phase-4, phase-1, decision-needed)*—Upgrade to Blaze (gates Functions + Cloud Vision) and set a budget alert **before** enabling Phase 1 (PRD mitigation). Decision: budget threshold $.

### Phase 2—Hardening (post-launch)

Epic [#131](https://github.com/nathanjohnpayne/gaycruisebingo/issues/131). The post-launch server-side hardening pass, added 2026-07-09. Context that supersedes the Wave-4 rows above: the Phase-1 backend infra has largely merged—`w4-infra-blaze-budget` (#46), `w4-infra-domain` (#45), and the server-authoritative report-count auto-hide from `w4-phase1-functions` (#43 → PR #127, `functions/src/autohide.ts`) are all **Done**. Cloud Vision (`moderateProof`) was then deliberately **gated off** by a human decision ([#126](https://github.com/nathanjohnpayne/gaycruisebingo/issues/126) → PR #128—an off-by-default `ENABLE_VISION_MODERATION` flag, `functions/src/visionGate.ts`) so the #101 email notifiers could deploy without `moderateProof`'s us-central1/us-east1 region mismatch blocking the whole `functions/` deploy. This epic re-enables Vision and finishes hardening; `w4-app-check` moved here from `epic-backend`.

**p2-vision-proof** *(needs-phase-4, phase-2, Blaze)*—The **producer** half of Cloud Vision: reverse the #126 deferral. Resolve the us-central1/us-east1 region mismatch so `moderateProof` validates, enable the Cloud Vision API, set `ENABLE_VISION_MODERATION=true` in `functions/.env.<projectId>`, deploy and verify SafeSearch on a real Proof upload—extreme/illegal-only, never raciness—plus the `sharp` thumbnail. `moderateProofHandler` logic is unchanged. Files: `functions/src/index.ts` (`:40` handler, `:81` gated export), `functions/.env.<projectId>`, `docs/app/phase-1-deploy.md`, `specs/cloud-vision-proof.md`.

**p2-vision-moderation** *(needs-phase-4, phase-2)*—The **consumer** half: promote an extreme/illegal `visionFlag` to a server-authoritative `status:'hidden'`. The shipped report-count auto-hide (`functions/src/autohide.ts`, #43) is *active-only* and deliberately leaves `flagged` docs alone, so today nothing auto-hides a Vision flag. Add the Vision-flag → hide path without regressing that invariant, and mark Vision-flagged items in the moderation queue (reason + restore). Files: `functions/src/autohide.ts` (or sibling), `firestore.rules`, `components/Admin.tsx`, `hooks/useData.ts`, `specs/cloud-vision-moderation.md`.

**p2-archive** *(needs-phase-4—touches `firestore.rules`)*—The PRD "remember the winners" end state: after the Event, freeze it to read-only and persist the final Leaderboard + First-to-BINGO hall of fame. `EventDoc.status` already types `'archived'` (`src/types.ts:28`) but nothing sets or reacts to it. Files: `src/types.ts` (`archivedAt` + snapshot), `firestore.rules` (deny gameplay writes when archived; admin-only toggle), `components/Leaderboard.tsx`, `data/admin.ts`, `specs/post-sailing-archive.md`.

### Cross-cutting / launch

**x-e2e-happy-path**—Playwright e2e (harness from `w0`) against the emulator: a full round join → mark → BINGO → leaderboard with zero coordination (PRD metric), plus the offline-mark-survives-reload assertion (ADR 0006).

**x-launch-checklist**—iOS/Android device matrix, launch runbook, one-handed reachability check, and the printed 12-card PDF fallback documented (PRD fallback).

**x-multi-event-schema** *(design-only)*—Document that the schema is already event-scoped (`events/{eventId}`), a second Event = a new Event doc, and there is **no** room-browsing / join-code UI (PRD non-goal, ADR 0003). Spec only (`tested: false` + `reason:`), no code.

**x-decisions-needed** *(decision-needed)*—One issue collecting the genuine open operational/config decisions, each tagged with the ticket(s) it blocks: admin roster (2–4 uids incl. Nathan's seed uid) → `w1-event-seed`; confirm `reportHideThreshold` = 4 → `w2-admin-console`; Blaze budget $ → `w4-infra-blaze-budget`; reCAPTCHA Enterprise key + enforcement timing → `w4-app-check`; domain cutover timing → `w4-infra-domain`; GA4 consent copy/region → `w2-ga4-events`; keep `recomputeStats` as labeled repair? (default: remove) → `recon-recompute-stats`. Blocks **only** those tickets, not the whole backlog.

## Coverage matrix

### PRD Goals & Success Metrics → tickets

| PRD Goal (metric) | Tickets |
|---|---|
| Live & shared—round playable end-to-end, ≥70% mark ≥1, ≥40% BINGO | w1-auth-google, w1-event-seed, w1-board-deal-join, w1-board-mark-win, w2-leaderboard, x-e2e-happy-path |
| Phone-native—installable PWA iOS+Android, Lighthouse ≥ 90, one-handed | w1-pwa, w0-app-shell, x-launch-checklist |
| Make it theirs—community-editable pool, 8 themes, add/switch < 5 s | w1-prompt-pool, w1-themes |
| Shareable—on-device Share Cards, ≥ 25 share events | w2-share-cards, w2-ga4-events |
| Remember winners—durable Leaderboard + First to BINGO, archive | w2-leaderboard, w2-feed-moments, x-multi-event-schema, p2-archive |

### PRD Non-Goals → enforcing tickets

| Non-Goal | Enforced by |
|---|---|
| No real verification / anti-cheat | w0-type-contract, w0-firestore-rules, recon-recompute-stats, w3-security-hardening (ADR 0001) |
| No multi-tenant "rooms" | x-multi-event-schema (single active Event; ADR 0003) |
| No payments / Atlantis affiliation | w3-security-hardening (acceptable-use, no marks), w1-themes |
| No native App Store / Play Store | w1-pwa |
| No heavy pre-moderation (reactive only) | w2-admin-console, w4-phase1-functions (ADR 0004) |
| No non-Google login | w1-auth-google |

### Glossary concept → tickets (esp. the design-review additions)

| Concept | Tickets |
|---|---|
| Event / Prompt / pool | w1-event-seed, w1-prompt-pool, x-multi-event-schema |
| Theme | w1-themes |
| Board / Square / Free Space | w1-board-deal-join |
| Mark / BINGO / Blackout | w1-board-mark-win, w2-feed-moments |
| User / Player | w1-auth-google, w1-profile-avatar, w1-board-deal-join, w2-leaderboard |
| Admin | w1-event-seed, w2-admin-console |
| **Tally** ⭐ | **w2-tally** (+ w0-firestore-rules, w0-type-contract) |
| **Doubt** ⭐ | **w2-doubts** |
| **Moment** ⭐ | **w2-feed-moments** |
| Feed | w2-feed-moments |
| Proof / Claim | w2-proof-capture, w3-claim-modes |
| Claim Mode (Honor / Proof-to-mark / **Admin-confirmed** ⭐) | w3-claim-modes, w0-type-contract (rename) |
| **Share Card** ⭐ | **w2-share-cards** |
| Leaderboard / First to BINGO | w2-leaderboard, w2-feed-moments |

### ADR → tickets

| ADR | Tickets |
|---|---|
| **0001** honor-system (client-authoritative; self-writable intentional; no recompute-as-anti-cheat) | w0-type-contract, w0-firestore-rules, w1-board-mark-win, w2-leaderboard, w2-tally, w2-doubts, w3-claim-modes, recon-recompute-stats, w3-security-hardening, p2-archive |
| **0002** Mark visibility (private Board, public per-Prompt Tally; bare Mark posts nothing) | w2-tally, w2-feed-moments, w2-proof-capture, w0-firestore-rules, w3-security-hardening |
| **0003** pool is pre-cruise (freeze at join; dense; no re-deal) | w1-prompt-pool, w1-board-deal-join, w1-event-seed, x-multi-event-schema, p2-archive |
| **0004** reactive moderation (report → threshold → hide; client Phase 0 → server Phase 1; remove `blackoutEnabled`; guard pool<24) | w2-admin-console, w4-phase1-functions, w0-firestore-rules, w0-type-contract, w1-event-seed, w1-board-deal-join, w0-storage-rules, p2-vision-proof, p2-vision-moderation |
| **0005** client-side Share Cards (on-device; drop Cloud Run OG + `share` pages; keep static og-default) | w2-share-cards, recon-share-og |
| **0006** offline resilience (`persistentLocalCache` + durable Mark queue; shell precached) | w0-offline-persistence, w1-board-mark-win, w1-pwa, x-e2e-happy-path |

## Slug → issue number map

Created 2026-07-07 on [Project #7](https://github.com/users/nathanjohnpayne/projects/7) / [issues](https://github.com/nathanjohnpayne/gaycruisebingo/issues). Ready queue: **#8, #16, #17**.

| Epic | # | Children (slug → #) |
|---|---|---|
| epic-foundation | 7 | w0-test-harness 8 · w0-type-contract 16 · w0-app-shell 17 · w0-firestore-rules 18 · w0-storage-rules 19 · w0-offline-persistence 20 |
| epic-identity | 9 | w1-auth-google 21 · w1-event-seed 22 · w1-adult-attestation 23 · w1-profile-avatar 25 |
| epic-play | 10 | w1-board-deal-join 26 · w1-board-mark-win 27 · w1-prompt-pool 28 · w1-themes 29 · w1-pwa 30 |
| epic-social | 11 | w2-tally 31 · w2-proof-capture 32 · w2-doubts 33 · w2-feed-moments 34 · w2-leaderboard 35 · w2-share-cards 36 · w3-claim-modes 41 |
| epic-moderation | 12 | w2-admin-console 37 · w2-ga4-events 38 · recon-share-og 39 · recon-recompute-stats 40 · w3-security-hardening 42 |
| epic-backend | 13 | w4-phase1-functions 43 · w4-infra-domain 45 · w4-infra-blaze-budget 46 |
| epic-launch | 14 | x-e2e-happy-path 47 · x-launch-checklist 48 · x-multi-event-schema 49 |
| epic-phase2-hardening | 131 | w4-app-check 44 (moved from epic-backend) · p2-vision-proof 132 · p2-vision-moderation 133 · p2-archive 134 |
| _(standalone)_ | — | x-decisions-needed 15 |

Board driver: [`scripts/gh-projects/examples/gaycruisebingo/create-issues.sh`](../scripts/gh-projects/examples/gaycruisebingo/create-issues.sh) (idempotent; re-runnable) + [`set-fields.sh`](../scripts/gh-projects/examples/gaycruisebingo/set-fields.sh); templated bodies under [`bodies/`](../scripts/gh-projects/examples/gaycruisebingo/bodies/).
