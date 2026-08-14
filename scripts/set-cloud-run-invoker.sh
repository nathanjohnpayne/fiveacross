#!/usr/bin/env bash
set -euo pipefail

# Shared helper: disable the Cloud Run invoker IAM check on a Gen2 Cloud
# Functions backing service (#158, generalized for #616's emailUnsubscribe).
#
# This project's org policy (Domain Restricted Sharing,
# constraints/iam.allowedPolicyMemberDomains) rejects an `allUsers` Cloud Run
# invoker IAM binding — the binding `firebase deploy` normally adds to make a
# function publicly reachable, and the ONLY thing that grants that reachability;
# a Firebase Hosting rewrite in front of the function does not change the Cloud
# Run invoker check, it just forwards the unauthenticated request into it. The
# org-policy-compatible alternative is to DISABLE the Cloud Run invoker IAM
# check on the function's backing service instead: the service then accepts
# unauthenticated requests at the network layer, and the function enforces its
# own authorization in application code. See docs/app/bug-reports.md §
# Repeat-deploy hardening (the original case, #158) and
# docs/app/phase-1-deploy.md (the emailUnsubscribe case, #616).
#
# A `firebase deploy --only functions` can reset this — it may re-try the
# rejected allUsers binding and report a partial failure, leaving the service
# unreachable. Re-run the per-endpoint wrapper AFTER every Functions deploy to
# restore the reachable state. Idempotent: if the invoker IAM check is already
# disabled it no-ops.
#
# This script is not meant to be invoked directly for a specific endpoint —
# use a thin per-service wrapper instead (scripts/set-bug-report-invoker.sh,
# scripts/set-email-unsubscribe-invoker.sh), which documents that endpoint's
# own env-var overrides and verify command, and keeps this shared
# implementation from being duplicated per service.
#
# Usage:
#   scripts/set-cloud-run-invoker.sh --service <name> --region <region> \
#     --project <project> [--label <text>] [--verify-hint <text>] \
#     [--service-env-hint <text>] [--dry-run]
#
# Flags:
#   --service            Cloud Run service name (required)
#   --region             Cloud Run region (required)
#   --project             GCP project (required)
#   --label               Short label prefixed to the status line (default: "Cloud Run")
#   --verify-hint         Text printed after a successful update, naming the
#                          endpoint's own verification step (default: none printed)
#   --service-env-hint    Text suggested in the "service not found" failure
#                          message (default: "the correct service name")
#   --dry-run             Print the action, change nothing
#
# Environment:
#   GCLOUD_BIN   gcloud binary (default: gcloud; the 1Password-backed wrapper
#                on PATH resolves credentials)

SERVICE=""
REGION=""
PROJECT=""
LABEL="Cloud Run"
VERIFY_HINT=""
SERVICE_ENV_HINT="the correct service name"
DRY_RUN=false
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
INVOKER_ANNOTATION='run.googleapis.com/invoker-iam-disabled'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:?--service needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --verify-hint) VERIFY_HINT="${2:?--verify-hint needs a value}"; shift 2 ;;
    --service-env-hint) SERVICE_ENV_HINT="${2:?--service-env-hint needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '3,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SERVICE" ]] || { echo "FAIL: --service is required" >&2; exit 2; }
[[ -n "$REGION" ]] || { echo "FAIL: --region is required" >&2; exit 2; }
[[ -n "$PROJECT" ]] || { echo "FAIL: --project is required" >&2; exit 2; }

run_gcloud() { "$GCLOUD_BIN" "$@"; }

echo ">> $LABEL invoker config: service=$SERVICE region=$REGION project=$PROJECT"

# Confirm the service exists before mutating anything — a wrong/renamed service
# should fail with a helpful list, not a confusing update error.
if ! current="$(run_gcloud run services describe "$SERVICE" \
      --region "$REGION" --project "$PROJECT" \
      --format="value(metadata.annotations[\"$INVOKER_ANNOTATION\"])" 2>/dev/null)"; then
  echo "FAIL: could not describe Cloud Run service '$SERVICE' in $REGION ($PROJECT)." >&2
  echo "      Available services:" >&2
  run_gcloud run services list --project "$PROJECT" --region "$REGION" \
    --format='value(metadata.name)' >&2 || true
  echo "      Set $SERVICE_ENV_HINT to the correct name and re-run." >&2
  exit 1
fi

if [[ "$current" == "true" ]]; then
  echo "   Invoker IAM check already disabled — nothing to do (idempotent)."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "   [dry-run] would run: gcloud run services update $SERVICE \\"
  echo "             --region $REGION --project $PROJECT --no-invoker-iam-check"
  exit 0
fi

echo "   Disabling the Cloud Run invoker IAM check (org-policy-compatible reachability)…"
run_gcloud run services update "$SERVICE" \
  --region "$REGION" --project "$PROJECT" --no-invoker-iam-check

if [[ -n "$VERIFY_HINT" ]]; then
  echo "   Done. Verify with: $VERIFY_HINT"
else
  echo "   Done."
fi
