#!/usr/bin/env bash
set -euo pipefail

# `npm run test:rules` entry point. A thin wrapper (rather than a raw
# `firebase emulators:exec` one-liner in package.json) so this suite gets
# the same runnable-Java probe every emulator-backed npm entry point uses
# handing off to firebase — see scripts/lib/ensure-java.sh (#1018). The
# probe has to run in THIS process, not a separate npm pre-hook, because a
# PATH fix only reaches firebase if it's set in the shell that execs it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ensure-java.sh
source "$SCRIPT_DIR/lib/ensure-java.sh"
ensure_java

# `firebase emulators:exec` takes ONE script string, so anything after
# `npm run test:rules --` used to land on emulators:exec itself rather than on
# the suite. Forward it into the inner vitest command instead — shell-quoted
# with printf %q, space-safe — so a targeted local run like
# `npm run test:rules -- tests/rules/d15-approvals.test.ts` reaches vitest
# intact, the way scripts/test-e2e.sh already does for Playwright. Without
# this the wrapper would swallow the arguments silently and run the whole
# suite as if none had been passed.
cmd="vitest run --config vitest.rules.config.ts"
for arg in "$@"; do
  cmd+=" $(printf '%q' "$arg")"
done

exec firebase emulators:exec --only firestore,storage "$cmd"
