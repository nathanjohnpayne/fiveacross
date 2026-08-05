#!/usr/bin/env bash
# tests/test_deploy.sh
#
# Unit tests for scripts/deploy.sh. Covers the two guards added /
# tightened by mergepath#286:
#
#   1. Strict-bash BUILD_CMD invocation.
#      The script must run BUILD_CMD under `bash -euo pipefail -c --`
#      rather than plain `bash -c --`. The regression case is a
#      compound command like `false; echo should-not-run`: the old
#      form returns 0 (last segment succeeds), masking the failure;
#      the strict form aborts on `false`. We assert non-zero exit AND
#      that the second segment never wrote its stdout.
#
#   2. Clean-working-tree guard.
#      With a dirty fixture worktree, the script must exit non-zero,
#      print the dirty-tree diagnostic, and list the modified path.
#      With DEPLOY_ALLOW_DIRTY=1, the same dirty fixture must allow
#      the deploy to proceed (we assert by reaching the shimmed
#      op-firebase-deploy step).
#
# Strategy: build a self-contained fixture git repo per test, run
# scripts/deploy.sh inside it with --force (to bypass guards 1+2 —
# branch + freshness — which depend on `origin/main` we don't want
# to set up) and --skip-cf-purge. Where the test needs the script
# to reach the deploy step, PATH-shim `op-firebase-deploy` so the
# script's `op-firebase-deploy "${DEPLOY_ARGS[@]}"` succeeds.
#
# Bash 3.2 portable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/deploy.sh"

