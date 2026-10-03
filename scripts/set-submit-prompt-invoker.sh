#!/usr/bin/env bash
set -euo pipefail

# Cloud Run invoker reconciliation for the submitPrompt callable (#1311).
# The shared helper owns authentication, read-only probes and annotation updates;
# this wrapper supplies only the endpoint's names. The callable enforces Firebase
# Auth and current Event/membership admission even when its network IAM check is
# disabled. The dark source release leaves the client/Rules cutover separate.
#
# Usage: scripts/set-submit-prompt-invoker.sh [--dry-run] [--allow-missing]
# --dry-run describes and prints the intended action without updates.
# --allow-missing tolerates NOT_FOUND for a first-deploy precheck; all other
# describe failures remain fatal. A proven post-publish export must exist.
# Environment: SUBMIT_PROMPT_PROJECT (default gaycruisebingo),
# SUBMIT_PROMPT_REGION (default us-central1), SUBMIT_PROMPT_SERVICE
# (default submitprompt, the lowercased Gen2 name), GCLOUD_BIN.
# Applying this wrapper to a deployed service requires separate authorization.

ARGS=(
  --service "${SUBMIT_PROMPT_SERVICE:-submitprompt}"
  --region "${SUBMIT_PROMPT_REGION:-us-central1}"
  --project "${SUBMIT_PROMPT_PROJECT:-gaycruisebingo}"
  --label "Community Prompt"
  --service-env-hint "SUBMIT_PROMPT_SERVICE"
  --verify-hint "Unauthenticated submitPrompt must reach callable 401 JSON; see specs/community-prompt-admission.md."
)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--allow-missing) ARGS+=("$1"); shift ;;
    -h|--help) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}"
