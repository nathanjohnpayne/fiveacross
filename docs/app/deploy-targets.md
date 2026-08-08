# Deploy targets — one repo, two Firebase projects

This repo ships to **two** Firebase projects from one codebase, but its deploy configuration is single-project: `.firebaserc` names exactly one default, and the client build reads exactly one untracked `.env.local`. Everything awkward about deploying Five Across follows from that one mismatch, including the dedicated worktree and the `--force` flag. This page records why the current arrangement exists, how to run each target correctly today, and what to fix so the workarounds can be retired ([#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663)).

## The two targets

| | Gay Cruise Bingo | Five Across / Vacay |
|---|---|---|
| Firebase project | `gaycruisebingo` | `fiveacross` |
| Event | `med-2026` | `bodega-bay-2026` |
| Player hosts | `gaycruisebingo.com`, `gaycruisebingo.web.app` | `bodega-bay.fiveacross.app` (canonical), `bodega-bay.vacaybingo.com`, `fiveacross.app` |
| Vercel mirrors | `gaycruisebingo.vercel.app` | `vacaybingo.vercel.app`, `fiveacross.vercel.app` — **sign-in does not work yet** |
| Baked `VITE_EDITION` | `gcb` (default) | `vacay` |
| Baked `VITE_FIREBASE_AUTH_DOMAIN` | `gaycruisebingo.com` | `bodega-bay.vacaybingo.com` |
| Deploy from | the main checkout (`~/GitHub/gaycruisebingo`) | the `bodega-deploy` worktree |

### Which host to verify against, and why it is not the canonical one

`bodega-bay.fiveacross.app` is the canonical host per [#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) as amended, and `docs/agents/repository-overview.md` records it that way. Every verification command on this page nonetheless targets `bodega-bay.vacaybingo.com`, which looks inconsistent and is deliberate: the Event was launched on that host, and the shipped bundle bakes it as `VITE_FIREBASE_AUTH_DOMAIN`, so it is the origin whose configuration a deploy can actually break. Both hosts serve the same release from the same Firebase project.

Making `bodega-bay.fiveacross.app` first-class is [#600](https://github.com/nathanjohnpayne/gaycruisebingo/issues/600), still open. **When it lands, move the verification targets on this page with it** — otherwise this runbook will keep proving the health of an alternate while the canonical entry point goes unchecked.

### Both targets are single-Event builds

A non-empty `VITE_EVENT_ID` means the bundle never consults the `hostnames/{host}` lookup, so the Event and the Edition are frozen at build time. The live Five Across `.env.local` sets `VITE_EVENT_ID=bodega-bay-2026`.

This **contradicts `README.md` § Event id**, which says a Five Across build "MUST leave it empty". That instruction is scoped to the wildcard-router design — the multi-Event build every `*.fiveacross.app` host would share once the Worker router ([#545](https://github.com/nathanjohnpayne/gaycruisebingo/issues/545)) exists. Today's hosts are exact Firebase Hosting custom domains, one Event each, and the single-Event build is the deliberate choice: `preview-deploys.md` records the reasoning, which is that a hostname-resolved build must complete a Firestore `getDocFromServer` before first paint and `shouldMountOnBootstrapFailure` fails **closed** to the `unreachable` screen if that read fails.

Reconstructing `.env.local` from the README alone would therefore produce a build that behaves differently from what is deployed. Copy the deployed values; do not infer them.

## Why Five Across needs its own worktree

`.env.local` is a single gitignored file at the repo root, and Vite loads it for every build. Two projects therefore need two copies of that file, and two copies need two working directories — a git worktree is the cheapest way to have both on disk at once.

That has a knock-on effect. Only one worktree can have `main` checked out, and the main checkout holds it, so `bodega-deploy` sits on a **detached HEAD** pinned to the same commit. `scripts/deploy.sh`'s first guard refuses any branch that is not `main`, which is why every Five Across deploy passes `--force`.

The functions side already solved this problem the right way: `functions/.env.gaycruisebingo` and `functions/.env.fiveacross` sit side by side in one directory, selected by project id, gitignored via `functions/.gitignore`. The client build simply never adopted the same convention.

## Deploying Gay Cruise Bingo

Ordinary path — from `main` in the main checkout, no flags:

```bash
npm run deploy:hosting
```

`.firebaserc`'s default (`gaycruisebingo`) selects the project and `.env.local` supplies the build config.

## Deploying Five Across / Vacay

Copy the whole block. The assertions are part of the command chain on purpose — `--force` switches off two of the script's own guards, so this re-asserts them *before* reaching the line that bypasses them, and `&&` makes the chain fail closed:

```bash
cd ~/GitHub/.gaycruisebingo-worktrees/bodega-deploy && \
git fetch origin main && \
git checkout --detach origin/main && \
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ABORT: HEAD is not origin/main"; false; } && \
[ -z "$(git status --porcelain)" ] || { echo "ABORT: worktree is dirty"; false; } && \
SYNTHETIC_URL=https://bodega-bay.vacaybingo.com/ \
  scripts/deploy.sh --force --skip-cf-purge -- fiveacross --only hosting
```

Do not run the last line on its own. `--force` bypasses the *branch* and *behind-origin/main* guards, so an isolated invocation deploys whatever commit the worktree happens to be pinned at — which is the failure the guards exist to stop, and it is silent.

The clean-tree guard is a separate matter and worth knowing precisely: `--force` does **not** subsume it. `scripts/deploy.sh` documents that explicitly and gates it on its own `DEPLOY_ALLOW_DIRTY=1` env var, so a dirty worktree is refused by the script whether or not you pass `--force`. The `git status` assertion above is therefore belt-and-braces — it fails earlier and more legibly, rather than being the only thing standing between a dirty tree and production.

Five things in that command are load-bearing:

- **`fiveacross` after the `--`** — `op-firebase-deploy` takes the project as a positional argument and otherwise falls back to `.firebaserc`'s default, which would deploy this build to the *Gay Cruise Bingo* project.
- **`--force`** — clears the not-on-`main` guard for the detached HEAD. See the checklist below before using it.
- **`--skip-cf-purge`** — `CF_ZONE_ID` defaults to a hard-coded Gay Cruise Bingo zone (`scripts/deploy.sh:225`). If a preflight has loaded `CF_API_TOKEN`, an unguarded Five Across deploy purges *that* zone: the wrong site's cache is cleared, Bodega's is not, and the mount-only synthetic still passes. Skipping is correct today because the Bodega host is DNS-only — responses carry no `cf-ray`, so there is no Cloudflare cache in front of it to purge. If a Five Across host is ever put behind the orange cloud, pass `CF_ZONE_ID=<five-across-zone>` instead of skipping.
- **`SYNTHETIC_URL`** — the post-deploy synthetic defaults to `https://gaycruisebingo.com/`, which would assert the wrong site mounted and tell you nothing about the deploy you just made.
- **the worktree** — it holds the only correct Five Across `.env.local` on this machine.

### Before passing `--force`

The guard exists to stop a stale or dirty tree from shipping something reviewers never saw ([mergepath#77](https://github.com/nathanjohnpayne/mergepath/issues/77)). Bypassing it is only safe when that specific risk is absent, so confirm all three:

```bash
git rev-parse HEAD                 # must equal origin/main
git rev-parse origin/main
git status --porcelain             # must be empty
```

If HEAD is not `origin/main`, you are about to ship something other than main's state and the guard is right. `--force` is the correct tool **only** for the detached-HEAD mechanics described above, never for "the guard is in my way".

## ⚠️ Do not deploy from the `fiveacross-deploy` worktree

A second worktree, `~/GitHub/.gaycruisebingo-worktrees/fiveacross-deploy`, also carries a Five Across `.env.local`. Its `VITE_FIREBASE_AUTH_DOMAIN` is **`fiveacross.firebaseapp.com`**, and deploying it to the live Bodega host would break sign-in.

The mechanism is worth understanding, because nothing about the build would look wrong:

`bodega-bay.vacaybingo.com` is **not** in `FIRST_PARTY_AUTH_HOSTS` (`src/auth-domain.ts`) — it appears in that file only in a comment. So `resolveAuthDomain` returns the *configured* `authDomain` verbatim on that host. Today that value is the host itself, which is what makes sign-in same-origin. Ship `fiveacross.firebaseapp.com` instead and the auth helper becomes cross-origin, which is exactly the arrangement Safari's storage partitioning breaks — the failure the exact-host pinning was built to prevent.

Verify what actually shipped by reading the app's own inlined Firebase config out of the served bundle. This **prints the deployed values** rather than asserting a count, so it cannot pass by accident:

Check **both** serving hosts, not just one. They are separate Hosting custom domains and a release can reach one and not the other:

```bash
for HOST in https://bodega-bay.vacaybingo.com https://bodega-bay.fiveacross.app; do
  ASSET=$(curl -sS "$HOST/" | grep -oE '/assets/index-[^"]*\.js' | head -1)
  echo "== $HOST ($ASSET)"
  curl -sS "$HOST$ASSET" | grep -oE 'authDomain:[A-Za-z0-9_$]+\("[^"]+"|projectId:"[^"]+"|"[0-9a-f]{40}"' | sort -u
done
```

Expected on each host — all three lines, and the sha must equal `git rev-parse origin/main`:

```
"33966aa1238132569c937d71f40938463cb70d2c"
authDomain:MH("bodega-bay.vacaybingo.com"
projectId:"fiveacross"
```

The 40-hex string is the build's commit, baked by `appVersion()` in `vite.config.ts` from `GITHUB_SHA` or `git rev-parse HEAD`. That makes this check **commit-aware**: it answers "which commit is this host serving", not merely "does it look right".

`VITE_FIREBASE_AUTH_DOMAIN` is inlined by Vite as the first argument to `resolveAuthDomain(...)` (`src/firebase.ts:18`), so that match is the configured auth domain itself. The minified function name (`MH` above) changes every build — do not pin it.

Two weaker checks to avoid, both of which pass on bundles that are wrong:

- **Grepping for `bodega-bay.vacaybingo.com`.** The Vacay Edition's `ogUrl` in `src/editions.ts` is that same hostname, so every Vacay build matches regardless of which `authDomain` was baked in — including one built from the broken worktree.
- **Asserting `fiveacross.firebaseapp.com` is absent.** A Gay Cruise Bingo bundle, or a build with a missing or differently-wrong auth domain, also produces zero. Absence of one wrong value is not presence of the right one.

The `projectId` line is what makes this a real Edition check too: a Gay Cruise Bingo build reports `projectId:"gaycruisebingo"` and fails the comparison immediately.

Until [#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663) lands, treat `fiveacross-deploy` as reference material for the mirror hosts, not a deploy source.

## Post-deploy verification

`scripts/deploy.sh` runs a synthetic that asserts the app mounts, and it never rolls back on its own — it prints instructions and waits for a human. A failed synthetic is **not** by itself grounds to roll back: open the URL in a browser first. The 2026-08-05 false alarm (an Edition-blind probe reporting a healthy Vacay deploy as broken) is documented in the script's own failure text.

The synthetic proves the app mounts; it does not prove *which* build shipped. For that, diff the asset hash before and after, and grep the new bundle for a marker unique to the change.

The Vercel mirrors are a **separate pipeline** and are not covered by this deploy or its synthetic. Since [#676](https://github.com/nathanjohnpayne/gaycruisebingo/issues/676) they are **manual, like the Firebase primaries** — `vercel.json` carries `git.deploymentEnabled: { "main": false }`, so a merge builds nothing on any of the three projects. Nothing rebuilds them but you.

That is a deliberate trade, and it trades in the direction the failure history points. Three projects on one repository meant three production builds per merge against an account-wide cap that, when exhausted, refuses deployments for **24 hours** across the whole team — taking out the brand's own ship-network fallback on the day you need it. The stale-mirror risk that automation was covering was never actually covered: Vercel silently cancels queued builds under pressure, the host keeps serving its previous bundle at `HTTP 200`, and both mirrors were found 22h and 7h stale on 2026-08-06 *with the integration connected*. Explicit staleness you can see beats implicit staleness you cannot.

Only `main` is disabled. Other branches keep whatever the per-project **Ignored Build Step** already decides, so the `preview`-branch flow in [`preview-deploys.md`](preview-deploys.md) § Part 2 is untouched by this.

### Deploying a mirror

**`vercel deploy` uploads your current working directory** — `--project` chooses the destination, not the source, and `--prod` promotes whatever was uploaded. With Git deploys off for `main`, this is the *only* path to production, so it needs the same guards the Firebase deploy has. Copy the whole block; `&&` makes it fail closed:

```bash
cd ~/GitHub/gaycruisebingo && \
git fetch origin main && \
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ABORT: HEAD is not origin/main"; false; } && \
[ -z "$(git status --porcelain)" ] || { echo "ABORT: worktree is dirty"; false; } && \
npx vercel deploy --prod --yes --project vacaybingo
```

Likewise `fiveacross` and `gaycruisebingo`. Deploy only what you need — each invocation is one build against the shared cap.

`--project <NAME_OR_ID>` is a real flag on `vercel deploy` ("Project name or ID (defaults to the linked project)" — `npx vercel deploy --help`, CLI 58.8.0), and it is used here **instead of** `vercel link` on purpose. Linking writes a `.vercel` directory and a `.env.local` into the checkout and appends both to `.gitignore` — which is tracked in this repo and already covers what it needs to ([`preview-deploys.md`](preview-deploys.md) § step 1). Three projects would mean three link states fighting over one working tree, in a repo where the *wrong* project is a live host serving the wrong Edition. Naming the project per invocation keeps that choice explicit at the call site and leaves nothing behind.

Do not run the last line on its own. Without the assertions above it publishes whatever is in the directory you happen to be standing in — a feature branch, a half-finished edit — straight to a production host, with no review and no CI between you and it. That is exactly the risk `scripts/deploy.sh`'s guards exist to stop on the Firebase side, and Vercel's CLI has no equivalent of its own.

The **build** then runs on Vercel using that project's own Production environment variables (`VITE_EDITION`, `VITE_EVENT_ID`, the Firebase config), which is why the same source builds into a different Edition per project — the project name selects the config, the working directory supplies the code. `git.deploymentEnabled` governs Git-triggered deployments only — [Vercel's own wording](https://vercel.com/docs/project-configuration/git-configuration) is "branches that should not trigger a deployment upon commits" — so it never blocks this command.

Then verify, because the mirror is now only as current as your last command:

**The mirrors cannot be checked by commit today, and that is a known gap — do not fake it with a timestamp.** The commit-sha check above does not work on them: `appVersion()` falls back to `git rev-parse HEAD`, Vercel builds remotely without the `.git` directory, so the fallback throws and the bundle bakes `unknown`. Vercel's own metadata does not fill the gap either — a CLI-deployed build carries no Git metadata (`vercel inspect --json` reports `source: null` and no `meta.githubCommitSha`), and `vercel inspect` exposes only a `created` timestamp, which tells you when a build ran, not what was in it.

So test for the **content you expect**, which is commit-aware in effect:

```bash
# Does the mirror contain the change you are looking for?
# All THREE — gaycruisebingo.vercel.app is the ship-network fallback and is
# now just as manual as the other two, so it needs the same check.
for H in vacaybingo.vercel.app fiveacross.vercel.app gaycruisebingo.vercel.app; do
  A=$(curl -sS "https://$H/" | grep -oE '/assets/index-[^"]*\.js' | head -1)
  printf '%-24s %s ' "$H" "$A"
  curl -sS "https://$H$A" | grep -qE 'try\{[A-Za-z0-9_$]+=URL\.createObjectURL' \
    && echo "has #660 guard" || echo "STALE (no #660 guard)"
done
```

Substitute a marker unique to whatever commit you are verifying.

Closing the gap properly is a one-line change — `appVersion()` should also read `VERCEL_GIT_COMMIT_SHA`, which Vercel does set during its builds — tracked in [#665](https://github.com/nathanjohnpayne/gaycruisebingo/issues/665). Note that a CLI deploy does not set it either, so #665 alone will not make manual mirror deploys commit-checkable; the content marker above stays the check that works.

> **Sign-in does not work on the Five Across mirrors yet.** `preview-deploys.md` verification step 5 is still *"Blocked on steps 5 and 6"* — the Firebase authorized-domain and Google OAuth redirect-URI registrations have not been done for `vacaybingo.vercel.app` / `fiveacross.vercel.app`. They render a Google button that fails with `auth/unauthorized-domain` or `redirect_uri_mismatch`. Keeping them current is still worth doing so they are ready, but **do not point players at them during an outage** until those two console steps are complete.

## Unwinding this

The whole arrangement collapses once the client build can select an env file per project, the way `functions/` already does. The plan and its one non-obvious hazard — Vite's blank-key guard is keyed to `mode === 'production'`, so a naive `--mode fiveacross` would silently disable the guard that exists to prevent blank-config outages — are in [#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663).
