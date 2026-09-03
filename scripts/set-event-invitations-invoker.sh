#!/usr/bin/env bash
set -euo pipefail

# Reproducible Cloud Run invoker configuration for the event-invitation
# callables (#803).
#
# Domain Restricted Sharing rejects the `allUsers` binding Firebase normally
# adds to a Gen2 callable. These functions authenticate and authorize inside
# the callable runtime, so their backing services must accept the request at
# the network layer first. A Functions deploy can reset that service setting;
# run this wrapper after every release that may include any of the three.
#
# Usage:
#   scripts/set-event-invitations-invoker.sh
#   scripts/set-event-invitations-invoker.sh --dry-run
#   scripts/set-event-invitations-invoker.sh --prove-update
#   scripts/set-event-invitations-invoker.sh --allow-missing
#   scripts/set-event-invitations-invoker.sh --allow-missing-service redeem
#
# `--allow-missing-service` is intentionally per service. After an exact
# `--only functions:mintEventInvitation` release, mint must exist, while the
# unselected redeem and revoke services may legitimately be absent on a first
# deploy. The deploy wrapper therefore allows only those two missing services;
# a missing selected service remains fatal.
#
# Environment / overrides:
#   EVENT_INVITATIONS_PROJECT        GCP project (default: fiveacross)
#   EVENT_INVITATIONS_REGION         Cloud Run region (default: us-central1)
#   EVENT_INVITATIONS_MINT_SERVICE   mintEventInvitation backing service
#                                    (default: minteventinvitation)
#   EVENT_INVITATIONS_REDEEM_SERVICE redeemEventInvitation backing service
#                                    (default: redeemeventinvitation)
#   EVENT_INVITATIONS_REVOKE_SERVICE revokeEventInvitation backing service
#                                    (default: revokeeventinvitation)
#   GCLOUD_BIN                       gcloud binary (default: gcloud)

PROJECT="${EVENT_INVITATIONS_PROJECT:-fiveacross}"
REGION="${EVENT_INVITATIONS_REGION:-us-central1}"
MINT_SERVICE="${EVENT_INVITATIONS_MINT_SERVICE:-minteventinvitation}"
REDEEM_SERVICE="${EVENT_INVITATIONS_REDEEM_SERVICE:-redeemeventinvitation}"
REVOKE_SERVICE="${EVENT_INVITATIONS_REVOKE_SERVICE:-revokeeventinvitation}"
DRY_RUN=false
PROVE_UPDATE=false
ALLOW_MISSING_MINT=false
ALLOW_MISSING_REDEEM=false
ALLOW_MISSING_REVOKE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --prove-update) PROVE_UPDATE=true; shift ;;
    --allow-missing)
      ALLOW_MISSING_MINT=true
      ALLOW_MISSING_REDEEM=true
      ALLOW_MISSING_REVOKE=true
      shift
      ;;
    --allow-missing-service)
      case "${2:-}" in
        mint) ALLOW_MISSING_MINT=true ;;
        redeem) ALLOW_MISSING_REDEEM=true ;;
        revoke) ALLOW_MISSING_REVOKE=true ;;
        *)
          echo "--allow-missing-service expects 'mint', 'redeem', or 'revoke', got: ${2:-<none>}" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Attempt every service even if an earlier one fails, so one broken endpoint
# never hides another from the operator.
STATUS=0
for entry in \
  "mint:$MINT_SERVICE:$ALLOW_MISSING_MINT" \
  "redeem:$REDEEM_SERVICE:$ALLOW_MISSING_REDEEM" \
  "revoke:$REVOKE_SERVICE:$ALLOW_MISSING_REVOKE"; do
  operation="${entry%%:*}"
  rest="${entry#*:}"
  service="${rest%%:*}"
  allow_missing="${rest#*:}"
  ARGS=(
    --service "$service" --region "$REGION" --project "$PROJECT"
    --label "Event invitation ($operation)"
    --verify-hint "issue #803 event-invitation callable tests"
    --service-env-hint "EVENT_INVITATIONS_$(echo "$operation" | tr '[:lower:]' '[:upper:]')_SERVICE"
  )
  [[ "$DRY_RUN" == "true" ]] && ARGS+=(--dry-run)
  [[ "$PROVE_UPDATE" == "true" ]] && ARGS+=(--prove-update)
  [[ "$allow_missing" == "true" ]] && ARGS+=(--allow-missing)
  "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}" || STATUS=$?
done

exit "$STATUS"
