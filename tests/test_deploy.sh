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
# (#142) and, most recently, the Cloud Run invoker reconciliation (#768,
# cases 9-14): it runs by default after op-firebase-deploy, is skippable via
# --skip-invoker, and a failure fails the deploy rather than being swallowed.
# Cases 11-14 are the r2 review round and are the load-bearing ones:
#
#   11. An unusable gcloud credential aborts BEFORE publishing, so the deploy
#       can never leave a published-but-403 endpoint behind.
#   12. A deploy that fails with Firebase's org-policy invoker rejection STILL
#       reconciles — that partial failure is the exact case the automation
#       exists for, and `set -e` used to abort before it ran.
#   13. …and that run still FAILS the script: the endpoint is repaired, the
#       deploy error is not converted into a false success.
#
# Cases 14-17 are the r4 review round:
#
#   14. A deploy that fails for an UNRELATED reason still reconciles. Inverted
#       from r2: a successful Functions release resets the invoker annotation
#       no matter what errors afterwards, so keying the recovery on the final
#       error text skipped it in exactly the state it repairs.
#   15. THE REGRESSION GUARD. A normal, documented, preflighted deploy —
#       GOOGLE_APPLICATION_CREDENTIALS holding the per-project Firebase-vault
#       SERVICE-ACCOUNT key, exactly as `op-preflight.sh --mode deploy`
#       exports it — must publish. r3 aborted it at Step 1.6.
#   16. A `--only hosting` deploy neither checks nor reconciles: it cannot
#       reset the invoker annotation, so it must not be gated on gcloud.
#   17. Stale BUG_REPORT_* / EMAIL_UNSUBSCRIBE_* exports do not redirect the
#       automatic reconciliation away from the selected deploy target.
#
# Stubbed via a PATH-shimmed `gcloud` — never real. Case 15 additionally runs
# the REAL scripts/gcloud/gcloud wrapper (with its real binary stubbed), so the
# service-account rejection under test is the wrapper's own logic rather than
# this file's imitation of it.
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

# Start from a known ambient state. A developer shell that has run
# `op-preflight.sh --mode deploy` exports GOOGLE_APPLICATION_CREDENTIALS, and a
# shell that has done a manual invoker repair may still carry BUG_REPORT_* /
# EMAIL_UNSUBSCRIBE_* overrides — both of which change what the code under test
# does. Every case that cares sets them explicitly.
unset GOOGLE_APPLICATION_CREDENTIALS GCLOUD_BIN GCLOUD_REAL_BIN DEPLOY_TARGET_PROJECT
unset AUTH_HANDOFF_DEPLOY_READINESS_PROJECT
unset BUG_REPORT_PROJECT BUG_REPORT_REGION BUG_REPORT_SERVICE
unset EMAIL_UNSUBSCRIBE_PROJECT EMAIL_UNSUBSCRIBE_REGION EMAIL_UNSUBSCRIBE_SERVICE

[[ -x "$SCRIPT" ]] || { echo "missing or non-executable $SCRIPT" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/test-deploy.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

READINESS_CREDENTIAL="$WORKDIR/fiveacross-deployer.json"
printf '%s\n' \
  '{"type":"service_account","client_email":"firebase-deployer@fiveacross.iam.gserviceaccount.com"}' \
  >"$READINESS_CREDENTIAL"

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

#
# OFD_STUB_EXIT (default 0) simulates a failed / partially-failed deploy, and
# OFD_STUB_OUTPUT is printed to stderr first so a test can reproduce the exact
# text deploy.sh classifies against (#768 r2). One line is enough — deploy.sh
# greps line-wise.
cat >"$STUB_DIR/op-firebase-deploy" <<'STUB'
#!/usr/bin/env bash
echo "stub-op-firebase-deploy: invoked with args: $*" >&2
: "${OFD_LOG:?OFD_LOG must be set by the test}"
{
  printf 'op-firebase-deploy'
  for a in "$@"; do printf '\t%s' "$a"; done
  printf '\n'
} >> "$OFD_LOG"
if [ -n "${OFD_CREDENTIAL_LOG:-}" ]; then
  printf '%s\n' "${GOOGLE_APPLICATION_CREDENTIALS:-}" >> "$OFD_CREDENTIAL_LOG"
fi
if [ -n "${OFD_STUB_OUTPUT:-}" ]; then
  printf '%s\n' "$OFD_STUB_OUTPUT" >&2
fi
exit "${OFD_STUB_EXIT:-0}"
STUB
chmod +x "$STUB_DIR/op-firebase-deploy"

# `deploy.sh` materializes the project Firebase-vault key before its invoker
# check when a named deployment starts without deploy-mode preflight. The real
# command writes a document to --out-file; this stub copies the fixture key
# there, or reports that the item is absent so all unrelated tests retain their
# credential-free state.
cat >"$STUB_DIR/op" <<'STUB'
#!/usr/bin/env bash
if [ -n "${OP_LOG:-}" ]; then
  {
    printf 'op'
    for a in "$@"; do printf '\t%s' "$a"; done
    printf '\n'
  } >> "$OP_LOG"
fi
out_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-file) out_file="${2:?--out-file needs a value}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${OP_VAULT_SA_KEY:-}" ] && [ -n "$out_file" ]; then
  cp "$OP_VAULT_SA_KEY" "$out_file"
  exit 0
fi
exit 1
STUB
chmod +x "$STUB_DIR/op"

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
if [ -n "${NPM_DEPLOYMENT_CHECK_LOG:-}" ]; then
  printf '%s\n' "${SYNTHETIC_DEPLOYMENT_CHECK:-}" >> "$NPM_DEPLOYMENT_CHECK_LOG"
fi
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

# Stub `gcloud` so the Step 1.6 credential check and the Step 2.5 invoker
# reconciliation (#768) are exercised without ever touching real
# infrastructure — scripts/set-bug-report-invoker.sh and
# scripts/set-email-unsubscribe-invoker.sh both shell out to `gcloud run
# services describe/update`, and deploy.sh now runs BOTH before publishing (as
# a read-only --dry-run) and again after (no test below opts out unless it
# explicitly passes --skip-invoker), so this stub must exist for every case,
# not just the ones that assert on it directly. Default behaviour answers "the
# invoker IAM check is already disabled" for any `describe` call, so both
# wrapper scripts see a clean idempotent no-op and exit 0 — matching their real
# documented steady state.
#
# Three failure knobs:
#   GCLOUD_STUB_EXIT   fail EVERY call (an absent credential — the pre-publish
#                      check catches this before op-firebase-deploy runs).
#   GCLOUD_FAIL_AFTER  fail only calls after the Nth, counted in
#                      GCLOUD_CALL_COUNTER. This is how a test reaches the
#                      case where the pre-publish check passes and the
#                      post-publish reconciliation then fails — a credential
#                      that expired mid-deploy, or describe-permission without
#                      update-permission.
#   GCLOUD_STUB_ERROR_TEXT  the stderr line printed alongside a simulated
#                      failure (default: the generic "simulated failure"
#                      line above). Set to either real gcloud missing-service
#                      diagnostic (e.g. "ERROR: (gcloud.run.services.describe)
#                      NOT_FOUND: Requested entity was not found." or
#                      "Cannot find service [name]") to exercise the
#                      --allow-missing / first-deploy path (#768 r5)
#                      distinctly from a credential failure.
cat >"$STUB_DIR/gcloud" <<'STUB'
#!/usr/bin/env bash
if [ -n "${GCLOUD_LOG:-}" ]; then
  {
    printf 'gcloud'
    for a in "$@"; do printf '\t%s' "$a"; done
    printf '\n'
  } >> "$GCLOUD_LOG"
fi
if [ -n "${GCLOUD_CALL_COUNTER:-}" ]; then
  gcloud_calls=0
  if [ -s "$GCLOUD_CALL_COUNTER" ]; then
    read -r gcloud_calls < "$GCLOUD_CALL_COUNTER"
  fi
  gcloud_calls=$((gcloud_calls + 1))
  printf '%s\n' "$gcloud_calls" > "$GCLOUD_CALL_COUNTER"
  if [ -n "${GCLOUD_FAIL_AFTER:-}" ] && [ "$gcloud_calls" -gt "$GCLOUD_FAIL_AFTER" ]; then
    echo "stub-gcloud: simulated failure (call $gcloud_calls > GCLOUD_FAIL_AFTER=$GCLOUD_FAIL_AFTER)" >&2
    exit 1
  fi
fi
if [ -n "${GCLOUD_MISSING_SERVICE:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$GCLOUD_MISSING_SERVICE" ]; then
      echo "ERROR: (gcloud.run.services.describe) NOT_FOUND: Requested entity was not found." >&2
      exit 1
    fi
  done
fi
exit_code="${GCLOUD_STUB_EXIT:-0}"
if [ "$exit_code" != "0" ]; then
  echo "${GCLOUD_STUB_ERROR_TEXT:-stub-gcloud: simulated failure (GCLOUD_STUB_EXIT=$exit_code)}" >&2
  exit "$exit_code"
fi
# Only `run services describe ... --format=value(metadata.annotations[...])`
# is exercised by scripts/set-cloud-run-invoker.sh; answering "true"
# (the invoker-iam-disabled annotation) makes it see the already-correct,
# idempotent no-op state on every call. GCLOUD_STUB_ANNOTATION overrides this
# to "false" so a test can prove whether a MUTATING `update` call would have
# followed — with the default "true", set-cloud-run-invoker.sh's own
# idempotence check would short-circuit before ever reaching `update`, which
# would make a dry-run regression test pass for the wrong reason (#768 r5).
echo "${GCLOUD_STUB_ANNOTATION:-true}"
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
: >"$WORKDIR/npm-deployment-check-6.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-6.log" \
NPM_LOG="$WORKDIR/npm-calls-6.log" \
NPM_DEPLOYMENT_CHECK_LOG="$WORKDIR/npm-deployment-check-6.log" \
  bash -c "cd '$REPO6' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT6" 2>"$ERR6"
RC6=$?
set -e

if [[ $RC6 -ne 0 ]]; then
  fail "synthetic-runs: deploy.sh returned $RC6 though the stubbed synthetic passed. stderr was:"
  cat "$ERR6" >&2
elif ! grep -q 'test:synthetic' "$WORKDIR/npm-calls-6.log"; then
  fail "synthetic-runs: deploy.sh did not invoke the post-deploy synthetic (npm run test:synthetic)."
elif ! grep -qx 'true' "$WORKDIR/npm-deployment-check-6.log"; then
  fail "synthetic-runs: deploy.sh did not mark the post-deploy probe as deployment evidence. log was:"
  cat "$WORKDIR/npm-deployment-check-6.log" >&2
else
  pass "synthetic-runs: deploy.sh runs the post-deploy synthetic as deployment evidence and completes when it passes."
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
# and scripts/set-email-unsubscribe-invoker.sh are invoked, not just one — and
# the read-only credential check (Step 1.6) runs on the happy path too.
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
elif ! grep -q 'Checking the Cloud Run invoker credential before publishing' "$OUT9"; then
  fail "invoker-runs: deploy.sh skipped the pre-publish invoker credential check (Step 1.6). stdout was:"
  cat "$OUT9" >&2
elif ! grep -q 'Reconciling Cloud Run invoker config' "$OUT9"; then
  fail "invoker-runs: deploy.sh did not reach the Step 2.5 reconciliation banner. stdout was:"
  cat "$OUT9" >&2
else
  pass "invoker-runs: Step 1.6 checks the credential before publishing, Step 2.5 reconciles BOTH endpoints, and the deploy completes."
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
  pass "invoker-skip: --skip-invoker skips both the pre-publish check and Step 2.5 (no gcloud call) and the deploy still completes."
fi

