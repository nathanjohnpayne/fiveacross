#!/usr/bin/env bash

# Shared credential primitive for Firebase deployment callers. The caller owns
# the returned temporary file and must remove it when its credential lifetime
# ends.
#
# The default contract is intentionally backward-compatible: every lookup miss
# returns 1 without exposing `op` stderr, so the ordinary Firebase deploy chain
# may continue through its established credential fallbacks. Safety-critical
# callers may pass `--classify-absence`; in that mode status 1 means the item is
# explicitly absent, while status 2 means authentication or infrastructure
# failed before absence could be established. The latter emits only a generic
# diagnostic because 1Password errors can contain account or vault details.

firebase_materialize_vault_sa_key() (
  local project="${1:-}"
  local failure_mode="${2:-}"
  local tmpfile=""
  local error_file=""

  cleanup_interrupted_materialization() {
    [[ -n "$tmpfile" ]] && rm -f "$tmpfile" >/dev/null 2>&1
    [[ -n "$error_file" ]] && rm -f "$error_file" >/dev/null 2>&1
  }
  trap 'cleanup_interrupted_materialization; exit 129' HUP
  trap 'cleanup_interrupted_materialization; exit 130' INT
  trap 'cleanup_interrupted_materialization; exit 143' TERM

  if [[ "$failure_mode" != "" && "$failure_mode" != "--classify-absence" ]]; then
    return 2
  fi

  if [[ -z "$project" ]] || ! command -v op >/dev/null 2>&1; then
    if [[ "$failure_mode" == "--classify-absence" ]]; then
      echo "FAIL: could not establish that the Firebase-vault deploy key is absent." >&2
      return 2
    fi
    return 1
  fi

  umask 077
  if ! tmpfile="$(mktemp "${TMPDIR:-/tmp}/firebase-sa-XXXXXX" 2>/dev/null)"; then
    if [[ "$failure_mode" == "--classify-absence" ]]; then
      echo "FAIL: could not prepare Firebase-vault credential materialization." >&2
      return 2
    fi
    return 1
  fi
  if ! error_file="$(mktemp "${TMPDIR:-/tmp}/firebase-sa-error-XXXXXX" 2>/dev/null)"; then
    rm -f "$tmpfile" >/dev/null 2>&1 || true
    if [[ "$failure_mode" == "--classify-absence" ]]; then
      echo "FAIL: could not prepare Firebase-vault credential materialization." >&2
      return 2
    fi
    return 1
  fi

  if op document get "${project} — Firebase Deployer SA Key" \
       --vault Firebase --out-file "$tmpfile" --force >/dev/null 2>"$error_file" \
     && [[ -s "$tmpfile" ]]; then
    rm -f "$error_file"
    error_file=""
    printf '%s\n' "$tmpfile"
    return 0
  fi

  rm -f "$tmpfile"
  tmpfile=""
  if [[ "$failure_mode" == "--classify-absence" ]]; then
    if grep -Eiq \
      "isn't an (item|document) in (the )?.*vault|(item|document) .* (was )?not found in (the )?.*vault|could not find (item|document) .* in (the )?.*vault|does not exist in (the )?.*vault" \
      "$error_file"; then
      rm -f "$error_file"
      return 1
    fi
    rm -f "$error_file"
    echo "FAIL: could not establish that the Firebase-vault deploy key is absent." >&2
    return 2
  fi

  rm -f "$error_file"
  return 1
)
