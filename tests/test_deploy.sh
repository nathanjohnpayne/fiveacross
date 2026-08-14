#!/usr/bin/env bash
# tests/test_deploy.sh
#
# Unit tests for scripts/deploy.sh. Covers the guards added /
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
#   2. Exact-main guard.
#      A local `main` commit that has not reached `origin/main` must not deploy.
#
#   3. Clean-working-tree guard.
#      With a dirty fixture worktree, the script must exit non-zero,
#      print the dirty-tree diagnostic, and list the modified path.
#      With DEPLOY_ALLOW_DIRTY=1, the same dirty fixture must allow
#      the deploy to proceed (we assert by reaching the shimmed
#      op-firebase-deploy step).
#
# Later cases (numbered inline below) cover the post-deploy synthetic gate
# (#142) and, most recently, the Step 2.5 Cloud Run invoker reconciliation
# (#768, cases 9-11): it runs by default after op-firebase-deploy, is
# skippable via --skip-invoker, and a failure there fails the deploy rather
# than being swallowed. Stubbed via a PATH-shimmed `gcloud` — never real.
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

# Stub `gcloud` so the Step 2.5 invoker reconciliation (#768) is exercised
# without ever touching real infrastructure — scripts/set-bug-report-invoker.sh
# and scripts/set-email-unsubscribe-invoker.sh both shell out to `gcloud run
# services describe/update`, and deploy.sh now runs BOTH by default on every
# invocation (no test below opts out unless it explicitly passes
# --skip-invoker), so this stub must exist for every case, not just the ones
# that assert on it directly. Default behaviour answers "the invoker IAM check
# is already disabled" for any `describe` call, so both wrapper scripts see a
# clean idempotent no-op and exit 0 — matching their real documented steady
# state. GCLOUD_STUB_EXIT lets a test simulate `describe` failing (e.g. a
# permissions error) instead. Logs to GCLOUD_LOG when set.
cat >"$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
if [ -n "${GCLOUD_LOG:-}" ]; then
  {
    printf 'gcloud'
    for a in "$@"; do printf '\t%s' "$a"; done
    printf '\n'
  } >> "$GCLOUD_LOG"
fi
exit_code="${GCLOUD_STUB_EXIT:-0}"
if [ "$exit_code" != "0" ]; then
  echo "stub-gcloud: simulated failure (GCLOUD_STUB_EXIT=$exit_code)" >&2
  exit "$exit_code"
fi
# Only `run services describe ... --format=value(metadata.annotations[...])`
# is exercised by scripts/set-cloud-run-invoker.sh; answering "true"
# (the invoker-iam-disabled annotation) makes it see the already-correct,
# idempotent no-op state on every call.
echo "true"
exit 0
STUB
chmod +x "$STUB_DIR/gcloud"

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

