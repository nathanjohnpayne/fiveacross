#!/usr/bin/env bash
set -euo pipefail

# `npm run emulator` entry point. A thin wrapper (rather than a raw
# `firebase emulators:start` one-liner in package.json) so this gets the
# same runnable-Java probe every emulator-booting script uses before
# handing off to firebase — see scripts/lib/ensure-java.sh (#1018). The
# probe has to run in THIS process, not a separate npm pre-hook, because a
# PATH fix only reaches firebase if it's set in the shell that execs it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ensure-java.sh
source "$SCRIPT_DIR/lib/ensure-java.sh"
ensure_java

exec firebase emulators:start --only auth,firestore,storage
