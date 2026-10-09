#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/firebase/lib/credential-materialization.sh"
TARGET="${1:?A registered deploy target is required.}"
[[ $# -eq 1 ]] || exit 1
PROJECT="$(node "$SCRIPT_DIR/proof-media-cors.mjs" "$TARGET" --project)"
OWNED_CREDENTIAL=""
cleanup() { [[ -z "$OWNED_CREDENTIAL" ]] || rm -f "$OWNED_CREDENTIAL"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  OWNED_CREDENTIAL="$(firebase_materialize_vault_sa_key "$PROJECT" --classify-absence)" || {
    echo 'Proof-media CORS requires attended deploy preflight or the project Firebase-vault deploy key.' >&2
    exit 1
  }
  export GOOGLE_APPLICATION_CREDENTIALS="$OWNED_CREDENTIAL"
fi
node "$SCRIPT_DIR/proof-media-cors.mjs" "$TARGET"
