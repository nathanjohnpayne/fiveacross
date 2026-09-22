#!/usr/bin/env bash
set -euo pipefail

# Capture publishable marketing screenshots of the real app over an
# emulator-seeded demo Event. See docs/app/marketing-screenshots.md.
#
# Usage:
#   scripts/marketing-shots.sh                     # Vacay Bingo chrome
#   HERO_EDITION=fiveacross scripts/marketing-shots.sh
#   scripts/marketing-shots.sh --grep "capture"     # args forward to Playwright
#
# Output: artifacts/marketing/*.png (gitignored — publish them by copying into
# whichever repo consumes them, not by committing them here).
#
# The emulator project id is `demo-`-prefixed, so a stray call can never reach a
# real Firebase project — the same posture scripts/test-e2e.sh takes. It differs
# from the e2e suite's id on purpose: this run CLEARS Firestore, and sharing an
# id would let a capture wipe a suite run's fixture out from under it.
#
# DO NOT RUN THIS CONCURRENTLY WITH `npm run test:e2e` (Codex P2 on #1020).
# A distinct project id namespaces the DATA, not the listening sockets: both
# runs read the fixed emulator ports from firebase.json (8080 Firestore, 9099
# Auth), and `firebase emulators:exec` exposes no per-invocation port override,
# so the second run dies on the occupied ports before Playwright starts. The
# web port (5184) and the build output (dist-marketing) are already separated;
# the emulator ports are the remaining shared resource, and unpicking them
# needs a second firebase config wired through the bundle. Run them in sequence.
PROJECT_ID='demo-fiveacross-marketing'

# The Firestore emulator is a Java program and `firebase emulators:exec` only
# looks on PATH, so this script needs the same JDK probe every other
# emulator-booting script runs — scripts/lib/ensure-java.sh (#1018). It used
# to carry its own inline copy, which had drifted: no JAVA_HOME, no
# /usr/libexec/java_home, and only openjdk@21 among the versioned kegs, so a
# Mac whose compatible JDK sat anywhere else failed a capture the shared
# helper would have rescued (Codex P1 on #1241). Sourced rather than executed
# because a PATH fix only reaches `firebase` from the shell that execs it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ensure-java.sh
source "$SCRIPT_DIR/lib/ensure-java.sh"
ensure_java

cmd="npx playwright test --config playwright.marketing.config.ts"
for arg in "$@"; do
  cmd+=" $(printf '%q' "$arg")"
done

# Auth + Firestore only: the fixture seeds no Storage objects, because a
# marketing shot must never carry a real photo proof.
npx firebase --non-interactive emulators:exec \
  --only auth,firestore --project "$PROJECT_ID" "$cmd"

echo
echo "Screenshots written to artifacts/marketing/:"
ls -1 artifacts/marketing 2>/dev/null || echo "  (none — the run produced no output)"