# ---------------------------------------------------------------------------
# Case 11 (#768 r2 — Codex P1, credential chain): an unusable `gcloud`
# credential must abort BEFORE publishing.
#
# `gcloud` does not inherit op-firebase-deploy's credential — that wrapper
# materializes a per-project Firebase-vault SA key into a temp file and
# deletes it in its own EXIT trap — so a deploy started without
# `op-preflight --mode deploy` can authenticate to Firebase and still have
# nothing usable left for the reconciliation. Discovering that AFTER Firebase
# published is the published-but-403 outage this whole change closes.
#
# GCLOUD_STUB_EXIT=1 fails every gcloud call, which is what an absent
# credential looks like from here. deploy.sh's read-only Step 1.6 must catch
# it and exit with op-firebase-deploy NEVER invoked.
# ---------------------------------------------------------------------------
REPO11="$WORKDIR/case11-invoker-cred-fail"
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
  fail "invoker-cred-fail: deploy.sh returned 0 though no usable gcloud credential was available."
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-11.log"; then
  fail "invoker-cred-fail: deploy.sh PUBLISHED (reached op-firebase-deploy) with a credential that cannot reconcile the invoker config. That is the published-but-403 case."
elif ! grep -q 'FAIL: could not describe Cloud Run service' "$ERR11"; then
  fail "invoker-cred-fail: deploy.sh did not surface set-cloud-run-invoker.sh's own failure diagnostic. stderr was:"
  cat "$ERR11" >&2
elif ! grep -q 'NOTHING HAS BEEN PUBLISHED' "$ERR11"; then
  fail "invoker-cred-fail: deploy.sh did not tell the operator nothing was published. stderr was:"
  cat "$ERR11" >&2
elif ! grep -q 'op-preflight.sh --agent <agent> --mode deploy' "$ERR11"; then
  fail "invoker-cred-fail: the abort diagnostic did not name the credential fix (op-preflight --mode deploy). stderr was:"
  cat "$ERR11" >&2
elif grep -q 'Deploy complete.' "$OUT11"; then
  fail "invoker-cred-fail: deploy.sh printed 'Deploy complete.' despite aborting."
else
  pass "invoker-cred-fail: an unusable gcloud credential aborts BEFORE publishing (rc=$RC11), naming op-preflight --mode deploy."
fi

# ---------------------------------------------------------------------------
# Case 11b (#768 r2): a credential that reads fine before publishing but fails
# afterwards still fails the deploy loudly — the pre-publish check is not a
# licence to swallow a later failure. GCLOUD_FAIL_AFTER lets the read-only
# Step 1.6 describes through and fails everything after, which is what an
# expired credential (or describe-without-update permission) looks like from
# Step 2.5. The threshold is the COUNT OF RECONCILED SERVICES — four since
# #548 added the two auth-handoff callables (submitbugreport, emailunsubscribe,
# mintauthhandoff, exchangeauthhandoff). Bump it when that set grows, or this
# case silently stops testing the post-publish path and starts testing the
# pre-publish abort instead.
# ---------------------------------------------------------------------------
REPO11B="$WORKDIR/case11b-invoker-late-fail"
init_fixture_repo "$REPO11B"
OUT11B="$WORKDIR/case11b.out"
ERR11B="$WORKDIR/case11b.err"
: >"$WORKDIR/ofd-calls-11b.log"
: >"$WORKDIR/npm-calls-11b.log"
: >"$WORKDIR/gcloud-counter-11b"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-11b.log" \
NPM_LOG="$WORKDIR/npm-calls-11b.log" \
GCLOUD_CALL_COUNTER="$WORKDIR/gcloud-counter-11b" \
GCLOUD_FAIL_AFTER=4 \
  bash -c "cd '$REPO11B' && bash '$SCRIPT' --force --skip-build --skip-cf-purge" \
  >"$OUT11B" 2>"$ERR11B"
RC11B=$?
set -e

if [[ $RC11B -eq 0 ]]; then
  fail "invoker-late-fail: deploy.sh returned 0 though the post-publish reconciliation failed — the failure was swallowed."
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-11b.log"; then
  fail "invoker-late-fail: deploy.sh never published, so this case did not exercise the post-publish path."
elif ! grep -q 'reconciliation FAILED and the deploy is already live' "$ERR11B"; then
  fail "invoker-late-fail: deploy.sh did not print the already-live reconciliation-failure banner. stderr was:"
  cat "$ERR11B" >&2
elif grep -q 'test:synthetic' "$WORKDIR/npm-calls-11b.log"; then
  fail "invoker-late-fail: deploy.sh continued on to the post-deploy synthetic despite the invoker step failing."
elif grep -q 'Deploy complete.' "$OUT11B"; then
  fail "invoker-late-fail: deploy.sh printed 'Deploy complete.' despite the invoker step failing."
else
  pass "invoker-late-fail: a reconciliation that fails after publishing still fails the deploy (rc=$RC11B) with an already-live banner."
fi

# ---------------------------------------------------------------------------
# Case 12 (#768 r2 — Codex P1, ordering): THE case this automation exists for.
#
# When a Functions deploy re-tries the `allUsers` invoker binding the org
# policy rejects, firebase-tools reports the whole deploy as FAILED (exit 2)
# while the function is published and serving — only its public reachability
# was refused. Before this round, `set -e` aborted at Step 2 and Step 2.5
# never ran, so the automatic recovery was skipped in precisely the failure
# mode it was written for and the endpoint stayed 403ing.
#
# The stub reproduces firebase-tools' own report line
# (lib/deploy/functions/release/reporter.js) and exits nonzero. Both invoker
# scripts must still run.
# ---------------------------------------------------------------------------
REPO12="$WORKDIR/case12-partial-failure-reconciles"
init_fixture_repo "$REPO12"
OUT12="$WORKDIR/case12.out"
ERR12="$WORKDIR/case12.err"
: >"$WORKDIR/ofd-calls-12.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-12.log" \
NPM_LOG="$WORKDIR/npm-calls-12.log" \
OFD_STUB_EXIT=2 \
OFD_STUB_OUTPUT='Unable to set the invoker for the IAM policy on the following functions: emailUnsubscribe(us-central1)' \
  bash -c "cd '$REPO12' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT12" 2>"$ERR12"
RC12=$?
set -e

if ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-12.log"; then
  fail "partial-failure-reconciles: deploy.sh never published, so this case did not exercise the partial-failure path."
elif ! grep -q 'Reconciling Cloud Run invoker config' "$OUT12"; then
  fail "partial-failure-reconciles: Step 2.5 did NOT run after the org-policy partial failure — the recovery is still skipped in exactly the case it exists for. stdout was:"
  cat "$OUT12" >&2
  echo "--- stderr ---" >&2
  cat "$ERR12" >&2
elif ! grep -q 'Bug-report invoker config' "$OUT12"; then
  fail "partial-failure-reconciles: set-bug-report-invoker.sh did not run after the partial failure. stdout was:"
  cat "$OUT12" >&2
elif ! grep -q 'Email-unsubscribe invoker config' "$OUT12"; then
  fail "partial-failure-reconciles: set-email-unsubscribe-invoker.sh did not run after the partial failure. stdout was:"
  cat "$OUT12" >&2
elif ! grep -q 'Reconciling the invoker check anyway' "$ERR12"; then
  fail "partial-failure-reconciles: deploy.sh reconciled but did not say why, so the operator cannot tell this from a clean run. stderr was:"
  cat "$ERR12" >&2
else
  pass "partial-failure-reconciles: an org-policy invoker partial failure still reaches Step 2.5 and reconciles BOTH endpoints."
fi

# ---------------------------------------------------------------------------
# Case 13 (#768 r2): …and that same run must still FAIL. Repairing the
# endpoint is not the same as the deploy having succeeded: a nonzero
# `firebase deploy` means at least one resource missed its intended state, and
# printing "Deploy complete." over it would convert a real failure into a
# false success. Same fixture run as case 12, asserted from the other side.
# ---------------------------------------------------------------------------
if [[ $RC12 -eq 0 ]]; then
  fail "partial-failure-still-fails: deploy.sh returned 0 after op-firebase-deploy exited 2 — a real deploy failure was converted into a false success."
elif grep -q 'Deploy complete.' "$OUT12"; then
  fail "partial-failure-still-fails: deploy.sh printed 'Deploy complete.' over a failed deploy. stdout was:"
  cat "$OUT12" >&2
elif [[ $RC12 -ne 2 ]]; then
  fail "partial-failure-still-fails: deploy.sh returned $RC12; expected op-firebase-deploy's own exit status (2)."
elif ! grep -q 'op-firebase-deploy exited 2' "$ERR12"; then
  fail "partial-failure-still-fails: deploy.sh did not report the deploy's own failure. stderr was:"
  cat "$ERR12" >&2
else
  pass "partial-failure-still-fails: the reconciliation runs but the deploy failure still fails the script (rc=$RC12), no 'Deploy complete.'."
fi

# ---------------------------------------------------------------------------
# Case 14 (#768 r4 — Codex P1, classifier too narrow). INVERTED from r2.
#
# r2 skipped reconciliation on any failure that did not carry the org-policy
# invoker text, reasoning that an unclassified failure leaves the project in an
# unknown state. That reasoning runs the wrong way: the invoker annotation is
# reset by a SUCCESSFUL Functions release, which can complete long before the
# overall command fails on something else entirely (Hosting, a second
# function). The skip therefore left BOTH endpoints 403ing merely because an
# unrelated resource also failed — the exact outage this automation prevents.
#
# The reconciliation is idempotent and one-directional, so running it here
# costs a no-op read. The deploy must still fail closed.
# ---------------------------------------------------------------------------
REPO14="$WORKDIR/case14-unrelated-failure"
init_fixture_repo "$REPO14"
OUT14="$WORKDIR/case14.out"
ERR14="$WORKDIR/case14.err"
: >"$WORKDIR/ofd-calls-14.log"
: >"$WORKDIR/npm-calls-14.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-14.log" \
NPM_LOG="$WORKDIR/npm-calls-14.log" \
OFD_STUB_EXIT=1 \
OFD_STUB_OUTPUT='Error: HTTP Error: 403, The caller does not have permission to deploy Hosting' \
  bash -c "cd '$REPO14' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT14" 2>"$ERR14"
RC14=$?
set -e

if [[ $RC14 -eq 0 ]]; then
  fail "unrelated-failure: deploy.sh returned 0 though op-firebase-deploy exited 1."
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-14.log"; then
  fail "unrelated-failure: deploy.sh never published, so this case did not exercise the failure path."
elif ! grep -q 'Reconciling Cloud Run invoker config' "$OUT14"; then
  fail "unrelated-failure: Step 2.5 did NOT reconcile after a non-invoker deploy failure. A successful Functions release resets the annotation regardless of what failed afterwards, so this leaves both endpoints 403ing. stdout was:"
  cat "$OUT14" >&2
  echo "--- stderr ---" >&2
  cat "$ERR14" >&2
elif ! grep -q 'Email-unsubscribe invoker config' "$OUT14"; then
  fail "unrelated-failure: set-email-unsubscribe-invoker.sh did not run. stdout was:"
  cat "$OUT14" >&2
elif ! grep -q 'could still have released' "$ERR14"; then
  fail "unrelated-failure: deploy.sh reconciled but did not explain why it reconciled over a failed deploy. stderr was:"
  cat "$ERR14" >&2
elif grep -q 'Deploy complete.' "$OUT14"; then
  fail "unrelated-failure: deploy.sh printed 'Deploy complete.' over a failed deploy."
elif [[ $RC14 -ne 1 ]]; then
  fail "unrelated-failure: deploy.sh returned $RC14; expected op-firebase-deploy's own exit status (1)."
else
  pass "unrelated-failure: an unrelated deploy failure still reconciles (idempotent) and still fails closed (rc=$RC14)."
fi

