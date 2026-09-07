#!/usr/bin/env bash
set -euo pipefail

# Guarded deploy wrapper for the Cloudflare Worker Event router (worker/).
#
# WHY THIS EXISTS
#
# `wrangler deploy` uploads the CALLER'S WORKING DIRECTORY, not `origin/main` —
# the same hazard `scripts/deploy.sh` was written for (mergepath#77), and worse
# here in one respect: once the routes are attached, this Worker fronts EVERY
# wildcard Event hostname, so publishing from a feature branch or a dirty tree
# replaces the router for every Event at once with code no reviewer has seen.
#
# `scripts/deploy.sh` states the canonical policy and enforces it for the
# Firebase surface; it cannot be reused here because it is bound end-to-end to
# `op-firebase-deploy` and the Cloud Run invoker reconciliation. This script
# applies the SAME shared guards to the Cloudflare surface, including the
# deliberately separate `--force` (branch/freshness) and DEPLOY_ALLOW_DIRTY=1
# (clean-tree) break-glass controls, so an operator meets one policy rather
# than two.
#
#   1. Current branch is `main`.
#   2. Local `main` exactly matches `origin/main`.
#   3. The working tree is clean.
#
# NOTE — deploying is not a cutover. `worker/wrangler.toml` ships with its
# `routes` commented out, so a successful run here publishes a new version and
# changes nothing the public sees. Attaching the routes is a separate, human,
# Gate-ladder step; see worker/README.md § Deploying and attaching.
#
# Usage:
#   scripts/worker-deploy.sh [--force]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/deploy-main-guard.sh
source "$SCRIPT_DIR/lib/deploy-main-guard.sh"

FORCE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    *)
      echo "scripts/worker-deploy.sh does not accept Wrangler arguments: $1" >&2
      exit 64
      ;;
  esac
done

guard_deploy_main_checkout "scripts/worker-deploy.sh" "$FORCE"

FORBIDDEN_SECRET="FIREBASE_API_KEY"
# Every deployed secret under this prefix is a Firebase credential the router
# must not carry (same policy as the [vars] check in the binding validator).
FORBIDDEN_SECRET_PREFIX="FIREBASE_"

# Is this a ROUTE-BEARING deploy? The cutover procedure uncomments the routes
# block in worker/wrangler.toml and redeploys through this same script, so
# "publishing changes nothing the public sees" is true for an ordinary deploy
# and FALSE for that one. Saying it unconditionally would reassure an operator
# at the exact moment they are changing live traffic.
#
# The answer comes from the binding check below, which reads it off the PARSED
# configuration. It used to be a line grep for `^\s*routes\s*=`, which is blind
# to `[[routes]]` and to a quoted `"routes" = [ … ]` — both of which Wrangler
# resolves into real routes. A cutover written either way would have been
# announced here as "nothing the public sees".
ROUTE_BEARING=false

