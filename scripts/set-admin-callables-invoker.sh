#!/usr/bin/env bash
set -euo pipefail

# Reproducible Cloud Run invoker configuration for the admin callables (#1277).
#
# Domain Restricted Sharing rejects the `allUsers` binding Firebase normally
# adds to a Gen2 callable. unlockDayNow (with its `resnapshot: true` arm) and
# approvePrompts (#1275) authenticate and check the admin claim inside the
# callable runtime, so their backing services must accept the request at the
# network layer first. A Functions deploy can reset that service setting; run
# this wrapper after every release that may include either callable.
#
# Healthy probe: an unauthenticated `POST {"data":{}}` to the function URL
# answers the function's own 401 UNAUTHENTICATED JSON. A Google HTML 403 page
# means the request never reached the function.
#
# Usage:
#   scripts/set-admin-callables-invoker.sh
#   scripts/set-admin-callables-invoker.sh --dry-run
#   scripts/set-admin-callables-invoker.sh --prove-update
#   scripts/set-admin-callables-invoker.sh --allow-missing
#   scripts/set-admin-callables-invoker.sh --allow-missing-service approve
#
# `--allow-missing-service` is intentionally per service. approvePrompts does
# not exist in either project until #1275 deploys, so a release that selects
# only unlockDayNow tolerates an absent approveprompts service, while a missing
# strict service remains fatal. A selected service is strict only when the
# codebase the selector resolves to exports it (#1282); when it does not, or
# the codebase cannot be inventoried, the deploy wrapper runs this script with
# every service allowed to be absent (--allow-missing).
#
# Environment / overrides:
#   ADMIN_CALLABLES_PROJECT          GCP project (default: fiveacross)
#   ADMIN_CALLABLES_REGION           Cloud Run region (default: us-central1)
#   ADMIN_CALLABLES_UNLOCK_SERVICE   unlockDayNow backing service
#                                    (default: unlockdaynow)
#   ADMIN_CALLABLES_APPROVE_SERVICE  approvePrompts backing service
#                                    (default: approveprompts)
#   GCLOUD_BIN                       gcloud binary (default: gcloud)

PROJECT="${ADMIN_CALLABLES_PROJECT:-fiveacross}"
REGION="${ADMIN_CALLABLES_REGION:-us-central1}"
UNLOCK_SERVICE="${ADMIN_CALLABLES_UNLOCK_SERVICE:-unlockdaynow}"
APPROVE_SERVICE="${ADMIN_CALLABLES_APPROVE_SERVICE:-approveprompts}"
DRY_RUN=false
PROVE_UPDATE=false
ALLOW_MISSING_UNLOCK=false
ALLOW_MISSING_APPROVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --prove-update) PROVE_UPDATE=true; shift ;;
    --allow-missing)
      ALLOW_MISSING_UNLOCK=true
      ALLOW_MISSING_APPROVE=true
      shift
      ;;
    --allow-missing-service)
      case "${2:-}" in
        unlock) ALLOW_MISSING_UNLOCK=true ;;
        approve) ALLOW_MISSING_APPROVE=true ;;
        *)
          echo "--allow-missing-service expects 'unlock' or 'approve', got: ${2:-<none>}" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '3,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Attempt every service even if an earlier one fails, so one broken endpoint
# never hides another from the operator.
STATUS=0
for entry in \
  "unlock:unlockDayNow:$UNLOCK_SERVICE:$ALLOW_MISSING_UNLOCK" \
  "approve:approvePrompts:$APPROVE_SERVICE:$ALLOW_MISSING_APPROVE"; do
  operation="${entry%%:*}"
  rest="${entry#*:}"
  callable="${rest%%:*}"
  rest="${rest#*:}"
  service="${rest%%:*}"
  allow_missing="${rest#*:}"
  ARGS=(
    --service "$service" --region "$REGION" --project "$PROJECT"
    --label "Admin callable ($callable)"
    --verify-hint "an unauthenticated POST {\"data\":{}} to $callable answers its own 401 UNAUTHENTICATED JSON, never an HTML 403 (#1277)"
    --service-env-hint "ADMIN_CALLABLES_$(echo "$operation" | tr '[:lower:]' '[:upper:]')_SERVICE"
  )
  [[ "$DRY_RUN" == "true" ]] && ARGS+=(--dry-run)
  [[ "$PROVE_UPDATE" == "true" ]] && ARGS+=(--prove-update)
  [[ "$allow_missing" == "true" ]] && ARGS+=(--allow-missing)
  "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}" || STATUS=$?
done

exit "$STATUS"
