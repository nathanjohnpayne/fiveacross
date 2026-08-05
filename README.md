# Five Across

A live, phone-first social bingo platform (PWA) for a group sharing one occasion — a trip, a wedding, a conference, a festival. Sign in, get a randomized card of things that might happen there, and mark them off as they do, with a shared Feed, a leaderboard, per-Day Themes, PWA install, and printed cards as the offline fallback.

The platform wears an **Edition** per class of occasion and runs one **Event** per occasion, addressed by its own hostname. See [`BRAND.md`](BRAND.md) for the Brand / Edition / Namespace model and [`CONTEXT.md`](CONTEXT.md) for the domain language.

## Where it runs

| Edition | Event | Host | State |
|---|---|---|---|
| Gay Cruise Bingo | `med-2026` — Atlantis, Trieste → Barcelona | `gaycruisebingo.com` · `gaycruisebingo.web.app` | Sailed and completed, July 15–24 2026 |
| Vacay Bingo | `bodega-bay-2026` — Bodega Bay house trip | `bodega-bay.vacaybingo.com` (alias `bodega-bay.fiveacrossbingo.com` → 301) | Live; Event runs August 7–9 2026 |

Two production Firebase projects back these — `gaycruisebingo` and `fiveacross` — a data-plane boundary between an adults-only cohort and a general-audience one, not a fork (ADR [0008](docs/adr/0008-five-across-second-firebase-project.md)). One repository, one source tree, one release process. Setup & runbook: [`docs/app/README.md`](docs/app/README.md).

## The game

- An **Event** owns an ordered list of **Days**; each Day owns a date, place, Theme, prompt Pool and unlock time. A Day stays locked until its unlock moment, then freezes a **Day Snapshot** of approved Prompts so everyone deals from the same pool no matter when they open the app.
- A **Day Card** is a frozen, randomized 5×5 board — 24 sampled Prompts plus the always-marked Free Space. Five in a line is a **BINGO**; all 24 non-free is a **Blackout**.
- Marking is an **honor system**: the group, not the server, is the verification (ADR [0001](docs/adr/0001-honor-system-trust-model.md)). **Claim Modes** (Honor, Proof-to-mark, Admin-confirmed) are an Event-wide friction knob, not a trust hierarchy.
- An **Echo Mark** carries a confirmed Mark to every other card of yours holding the same Prompt. A **Reshuffle** trades a still-pristine card for a fresh deal, three per Event.
- **Tally** publishes a public, attributed per-Prompt record — a count plus tap-to-see-who-else-got-it — while your board's layout stays private. **Doubts** let one Player publicly ask another to back up a Mark; **Hearts** add warmth and touch no stats.
- The **Feed** carries Proofs (photo / audio / text), Moments that broadcast the big beats, and admin-authored Notices. The **Leaderboard** ranks bingos → squares → earliest first-bingo with a pinned First to BINGO, and a **Standings Freeze** computes the finale.
- **Share Cards** for a BINGO, the leaderboard and the final standings render on-device and go straight to the native share sheet (ADR [0005](docs/adr/0005-client-side-share-images.md)) — no server in the path.
- Google sign-in with an 18+ acknowledgement, Edition-scoped Themes, offline-durable Marks (ADR [0006](docs/adr/0006-offline-resilience.md)), and PostHog analytics dimensioned by Brand / Edition / Event.

## Stack

Vite · React 18 · TypeScript (strict) · Firebase (Auth · Firestore · Storage · Hosting) · `vite-plugin-pwa` with a custom service worker · Cloud Functions · Cloud Scheduler · PostHog · Cloudflare DNS and edge redirects.

The Functions package carries only what needs a server: scheduled Day unlocks and finale computation, server-authoritative hiding once a report count crosses the Event threshold, admin moderation email, and bug-report intake with thumbnails. Player stats stay client-authoritative by design (ADR 0001).

## Quick start

The full setup — env, seeding, deploy, and custom domains — lives in the **[app guide](docs/app/README.md)**. The short version:

**Node 22.22 or newer is required** (`react-router` 8 sets the floor; `.nvmrc` pins the line, so `nvm use` selects it). On an older Node, `npm install` warns via `EBADENGINE` and then lets every command below run anyway — the failures that follow are unsupported-engine failures, not bugs.

```bash
cp .env.example .env.local     # fill from `firebase apps:sdkconfig WEB` — see app guide §2
npm install
npm run dev                    # local dev at http://localhost:5173
npm test                       # game-logic unit tests
npm run typecheck              # tsc --noEmit, app + service worker
```

Emulator-backed suites (`test:rules`, `test:offline`, `test:functions`) and Playwright e2e (`test:e2e`) gate every merge; see [`docs/agents/testing-requirements.md`](docs/agents/testing-requirements.md).

Deploys go through `scripts/deploy.sh`, which wraps `op-firebase-deploy` (1Password-backed service-account impersonation; never `firebase login` / `firebase deploy` directly) and enforces the main-branch, freshness and clean-tree guards. **Pass the Firebase project explicitly** — `.firebaserc`'s default is `gaycruisebingo`, so a Five Across deploy that omits it ships to the wrong project:

```bash
SYNTHETIC_URL=https://bodega-bay.vacaybingo.com/ scripts/deploy.sh -- fiveacross --only hosting
```

See app guide §5 and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Documentation

| Doc | What |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Domain model and ubiquitous language — the canonical vocabulary |
| [`BRAND.md`](BRAND.md) | Brand, Editions, Namespaces, Themes, and the 18+ posture |
| [`docs/app/README.md`](docs/app/README.md) | App guide + deploy / seed / custom-domain runbook |
| [`docs/app/phase-1-deploy.md`](docs/app/phase-1-deploy.md) | Backend deploy (Functions, App Check) |
| [`docs/app/preview-deploys.md`](docs/app/preview-deploys.md) | Previewing a branch on a real device, with working Google sign-in |
| [`docs/adr/`](docs/adr/) · [`docs/architecture/`](docs/architecture/) | Architecture decision records |
| [`specs/`](specs/) | Per-feature contracts — this repo's canonical spec source |
| [`docs/projects/gaycruisebingo/prds/gaycruisebingo.md`](docs/projects/gaycruisebingo/prds/gaycruisebingo.md) | Founding PRD. Describes the first Edition only and predates the platform model — `CONTEXT.md` and the ADRs win where they differ |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Deploy tooling + 1Password credential model |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) | Contribution workflow · security policy |

## Layout

| Path | Purpose |
|---|---|
| `src/` | App code: game logic, Firebase init, Event/Edition resolution, auth, theme, hooks, components |
| `functions/` | Cloud Functions (unlocks, finale, moderation, email, bug reports — stats stay client-authoritative, ADR 0001) |
| `public/` | Static assets served verbatim (icons, manifest, `og-default.png`, service worker) |
| `firestore.rules` · `storage.rules` · `firestore.indexes.json` | Security rules + indexes |
| `scripts/` | Seed script + build / CI / deploy tooling |
| `tests/`, `src/**/*.test.*` | Automated validation |
| `docs/`, `specs/`, `plans/`, `rules/` | Docs, product specs, execution plans, and binding repo constraints |

## Contributing

Changes land via branch + pull request — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