[[ -x "$SCRIPT" ]] || { echo "missing or non-executable $SCRIPT" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/test-deploy.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Build a PATH shim that supplies a stub `op-firebase-deploy` so the
# script can reach its deploy step in success cases. The shim records
# its invocation to a per-test log so we can assert reachability.
# ---------------------------------------------------------------------------
STUB_DIR="$WORKDIR/stub-bin"
mkdir -p "$STUB_DIR"

cat >"$STUB_DIR/op-firebase-deploy" <<'STUB'
#!/usr/bin/env bash
echo "stub-op-firebase-deploy: invoked with args: $*" >&2
: "${OFD_LOG:?OFD_LOG must be set by the test}"
{
  printf 'op-firebase-deploy'
  for a in "$@"; do printf '\t%s' "$a"; done
  printf '\n'
} >> "$OFD_LOG"
exit 0
STUB
chmod +x "$STUB_DIR/op-firebase-deploy"

# Stub `npm` so the post-deploy synthetic step (issue #142) is exercised without
# a real app / Playwright. Records each invocation to NPM_LOG and exits with
# NPM_STUB_EXIT (default 0) so a test can simulate the synthetic passing or
# failing.
cat >"$STUB_DIR/npm" <<'STUB'
#!/usr/bin/env bash
: "${NPM_LOG:?NPM_LOG must be set by the test}"
{
  printf 'npm'
  for a in "$@"; do printf '\t%s' "$a"; done
  printf '\n'
} >> "$NPM_LOG"
exit "${NPM_STUB_EXIT:-0}"
STUB
chmod +x "$STUB_DIR/npm"

# Stub `npx` so the pre-deploy Chromium-ensure step (issue #142) is exercised
# without a real Playwright install. Logs to NPX_LOG when set and exits with
# NPX_STUB_EXIT (default 0) so a test can simulate the browser install failing.
cat >"$STUB_DIR/npx" <<'STUB'
#!/usr/bin/env bash
if [ -n "${NPX_LOG:-}" ]; then
  {
    printf 'npx'
    for a in "$@"; do printf '\t%s' "$a"; done
    printf '\n'
  } >> "$NPX_LOG"
fi
exit "${NPX_STUB_EXIT:-0}"
STUB
chmod +x "$STUB_DIR/npx"

# Helper: build a throwaway git repo on a non-main branch with one
# committed file. Caller sets the working dir's dirty/clean state.
init_fixture_repo() {
  local repo="$1"
  mkdir -p "$repo"
  (
    cd "$repo"
    git init --quiet -b feature/deploy-test
    git config user.email "test@example.com"
    git config user.name "Test"
    git config commit.gpgsign false
    echo "initial" > README.md
    git add README.md
    git commit --quiet -m "initial"
  )
}

# Run scripts/deploy.sh inside a fixture repo with sensible defaults.
# Args after `--` are passed to the script.
run_deploy() {
  local repo="$1"; shift
  (
    cd "$repo"
    PATH="$STUB_DIR:$PATH" \
      OFD_LOG="$WORKDIR/ofd-calls.log" \
      bash "$SCRIPT" "$@"
  )
}

# ---------------------------------------------------------------------------
# Case 1: BUILD_CMD='false; echo should-not-run' fails closed under
# strict-bash invocation.
# ---------------------------------------------------------------------------
REPO1="$WORKDIR/case1-strict-bash"
init_fixture_repo "$REPO1"
OUT1="$WORKDIR/case1.out"
ERR1="$WORKDIR/case1.err"
: >"$WORKDIR/ofd-calls.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls.log" \
BUILD_CMD='false; echo should-not-run' \
  bash -c "cd '$REPO1' && bash '$SCRIPT' --force --skip-cf-purge --skip-synthetic" \
  >"$OUT1" 2>"$ERR1"
RC1=$?
set -e

if [[ $RC1 -eq 0 ]]; then
  fail "strict-bash: deploy.sh returned 0 with BUILD_CMD='false; echo should-not-run' — the OLD masking behavior is still live."
# Grep only for a LINE that is exactly 'should-not-run' (the
# `echo should-not-run` output), not any line containing the
# string — the script's own `>> Building: false; echo should-not-run`
# diagnostic echoes BUILD_CMD itself and would false-positive a
# substring match.
elif grep -qE '^should-not-run$' "$OUT1" "$ERR1" 2>/dev/null; then
  fail "strict-bash: deploy.sh ran the second segment of the compound command (output contains a bare 'should-not-run' line). Strict-bash should abort on 'false'."
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls.log"; then
  fail "strict-bash: deploy.sh reached the op-firebase-deploy step despite the failing build — build failure was masked."
else
  pass "strict-bash: compound BUILD_CMD with leading false fails closed (rc=$RC1, no bare 'should-not-run' line, no deploy)."
fi

# ---------------------------------------------------------------------------
# Case 2: Clean-working-tree guard rejects a dirty fixture worktree.
# ---------------------------------------------------------------------------
REPO2="$WORKDIR/case2-dirty-tree"
init_fixture_repo "$REPO2"
# Introduce a dirty edit so git status --porcelain reports a modified path.
echo "uncommitted change" >> "$REPO2/README.md"

OUT2="$WORKDIR/case2.out"
ERR2="$WORKDIR/case2.err"
: >"$WORKDIR/ofd-calls.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls.log" \
  bash -c "cd '$REPO2' && bash '$SCRIPT' --force --skip-cf-purge --skip-synthetic --skip-build" \
  >"$OUT2" 2>"$ERR2"
RC2=$?
set -e

if [[ $RC2 -eq 0 ]]; then
  fail "dirty-tree: deploy.sh returned 0 from a dirty worktree. Guard 3 missing or non-enforcing."
elif ! grep -q 'working tree is dirty' "$ERR2"; then
  fail "dirty-tree: deploy.sh exited non-zero (rc=$RC2) but did not print the 'working tree is dirty' diagnostic to stderr. stderr was:"
  cat "$ERR2" >&2
elif ! grep -q 'README.md' "$ERR2"; then
  fail "dirty-tree: deploy.sh did not list the modified path (README.md) in its diagnostic. stderr was:"
  cat "$ERR2" >&2
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls.log"; then
  fail "dirty-tree: deploy.sh reached the op-firebase-deploy step from a dirty worktree."
else
  pass "dirty-tree: deploy.sh exits non-zero with a clear diagnostic and the dirty paths listed (rc=$RC2)."
fi

# ---------------------------------------------------------------------------
# Case 3: DEPLOY_ALLOW_DIRTY=1 break-glass override lets the dirty
# fixture worktree deploy. We use --skip-build so the test doesn't
# depend on `npm` being installed, and check that the shimmed
# op-firebase-deploy was reached.
# ---------------------------------------------------------------------------
REPO3="$WORKDIR/case3-allow-dirty"
init_fixture_repo "$REPO3"
echo "another uncommitted change" >> "$REPO3/README.md"

OUT3="$WORKDIR/case3.out"
ERR3="$WORKDIR/case3.err"
: >"$WORKDIR/ofd-calls.log"

set +e
# Pass trailing args through `--` (`--only hosting`) to exercise the
# non-empty DEPLOY_ARGS path. The empty-DEPLOY_ARGS path is exercised
# separately in Case 4 below (#286 r3 regression).
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls.log" \
DEPLOY_ALLOW_DIRTY=1 \
  bash -c "cd '$REPO3' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- --only hosting" \
  >"$OUT3" 2>"$ERR3"
RC3=$?
set -e

if [[ $RC3 -ne 0 ]]; then
  fail "allow-dirty: deploy.sh returned $RC3 with DEPLOY_ALLOW_DIRTY=1 from a dirty worktree. Override is broken. stderr was:"
  cat "$ERR3" >&2
elif ! grep -q 'DEPLOY_ALLOW_DIRTY=1' "$ERR3"; then
  fail "allow-dirty: deploy.sh did not log the DEPLOY_ALLOW_DIRTY=1 override banner to stderr. stderr was:"
  cat "$ERR3" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls.log"; then
  fail "allow-dirty: deploy.sh did not reach the op-firebase-deploy step despite the override."
else
  pass "allow-dirty: DEPLOY_ALLOW_DIRTY=1 override permits deploy, logs the banner, reaches the deploy step."
fi

# ---------------------------------------------------------------------------
# Case 4 (#286 r3 — nathanpayne-codex Phase 4b finding): empty
# DEPLOY_ARGS must NOT trip the bash 3.2 unbound-variable abort.
# Invoke `deploy.sh --force --skip-build --skip-cf-purge` with NO
# trailing `-- <args>`; the script reaches the op-firebase-deploy
# step with DEPLOY_ARGS=(). Pre-fix: aborts with `DEPLOY_ARGS[@]:
# unbound variable`. Post-fix: expansion is `${ARR[@]+"${ARR[@]}"}`
# which is empty-safe under `set -u`.
# ---------------------------------------------------------------------------
REPO4="$WORKDIR/case4-empty-args-repo"
mkdir -p "$REPO4"
( cd "$REPO4" && git init -q -b main && git config user.email a@b.c && git config user.name a && \
  echo init >README.md && git add README.md && git commit -q -m init )

OUT4="$WORKDIR/case4.out"
ERR4="$WORKDIR/case4.err"
: >"$WORKDIR/ofd-calls-4.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-4.log" \
  bash -c "cd '$REPO4' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT4" 2>"$ERR4"
RC4=$?
set -e

if grep -q 'unbound variable' "$ERR4" 2>/dev/null; then
  fail "empty-args: deploy.sh aborted with 'unbound variable' (#286 r3 regression)."
  cat "$ERR4" >&2
elif [[ $RC4 -ne 0 ]]; then
  fail "empty-args: deploy.sh returned $RC4 (expected 0). stderr was:"
  cat "$ERR4" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-4.log"; then
  fail "empty-args: deploy.sh did not reach the op-firebase-deploy step."
  cat "$ERR4" >&2
else
  pass "empty-args: deploy.sh with no trailing DEPLOY_ARGS reaches op-firebase-deploy without unbound-variable abort"
fi

# ---------------------------------------------------------------------------
# Case 5 (#142): the post-deploy synthetic runs by default and the deploy
# completes when it passes. The `npm` stub records `run … test:synthetic`.
# ---------------------------------------------------------------------------
REPO5="$WORKDIR/case5-synthetic-runs"
init_fixture_repo "$REPO5"
OUT5="$WORKDIR/case5.out"
ERR5="$WORKDIR/case5.err"
: >"$WORKDIR/ofd-calls-5.log"
: >"$WORKDIR/npm-calls-5.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-5.log" \
NPM_LOG="$WORKDIR/npm-calls-5.log" \
  bash -c "cd '$REPO5' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT5" 2>"$ERR5"
RC5=$?
set -e

if [[ $RC5 -ne 0 ]]; then
  fail "synthetic-runs: deploy.sh returned $RC5 though the stubbed synthetic passed. stderr was:"
  cat "$ERR5" >&2
elif ! grep -q 'test:synthetic' "$WORKDIR/npm-calls-5.log"; then
  fail "synthetic-runs: deploy.sh did not invoke the post-deploy synthetic (npm run test:synthetic)."
else
  pass "synthetic-runs: deploy.sh runs the post-deploy synthetic and completes when it passes."
fi

# ---------------------------------------------------------------------------
# Case 6 (#142): --skip-synthetic skips the step — logs the skip line and
# never invokes `npm run test:synthetic`.
# ---------------------------------------------------------------------------
REPO6="$WORKDIR/case6-synthetic-skip"
init_fixture_repo "$REPO6"
OUT6="$WORKDIR/case6.out"
ERR6="$WORKDIR/case6.err"
: >"$WORKDIR/ofd-calls-6.log"
: >"$WORKDIR/npm-calls-6.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-6.log" \
NPM_LOG="$WORKDIR/npm-calls-6.log" \
  bash -c "cd '$REPO6' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT6" 2>"$ERR6"
RC6=$?
set -e

if [[ $RC6 -ne 0 ]]; then
  fail "synthetic-skip: deploy.sh returned $RC6 with --skip-synthetic. stderr was:"
  cat "$ERR6" >&2
elif grep -q 'test:synthetic' "$WORKDIR/npm-calls-6.log"; then
  fail "synthetic-skip: deploy.sh ran the synthetic despite --skip-synthetic."
elif ! grep -q 'synthetic skipped' "$OUT6"; then
  fail "synthetic-skip: deploy.sh did not log the skip line. stdout was:"
  cat "$OUT6" >&2
else
  pass "synthetic-skip: --skip-synthetic skips the synthetic and logs the skip line."
fi

# ---------------------------------------------------------------------------
# Case 7 (#142): a failing synthetic fails the deploy (non-zero) and prints
# the rollback guidance. NPM_STUB_EXIT=1 makes the stubbed synthetic fail.
#
# It must ALSO tell the operator to confirm the outage before rolling back. A
# synthetic failure is not proof the release is broken — the probe itself can
# fail (2026-08-05: the mount assertion hardcoded the `gcb` wordmark, so a
# healthy Vacay-Edition deploy failed it and this banner told the operator to
# roll back a good release two days before the event). The rollback path stays,
# the unconditional instruction to take it does not.
# ---------------------------------------------------------------------------
REPO7="$WORKDIR/case7-synthetic-fail"
init_fixture_repo "$REPO7"
OUT7="$WORKDIR/case7.out"
ERR7="$WORKDIR/case7.err"
: >"$WORKDIR/ofd-calls-7.log"
: >"$WORKDIR/npm-calls-7.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-7.log" \
NPM_LOG="$WORKDIR/npm-calls-7.log" \
NPM_STUB_EXIT=1 \
  bash -c "cd '$REPO7' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT7" 2>"$ERR7"
RC7=$?
set -e

if [[ $RC7 -eq 0 ]]; then
  fail "synthetic-fail: deploy.sh returned 0 though the synthetic failed."
elif ! grep -q 'synthetic FAILED' "$ERR7"; then
  fail "synthetic-fail: deploy.sh did not print the synthetic-failure diagnostic. stderr was:"
  cat "$ERR7" >&2
elif ! grep -q 'Rollback' "$ERR7"; then
  fail "synthetic-fail: deploy.sh failure diagnostic did not point at the rollback. stderr was:"
  cat "$ERR7" >&2
elif ! grep -q 'CONFIRM BEFORE ROLLING BACK' "$ERR7"; then
  fail "synthetic-fail: deploy.sh failure diagnostic told the operator to roll back without first confirming the outage. stderr was:"
  cat "$ERR7" >&2
elif ! grep -q 'Do NOT roll' "$ERR7"; then
  fail "synthetic-fail: deploy.sh failure diagnostic did not name the probe-failure case (a healthy release must not be rolled back). stderr was:"
  cat "$ERR7" >&2
else
  pass "synthetic-fail: a failing synthetic fails the deploy, points at the rollback, and makes the operator confirm the outage first."
fi

# ---------------------------------------------------------------------------
# Case 8 (#142): a failing pre-deploy Chromium install aborts BEFORE publishing
# — op-firebase-deploy is never reached, so a broken local probe browser cannot
# report a healthy site as a failed deploy after it is already live.
# ---------------------------------------------------------------------------
REPO8="$WORKDIR/case8-chromium-fail"
init_fixture_repo "$REPO8"
OUT8="$WORKDIR/case8.out"
ERR8="$WORKDIR/case8.err"
: >"$WORKDIR/ofd-calls-8.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-8.log" \
NPM_LOG="$WORKDIR/npm-calls-8.log" \
NPX_STUB_EXIT=1 \
  bash -c "cd '$REPO8' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT8" 2>"$ERR8"
RC8=$?
set -e

if [[ $RC8 -eq 0 ]]; then
  fail "chromium-fail: deploy.sh returned 0 though the Chromium install failed."
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-8.log"; then
  fail "chromium-fail: deploy.sh published (reached op-firebase-deploy) despite the browser install failing before publishing."
elif ! grep -q 'before publishing' "$ERR8"; then
  fail "chromium-fail: deploy.sh did not print the before-publishing abort diagnostic. stderr was:"
  cat "$ERR8" >&2
else
  pass "chromium-fail: a failing pre-deploy Chromium install aborts before publishing (op-firebase-deploy never reached)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "test_deploy.sh: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
