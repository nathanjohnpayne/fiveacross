#!/usr/bin/env bash
set -euo pipefail

# Canonical deploy wrapper for projects that use op-firebase-deploy.
#
# Enforces three guards before calling the deploy chain:
#   1. Current branch is `main`.
#   2. Local `main` exactly matches `origin/main`.
#   3. The working tree is clean (no modified or staged paths).
#
# These three guards together prevent the stale-worktree class of deploy
# (documented in https://github.com/nathanjohnpayne/mergepath/issues/77):
# an agent working in a feature branch, stale worktree, or with
# uncommitted in-progress edits accidentally deploying a dist/ output
# that does not match what reviewers have seen merged on main.
#
# After the guards pass, the script:
#   - Builds (default: `npm run build`; configurable via $BUILD_CMD).
#     The build command is run under `bash -euo pipefail -c --` so a
#     compound command (e.g. `npm run lint && npm run build`) fails
#     closed if any step errors, rather than masking earlier failures
#     behind the exit code of the final segment.
#   - Verifies the Cloud Run invoker credential BEFORE publishing, with a
#     read-only dry run of both reconciliation scripts, so a missing or
#     expired deploy credential fails the script while nothing is live.
#     Skipped entirely when this deploy does not release Functions. A
#     NOT_FOUND here is not fatal — a brand-new target's first deploy has no
#     Cloud Run service yet, so this check tolerates "absent" and only still
#     fails closed on a real credential/permission problem (#768 r5).
#   - Deploys (`op-firebase-deploy`; any arguments after `--` are passed
#     through, e.g. `--only hosting`). Its exit status is CAPTURED rather
#     than allowed to abort at `set -e`, because Firebase reports the
#     org-policy rejection of the `allUsers` invoker binding as a partial
#     FAILURE — the exact case the reconciliation below exists to repair.
#   - Reconciles the Cloud Run invoker config for submitBugReport and
#     emailUnsubscribe (#768; see docs/app/bug-reports.md § Repeat-deploy
#     hardening). Idempotent — no-ops when already correct. Runs whenever
#     this deploy could have RELEASED Functions, on success or failure; the
#     deploy's own exit status is honoured afterwards either way. Skipped —
#     mutates nothing — when the caller passed Firebase's own `--dry-run`
#     (#768 r5): nothing was released, so there is nothing to reconcile, and
#     running it anyway would let a supposedly no-op validation run flip live
#     Cloud Run IAM state.
#   - Purges Cloudflare cache (if CF_API_TOKEN + CF_ZONE_ID are set).
#
# Usage:
#   scripts/deploy.sh                       # full deploy from main
#   scripts/deploy.sh -- --only hosting     # scope the op-firebase-deploy call
#   scripts/deploy.sh --force               # bypass branch + freshness guards
#   scripts/deploy.sh --skip-build          # assume dist/ is already built
#   scripts/deploy.sh --skip-cf-purge       # skip the Cloudflare purge step
#   scripts/deploy.sh --skip-synthetic      # skip the post-deploy app-mount check
#   scripts/deploy.sh --skip-invoker        # skip the Cloud Run invoker credential
#                                           # check AND the reconciliation
#
# Environment:
#   BUILD_CMD            Build command (default: "npm run build").
#   CF_API_TOKEN         Cloudflare API token with Purge Cache permission.
#                        Typical source: 1Password (op read ...).
#   CF_ZONE_ID           Cloudflare zone ID for the project domain.
#   SYNTHETIC_URL        Origin the post-deploy synthetic loads
#                        (default: https://gaycruisebingo.com/). See #142.
#   DEPLOY_ALLOW_DIRTY   Set to "1" to bypass the clean-working-tree guard.
#                        Break-glass only — never set during routine deploys.
#                        See DEPLOYMENT.md § Deploy guards.
#   DEPLOY_TARGET_PROJECT
#                        The Firebase project this run is deploying, set by
#                        scripts/deploy-target.mjs. Pins the invoker
#                        reconciliation to the SELECTED target rather than
#                        letting an ambient BUG_REPORT_PROJECT /
#                        EMAIL_UNSUBSCRIBE_PROJECT override decide.
#
# Credentials:
#   The invoker steps (1.6 and 2.5) shell out to `gcloud`. When a named deploy
#   has no preloaded credential, this wrapper materializes the same
#   project-specific Firebase-vault service-account key that
#   `op-firebase-deploy` uses before its own work starts. Deploy preflight is
#   still useful when you want to load all credentials in one biometric burst:
#     eval "$(scripts/op-preflight.sh --agent <agent> --mode deploy)"
#   That exports GOOGLE_APPLICATION_CREDENTIALS pointing at the per-project
#   Firebase-vault SERVICE-ACCOUNT key, and `scripts/set-cloud-run-invoker.sh`
#   now consumes that key directly (activating it into a throwaway
#   CLOUDSDK_CONFIG) rather than handing it to the `scripts/gcloud/gcloud`
#   wrapper, which rejects service-account files. See that script's
#   § CREDENTIALS — a routine preflighted deploy needs no manual `unset`.
#
# See DEPLOYMENT.md § Deploy flow for full documentation.

FORCE=false
BUILD_SKIP=false
CF_PURGE_SKIP=false
SYNTHETIC_SKIP=false
INVOKER_SKIP=false
DEPLOY_ARGS=()

usage() {
  sed -n '3,54p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)         FORCE=true; shift ;;
    --skip-build)    BUILD_SKIP=true; shift ;;
    --skip-cf-purge) CF_PURGE_SKIP=true; shift ;;
    --skip-synthetic) SYNTHETIC_SKIP=true; shift ;;
    --skip-invoker)  INVOKER_SKIP=true; shift ;;
    -h|--help)       usage; exit 0 ;;
    --)              shift; DEPLOY_ARGS+=("$@"); break ;;
    *)               DEPLOY_ARGS+=("$1"); shift ;;
  esac
