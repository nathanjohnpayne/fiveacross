#!/usr/bin/env bash
# scripts/lib/ensure-java.sh
#
# ensure_java — make sure a Java runtime that actually RUNS is on PATH
# before any script boots a Firebase emulator (Firestore needs a JVM).
#
# The bug this exists for (#1018): on a Mac whose only JDK is Homebrew's,
# `java` still resolves via `command -v` because macOS ships a
# `/usr/bin/java` stub that exits 1 the moment it's actually invoked ("The
# operation couldn't be completed. Unable to locate a Java Runtime.").
# Homebrew's openjdk formulae are keg-only — never symlinked into
# /opt/homebrew/bin — so `brew install openjdk@21` alone does not put a
# working `java` on PATH either. A presence check (`command -v java`)
# therefore reports success on exactly the machines that have no runnable
# JDK; only running `java -version` tells the truth.
#
# Sourced, not executed: a PATH fix only helps the caller if it survives in
# the CALLING shell, so this file just defines ensure_java() and every
# emulator-backed npm entry point (scripts/test-e2e.sh,
# scripts/test-rules.sh, scripts/test-offline.sh, scripts/emulator.sh)
# sources it and calls ensure_java before handing off to `firebase`.
# scripts/marketing-shots.sh boots an emulator too, but it is not an npm
# script and still carries its own equivalent inline probe — it is the one
# remaining standalone copy, so a change here does NOT reach it.
#
# Probe order, prepending the first one that actually runs `java -version`:
#   1. the ambient PATH (no-op if this already works)
#   2. $JAVA_HOME/bin
#   3. `/usr/libexec/java_home -v 17+` (macOS's own JDK locator)
#   4. Homebrew keg-only installs, under both prefixes (/opt/homebrew on
#      Apple silicon, /usr/local on Intel). The named 17+ kegs come first:
#      the order scripts/marketing-shots.sh already uses (openjdk@21, then
#      the unversioned — latest — openjdk), extended with openjdk@17, the
#      floor the locator call and the failure message state. Naming them
#      is what keeps a machine that has BOTH a stale openjdk@11 keg and a
#      named 17+ one off the 11: a bare openjdk*/bin glob expands in
#      collation order, so 11 would win. The trailing openjdk*/bin
#      wildcard is a deliberate last resort for a keg this list does not
#      name yet (a future openjdk@25, say); every named keg is tried
#      first.
#
# Env overrides (test seams — tests/test_ensure_java.sh points these at a
# fake locator/keg tree under a tmp dir so no real system state is
# touched; production uses the defaults):
#   ENSURE_JAVA_HOME_LOCATOR  path to the java_home locator binary
#                             (default: /usr/libexec/java_home)
#   ENSURE_JAVA_KEG_GLOBS     space-separated bin-dir globs to probe, in
#                             preference order (default: the Homebrew keg
#                             paths above)
#
# Bash 3.2 portable.

set -euo pipefail

ensure_java() {
  if java -version >/dev/null 2>&1; then
    return 0
  fi

  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
    PATH="${JAVA_HOME}/bin:${PATH}"
    export PATH
    if java -version >/dev/null 2>&1; then
      return 0
    fi
  fi

  local locator="${ENSURE_JAVA_HOME_LOCATOR:-/usr/libexec/java_home}"
  if [ -x "$locator" ]; then
    local resolved
    resolved="$("$locator" -v 17+ 2>/dev/null || true)"
    if [ -n "$resolved" ] && [ -x "${resolved}/bin/java" ]; then
      PATH="${resolved}/bin:${PATH}"
      export PATH
      if java -version >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  local kegs="${ENSURE_JAVA_KEG_GLOBS:-\
/opt/homebrew/opt/openjdk@21/bin /opt/homebrew/opt/openjdk/bin /opt/homebrew/opt/openjdk@17/bin \
/usr/local/opt/openjdk@21/bin /usr/local/opt/openjdk/bin /usr/local/opt/openjdk@17/bin \
/opt/homebrew/opt/openjdk*/bin /usr/local/opt/openjdk*/bin}"
  local keg
  for keg in $kegs; do
    if [ -x "${keg}/java" ]; then
      PATH="${keg}:${PATH}"
      export PATH
      if java -version >/dev/null 2>&1; then
        return 0
      fi
    fi
  done

  echo "ensure_java: no working Java runtime found (java -version failed on every candidate)." >&2
  echo "The Firestore emulator needs a JDK 17+. Install one with: brew install openjdk@21" >&2
  return 1
}
