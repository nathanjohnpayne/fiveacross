#!/usr/bin/env bash
set -euo pipefail

# Reproducible invoker configuration for the auth-handoff callables (#548).
#
# Thin wrapper over the shared scripts/set-cloud-run-invoker.sh, alongside
# scripts/set-bug-report-invoker.sh and scripts/set-email-unsubscribe-invoker.sh.
#
# ONE WRAPPER FOR TWO SERVICES, unlike its siblings, because mintAuthHandoff and
# exchangeAuthHandoff are two halves of a single sign-in flow: either one left
# 403ing breaks authentication on every Event origin, they are always released
# together, and there is no deploy in which reconciling one without the other is
# the correct outcome. Splitting them would double deploy.sh's per-endpoint
# selection state to buy a distinction nothing can act on.
#
# The org policy on these projects rejects an `allUsers` Cloud Run invoker IAM
# binding (Domain Restricted Sharing), which is the binding `firebase deploy`
# normally adds to make a callable publicly reachable. The org-policy-compatible
# alternative is to DISABLE the Cloud Run invoker IAM check on each backing
# service: the service then accepts unauthenticated requests at the network
# layer, and the function enforces its own authorization in application code.
#
# BOTH services genuinely need it, for different reasons, and neither is an
# oversight:
#   - `exchangeAuthHandoff` is unauthenticated BY DESIGN. Its caller is an Event
#     origin that has no Firebase session yet — obtaining one is the entire
#     point — so there is no token to present at the IAM layer. Its
#     authorization is the handoff code plus the transaction verifier, checked
#     in application code (functions/src/authHandoff.ts).
#   - `mintAuthHandoff` DOES require a signed-in caller, but that check is a
#     Firebase ID token verified by the callable runtime, which is not a Google
#     IAM identity. The Cloud Run invoker check would reject the request before
#     the function ever ran, so a callable that authenticates in application
#     code still needs the network-layer check disabled. This is the same shape
#     as submitBugReport (#158), which is also an authenticated callable.
#
# A `firebase deploy --only functions` can reset this — it may re-try the
# rejected allUsers binding and report a partial failure, leaving the callables
# unreachable and sign-in broken. Re-run this AFTER any Functions deploy to
# restore the reachable state. It is idempotent: if the invoker IAM check is
# already disabled on both services it no-ops.
#
# Usage:
#   scripts/set-auth-handoff-invoker.sh                 # apply to prod (default)
#   scripts/set-auth-handoff-invoker.sh --dry-run       # print the actions, change nothing
#   scripts/set-auth-handoff-invoker.sh --allow-missing # a NOT_FOUND describe is
#                                                       # non-fatal for BOTH halves
#   scripts/set-auth-handoff-invoker.sh --allow-missing-half exchange
#                                                       # non-fatal for ONE half only
#
# --allow-missing-half exists because "the pair is reconciled together" must not
# become "a missing service is always tolerated" (#548, Codex P2 round 4). A
# scoped `--only functions:mintAuthHandoff` deploy may legitimately leave
# exchangeAuthHandoff uncreated, but the half it actually DEPLOYED must still be
# there afterwards — tolerating both would let a scoped deploy finish green
# without reconciling the function it just released, which is the 403 this whole
# mechanism exists to prevent. deploy.sh therefore names the absent-tolerated
# half rather than passing a single blanket --allow-missing.
#
# Environment / overrides:
#   AUTH_HANDOFF_PROJECT          GCP project      (default: fiveacross)
#   AUTH_HANDOFF_REGION           Cloud Run region (default: us-central1)
#   AUTH_HANDOFF_MINT_SERVICE     Cloud Run service for mintAuthHandoff
#                                 (default: mintauthhandoff — the lowercased
#                                 Gen2 function name)
#   AUTH_HANDOFF_EXCHANGE_SERVICE Cloud Run service for exchangeAuthHandoff
#                                 (default: exchangeauthhandoff)
#   GCLOUD_BIN                    gcloud binary (default: gcloud; the
#                                 1Password-backed wrapper on PATH resolves
#                                 credentials)
#
# The project default is `fiveacross`, NOT `gaycruisebingo` as the two sibling
# wrappers use. The handoff exists for the Five Across wildcard-hostname
# architecture (ADR 0010); gaycruisebingo is a single registered origin that
# signs in same-origin and never mints a handoff. A gaycruisebingo deploy still
# publishes the functions, though, so deploy.sh pins the project from the
# selected deploy target rather than relying on this default.

PROJECT="${AUTH_HANDOFF_PROJECT:-fiveacross}"
REGION="${AUTH_HANDOFF_REGION:-us-central1}"
MINT_SERVICE="${AUTH_HANDOFF_MINT_SERVICE:-mintauthhandoff}"
EXCHANGE_SERVICE="${AUTH_HANDOFF_EXCHANGE_SERVICE:-exchangeauthhandoff}"
DRY_RUN=false
ALLOW_MISSING_MINT=false
ALLOW_MISSING_EXCHANGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --allow-missing) ALLOW_MISSING_MINT=true; ALLOW_MISSING_EXCHANGE=true; shift ;;
    --allow-missing-half)
      case "${2:-}" in
        mint)     ALLOW_MISSING_MINT=true ;;
        exchange) ALLOW_MISSING_EXCHANGE=true ;;
        *) echo "--allow-missing-half expects 'mint' or 'exchange', got: ${2:-<none>}" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '3,76p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Both services are attempted even if the first fails, and the worst status
# wins. Stopping at the first failure would hide a second broken service behind
# the one already being reported — and since sign-in needs both, a report that
# names only half the problem sends the operator back for a second round.
STATUS=0
for entry in "mint:$MINT_SERVICE:$ALLOW_MISSING_MINT" "exchange:$EXCHANGE_SERVICE:$ALLOW_MISSING_EXCHANGE"; do
  half="${entry%%:*}"
  rest="${entry#*:}"
  service="${rest%%:*}"
  allow_missing="${rest#*:}"
  ARGS=(
    --service "$service" --region "$REGION" --project "$PROJECT"
    --label "Auth-handoff ($half)"
    --verify-hint "specs/auth-handoff.md § Wire contract"
    --service-env-hint "AUTH_HANDOFF_$(echo "$half" | tr '[:lower:]' '[:upper:]')_SERVICE"
  )
  [[ "$DRY_RUN" == "true" ]] && ARGS+=(--dry-run)
  [[ "$allow_missing" == "true" ]] && ARGS+=(--allow-missing)
  "$SCRIPT_DIR/set-cloud-run-invoker.sh" "${ARGS[@]}" || STATUS=$?
done

exit "$STATUS"