done

# Resolve repo-relative script paths regardless of the caller's CWD (the
# fixture-repo test harness invokes this script from a throwaway git repo
# rooted elsewhere, so `scripts/foo.sh` alone is not reliable).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=firebase/lib/credential-materialization.sh
source "$SCRIPT_DIR/firebase/lib/credential-materialization.sh"

DEPLOY_SOURCE_CRED_TMPFILE=""
DEPLOY_LOG=""
cleanup_deploy_artifacts() {
  [[ -n "$DEPLOY_SOURCE_CRED_TMPFILE" && -f "$DEPLOY_SOURCE_CRED_TMPFILE" ]] && rm -f "$DEPLOY_SOURCE_CRED_TMPFILE"
  [[ -n "$DEPLOY_LOG" && -f "$DEPLOY_LOG" ]] && rm -f "$DEPLOY_LOG"
}
trap cleanup_deploy_artifacts EXIT

# Could this deploy have RELEASED Functions? (#768 r4 Codex P1)
#
# This is the gate on both invoker steps, and it deliberately asks "could it"
# rather than "did it". The invoker annotation is reset by a SUCCESSFUL
# Functions release, which can happen long before the overall `firebase deploy`
# command exits — a multi-surface deploy that releases Functions and then fails
# on Hosting, or a Functions deploy where emailUnsubscribe updates before a
# different function errors, both end nonzero with the annotation already
# cleared. Keying the recovery on the FINAL error text therefore skipped
# reconciliation in exactly the cases that need it most.
#
# `firebase deploy` only touches Functions when `--only` names them (or when
# no `--only` is given at all), so the argument list is an exact, cheap answer
# that does not depend on what went wrong. Matching stays one-directional:
# reconciling when Functions were untouched costs one idempotent read; not
# reconciling when they were is the published-but-403 outage.
#
# The same pass also detects Firebase's OWN `--dry-run` (#768 r5 Codex P2): a
# boolean flag `firebase deploy` supports directly ("perform a dry run of your
# deployment ... without deploying any changes"), forwarded here verbatim as
# part of DEPLOY_ARGS. It is unrelated to FUNCTIONS_ATTEMPTED — a dry run can
# still name `functions` in its scope — but it gates Step 2.5 below: a dry run
# never actually releases anything, so nothing there needs reconciling, and
# running the (mutating) reconciliation anyway is the footgun a dry run exists
# to prevent.
FUNCTIONS_ATTEMPTED=true
FIREBASE_DRY_RUN=false
BUG_REPORT_INVOKER_SELECTED=true
EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=true
# An endpoint selected by an exact `functions:<endpoint>` (or the whole
# `functions` scope) MUST exist after a successful Functions deploy, so its
# post-publish reconciliation stays strict. An unfamiliar `functions:<name>`
# may instead be a codebase/group or a genuinely unrelated function; it selects
# both endpoints defensively, but records that they were inferred rather than
# named so a valid scoped first deploy is not failed by an absent service.
BUG_REPORT_INVOKER_CONSERVATIVE=false
EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
ONLY_VALUES=()
EXCEPT_VALUES=()
DEPLOY_PROJECT="${DEPLOY_TARGET_PROJECT:-}"
EXPECT_ARG=""
for arg in ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}; do
  if [[ -n "$EXPECT_ARG" ]]; then
    case "$EXPECT_ARG" in
      only)   ONLY_VALUES=("$arg") ;;
      except) EXCEPT_VALUES=("$arg") ;;
    esac
    EXPECT_ARG=""
    continue
  fi
  case "$arg" in
    --only)     EXPECT_ARG="only" ;;
    --only=*)   ONLY_VALUES=("${arg#*=}") ;;
    --except)   EXPECT_ARG="except" ;;
    --except=*) EXCEPT_VALUES=("${arg#*=}") ;;
    --message) EXPECT_ARG="message" ;;
    --dry-run) FIREBASE_DRY_RUN=true ;;
    --*) ;;
    *)
      if [[ -z "$DEPLOY_PROJECT" ]]; then
        DEPLOY_PROJECT="$arg"
      fi
      ;;
  esac
done

if [[ -z "$DEPLOY_PROJECT" && -f .firebaserc ]]; then
  DEPLOY_PROJECT="$(python3 -c "import json; print(json.load(open('.firebaserc'))['projects']['default'])")"
fi

# `--only` is an allowlist. It also tells us which of the two Cloud Run
# services could have changed: an unrelated first function deployment must not
# fail because the other service has not been created yet.
if [[ ${#ONLY_VALUES[@]} -gt 0 ]]; then
  FUNCTIONS_ATTEMPTED=false
  BUG_REPORT_INVOKER_SELECTED=false
  EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=false
  BUG_REPORT_INVOKER_CONSERVATIVE=false
  EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
  for only_value in "${ONLY_VALUES[@]}"; do
    IFS=',' read -r -a only_selectors <<< "$only_value"
    for selector in "${only_selectors[@]}"; do
      case "$selector" in
        functions)
          FUNCTIONS_ATTEMPTED=true
          BUG_REPORT_INVOKER_SELECTED=true
          EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=true
          BUG_REPORT_INVOKER_CONSERVATIVE=false
          EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
          ;;
        functions:submitBugReport)
          FUNCTIONS_ATTEMPTED=true
          BUG_REPORT_INVOKER_SELECTED=true
          BUG_REPORT_INVOKER_CONSERVATIVE=false
          ;;
        functions:emailUnsubscribe)
          FUNCTIONS_ATTEMPTED=true
          EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=true
          EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
          ;;
        # A selector after `functions:` is not necessarily a single exported
        # function. Firebase also accepts codebase and function-group selectors
        # in this position. We cannot prove that an unfamiliar selector excludes
        # either protected endpoint from this wrapper, so include both
        # conservatively. The invoker helpers are idempotent, and their
        # pre-publish `--allow-missing` path keeps a genuinely new/unrelated
        # function deploy from failing just because either service has not been
        # created yet. Skipping one here risks a released endpoint remaining 403.
        functions:*)
          FUNCTIONS_ATTEMPTED=true
          if [[ "$BUG_REPORT_INVOKER_SELECTED" != "true" ]]; then
            BUG_REPORT_INVOKER_CONSERVATIVE=true
          fi
          if [[ "$EMAIL_UNSUBSCRIBE_INVOKER_SELECTED" != "true" ]]; then
            EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=true
          fi
          BUG_REPORT_INVOKER_SELECTED=true
          EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=true
          ;;
      esac
    done
  done
