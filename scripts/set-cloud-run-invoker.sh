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
#     [--service-env-hint <text>] [--dry-run] [--allow-missing]
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
#   --allow-missing       Treat a NOT_FOUND on the describe call as a distinct,
#                          non-fatal outcome (exit 0) instead of a FAIL. For a
#                          brand-new target's first deploy, the Cloud Run
#                          service does not exist until Functions creates it,
#                          so "not found yet" is expected, not an error (#768
#                          r5 Codex P2). Every OTHER describe failure — no
#                          credential, PERMISSION_DENIED, an unusable key file
#                          — still exits 1: this flag narrows what counts as
#                          "absent", it does not widen what counts as "fine".
#                          Intended for the PRE-PUBLISH check only; the
#                          post-deploy reconciliation omits it on purpose, so
#                          a 404 there (service should exist by now) still
#                          fails loud.
#
# Environment:
#   GCLOUD_BIN   gcloud binary (default: gcloud; the 1Password-backed wrapper
#                on PATH resolves credentials)
#
# CREDENTIALS (#768 r4 — this used to abort routine deploys)
#
# `gcloud` resolves its OWN chain and does NOT inherit op-firebase-deploy's
# per-project Firebase-vault SA key, which that wrapper materializes into a
# temp file and deletes on exit. Load deploy credentials before running this
# inside or after a deploy:
#   eval "$(scripts/op-preflight.sh --agent <agent> --mode deploy)"
#
# That preflight exports GOOGLE_APPLICATION_CREDENTIALS pointing at the
# per-project Firebase-vault SERVICE-ACCOUNT key — which is exactly the
# credential this script wants, and exactly the one neither `gcloud` path could
# previously use. Two facts, both verified rather than assumed:
#
#   1. The key is the RIGHT identity. `scripts/firebase/op-firebase-setup`
#      grants the `firebase-deployer` SA `roles/run.admin` on the project, so
#      it is guaranteed to be able to describe and update these very services —
#      it is the identity that just deployed them and attempted the rejected
#      `allUsers` invoker binding in the first place.
#   2. Neither gcloud path can AUTHENTICATE from that env var.
#      `scripts/gcloud/gcloud` mints tokens from an `authorized_user` refresh
#      token and rejects a `service_account` file outright ("points to an
#      unusable credential file"). And bypassing that wrapper does not help:
#      the real gcloud CLI ignores GOOGLE_APPLICATION_CREDENTIALS for its own
#      auth — it is an ADC variable for client libraries, and
#      `googlecloudsdk/core/credentials/store.py` never reads it — so a bypass
#      would silently run as whatever account happens to be active, or as none.
#      The wrapper's rejection is a capability gap, not a security boundary
#      (its own comment says "fall back to gcloud"), but "bypass it" is not a
#      fix on its own.
#
# So this script takes the ONE path gcloud supports for a service-account key:
# `gcloud auth activate-service-account`, run against a THROWAWAY
# `CLOUDSDK_CONFIG` directory that is deleted on exit. The machine-global
# gcloud account selection, active configuration, and ADC file are never
# touched, and the deploy's own credential is reused rather than requiring a
# second, separately-maintained ADC.
#
# When GOOGLE_APPLICATION_CREDENTIALS is absent or holds an `authorized_user` /
# `impersonated_service_account` credential, nothing changes: the calls go
# through the wrapper exactly as before, because the wrapper handles those.

SERVICE=""
REGION=""
PROJECT=""
LABEL="Cloud Run"
VERIFY_HINT=""
SERVICE_ENV_HINT="the correct service name"
DRY_RUN=false
ALLOW_MISSING=false
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
INVOKER_ANNOTATION='run.googleapis.com/invoker-iam-disabled'
# `gcloud run services describe` has two observed missing-service diagnostics:
# the structured `NOT_FOUND` status and `Cannot find service [<name>]`. Match
# the latter's complete, bracketed gcloud phrase rather than a generic "not
# found" so a shell-level `gcloud: command not found` remains a fatal tooling
# error instead of being mistaken for a first deploy.
MISSING_SERVICE_PATTERN='NOT_FOUND|Cannot[[:space:]]+find[[:space:]]+service[[:space:]]+\['

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:?--service needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --verify-hint) VERIFY_HINT="${2:?--verify-hint needs a value}"; shift 2 ;;
    --service-env-hint) SERVICE_ENV_HINT="${2:?--service-env-hint needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --allow-missing) ALLOW_MISSING=true; shift ;;
    -h|--help) sed -n '3,103p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SERVICE" ]] || { echo "FAIL: --service is required" >&2; exit 2; }