# Refuse an ignored dotenv file under worker/, and load none anywhere.
#
# The two ambient-variable refusals below read the SHELL this wrapper was
# started in. Wrangler 4.129 reads more than that: every command resolves
# `.env` and `.env.local` — plus `.env.<env>` and `.env.<env>.local` — against
# its working directory and merges them into `process.env` inside a yargs
# `.check()`, which runs AFTER this guard and BEFORE the command it guards does
# anything. So a `WRANGLER_CI_OVERRIDE_NAME` or `CLOUDFLARE_ENV` written into
# `worker/.env.local` applies the exact override those refusals
# exist to prevent, through a guard that saw a clean shell — and `worker/.env`,
# `worker/.env.local` and `worker/.dev.vars` are gitignored, so the clean-tree
# guard cannot see them either (Codex P1 on #1120).
#
# Two answers, because they close different halves of it.
#
# 1. REFUSE THE FILES. The router carries no secrets: ADR 0014 removed the
#    Firestore reader, `wrangler.toml` declares one service binding and no
#    `[vars]`, and `verify_no_firebase_secret` below asserts the deployed
#    Worker holds no credential at all. `worker/` therefore has no legitimate
#    dotenv file, and their PRESENCE is the refusal — nothing here reads one.
#    Parsing them would be a second definition of "what Wrangler would have
#    loaded" (its own `.env` grammar, its `dotenv-expand` pass, its precedence)
#    that can disagree with Wrangler's, and a guard that disagrees with the
#    tool it guards is the failure this one is fixing.
#
# 2. `--env-file /dev/null` ON EVERY WRANGLER COMMAND. The flag REPLACES the
#    default list rather than adding to it, so a run carrying it loads no
#    dotenv file at all, wherever one sits. That is the half a presence check
#    under `worker/` cannot cover: `npm exec` keeps THIS script's working
#    directory, so the secret readback resolves its dotenv files at the
#    REPOSITORY ROOT, where `.env.local` is the app build's legitimate and
#    required input and refusing it would refuse every deploy.
#
# `.dev.vars` is `wrangler dev`'s local-secret file rather than `deploy`'s, and
# is refused with the rest: it is the same ignored-file-changes-what-Wrangler-
# sees hazard, it is read by `npm run dev` against this same `wrangler.toml`,
# and a deploy tree carrying one is a tree someone has been experimenting in.
refuse_worker_dotenv_files() {
  local candidate found=""
  # No `shopt -s nullglob`: every pattern starts with a literal dot, so an
  # unmatched one stays literal and `-e` is false for it. Leaving the shell's
  # globbing options alone keeps this guard from changing how anything else in
  # the script expands.
  for candidate in \
    "$REPO_ROOT/worker"/.env \
    "$REPO_ROOT/worker"/.env.* \
    "$REPO_ROOT/worker"/.dev.vars \
    "$REPO_ROOT/worker"/.dev.vars.*; do
    if [[ -e "$candidate" ]]; then
      found="${found:+$found, }worker/${candidate##*/}"
    fi
  done

  if [[ -n "$found" ]]; then
    echo "" >&2
    echo "❌ A dotenv file is present under worker/: ${found}" >&2
    echo "" >&2
    echo "Wrangler loads worker/.env, worker/.env.local and worker/.env.<env>* into" >&2
    echo "process.env while it validates the command line — after this guard has run." >&2
    echo "A WRANGLER_CI_OVERRIDE_NAME or CLOUDFLARE_ENV defined in one of them would" >&2
    echo "publish over a Worker this deploy never verified — and .env, .env.local and" >&2
    echo ".dev.vars are gitignored, so the clean-tree guard does not see them either." >&2
    echo "" >&2
    echo "The router carries no secrets, so nothing here needs one. Remove or move it:" >&2
    echo "" >&2
    echo "    rm ${found//, / }" >&2
    echo "" >&2
    exit 65
  fi
}