fi

# `--except` removes whole Functions releases or one known invoker service.
# An unfamiliar `functions:<selector>` can be a codebase/group containing an
# endpoint, so it must be treated as excluding both protected endpoints: do
# not let an effective Hosting-only deploy be blocked by gcloud or mutate Cloud
# Run IAM for an endpoint Firebase was told not to release. This is deliberately
# the complement of unfamiliar `--only`: the allowlist includes a possible
# endpoint defensively; the subtractive selector excludes a possible endpoint
# defensively. Exact endpoint selectors keep their precise behavior below.
for except_value in ${EXCEPT_VALUES[@]+"${EXCEPT_VALUES[@]}"}; do
  IFS=',' read -r -a except_selectors <<< "$except_value"
  for selector in "${except_selectors[@]}"; do
    case "$selector" in
      functions)
        FUNCTIONS_ATTEMPTED=false
        BUG_REPORT_INVOKER_SELECTED=false
        EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=false
        BUG_REPORT_INVOKER_CONSERVATIVE=false
        EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
        ;;
      functions:submitBugReport)
        BUG_REPORT_INVOKER_SELECTED=false
        BUG_REPORT_INVOKER_CONSERVATIVE=false
        ;;
      functions:emailUnsubscribe)
        EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=false
        EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
        ;;
      functions:*)
        BUG_REPORT_INVOKER_SELECTED=false
        EMAIL_UNSUBSCRIBE_INVOKER_SELECTED=false
        BUG_REPORT_INVOKER_CONSERVATIVE=false
        EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE=false
        ;;
    esac
  done
done

# Reconciliation coordinates are PINNED to the selected deploy target, never
# inherited (#768 r4 Codex P2).
#
# scripts/set-bug-report-invoker.sh and scripts/set-email-unsubscribe-invoker.sh
# read BUG_REPORT_* / EMAIL_UNSUBSCRIBE_* overrides so an operator can point a
# MANUAL repair at another project, region, or renamed service. Those exports
# survive in a shell, and an automatic call that honoured them would reconcile
# whatever the last manual repair named: a stale `EMAIL_UNSUBSCRIBE_PROJECT=
# fiveacross` during a `gaycruisebingo` deploy makes both prechecks pass
# against Five Across and leaves the just-reset gaycruisebingo services 403ing,
# with every log line claiming success. So the automatic path clears all six
# and re-pins the project from DEPLOY_TARGET_PROJECT (set by
# scripts/deploy-target.mjs). Invoked bare, with no target selected, everything
# is cleared and each script falls back to its own documented default.
# A manual repair is unaffected — run the scripts directly, as their own
# --help documents.
INVOKER_ENV=(env
  -u BUG_REPORT_PROJECT -u BUG_REPORT_REGION -u BUG_REPORT_SERVICE
  -u EMAIL_UNSUBSCRIBE_PROJECT -u EMAIL_UNSUBSCRIBE_REGION -u EMAIL_UNSUBSCRIBE_SERVICE
)
if [[ -n "${DEPLOY_TARGET_PROJECT:-}" ]]; then
  INVOKER_ENV+=(
    BUG_REPORT_PROJECT="$DEPLOY_TARGET_PROJECT"
    EMAIL_UNSUBSCRIBE_PROJECT="$DEPLOY_TARGET_PROJECT"
  )
fi
run_invoker() { "${INVOKER_ENV[@]}" "$@"; }

# A post-deploy `--allow-missing` is normally wrong: an endpoint explicitly
# selected for Functions release must exist once Firebase returns. The one
# exception is an endpoint selected only because an unfamiliar
# `functions:<selector>` might be a group/codebase containing it. That
# conservative probe must not make a valid unrelated first deploy fail on a
# service Firebase had no reason to create; credential and permission failures
# remain fatal because set-cloud-run-invoker only tolerates its narrowly
# matched missing-service diagnostics.
run_postdeploy_invoker() {
  local invoker_script="$1"
  local selected_conservatively="$2"
  if [[ "$selected_conservatively" == "true" ]]; then
    run_invoker "$invoker_script" --allow-missing
  else
    run_invoker "$invoker_script"
  fi
}

INVOKER_SCRIPTS=()
if [[ "$BUG_REPORT_INVOKER_SELECTED" == "true" ]]; then
  INVOKER_SCRIPTS+=("$SCRIPT_DIR/set-bug-report-invoker.sh")
fi
if [[ "$EMAIL_UNSUBSCRIBE_INVOKER_SELECTED" == "true" ]]; then
  INVOKER_SCRIPTS+=("$SCRIPT_DIR/set-email-unsubscribe-invoker.sh")
fi

