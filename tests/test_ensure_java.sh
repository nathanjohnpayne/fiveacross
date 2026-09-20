#!/usr/bin/env bash
# tests/test_ensure_java.sh
#
# Unit tests for scripts/lib/ensure-java.sh ensure_java (#1018).
#
# The headline contract this nails down: presence on PATH is not enough.
# macOS ships a `/usr/bin/java` stub that a plain `command -v java` finds
# but that exits 1 the moment it's actually run, and Homebrew's openjdk
# formulae are keg-only (never symlinked onto PATH), so a machine can have
# a perfectly good JDK installed and still fail every presence check.
# ensure_java has to probe by RUNNING java, and — when the ambient one
# fails — find a working JDK via JAVA_HOME, macOS's own java_home locator,
# or a Homebrew keg, in that order, and prepend it to PATH.
#
# Strategy: PATH-shim fake `java` binaries (one that runs, one that mimics
# the failing stub) plus test-seam env overrides (ENSURE_JAVA_HOME_LOCATOR,
# ENSURE_JAVA_KEG_GLOBS) so every branch is exercised against a synthetic
# tree under a tmp dir — no real system state is touched, and the tests
# pass identically whether or not this machine actually has a keg-only JDK.
#
# Bash 3.2 portable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/lib/ensure-java.sh"

