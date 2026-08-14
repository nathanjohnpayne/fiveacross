#!/usr/bin/env bash
set -euo pipefail

# Reproducible invoker configuration for the submitBugReport callable (#158).
#
# Thin wrapper over the shared scripts/set-cloud-run-invoker.sh — #616
# generalized this mechanism into that shared script so the emailUnsubscribe
# endpoint could reuse it (see scripts/set-email-unsubscribe-invoker.sh)
# instead of duplicating the gcloud logic. This file's documented interface —
# the BUG_REPORT_* env vars, `--dry-run`, `--help` — is unchanged; only the
# implementation moved.
#
# The org policy on this project rejects an `allUsers` Cloud Run invoker IAM
# binding (Domain Restricted Sharing), which is the binding `firebase deploy`
# normally adds to make a callable publicly reachable. The org-policy-compatible
# alternative is to DISABLE the Cloud Run invoker IAM check on the function's
# backing service: the service then accepts unauthenticated requests at the
# network layer, and the callable enforces Firebase Auth in application code
# (returns UNAUTHENTICATED). See docs/app/bug-reports.md § Repeat-deploy
# hardening and issue #158.
#
# A `firebase deploy --only functions` can reset this — it may re-try the
# rejected allUsers binding and report a partial failure, leaving the callable
# unreachable. Re-run this AFTER any Functions deploy to restore the reachable
# state. It is idempotent: if the invoker IAM check is already disabled it
# no-ops.
#
# Usage:
#   scripts/set-bug-report-invoker.sh              # apply to prod (default)
#   scripts/set-bug-report-invoker.sh --dry-run    # print the action, change nothing
#
# Environment / overrides (defaults target this project's prod callable):
#   BUG_REPORT_PROJECT   GCP project      (default: gaycruisebingo)
#   BUG_REPORT_REGION    Cloud Run region (default: us-central1)
#   BUG_REPORT_SERVICE   Cloud Run service name (default: submitbugreport —
#                        the lowercased Gen2 function name)
#   GCLOUD_BIN           gcloud binary (default: gcloud; the 1Password-backed
#                        wrapper on PATH resolves credentials)
#
# Verify the result with: scripts/smoke-bug-report-callable.sh

PROJECT="${BUG_REPORT_PROJECT:-gaycruisebingo}"
REGION="${BUG_REPORT_REGION:-us-central1}"
SERVICE="${BUG_REPORT_SERVICE:-submitbugreport}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '3,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=(
  --service "$SERVICE" --region "$REGION" --project "$PROJECT"
  --label "Bug-report"
  --verify-hint "scripts/smoke-bug-report-callable.sh"
  --service-env-hint "BUG_REPORT_SERVICE"
)
[[ "$DRY_RUN" == "true" ]] && ARGS+=(--dry-run)

exec "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}"