# ---------------------------------------------------------------------------
# Case 15 (#768 r4 — Codex P1, credential chain). THE REGRESSION GUARD.
#
# This is the case r3 broke and this round exists to fix: the NORMAL,
# documented, preflighted deploy. `op-preflight.sh --agent <a> --mode deploy`
# exports GOOGLE_APPLICATION_CREDENTIALS pointing at the per-project
# Firebase-vault SERVICE-ACCOUNT key (docs/agents/deployment-process.md § 24),
# and r3's new pre-publish Step 1.6 handed that key to `scripts/gcloud/gcloud`,
# which rejects service-account files outright — so every standard deploy
# aborted before publishing. That is strictly worse than the 403 it prevents:
# it converts a broken unsubscribe link into a broken deploy.
#
# The stubbing here is deliberately one layer deeper than the other cases.
# `gcloud` on PATH is the REAL scripts/gcloud/gcloud wrapper, with
# GCLOUD_REAL_BIN pointing at a recording stub — so the rejection this case
# guards against is the wrapper's own `try_token_from_source` /
# "unusable credential file" logic, not a re-implementation of it here that
# could drift from the real thing. Nothing touches a network or real
# infrastructure: the wrapper either aborts locally (the pre-fix behaviour) or
# hands off to the stub via its own GCLOUD_BYPASS_ADC_WRAPPER passthrough.
# ---------------------------------------------------------------------------
REPO15="$WORKDIR/case15-preflighted-sa-key"
init_fixture_repo "$REPO15"
OUT15="$WORKDIR/case15.out"
ERR15="$WORKDIR/case15.err"
: >"$WORKDIR/ofd-calls-15.log"
: >"$WORKDIR/gcloud-real-15.log"

# A structurally-valid Firebase-vault SA key. The private key is a placeholder:
# nothing here ever signs or authenticates, because the real gcloud binary is
# stubbed. What matters is the `"type": "service_account"` discriminator, which
# is what both the wrapper and set-cloud-run-invoker.sh branch on.
SA_KEY_15="$WORKDIR/case15-firebase-deployer-key.json"
cat >"$SA_KEY_15" <<'JSON'
{
  "type": "service_account",
  "project_id": "gaycruisebingo",
  "private_key_id": "placeholder",
  "private_key": "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-deployer@gaycruisebingo.iam.gserviceaccount.com",
  "client_id": "000000000000000000000",
  "token_uri": "https://oauth2.googleapis.com/token"
}
JSON

# The real gcloud binary the wrapper delegates to. Answers
# `auth activate-service-account` with success and `run services describe` with
# the already-disabled annotation, and records every call so the assertions can
# prove the SA key was actually activated rather than quietly ignored.
cat >"$STUB_DIR/gcloud-real" <<'STUB'
#!/usr/bin/env bash
{
  printf 'gcloud-real'
  for a in "$@"; do printf '\t%s' "$a"; done
  printf '\tCLOUDSDK_CONFIG=%s' "${CLOUDSDK_CONFIG:-}"
  printf '\n'
} >> "${GCLOUD_REAL_LOG:?GCLOUD_REAL_LOG must be set by the test}"
for a in "$@"; do
  if [ "$a" = "activate-service-account" ]; then
    exit 0
  fi
done
echo "true"
exit 0
STUB
chmod +x "$STUB_DIR/gcloud-real"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-15.log" \
GCLOUD_BIN="$ROOT/scripts/gcloud/gcloud" \
GCLOUD_REAL_BIN="$STUB_DIR/gcloud-real" \
GCLOUD_REAL_LOG="$WORKDIR/gcloud-real-15.log" \
GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY_15" \
  bash -c "cd '$REPO15' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT15" 2>"$ERR15"
RC15=$?
set -e

if [[ $RC15 -ne 0 ]]; then
  fail "preflighted-sa-key: a NORMAL preflighted deploy (GOOGLE_APPLICATION_CREDENTIALS = Firebase-vault SA key) returned $RC15. The invoker feature is breaking routine deploys. stderr was:"
  cat "$ERR15" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-15.log"; then
  fail "preflighted-sa-key: deploy.sh never published — Step 1.6 aborted a deploy that had nothing wrong with it. stderr was:"
  cat "$ERR15" >&2
elif grep -q 'unusable credential file' "$ERR15"; then
  fail "preflighted-sa-key: the gcloud wrapper still rejected the deploy service-account key. stderr was:"
  cat "$ERR15" >&2
elif ! grep -q 'activate-service-account' "$WORKDIR/gcloud-real-15.log"; then
  fail "preflighted-sa-key: the deploy service-account key was never activated, so the reconciliation did not actually use it. gcloud log was:"
  cat "$WORKDIR/gcloud-real-15.log" >&2
elif ! grep -q 'invoker-gcloud-config' "$WORKDIR/gcloud-real-15.log"; then
  fail "preflighted-sa-key: the key was activated into the machine's own gcloud config rather than a throwaway CLOUDSDK_CONFIG. gcloud log was:"
  cat "$WORKDIR/gcloud-real-15.log" >&2
elif ! grep -q 'describe' "$WORKDIR/gcloud-real-15.log"; then
  fail "preflighted-sa-key: no describe call reached the real gcloud, so the reconciliation never ran. gcloud log was:"
  cat "$WORKDIR/gcloud-real-15.log" >&2
elif ! grep -q 'Deploy complete.' "$OUT15"; then
  fail "preflighted-sa-key: deploy.sh did not complete. stdout was:"
  cat "$OUT15" >&2
else
  pass "preflighted-sa-key: a normal preflighted deploy publishes, activating the deploy SA key into a throwaway gcloud config (rc=$RC15)."
fi

# ---------------------------------------------------------------------------
# Case 15b (#768 r4): the same fixture proves the guard is REAL — i.e. that
# handing the SA key to the wrapper would abort. If `scripts/gcloud/gcloud`
# ever stopped rejecting service-account keys, case 15 would pass for the wrong
# reason and silently stop guarding anything, so assert the rejection directly.
# ---------------------------------------------------------------------------
WRAPPER_ERR15="$WORKDIR/case15b-wrapper.err"
set +e
GCLOUD_REAL_BIN="$STUB_DIR/gcloud-real" \
GCLOUD_REAL_LOG="$WORKDIR/gcloud-real-15b.log" \
GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY_15" \
  "$ROOT/scripts/gcloud/gcloud" run services describe emailunsubscribe \
    --region us-central1 --project gaycruisebingo \
  >/dev/null 2>"$WRAPPER_ERR15"
RC15B=$?
set -e

if [[ $RC15B -eq 0 ]]; then
  fail "sa-key-rejection-is-real: scripts/gcloud/gcloud accepted a service-account key, so case 15 no longer guards anything. Re-check the wrapper's credential chain."
elif ! grep -q 'unusable credential file' "$WRAPPER_ERR15"; then
  fail "sa-key-rejection-is-real: the wrapper failed (rc=$RC15B) but not with the service-account rejection this case pins. stderr was:"
  cat "$WRAPPER_ERR15" >&2
else
  pass "sa-key-rejection-is-real: scripts/gcloud/gcloud does reject a service-account key (rc=$RC15B), so case 15 is a real guard."
fi

# ---------------------------------------------------------------------------
# Case 16 (#768 r4): `--only hosting` neither checks nor reconciles.
#
# A Hosting-only deploy cannot reset the Cloud Run invoker annotation, so there
# is nothing for the reconciliation to repair — and no reason to let a gcloud
# credential problem block a deploy that never needed gcloud. This is the other
# half of the "must not break normal deploys" property: GCLOUD_STUB_EXIT=1
# simulates an entirely absent credential, and the deploy must still publish.
# ---------------------------------------------------------------------------
REPO16="$WORKDIR/case16-hosting-only"
init_fixture_repo "$REPO16"
OUT16="$WORKDIR/case16.out"
ERR16="$WORKDIR/case16.err"
: >"$WORKDIR/ofd-calls-16.log"
: >"$WORKDIR/gcloud-calls-16.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-16.log" \
GCLOUD_STUB_EXIT=1 \
  bash -c "cd '$REPO16' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only hosting" \
  >"$OUT16" 2>"$ERR16"
RC16=$?
set -e

if [[ $RC16 -ne 0 ]]; then
  fail "hosting-only: a --only hosting deploy returned $RC16 because gcloud was unavailable, though it cannot touch the invoker config at all. stderr was:"
  cat "$ERR16" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-16.log"; then
  fail "hosting-only: deploy.sh never published."
elif [[ -s "$WORKDIR/gcloud-calls-16.log" ]]; then
  fail "hosting-only: gcloud was invoked for a Hosting-only deploy. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16.log" >&2
elif ! grep -q 'does not release Functions' "$OUT16"; then
  fail "hosting-only: deploy.sh did not log why it skipped the invoker steps. stdout was:"
  cat "$OUT16" >&2
else
  pass "hosting-only: a --only hosting deploy skips both invoker steps and publishes even with no gcloud credential (rc=$RC16)."
fi

# ---------------------------------------------------------------------------
# Case 16b (#768 r4): …but `--only functions:emailUnsubscribe` DOES reconcile.
# The allowlist parse must recognise a per-function selector, not just the bare
# `functions` token — a single-function deploy is the most common way to reset
# the annotation.
# ---------------------------------------------------------------------------
REPO16B="$WORKDIR/case16b-single-function"
init_fixture_repo "$REPO16B"
OUT16B="$WORKDIR/case16b.out"
ERR16B="$WORKDIR/case16b.err"
: >"$WORKDIR/ofd-calls-16b.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16b.log" \
  bash -c "cd '$REPO16B' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:emailUnsubscribe" \
  >"$OUT16B" 2>"$ERR16B"
RC16B=$?
set -e

if [[ $RC16B -ne 0 ]]; then
  fail "single-function: deploy.sh returned $RC16B. stderr was:"
  cat "$ERR16B" >&2
elif ! grep -q 'Reconciling Cloud Run invoker config' "$OUT16B"; then
  fail "single-function: --only functions:emailUnsubscribe did NOT reconcile — the allowlist parse missed the per-function selector. stdout was:"
  cat "$OUT16B" >&2
else
  pass "single-function: --only functions:emailUnsubscribe still reconciles (rc=$RC16B)."
fi

# ---------------------------------------------------------------------------
# Case 16c (#768 Phase 4b P1): `functions:<selector>` can name a Firebase
# codebase or function group, not only one exported function. An unfamiliar
# selector must therefore reconcile BOTH protected endpoints rather than
# silently leaving one released service 403ing. Exact known endpoint names
# remain precisely scoped (case 21).
# ---------------------------------------------------------------------------
REPO16C="$WORKDIR/case16c-codebase-selector"
init_fixture_repo "$REPO16C"
OUT16C="$WORKDIR/case16c.out"
ERR16C="$WORKDIR/case16c.err"
: >"$WORKDIR/ofd-calls-16c.log"
: >"$WORKDIR/gcloud-calls-16c.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16c.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-16c.log" \
  bash -c "cd '$REPO16C' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:default" \
  >"$OUT16C" 2>"$ERR16C"
RC16C=$?
set -e

if [[ $RC16C -ne 0 ]]; then
  fail "codebase-selector: --only functions:default returned $RC16C. stderr was:"
  cat "$ERR16C" >&2
elif ! grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-16c.log" || ! grep -q 'emailunsubscribe' "$WORKDIR/gcloud-calls-16c.log"; then
  fail "codebase-selector: an unfamiliar functions: selector did not reconcile both protected endpoints. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16c.log" >&2
else
  pass "codebase-selector: an unfamiliar functions: selector conservatively reconciles both protected endpoints (rc=$RC16C)."
fi

# ---------------------------------------------------------------------------
# Case 16d (#768 Phase 4b P2): an unfamiliar selector can be a genuinely
# unrelated function. Its conservative post-deploy probes must allow a
# protected service to remain absent rather than turning the valid scoped
# deploy into a failure; explicitly named endpoint scopes remain strict (19a).
# ---------------------------------------------------------------------------
REPO16D="$WORKDIR/case16d-unrelated-selector-first-deploy"
init_fixture_repo "$REPO16D"
OUT16D="$WORKDIR/case16d.out"
ERR16D="$WORKDIR/case16d.err"
: >"$WORKDIR/ofd-calls-16d.log"
: >"$WORKDIR/gcloud-calls-16d.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16d.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-16d.log" \
GCLOUD_MISSING_SERVICE=submitbugreport \
  bash -c "cd '$REPO16D' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:unrelatedFirstFunction" \
  >"$OUT16D" 2>"$ERR16D"
RC16D=$?
set -e