[[ -n "$REGION" ]] || { echo "FAIL: --region is required" >&2; exit 2; }
[[ -n "$PROJECT" ]] || { echo "FAIL: --project is required" >&2; exit 2; }

SA_CONFIG_DIR=""
DESCRIBE_ERR=""
ACTIVATE_ERR=""
CREDENTIAL_MODE="the gcloud wrapper's own credential chain"

cleanup() {
  [[ -n "$DESCRIBE_ERR" && -f "$DESCRIBE_ERR" ]] && rm -f "$DESCRIBE_ERR"
  [[ -n "$ACTIVATE_ERR" && -f "$ACTIVATE_ERR" ]] && rm -f "$ACTIVATE_ERR"
  [[ -n "$SA_CONFIG_DIR" && -d "$SA_CONFIG_DIR" ]] && rm -rf "$SA_CONFIG_DIR"
  return 0
}
trap cleanup EXIT

# Env prefix applied to every gcloud call. Always non-empty (a bare `env`) so
# the array expansion is safe under bash 3.2 + `set -u`.
GCLOUD_ENV=(env)
run_gcloud() { "${GCLOUD_ENV[@]}" "$GCLOUD_BIN" "$@"; }

# A service-account key is the ONE credential type `scripts/gcloud/gcloud`
# refuses. Detected by the JSON `type` field. `"impersonated_service_account"`
# deliberately does NOT match — the leading quote in the pattern anchors on the
# whole value — because the wrapper unwraps that form to its authorized_user
# source and mints a token from it perfectly well.
credential_is_service_account() {
  local file="${1:-}"
  [[ -n "$file" && -f "$file" ]] || return 1
  grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$file" 2>/dev/null
}

# Resolve the credential BEFORE the first call (see § CREDENTIALS above).
#
# `GCLOUD_BYPASS_ADC_WRAPPER=1` is `scripts/gcloud/gcloud`'s own first-class
# passthrough — the wrapper sets it on every call it makes to the real binary.
# It is correct to use here precisely because we are supplying a BETTER
# credential than the wrapper could resolve, in an isolated config the wrapper
# knows nothing about. Using it without activating the key first would be the
# bug: gcloud would silently fall back to the machine's active account.
resolve_credential() {
  local key_file="${GOOGLE_APPLICATION_CREDENTIALS:-}"

  if ! credential_is_service_account "$key_file"; then
    return 0
  fi

  SA_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-gcloud-config-XXXXXX")"
  ACTIVATE_ERR="$(mktemp "${TMPDIR:-/tmp}/invoker-activate-XXXXXX")"

  if env GCLOUD_BYPASS_ADC_WRAPPER=1 CLOUDSDK_CONFIG="$SA_CONFIG_DIR" \
       CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
       CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true \
       "$GCLOUD_BIN" auth activate-service-account --key-file="$key_file" --quiet \
       >/dev/null 2>"$ACTIVATE_ERR"; then
    GCLOUD_ENV=(env
      GCLOUD_BYPASS_ADC_WRAPPER=1
      CLOUDSDK_CONFIG="$SA_CONFIG_DIR"
      CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true
    )
    CREDENTIAL_MODE="the deploy service-account key from GOOGLE_APPLICATION_CREDENTIALS (isolated gcloud config)"
    return 0
  fi

  # Activation failed (malformed key, gcloud too old, revoked key). Fall back
  # to the wrapper's own chain — but DROP the service-account key from the
  # child environment first, or the wrapper rejects it outright and this step
  # aborts a deploy that had nothing else wrong with it. Clearing the variable
  # for the gcloud child only is exactly what
  # docs/agents/deployment-process.md tells an operator to do by hand for
  # non-deploy gcloud work; doing it here removes the manual step.
  rm -rf "$SA_CONFIG_DIR"
  SA_CONFIG_DIR=""
  GCLOUD_ENV=(env -u GOOGLE_APPLICATION_CREDENTIALS)
  CREDENTIAL_MODE="the gcloud wrapper's own ADC chain (the deploy service-account key could not be activated)"
  echo "   Note: could not activate the deploy service-account key; falling back to the gcloud ADC chain." >&2
  sed 's/^/     /' "$ACTIVATE_ERR" >&2
}

echo ">> $LABEL invoker config: service=$SERVICE region=$REGION project=$PROJECT"
resolve_credential
echo "   Credential: $CREDENTIAL_MODE"

