# Gay Cruise Bingo

A live, multiplayer bingo web app (PWA) to play with your friends on a gay cruise. Sign in, get a randomized card of things that might happen on the sailing, and mark them off as they go down — with a shared leaderboard, party themes, PWA install, and printed cards as the offline fallback.

**Live:** https://gaycruisebingo.web.app · **Setup & runbook:** [`docs/app/README.md`](docs/app/README.md)

## The game

- A randomized 5×5 card dealt from a community-editable prompt pool; the free center square is always marked.
- Honor-system marking with BINGO + blackout detection and a live leaderboard (client-sorted in Phase 0).
- Google sign-in with an 18+ acknowledgment, eight party themes, GA4, and a static share image for bare-URL unfurl. Shareable win/leaderboard cards are rendered on-device and handed to the native share sheet (ADR 0005) — no server.
- **Phase 1** (scaffolded, not yet deployed): a photo/audio proof system with a live feed, an admin moderation console with Cloud Vision flagging, verified-claim mode, and App Check — designed to land as live updates during the sailing. See [`docs/app/phase-1-deploy.md`](docs/app/phase-1-deploy.md).

## Stack

Vite + React 18 + TypeScript (strict) · Firebase (Auth · Firestore · Storage · Hosting · Analytics) · `vite-plugin-pwa` · Cloud Functions (Vision moderation + thumbnails, Phase 1).

## Quick start

The full setup — env, seeding, deploy, and custom domain — lives in the **[app guide](docs/app/README.md)**. The short version:

**Node 22.22 or newer is required** (`react-router` 8 sets the floor; `.nvmrc` pins the line, so `nvm use` selects it). On an older Node, `npm install` warns via `EBADENGINE` and then lets every command below run anyway — the failures that follow are unsupported-engine failures, not bugs.

```bash
cp .env.example .env.local     # fill from `firebase apps:sdkconfig WEB` — see app guide §2
npm install
npm run dev                    # local dev at http://localhost:5173
npm test                       # game-logic unit tests
npm run typecheck              # tsc --noEmit
```

Deploys go through `op-firebase-deploy` (1Password-backed service-account impersonation; never `firebase login` / `firebase deploy` directly) — see app guide §5 and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Documentation

| Doc | What |
|---|---|
| [`docs/app/README.md`](docs/app/README.md) | App guide + deploy / seed / custom-domain runbook |
| [`docs/app/phase-1-deploy.md`](docs/app/phase-1-deploy.md) | Phase-1 backend deploy (Functions, App Check) |
| [`docs/app/preview-deploys.md`](docs/app/preview-deploys.md) | Previewing a branch on a real device, with working Google sign-in |
| [`docs/projects/gaycruisebingo/prds/gaycruisebingo.md`](docs/projects/gaycruisebingo/prds/gaycruisebingo.md) | Product requirements (PRD) |
| [`docs/adr/`](docs/adr/) · [`docs/architecture/`](docs/architecture/) | Architecture decision records |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Deploy tooling + 1Password credential model |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) | Contribution workflow · security policy |

## Layout

| Path | Purpose |
|---|---|
| `src/` | App code: game logic, Firebase init, auth, theme, hooks, components |
| `functions/` | Phase-1 Cloud Functions (Vision moderation, thumbnails — stats stay client-authoritative, ADR 0001) |
| `public/` | Static assets served verbatim (icons, manifest, `og-default.png`, service worker) |
| `firestore.rules` · `storage.rules` · `firestore.indexes.json` | Security rules + indexes |
| `scripts/` | Seed script + build / CI / deploy tooling |
| `tests/`, `src/**/*.test.*` | Automated validation |
| `docs/`, `specs/`, `plans/`, `rules/` | Docs, product specs, execution plans, and binding repo constraints |

## Contributing

Changes land via branch + pull request — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