if [[ $RC16D -ne 0 ]]; then
  fail "unrelated-selector-first-deploy: a valid unfamiliar scoped deploy returned $RC16D because protected submitbugreport is absent. stderr was:"
  cat "$ERR16D" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-16d.log"; then
  fail "unrelated-selector-first-deploy: the conservative precheck did not reach the scoped Firebase deploy."
elif ! grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-16d.log"; then
  fail "unrelated-selector-first-deploy: did not exercise the conservatively inferred absent service. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16d.log" >&2
else
  pass "unrelated-selector-first-deploy: an unfamiliar scoped selector tolerates an absent conservatively inferred service before and after publish (rc=$RC16D)."
fi

# ---------------------------------------------------------------------------
# Case 16e (#548, Codex P2 round 10 — REVERSES the #768 Phase 4b P2 conclusion
# this case previously encoded): `--except functions:default` excludes NOTHING,
# so Functions are still released and the invoker reconciliation must still run.
#
# The vendored source is decisive — firebase-tools/lib/filterTargets.js applies
# `difference(targets, options.except.split(","))` with NO `:` splitting, so
# "functions:default" is compared literally against the target name "functions",
# matches nothing, and removes nothing. (`--only` DOES split on `:`, which is
# why the two spellings legitimately differ there and cannot here.)
#
# The old assertion — that this scope touches no gcloud — was therefore
# asserting the bug: Firebase released Functions, reset the invoker
# annotations, and deploy.sh skipped the repair, leaving all three protected
# endpoints 403.
# ---------------------------------------------------------------------------
REPO16E="$WORKDIR/case16e-unfamiliar-except"
init_fixture_repo "$REPO16E"
OUT16E="$WORKDIR/case16e.out"
ERR16E="$WORKDIR/case16e.err"
: >"$WORKDIR/ofd-calls-16e.log"
: >"$WORKDIR/gcloud-calls-16e.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16e.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-16e.log" \
  bash -c "cd '$REPO16E' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions --except functions:default" \
  >"$OUT16E" 2>"$ERR16E"
RC16E=$?
set -e

if [[ $RC16E -ne 0 ]]; then
  fail "default-codebase-except: deploy.sh returned $RC16E. stderr was:"
  cat "$ERR16E" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-16e.log"; then
  fail "default-codebase-except: deploy.sh never reached Firebase."
elif ! grep -q 'mintauthhandoff' "$WORKDIR/gcloud-calls-16e.log"; then
  fail "default-codebase-except: an exclusion that excludes NOTHING skipped the handoff reconciliation, leaving the released callables 403. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16e.log" >&2
elif ! grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-16e.log"; then
  fail "default-codebase-except: the sibling endpoints were skipped too. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16e.log" >&2
else
  pass "default-codebase-except: --except functions:default excludes nothing, so every protected endpoint is still reconciled (rc=$RC16E)."
fi

# ---------------------------------------------------------------------------
# Case 16f (#768 Phase 4b P1): an unknown exclusion can name a single
# unrelated function. It must NOT suppress the protected-endpoint
# reconciliation, because a full Functions deploy still releases those
# endpoints and can reset their invoker annotations.
# ---------------------------------------------------------------------------
REPO16F="$WORKDIR/case16f-unknown-except"
init_fixture_repo "$REPO16F"
OUT16F="$WORKDIR/case16f.out"
ERR16F="$WORKDIR/case16f.err"
: >"$WORKDIR/ofd-calls-16f.log"
: >"$WORKDIR/gcloud-calls-16f.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-16f.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-16f.log" \
  bash -c "cd '$REPO16F' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions --except functions:someUnrelatedFunction" \
  >"$OUT16F" 2>"$ERR16F"
RC16F=$?
set -e

if [[ $RC16F -ne 0 ]]; then
  fail "unknown-except: a full Functions deploy excluding an unrelated function returned $RC16F. stderr was:"
  cat "$ERR16F" >&2
elif ! grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-16f.log" || ! grep -q 'emailunsubscribe' "$WORKDIR/gcloud-calls-16f.log"; then
  fail "unknown-except: deploy.sh skipped protected-endpoint reconciliation for an unrelated exclusion. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-16f.log" >&2
else
  pass "unknown-except: an unrelated function exclusion still reconciles both protected endpoints (rc=$RC16F)."
fi

# ---------------------------------------------------------------------------
# Case 17 (#768 r4 — Codex P2): stale overrides must not redirect the automatic
# reconciliation.
#
# scripts/set-*-invoker.sh honour BUG_REPORT_* / EMAIL_UNSUBSCRIBE_* so an
# operator can point a MANUAL repair at another project. Those exports survive
# in a shell, and an automatic call that inherited them would reconcile
# whatever the last manual repair named — a leftover
# `EMAIL_UNSUBSCRIBE_PROJECT=fiveacross` during a gaycruisebingo deploy makes
# both prechecks pass against Five Across while the just-reset gaycruisebingo
# services keep 403ing, with every log line claiming success.
# ---------------------------------------------------------------------------
REPO17="$WORKDIR/case17-pinned-coordinates"
init_fixture_repo "$REPO17"
OUT17="$WORKDIR/case17.out"
ERR17="$WORKDIR/case17.err"
: >"$WORKDIR/ofd-calls-17.log"
: >"$WORKDIR/gcloud-calls-17.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-17.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-17.log" \
DEPLOY_TARGET_PROJECT=gaycruisebingo \
BUG_REPORT_PROJECT=fiveacross \
EMAIL_UNSUBSCRIBE_PROJECT=fiveacross \
EMAIL_UNSUBSCRIBE_REGION=europe-west1 \
EMAIL_UNSUBSCRIBE_SERVICE=someoldname \
  bash -c "cd '$REPO17' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT17" 2>"$ERR17"
RC17=$?
set -e

if [[ $RC17 -ne 0 ]]; then
  fail "pinned-coordinates: deploy.sh returned $RC17. stderr was:"
  cat "$ERR17" >&2
elif grep -q 'fiveacross' "$WORKDIR/gcloud-calls-17.log"; then
  fail "pinned-coordinates: the automatic reconciliation targeted fiveacross because a stale export leaked through. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-17.log" >&2
elif grep -qE 'europe-west1|someoldname' "$WORKDIR/gcloud-calls-17.log"; then
  fail "pinned-coordinates: a stale region/service override leaked into the automatic reconciliation. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-17.log" >&2
elif ! grep -q 'project=gaycruisebingo' "$OUT17"; then
  fail "pinned-coordinates: the reconciliation did not report the selected target's project. stdout was:"
  cat "$OUT17" >&2
elif ! grep -q 'emailunsubscribe' "$WORKDIR/gcloud-calls-17.log"; then
  fail "pinned-coordinates: the default emailunsubscribe service was not the one described. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-17.log" >&2
else
  pass "pinned-coordinates: stale BUG_REPORT_* / EMAIL_UNSUBSCRIBE_* exports are cleared and the project is re-pinned from the deploy target (rc=$RC17)."
fi

# ---------------------------------------------------------------------------
# Case 18 (#768 r5 — Codex P2, dry-run footgun). Firebase's OWN `--dry-run`
# must not let Step 2.5 mutate the Cloud Run invoker config.
#
# `firebase deploy --dry-run` is a real, documented flag (validate and build
# without releasing project changes, though Firebase may still enable APIs),
# forwarded here through DEPLOY_ARGS exactly like `--only hosting` is. Before
# this round, only FUNCTIONS_ATTEMPTED gated Step 2.5, so
# `scripts/deploy.sh -- --dry-run` — a call that must not release the app or
# run wrapper-owned IAM updates — still ran the MUTATING reconciliation once
# op-firebase-deploy's own dry run reported success (DEPLOY_STATUS=0).
#
# GCLOUD_STUB_ANNOTATION=false makes every `describe` answer "not yet
# disabled" — the state that would otherwise require a real `gcloud run
# services update ... --no-invoker-iam-check` call. With the default
# annotation ("true", already disabled) this test would pass for the wrong
# reason: set-cloud-run-invoker.sh's own idempotence check short-circuits
# before ever reaching `update`, regardless of whether Step 2.5 ran. Forcing
# "false" means the ONLY thing standing between this test and a real mutation
# attempt is deploy.sh's own dry-run gate — exactly what's under test.
#
# Step 1.6's own `--dry-run` (always passed, unrelated to Firebase's) is
# unaffected and still runs read-only, so a `describe` call IS expected in
# the gcloud log — only `update` must be absent.
# ---------------------------------------------------------------------------
REPO18="$WORKDIR/case18-firebase-dry-run"
init_fixture_repo "$REPO18"
OUT18="$WORKDIR/case18.out"
ERR18="$WORKDIR/case18.err"
: >"$WORKDIR/ofd-calls-18.log"
: >"$WORKDIR/gcloud-calls-18.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-18.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-18.log" \
GCLOUD_STUB_ANNOTATION=false \
GCLOUD_BIN="$STUB_DIR/gcloud" \
GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
DEPLOY_TARGET_PROJECT=fiveacross \
  bash -c "cd '$REPO18' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --dry-run" \
  >"$OUT18" 2>"$ERR18"
RC18=$?
set -e

if [[ $RC18 -ne 0 ]]; then
  fail "firebase-dry-run: deploy.sh returned $RC18 for a Firebase --dry-run. stderr was:"
  cat "$ERR18" >&2
elif ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-18.log"; then
  fail "firebase-dry-run: deploy.sh never reached op-firebase-deploy."
elif ! grep -q -- '--dry-run' "$WORKDIR/ofd-calls-18.log"; then
  fail "firebase-dry-run: op-firebase-deploy was not called with --dry-run. Call log was:"
  cat "$WORKDIR/ofd-calls-18.log" >&2
elif grep -qw 'update' "$WORKDIR/gcloud-calls-18.log"; then
  fail "firebase-dry-run: gcloud was invoked with 'update' during a Firebase --dry-run — a supposedly no-op validation run mutated live Cloud Run invoker config. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-18.log" >&2
elif ! grep -q 'describe' "$WORKDIR/gcloud-calls-18.log"; then
  fail "firebase-dry-run: Step 1.6's own read-only pre-publish check did not run. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-18.log" >&2
elif ! grep -q 'Invoker reconciliation skipped (Firebase --dry-run' "$OUT18"; then
  fail "firebase-dry-run: deploy.sh did not log why Step 2.5 was skipped. stdout was:"
  cat "$OUT18" >&2
elif ! grep -q 'Auth-handoff deploy readiness skipped (Firebase --dry-run)' "$OUT18"; then
  fail "firebase-dry-run: deploy.sh did not skip the wrapper-owned pre-build readiness update. stdout was:"
  cat "$OUT18" >&2
elif grep -q 'Reconciling Cloud Run invoker config' "$OUT18"; then
  fail "firebase-dry-run: deploy.sh ran the Step 2.5 reconciliation banner despite the Firebase --dry-run. stdout was:"
  cat "$OUT18" >&2
elif ! grep -q 'Deploy complete.' "$OUT18"; then
  fail "firebase-dry-run: deploy.sh did not complete. stdout was:"
  cat "$OUT18" >&2
else
  pass "firebase-dry-run: a Firebase --dry-run runs the read-only pre-publish check but skips the mutating Step 2.5 reconciliation entirely (rc=$RC18, no gcloud update call)."
fi