# Build a clean main checkout with a real origin/main, then let a caller add
# local-only commits. deploy.sh fetches before it compares exact commit ids, so
# this must be a real remote rather than a synthetic local ref.
init_main_fixture_with_origin() {
  local repo="$1"
  local remote="$2"
  git init --quiet --bare "$remote"
  mkdir -p "$repo"
  (
    cd "$repo"
    git init --quiet -b main
    git config user.email "test@example.com"
    git config user.name "Test"
    git config commit.gpgsign false
    echo "initial" > README.md
    git add README.md
    git commit --quiet -m "initial"
    git remote add origin "$remote"
    git push --quiet -u origin main
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
# Case 5: Exact-main guard rejects a clean local main that is ahead of
# origin/main. A behind-only check would wrongly deploy this unreviewed commit.
# ---------------------------------------------------------------------------
REPO5="$WORKDIR/case5-local-main-ahead"
REMOTE5="$WORKDIR/case5-origin.git"
init_main_fixture_with_origin "$REPO5" "$REMOTE5"
(
  cd "$REPO5"
  echo "local only" >> README.md
  git add README.md
  git commit --quiet -m "local-only"
)

OUT5="$WORKDIR/case5.out"
ERR5="$WORKDIR/case5.err"
: >"$WORKDIR/ofd-calls-5.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-5.log" \
  bash -c "cd '$REPO5' && bash '$SCRIPT' --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT5" 2>"$ERR5"
RC5=$?
set -e

if [[ $RC5 -eq 0 ]]; then
  fail "exact-main: deploy.sh accepted a local main ahead of origin/main."
elif ! grep -q 'does not exactly match origin/main' "$ERR5"; then
  fail "exact-main: deploy.sh rejected the local-only commit but did not explain the exact-match guard. stderr was:"
  cat "$ERR5" >&2
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-5.log"; then
  fail "exact-main: deploy.sh reached op-firebase-deploy despite local main being ahead of origin/main."
else
  pass "exact-main: local-only main commit is rejected before deploy."
fi

# ---------------------------------------------------------------------------
# Case 6 (#142): the post-deploy synthetic runs by default and the deploy
# completes when it passes. The `npm` stub records `run … test:synthetic`.
# ---------------------------------------------------------------------------
REPO6="$WORKDIR/case6-synthetic-runs"
init_fixture_repo "$REPO6"
OUT6="$WORKDIR/case6.out"
ERR6="$WORKDIR/case6.err"
: >"$WORKDIR/ofd-calls-6.log"
: >"$WORKDIR/npm-calls-6.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-6.log" \
NPM_LOG="$WORKDIR/npm-calls-6.log" \
  bash -c "cd '$REPO6' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT6" 2>"$ERR6"
RC6=$?
set -e

if [[ $RC6 -ne 0 ]]; then
  fail "synthetic-runs: deploy.sh returned $RC6 though the stubbed synthetic passed. stderr was:"
  cat "$ERR6" >&2
elif ! grep -q 'test:synthetic' "$WORKDIR/npm-calls-6.log"; then
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
# Case 9 (#768): the Cloud Run invoker reconciliation step (Step 2.5) runs by
# default, after op-firebase-deploy — both scripts/set-bug-report-invoker.sh
# and scripts/set-email-unsubscribe-invoker.sh are invoked, not just one.
# ---------------------------------------------------------------------------
REPO9="$WORKDIR/case9-invoker-runs"
init_fixture_repo "$REPO9"
OUT9="$WORKDIR/case9.out"
ERR9="$WORKDIR/case9.err"
: >"$WORKDIR/ofd-calls-9.log"
: >"$WORKDIR/gcloud-calls-9.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-9.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-9.log" \
  bash -c "cd '$REPO9' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT9" 2>"$ERR9"
RC9=$?
set -e

if [[ $RC9 -ne 0 ]]; then
  fail "invoker-runs: deploy.sh returned $RC9 though the stubbed gcloud reported the check already disabled. stderr was:"
  cat "$ERR9" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-9.log"; then
  fail "invoker-runs: deploy.sh did not reach op-firebase-deploy."
elif ! grep -q 'Bug-report invoker config' "$OUT9"; then
  fail "invoker-runs: deploy.sh did not reconcile the bug-report invoker (scripts/set-bug-report-invoker.sh was not reached). stdout was:"
  cat "$OUT9" >&2
elif ! grep -q 'Email-unsubscribe invoker config' "$OUT9"; then
  fail "invoker-runs: deploy.sh did not reconcile the email-unsubscribe invoker (scripts/set-email-unsubscribe-invoker.sh was not reached). stdout was:"
  cat "$OUT9" >&2
elif ! grep -q 'describe' "$WORKDIR/gcloud-calls-9.log"; then
  fail "invoker-runs: the stubbed gcloud was never invoked. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-9.log" >&2
else
  pass "invoker-runs: Step 2.5 reconciles BOTH bug-report and email-unsubscribe by default and the deploy completes."
fi

# ---------------------------------------------------------------------------
# Case 10 (#768): --skip-invoker skips Step 2.5 entirely — neither invoker
# script runs, and the deploy still completes.
# ---------------------------------------------------------------------------
REPO10="$WORKDIR/case10-invoker-skip"
init_fixture_repo "$REPO10"
OUT10="$WORKDIR/case10.out"
ERR10="$WORKDIR/case10.err"
: >"$WORKDIR/ofd-calls-10.log"
: >"$WORKDIR/gcloud-calls-10.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-10.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-10.log" \
  bash -c "cd '$REPO10' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic --skip-invoker" \
  >"$OUT10" 2>"$ERR10"
RC10=$?
set -e

if [[ $RC10 -ne 0 ]]; then
  fail "invoker-skip: deploy.sh returned $RC10 with --skip-invoker. stderr was:"
  cat "$ERR10" >&2
elif ! grep -q 'Invoker reconciliation skipped (--skip-invoker)' "$OUT10"; then
  fail "invoker-skip: deploy.sh did not log the invoker-skip line. stdout was:"
  cat "$OUT10" >&2
elif grep -q 'invoker config:' "$OUT10"; then
  fail "invoker-skip: deploy.sh ran an invoker script despite --skip-invoker. stdout was:"
  cat "$OUT10" >&2
elif [[ -s "$WORKDIR/gcloud-calls-10.log" ]]; then
  fail "invoker-skip: the stubbed gcloud was invoked despite --skip-invoker. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-10.log" >&2
else
  pass "invoker-skip: --skip-invoker skips Step 2.5 entirely (no gcloud call) and the deploy still completes."
fi

# ---------------------------------------------------------------------------
# Case 11 (#768): a failing invoker reconciliation fails the deploy rather
# than being swallowed. GCLOUD_STUB_EXIT simulates `gcloud run services
# describe` erroring (e.g. a permissions/config problem) on the FIRST
# reconciled service (bug-report) — deploy.sh's `set -euo pipefail` must
# abort immediately rather than continuing on to Cloudflare purge / the
# synthetic / "Deploy complete.".
# ---------------------------------------------------------------------------
REPO11="$WORKDIR/case11-invoker-fail"
init_fixture_repo "$REPO11"
OUT11="$WORKDIR/case11.out"
ERR11="$WORKDIR/case11.err"
: >"$WORKDIR/ofd-calls-11.log"
: >"$WORKDIR/npm-calls-11.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-11.log" \
NPM_LOG="$WORKDIR/npm-calls-11.log" \
GCLOUD_STUB_EXIT=1 \
  bash -c "cd '$REPO11' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT11" 2>"$ERR11"
RC11=$?
set -e

if [[ $RC11 -eq 0 ]]; then
  fail "invoker-fail: deploy.sh returned 0 though the invoker reconciliation failed — the failure was swallowed."
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-11.log"; then
  fail "invoker-fail: deploy.sh never reached op-firebase-deploy (Step 2 runs before Step 2.5; this changes the ordering assumption)."
elif ! grep -q 'FAIL: could not describe Cloud Run service' "$ERR11"; then
  fail "invoker-fail: deploy.sh did not surface set-cloud-run-invoker.sh's own failure diagnostic. stderr was:"
  cat "$ERR11" >&2
elif grep -q 'test:synthetic' "$WORKDIR/npm-calls-11.log"; then
  fail "invoker-fail: deploy.sh continued on to the post-deploy synthetic despite the invoker step failing."
elif grep -q 'Deploy complete.' "$OUT11"; then
  fail "invoker-fail: deploy.sh printed 'Deploy complete.' despite the invoker step failing."
else
  pass "invoker-fail: a failing invoker reconciliation fails the deploy (rc=$RC11) rather than being swallowed, after op-firebase-deploy already ran."
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
