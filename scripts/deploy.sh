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
#   - Deploys (`op-firebase-deploy`; any arguments after `--` are passed
#     through, e.g. `--only hosting`).
#   - Reconciles the Cloud Run invoker config for submitBugReport and
#     emailUnsubscribe (#768; see docs/app/bug-reports.md § Repeat-deploy
#     hardening). Idempotent — no-ops when already correct.
#   - Purges Cloudflare cache (if CF_API_TOKEN + CF_ZONE_ID are set).
#
# Usage:
#   scripts/deploy.sh                       # full deploy from main
#   scripts/deploy.sh -- --only hosting     # scope the op-firebase-deploy call
#   scripts/deploy.sh --force               # bypass branch + freshness guards
#   scripts/deploy.sh --skip-build          # assume dist/ is already built
#   scripts/deploy.sh --skip-cf-purge       # skip the Cloudflare purge step
#   scripts/deploy.sh --skip-synthetic      # skip the post-deploy app-mount check
#   scripts/deploy.sh --skip-invoker        # skip the Cloud Run invoker reconciliation
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
#
# See DEPLOYMENT.md § Deploy flow for full documentation.

FORCE=false
BUILD_SKIP=false
CF_PURGE_SKIP=false
SYNTHETIC_SKIP=false
INVOKER_SKIP=false
DEPLOY_ARGS=()

usage() {
  sed -n '3,37p' "$0" | sed 's/^# \{0,1\}//'
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
op-firebase-deploy ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}

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
# them on every deploy costs one cheap read-only `gcloud` call when nothing
# regressed, and silently fixes the regression when something did. Prefer
# that over trying to detect whether this deploy actually touched Functions —
# guessing wrong toward "always run" costs a no-op; guessing wrong toward
# "skip" is exactly the silent-breakage class this closes.
#
# Not gated per-target: `scripts/deploy-target.mjs` auto-injects
# --skip-invoker for the fiveacross target (`skipInvokerReconcile: true` in
# `scripts/build-target.mjs`) because that project's deploy credential is
# fiveacross-scoped and is not provisioned with IAM access to describe or
# update a gaycruisebingo Cloud Run service — see the comment there.
if [[ "$INVOKER_SKIP" == "true" ]]; then
  echo ">> Invoker reconciliation skipped (--skip-invoker)"
else
  echo ">> Reconciling Cloud Run invoker config (bug-report + email-unsubscribe)"
  "$SCRIPT_DIR/set-bug-report-invoker.sh"
  "$SCRIPT_DIR/set-email-unsubscribe-invoker.sh"
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
# Runs against the live origin (SYNTHETIC_URL, default the production domain)
# AFTER the cache purge above, so it sees what users will get. This is the
# deploy-to-live-then-verify posture: on failure it exits non-zero and points at
# the rollback so a broken deploy is caught immediately rather than by a user.
if [[ "$SYNTHETIC_SKIP" == "true" ]]; then
  echo ">> Post-deploy synthetic skipped (--skip-synthetic)"
else
  SYNTHETIC_URL="${SYNTHETIC_URL:-https://gaycruisebingo.com/}"
  echo ">> Post-deploy synthetic: asserting the app mounts at $SYNTHETIC_URL"
  if ! SYNTHETIC_URL="$SYNTHETIC_URL" npm run --silent test:synthetic; then
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