# ---------------------------------------------------------------------------
# Cases 18a-18f (#852, Codex P1): every documented Firebase deploy option
# whose NEXT token is a value must consume a value named `--dry-run` rather
# than suppressing deploy.sh's wrapper-owned readiness and repair updates.
#
# firebase-tools 15.27.0 documents -m/--message, -p/--public, --only, and
# --except as the complete split value-taking set. There is deliberately no
# second named-target scanner; it forwards these arguments here unchanged. A
# final --only hosting makes every case a real client deploy, so the exact-SA
# readiness update proves deploy.sh did not misclassify the earlier option
# value as Firebase's standalone --dry-run flag.
# ---------------------------------------------------------------------------
for value_option_case in \
  "18a:-m" "18b:--message" "18c:-p" "18d:--public" \
  "18e:--only" "18f:--except"; do
  case_id="${value_option_case%%:*}"
  value_option="${value_option_case#*:}"
  REPO_VALUE="$WORKDIR/case${case_id}-firebase-value"
  init_fixture_repo "$REPO_VALUE"
  OUT_VALUE="$WORKDIR/case${case_id}.out"
  ERR_VALUE="$WORKDIR/case${case_id}.err"
  : >"$WORKDIR/ofd-calls-${case_id}.log"
  : >"$WORKDIR/gcloud-calls-${case_id}.log"

  set +e
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-${case_id}.log" \
  GCLOUD_LOG="$WORKDIR/gcloud-calls-${case_id}.log" \
  GCLOUD_STUB_ANNOTATION=false \
  GCLOUD_BIN="$STUB_DIR/gcloud" \
  GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
  AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
  DEPLOY_TARGET_PROJECT=fiveacross \
    bash -c "cd '$REPO_VALUE' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo '$value_option' --dry-run --only hosting" \
    >"$OUT_VALUE" 2>"$ERR_VALUE"
  RC_VALUE=$?
  set -e

  if [[ $RC_VALUE -ne 0 ]]; then
    fail "firebase-value ($case_id, $value_option): deploy.sh returned $RC_VALUE. stderr was:"
    cat "$ERR_VALUE" >&2
  elif ! grep -q -- "$value_option" "$WORKDIR/ofd-calls-${case_id}.log"; then
    fail "firebase-value ($case_id, $value_option): op-firebase-deploy did not receive the value-taking option. Call log was:"
    cat "$WORKDIR/ofd-calls-${case_id}.log" >&2
  elif ! grep -qw 'update' "$WORKDIR/gcloud-calls-${case_id}.log"; then
    fail "firebase-value ($case_id, $value_option): a --dry-run option value suppressed exact-SA pre-build readiness. gcloud log was:"
    cat "$WORKDIR/gcloud-calls-${case_id}.log" >&2
  elif ! grep -q 'Proving exact deploy-SA auth-handoff readiness before build' "$OUT_VALUE"; then
    fail "firebase-value ($case_id, $value_option): the canonical parser did not select readiness for the final Hosting scope. stdout was:"
    cat "$OUT_VALUE" >&2
  elif grep -q 'Invoker reconciliation skipped (Firebase --dry-run' "$OUT_VALUE"; then
    fail "firebase-value ($case_id, $value_option): deploy.sh reported a dry run for an option value. stdout was:"
    cat "$OUT_VALUE" >&2
  else
    pass "firebase-value ($case_id, $value_option): a value named --dry-run remains a real Hosting deploy and runs pre-build readiness (rc=$RC_VALUE)."
  fi
done

# ---------------------------------------------------------------------------
# Case 19a (#768 r5 — Codex P2, chicken-and-egg). A first deploy against a
# brand-new target — neither Cloud Run service exists yet — must not be
# aborted at the Step 1.6 pre-publish check, and the SAME condition must
# still fail the deploy if it persists at Step 2.5 post-deploy (proving a 404
# stays meaningful there, since by then the service should exist).
#
# GCLOUD_STUB_ERROR_TEXT reproduces gcloud's real NOT_FOUND status enum for a
# missing Cloud Run service. Every gcloud call fails identically here (the
# stub cannot tell Step 1.6's calls from Step 2.5's), which models the
# pessimistic case: the service is STILL missing after "deploy" (op-firebase-
# deploy is stubbed and never actually creates anything). Step 1.6 must let
# that through; Step 2.5 must not.
# ---------------------------------------------------------------------------
REPO19A="$WORKDIR/case19a-first-deploy-not-found"
init_fixture_repo "$REPO19A"
OUT19A="$WORKDIR/case19a.out"
ERR19A="$WORKDIR/case19a.err"
: >"$WORKDIR/ofd-calls-19a.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-19a.log" \
NPM_LOG="$WORKDIR/npm-calls-19a.log" \
GCLOUD_STUB_EXIT=1 \
GCLOUD_STUB_ERROR_TEXT='ERROR: (gcloud.run.services.describe) NOT_FOUND: Requested entity was not found.' \
  bash -c "cd '$REPO19A' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT19A" 2>"$ERR19A"
RC19A=$?
set -e

if ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-19a.log"; then
  fail "first-deploy-not-found: deploy.sh never reached op-firebase-deploy — Step 1.6 wrongly aborted a first deploy just because the Cloud Run service does not exist yet. stderr was:"
  cat "$ERR19A" >&2
elif grep -q 'NOTHING HAS BEEN PUBLISHED' "$ERR19A"; then
  fail "first-deploy-not-found: deploy.sh printed the pre-publish abort banner for a plain NOT_FOUND, though op-firebase-deploy was (impossibly) also reached. stderr was:"
  cat "$ERR19A" >&2
elif ! grep -q 'does not exist yet' "$ERR19A"; then
  fail "first-deploy-not-found: set-cloud-run-invoker.sh did not print the expected first-deploy explanation for the NOT_FOUND. stderr was:"
  cat "$ERR19A" >&2
elif [[ $RC19A -eq 0 ]]; then
  fail "first-deploy-not-found: deploy.sh returned 0 though the Cloud Run service is STILL missing after \"deploy\" — Step 2.5 should have failed the run, not silently accepted a persistent 404."
elif ! grep -q 'reconciliation FAILED and the deploy is already live' "$ERR19A"; then
  fail "first-deploy-not-found: Step 2.5 did not fail loudly on the still-missing service post-deploy — a 404 there must stay fatal. stderr was:"
  cat "$ERR19A" >&2
elif grep -q 'Deploy complete.' "$OUT19A"; then
  fail "first-deploy-not-found: deploy.sh printed 'Deploy complete.' despite the post-deploy reconciliation failing."
else
  pass "first-deploy-not-found: Step 1.6 tolerates a NOT_FOUND before publishing (op-firebase-deploy reached, rc=$RC19A), and Step 2.5 still fails loud if the service is STILL missing after deploy."
fi

# ---------------------------------------------------------------------------
# Case 19a2 (#768 Phase 4b P2): gcloud also reports a missing Cloud Run
# service as `Cannot find service [name]` rather than the structured NOT_FOUND
# enum. The pre-publish first-deploy allowance must recognise that actual
# diagnostic without treating a generic shell "command not found" as safe.
# ---------------------------------------------------------------------------
REPO19A2="$WORKDIR/case19a2-first-deploy-cannot-find-service"
init_fixture_repo "$REPO19A2"
OUT19A2="$WORKDIR/case19a2.out"
ERR19A2="$WORKDIR/case19a2.err"
: >"$WORKDIR/ofd-calls-19a2.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-19a2.log" \
NPM_LOG="$WORKDIR/npm-calls-19a2.log" \
GCLOUD_STUB_EXIT=1 \
GCLOUD_STUB_ERROR_TEXT='ERROR: (gcloud.run.services.describe) Cannot find service [emailunsubscribe]' \
  bash -c "cd '$REPO19A2' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT19A2" 2>"$ERR19A2"
RC19A2=$?
set -e

if ! grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-19a2.log"; then
  fail "first-deploy-cannot-find-service: deploy.sh never reached op-firebase-deploy — Step 1.6 rejected gcloud's normal missing-service diagnostic. stderr was:"
  cat "$ERR19A2" >&2
elif [[ $RC19A2 -eq 0 ]]; then
  fail "first-deploy-cannot-find-service: deploy.sh returned 0 even though the service remained missing after the stubbed deploy — Step 2.5 must still fail loud."
elif ! grep -q 'does not exist yet' "$ERR19A2"; then
  fail "first-deploy-cannot-find-service: the normal gcloud missing-service diagnostic was not explained as a first deploy. stderr was:"
  cat "$ERR19A2" >&2
else
  pass "first-deploy-cannot-find-service: Step 1.6 accepts gcloud's normal missing-service diagnostic, while Step 2.5 still fails if it persists (rc=$RC19A2)."
fi

# ---------------------------------------------------------------------------
# Case 19b (#768 r5 — Codex P2): --allow-missing narrows what counts as
# "absent", not what counts as "fine" — a NON-NOT_FOUND describe failure
# (credential/permission) at Step 1.6 must still abort BEFORE publishing,
# exactly as before this round. Same shape as case 19a but with a
# PERMISSION_DENIED-flavored error instead of NOT_FOUND, to prove the new
# --allow-missing flag added in this round does not accidentally widen its
# net to swallow a real credential problem.
# ---------------------------------------------------------------------------
REPO19B="$WORKDIR/case19b-permission-denied"
init_fixture_repo "$REPO19B"
OUT19B="$WORKDIR/case19b.out"
ERR19B="$WORKDIR/case19b.err"
: >"$WORKDIR/ofd-calls-19b.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-19b.log" \
NPM_LOG="$WORKDIR/npm-calls-19b.log" \
GCLOUD_STUB_EXIT=1 \
GCLOUD_STUB_ERROR_TEXT="ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: Permission 'run.services.get' denied on resource." \
  bash -c "cd '$REPO19B' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic" \
  >"$OUT19B" 2>"$ERR19B"
RC19B=$?
set -e

if [[ $RC19B -eq 0 ]]; then
  fail "permission-denied-still-aborts: deploy.sh returned 0 though every gcloud call was denied — --allow-missing should not have swallowed a PERMISSION_DENIED. stdout was:"
  cat "$OUT19B" >&2
elif grep -q 'op-firebase-deploy' "$WORKDIR/ofd-calls-19b.log"; then
  fail "permission-denied-still-aborts: deploy.sh PUBLISHED despite a PERMISSION_DENIED on the pre-publish check — --allow-missing widened what counts as fine, not just what counts as absent."
elif ! grep -q 'NOTHING HAS BEEN PUBLISHED' "$ERR19B"; then
  fail "permission-denied-still-aborts: deploy.sh did not print the pre-publish abort banner. stderr was:"
  cat "$ERR19B" >&2
elif ! grep -q 'FAIL: could not describe Cloud Run service' "$ERR19B"; then
  fail "permission-denied-still-aborts: set-cloud-run-invoker.sh's own FAIL diagnostic did not surface. stderr was:"
  cat "$ERR19B" >&2
else
  pass "permission-denied-still-aborts: a non-NOT_FOUND describe failure still aborts BEFORE publishing (rc=$RC19B) — --allow-missing did not widen the credential check."
fi

# ---------------------------------------------------------------------------
# Case 20 (#768 Codex P1): a named deploy without deploy-mode preflight must
# still reuse the canonical project Firebase-vault key before Step 1.6. The
# regular deploy wrapper already finds that key itself; making the precheck
# depend on a separate ambient ADC chain would abort the ordinary path before
# the wrapper gets that chance.
# ---------------------------------------------------------------------------
REPO20="$WORKDIR/case20-vault-key-before-precheck"
init_fixture_repo "$REPO20"
OUT20="$WORKDIR/case20.out"
ERR20="$WORKDIR/case20.err"
OP_KEY20="$WORKDIR/case20-firebase-deployer-key.json"
: >"$WORKDIR/ofd-calls-20.log"
: >"$WORKDIR/ofd-credential-20.log"
: >"$WORKDIR/op-calls-20.log"
cat >"$OP_KEY20" <<'JSON'
{
  "type": "service_account",
  "project_id": "gaycruisebingo",
  "private_key_id": "placeholder",
  "private_key": "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-deployer@gaycruisebingo.iam.gserviceaccount.com",
  "client_id": "000000000000000000000",
  "token_uri": "https://oauth2.googleapis.com/token"
}
JSON

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-20.log" \
OFD_CREDENTIAL_LOG="$WORKDIR/ofd-credential-20.log" \
OP_LOG="$WORKDIR/op-calls-20.log" \
OP_VAULT_SA_KEY="$OP_KEY20" \
  bash -c "cd '$REPO20' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo" \
  >"$OUT20" 2>"$ERR20"
RC20=$?
set -e
MATERIALIZED_KEY20="$(tail -n 1 "$WORKDIR/ofd-credential-20.log")"

