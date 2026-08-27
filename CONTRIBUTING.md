# Contributing to Gay Cruise Bingo

Thanks for helping out. Gay Cruise Bingo is a live, multiplayer bingo PWA — Vite + React 18 + TypeScript (strict) on Firebase — maintained by a solo developer with AI agent assistance. This guide is the entry point: it routes you to the canonical docs rather than restating them, so where a section says "see X," X is the source of truth.

Be kind and assume good faith. This is a small, for-fun project; contributions of any size are welcome.

## Before you start

Read, in this order, before making a change:

1. [`README.md`](README.md) — what the project is and the quick start.
2. [`docs/app/README.md`](docs/app/README.md) — the app guide and setup/seed/deploy runbook.
3. [`AGENTS.md`](AGENTS.md) — operating rules, code-review policy, and (for AI agents) the full contribution workflow. Human contributors can skim it; it is the canonical rulebook.
4. The [`specs/`](specs/) file(s) for the area you're touching — intended behavior.
5. [`docs/adr/`](docs/adr/) — architecture decision records. The trust model and data-flow decisions there are load-bearing; see [Domain gotchas](#domain-gotchas-read-these) below.

If code conflicts with a spec, or a change would violate [`rules/repo_rules.md`](rules/repo_rules.md), stop and flag it — update the spec/tests first, then the code. Don't silently change behavior.

## Development setup

Full setup (env mapping, seeding, custom domain) lives in the [app guide §2–3](docs/app/README.md). The short version:

**Node 22.22 or newer is required** — `react-router` 8 declares `engines.node: >=22.22.0`, the root `package.json` declares the same floor, and `.nvmrc` pins the line so `nvm use` picks it up. npm only *warns* on a version mismatch, so an older Node lets the commands below run on an unsupported engine rather than stopping you. [`app-ci`](.github/workflows/app-ci.yml) runs on Node 22, which is what your local checks should match.

```bash
cp .env.example .env.local     # fill from `firebase apps:sdkconfig WEB` — app guide §2
npm install
npm run dev                    # local dev at http://localhost:5173
```

The `VITE_FIREBASE_*` values are **non-secret client identifiers** — they're baked into the client bundle by design, and access is enforced by the Firestore/Storage rules + Auth, not by hiding them. `.env.local` is gitignored; never commit it. A build with an empty `VITE_FIREBASE_API_KEY` ships a blank-page outage, so a real config must be present at build time (the build guards against an empty key — see [#140](https://github.com/nathanjohnpayne/fiveacross/pull/140)).

## Local checks before you push

Run the same gates CI runs. [`app-ci`](.github/workflows/app-ci.yml) executes these on every PR and on pushes to `main`, in this order:

| Command | What it covers |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — strict TypeScript is the primary static gate |
| `npm test` | Game-logic unit + component tests (Vitest, jsdom) |
| `npm run build` | Production Vite build; must succeed |
| `npm run test:functions` | Cloud Functions notifier suite (installs `functions/` deps first; no emulator) |
| `npm run test:rules` | Firestore/Storage security-rules suite against the emulators (needs Java) |

`npm run test:e2e` is a **local** Playwright smoke runner — it is intentionally *not* run in CI. Run it locally when you touch a user-facing flow end-to-end.

At minimum, `npm run typecheck` and `npm test` should be green before every push; run the rules/functions suites too when you touch `firestore.rules`, `storage.rules`, or `functions/`.

There is no `npm run lint` in this repo. An `eslint.config.js` flat config is present per the repo's ESLint policy (see [`docs/agents/code-modification-rules.md`](docs/agents/code-modification-rules.md) § ESLint flat-config policy), but ESLint is not wired as a local or CI gate here — TypeScript strict mode is the enforced static check, and CodeRabbit provides advisory lint on PRs. Don't claim a lint pass you didn't run.

## Conventions

- **TypeScript strict.** No `any` escape hatches to make types pass; fix the type.
- **Prefer editing existing files** over creating new ones, and never duplicate logic or instructions. Don't add a new top-level directory without documented justification in `AGENTS.md` or a `plans/` entry. See [`docs/agents/code-modification-rules.md`](docs/agents/code-modification-rules.md).
- **Match the surrounding code** — naming, structure, and idiom. `src/types.ts` is the shared domain contract; keep it the one source for shared types.
- **Soft-wrap Markdown prose:** one physical line per paragraph, let the renderer wrap. Do not hard-wrap at a fixed column — GitHub collapses single newlines to spaces, so it's invisible and just churns diffs. Leave tables, code fences, and list structure as-is. See [`docs/agents/documentation-rules.md`](docs/agents/documentation-rules.md) § Prose line-wrapping.

## Branching, commits, and pull requests

- **Branch off `main`; never push to `main`.** Use a descriptive branch name — the house style is `feat/<slug>` (also `fix/<slug>`, `docs/<slug>`).
- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/):** `type(scope): summary`, e.g. `fix(auth): time out stalled online bootstrap` or `feat(board): define the free space visually`. Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
- **Open a PR** and let the [PR template](.github/pull_request_template.md) structure it — a Summary, a Testing checklist, and a Self-Review checklist. Fill them in honestly; if tests failed or a step was skipped, say so.
- **Link the issue** with `Closes #<num>` in the PR body so the merge closes it (and the Project #7 board can auto-advance the card — [`docs/agents/ticket-workflow.md`](docs/agents/ticket-workflow.md)).
- Keep the title and description about the *final state of the change*, not the session that produced it (no "originally tried X, then switched"). See [`docs/agents/operating-rules.md`](docs/agents/operating-rules.md) § PR and issue titles.

## Review and merge

Every change lands via pull request review before merge — this is enforced by branch protection. The repo runs a multi-identity AI code-review system: code is authored as `nathanjohnpayne`, reviewed under a separate reviewer identity, and only `nathanjohnpayne` merges to `main`. Protected paths (`.github/`, anything matching `*secret*` / `*credential*`) always require review per [`.github/CODEOWNERS`](.github/CODEOWNERS). The complete policy — review phases, external-review thresholds, and the `human-hold` freeze label — is in [`REVIEW_POLICY.md`](REVIEW_POLICY.md) and summarized in [`AGENTS.md`](AGENTS.md) § Code Review Policy. Merges are squash-and-delete-branch.

## Domain gotchas (read these)

A few things about this app will bite you if you don't know them up front:

- **The prompt pool lives in Firestore, not the JS bundle.** The app renders `events/{id}/items`, which only the seed script writes. Changing `ITEMS` in `src/data/seed.ts` / `scripts/seed.mjs` and deploying the app does **not** reach players — you must re-run the seed against the live project, then confirm with `npm run verify:seed` (production-pinned, read-only, exits non-zero on drift). Skipping the reseed is exactly how a pool update shipped late once ([#129](https://github.com/nathanjohnpayne/fiveacross/issues/129)). Full detail: [app guide §4](docs/app/README.md).
- **Stats are client-authoritative and never move server-side** — the honor-system trust model ([ADR 0001](docs/adr/0001-honor-system-trust-model.md)). Don't reintroduce a server-side stat recompute; it was deliberately removed.
- **Boards freeze at deal time.** Prompts added later feed *future* deals only ([ADR 0003](docs/adr/0003-pool-is-pre-cruise.md)).
- **Share images are generated on-device**, not server-rendered ([ADR 0005](docs/adr/0005-client-side-share-images.md)). The OG unfurl image is a static asset.

## Documentation and tests

- **Update docs and specs alongside the code**, not after — when you change system behavior, build/deploy steps, dependencies, or directory structure, update the relevant [`specs/`](specs/) file and any affected `docs/agents/**` sub-file in the same change ([`docs/agents/documentation-rules.md`](docs/agents/documentation-rules.md)).
- **Don't edit generated mirrors.** `docs/projects/<project>/prds/**` and other synced surfaces carry a `do_not_edit:` marker — edit the canonical source instead. Repo-owned docs (root docs, `docs/agents/**`, `docs/architecture/**`, `docs/adr/**`, `specs/**`) are directly editable.
- **Update tests when behavior changes, and never delete a test just to make a build pass** ([`docs/agents/testing-requirements.md`](docs/agents/testing-requirements.md)). New code paths should be tested; every spec file should have a corresponding test or a documented reason it doesn't.

## Deploying (maintainers)

Deploys are manual and 1Password-backed — there is no CI deploy. They go through `scripts/firebase/op-firebase-deploy`, which impersonates the deployer service account; never run `firebase login` / `firebase deploy` directly, and there are no committed service-account keys. Deploy security rules/indexes/storage *before* hosting so access is locked before the app goes live. See [`DEPLOYMENT.md`](DEPLOYMENT.md) and [app guide §5](docs/app/README.md). Whenever a deploy touched the pool, finish with `npm run verify:seed`.

## Reporting security issues

Do **not** open a public issue for a vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/nathanjohnpayne/fiveacross/security/advisories/new) or email the maintainer directly. See [`SECURITY.md`](SECURITY.md).
