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

FORBIDDEN_SECRET="FIREBASE_API_KEY"

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

# Verify the registry lookup binding in the configuration about to be published.
#
# This replaces the old `FIREBASE_API_KEY` presence check, and the shape of the
# check changed with the shape of the dependency (#972). The api key was set
# with `wrangler secret put` and deliberately NOT committed, so the only place
# to observe it was the deployed Worker. The registry binding is the opposite:
# it is declared in `worker/wrangler.toml` and travels with the upload, so the
# committed configuration IS the deployed configuration and is answerable here,
# before anything is published or installed.
#
# What it defends is a one-word difference with a large blast radius. Bound with
# an explicit `entrypoint = "RegistryLookupEntrypoint"`, the router can call
# `lookup(host)` and nothing else. Omit that line, or write `default`, and the
# same binding reaches the registry's default export — the signed
# sync/audit/recovery control plane — handing a public edge Worker the private
# control surface. The validator is shared with the synthetic harness so both
# configurations are held to one definition of "bound to the lookup entrypoint".
verify_registry_lookup_binding() {
  echo "🔎 Verifying worker/wrangler.toml binds the registry lookup entrypoint explicitly…" >&2
  local status=0
  node "$SCRIPT_DIR/event-router-registry/check-router-binding.mjs" || status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "✅ REGISTRY is bound explicitly to RegistryLookupEntrypoint." >&2
    return 0
  fi
  # 69 is "the check could not run", not "the binding is wrong". Announcing a
  # binding problem here would send the operator to edit the one block that is
  # correct — the validator parses the configuration with a ROOT devDependency,
  # and this guard runs before any install.
  if [[ "$status" -eq 69 ]]; then
    echo "" >&2
    echo "❌ Could not run the registry binding check." >&2
    echo "" >&2
    echo "It parses worker/wrangler.toml with a root devDependency, so install the" >&2
    echo "root lockfile first and re-run:" >&2
    echo "" >&2
    echo "  npm ci" >&2
    echo "" >&2
    exit 69
  fi
  echo "" >&2
  echo "❌ worker/wrangler.toml does not bind REGISTRY explicitly to RegistryLookupEntrypoint." >&2
  echo "" >&2
  echo "An omitted or \`default\` entrypoint binds the registry's control-plane fetch" >&2
  echo "instead of its lookup-only entrypoint. Fix the [[services]] block before" >&2
  echo "deploying; see worker/README.md § The registry lookup binding." >&2
  echo "" >&2
  exit 65
}

# Verify the DEPLOYED Worker carries no Firebase credential.
#
# The inversion is the deliverable, not a leftover. ADR 0014 removed the
# Firestore REST reader outright, and R0's evidence claim is that the public
# router has no Firebase, KV, Cache, or Durable Object binding at all — a claim
# a stale `FIREBASE_API_KEY` left on the Worker from the previous design would
# quietly falsify. The code no longer reads it, so it grants nothing on its own;
# it is refused because an unrouted router that still holds an edge credential
# is not the artifact the App Check cutover is allowed to attach.
#
# Nothing else in the ladder can observe this. `wrangler dev --remote` uploads
# the local checkout into a temporary preview with its own `.dev.vars`, and the
# workers.dev URL is refused as `out-of-namespace` before configuration is
# consulted, so neither can report what the deployed Worker holds.
#
# `wrangler secret list` returns names and types only, never values.
verify_no_firebase_secret() {
  local when="$1" secrets
  echo "🔎 Verifying the deployed Worker carries no ${FORBIDDEN_SECRET} binding (${when})…" >&2

  if ! secrets="$(npm --prefix worker exec -- wrangler secret list --format json 2>/dev/null)"; then
    # Inability to inspect is NOT a pass. The README presents this as
    # verification of the deployed artifact, so exiting 0 here would let
    # automation record an unverified deploy as a verified one.
    cat >&2 <<MSG

❌ Could not list the deployed Worker's secrets, so its Firebase posture could not be verified.

This is a FAILED verification, not a skipped one. Check \`wrangler\` auth and the
Worker's existence, then re-run. To inspect by hand:

    npm --prefix worker exec -- wrangler secret list

MSG
    exit 75
  fi

  # EXACT name comparison, for the same reason the presence check needed one:
  # an unanchored match would report a leftover `OLD_FIREBASE_API_KEY` as the
  # live binding, or miss the live one behind a near-miss neighbour.
  #
  # `present` is compared against the literal `false` rather than tested for
  # truthiness, so ONLY a parsed array that demonstrably lacks the name passes.
  # Inverting a check inverts its failure mode too: with the old presence test,
  # unparseable output made `jq` exit non-zero and the deploy failed closed by
  # accident; here the same accident would read as proof of absence. A listing
  # that is not an array, or not JSON at all, is evidence of nothing.
  local present
  if ! present="$(printf '%s' "$secrets" | jq -r --arg name "$FORBIDDEN_SECRET" \
      'if type=="array" then (any(.[]; .name == $name) | tostring) else "true" end' 2>/dev/null)"; then
    present="true"
  fi

  if [[ "$present" != "false" ]]; then
    cat >&2 <<MSG

❌ ${FORBIDDEN_SECRET} is STILL bound on the deployed Worker.

The router no longer reads it — ADR 0014 removed the Firestore REST reader — but
an edge Firebase credential must not outlive the code that used it. Remove it
before attaching any route:

    npm --prefix worker exec -- wrangler secret delete ${FORBIDDEN_SECRET}

MSG
    exit 1
  fi

  echo "✅ No ${FORBIDDEN_SECRET} binding on the deployed Worker." >&2
}

verify_registry_lookup_binding

# Install the reviewed Worker toolchain before ANY Wrangler command. A
# route-bearing deploy verifies the deployed artifact before publishing, so
# deferring this until the deploy step would make that prerequisite check run
# through npm's unpinned fallback in a clean checkout with no node_modules.
# `npm ci`, never `npm install`: the lockfile is part of the reviewed deploy.
# Wrangler is a devDependency, so force its inclusion even when the operator's
# shell carries NODE_ENV=production or NPM_CONFIG_OMIT=dev.
npm --prefix worker ci --include=dev

if [[ "$ROUTE_BEARING" == "true" ]]; then
  cat >&2 <<'MSG'
⚠️  worker/wrangler.toml has ROUTES CONFIGURED.

This deploy ATTACHES those routes and CHANGES LIVE TRAFFIC. Verifying
prerequisites before publishing rather than after.
MSG
  # Before publishing, while nothing has changed yet.
  verify_no_firebase_secret "pre-publish"
else
  echo "✅ Guards passed. Publishing the Worker (no routes configured, so this changes nothing the public sees)." >&2
fi

npm --prefix worker run deploy

# Always verify after publishing too: a first deploy has no Worker to inspect
# beforehand, so the pre-publish check above cannot be the only one.
verify_no_firebase_secret "post-publish"