if [[ $RC20 -ne 0 ]]; then
  fail "vault-key-before-precheck: a named deploy without deploy preflight returned $RC20. stderr was:"
  cat "$ERR20" >&2
elif ! grep -q 'document' "$WORKDIR/op-calls-20.log" || ! grep -q 'gaycruisebingo' "$WORKDIR/op-calls-20.log"; then
  fail "vault-key-before-precheck: deploy.sh did not request gaycruisebingo's Firebase-vault key before the invoker check. op log was:"
  cat "$WORKDIR/op-calls-20.log" >&2
elif [[ -z "$MATERIALIZED_KEY20" ]]; then
  fail "vault-key-before-precheck: op-firebase-deploy did not inherit the materialized credential."
elif [[ -e "$MATERIALIZED_KEY20" ]]; then
  fail "vault-key-before-precheck: the temporary Firebase-vault key was not removed after deploy.sh exited: $MATERIALIZED_KEY20"
elif ! grep -q 'Loaded the project Firebase-vault deploy credential' "$ERR20"; then
  fail "vault-key-before-precheck: deploy.sh did not report that it loaded the canonical deploy credential. stderr was:"
  cat "$ERR20" >&2
else
  pass "vault-key-before-precheck: a named deploy without preflight reuses and removes the project Firebase-vault key before checking the invoker (rc=$RC20)."
fi

# ---------------------------------------------------------------------------
# Case 21 (#768 Codex P2): a first scoped emailUnsubscribe deploy must never
# inspect submitbugreport. If that unrelated service has not been created yet,
# its NOT_FOUND would otherwise make a successful targeted deployment fail.
# ---------------------------------------------------------------------------
REPO21="$WORKDIR/case21-scoped-email-first-deploy"
init_fixture_repo "$REPO21"
OUT21="$WORKDIR/case21.out"
ERR21="$WORKDIR/case21.err"
: >"$WORKDIR/ofd-calls-21.log"
: >"$WORKDIR/gcloud-calls-21.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-21.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-21.log" \
GCLOUD_MISSING_SERVICE=submitbugreport \
  bash -c "cd '$REPO21' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:emailUnsubscribe" \
  >"$OUT21" 2>"$ERR21"
RC21=$?
set -e

if [[ $RC21 -ne 0 ]]; then
  fail "scoped-email-first-deploy: a targeted emailUnsubscribe deployment returned $RC21 because submitbugreport is absent. stderr was:"
  cat "$ERR21" >&2
elif grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-21.log"; then
  fail "scoped-email-first-deploy: deploy.sh inspected unrelated submitbugreport despite --only functions:emailUnsubscribe. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-21.log" >&2
elif ! grep -q 'emailunsubscribe' "$WORKDIR/gcloud-calls-21.log"; then
  fail "scoped-email-first-deploy: deploy.sh did not inspect the selected emailunsubscribe service. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-21.log" >&2
else
  pass "scoped-email-first-deploy: an emailUnsubscribe-only first deploy never touches unrelated submitbugreport (rc=$RC21)."
fi

# ---------------------------------------------------------------------------
# Case 22 (#548): a full Functions deploy reconciles BOTH auth-handoff services.
#
# The handoff callables are the first endpoints where a missed reconciliation
# breaks authentication itself rather than one feature: an `allUsers` binding
# rejected by the org policy leaves mintAuthHandoff and exchangeAuthHandoff
# 403ing, and sign-in on every Event origin fails. Firebase reports that as a
# PARTIAL deploy failure, which is precisely why this must be asserted rather
# than assumed.
# ---------------------------------------------------------------------------
REPO22="$WORKDIR/case22-auth-handoff"
init_fixture_repo "$REPO22"
OUT22="$WORKDIR/case22.out"
ERR22="$WORKDIR/case22.err"
: >"$WORKDIR/ofd-calls-22.log"
: >"$WORKDIR/gcloud-calls-22.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22.log" \
  bash -c "cd '$REPO22' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions" \
  >"$OUT22" 2>"$ERR22"
RC22=$?
set -e

if [[ $RC22 -ne 0 ]]; then
  fail "auth-handoff: a full Functions deploy returned $RC22. stderr was:"
  cat "$ERR22" >&2
elif ! grep -q 'mintauthhandoff' "$WORKDIR/gcloud-calls-22.log"; then
  fail "auth-handoff: deploy.sh never reconciled mintauthhandoff — sign-in would 403 after this deploy. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22.log" >&2
elif ! grep -q 'exchangeauthhandoff' "$WORKDIR/gcloud-calls-22.log"; then
  fail "auth-handoff: deploy.sh never reconciled exchangeauthhandoff — the exchange half would 403. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22.log" >&2
else
  pass "auth-handoff: a full Functions deploy reconciles both handoff services (rc=$RC22)."
fi

# ---------------------------------------------------------------------------
# Case 22b (#548): naming EITHER handoff endpoint reconciles the PAIR.
#
# Selecting one half releases a function whose partner must stay reachable for
# sign-in to work at all, so an exact `functions:mintAuthHandoff` scope is a
# selection of both services rather than of the one named.
# ---------------------------------------------------------------------------
REPO22B="$WORKDIR/case22b-auth-handoff-scoped"
init_fixture_repo "$REPO22B"
OUT22B="$WORKDIR/case22b.out"
ERR22B="$WORKDIR/case22b.err"
: >"$WORKDIR/ofd-calls-22b.log"
: >"$WORKDIR/gcloud-calls-22b.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22b.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22b.log" \
  bash -c "cd '$REPO22B' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:mintAuthHandoff" \
  >"$OUT22B" 2>"$ERR22B"
RC22B=$?
set -e

if [[ $RC22B -ne 0 ]]; then
  fail "auth-handoff-scoped: deploy.sh returned $RC22B. stderr was:"
  cat "$ERR22B" >&2
elif ! grep -q 'exchangeauthhandoff' "$WORKDIR/gcloud-calls-22b.log"; then
  fail "auth-handoff-scoped: --only functions:mintAuthHandoff did not reconcile the exchange half. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22b.log" >&2
elif grep -q 'submitbugreport' "$WORKDIR/gcloud-calls-22b.log"; then
  fail "auth-handoff-scoped: deploy.sh inspected unrelated submitbugreport despite an exact handoff scope. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22b.log" >&2
else
  pass "auth-handoff-scoped: naming one handoff endpoint reconciles both services and nothing else (rc=$RC22B)."
fi

# ---------------------------------------------------------------------------
# Case 22c (#548 Codex P2 round 3): a scoped FIRST deploy of one handoff half
# must not fail on the partner that does not exist yet.
#
# `--only functions:mintAuthHandoff` is a scoped deploy — it does not create
# exchangeAuthHandoff — so on a first scoped deploy the partner service is
# genuinely absent. Reconciling the pair strictly would fail on that NOT_FOUND
# and exit deploy.sh nonzero even though Firebase succeeded: a false failure on
# a correct deploy. Naming one half therefore reconciles the pair leniently.
# ---------------------------------------------------------------------------
REPO22C="$WORKDIR/case22c-auth-handoff-partner-absent"
init_fixture_repo "$REPO22C"
OUT22C="$WORKDIR/case22c.out"
ERR22C="$WORKDIR/case22c.err"
: >"$WORKDIR/ofd-calls-22c.log"
: >"$WORKDIR/gcloud-calls-22c.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22c.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22c.log" \
GCLOUD_MISSING_SERVICE="exchangeauthhandoff" \
  bash -c "cd '$REPO22C' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:mintAuthHandoff" \
  >"$OUT22C" 2>"$ERR22C"
RC22C=$?
set -e

if [[ $RC22C -ne 0 ]]; then
  fail "auth-handoff-partner-absent: a scoped first deploy returned $RC22C because the unselected partner does not exist yet. stderr was:"
  cat "$ERR22C" >&2
elif ! grep -q 'mintauthhandoff' "$WORKDIR/gcloud-calls-22c.log"; then
  fail "auth-handoff-partner-absent: the SELECTED half was never reconciled. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22c.log" >&2
else
  pass "auth-handoff-partner-absent: a scoped first deploy tolerates the absent partner and still reconciles the selected half (rc=$RC22C)."
fi

# ---------------------------------------------------------------------------
# Case 22d (#548 Codex P2 round 3): a FULL Functions deploy stays strict.
#
# The leniency above is scoped to a partial selection. A whole-`functions`
# deploy releases both halves, so a service still missing afterwards is a real
# failure and must not be swallowed — otherwise the lenient path would quietly
# become the only path and a 403ing callable would ship green.
# ---------------------------------------------------------------------------
REPO22D="$WORKDIR/case22d-auth-handoff-strict"
init_fixture_repo "$REPO22D"
OUT22D="$WORKDIR/case22d.out"
ERR22D="$WORKDIR/case22d.err"
: >"$WORKDIR/ofd-calls-22d.log"
: >"$WORKDIR/gcloud-calls-22d.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22d.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22d.log" \
GCLOUD_MISSING_SERVICE="exchangeauthhandoff" \
  bash -c "cd '$REPO22D' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions" \
  >"$OUT22D" 2>"$ERR22D"
RC22D=$?
set -e

if [[ $RC22D -eq 0 ]]; then
  fail "auth-handoff-strict: a full Functions deploy returned 0 though exchangeauthhandoff is still missing afterwards — the lenient path leaked into the strict one. stdout was:"
  cat "$OUT22D" >&2
else
  pass "auth-handoff-strict: a full Functions deploy still fails loud when a handoff service is missing after publish (rc=$RC22D)."
fi

# ---------------------------------------------------------------------------
# Case 22e (#548 Codex P2 round 4): the SELECTED half stays strict.
#
# The companion to 22c. Tolerating the absent partner must not decay into
# tolerating any absent service: if the half the deploy actually RELEASED is
# missing afterwards, that is precisely the 403 this mechanism exists to catch,
# and it must fail loud. One shared leniency bit for both services would make
# this case pass silently, which is what makes it worth pinning.
# ---------------------------------------------------------------------------
REPO22E="$WORKDIR/case22e-auth-handoff-selected-missing"
init_fixture_repo "$REPO22E"
OUT22E="$WORKDIR/case22e.out"
ERR22E="$WORKDIR/case22e.err"
: >"$WORKDIR/ofd-calls-22e.log"
: >"$WORKDIR/gcloud-calls-22e.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22e.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22e.log" \
GCLOUD_MISSING_SERVICE="mintauthhandoff" \
  bash -c "cd '$REPO22E' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:mintAuthHandoff" \
  >"$OUT22E" 2>"$ERR22E"
RC22E=$?
set -e

if [[ $RC22E -eq 0 ]]; then
  fail "auth-handoff-selected-missing: deploy.sh returned 0 though the SELECTED half is missing after publish — the partner leniency leaked onto the deployed service. stdout was:"
  cat "$OUT22E" >&2
else
  pass "auth-handoff-selected-missing: a scoped deploy still fails when the half it released is missing afterwards (rc=$RC22E)."
fi

# ---------------------------------------------------------------------------
# Case 22f (#548 Codex P1 round 4): a skipped reconciliation that RELEASED the
# handoff must say so.
#
# `scripts/deploy-target.mjs` auto-injects --skip-invoker for the fiveacross
# target — the project the handoff lives in — so this is the routine path, not
# an edge case. The skip cannot be silent: a 403 on these two callables is
# sign-in unavailable on every Event origin.
# ---------------------------------------------------------------------------
REPO22F="$WORKDIR/case22f-auth-handoff-skip-warns"
init_fixture_repo "$REPO22F"
OUT22F="$WORKDIR/case22f.out"
ERR22F="$WORKDIR/case22f.err"
: >"$WORKDIR/ofd-calls-22f.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22f.log" \
  bash -c "cd '$REPO22F' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic --skip-invoker -- fiveacross --only functions" \
  >"$OUT22F" 2>"$ERR22F"
RC22F=$?
set -e

if [[ $RC22F -ne 0 ]]; then
  fail "auth-handoff-skip-warns: deploy.sh returned $RC22F. stderr was:"
  cat "$ERR22F" >&2
