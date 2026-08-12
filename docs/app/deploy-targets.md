# Deploy targets — one repo, two Firebase projects

This repo ships to **two** Firebase projects from one codebase. The target commands select the local client environment, pass the Firebase project explicitly, and use the matching post-deploy verification origin. Deploy either target from the clean, current `main` checkout; neither requires `--force` or a dedicated worktree.

## The two targets

| | Gay Cruise Bingo | Five Across / Vacay |
|---|---|---|
| Firebase project | `gaycruisebingo` | `fiveacross` |
| Event | `med-2026` | `bodega-bay-2026` |
| Player hosts | `gaycruisebingo.com`, `gaycruisebingo.web.app` | `bodega-bay.fiveacross.app` (canonical), `bodega-bay.vacaybingo.com`, `fiveacross.app` |
| Vercel mirrors | `gaycruisebingo.vercel.app` | `vacaybingo.vercel.app`, `fiveacross.vercel.app` — **sign-in does not work yet** |
| Baked `VITE_EDITION` | `gcb` (explicit) | `vacay` (explicit) |
| Baked `VITE_FIREBASE_AUTH_DOMAIN` | `gaycruisebingo.com` | `bodega-bay.vacaybingo.com` |
| Baked `VITE_FIREBASE_MEASUREMENT_ID` | `G-42N7WYDYT5` | `G-42N7WYDYT5` |
| Baked `VITE_POSTHOG_HOST` | blank (explicit) | blank (explicit) |
| Post-deploy synthetic | `https://gaycruisebingo.com/` | `https://bodega-bay.fiveacross.app/` |
| Cache purge | Gay Cruise Bingo zone `8066dd2b105ad564c45bb8c898859343` | explicitly skipped (no Five Across zone configured) |
| Deploy from | the main checkout (`~/GitHub/gaycruisebingo`) | the main checkout (`~/GitHub/gaycruisebingo`) |

### Which hosts to verify

`bodega-bay.fiveacross.app` is the canonical host. The target deploy command runs its synthetic there. Verify `bodega-bay.vacaybingo.com` as well after significant changes: both are live serving hosts for the same Firebase release.

### Both targets are single-Event builds

A non-empty `VITE_EVENT_ID` means the bundle never consults the `hostnames/{host}` lookup, so the Event and the Edition are frozen at build time. The Five Across target config sets `VITE_EVENT_ID=bodega-bay-2026`.

