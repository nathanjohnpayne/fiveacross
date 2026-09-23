#!/usr/bin/env bash
# scripts/lib/ensure-java.sh
#
# ensure_java — make sure a Java runtime that actually RUNS, at a major
# version firebase-tools still supports, is on PATH before any script boots
# a Firebase emulator (Firestore needs a JVM).
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
# Running it is still not enough, though: a runnable but OLD java is just a
# slower way to fail. firebase-tools pins the floor at major 21 —
# node_modules/firebase-tools/lib/emulator/commandUtils.js sets
# MIN_SUPPORTED_JAVA_MAJOR_VERSION = 21, and controller.js throws
# JAVA_DEPRECATION_WARNING ("firebase-tools no longer supports Java version
# before 21. Please install a JDK at version 21 or above...") below it — so
# a machine with java 17 on PATH and a 21 keg installed has a perfectly
# usable JDK that a runnability-only probe would step straight past. Every
# candidate below is therefore checked for BOTH: it must run, and it must
# report ENSURE_JAVA_MIN_MAJOR or newer. A rejected candidate is removed
# from PATH again before the next one is tried.
#
# Sourced, not executed: a PATH fix only helps the caller if it survives in
# the CALLING shell, so this file just defines ensure_java() and every
# emulator-booting script (scripts/test-e2e.sh, scripts/test-rules.sh,
# scripts/test-offline.sh, scripts/emulator.sh and
# scripts/marketing-shots.sh) sources it and calls ensure_java before
# handing off to `firebase`.
#
# Probe order, prepending the first one that runs AND is new enough:
#   1. the ambient PATH (no-op if this already works)
#   2. $JAVA_HOME/bin
#   3. `/usr/libexec/java_home -v <min>+` (macOS's own JDK locator)
#   4. Homebrew keg-only installs, under both prefixes (/opt/homebrew on
#      Apple silicon, /usr/local on Intel). The two common landing spots
#      come first — openjdk@21 and the unversioned (latest) openjdk, the
#      order scripts/marketing-shots.sh used before it moved onto this
#      helper — and a trailing openjdk*/bin wildcard catches a keg this
#      list does not name yet (a future openjdk@26, say). The wildcard
#      expands in collation order, so a stale openjdk@11 keg is reached
#      before a named-but-unlisted newer one; that is harmless now only
#      because the version check rejects the 11 and the loop keeps going.
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

# The floor firebase-tools enforces (see the header). Bumping this is the
# one edit needed when firebase-tools raises it again.
ENSURE_JAVA_MIN_MAJOR=21

# _ensure_java_major — print the major version of whichever `java` is first
# on PATH right now, or fail if it does not run or prints no parsable
# banner. `java -version` writes to stderr, hence the 2>&1.
_ensure_java_major() {
  local banner major
  banner="$(java -Duser.language=en -version 2>&1)" || return 1
  # The banner reads `openjdk version "21.0.8" 2025-07-15`. Take the digits
  # immediately after `version "` — the same field firebase-tools parses
  # with /version "([1-9][0-9]*)/. A pre-9 JDK reports "1.8.0_292", which
  # yields 1: below the floor, which is the correct verdict.
  major="$(printf '%s\n' "$banner" | awk -F'"' '
    seen == 0 && /version "/ {
      v = $2
      sub(/[^0-9].*/, "", v)
      if (v != "") { print v + 0; seen = 1 }
    }')"
  [ -n "$major" ] || return 1
  printf '%s\n' "$major"
}

# _ensure_java_ok — true when the `java` first on PATH both runs and meets
# the floor.
_ensure_java_ok() {
  local major
  major="$(_ensure_java_major)" || return 1
  [ "$major" -ge "$ENSURE_JAVA_MIN_MAJOR" ]
}

ensure_java() {
  if _ensure_java_ok; then
    return 0
  fi

  # Every candidate is tried by prepending it and re-probing; a candidate
  # that runs but is too old is unwound so it cannot shadow a later one or
  # linger on the caller's PATH after a successful probe.
  local original_path="$PATH"

  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
    PATH="${JAVA_HOME}/bin:${original_path}"
    export PATH
    if _ensure_java_ok; then
      return 0
    fi
    PATH="$original_path"
    export PATH
  fi

  local locator="${ENSURE_JAVA_HOME_LOCATOR:-/usr/libexec/java_home}"
  if [ -x "$locator" ]; then
    local resolved
    resolved="$("$locator" -v "${ENSURE_JAVA_MIN_MAJOR}+" 2>/dev/null || true)"
    if [ -n "$resolved" ] && [ -x "${resolved}/bin/java" ]; then
      PATH="${resolved}/bin:${original_path}"
      export PATH
      if _ensure_java_ok; then
        return 0
      fi
      PATH="$original_path"
      export PATH
    fi
  fi

  local kegs="${ENSURE_JAVA_KEG_GLOBS:-\
/opt/homebrew/opt/openjdk@21/bin /opt/homebrew/opt/openjdk/bin \
/usr/local/opt/openjdk@21/bin /usr/local/opt/openjdk/bin \
/opt/homebrew/opt/openjdk*/bin /usr/local/opt/openjdk*/bin}"
  local keg
  for keg in $kegs; do
    if [ -x "${keg}/java" ]; then
      PATH="${keg}:${original_path}"
      export PATH
      if _ensure_java_ok; then
        return 0
      fi
      PATH="$original_path"
      export PATH
    fi
  done

  echo "ensure_java: no usable Java runtime found (on every candidate, java -version either failed to run or reported a major below ${ENSURE_JAVA_MIN_MAJOR})." >&2
  echo "The Firestore emulator needs a JDK ${ENSURE_JAVA_MIN_MAJOR}+: firebase-tools refuses to start it on anything older." >&2
  echo "Install one from your platform's package manager or a vendor build such as Temurin (https://adoptium.net/temurin/releases/); on a Mac with Homebrew: brew install openjdk@21" >&2
  return 1
}