[ -r "$LIB" ] || { echo "missing $LIB" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ensure-java-test.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

# make_java DIR OK — writes DIR/java: exits 0 (a real JDK) if OK=1, or
# mimics the macOS /usr/bin/java stub (exits 1, names the wrong problem)
# if OK=0.
make_java() {
  dir="$1"; ok="$2"
  mkdir -p "$dir"
  if [ "$ok" = "1" ]; then
    cat >"$dir/java" <<'STUB'
#!/usr/bin/env bash
echo "openjdk version \"21.0.12\" 2026-fake" >&2
exit 0
STUB
  else
    cat >"$dir/java" <<'STUB'
#!/usr/bin/env bash
echo "The operation couldn't be completed. Unable to locate a Java Runtime." >&2
exit 1
STUB
  fi
  chmod +x "$dir/java"
}

# ---------------------------------------------------------------------------
# Test 1: ambient PATH already has a working java — ensure_java is a no-op
# and does not need JAVA_HOME, the locator, or a keg at all.
# ---------------------------------------------------------------------------
echo "--- Test 1: ambient java already works → no-op success"
AMBIENT="$WORKDIR/t1-ambient"; make_java "$AMBIENT" 1
set +e
OUT=$(
  PATH="$AMBIENT:$PATH"
  unset JAVA_HOME ENSURE_JAVA_HOME_LOCATOR ENSURE_JAVA_KEG_GLOBS
  . "$LIB"
  ensure_java && echo "PATH_HEAD=${PATH%%:*}"
)
RC=$?
set -e
if [ "$RC" = 0 ] && [ "$OUT" = "PATH_HEAD=$AMBIENT" ]; then
  pass "ambient java accepted, PATH left untouched"
else
  fail "expected rc=0 PATH_HEAD=$AMBIENT; got rc=$RC out=[$OUT]"
fi

# ---------------------------------------------------------------------------
# Test 2 (the #1018 regression): ambient PATH has only the failing stub
# (macOS /usr/bin/java), but JAVA_HOME points at a working JDK. A presence
# check would report the stub as "found"; ensure_java must actually run it,
# see it fail, and fall through to JAVA_HOME.
# ---------------------------------------------------------------------------
echo "--- Test 2: stub on ambient PATH, JAVA_HOME has a working JDK"
STUB1="$WORKDIR/t2-stub"; make_java "$STUB1" 0
JH="$WORKDIR/t2-javahome"; make_java "$JH/bin" 1
set +e
OUT=$(
  PATH="$STUB1:$PATH"
  JAVA_HOME="$JH"
  export JAVA_HOME
  unset ENSURE_JAVA_HOME_LOCATOR ENSURE_JAVA_KEG_GLOBS
  . "$LIB"
  ensure_java && echo "PATH_HEAD=${PATH%%:*}"
)
RC=$?
set -e
if [ "$RC" = 0 ] && [ "$OUT" = "PATH_HEAD=$JH/bin" ]; then
  pass "failing stub on PATH is not trusted; JAVA_HOME/bin found and prepended"
else
  fail "expected rc=0 PATH_HEAD=$JH/bin; got rc=$RC out=[$OUT]"
fi

# ---------------------------------------------------------------------------
# Test 3: no JAVA_HOME, but the java_home locator (macOS's own JDK finder)
# resolves to a working JDK.
# ---------------------------------------------------------------------------
echo "--- Test 3: no JAVA_HOME, java_home locator resolves a working JDK"
STUB2="$WORKDIR/t3-stub"; make_java "$STUB2" 0
LOCATOR_HOME="$WORKDIR/t3-jdkhome"; make_java "$LOCATOR_HOME/bin" 1
LOCATOR="$WORKDIR/t3-java_home"
cat >"$LOCATOR" <<STUB
#!/usr/bin/env bash
echo "$LOCATOR_HOME"
STUB
chmod +x "$LOCATOR"
set +e
OUT=$(
  PATH="$STUB2:$PATH"
  unset JAVA_HOME
  ENSURE_JAVA_HOME_LOCATOR="$LOCATOR"
  export ENSURE_JAVA_HOME_LOCATOR
  unset ENSURE_JAVA_KEG_GLOBS
  . "$LIB"
  ensure_java && echo "PATH_HEAD=${PATH%%:*}"
)
RC=$?
set -e
if [ "$RC" = 0 ] && [ "$OUT" = "PATH_HEAD=$LOCATOR_HOME/bin" ]; then
  pass "java_home locator resolved and its bin/ prepended"
else
  fail "expected rc=0 PATH_HEAD=$LOCATOR_HOME/bin; got rc=$RC out=[$OUT]"
fi

# ---------------------------------------------------------------------------
# Test 4 (the exact #1018 scenario): no JAVA_HOME, the locator fails to
# resolve anything, but a Homebrew keg-only openjdk is present. This is the
# reported machine shape — brew install openjdk@21 without linking it.
# ---------------------------------------------------------------------------
echo "--- Test 4: keg-only Homebrew openjdk found when JAVA_HOME/locator give nothing"
STUB3="$WORKDIR/t4-stub"; make_java "$STUB3" 0
KEG="$WORKDIR/t4-opt-homebrew/opt/openjdk@21/bin"; make_java "$KEG" 1
DEAD_LOCATOR="$WORKDIR/t4-dead-java_home"
cat >"$DEAD_LOCATOR" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$DEAD_LOCATOR"
set +e
OUT=$(
  PATH="$STUB3:$PATH"
  unset JAVA_HOME
  ENSURE_JAVA_HOME_LOCATOR="$DEAD_LOCATOR"
  ENSURE_JAVA_KEG_GLOBS="$WORKDIR/t4-opt-homebrew/opt/openjdk*/bin $WORKDIR/t4-usr-local/opt/openjdk*/bin"
  export ENSURE_JAVA_HOME_LOCATOR ENSURE_JAVA_KEG_GLOBS
  . "$LIB"
  ensure_java && echo "PATH_HEAD=${PATH%%:*}"
)
RC=$?
set -e
if [ "$RC" = 0 ] && [ "$OUT" = "PATH_HEAD=$KEG" ]; then
  pass "keg-only openjdk located via the glob and prepended"
else
  fail "expected rc=0 PATH_HEAD=$KEG; got rc=$RC out=[$OUT]"
fi

# ---------------------------------------------------------------------------
# Test 5: nothing works anywhere — ensure_java fails closed and names the
# actual problem plus the fix, instead of leaving firebase to print a
# generic PATH complaint.
# ---------------------------------------------------------------------------
echo "--- Test 5: no working JDK anywhere → fails with an actionable message"
STUB4="$WORKDIR/t5-stub"; make_java "$STUB4" 0
DEAD_LOCATOR2="$WORKDIR/t5-dead-java_home"
cat >"$DEAD_LOCATOR2" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$DEAD_LOCATOR2"
set +e
ERR=$(
  PATH="$STUB4:$PATH"
  unset JAVA_HOME
  ENSURE_JAVA_HOME_LOCATOR="$DEAD_LOCATOR2"
  ENSURE_JAVA_KEG_GLOBS="$WORKDIR/t5-nowhere/openjdk*/bin"
  export ENSURE_JAVA_HOME_LOCATOR ENSURE_JAVA_KEG_GLOBS
  . "$LIB"
  ensure_java 2>&1
)
RC=$?
set -e
case "$ERR" in
  *"brew install openjdk@21"*) MSG_OK=1 ;;
  *) MSG_OK=0 ;;
esac
if [ "$RC" != 0 ] && [ "$MSG_OK" = 1 ]; then
  pass "fails closed (rc=$RC) and names the install fix"
else
  fail "expected non-zero rc with an openjdk@21 install hint; got rc=$RC err=[$ERR]"
fi

echo
echo "test_ensure_java: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