# Verify the registry lookup binding in the configuration about to be published.
#
# This replaces the old `FIREBASE_API_KEY` presence check, and the shape of the
# check changed with the shape of the dependency (#972). The api key was set
# with `wrangler secret put` and deliberately NOT committed, so the only place
# to observe it was the deployed Worker. The registry binding is the opposite:
# it is declared in `worker/wrangler.toml` and travels with the upload, so the
# committed configuration IS the deployed configuration and is answerable here,
# before anything is published or installed.
#
# What it defends is a one-word difference with a large blast radius. Bound with
# an explicit `entrypoint = "RegistryLookupEntrypoint"`, the router can call
# `lookup(host)` and nothing else. Omit that line, or write `default`, and the
# same binding reaches the registry's default export — the signed
# sync/audit/recovery control plane — handing a public edge Worker the private
# control surface. The validator is shared with the synthetic harness so both
# configurations are held to one definition of "bound to the lookup entrypoint".
verify_registry_lookup_binding() {
  # An ambient CLOUDFLARE_ENV selects a Wrangler environment with no
  # command-line flag, and this wrapper forwards the operator's environment to
  # every Wrangler command it runs. The committed configuration declares no
  # `[env.<name>]` — the binding check refuses the key outright — but Wrangler
  # treats a MISSING section as a warning rather than an error: it reuses the
  # top-level configuration and appends the environment name to the Worker,
  # publishing or inspecting `five-across-event-router-<env>` while every
  # message here says the production router was handled. So the variable is
  # refused before the binding is certified rather than certified around.
  # The same shape of ambient override, one level up: Wrangler 4.129's deploy
  # handler replaces the configured Worker NAME with WRANGLER_CI_OVERRIDE_NAME
  # (a Workers Builds convenience), while `wrangler secret list` keeps reading
  # the name from wrangler.toml. With it set, this wrapper would verify
  # five-across-event-router, publish the bundle over a different Worker, and
  # verify five-across-event-router again — the published target unchecked.
  if [[ -n "${WRANGLER_CI_OVERRIDE_NAME:-}" ]]; then
    echo "" >&2
    echo "❌ WRANGLER_CI_OVERRIDE_NAME is set to '${WRANGLER_CI_OVERRIDE_NAME}'." >&2
    echo "" >&2
    echo "Wrangler deploys under that name instead of the configured one, while the" >&2
    echo "secret readback still inspects five-across-event-router — so the Worker" >&2
    echo "this deploy would publish is not the one it verifies. Unset it and re-run:" >&2
    echo "" >&2
    echo "    unset WRANGLER_CI_OVERRIDE_NAME" >&2
    echo "" >&2
    exit 65
  fi

  if [[ -n "${CLOUDFLARE_ENV:-}" ]]; then
    echo "" >&2
    echo "❌ CLOUDFLARE_ENV is set to '${CLOUDFLARE_ENV}'." >&2
    echo "" >&2
    echo "Wrangler selects an environment from that variable with no flag, and" >&2
    echo "worker/wrangler.toml declares none — so Wrangler would fall back to the" >&2
    echo "top-level configuration under the name five-across-event-router-${CLOUDFLARE_ENV}," >&2
    echo "which is a different Worker from the one this deploy reports on." >&2
    echo "" >&2
    echo "Unset it and re-run:" >&2
    echo "" >&2
    echo "  unset CLOUDFLARE_ENV" >&2
    echo "" >&2
    exit 1
  fi

  echo "🔎 Verifying worker/wrangler.toml binds the registry lookup entrypoint explicitly…" >&2
  local status=0 answer=""
  answer="$(node "$SCRIPT_DIR/event-router-registry/check-router-binding.mjs")" || status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "✅ REGISTRY is bound explicitly to RegistryLookupEntrypoint." >&2
    # Read off the same parsed document the binding was read from, so the two
    # answers cannot disagree about the file they describe.
    if [[ "$answer" == *"routes=true"* ]]; then
      ROUTE_BEARING=true
    elif [[ "$answer" == *"routes=false"* ]]; then
      ROUTE_BEARING=false
    else
      # The check passed but said nothing about routes. Assume the dangerous
      # answer: a wrongly-quiet cutover is the failure this variable prevents.
      ROUTE_BEARING=true
    fi
    return 0
  fi
  # Only exit 1 is a REFUSAL. 69 is "could not run" (below), and anything else —
  # 127 for a missing `node`, 126 for one that will not execute — is the same
  # thing: the check did not reach a verdict, so it must not be reported as one.
  if [[ "$status" -ne 1 && "$status" -ne 69 ]]; then
    status=69
  fi
  # 69 is "the check could not run", not "the binding is wrong". Announcing a
  # binding problem here would send the operator to edit the one block that is
  # correct — the validator parses the configuration with a ROOT devDependency,
  # and this guard runs before any install.
  if [[ "$status" -eq 69 ]]; then
    echo "" >&2
    echo "❌ Could not run the registry binding check." >&2
    echo "" >&2
    echo "It parses worker/wrangler.toml with a root devDependency, so install the" >&2
    echo "root lockfile first and re-run. \`--include=dev\` is not optional: a shell" >&2
    echo "carrying NODE_ENV=production or NPM_CONFIG_OMIT=dev omits smol-toml and" >&2
    echo "lands you back here." >&2
    echo "" >&2
    echo "  npm ci --include=dev" >&2
    echo "" >&2
    exit 69
  fi
  echo "" >&2
  echo "❌ worker/wrangler.toml does not bind REGISTRY explicitly to RegistryLookupEntrypoint." >&2
  echo "" >&2
  echo "An omitted or \`default\` entrypoint binds the registry's control-plane fetch" >&2
  echo "instead of its lookup-only entrypoint. Fix the [[services]] block before" >&2
  echo "deploying; see worker/README.md § The registry lookup binding." >&2
  echo "" >&2
  exit 65
}

