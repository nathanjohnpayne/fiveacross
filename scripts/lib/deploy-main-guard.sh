#!/usr/bin/env bash
# Shared deploy source guard for every command that publishes this checkout.
#
# Source this file after changing to the repository root, then call:
#   guard_deploy_main_checkout <command-name> <force:true|false>
#
# `--force` is intentionally limited to branch/freshness checks. A dirty tree
# needs the separate, audit-visible DEPLOY_ALLOW_DIRTY=1 escape hatch so a
# routine break-glass deploy cannot silently publish uncommitted files.

guard_deploy_main_checkout() {
  local command_name="${1:?command name is required}"
  local force="${2:-false}"
  local current_branch local_head origin_head ahead behind dirty

  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" != "main" ]]; then
    if [[ "$force" == "true" ]]; then
      echo "⚠️  --force: deploying from '$current_branch' (not main)" >&2
    else
      cat >&2 <<EOF
Refusing to deploy: current branch is '$current_branch', not 'main'.

Deploys must ship the reviewed state on main. Worktrees and feature branches
can silently publish code reviewers have not seen.

To override branch and freshness checks (break-glass only): $command_name --force
EOF
      return 1
    fi
  fi

  # Fail closed on fetch failure: stale origin/main metadata cannot prove the
  # checkout is the reviewed, merged source that a deploy must publish.
  if ! git fetch --quiet origin main 2>/dev/null; then
    if [[ "$force" == "true" ]]; then
      echo "⚠️  --force: git fetch failed; skipping freshness verification" >&2
    else
      cat >&2 <<EOF
Refusing to deploy: 'git fetch origin main' failed, so freshness against
origin/main cannot be verified.

To override branch and freshness checks (break-glass only): $command_name --force
EOF
      return 1
    fi
  fi

  if ! git rev-parse --verify --quiet origin/main >/dev/null; then
    if [[ "$force" == "true" ]]; then
      echo "⚠️  --force: origin/main is unavailable after fetch; skipping exact-match verification" >&2
    else
      cat >&2 <<EOF
Refusing to deploy: origin/main is unavailable after fetch, so the exact
merged commit cannot be verified.

To override branch and freshness checks (break-glass only): $command_name --force
EOF
      return 1
    fi
  else
    local_head="$(git rev-parse HEAD)"
    origin_head="$(git rev-parse origin/main)"
    if [[ "$local_head" != "$origin_head" ]]; then
      behind="$(git rev-list --count HEAD..origin/main)"
      ahead="$(git rev-list --count origin/main..HEAD)"
      if [[ "$force" == "true" ]]; then
        echo "⚠️  --force: local main differs from origin/main ($ahead ahead, $behind behind)" >&2
      else
        cat >&2 <<EOF
Refusing to deploy: local main does not exactly match origin/main
($ahead commit(s) ahead, $behind commit(s) behind).

Deploys must ship the reviewed, merged origin/main commit. Push or discard
local-only commits, then update main before deploying.

To override branch and freshness checks (break-glass only): $command_name --force
EOF
        return 1
      fi
    fi
  fi

  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    if [[ "${DEPLOY_ALLOW_DIRTY:-0}" == "1" ]]; then
      echo "⚠️  DEPLOY_ALLOW_DIRTY=1: deploying with uncommitted changes:" >&2
      printf '%s\n' "$dirty" >&2
    else
      cat >&2 <<EOF
Refusing to deploy: working tree is dirty.

Modified / staged / untracked paths:
$dirty

Commit, stash, or revert these before deploying so the deploy reflects the
merged-on-main state reviewers approved.

To override the clean-tree check (break-glass only): DEPLOY_ALLOW_DIRTY=1 $command_name
EOF
      return 1
    fi
  fi
}
