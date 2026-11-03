# Agent Operating Rules

> This file is this repository's **local overlay**. The fleet-wide shared core lives in [`docs/agents/shared-operating-rules.md`](shared-operating-rules.md) --- read that first (`AGENTS.md` § Sections orders them). Where the two overlap, the shared file is the baseline; this file adds repo-specific detail and does not restate it.

Read in this order before taking any action:

1. `README.md`—understand the project
2. `AGENTS.md`—load behavioral instructions (index pointing to this directory)
3. `rules/repo_rules.md`—load binding constraints
4. Relevant `specs/` files—understand intended behavior
5. `.ai_context.md`—load supplemental context

If `docs/projects/<project>/prds/` exists in the repo, read the generated PRD mirror as product context. It is a generated mirror --- do not edit it directly; see `docs/agents/documentation-rules.md` § "Direct writes to documentation" for the repo-owned-vs-mirror boundary and the canonical edit path. Implementation behavior changes still belong in the owning repo's `specs/`, policy files, scripts, and tests.

Conflict resolution:

- If code conflicts with `specs/`: flag the conflict, update spec or tests first, then update code. Do not silently modify behavior.
- If a proposed change violates `rules/repo_rules.md`: stop and flag the violation. Do not proceed without resolution.
- If a tool folder contains instructions that conflict with `AGENTS.md` or these sub-files: follow the canonical docs and flag the duplication for removal.
- If `AGENTS.md` or its sub-files are missing required sections: flag the gap and do not assume behavior for missing sections.

## Prose sweep when a review round changes a claim

The bug-fix escalation policy (two-strike audit, agent rotation, serialization-layer review) is fleet-wide and lives in [`shared-operating-rules.md`](shared-operating-rules.md) § *Bug fix escalation policy*. This section is this repository's own addition to it and is not restated there.

