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
# applies the SAME three guards to the Cloudflare surface, deliberately
# mirroring that script's guards, messages and `--force` break-glass so an
# operator meets one policy rather than two.
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
#   scripts/worker-deploy.sh [--force] [-- <extra wrangler args>]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORCE=false
WRANGLER_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --) shift; WRANGLER_ARGS=("$@"); break ;;
    *) WRANGLER_ARGS+=("$1"); shift ;;
  esac
done

# Guard 1: must be on main
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: deploying the Worker from '$CURRENT_BRANCH' (not main)" >&2
  else
    cat >&2 <<EOF
Refusing to deploy the Worker: current branch is '$CURRENT_BRANCH', not 'main'.

wrangler publishes your working directory, not origin/main. Once the routes
are attached this Worker fronts every wildcard Event hostname, so shipping a
feature branch replaces the router for every Event with unreviewed code.

To override (break-glass only): scripts/worker-deploy.sh --force
EOF
    exit 1
  fi
fi

# Guard 2: must exactly match origin/main. Fail closed on a fetch failure —
# stale origin/main metadata would silently defeat the freshness check.
if ! git fetch --quiet origin main 2>/dev/null; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: git fetch failed; skipping freshness verification" >&2
  else
    echo "Refusing to deploy the Worker: 'git fetch origin main' failed, so freshness against origin/main cannot be verified." >&2
    echo "To override (break-glass only): scripts/worker-deploy.sh --force" >&2
    exit 1
  fi
fi

if [[ "$CURRENT_BRANCH" == "main" ]] && git rev-parse --verify --quiet origin/main >/dev/null; then
  LOCAL_HEAD="$(git rev-parse HEAD)"
  ORIGIN_HEAD="$(git rev-parse origin/main)"
  if [[ "$LOCAL_HEAD" != "$ORIGIN_HEAD" ]]; then
    AHEAD="$(git rev-list --count origin/main..HEAD)"
    BEHIND="$(git rev-list --count HEAD..origin/main)"
    if [[ "$FORCE" == "true" ]]; then
      echo "⚠️  --force: local main differs from origin/main ($AHEAD ahead, $BEHIND behind)" >&2
    else
      cat >&2 <<EOF
Refusing to deploy the Worker: local main does not exactly match origin/main
($AHEAD ahead, $BEHIND behind).

Deploys must ship the reviewed, merged origin/main commit. Push or discard
your local commits first.

To override (break-glass only): scripts/worker-deploy.sh --force
EOF
      exit 1
    fi
  fi
fi

# Guard 3: working tree must be clean
DIRTY="$(git status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: deploying the Worker from a dirty working tree" >&2
  else
    cat >&2 <<EOF
Refusing to deploy the Worker: working tree is dirty.

wrangler bundles what is on disk, so uncommitted edits would ship to the
router that fronts every Event hostname.

$DIRTY

To override (break-glass only): scripts/worker-deploy.sh --force
EOF
    exit 1
  fi
fi

echo "✅ Guards passed. Publishing the Worker (routes are NOT attached by this step)." >&2
npm --prefix worker install
npm --prefix worker run deploy -- "${WRANGLER_ARGS[@]+"${WRANGLER_ARGS[@]}"}"
