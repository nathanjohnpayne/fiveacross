# AGENTS.md

Agent instructions are organized into focused sub-files under `docs/agents/`. Read the relevant file(s) before taking action in this repository.

## Sections

1. **[Repository Overview](docs/agents/repository-overview.md)** --- Project description, tech stack, agent role
2. **[Agent Operating Rules](docs/agents/operating-rules.md)** --- Reading order, conflict resolution, the prose sweep required when a review round changes a claim
3. **[Code Modification Rules](docs/agents/code-modification-rules.md)** --- File creation, duplication, directory constraints
4. **[Documentation Rules](docs/agents/documentation-rules.md)** --- When and what to update; which `docs/**` paths are directly editable vs generated mirrors
5. **[Testing Requirements](docs/agents/testing-requirements.md)** --- Coverage expectations, test deletion policy
6. **[Deployment Process](docs/agents/deployment-process.md)** --- Build/deploy flow, 1Password-backed auth
7. **[Ticket Workflow](docs/agents/ticket-workflow.md)** --- Project #7 board discipline: claim protocol and the exact Status transitions (Ready → In progress → In review → Done)

## Repository Layout

Most top-level directories are described by the `docs/agents/` files above or are self-evident. The app-specific ones carry their justification out-of-line, per the [Code Modification Rules](docs/agents/code-modification-rules.md) requirement that new top-level directories document their justification here or in a `plans/` entry:

- **`public/`** --- the Vite app's static-assets directory (icons, PWA manifest, service worker, `og-default.png`), served verbatim by Firebase Hosting. Whitelisted in `.repo-template.yml` (`extra_top_level_dirs`); the app-scaffold directory rationale lives in [`plans/app-scaffold-dirs.md`](plans/app-scaffold-dirs.md).
- **`worker/`** --- the Cloudflare Worker Event router that fronts the wildcard Namespaces `*.fiveacross.app` and `*.vacaybingo.com` (#545, epic #529; contract in [`specs/event-router.md`](specs/event-router.md), operations in [`worker/README.md`](worker/README.md)). Top-level for the same reason `functions/` is: it is a **separately deployed service with its own runtime, its own build tool (`wrangler`) and its own dependency tree**, not a part of the Vite app --- it never enters the bundle, and Vite would have no idea what to do with it. Nesting it under `src/` would put a workerd-targeted program inside the browser app's TypeScript project, whose `@cloudflare/workers-types` would then retype globals like `fetch` and `caches` for every file in it (the hazard `tsconfig.json`'s own note describes for `src/sw.ts`). Its decision modules are nonetheless typechecked by the root `npm run typecheck` (via `worker/tsconfig.json`) and tested by the root `npm test`, because every platform seam is injected --- only `wrangler` itself lives in `worker/package.json`. Whitelisted in `.repo-template.yml` (`extra_top_level_dirs`).
- **`router-publisher/`** --- the dedicated Google Cloud Functions v2 Firestore-event receiver that signs private registry sync requests with Cloud KMS (#970, epic #888; contract in [`specs/event-router-registry.md`](specs/event-router-registry.md)). It is isolated from `functions/` because its runtime identity must have **no Firestore/Admin SDK data-plane capability or dependency**: a raw Functions Framework CloudEvent handler receives the desired state in its event payload, gets an OIDC token and KMS signing authority from the metadata server, and does nothing else. Its locked graph excludes both `firebase-admin` and `firebase-functions`; `deployment.json` plus the render-only deployment-plan script keep retry/identity/trigger settings explicit, while ordinary Firebase deployments continue to use `firebase.json` and cannot discover this codebase. Whitelisted in `.repo-template.yml` (`extra_top_level_dirs`).

## Code Review Policy

This repository uses a multi-identity AI agent code review system. The full policy is in REVIEW_POLICY.md. The per-repo configuration is in .github/review-policy.yml.

### Identity Rules

- All agents author code as nathanjohnpayne. Local sessions also use the human committer; Claude cloud sessions retain the approved signed committer described in [Cloud Agent Environments](docs/agents/cloud-environments.md).
- Each agent reviews code under its own reviewer identity (e.g., nathanpayne-claude, nathanpayne-cursor, nathanpayne-codex).
- An agent never reviews code under the same identity that authored it.
- Only nathanjohnpayne merges to the target branch.
- Agents may add `human-hold` to freeze a PR, but must never remove it. The label is human-remove-only and supersedes all merge paths.

### Workflow Summary

Use [REVIEW_POLICY.md § Workflow](REVIEW_POLICY.md#workflow) for credential preflight, author/reviewer identities, review rounds and merge gates. The [agent operating rules](docs/agents/operating-rules.md) and [testing requirements](docs/agents/testing-requirements.md) cover local execution details.

1. Author as `nathanjohnpayne`, file the PR through `scripts/gh-as-author.sh`, and include the required `Authoring-Agent:` and `## Self-Review` body fields.
2. Review under a registered reviewer identity. Resolve eligible bot conversations and registered agent-reviewer conversations after that reviewer accepts the fix; stop for real-human conversations unless the human explicitly directs otherwise. Follow the policy's complete-history feedback accounting before merging.
3. Run `scripts/coderabbit-should-invoke.sh` to select Phase 2.5. When that phase observes a CodeRabbit rate-limit or included-quota refusal, request Codex immediately; do not wait out the provider window or post a CodeRabbit retry. See [Phase 2.5](REVIEW_POLICY.md#phase-25-automated-external-review-coderabbit).
4. A rate-limited under-threshold PR still needs exact-head Codex clearance before reviewer approval. Record the provider and full SHA in the later approval as required by [Phase 3](REVIEW_POLICY.md#phase-3-external-review-threshold-check).
5. Use the configured threshold, protected paths and the force-on `needs-external-review` label to route [Phase 4](REVIEW_POLICY.md#phase-4-external-review). Apply the governing policy's request budgets, external-review requirements and human escalation rules.
6. Outside an active native merge-queue rollout, merge one current, approved head as `nathanjohnpayne` through the author wrapper only after all applicable gates and review conversations clear. During an active rollout, follow the [canonical native merge-queue policy](https://github.com/nathanjohnpayne/mergepath/blob/main/REVIEW_POLICY.md#native-merge-queue-boundary-1058) and leave activation, queue actions and any direct merge to the human owner. Preserve human holds, reviewer disagreements and actual in-flight Codex review stops.

### Disagreements

If the internal reviewer and external reviewer disagree on whether code is ready to merge, the human is the tiebreaker. Surface both positions clearly and wait.

In Phase 4a specifically, the agent escalates automatically on any of three signals: **repeat-after-rebuttal** (Codex re-flags a finding after the agent posted a rebuttal reply), **runaway** (the Phase 4b barrier's `runaway` stop at a spent request ceiling: every request `codex.max_review_rounds` allowed drew a blocking review; the ceiling alone is cost exhaustion, not a runaway), or **blocking-review budget** (requester exit `7` with `cap_exhausted.kind: "blocking-reviews"`: the PR already holds `codex.max_blocking_reviews` solicited Codex responses that are blocking, unknown-tier or conflicting, default 10, #1560). A spent **request ceiling** (requester exit `7` with `cap_exhausted.kind: "request-ceiling"`) is not one of them: run `scripts/phase-4b-review.sh`, whose barrier dispatches the adapter when no human stop holds and exits `8` when one does (#1560 slice 3). On escalation, the agent stops the loop, posts a comment on the PR summarizing both positions with links to the review rounds, alerts the human, and does not merge or route to automated Phase 4b. For blocking-budget exhaustion, or a Phase 4b exit `8`, the comment instead reports the configured and consumed counts (requests, and blocking reviews), any provider-block diagnostic, and the observed final-request/response state (or that it is unknown); opposing positions and rebuttal links are not required. Timeout (exit code `4` from `codex-review-request.sh`) is NOT a disagreement — it falls back to Phase 4b directly. Full detail in REVIEW_POLICY.md § Disagreements and Tiebreaking.

### Adding a New Agent

1. Create a GitHub account: nathanpayne-{agent}
2. Add it to available_reviewers in .github/review-policy.yml.
3. Configure the agent environment with credentials for both nathanjohnpayne and the new reviewer identity.

For the complete policy including the handoff message format, post-merge issue creation rules, commit identity inspection and verified GitHub API credentials, read REVIEW_POLICY.md.