This **contradicts `README.md` § Event id**, which says a Five Across build "MUST leave it empty". That instruction is scoped to the wildcard-router design — the multi-Event build every `*.fiveacross.app` host would share once the Worker router ([#545](https://github.com/nathanjohnpayne/gaycruisebingo/issues/545)) exists. Today's hosts are exact Firebase Hosting custom domains, one Event each, and the single-Event build is the deliberate choice: `preview-deploys.md` records the reasoning, which is that a hostname-resolved build must complete a Firestore `getDocFromServer` before first paint and `shouldMountOnBootstrapFailure` fails **closed** to the `unreachable` screen if that read fails.

Reconstructing the target env from the README alone would therefore produce a build that behaves differently from what is deployed. Copy the registered web-app values; do not infer them.

## Target environment files

`.env.gaycruisebingo` and `.env.fiveacross` sit beside the generic local-development `.env.local`. They are ignored by Git and each contains the Firebase web-app config for exactly one project. `scripts/build-target.mjs` requires every `VITE_*` key from `.env.example`, then verifies the target's Firebase web-app identity (project, auth domain, Storage bucket, sender id, app id, and measurement id), Event, Edition, and adult-content seed before it builds. Both targets name their Edition and audience posture explicitly (`gcb`/`true` or `vacay`/`false`); neither relies on an application default. The wrapper removes ambient `VITE_*` values and disables Vite's subsequent root env-file load, so a developer's `.env.local` cannot override or fill in part of a production target. App Check keys belong in the target file too when enabled.

The Functions package already follows the same convention through `functions/.env.gaycruisebingo` and `functions/.env.fiveacross`.

## Deploying Gay Cruise Bingo

Ordinary path — from `main` in the main checkout, no flags:

```bash
npm run deploy:gaycruisebingo:hosting
```

Use `npm run deploy:gaycruisebingo` to deploy every configured Firebase surface. The target command builds from `.env.gaycruisebingo` and passes `gaycruisebingo` explicitly.

## Deploying Five Across / Vacay

From the clean, current `main` checkout:

```bash
npm run deploy:fiveacross:hosting
```

Use `npm run deploy:fiveacross` to deploy every configured Firebase surface. The command builds from `.env.fiveacross`, passes `fiveacross` explicitly, skips the Gay Cruise Bingo Cloudflare zone, and verifies the canonical Five Across host.

The existing deploy guards require `main`, an exact `HEAD == origin/main`, and a clean worktree. A target command failing one of those checks should be fixed rather than bypassed with `--force`. Every named target rebuilds its own `dist/`; `--skip-build` is intentionally unavailable because a bundle built for another target would be unsafe to deploy.

### Deploy-wrapper controls

Even a break-glass control must keep the selected target environment. Place deploy-wrapper flags before a second `--`, and Firebase options after it:

```bash
npm run deploy:gaycruisebingo -- --skip-synthetic -- --only hosting
npm run deploy:fiveacross -- --force --
```

The named target still supplies the Firebase project, target build command, cache decision, and synthetic URL. A Firebase-specific `--force` belongs after the second separator, for example `npm run deploy:fiveacross -- -- --only functions --force`.

### Registering a future target

There is intentionally no ambient “new Event” deploy. Register a named target in a reviewed change: add its complete identity, a nonblank `syntheticUrl`, and an explicit `skipCloudflarePurge` choice (a zone id is required when false) to `scripts/build-target.mjs`; create its ignored `.env.<target>` from `.env.example`; and add the matching `build:<target>` / `deploy:<target>` package commands. The Firebase API and production PostHog keys must be nonblank; the PostHog host override must be explicitly blank. Only then use `npm run deploy -- <target>` (or `npm run deploy:hosting -- <target>`). This keeps a future Event from silently rebuilding and publishing an existing target.

### Verify the deployed target

The synthetic proves the application mounted. For an independent target check, verify both serving hosts contain the Five Across project **and the exact commit that was deployed**. Run this from the clean `main` checkout used for deployment; the target deploy commands ensure its `HEAD` equals `origin/main`.

```bash
EXPECTED_SHA="$(git rev-parse HEAD)"
for HOST in https://bodega-bay.fiveacross.app https://bodega-bay.vacaybingo.com; do
  ASSET=$(curl -sS "$HOST/" | grep -oE '/assets/index-[^"]*\.js' | head -1)
  printf '%s ' "$HOST"
  if curl -sS "$HOST$ASSET" | grep -q 'projectId:"fiveacross"' && \
     curl -sS "$HOST$ASSET" | grep -q "\"$EXPECTED_SHA\""; then
    echo "fiveacross $EXPECTED_SHA"
  else
    echo WRONG-TARGET-OR-STALE-COMMIT
  fi
done
```

## Post-deploy verification

`scripts/deploy.sh` runs a synthetic that asserts the app mounts, and it never rolls back on its own — it prints instructions and waits for a human. A failed synthetic is **not** by itself grounds to roll back: open the URL in a browser first. The 2026-08-05 false alarm (an Edition-blind probe reporting a healthy Vacay deploy as broken) is documented in the script's own failure text.

The synthetic proves the app mounts; it does not prove *which* build shipped. For that, diff the asset hash before and after, and grep the new bundle for a marker unique to the change.

The Vercel mirrors are a **separate pipeline** and are not covered by this deploy or its synthetic. They need publishing after any change that alters what a browser receives — `src/**`, `public/**`, `index.html`, `vite.config.ts`, dependencies, or `vercel.json` itself. Since [#676](https://github.com/nathanjohnpayne/gaycruisebingo/issues/676) they are **manual, like the Firebase primaries** — `vercel.json` carries `git.deploymentEnabled: { "**": false, "preview": true }`, so neither a merge nor a branch push builds anything on any of the three projects. Nothing rebuilds them but you.

That is a deliberate trade, and it trades in the direction the failure history points. Three projects on one repository meant three production builds per merge against an account-wide cap that, when exhausted, refuses deployments for **24 hours** across the whole team — taking out the brand's own ship-network fallback on the day you need it. The stale-mirror risk that automation was covering was never actually covered: Vercel silently cancels queued builds under pressure, the host keeps serving its previous bundle at `HTTP 200`, and both mirrors were found 22h and 7h stale on 2026-08-06 *with the integration connected*. Explicit staleness you can see beats implicit staleness you cannot.

Every branch is denied except `preview`, which is exempted so the stable sign-in alias survives. Note that the alias is separately out of service until the per-project Ignored Build Step is narrowed — see [`preview-deploys.md`](preview-deploys.md) § step 4.

### Deploying a mirror

**`vercel deploy` uploads your current working directory** — `--project` chooses the destination, not the source, and `--prod` promotes whatever was uploaded. With Git deploys off for `main`, this is the *only* path to production, so it needs the same guards the Firebase deploy has. Copy the whole block; `&&` makes it fail closed:

```bash
cd ~/GitHub/gaycruisebingo && \
git fetch origin main && \
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ABORT: HEAD is not origin/main"; false; } && \
[ -z "$(git status --porcelain)" ] || { echo "ABORT: worktree is dirty"; false; } && \
npx vercel deploy --prod --yes --scope nathanjohnpaynes-projects --project vacaybingo \
  --build-env GITHUB_SHA="$(git rev-parse HEAD)"
```

**Repeat it for every affected mirror** — `fiveacross` and `gaycruisebingo` too. A browser-facing change is shared by all three builds, so normally that means all three, and the verification loop below expects every mirror you advance to serve `origin/main`. Each invocation is one build against the shared cap; skip a mirror only when you can say why that host is unaffected, not to save a slot.

**Each mirror advances only after ITS OWN Firebase primary has.** A mirror is a second front end for the same backend, so publishing it first points a new client at an old backend — and the two primaries deploy independently (§ Deploying Gay Cruise Bingo, § Deploying Five Across / Vacay), so "deploy all three mirrors" after a *single*-target rollout is exactly how that happens:

| Mirror | Only after this project has shipped **every part** the change needs |
|---|---|
| `gaycruisebingo.vercel.app` | `gaycruisebingo` |
| `vacaybingo.vercel.app`, `fiveacross.vercel.app` | `fiveacross` |

**"Primary" means the whole backend, not just Hosting.** Both target commands above are hosting-only, so a client that needs new Cloud Functions, `firestore.rules`, or a Firestore index is *not* unblocked by running them. Deploy the backend to its named project first (for example, `npm run deploy:fiveacross -- --only functions,firestore:rules,firestore:indexes`), then Hosting, then that project's mirrors. Otherwise the ordering rule below is satisfied on paper while the backend the new bundle calls is still the old one.

It bites hardest when the change needs a backend that only one project has: new Cloud Functions, new `firestore.rules`, a new Firestore field the client expects. A Five Across-only rollout that also advances `gaycruisebingo.vercel.app` breaks the ship-network fallback against a backend that has not moved — the one host whose whole job is to work when the primary does not.

The safe general shape is therefore **primary, then its mirrors** — and if a change is going to both projects, deploy both primaries before any mirror.

`--build-env GITHUB_SHA=...` is what makes the deployed build identifiable. `appVersion()` (`vite.config.ts`) reads `GITHUB_SHA` first and falls back to `git rev-parse HEAD`, which throws on Vercel because the remote build has no `.git` — so without this the bundle bakes `__APP_VERSION__ = 'unknown'`. That value is not cosmetic: it is shown in More → About and attached to **every bug report** (`src/data/bugReports.ts`), so an unstamped mirror produces reports that cannot name the code they came from. The guarded block already knows the exact commit, so it passes it.

`.vercelignore` is what makes the command possible at all, and it is not optional. The Vercel CLI does **not** read `.gitignore`, so without it `vercel deploy` walks the whole checkout — here that is `node_modules/` plus `.claude/`, which holds the agent worktrees and their own `node_modules/`. The first real manual mirror deploy failed exactly there: *"`files` should NOT have more than 15000 items, received 48318."*

It is an **allowlist** — deny `/*`, then re-admit the build's inputs — not a list of exclusions. That direction matters more than the file-count saving. A denylist uploads whatever it forgot to name, and what it forgets is exactly what hurts: gitignored local secrets the clean-worktree guard cannot see because git does not track them (`serviceAccountKey.json`, `.env.local`), and every build artifact a future tool drops at the root (`coverage/`, `playwright-report/`, `.venv/`). **Adding a root-level build input therefore means adding a `!` line** — the deploy fails loudly if you forget, instead of quietly shipping something wrong.

`--scope` pins the team the project name resolves in. Without it the CLI uses whatever scope is currently active, and `--yes` suppresses the prompt that would otherwise catch the mismatch — so an operator whose last `vercel switch` went elsewhere either fails to refresh the intended mirror or, worse, resolves a same-named project in another scope. There is no `.vercel/project.json` to supply it here, deliberately (below).

`--project <NAME_OR_ID>` is a real flag on `vercel deploy` ("Project name or ID (defaults to the linked project)" — `npx vercel deploy --help`, CLI 58.8.0), and it is used here **instead of** `vercel link` on purpose. Linking writes a `.vercel` directory and a `.env.local` into the checkout and appends both to `.gitignore` — which is tracked in this repo and already covers what it needs to ([`preview-deploys.md`](preview-deploys.md) § step 1). Three projects would mean three link states fighting over one working tree, in a repo where the *wrong* project is a live host serving the wrong Edition. Naming the project per invocation keeps that choice explicit at the call site and leaves nothing behind.

Do not run the last line on its own. Without the assertions above it publishes whatever is in the directory you happen to be standing in — a feature branch, a half-finished edit — straight to a production host, with no review and no CI between you and it. That is exactly the risk `scripts/deploy.sh`'s guards exist to stop on the Firebase side, and Vercel's CLI has no equivalent of its own.

The **build** then runs on Vercel using that project's own Production environment variables (`VITE_EDITION`, `VITE_EVENT_ID`, the Firebase config), which is why the same source builds into a different Edition per project — the project name selects the config, the working directory supplies the code. `git.deploymentEnabled` governs Git-triggered deployments only — [Vercel's own wording](https://vercel.com/docs/project-configuration/git-configuration) is "branches that should not trigger a deployment upon commits" — so it never blocks this command.

Then verify, because the mirror is now only as current as your last command.

**A mirror deployed with the block above is checkable by commit**, exactly like the Firebase hosts — `--build-env GITHUB_SHA=...` makes `appVersion()` bake the real 40-hex stamp, so the same `grep -oE '"[0-9a-f]{40}"'` works and answers *which commit is this host serving*:

```bash
# Only the mirrors THIS rollout advanced. After a Five Across-only deploy
# that is the two brand hosts; gaycruisebingo.vercel.app is meant to stay on
# its older commit until its own primary moves, and checking it here would
# report a correct partial rollout as a failure.
for H in vacaybingo.vercel.app fiveacross.vercel.app; do
  A=$(curl -sS "https://$H/" | grep -oE '/assets/index-[^"]*\.js' | head -1)
  printf '%-24s ' "$H"
  curl -sS "https://$H$A" | grep -oE '"[0-9a-f]{40}"' | head -1
done
# each must equal: git rev-parse origin/main
```

For a Gay Cruise Bingo rollout the list is `gaycruisebingo.vercel.app`; for a change going to both projects it is all three.

**Anything deployed without that flag bakes `unknown` instead**, and no Vercel metadata fills the gap — a CLI deployment reports `source: null` and no `meta.githubCommitSha`, and `vercel inspect` exposes only a `created` timestamp, which says when a build ran, not what was in it. **Do not fake it with that timestamp.**

Since [#665](https://github.com/nathanjohnpayne/gaycruisebingo/issues/665), `appVersion()` (`src/build-config.ts`'s `resolveAppVersion`) also falls back to Vercel's own `VERCEL_GIT_COMMIT_SHA`, which a Git-triggered build sets automatically — so the `preview`-branch alias `vercel.json` still allows to build on push now bakes a real commit too, with no flag to remember. The CLI path above is unaffected: `vercel deploy` never sets `VERCEL_GIT_COMMIT_SHA` either, which is exactly why it passes `GITHUB_SHA` explicitly. A bare `unknown` where you expected a sha is therefore always the same finding — that build was published without `--build-env GITHUB_SHA=...` — and the same sha-comparison loop above (§ "each must equal: `git rev-parse origin/main`") is what to re-run once you redeploy it with the guarded block; there is no separate content-marker case left to hand-maintain.

> **Sign-in does not work on the Five Across mirrors yet.** `preview-deploys.md` verification step 5 is still *"Blocked on steps 5 and 6"* — the Firebase authorized-domain and Google OAuth redirect-URI registrations have not been done for `vacaybingo.vercel.app` / `fiveacross.vercel.app`. They render a Google button that fails with `auth/unauthorized-domain` or `redirect_uri_mismatch`. Keeping them current is still worth doing so they are ready, but **do not point players at them during an outage** until those two console steps are complete.

## Implementation note

Target selection is separate from Vite's build mode: both target commands run `vite build --mode production`. That deliberately keeps the blank-Firebase-key guard active for both projects; using a target name as the Vite mode would bypass that guard.