elif ! grep -q 'RELEASED but NOT reconciled' "$ERR22F"; then
  fail "auth-handoff-skip-warns: --skip-invoker silently skipped a release that included the handoff. stderr was:"
  cat "$ERR22F" >&2
elif ! grep -q 'set-auth-handoff-invoker.sh' "$ERR22F"; then
  fail "auth-handoff-skip-warns: the warning did not name the manual repair command. stderr was:"
  cat "$ERR22F" >&2
else
  pass "auth-handoff-skip-warns: a skipped reconciliation that released the handoff warns loudly and names the repair (rc=$RC22F)."
fi

# ---------------------------------------------------------------------------
# Cases 22g / 22h (#548, CodeRabbit round 5): an EXPLICIT half name outranks the
# conservative inference, in EITHER selector order.
#
# `functions:<unfamiliar>` sets the conservative bit as a guess that the group
# might contain a handoff endpoint. Naming a half outright is a fact that it was
# released. When the guess came first it used to win, so a combined scope
# tolerated the deployed half being absent — the same hole 22e closed for simple
# scopes, reopened for combined ones. Both orders are pinned because the defect
# was order-dependent, which is exactly the kind of thing that regresses.
# ---------------------------------------------------------------------------
for combined_case in "22g:functions:someGroup,functions:mintAuthHandoff" "22h:functions:mintAuthHandoff,functions:someGroup"; do
  case_id="${combined_case%%:*}"
  scope="${combined_case#*:}"
  REPO_C="$WORKDIR/case${case_id}-combined-scope"
  init_fixture_repo "$REPO_C"
  OUT_C="$WORKDIR/case${case_id}.out"
  ERR_C="$WORKDIR/case${case_id}.err"
  : >"$WORKDIR/ofd-calls-${case_id}.log"

  set +e
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-${case_id}.log" \
  GCLOUD_MISSING_SERVICE="mintauthhandoff" \
    bash -c "cd '$REPO_C' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only $scope" \
    >"$OUT_C" 2>"$ERR_C"
  RC_C=$?
  set -e

  if [[ $RC_C -eq 0 ]]; then
    fail "combined-scope ($case_id, --only $scope): returned 0 though the explicitly named mintauthhandoff is missing — the conservative guess outranked the explicit name. stdout was:"
    cat "$OUT_C" >&2
  else
    pass "combined-scope ($case_id, --only $scope): an explicitly named half stays strict despite an unfamiliar selector in the same scope (rc=$RC_C)."
  fi
done

# ---------------------------------------------------------------------------
# Case 22i (#548, Codex P2 round 5): the codebase-qualified scope stays strict.
#
# Firebase accepts BOTH `functions:<fn>` and `functions:<codebase>:<fn>` for a
# scoped function deploy. Matching only the short form sent the qualified one
# into the unfamiliar-selector arm, where both halves went lenient — so the
# service the operator explicitly scoped could vanish unnoticed.
# ---------------------------------------------------------------------------
REPO22I="$WORKDIR/case22i-codebase-qualified"
init_fixture_repo "$REPO22I"
OUT22I="$WORKDIR/case22i.out"
ERR22I="$WORKDIR/case22i.err"
: >"$WORKDIR/ofd-calls-22i.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22i.log" \
GCLOUD_MISSING_SERVICE="mintauthhandoff" \
  bash -c "cd '$REPO22I' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:default:mintAuthHandoff" \
  >"$OUT22I" 2>"$ERR22I"
RC22I=$?
set -e

if [[ $RC22I -eq 0 ]]; then
  fail "codebase-qualified: --only functions:default:mintAuthHandoff returned 0 though the scoped mintauthhandoff is missing — the qualified form bypassed strict-half tracking. stdout was:"
  cat "$OUT22I" >&2
else
  pass "codebase-qualified: functions:<codebase>:<fn> keeps the scoped half strict (rc=$RC22I)."
fi

# ---------------------------------------------------------------------------
# Case 22j (#548, Codex P2 round 5): endpoint-qualified --except relaxes nothing.
#
# Firebase's --except subtracts exact TOP-LEVEL target names, so
# `--except functions:mintAuthHandoff` subtracts nothing from `functions` and
# the complete Functions target is still released — including the endpoint the
# operator believed they excluded. Treating it as an exclusion would swallow a
# NOT_FOUND on a service Firebase was actually asked to deploy.
# ---------------------------------------------------------------------------
REPO22J="$WORKDIR/case22j-except-not-a-filter"
init_fixture_repo "$REPO22J"
OUT22J="$WORKDIR/case22j.out"
ERR22J="$WORKDIR/case22j.err"
: >"$WORKDIR/ofd-calls-22j.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22j.log" \
GCLOUD_MISSING_SERVICE="mintauthhandoff" \
  bash -c "cd '$REPO22J' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --except functions:mintAuthHandoff" \
  >"$OUT22J" 2>"$ERR22J"
RC22J=$?
set -e

if [[ $RC22J -eq 0 ]]; then
  fail "except-not-a-filter: --except functions:mintAuthHandoff returned 0 though mintauthhandoff is missing and Firebase still released it. stdout was:"
  cat "$OUT22J" >&2
else
  pass "except-not-a-filter: an endpoint-qualified --except keeps both halves strict (rc=$RC22J)."
fi

# The same vendored filter applies to every endpoint, not only the handoff
# pair. Short and codebase-qualified `functions:<...>:<endpoint>` exclusions
# are still unequal to the top-level `functions` target, so ordinary
# postdeploy repair must stay selected.
for except_endpoint_case in \
  "22jb:functions:submitBugReport:submitbugreport" \
  "22jc:functions:default:submitBugReport:submitbugreport" \
  "22jd:functions:emailUnsubscribe:emailunsubscribe" \
  "22je:functions:default:emailUnsubscribe:emailunsubscribe"; do
  case_id="${except_endpoint_case%%:*}"
  case_tail="${except_endpoint_case#*:}"
  selector="${case_tail%:*}"
  service="${case_tail##*:}"
  REPO_EXCEPT="$WORKDIR/case${case_id}-except-not-a-filter"
  init_fixture_repo "$REPO_EXCEPT"
  OUT_EXCEPT="$WORKDIR/case${case_id}.out"
  ERR_EXCEPT="$WORKDIR/case${case_id}.err"
  : >"$WORKDIR/ofd-calls-${case_id}.log"

  set +e
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-${case_id}.log" \
  GCLOUD_MISSING_SERVICE="$service" \
    bash -c "cd '$REPO_EXCEPT' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --except $selector" \
    >"$OUT_EXCEPT" 2>"$ERR_EXCEPT"
  RC_EXCEPT=$?
  set -e

  if [[ $RC_EXCEPT -eq 0 ]]; then
    fail "except-not-a-filter ($case_id, $selector): returned 0 though $service is missing and Firebase still released it. stdout was:"
    cat "$OUT_EXCEPT" >&2
  else
    pass "except-not-a-filter ($case_id, $selector): endpoint-qualified --except keeps ordinary invoker repair strict (rc=$RC_EXCEPT)."
  fi
done

# ---------------------------------------------------------------------------
# Case 22k (#548, Codex P2 round 6): `--only functions:default` is a FULL
# Functions release and must stay strict.
#
# This repo has one Firebase codebase, `default`, so naming it carries no
# endpoint filter and releases both handoff callables exactly like the bare
# `functions` scope. Falling through to the unfamiliar-selector arm made it
# conservative, which could report success over a released service that was
# missing. This pins `--only functions:default` independently of the opposite
# `--except functions:default` spelling, which Firebase treats as a no-op.
# ---------------------------------------------------------------------------
REPO22K="$WORKDIR/case22k-default-codebase"
init_fixture_repo "$REPO22K"
OUT22K="$WORKDIR/case22k.out"
ERR22K="$WORKDIR/case22k.err"
: >"$WORKDIR/ofd-calls-22k.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22k.log" \
GCLOUD_MISSING_SERVICE="exchangeauthhandoff" \
  bash -c "cd '$REPO22K' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions:default" \
  >"$OUT22K" 2>"$ERR22K"
RC22K=$?
set -e

if [[ $RC22K -eq 0 ]]; then
  fail "default-codebase: --only functions:default returned 0 though a released handoff service is missing — the whole-codebase scope went conservative. stdout was:"
  cat "$OUT22K" >&2
else
  pass "default-codebase: --only functions:default keeps both handoff halves strict (rc=$RC22K)."
fi

# ---------------------------------------------------------------------------
# Case 22l (#548, Codex P2 round 8): a BARE deploy.sh invocation still pins the
# reconciliation project.
#
# DEPLOY_TARGET_PROJECT is set only by scripts/deploy-target.mjs. The documented
# `scripts/deploy.sh -- <project>` entry point leaves it unset, so without a
# DEPLOY_PROJECT fallback the handoff wrapper falls back to its OWN default —
# `fiveacross`, unlike its siblings' `gaycruisebingo` — and reconciles the wrong
# project while the callables just deployed stay 403.
# ---------------------------------------------------------------------------
REPO22L="$WORKDIR/case22l-bare-project-pin"
init_fixture_repo "$REPO22L"
OUT22L="$WORKDIR/case22l.out"
ERR22L="$WORKDIR/case22l.err"
: >"$WORKDIR/ofd-calls-22l.log"
: >"$WORKDIR/gcloud-calls-22l.log"

set +e
PATH="$STUB_DIR:$PATH" \
OFD_LOG="$WORKDIR/ofd-calls-22l.log" \
GCLOUD_LOG="$WORKDIR/gcloud-calls-22l.log" \
  bash -c "cd '$REPO22L' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only functions" \
  >"$OUT22L" 2>"$ERR22L"
RC22L=$?
set -e

if [[ $RC22L -ne 0 ]]; then
  fail "bare-project-pin: deploy.sh returned $RC22L. stderr was:"
  cat "$ERR22L" >&2
elif grep -q 'fiveacross' "$WORKDIR/gcloud-calls-22l.log"; then
  fail "bare-project-pin: a bare gaycruisebingo deploy reconciled fiveacross — the handoff wrapper's own default leaked through. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22l.log" >&2
elif ! grep -q 'mintauthhandoff' "$WORKDIR/gcloud-calls-22l.log"; then
  fail "bare-project-pin: the handoff services were never reconciled at all. gcloud log was:"
  cat "$WORKDIR/gcloud-calls-22l.log" >&2
else
  pass "bare-project-pin: a bare deploy.sh invocation pins every wrapper to the resolved deploy project (rc=$RC22L)."
fi

# ---------------------------------------------------------------------------
# Cases 22m–22p (#854): codebase-qualified exact names outrank conservative
# inference for the standalone invoker endpoints, in EITHER selector order.
#
# Firebase accepts `functions:<codebase>:<fn>` for a scoped function deploy.
# If that exact spelling falls through to the unfamiliar-selector arm, a
# missing service is tolerated as a conservative guess even though Firebase
# was explicitly asked to release it. Combining it with another unfamiliar
# selector pins the same order-independence contract as 22g/22h for both
# submitBugReport and emailUnsubscribe.
# ---------------------------------------------------------------------------
for qualified_case in \
  "22m:submitBugReport:submitbugreport:functions:someGroup,functions:default:submitBugReport" \
  "22n:submitBugReport:submitbugreport:functions:default:submitBugReport,functions:someGroup" \
  "22o:emailUnsubscribe:emailunsubscribe:functions:someGroup,functions:default:emailUnsubscribe" \
  "22p:emailUnsubscribe:emailunsubscribe:functions:default:emailUnsubscribe,functions:someGroup"; do
  IFS=: read -r case_id endpoint service scope <<< "$qualified_case"
  REPO_C="$WORKDIR/case${case_id}-qualified-${endpoint}"
  init_fixture_repo "$REPO_C"
  OUT_C="$WORKDIR/case${case_id}.out"
  ERR_C="$WORKDIR/case${case_id}.err"
  : >"$WORKDIR/ofd-calls-${case_id}.log"

  set +e
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-${case_id}.log" \
  GCLOUD_MISSING_SERVICE="$service" \
    bash -c "cd '$REPO_C' && bash '$SCRIPT' --force --skip-build --skip-cf-purge --skip-synthetic -- gaycruisebingo --only $scope" \
    >"$OUT_C" 2>"$ERR_C"
  RC_C=$?
  set -e

  if [[ $RC_C -eq 0 ]]; then
    fail "qualified standalone scope ($case_id, --only $scope): returned 0 though explicitly named $service is missing. stdout was:"
    cat "$OUT_C" >&2
  else
    pass "qualified standalone scope ($case_id, --only $scope): explicitly named $endpoint stays strict regardless of selector order (rc=$RC_C)."
  fi
