#!/usr/bin/env bash
set -euo pipefail

# Executable boundary around the canonical deploy source guard. The named
# target wrapper runs this before any mutating pre-build readiness operation;
# deploy.sh runs the same guard again immediately before its build.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/deploy-main-guard.sh
source "$SCRIPT_DIR/lib/deploy-main-guard.sh"

FORCE=false
if [[ "${1:-}" == "--force" && $# -eq 1 ]]; then
  FORCE=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: scripts/assert-deploy-source-ready.sh [--force]" >&2
  exit 2
fi

guard_deploy_main_checkout "scripts/deploy-target.mjs" "$FORCE"
