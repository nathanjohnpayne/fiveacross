#!/usr/bin/env bash
set -euo pipefail

# Reproducible invoker configuration for the emailUnsubscribe function (#616 P1
# follow-up).
#
# The /unsubscribe Hosting rewrite (firebase.json) makes the endpoint reachable
# at a first-party URL, but a Hosting rewrite does NOT bypass the backing Gen2
# Cloud Run service's invoker IAM check — it just forwards the unauthenticated
# request into it, which this project's org policy still rejects. Without this
# script the rewrite alone is cosmetic: the endpoint still 403s and every
# emailed unsubscribe link stays unusable. This is the exact org-policy
# constraint scripts/set-bug-report-invoker.sh already solved for
# submitBugReport (#158); both are thin wrappers over the shared
# scripts/set-cloud-run-invoker.sh implementation.
#
# The org policy on this project rejects an `allUsers` Cloud Run invoker IAM
# binding (Domain Restricted Sharing), which is the binding `firebase deploy`
# normally adds to make a function publicly reachable. The org-policy-compatible
# alternative is to DISABLE the Cloud Run invoker IAM check on the function's
# backing service: the service then accepts unauthenticated requests at the
# network layer, and the function enforces its own authorization in
# application code (`applyOptOut`'s constant-time capability-token check). See
# docs/app/bug-reports.md § Repeat-deploy hardening for the full mechanism and
# docs/app/phase-1-deploy.md for the post-deploy runbook step.
#
# A `firebase deploy --only functions` can reset this — it may re-try the
# rejected allUsers binding and report a partial failure, leaving the endpoint
# unreachable (every emailed unsubscribe link 403s). Re-run this AFTER any
# Functions deploy to restore the reachable state. It is idempotent: if the
# invoker IAM check is already disabled it no-ops.
#
# Usage:
#   scripts/set-email-unsubscribe-invoker.sh              # apply to prod (default)
#   scripts/set-email-unsubscribe-invoker.sh --dry-run    # print the action, change nothing
#
# Environment / overrides (defaults target this project's prod endpoint):
#   EMAIL_UNSUBSCRIBE_PROJECT   GCP project      (default: gaycruisebingo)
#   EMAIL_UNSUBSCRIBE_REGION    Cloud Run region (default: us-central1)
#   EMAIL_UNSUBSCRIBE_SERVICE   Cloud Run service name (default: emailunsubscribe —
#                                the lowercased Gen2 function name)
#   GCLOUD_BIN                  gcloud binary (default: gcloud; the
#                                1Password-backed wrapper on PATH resolves
#                                credentials)
#
# Verify the result per docs/app/phase-1-deploy.md's post-deploy check:
#   curl -sI "$EMAIL_UNSUBSCRIBE_URL?e=x&u=y&t=z"   # expect 200, not 403

PROJECT="${EMAIL_UNSUBSCRIBE_PROJECT:-gaycruisebingo}"
REGION="${EMAIL_UNSUBSCRIBE_REGION:-us-central1}"
SERVICE="${EMAIL_UNSUBSCRIBE_SERVICE:-emailunsubscribe}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '3,47p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=(
  --service "$SERVICE" --region "$REGION" --project "$PROJECT"
  --label "Email-unsubscribe"
  --verify-hint "curl -sI \"\$EMAIL_UNSUBSCRIBE_URL?e=x&u=y&t=z\" (docs/app/phase-1-deploy.md)"
  --service-env-hint "EMAIL_UNSUBSCRIBE_SERVICE"
)
[[ "$DRY_RUN" == "true" ]] && ARGS+=(--dry-run)

exec "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}"
