#!/usr/bin/env bash
# Load the scoped upload credential through 1Password; never print or persist it.
set -euo pipefail
[[ "${1:-}" == -- ]] && shift
if [[ "$#" -eq 0 ]]; then echo 'Usage: with-posthog-sourcemaps.sh -- COMMAND [ARGS...]' >&2; exit 2; fi
POSTHOG_UPLOAD_OP_REF="${POSTHOG_UPLOAD_OP_REF:-op://iuzrzn5uhj3tgd4c3lollfvvka/lvnykakmgy4a6vjaibwda6gkoq/credential}"
if [[ -z "${POSTHOG_UPLOAD_OP_REF:-}" || "$POSTHOG_UPLOAD_OP_REF" != op://* ]]; then
  echo 'Set POSTHOG_UPLOAD_OP_REF to the scoped upload credential field in 1Password.' >&2
  exit 2
fi
# Do not fall back to a loose token or a different credential after any op failure.
unset POSTHOG_UPLOAD_API_KEY
POSTHOG_UPLOAD_API_KEY="$(op read "$POSTHOG_UPLOAD_OP_REF")"
[[ -n "$POSTHOG_UPLOAD_API_KEY" ]] || { echo '1Password returned an empty PostHog upload key.' >&2; exit 1; }
export POSTHOG_UPLOAD_API_KEY
exec "$@"
