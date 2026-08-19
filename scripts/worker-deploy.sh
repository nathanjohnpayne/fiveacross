#!/usr/bin/env bash
set -euo pipefail

# Guarded deploy wrapper for the Cloudflare Worker Event router (worker/).
#
# WHY THIS EXISTS
#
# `wrangler deploy` uploads the CALLER'S WORKING DIRECTORY, not `origin/main` —
# the same hazard `scripts/deploy.sh` was written for (mergepath#77), and worse
# here in one respect: once the routes are attached, this Worker fronts EVERY
# wildcard Event hostname, so publishing from a feature branch or a dirty tree
# replaces the router for every Event at once with code no reviewer has seen.
#
# `scripts/deploy.sh` states the canonical policy and enforces it for the
# Firebase surface; it cannot be reused here because it is bound end-to-end to
# `op-firebase-deploy` and the Cloud Run invoker reconciliation. This script
# applies the SAME shared guards to the Cloudflare surface, including the
# deliberately separate `--force` (branch/freshness) and DEPLOY_ALLOW_DIRTY=1
# (clean-tree) break-glass controls, so an operator meets one policy rather
# than two.
#
#   1. Current branch is `main`.
#   2. Local `main` exactly matches `origin/main`.
#   3. The working tree is clean.
#
# NOTE — deploying is not a cutover. `worker/wrangler.toml` ships with its
# `routes` commented out, so a successful run here publishes a new version and
# changes nothing the public sees. Attaching the routes is a separate, human,
# Gate-ladder step; see worker/README.md § Deploying and attaching.
#
# Usage:
#   scripts/worker-deploy.sh [--force]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/deploy-main-guard.sh
source "$SCRIPT_DIR/lib/deploy-main-guard.sh"

FORCE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    *)
      echo "scripts/worker-deploy.sh does not accept Wrangler arguments: $1" >&2
      exit 64
      ;;
  esac
done

guard_deploy_main_checkout "scripts/worker-deploy.sh" "$FORCE"

echo "✅ Guards passed. Publishing the Worker (routes are NOT attached by this step)." >&2

# `npm ci`, never `npm install`, and the difference is the whole point of the
# guards above. `npm install` would re-resolve wrangler's caret range against
# the registry at deploy time, so an operator could start from the required
# clean, reviewed origin/main commit and still publish a bundle built by a
# toolchain version nobody reviewed — the guards would verify the source and
# the toolchain would slip underneath them. `npm ci` installs exactly
# worker/package-lock.json and fails closed if it and package.json disagree.
npm --prefix worker ci
npm --prefix worker run deploy

# Verify the production secret binding on the DEPLOYED Worker.
#
# Nothing else in the cutover ladder does. `wrangler dev --remote` uploads the
# local checkout into a temporary preview with its own `.dev.vars`, so it can
# pass while production has no `FIREBASE_API_KEY` at all; and the workers.dev
# URL is refused as `out-of-namespace` before configuration is ever consulted,
# so it cannot report the binding either. Without this check the first evidence
# of a missing secret would be every hostname failing closed AFTER the wildcard
# routes were attached.
#
# `wrangler secret list` returns names and types only — never values — so this
# is safe to run and safe to print.
echo "🔎 Verifying the deployed Worker's FIREBASE_API_KEY binding…" >&2
if SECRETS="$(npm --prefix worker exec -- wrangler secret list 2>/dev/null)"; then
  if printf '%s' "$SECRETS" | grep -q 'FIREBASE_API_KEY'; then
    echo "✅ FIREBASE_API_KEY is bound on the deployed Worker." >&2
  else
    cat >&2 <<'MSG'

❌ The Worker deployed, but FIREBASE_API_KEY is NOT bound on it.

Every hostname will fail closed with `x-event-router-reason: lookup-forbidden`
or `lookup-unavailable`. Bind it before attaching any route:

    npm --prefix worker exec -- wrangler secret put FIREBASE_API_KEY

MSG
    exit 1
  fi
else
  echo "⚠️  Could not list the deployed Worker's secrets; verify FIREBASE_API_KEY by hand before attaching routes." >&2
fi
