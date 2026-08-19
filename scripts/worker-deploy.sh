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

REQUIRED_SECRET="FIREBASE_API_KEY"

# Is this a ROUTE-BEARING deploy? The cutover procedure uncomments `routes` in
# worker/wrangler.toml and redeploys through this same script, so "publishing
# changes nothing the public sees" is true for an ordinary deploy and FALSE for
# that one. Saying it unconditionally would reassure an operator at the exact
# moment they are changing live traffic. Matches an uncommented `routes` key
# only; the shipped file keeps the block commented out.
if grep -Eq '^[[:space:]]*routes[[:space:]]*=' worker/wrangler.toml; then
  ROUTE_BEARING=true
else
  ROUTE_BEARING=false
fi

# Verify the required secret binding on the DEPLOYED Worker.
#
# Nothing else in the cutover ladder does. `wrangler dev --remote` uploads the
# local checkout into a temporary preview with its own `.dev.vars`, so it can
# pass while production has no binding at all; and the workers.dev URL is
# refused as `out-of-namespace` before configuration is consulted, so it cannot
# report the binding either.
#
# Secrets live on the Worker rather than in this bundle, so this is answerable
# BEFORE publishing as well as after — which is what lets a route-bearing
# deploy check its prerequisites while nothing has changed yet.
#
# `wrangler secret list` returns names and types only, never values.
verify_required_secret() {
  local when="$1" secrets
  echo "🔎 Verifying the deployed Worker's ${REQUIRED_SECRET} binding (${when})…" >&2

  if ! secrets="$(npm --prefix worker exec -- wrangler secret list --format json 2>/dev/null)"; then
    # Inability to inspect is NOT a pass. The README presents this as
    # verification of the deployed artifact, so exiting 0 here would let
    # automation record an unverified deploy as a verified one.
    cat >&2 <<MSG

❌ Could not list the deployed Worker's secrets, so ${REQUIRED_SECRET} could not be verified.

This is a FAILED verification, not a skipped one. Check \`wrangler\` auth and the
Worker's existence, then re-run. To inspect by hand:

    npm --prefix worker exec -- wrangler secret list

MSG
    exit 75
  fi

  # EXACT name comparison. An unanchored substring match would accept
  # `OLD_FIREBASE_API_KEY` or `FIREBASE_API_KEY_BACKUP` and report a green
  # verification while the real binding is absent — a false pass that, after
  # routes are attached, means every uncached hostname fails closed.
  if printf '%s' "$secrets" | jq -e --arg name "$REQUIRED_SECRET" \
      'if type=="array" then any(.[]; .name == $name) else false end' >/dev/null 2>&1; then
    echo "✅ ${REQUIRED_SECRET} is bound on the deployed Worker." >&2
    return 0
  fi

  cat >&2 <<MSG

❌ ${REQUIRED_SECRET} is NOT bound on the deployed Worker.

Every hostname will fail closed with \`x-event-router-reason: lookup-forbidden\`
or \`lookup-unavailable\`. Bind it before attaching any route:

    npm --prefix worker exec -- wrangler secret put ${REQUIRED_SECRET}

MSG
  exit 1
}

# Install the reviewed Worker toolchain before ANY Wrangler command. A
# route-bearing deploy verifies production secrets before publishing, so
# deferring this until the deploy step would make that prerequisite check run
# through npm's unpinned fallback in a clean checkout with no node_modules.
# `npm ci`, never `npm install`: the lockfile is part of the reviewed deploy.
npm --prefix worker ci

if [[ "$ROUTE_BEARING" == "true" ]]; then
  cat >&2 <<'MSG'
⚠️  worker/wrangler.toml has ROUTES CONFIGURED.

This deploy ATTACHES those routes and CHANGES LIVE TRAFFIC. Verifying
prerequisites before publishing rather than after.
MSG
  # Before publishing, while nothing has changed yet.
  verify_required_secret "pre-publish"
else
  echo "✅ Guards passed. Publishing the Worker (no routes configured, so this changes nothing the public sees)." >&2
fi

npm --prefix worker run deploy

# Always verify after publishing too: a first deploy has no Worker to inspect
# beforehand, so the pre-publish check above cannot be the only one.
verify_required_secret "post-publish"
