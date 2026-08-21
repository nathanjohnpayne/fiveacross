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
# looks on PATH. Homebrew's openjdk is keg-only (never symlinked into
# /opt/homebrew/bin), so a shell that has never sourced it fails with
# "Unable to locate a Java Runtime" — prepend it when it is the one present.
#
# The probe RUNS java rather than testing `command -v`: macOS ships a
# /usr/bin/java stub that exists on PATH and exits 1, so a presence check
# passes on exactly the machines that have no JDK at all.
java_works() { java -version >/dev/null 2>&1; }
if ! java_works; then
  # Both Homebrew prefixes, versioned and unversioned: /opt/homebrew on Apple
  # silicon, /usr/local on Intel. `brew install openjdk` (no @21) is the common
  # form and lands on the unversioned path (Codex P2 on #1020).
  for jdk in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk \
             /usr/local/opt/openjdk@21 /usr/local/opt/openjdk; do
    if [[ -x "$jdk/bin/java" ]]; then
      PATH="$jdk/bin:$PATH"
      export PATH
      break
    fi
  done
fi
java_works || {
  echo "marketing-shots: no working Java runtime; the Firestore emulator needs one." >&2
  echo "  brew install openjdk@21" >&2
  exit 1
}

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