When a review round changes a claim—a behavior, an ordering, or a guarantee that any repo-owned prose surface (a comment, a docstring, a spec sentence, README prose, a `plans/**` caption) asserts about the system—the author sweeps every repo-owned prose surface that restates it in the same commit (code comments and docstrings, `specs/**`, `plans/**` captions, README prose) and updates the PR body in the same review round, since a PR body is GitHub metadata and cannot be part of any commit. Generated and synced mirrors are outside the sweep, because a direct edit there is overwritten on the next sync: a restatement that lives in a `do_not_edit` PRD mirror under `docs/projects/**` or in a surface `.mergepath-sync.yml` propagates is corrected at its canonical source and re-materialized by the sync, per the generated-mirror boundary in [documentation-rules.md](documentation-rules.md). Grep the tree for the claim's key terms rather than trusting the current diff to surface every place it lives, because the trigger is "this round changed a claim," not "this round changed behavior"—a prose restatement can go stale with no code change ever touching the line it sits on, since it was accurate for the round that wrote it and nothing after that round had reason to look at it again. PR #1207 is the motivating example: an inventory taken on that PR while it was still open found five separate instances of exactly this staleness across its sixteen review rounds, each accurate when written and each caught only because a later round—or a review outside the PR's own rounds—happened to re-read the surrounding prose rather than the diff (#1212). A reviewer who finds a leftover restatement of a claim a later round already retracted treats it as a P1, not a nit.

## Session finalization

Before an agent session goes idle, implementation-ready work must end in one of three durable states: a committed PR, an explicit issue/PR handoff, or an explicit discard. Start follow-up work after a PR merges on a fresh branch or worktree from current `origin/main`; do not continue shipping follow-ups from the just-merged branch's stale checkout. Open the tracking PR or issue early enough that in-flight work is visible. Run `scripts/session-finalization-check.sh` (or equivalent `git status` / stash / worktree checks) before closeout; the script is read-only and reports dirty files, stashes, stale branch state, and dirty auxiliary worktrees without deleting work. Verified-merged local branch classification is handled by `scripts/worktree-cleanup.sh`.

## Worktree lifecycle

Worktrees created for a task must be removed immediately after the corresponding branch is merged or deleted from the remote. Never leave a worktree checked out for a branch that is `[gone]` on the remote. Stale worktrees confuse branch/HEAD reasoning, leave dead generated artifacts around, and increase the chance an agent validates or runs commands from a dead branch.

**After a merge or branch delete**, run `scripts/worktree-cleanup.sh` (dry-run) to audit stale worktrees and `scripts/worktree-cleanup.sh --apply` to remove safe candidates. The helper identifies four classes of stale state:

- worktrees whose branch upstream is `[gone]` (the branch was deleted upstream);
- detached `mergepath-pr-*` worktrees whose corresponding PR is closed/merged (cross-checked via `gh pr view`);
- local branches whose upstream is `[gone]` and whose PR is verified merged (cross-checked via `gh pr list --head <branch> --state merged`);
- orphaned directories under `.claude/worktrees/` that have no matching entry in `git worktree list --porcelain`.

```bash
scripts/worktree-cleanup.sh                       # dry-run audit (default)
scripts/worktree-cleanup.sh --apply               # remove safe candidates
scripts/worktree-cleanup.sh --apply --force-locked
                                                  # also remove LOCKED entries
                                                  # (may belong to active sessions)
scripts/worktree-cleanup.sh --apply --orphan-clean
                                                  # also rm -rf orphan dirs
```

Locked worktrees and orphan dirs are listed in dry-run but require explicit `--force-locked` / `--orphan-clean` opt-in under `--apply`, because locked worktrees may correspond to in-progress agent sessions and orphan dirs may hold partial work the user wants to keep. Verified-merged local branches are deleted only after `gh pr list --head <branch> --state merged` confirms the PR merged; checked-out local branches are listed but skipped.

This helper is intentionally local-only—worktree state is machine-local and should not gate repository CI (see #288).

## Feedback-rollup cadence model

Two complementary automations catch unaddressed review feedback at different time horizons. Agents should know which one fires when, so triage work isn't duplicated and missed-signal classes are surfaced at the right cadence.

### Daily rollup

The daily rollup (deferred-and-forgotten class) is fleet-wide: see [`shared-operating-rules.md`](shared-operating-rules.md) § *Daily feedback rollup — the deferred-and-forgotten class*. Only the weekly sweep below is local to this overlay.

### Weekly sweep—longer-tail residuals

**`.github/workflows/weekly-feedback-sweep.yml`** runs Mondays at `09:00` UTC. It enumerates UNRESOLVED review threads on closed PRs across the repositories in `target-repos.txt` (by default a 90-day lookback). Captures items that slipped past the merge gate AND remained unresolved through the daily rollup's 24h window—typically because the resolving agent's day rolled over before triage.

The sweep keys purely on GitHub review-thread state (`isResolved == false && isOutdated == false`), so a finding that was fixed during the PR but whose thread was left open re-surfaces here as if it were unactioned. Resolving actioned threads during the PR—`scripts/resolve-pr-threads.sh <PR#> --resolve-actioned`, which resolves only demonstrably-actioned threads and confirms each with an `isResolved: true` readback—keeps this backlog focused on feedback that still needs attention (#564).

See `scripts/sweep-unresolved-feedback/enumerate.sh` + `scripts/sweep-unresolved-feedback/render.sh`.

### Which one to act on

- Daily-rollup triage (substantive and polish issues) → see the shared section above.
- Quarterly backlog review → the weekly sweep's rollup issue. Items aged 7+ days, context decayed but pattern recognition still possible.

The daily rollup is per-repo; the weekly sweep is not. It reads the repositories listed in `scripts/sweep-unresolved-feedback/target-repos.txt` and `render.sh` posts one rollup issue to `SWEEP_TARGET_REPO`, which defaults to `nathanjohnpayne/mergepath` (it does not open a weekly issue per consumer). Look for the weekly rollup there, not in this repository.