done

# ---------------------------------------------------------------------------
# Cases 23a-23z (#852): named Five Across readiness is owned by this canonical
# deploy boundary, after its one argument/scope parse and source guard but
# before BUILD_CMD or op-firebase-deploy. It runs only when Hosting or an auth-
# handoff Function may be released. These cases execute deploy.sh itself with
# the real readiness wrapper and a PATH-stubbed gcloud; the forced `update` is
# therefore the observable proof that the hook ran.
# ---------------------------------------------------------------------------
run_readiness_scope_case() {
  local case_id="$1"
  local expected="$2"
  shift 2
  local repo="$WORKDIR/case${case_id}-readiness-scope"
  local out="$WORKDIR/case${case_id}.out"
  local err="$WORKDIR/case${case_id}.err"
  local gcloud_log="$WORKDIR/gcloud-calls-${case_id}.log"
  local ofd_log="$WORKDIR/ofd-calls-${case_id}.log"
  init_fixture_repo "$repo"
  : >"$gcloud_log"
  : >"$ofd_log"

  set +e
  (
    cd "$repo"
    PATH="$STUB_DIR:$PATH" \
    OFD_LOG="$ofd_log" \
    GCLOUD_BIN="$STUB_DIR/gcloud" \
    GCLOUD_LOG="$gcloud_log" \
    GCLOUD_STUB_ANNOTATION=true \
    GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
    AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
    DEPLOY_TARGET_PROJECT=fiveacross \
    BUILD_CMD=: \
      bash "$SCRIPT" --force --skip-cf-purge --skip-synthetic -- fiveacross "$@"
  ) >"$out" 2>"$err"
  local rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    fail "readiness-scope ($case_id, $*): deploy.sh returned $rc. stderr was:"
    cat "$err" >&2
  elif [[ "$expected" == "required" ]] && ! grep -qw update "$gcloud_log"; then
    fail "readiness-scope ($case_id, $*): selected Hosting/handoff work but forced readiness never ran. gcloud log was:"
    cat "$gcloud_log" >&2
  elif [[ "$expected" == "skipped" ]] && grep -qw update "$gcloud_log"; then
    fail "readiness-scope ($case_id, $*): unrelated work unexpectedly mutated auth-handoff readiness. gcloud log was:"
    cat "$gcloud_log" >&2
  else
    pass "readiness-scope ($case_id, $*): readiness was $expected for this exact Firebase scope (rc=$rc)."
  fi
}

run_readiness_scope_case 23a required --only hosting
run_readiness_scope_case 23b required --only functions
run_readiness_scope_case 23c required --only functions:default
run_readiness_scope_case 23d required --only functions:mintAuthHandoff
run_readiness_scope_case 23e required --only functions:default:exchangeAuthHandoff
run_readiness_scope_case 23f required --only functions:someGroup
run_readiness_scope_case 23g required --only firestore,functions:mintAuthHandoff
run_readiness_scope_case 23h required --only functions:mintAuthHandoff,firestore
run_readiness_scope_case 23i required --except functions:mintAuthHandoff
run_readiness_scope_case 23j required --except hosting
run_readiness_scope_case 23k required --except functions
run_readiness_scope_case 23l skipped --only firestore
run_readiness_scope_case 23m skipped --only storage
run_readiness_scope_case 23n skipped --only functions:emailUnsubscribe
run_readiness_scope_case 23o skipped --only functions:default:submitBugReport
run_readiness_scope_case 23p skipped --except hosting,functions
run_readiness_scope_case 23u required --only hosting --except hosting
run_readiness_scope_case 23v required --except hosting --only hosting
run_readiness_scope_case 23w required --only functions:mintAuthHandoff --except functions
run_readiness_scope_case 23x required --except functions --only functions:default:exchangeAuthHandoff
run_readiness_scope_case 23y skipped --only firestore --except hosting,functions
run_readiness_scope_case 23z skipped --dry-run --only hosting --except hosting

# The source guard must fail before the readiness process can make a Cloud Run
# update. This fixture deliberately stays on feature/deploy-test and omits
# --force, so reaching gcloud or Firebase would prove the hook moved ahead of
# the canonical guard.
REPO23Q="$WORKDIR/case23q-readiness-after-guard"
init_fixture_repo "$REPO23Q"
: >"$WORKDIR/gcloud-calls-23q.log"
: >"$WORKDIR/ofd-calls-23q.log"
set +e
(
  cd "$REPO23Q"
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-23q.log" \
  GCLOUD_BIN="$STUB_DIR/gcloud" \
  GCLOUD_LOG="$WORKDIR/gcloud-calls-23q.log" \
  GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
  AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
  DEPLOY_TARGET_PROJECT=fiveacross \
  BUILD_CMD=: \
    bash "$SCRIPT" --skip-cf-purge --skip-synthetic -- fiveacross --only hosting
) >"$WORKDIR/case23q.out" 2>"$WORKDIR/case23q.err"
RC23Q=$?
set -e
if [[ $RC23Q -eq 0 ]]; then
  fail "readiness-after-guard: a feature checkout unexpectedly passed the canonical source guard."
elif [[ -s "$WORKDIR/gcloud-calls-23q.log" || -s "$WORKDIR/ofd-calls-23q.log" ]]; then
  fail "readiness-after-guard: readiness or Firebase ran before the failing canonical source guard."
else
  pass "readiness-after-guard: source rejection happens before readiness, build, or publish (rc=$RC23Q)."
fi

# A successful forced update must already be visible when BUILD_CMD starts;
# the same run must then reach Firebase. This pins guard -> readiness -> build
# -> publish at the real shell entry point rather than at injected call counts.
REPO23R="$WORKDIR/case23r-readiness-order"
init_fixture_repo "$REPO23R"
: >"$WORKDIR/gcloud-calls-23r.log"
: >"$WORKDIR/ofd-calls-23r.log"
set +e
(
  cd "$REPO23R"
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-23r.log" \
  GCLOUD_BIN="$STUB_DIR/gcloud" \
  GCLOUD_LOG="$WORKDIR/gcloud-calls-23r.log" \
  GCLOUD_STUB_ANNOTATION=true \
  GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
  AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
  DEPLOY_TARGET_PROJECT=fiveacross \
  BUILD_CMD="grep -qw update '$WORKDIR/gcloud-calls-23r.log'" \
    bash "$SCRIPT" --force --skip-cf-purge --skip-synthetic -- fiveacross --only hosting
) >"$WORKDIR/case23r.out" 2>"$WORKDIR/case23r.err"
RC23R=$?
set -e
if [[ $RC23R -ne 0 ]]; then
  fail "readiness-order: deploy.sh returned $RC23R. stderr was:"
  cat "$WORKDIR/case23r.err" >&2
elif ! grep -qw update "$WORKDIR/gcloud-calls-23r.log"; then
  fail "readiness-order: exact-SA forced readiness never updated both callables."
elif [[ ! -s "$WORKDIR/ofd-calls-23r.log" ]]; then
  fail "readiness-order: Firebase was never reached after readiness and build."
else
  pass "readiness-order: exact-SA forced readiness completes before BUILD_CMD and Firebase publish (rc=$RC23R)."
fi

# A readiness failure is terminal before BUILD_CMD or Firebase. The failing
# gcloud activation models an unusable exact deploy-SA key; the wrapper's own
# suite separately proves this cannot fall through to ambient ADC.
REPO23S="$WORKDIR/case23s-readiness-failure"
init_fixture_repo "$REPO23S"
: >"$WORKDIR/gcloud-calls-23s.log"
: >"$WORKDIR/ofd-calls-23s.log"
rm -f "$WORKDIR/build-ran-23s"
set +e
(
  cd "$REPO23S"
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-23s.log" \
  GCLOUD_BIN="$STUB_DIR/gcloud" \
  GCLOUD_LOG="$WORKDIR/gcloud-calls-23s.log" \
  GCLOUD_STUB_EXIT=8 \
  GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
  AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
  DEPLOY_TARGET_PROJECT=fiveacross \
  BUILD_CMD="touch '$WORKDIR/build-ran-23s'" \
    bash "$SCRIPT" --force --skip-cf-purge --skip-synthetic -- fiveacross --only hosting
) >"$WORKDIR/case23s.out" 2>"$WORKDIR/case23s.err"
RC23S=$?
set -e
if [[ $RC23S -eq 0 ]]; then
  fail "readiness-failure: deploy.sh returned 0 for failed exact-SA readiness."
elif [[ -e "$WORKDIR/build-ran-23s" || -s "$WORKDIR/ofd-calls-23s.log" ]]; then
  fail "readiness-failure: build or Firebase ran after exact-SA readiness failed."
else
  pass "readiness-failure: exact-SA readiness failure blocks BUILD_CMD and Firebase publish (rc=$RC23S)."
fi

# Every nonmutating pre-build guard must finish before readiness mutates Cloud
# Run. A missing Functions param reproduces Guard 4's hard failure and proves
# that readiness, BUILD_CMD, and Firebase all remain untouched.
REPO23T="$WORKDIR/case23t-readiness-after-param-guard"
init_fixture_repo "$REPO23T"
mkdir -p "$REPO23T/functions/src"
printf '%s\n' "import './params';" >"$REPO23T/functions/src/index.ts"
printf '%s\n' \
  "import { defineString } from 'firebase-functions/params';" \
  "export const REQUIRED_BEFORE_DEPLOY = defineString('REQUIRED_BEFORE_DEPLOY');" \
  >"$REPO23T/functions/src/params.ts"
(
  cd "$REPO23T"
  git add functions
  git commit --quiet -m "add incomplete Functions params fixture"
)
: >"$WORKDIR/gcloud-calls-23t.log"
: >"$WORKDIR/ofd-calls-23t.log"
rm -f "$WORKDIR/build-ran-23t"
set +e
(
  cd "$REPO23T"
  PATH="$STUB_DIR:$PATH" \
  OFD_LOG="$WORKDIR/ofd-calls-23t.log" \
  GCLOUD_BIN="$STUB_DIR/gcloud" \
  GCLOUD_LOG="$WORKDIR/gcloud-calls-23t.log" \
  GOOGLE_APPLICATION_CREDENTIALS="$READINESS_CREDENTIAL" \
  AUTH_HANDOFF_DEPLOY_READINESS_PROJECT=fiveacross \
  DEPLOY_TARGET_PROJECT=fiveacross \
  BUILD_CMD="touch '$WORKDIR/build-ran-23t'" \
    bash "$SCRIPT" --force --skip-cf-purge --skip-synthetic -- fiveacross --only functions
) >"$WORKDIR/case23t.out" 2>"$WORKDIR/case23t.err"
RC23T=$?
set -e
if [[ $RC23T -eq 0 ]]; then
  fail "readiness-after-param-guard: missing Functions params unexpectedly passed Guard 4."
elif ! grep -q 'REQUIRED_BEFORE_DEPLOY' "$WORKDIR/case23t.err"; then
  fail "readiness-after-param-guard: Guard 4 did not name the missing param. stderr was:"
  cat "$WORKDIR/case23t.err" >&2
elif [[ -s "$WORKDIR/gcloud-calls-23t.log" || -e "$WORKDIR/build-ran-23t" || -s "$WORKDIR/ofd-calls-23t.log" ]]; then
  fail "readiness-after-param-guard: readiness, build, or Firebase ran after Guard 4 failed."
else
  pass "readiness-after-param-guard: missing Functions params block readiness, BUILD_CMD, and Firebase (rc=$RC23T)."
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
