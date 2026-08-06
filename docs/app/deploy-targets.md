# Deploy targets — one repo, two Firebase projects

This repo ships to **two** Firebase projects from one codebase, but its deploy configuration is single-project: `.firebaserc` names exactly one default, and the client build reads exactly one untracked `.env.local`. Everything awkward about deploying Five Across follows from that one mismatch, including the dedicated worktree and the `--force` flag. This page records why the current arrangement exists, how to run each target correctly today, and what to fix so the workarounds can be retired ([#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663)).

## The two targets

| | Gay Cruise Bingo | Five Across / Vacay |
|---|---|---|
| Firebase project | `gaycruisebingo` | `fiveacross` |
| Event | `med-2026` | `bodega-bay-2026` |
| Player hosts | `gaycruisebingo.com`, `gaycruisebingo.web.app` | `bodega-bay.vacaybingo.com`, `fiveacross.app` |
| Backup mirrors | `gaycruisebingo.vercel.app` | `vacaybingo.vercel.app`, `fiveacross.vercel.app` |
| Baked `VITE_EDITION` | `gcb` (default) | `vacay` |
| Baked `VITE_FIREBASE_AUTH_DOMAIN` | `gaycruisebingo.com` | `bodega-bay.vacaybingo.com` |
| Deploy from | the main checkout (`~/GitHub/gaycruisebingo`) | the `bodega-deploy` worktree |

Both are **single-Event builds**: a non-empty `VITE_EVENT_ID` means the bundle never consults the `hostnames/{host}` lookup, so the Event and the Edition are frozen at build time. See `README.md` § Event id.

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

```bash
cd ~/GitHub/.gaycruisebingo-worktrees/bodega-deploy
git fetch origin main && git checkout --detach origin/main
SYNTHETIC_URL=https://bodega-bay.vacaybingo.com/ \
  scripts/deploy.sh --force -- fiveacross --only hosting
```

Four things in that command are load-bearing:

- **`fiveacross` after the `--`** — `op-firebase-deploy` takes the project as a positional argument and otherwise falls back to `.firebaserc`'s default, which would deploy this build to the *Gay Cruise Bingo* project.
- **`--force`** — clears the not-on-`main` guard for the detached HEAD. See the checklist below before using it.
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

Verify what actually shipped by grepping the served bundle:

```bash
curl -sS https://bodega-bay.vacaybingo.com/ | grep -oE '/assets/index-[^"]*\.js'
curl -sS "https://bodega-bay.vacaybingo.com/assets/index-<hash>.js" \
  | grep -c 'bodega-bay\.vacaybingo\.com'   # must be ≥ 1
```

Until [#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663) lands, treat `fiveacross-deploy` as reference material for the mirror hosts, not a deploy source.

## Post-deploy verification

`scripts/deploy.sh` runs a synthetic that asserts the app mounts, and it never rolls back on its own — it prints instructions and waits for a human. A failed synthetic is **not** by itself grounds to roll back: open the URL in a browser first. The 2026-08-05 false alarm (an Edition-blind probe reporting a healthy Vacay deploy as broken) is documented in the script's own failure text.

The synthetic proves the app mounts; it does not prove *which* build shipped. For that, diff the asset hash before and after, and grep the new bundle for a marker unique to the change.

The Vercel mirrors are a **separate pipeline** and are not covered by this deploy or its synthetic. After any deploy touching `src/**`, redeploy them too (`npx vercel deploy --prod --yes --project vacaybingo`, likewise `fiveacross`) and confirm they carry the same markers — see `preview-deploys.md`.

## Unwinding this

The whole arrangement collapses once the client build can select an env file per project, the way `functions/` already does. The plan and its one non-obvious hazard — Vite's blank-key guard is keyed to `mode === 'production'`, so a naive `--mode fiveacross` would silently disable the guard that exists to prevent blank-config outages — are in [#663](https://github.com/nathanjohnpayne/gaycruisebingo/issues/663).