# Verify the DEPLOYED Worker carries no Firebase credential.
#
# The inversion is the deliverable, not a leftover. ADR 0014 removed the
# Firestore REST reader outright, and R0's evidence claim is that the public
# router has no Firebase, KV, Cache, or Durable Object binding at all — a claim
# a stale `FIREBASE_API_KEY` left on the Worker from the previous design would
# quietly falsify. The code no longer reads it, so it grants nothing on its own;
# it is refused because an unrouted router that still holds an edge credential
# is not the artifact the App Check cutover is allowed to attach.
#
# Nothing else in the ladder can observe this. `wrangler dev --remote` uploads
# the local checkout into a temporary preview with its own `.dev.vars`, and the
# workers.dev URL is refused as `out-of-namespace` before configuration is
# consulted, so neither can report what the deployed Worker holds.
#
# `wrangler secret list` returns names and types only, never values.
verify_no_firebase_secret() {
  local when="$1" secrets
  echo "🔎 Verifying the deployed Worker carries no ${FORBIDDEN_SECRET_PREFIX}* binding (${when})…" >&2

  # `--env-file /dev/null` for the reason in `refuse_worker_dotenv_files`: `npm
  # exec` keeps THIS script's working directory, so without it Wrangler would
  # load the repository root's `.env` and `.env.local` — the app build's own,
  # which this guard deliberately does not refuse — and could read the target
  # of this readback out of one of them.
  if ! secrets="$(npm --prefix worker exec -- wrangler secret list --format json --env-file /dev/null 2>/dev/null)"; then
    # Inability to inspect is NOT a pass. The README presents this as
    # verification of the deployed artifact, so exiting 0 here would let
    # automation record an unverified deploy as a verified one.
    cat >&2 <<MSG

❌ Could not list the deployed Worker's secrets, so its Firebase posture could not be verified.

This is a FAILED verification, not a skipped one. Check \`wrangler\` auth and the
Worker's existence, then re-run. To inspect by hand:

    npm --prefix worker exec -- wrangler secret list --env-file /dev/null

MSG
    exit 75
  fi

  # The WHOLE prefix, not the one name the reader used to consume. The claim
  # this readback backs (R0: the public router carries no Firebase credential
  # of any kind) is about every `FIREBASE_*` secret — a `FIREBASE_SERVICE_ACCOUNT`
  # or `FIREBASE_PROJECT_ID` left bound is the same contradiction as the api
  # key — and it is the same prefix policy the binding validator applies to
  # plain-text `[vars]`, so the two readbacks cannot disagree about what a
  # Firebase credential is. Anchored at the START of the name, so a leftover
  # `OLD_FIREBASE_API_KEY` is still not mistaken for a live binding.
  #
  # `found` is compared against the literal empty string rather than tested for
  # truthiness, so ONLY a parsed array that demonstrably carries no such name
  # passes. Inverting a check inverts its failure mode too: with the old
  # presence test, unparseable output made `jq` exit non-zero and the deploy
  # failed closed by accident; here the same accident would read as proof of
  # absence. A listing that is not an array, or not JSON at all, is evidence
  # of nothing, and is reported as such.
  local found
  # Two steps on purpose: the shape check first (`-e` fails on a non-array, a
  # parse error AND empty output, which a single filter would read as "no
  # names found"), and only then the prefix scan over a listing proven to be
  # an array.
  # ...and every entry must be an object carrying a string `name`: the pinned
  # command documents the output as the complete secret list, so an element
  # this check cannot read is evidence of nothing, exactly like a non-array.
  if ! printf '%s' "$secrets" | jq -e 'type=="array" and all(.[]; type=="object" and (.name|type)=="string")' >/dev/null 2>&1; then
    found="<unreadable listing>"
  elif ! found="$(printf '%s' "$secrets" | jq -r --arg prefix "$FORBIDDEN_SECRET_PREFIX" \
      '[.[] | .name | select(type=="string" and startswith($prefix))] | join(", ")' 2>/dev/null)"; then
    found="<unreadable listing>"
  fi

  if [[ -n "$found" ]]; then
    cat >&2 <<MSG

❌ A Firebase credential is STILL bound on the deployed Worker: ${found}

The router no longer reads any of them — ADR 0014 removed the Firestore REST
reader — but an edge Firebase credential must not outlive the code that used
it. Remove every ${FORBIDDEN_SECRET_PREFIX}* secret before attaching any route:

    npm --prefix worker exec -- wrangler secret delete <name>

MSG
    exit 1
  fi

  echo "✅ No ${FORBIDDEN_SECRET_PREFIX}* binding on the deployed Worker." >&2
}

refuse_worker_dotenv_files
verify_registry_lookup_binding

# Install the reviewed Worker toolchain before ANY Wrangler command. A
# route-bearing deploy verifies the deployed artifact before publishing, so
# deferring this until the deploy step would make that prerequisite check run
# through npm's unpinned fallback in a clean checkout with no node_modules.
# `npm ci`, never `npm install`: the lockfile is part of the reviewed deploy.
# Wrangler is a devDependency, so force its inclusion even when the operator's
# shell carries NODE_ENV=production or NPM_CONFIG_OMIT=dev.
npm --prefix worker ci --include=dev

if [[ "$ROUTE_BEARING" == "true" ]]; then
  cat >&2 <<'MSG'
⚠️  worker/wrangler.toml has ROUTES CONFIGURED.

This deploy ATTACHES those routes and CHANGES LIVE TRAFFIC. Verifying
prerequisites before publishing rather than after.
MSG
  # Before publishing, while nothing has changed yet.
  verify_no_firebase_secret "pre-publish"
else
  echo "✅ Guards passed. Publishing the Worker (no routes configured, so this changes nothing the public sees)." >&2
fi

# `--env-file /dev/null` again, on the one command that PUBLISHES. `npm run`
# sets the working directory to `worker/`, so this is where a `worker/.env*`
# would have been loaded; the file is refused above and this makes the refusal
# belt and braces rather than the only thing standing between an ignored file
# and the published Worker's name.
npm --prefix worker run deploy -- --env-file /dev/null

# Always verify after publishing too: a first deploy has no Worker to inspect
# beforehand, so the pre-publish check above cannot be the only one.
verify_no_firebase_secret "post-publish"
