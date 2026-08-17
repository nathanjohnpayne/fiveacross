#!/usr/bin/env bash

# Shared credential primitive for Firebase deployment callers. The caller owns
# the returned temporary file and must remove it when its credential lifetime
# ends.

firebase_materialize_vault_sa_key() {
  local project="${1:-}"
  local tmpfile=""

  if [[ -z "$project" ]] || ! command -v op >/dev/null 2>&1; then
    return 1
  fi

  umask 077
  tmpfile="$(mktemp "${TMPDIR:-/tmp}/firebase-sa-XXXXXX")"

  if op document get "${project} — Firebase Deployer SA Key" \
       --vault Firebase --out-file "$tmpfile" --force >/dev/null 2>&1 \
     && [[ -s "$tmpfile" ]]; then
    printf '%s\n' "$tmpfile"
    return 0
  fi

  rm -f "$tmpfile"
  return 1
}
