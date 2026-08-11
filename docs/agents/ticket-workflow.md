# Ticket workflow—keeping the Project board accurate

This is the manual board-update protocol every agent (and human) follows so [Project #7](https://github.com/users/nathanjohnpayne/projects/7) stays an accurate picture of the [Five Across backlog](../../plans/gaycruisebingo-backlog.md). The board is the shared source of truth for who is doing what; drift makes agents double-pick and hides what's actually Ready. The backlog and the dependency DAG / hot-file plan live in [`plans/gaycruisebingo-backlog.md`](../../plans/gaycruisebingo-backlog.md) and [`plans/gaycruisebingo-parallelization.md`](../../plans/gaycruisebingo-parallelization.md).

## Board columns (Status) and their meaning

| Status | Meaning |
|---|---|
| **Backlog** | Created, not yet startable (a `Depends on` is still open) or not yet triaged. |
| **Ready** | Every `Depends on` is `Done`; free for any agent to claim. Wave-0 unblocked tickets start here. |
| **In progress** | Claimed—exactly one agent is working it, and is the assignee. |
| **In review** | A PR with `Closes #<issue>` is open. |
| **Done** | The PR merged (issue auto-closed). |

## Built-in Project Workflows (enable these once, in the Project UI)

Project → **⋯** → **Workflows**. Enable:

- **Item added to project → set Status = Backlog**.
- **Item reopened → set Status = Backlog** (or In progress).
- **Pull request merged → set Status = Done**, and/or **Issue closed → set Status = Done**.
- **Pull request opened / linked (auto-add) → set Status = In review** if your plan offers it.

The built-ins cannot infer "claimed" or promote `Backlog → Ready` across a dependency edge—those are manual steps below.

## The manual protocol

Session prelude (once): `eval "$(scripts/op-preflight.sh --agent claude --mode all)"` then `export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"` (author identity `nathanjohnpayne`; `move-item.sh` verifies it). All commands assume `REPO=nathanjohnpayne/gaycruisebingo OWNER=nathanjohnpayne PROJECT=7`.

### 0. File a ticket (adds with no Status)

`gh project item-add` does not set Status on its own—whether or not the built-in workflow above is enabled, treat a freshly added item as landing with **no Status** and set it explicitly:

```bash
scripts/gh-as-author.sh -- gh project item-add "$PROJECT" --owner "$OWNER" --url https://github.com/nathanjohnpayne/gaycruisebingo/issues/<num>
PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
  GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh <num> "Backlog"
```

Skipping this leaves the item in a No Status column—invisible in any Status-grouped board view.

### 1. Claim a ticket (Ready → In progress)

Pick a ticket whose Status is `Ready` and whose every `Depends on` is `Done`. Claim it **atomically**—self-assign **and** move it—then comment, so a racing agent sees it's taken:

```bash
gh issue edit <num> --repo nathanjohnpayne/gaycruisebingo --add-assignee nathanjohnpayne
PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
  GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh <num> "In progress"
GH_AS_REVIEWER_IDENTITY=nathanpayne-claude scripts/gh-as-reviewer.sh -- \
  gh issue comment <num> --repo nathanjohnpayne/gaycruisebingo --body "Claiming — nathanpayne-claude."
```

If the issue already has an assignee, back off and pick another `Ready` ticket. One in-progress ticket per agent; at most one open hot-file-owner ticket at a time (see the parallelization plan).

### 2. Open the PR (In progress → In review)

Branch `feat/<slug>` off `main` (never push to `main`). Put `Closes #<num>` in the PR body so the merge closes the issue and the built-in workflow can drive Done. Then move the card:

```bash
scripts/gh-as-author.sh -- gh pr create --repo nathanjohnpayne/gaycruisebingo \
  --title "<type>: <summary>" --body "Closes #<num>

<what changed / how verified>"
PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
  GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh <num> "In review"
```

### 3. Merge (In review → Done)

After review clears per [`REVIEW_POLICY.md`](../../REVIEW_POLICY.md) (reviewer-identity `--approve` under threshold; Phase 4 for `needs-phase-4` / ≥ 300-line / `src/auth/**` PRs), merge as `nathanjohnpayne`. The `Closes #<num>` link closes the issue; if the "issue closed / PR merged → Done" workflow is on, the card moves itself. Verify (or force) it:

```bash
scripts/gh-as-author.sh -- gh pr merge <pr> --repo nathanjohnpayne/gaycruisebingo --squash --delete-branch
PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
  GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh <num> "Done"   # only if the workflow didn't
```

### 4. Promote the unblocked (Backlog → Ready)

When a ticket merges, whoever merged promotes the tickets that were waiting on it—every `Backlog` ticket whose `Depends on` set is now fully `Done`:

```bash
PROJECT=7 OWNER=nathanjohnpayne REPO=nathanjohnpayne/gaycruisebingo \
  GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT" scripts/gh-projects/move-item.sh <dependent-num> "Ready"
```

E.g. when `w0-test-harness` merges, promote `w0-firestore-rules`, `w0-storage-rules`, `w0-offline-persistence`.

## Rules of thumb

- Never work a `Backlog` ticket. If it looks ready but is still `Backlog`, check its `Depends on`—a dependency is probably still open.
- The board reflects reality: if you stop working a ticket, move it back to `Ready` and unassign.
- `move-item.sh` discovers the Status field/option ids at runtime, so the exact option names (`Backlog` / `Ready` / `In progress` / `In review` / `Done`) are what it matches—pass them verbatim.
