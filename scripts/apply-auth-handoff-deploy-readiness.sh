#!/usr/bin/env bash
set -euo pipefail

# Pre-build Five Across auth-handoff readiness. This wrapper is intentionally
# narrower than the ordinary post-Functions reconciliation: it pins the exact
# deploy service-account identity and forces a real, idempotent update on both
# existing callables so run.services.update is exercised before a client build
# can ship.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/firebase/lib/credential-materialization.sh
source "$SCRIPT_DIR/firebase/lib/credential-materialization.sh"

PROJECT="${AUTH_HANDOFF_PROJECT:-fiveacross}"
EXPECTED_PROJECT="fiveacross"
EXPECTED_SERVICE_ACCOUNT="firebase-deployer@fiveacross.iam.gserviceaccount.com"
OWNED_CREDENTIAL=""

cleanup() {
  if [[ -n "$OWNED_CREDENTIAL" && -f "$OWNED_CREDENTIAL" ]]; then
    rm -f "$OWNED_CREDENTIAL"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$PROJECT" != "$EXPECTED_PROJECT" ]]; then
  echo "FAIL: auth-handoff deploy readiness requires AUTH_HANDOFF_PROJECT=$EXPECTED_PROJECT; got $PROJECT." >&2
  exit 1
fi

credential_is_exact_deployer() {
  local file="${1:-}"
  [[ -n "$file" && -f "$file" && -s "$file" ]] || return 1
  python3 - "$file" "$EXPECTED_SERVICE_ACCOUNT" <<'PY'
import json
import pathlib
import sys

try:
    credential = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception:
    sys.exit(1)

if credential.get("type") == "service_account" and credential.get("client_email") == sys.argv[2]:
    sys.exit(0)
sys.exit(1)
PY
}

SOURCE_CREDENTIAL="${GOOGLE_APPLICATION_CREDENTIALS:-}"
IMPERSONATE_SERVICE_ACCOUNT="$EXPECTED_SERVICE_ACCOUNT"

if [[ -n "$SOURCE_CREDENTIAL" && ! -f "$SOURCE_CREDENTIAL" ]]; then
  echo "FAIL: GOOGLE_APPLICATION_CREDENTIALS points to a missing file: $SOURCE_CREDENTIAL" >&2
  echo "Nothing has been built or published." >&2
  exit 1
fi

if credential_is_exact_deployer "$SOURCE_CREDENTIAL"; then
  # The operation already runs directly as the selected deploy SA. Asking that
  # account to impersonate itself would add an unnecessary tokenCreator grant.
  IMPERSONATE_SERVICE_ACCOUNT=""
elif [[ -z "$SOURCE_CREDENTIAL" ]]; then
  # Reuse the canonical Firebase deploy credential primitive before falling
  # back to the keyless gcloud source chain. Five Across is normally keyless,
  # but this also supports a project key if one is provisioned later.
  OWNED_CREDENTIAL="$(firebase_materialize_vault_sa_key "$PROJECT" || true)"
  if [[ -n "$OWNED_CREDENTIAL" ]]; then
    if ! credential_is_exact_deployer "$OWNED_CREDENTIAL"; then
      echo "FAIL: the Firebase-vault deploy credential is not $EXPECTED_SERVICE_ACCOUNT." >&2
      echo "Nothing has been built or published." >&2
      exit 1
    fi
    SOURCE_CREDENTIAL="$OWNED_CREDENTIAL"
    IMPERSONATE_SERVICE_ACCOUNT=""
  fi
fi

COMMON_ENV=(
  env
  -u AUTH_HANDOFF_REGION
  -u AUTH_HANDOFF_MINT_SERVICE
  -u AUTH_HANDOFF_EXCHANGE_SERVICE
)

if [[ -n "$SOURCE_CREDENTIAL" ]]; then
  "${COMMON_ENV[@]}" \
    "AUTH_HANDOFF_PROJECT=$PROJECT" \
    "GCLOUD_IMPERSONATE_SERVICE_ACCOUNT=$IMPERSONATE_SERVICE_ACCOUNT" \
    "GOOGLE_APPLICATION_CREDENTIALS=$SOURCE_CREDENTIAL" \
    "$SCRIPT_DIR/set-auth-handoff-invoker.sh" --prove-update
else
  "${COMMON_ENV[@]}" -u GOOGLE_APPLICATION_CREDENTIALS \
    "AUTH_HANDOFF_PROJECT=$PROJECT" \
    "GCLOUD_IMPERSONATE_SERVICE_ACCOUNT=$IMPERSONATE_SERVICE_ACCOUNT" \
    "$SCRIPT_DIR/set-auth-handoff-invoker.sh" --prove-update
fi