# Confirm the service exists before mutating anything — a wrong/renamed service
# should fail with a helpful list, not a confusing update error.
# gcloud's own stderr goes to a file rather than /dev/null: it is the one
# place the actual cause is written, and discarding it is what made a
# credential failure read as a naming failure. Kept OUT of the command
# substitution so a stray warning cannot end up inside `$current` and defeat
# the `== "true"` idempotence check below.
DESCRIBE_ERR="$(mktemp "${TMPDIR:-/tmp}/invoker-describe-XXXXXX")"

if ! current="$(run_gcloud run services describe "$SERVICE" \
      --region "$REGION" --project "$PROJECT" \
      --format="value(metadata.annotations[\"$INVOKER_ANNOTATION\"])" 2>"$DESCRIBE_ERR")"; then
  # --allow-missing (#768 r5 Codex P2): a missing-service describe on a
  # brand-new target is expected, not broken — the Cloud Run service does not exist
  # until the FIRST Functions deploy creates it, so a pre-publish check that
  # treats "absent" as fatal makes that first deploy impossible without
  # --skip-invoker. Narrow: only gcloud's structured NOT_FOUND status or its
  # complete `Cannot find service [<name>]` diagnostic qualifies (not a bare
  # "not found" — that also matches a shell-level "gcloud: command not found",
  # which is a real tooling failure and must stay fatal), and only when the
  # CALLER opted in. Every other describe failure — no credential,
  # PERMISSION_DENIED, a malformed key — falls through to the FAIL block
  # below exactly as before, so the credential check this step exists for is
  # not weakened.
  if [[ "$ALLOW_MISSING" == "true" ]] && grep -Eqi "$MISSING_SERVICE_PATTERN" "$DESCRIBE_ERR"; then
    echo "   Service '$SERVICE' does not exist yet in $REGION ($PROJECT) — expected on a" >&2
    echo "   first deploy (nothing has released Functions there yet). Not a failure:" >&2
    echo "   there is nothing to reconcile until the first Functions deploy creates it." >&2
    exit 0
  fi
  # `describe` fails for two unrelated reasons, and the older message named
  # only one of them ("set <VAR> to the correct name"), which sent an operator
  # hunting a renamed service when the real cause was an absent or expired
  # `gcloud` credential. That misdirection matters here because this script
  # runs inside a deploy: `gcloud` resolves its OWN credential chain, not the
  # temporary one `op-firebase-deploy` materializes and deletes on exit, so
  # "no credential" is the LIKELIER of the two. Print gcloud's own error and
  # name both causes.
  echo "FAIL: could not describe Cloud Run service '$SERVICE' in $REGION ($PROJECT)." >&2
  echo "      Credential used: $CREDENTIAL_MODE" >&2
  echo "      gcloud said:" >&2
  sed 's/^/        /' "$DESCRIBE_ERR" >&2
  echo "      Causes, likeliest first:" >&2
  echo "        1. No gcloud credential at all. gcloud does NOT inherit" >&2
  echo "           op-firebase-deploy's credential — that wrapper deletes its" >&2
  echo "           temporary key on exit. Load one and re-run:" >&2
  echo "             eval \"\$(scripts/op-preflight.sh --agent <agent> --mode deploy)\"" >&2
  echo "        2. A 403 means the identity lacks run.services.get on $PROJECT." >&2
  echo "           The project Firebase-vault SA key carries roles/run.admin when" >&2
  echo "           provisioned by scripts/firebase/op-firebase-setup, so a 403 on" >&2
  echo "           that credential means the grant is missing or the key belongs" >&2
  echo "           to a DIFFERENT project than $PROJECT." >&2
  echo "        3. A 404 means the service was renamed — or, on a brand-new target's" >&2
  echo "           first deploy, simply does not exist yet (pass --allow-missing to" >&2
  echo "           the pre-publish check to treat that as expected). Otherwise set" >&2
  echo "           $SERVICE_ENV_HINT and re-run." >&2
  echo "        4. \"points to an unusable credential file\" should no longer be" >&2
  echo "           reachable — this script activates a service-account key into an" >&2
  echo "           isolated gcloud config rather than handing it to the wrapper." >&2
  echo "           If you see it, GOOGLE_APPLICATION_CREDENTIALS holds something" >&2
  echo "           that is neither an authorized_user ADC nor a service-account key." >&2
  echo "      Services visible to this credential in $REGION ($PROJECT):" >&2
  run_gcloud run services list --project "$PROJECT" --region "$REGION" \
    --format='value(metadata.name)' 2>/dev/null >&2 ||
    echo "        (the list call failed too, which points at cause 1)" >&2
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