resolve_invoker_deploy_credential() {
  [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] && return 0
  [[ -n "$DEPLOY_PROJECT" ]] || return 0

  local credential=""
  credential="$(firebase_materialize_vault_sa_key "$DEPLOY_PROJECT" || true)"
  if [[ -n "$credential" ]]; then
    DEPLOY_SOURCE_CRED_TMPFILE="$credential"
    export GOOGLE_APPLICATION_CREDENTIALS="$credential"
    echo "   Loaded the project Firebase-vault deploy credential for the invoker check." >&2
  fi
}

# Guard 1: must be on main
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: deploying from '$CURRENT_BRANCH' (not main)" >&2
  else
    cat >&2 <<EOF
Refusing to deploy: current branch is '$CURRENT_BRANCH', not 'main'.

Deploys should ship main's state — the site must match what reviewers
have seen in merged PRs. Worktrees and feature branches are routinely
behind main and will silently ship stale builds (see mergepath#77).

To override (break-glass only): scripts/deploy.sh --force
EOF
    exit 1
  fi
fi

# Guard 2: must exactly match origin/main
# Fail closed on fetch failure — stale origin/main metadata would
# silently defeat the freshness check and re-open the exact class
# of failure #77 closes.
if ! git fetch --quiet origin main 2>/dev/null; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: git fetch failed; skipping freshness verification" >&2
  else
    cat >&2 <<EOF
Refusing to deploy: 'git fetch origin main' failed, so freshness
against origin/main cannot be verified.

Network down? Try again once connectivity is restored.

To override (break-glass only): scripts/deploy.sh --force
EOF
    exit 1
  fi
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  if [[ "$FORCE" == "true" ]]; then
    echo "⚠️  --force: origin/main is unavailable after fetch; skipping exact-match verification" >&2
  else
    cat >&2 <<EOF
Refusing to deploy: origin/main is unavailable after fetch, so the exact
merged commit cannot be verified.

To override (break-glass only): scripts/deploy.sh --force
EOF
    exit 1
  fi
else
  LOCAL_HEAD="$(git rev-parse HEAD)"
  ORIGIN_HEAD="$(git rev-parse origin/main)"
  if [[ "$LOCAL_HEAD" != "$ORIGIN_HEAD" ]]; then
    BEHIND="$(git rev-list --count HEAD..origin/main)"
    AHEAD="$(git rev-list --count origin/main..HEAD)"
    if [[ "$FORCE" == "true" ]]; then
      echo "⚠️  --force: deploying local main that differs from origin/main ($AHEAD ahead, $BEHIND behind)" >&2
    else
      cat >&2 <<EOF
Refusing to deploy: local main does not exactly match origin/main
($AHEAD commit(s) ahead, $BEHIND commit(s) behind).

Deploys must ship the reviewed, merged origin/main commit. Push or discard
local-only commits, then run: git pull --ff-only && scripts/deploy.sh

To override (break-glass only): scripts/deploy.sh --force
EOF
      exit 1
    fi
  fi
fi

# Guard 3: working tree must be clean
#
# `git status --porcelain` prints one line per modified, staged, or
# untracked path and is empty when the worktree matches HEAD with the
# index. Deploying from a dirty tree silently ships whatever the
# in-progress edits compile to — that diverges from the merged-on-main
# state that reviewers signed off on (same failure class as #77).
#
# Break-glass override: DEPLOY_ALLOW_DIRTY=1 (env var, not a flag, so
# `--force` doesn't accidentally subsume this guard — keeping the
# override deliberate and audit-greppable). Logged with a clear ⚠️
# trail when used.
DIRTY="$(git status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  if [[ "${DEPLOY_ALLOW_DIRTY:-0}" == "1" ]]; then
    echo "⚠️  DEPLOY_ALLOW_DIRTY=1: deploying with uncommitted changes:" >&2
    printf '%s\n' "$DIRTY" >&2
  else
    cat >&2 <<EOF
Refusing to deploy: working tree is dirty.

Modified / staged / untracked paths:
$DIRTY

Commit, stash, or revert these before deploying so the deploy reflects
the merged-on-main state that reviewers approved (see mergepath#77 for
the class of failure this guard closes).

To override (break-glass only): DEPLOY_ALLOW_DIRTY=1 scripts/deploy.sh
EOF
    exit 1
  fi
fi

# Step 1: Build
if [[ "$BUILD_SKIP" == "true" ]]; then
  echo ">> Skipping build (--skip-build)"
else
  BUILD_CMD="${BUILD_CMD:-npm run build}"
  echo ">> Building: $BUILD_CMD"
  # Use `bash -euo pipefail -c --` so BUILD_CMD is parsed as a shell
  # command string in a controlled subshell rather than `eval`'d in
  # the current shell (cheap defense against environment injection
  # from whatever source populated BUILD_CMD), AND so compound
  # commands fail closed:
  #   - `set -e`: any failing step aborts the subshell.
  #   - `set -u`: unset variables are an error (catches typos in
  #     BUILD_CMD that would otherwise silently expand to empty).
  #   - `set -o pipefail`: a failing step in a pipeline is preserved,
  #     not masked by the success of the final stage.
  # Without these flags, a BUILD_CMD like `npm run lint && npm run
  # build` would still fail if lint failed (because && short-circuits)
  # — but `npm run lint; npm run build` would mask the lint failure
  # behind the build's exit code, and `npm run build | tee log.txt`
  # would only surface tee's exit code. Strict-bash closes both.
  bash -euo pipefail -c -- "$BUILD_CMD"
fi

# Step 1.5: Ensure the post-deploy synthetic browser is present BEFORE we
# publish (#142 Codex P2). The synthetic (Step 4) needs Playwright Chromium; if
# it is missing, install it here — before op-firebase-deploy — so a missing probe
# browser fails the deploy up front rather than after the release is already
# live, which would report a healthy site as a failed deploy.
if [[ "$SYNTHETIC_SKIP" != "true" ]]; then
  echo ">> Ensuring Playwright Chromium (post-deploy synthetic prerequisite)"
  # --with-deps so the browser can actually LAUNCH: on a clean Linux runner the
  # binary alone is not enough (missing native libs), and a browser that installs
  # but cannot launch would let the deploy publish and only then fail the probe.
  # On macOS (the usual deploy host) --with-deps just installs the browser.
  if ! npx playwright install --with-deps chromium; then
    echo "   Could not install Playwright Chromium — aborting before publishing." >&2
    echo "   Fix the tooling, or re-run with --skip-synthetic to deploy without" >&2
    echo "   the post-deploy app-mount check." >&2
    exit 1
  fi
fi

# Step 1.6: Cloud Run invoker credential check, BEFORE we publish (#768 Codex
# P1 r2 — credential chain mismatch).
#
# Step 2.5 below shells out to `gcloud`, which does NOT share
# `op-firebase-deploy`'s credential. That wrapper resolves a per-project
# Firebase-vault SA key into a TEMPORARY file and deletes it in its own EXIT
# trap; `gcloud` resolves its own chain (GOOGLE_APPLICATION_CREDENTIALS, the
# shared 1Password ADC item, then the local ADC file). So a deploy started
# without `op-preflight.sh --mode deploy` can authenticate to Firebase
# perfectly and still have no usable credential left for the reconciliation —
# and the reconciliation is the half that keeps submitBugReport and
# emailUnsubscribe answering.
#
# Running that check here instead of only at Step 2.5 is the whole point: the
# failure it catches used to land AFTER Firebase had already published, which
# is precisely the "published but 403" outage #768 is closing. Both scripts
# are read-only in --dry-run (they `gcloud run services describe` and print
# what they WOULD do), so this costs two cheap reads and mutates nothing.
#
# Not a substitute for Step 2.5's own error handling: a credential can still
# expire between here and there, and describe-permission does not prove
# update-permission. It converts the common case from "fails after publishing"
# into "fails before publishing", and names the cause.
#
# Gated on FUNCTIONS_ATTEMPTED: a `--only hosting` run cannot reset the invoker
# annotation, so there is nothing for Step 2.5 to repair and no reason to let a
# gcloud problem block a deploy that never needed gcloud (#768 r4).
#
# --allow-missing (#768 r5 Codex P2): for a brand-new target's FIRST deploy,
# neither Cloud Run service exists yet — Functions has not created them —
# so `describe` here 404s unconditionally and would abort every first deploy
# before Firebase ever got a chance to create the services, with only
# --skip-invoker (which also disables Step 2.5) as a workaround. --allow-missing
# makes a NOT_FOUND describe a non-fatal, distinct outcome ONLY here, at the
# pre-publish stage, where "the service isn't there yet" is the expected first-
# deploy state. It narrows what counts as absent, not what counts as fine: a
# missing credential, PERMISSION_DENIED, or any other describe failure still
# aborts below exactly as before. Step 2.5's post-deploy reconciliation omits
# this flag on purpose for exactly selected endpoints — by then the service
# should exist, so a 404 stays a real, fatal signal. A service selected only
# conservatively from an unfamiliar codebase/group selector is the exception:
# the post-deploy call also allows it to be absent, because that selector may
# have been an unrelated function Firebase validly deployed without creating
# either protected service.
if [[ "$INVOKER_SKIP" == "true" ]]; then
  echo ">> Invoker credential check skipped (--skip-invoker)"
elif [[ "$FUNCTIONS_ATTEMPTED" != "true" ]]; then
  echo ">> Invoker credential check skipped (this deploy does not release Functions)"
elif [[ ${#INVOKER_SCRIPTS[@]} -eq 0 ]]; then
  echo ">> Invoker credential check skipped (the selected Function scope does not include submitBugReport or emailUnsubscribe)"
else
  echo ">> Checking the Cloud Run invoker credential before publishing (read-only)"
  resolve_invoker_deploy_credential
  PRECHECK_STATUS=0
  for invoker_script in "${INVOKER_SCRIPTS[@]}"; do
    run_invoker "$invoker_script" --dry-run --allow-missing || PRECHECK_STATUS=$?
  done
  if [[ "$PRECHECK_STATUS" -ne 0 ]]; then
    cat >&2 <<EOF

✗ Could not read the Cloud Run invoker config. NOTHING HAS BEEN PUBLISHED.

  Step 2.5 of this deploy reconciles the invoker IAM check on submitBugReport
  and emailUnsubscribe (#768). It runs \`gcloud\`, which resolves its own
  credential chain — NOT the temporary one op-firebase-deploy materializes and
  deletes on exit. If that chain is empty or expired, the reconciliation would
  fail AFTER Firebase had published, leaving both endpoints 403ing.

  Read the gcloud error printed above, then match it here:

    • "No GCP source credential found" — nothing is loaded. Run:
        eval "\$(scripts/op-preflight.sh --agent <agent> --mode deploy)"
      That is also the fix for the routine case: deploy preflight exports the
      per-project Firebase-vault SERVICE-ACCOUNT key, which the invoker script
      activates into a throwaway gcloud config and uses directly. No manual
      \`unset GOOGLE_APPLICATION_CREDENTIALS\` is needed any more.
    • "PERMISSION_DENIED" / 403 — the identity lacks run.services.get on the
      project. The Firebase-vault SA key carries roles/run.admin when
      provisioned by scripts/firebase/op-firebase-setup, so a 403 on it means
      the grant is missing or the key belongs to a different project.
    • "NOT_FOUND" — this check already tolerates an absent service (expected
      on a brand-new target's first deploy, before Functions has created it),
      so reaching THIS abort with a NOT_FOUND above means something else is
      also wrong — most likely cause 1 or 2. The message above lists the
      services this credential can see.

  To deploy without touching the invoker config at all (the endpoints keep
  whatever state they are already in):

    scripts/deploy.sh --skip-invoker
EOF
    exit 1
  fi
fi

# Step 2: Deploy
echo ">> Deploying via op-firebase-deploy"
# Bash 3.2 + `set -u`: expanding an empty `${DEPLOY_ARGS[@]}` aborts
# with "DEPLOY_ARGS[@]: unbound variable" when no trailing deploy
# args were appended (e.g. `deploy.sh --force --skip-build
# --skip-cf-purge` with nothing after `--`). The `${ARR[@]+"${ARR[@]}"}`
# idiom expands to the array contents only when the array has been
# ASSIGNED — DEPLOY_ARGS=() at parse time qualifies as assigned, so
# this expansion is always defined regardless of length. Bash 4+
# tolerates the bare form; Bash 3.2 (still the macOS system shell)
# does not. nathanpayne-codex Phase 4b r3 on PR #296 reproduced
# the abort with `--force --skip-build --skip-cf-purge` under bash 3.2.
#
# The exit status is CAPTURED rather than left to `set -e` (#768 Codex P1 r2 —
# ordering). Firebase reports the org-policy rejection of the `allUsers`
# invoker binding as a partial FAILURE: `op-firebase-deploy` returns nonzero,
# and with `set -e` the script aborted right here — so Step 2.5, the recovery
# built for exactly this failure, never ran. Capturing the status lets the
# reconciliation run before the script returns; the status is then honoured at
# Step 2.6 so a genuinely failed deploy still fails.
#
# Output is teed to a log so Step 2.5 can CLASSIFY the failure. `2>&1` merges
# the streams deliberately: firebase-tools prints the invoker report through
# its own logger (stdout) while the terminal error goes to stderr, and the
# classifier needs to see both. `${PIPESTATUS[0]}` is op-firebase-deploy's own
# status, not tee's.
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/deploy-firebase-XXXXXX")"

set +e
op-firebase-deploy ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"} 2>&1 | tee "$DEPLOY_LOG"
DEPLOY_STATUS="${PIPESTATUS[0]}"
set -e

# Step 2.5: Cloud Run invoker reconciliation (#768)
#
# gaycruisebingo's GCP project enforces Domain Restricted Sharing
# (constraints/iam.allowedPolicyMemberDomains), which rejects the `allUsers`
# Cloud Run invoker binding `firebase deploy` normally adds to make a Function
# publicly reachable. The org-policy-compatible fix instead DISABLES the
# invoker IAM check on the backing Cloud Run service — see
# docs/app/bug-reports.md § Repeat-deploy hardening and
# docs/app/phase-1-deploy.md § 1a-i. A `firebase deploy --only functions` can
# reset that annotation and re-try the rejected `allUsers` binding, silently
# 403ing submitBugReport / emailUnsubscribe until someone notices and re-runs
# the fix by hand.
#
# This used to be a manual post-deploy step an operator had to remember for
# BOTH endpoints — and at different times, each one was forgotten: #158 for
# submitBugReport, and #768 found emailUnsubscribe broken in production the
# same way. Both scripts/set-*-invoker.sh are idempotent (they describe the
# service first and no-op when the check is already disabled), so running
# them costs one cheap read-only `gcloud` call when nothing regressed, and
# silently fixes the regression when something did.
#
# Not gated per-target: `scripts/deploy-target.mjs` auto-injects
# --skip-invoker for the fiveacross target (`skipInvokerReconcile: true` in
# `scripts/build-target.mjs`) because that project's deploy credential is
# fiveacross-scoped and is not provisioned with IAM access to describe or
# update a gaycruisebingo Cloud Run service — see the comment there.
#
# WHEN IT RUNS (rewritten in #768 r4 — Codex P1).
#
# It runs whenever this deploy could have RELEASED Functions
# (FUNCTIONS_ATTEMPTED, computed from the argument list at the top of this
# script) — on success AND on failure, whatever the failure was.
#
# The previous rule ran it only on success or on a failure whose text matched
# the org-policy invoker rejection, and that rule was wrong in the direction
# that hurts. The annotation is reset by a SUCCESSFUL Functions release, which
# says nothing about how the overall command later exits: a multi-surface
# deploy that releases Functions and then fails on Hosting, or a Functions
# deploy where emailUnsubscribe updates before a different function errors,
# both end nonzero WITHOUT the invoker text — so the recovery was skipped in
# exactly the state it exists to repair, leaving both endpoints 403ing merely
# because something unrelated also failed. "We do not know what state the
# project is in" argued for skipping; it actually argues for running, because
# the reconciliation is idempotent and one-directional: running it when it was
# not needed costs a no-op read, skipping it when it was needed costs the
# outage.
#
# The org-policy classifier survives for MESSAGING only — it decides which
# explanation Step 2.6 prints — and no longer gates whether anything runs. It
# greps firebase-tools' own invoker report ("Unable to set the invoker for the
# IAM policy on the following functions:",
# node_modules/firebase-tools/lib/deploy/functions/release/reporter.js) plus
# the two org-policy strings GCP returns for a Domain Restricted Sharing
# rejection. It never suppresses the nonzero exit — Step 2.6 honours
# DEPLOY_STATUS regardless.
#
# ONE exception to "runs whenever Functions were in scope": FIREBASE_DRY_RUN
# (#768 r5 Codex P2). Firebase's own `--dry-run` "[validates] your changes and
# builds your code without deploying any changes to your project" — nothing is
# ever released, success or failure, so the premise this step repairs (a
# release that may have reset the invoker annotation) never applies. Running
# the reconciliation anyway would be the exact footgun a dry run exists to
# rule out: `op-firebase-deploy --dry-run` could still exit 0 (validation
# passed), FUNCTIONS_ATTEMPTED would still be true, and without this gate
# `gcloud run services update --no-invoker-iam-check` would fire for real
# against production during a call whose entire point was to change nothing.
# Step 1.6's own --dry-run is unrelated and unaffected — it is always
# read-only regardless of whether the caller also passed Firebase's.
INVOKER_PARTIAL_FAILURE=false
if [[ "$DEPLOY_STATUS" -ne 0 ]] &&
   grep -qiE 'Unable to set the invoker for the IAM policy|do not belong to a permitted customer|allowedPolicyMemberDomains' \
     "$DEPLOY_LOG"; then
  INVOKER_PARTIAL_FAILURE=true
fi

RECONCILE_STATUS=0
RECONCILE_RAN=false
if [[ "$INVOKER_SKIP" == "true" ]]; then
  echo ">> Invoker reconciliation skipped (--skip-invoker)"
elif [[ "$FUNCTIONS_ATTEMPTED" != "true" ]]; then
  echo ">> Invoker reconciliation skipped (this deploy does not release Functions, so the invoker annotation cannot have been reset)"
elif [[ ${#INVOKER_SCRIPTS[@]} -eq 0 ]]; then
  echo ">> Invoker reconciliation skipped (the selected Function scope does not include submitBugReport or emailUnsubscribe)"
elif [[ "$FIREBASE_DRY_RUN" == "true" ]]; then
  echo ">> Invoker reconciliation skipped (Firebase --dry-run: nothing was deployed, so nothing could have been released — mutating the invoker config here would be the exact footgun a dry run exists to rule out)"
else
  if [[ "$DEPLOY_STATUS" -ne 0 ]]; then
    if [[ "$INVOKER_PARTIAL_FAILURE" == "true" ]]; then
      cat >&2 <<EOF

⚠️  Firebase rejected the \`allUsers\` invoker binding (org policy) and reported
    the deploy as FAILED. Reconciling the invoker check anyway — this is the
    failure mode Step 2.5 exists for, and skipping it here is what left
    submitBugReport (#158) and emailUnsubscribe (#768) 403ing in production.
EOF
    else
      cat >&2 <<EOF

⚠️  op-firebase-deploy FAILED for a reason that is not the org-policy invoker
    rejection. Reconciling anyway: this deploy could still have released
    Functions before it failed, and a released function resets the invoker
    annotation regardless of what errored afterwards. The reconciliation is
    idempotent, so this is a no-op if nothing regressed — and the deploy still
    fails below.
EOF
    fi
  fi
  echo ">> Reconciling Cloud Run invoker config for selected Functions"
  RECONCILE_RAN=true
  if [[ "$BUG_REPORT_INVOKER_SELECTED" == "true" ]]; then
    run_postdeploy_invoker "$SCRIPT_DIR/set-bug-report-invoker.sh" \
      "$BUG_REPORT_INVOKER_CONSERVATIVE" || RECONCILE_STATUS=$?
  fi
  if [[ "$EMAIL_UNSUBSCRIBE_INVOKER_SELECTED" == "true" ]]; then
    run_postdeploy_invoker "$SCRIPT_DIR/set-email-unsubscribe-invoker.sh" \
      "$EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE" || RECONCILE_STATUS=$?
  fi
  if [[ "$RECONCILE_STATUS" -ne 0 ]]; then
    cat >&2 <<EOF

✗ The Cloud Run invoker reconciliation FAILED and the deploy is already live.
  submitBugReport and/or emailUnsubscribe may be returning 403 right now.

  The read-only check before publishing passed, so this is not a plain
  "no credential" case. Most likely, in order:

    • The credential can describe but not UPDATE the service (needs
      run.services.update / roles/run.admin on the project).
    • The deploy credential expired between publishing and now — reload it:
        eval "\$(scripts/op-preflight.sh --agent <agent> --mode deploy)"
    • The org policy also blocks the annotation (it should not — that is a
      service setting, not an IAM binding — but read the gcloud error above).

  Re-run by hand once fixed; both are idempotent, so a re-run is safe:

    scripts/set-bug-report-invoker.sh
    scripts/set-email-unsubscribe-invoker.sh
EOF
  fi
fi

# Step 2.6: honour the deploy's own exit status.
#
# Deliberately AFTER the reconciliation, and deliberately still fatal. Running
# the reconciliation first means a partial-failure deploy no longer leaves a
# published-but-403 endpoint behind. Returning success afterwards would be a
# different bug: a nonzero `firebase deploy` means at least one resource did
# not reach its intended state, we cannot prove from out here that the
# rejected binding was the only casualty, and a script that prints "Deploy
# complete." over a failed deploy teaches operators to ignore it. So the
# endpoint is repaired, the failure is still reported, and the Cloudflare
# purge + post-deploy synthetic are skipped exactly as they were before.
if [[ "$DEPLOY_STATUS" -ne 0 ]]; then
  if [[ "$RECONCILE_RAN" == "true" && "$RECONCILE_STATUS" -eq 0 ]]; then
    cat >&2 <<EOF

✗ op-firebase-deploy exited $DEPLOY_STATUS. The invoker reconciliation ran and
  succeeded, so the endpoints are NOT left 403ing — but the deploy itself
  reported an error, so this run is a failure and the Cloudflare purge and the
  post-deploy synthetic did NOT run.
EOF
    if [[ "$INVOKER_PARTIAL_FAILURE" == "true" ]]; then
      cat >&2 <<EOF

  Read the Firebase output above. If the rejected \`allUsers\` invoker binding
  was the ONLY thing it complained about, the project is in the state you
  wanted and re-running \`scripts/deploy.sh\` is a cheap, idempotent way to
  finish the purge + synthetic. If it named anything else, fix that first.
EOF
    else
      cat >&2 <<EOF

  Read the Firebase output above and fix what it named. The reconciliation was
  a precaution, not a diagnosis: it ran because this deploy COULD have released
  Functions before failing, which would have reset the invoker annotation. It
  says nothing about why the deploy failed.
EOF
    fi
  elif [[ "$RECONCILE_RAN" != "true" ]]; then
    echo "" >&2
    echo "✗ op-firebase-deploy exited $DEPLOY_STATUS. Nothing further ran." >&2
  fi
  exit "$DEPLOY_STATUS"
fi

if [[ "$RECONCILE_STATUS" -ne 0 ]]; then
  exit "$RECONCILE_STATUS"
fi

# Step 3: Cloudflare cache purge (optional)
# CF_ZONE_ID is per-repo by design (DEPLOYMENT.md § Cloudflare cache purge:
# one shared token covers all domains, each domain has its own zone), so the
# gaycruisebingo.com zone id is the repo-level default here. Zone ids are not
# secrets; the env override stays for staging/alternate zones. Without this
# default a routine deploy silently skipped the purge (2026-07-14), leaving
# Cloudflare serving the previous bundle at the proxied apex.
CF_ZONE_ID="${CF_ZONE_ID:-8066dd2b105ad564c45bb8c898859343}"
if [[ "$CF_PURGE_SKIP" == "true" ]]; then
  echo ">> Cloudflare cache purge skipped (--skip-cf-purge)"
elif [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ZONE_ID:-}" ]]; then
  echo ">> Cloudflare cache purge skipped (CF_API_TOKEN or CF_ZONE_ID not set)"
else
  echo ">> Purging Cloudflare cache"
  # The Cloudflare purge endpoint returns 200 on success with a JSON body.
  # We only care about HTTP status here.
  purge_http_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 \
    --max-time 30 \
    -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}')"
  if [[ "$purge_http_code" != "200" ]]; then
    echo "   Cloudflare purge failed: HTTP $purge_http_code" >&2
    exit 1
  fi
  echo "   Cache purged."
fi

# Step 4: Post-deploy synthetic gate (issue #142)
#
# Assert the DEPLOYED app actually mounts and renders its root — the signal a
# Hosting-200 check misses. The 2026-07-09 outage (#141) returned 200 for the
# shell while the client JS crashed on init (`auth/invalid-api-key`), leaving a
# blank page; a rules regression that blocks first paint fails the same way.
# `SYNTHETIC_DEPLOYMENT_CHECK=true` also tells the unsubscribe probe that this
# is post-release evidence, not the scheduled monitor's unchanged pre-rollout
# baseline: `/unsubscribe` serving the SPA here is a failed deploy, never a
# grace-worthy state.
# Runs against the live origin (SYNTHETIC_URL, default the production domain)
# AFTER the cache purge above, so it sees what users will get. This is the
# deploy-to-live-then-verify posture: on failure it exits non-zero and points at
# the rollback so a broken deploy is caught immediately rather than by a user.
if [[ "$SYNTHETIC_SKIP" == "true" ]]; then
  echo ">> Post-deploy synthetic skipped (--skip-synthetic)"
else
  SYNTHETIC_URL="${SYNTHETIC_URL:-https://gaycruisebingo.com/}"
  echo ">> Post-deploy synthetic: asserting the app mounts at $SYNTHETIC_URL"
  if ! SYNTHETIC_DEPLOYMENT_CHECK=true SYNTHETIC_URL="$SYNTHETIC_URL" npm run --silent test:synthetic; then
    cat >&2 <<EOF

✗ Post-deploy synthetic FAILED at $SYNTHETIC_URL. The deploy is live.

  CONFIRM BEFORE ROLLING BACK (10 seconds). Open $SYNTHETIC_URL in a browser:

    • Blank page / spinner forever  → real outage. Roll back, instructions below.
    • The sign-in gate renders      → the PROBE failed, not the app. Do NOT roll
                                      back a healthy release. Read the Playwright
                                      output above, then file the probe bug.

  Rolling back a working release costs more than one extra minute of checking.
  This exact false alarm happened on 2026-08-05: the synthetic waited for the
  \`GAY CRUISE BINGO\` heading, the Vacay-Edition host correctly rendered
  \`VACAY BINGO\`, and a completely healthy Bodega Bay deploy was reported as a
  broken one with these rollback instructions attached (fixed since — the mount
  signal is Edition-free now, see tests/synthetic/app-mounts.spec.ts).

  Read the failure line above to tell the two apart:
    "Firebase init error(s) detected"  → real: bad/rotated key, wrong project.
    "uncaught exception(s) during load" → real: the client threw before paint.
    "the sign-in gate never rendered"   → real IF the page is blank in a browser;
                                          a probe bug if the gate is right there.
    "emailUnsubscribe 403"              → real, but NOT a rollback case: the
                                          Cloud Run invoker IAM check regressed
                                          (#768). Rolling back Hosting does not
                                          touch Cloud Run IAM, so it will not
                                          fix this. Step 2.5 above reconciles
                                          it automatically unless --skip-invoker
                                          was passed; if it still fails here,
                                          re-run scripts/set-email-unsubscribe-invoker.sh
                                          by hand and check its own output for
                                          the reason (permissions, org policy,
                                          wrong project).
    anything else (browser launch,
    navigation timeout, DNS/TLS)        → probe or network, not the release.

  Roll back — Firebase Console → Hosting → Release history → Roll back is the
  one-click path; or via the CLI (see DEPLOYMENT.md § Rollback Procedure):
    firebase hosting:releases:list                          # find the prior version id
    firebase hosting:clone <site-id>:@<VERSION_ID> <site-id>:live

  (If this is a "browser not found" error, run: npx playwright install chromium,
   then re-run: npm run test:synthetic)
EOF
    exit 1
  fi
  echo "   App mounts. Synthetic passed."
fi

echo ">> Deploy complete."
