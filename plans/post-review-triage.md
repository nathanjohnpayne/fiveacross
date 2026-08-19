# Substantive post-review ticket triage

Triaged 2026-08-18 against Project #7, the repository operating and ticket rules, the review policy, `CONTEXT.md`, the Five Across PRD migration ladder, the live issue discussions, and `main` at `a2ae3f5`.

This is backlog sizing, not a review-feedback sweep: each item is treated as feature, bug, design, or architecture work, and no implementation is included.

The redundancy check found three important overlaps: #843 has been decomposed into the sharper #905, #906, and #907 residuals after PR #836; #844 is superseded by #802 and its open PR #891; and #852's implementation was carried by #549 and merged PR #892. No `.out-of-scope/` knowledge-base entry matches any requested ticket.

## Priority and board summary

There is no P0 in this set: none is an active account-takeover, data-loss, or Event-wide outage, and the production #850 denial is the prerequisite rather than one of the tickets being sized here.

P1: #851, #852, #854, and #888 because they either gate the wildcard-router cutover or can silently leave deployed production endpoints unreachable.

P2: #846, #853, #858, #868, #895, and #897 because they are bounded correctness, resilience, or player-facing defects without a currently live Event-wide outage.

Park: #843 and #844 because current work has superseded or decomposed them; they should not receive separate implementation branches.

Project #7 Status was set to `Backlog` for #843, #844, and #858, and `Ready` for #846, #851, #852, #853, #854, #868, #888, #895, and #897.

## #843 — redirect-return cross-tab attempt correlation

Priority: **park** — PR #836 added per-attempt token correlation and merged; the remaining narrower races now live in #905, #906, and #907, so implementing this umbrella would duplicate active tickets.

Size: **XS closeout** for verifying the decomposition and closing the umbrella; size the three residual tickets independently rather than treating this as one implementation.

Suggested runner: **Claude Sonnet 5 low** for closeout because this is a bounded comparison between the merged contract and three already-filed residuals, not fresh architecture work.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: the closeout does not trip Phase 4, but each real residual is expected to touch `src/auth/**` and therefore does.

Blocked-by: none; PR #836 is merged, and no native edge should be added merely to represent decomposition.

Project #7 Status: **Backlog** because a parked/superseded umbrella is not claimable work.

## #844 — client-forgeable membership

Priority: **park** — #802 and open PR #891 adopt exactly the required non-self-writable `events/{eventId}/memberships/{uid}` admission record and explicitly supersede this ticket.

Size: **XS closeout** after #802 lands; the actual contract work is sized on #802 and is already a large review diff in PR #891, not a second implementation here.

Suggested runner: **Claude Sonnet 5 low** for acceptance verification and closeout because the superseding PR names this issue and the comparison is narrow.

Hot-file footprint: the separate closeout touches none; the superseding PR touches `CONTEXT.md` and `src/domainTypes.d.ts`, while `src/types.ts`, `firestore.rules`, `src/index.css`, and `src/App.tsx` remain untouched.

Phase 4: the separate closeout does not trip Phase 4; PR #891 does via the at-least-300-line threshold, not a protected path.

Blocked-by: recorded native edge **#844 blocked by #802** so the duplicate stays non-claimable until its replacement contract lands.

Project #7 Status: **Backlog**.

## #846 — archive transition strands the admin-alert queue

Priority: **P2** — enqueue-time TTL now bounds retention to 30 days, but an archive between enqueue and sweep still silently drops an admin notification; the remaining product decision is delivery versus deliberate discard.

Size: **S specification/decision plus M implementation**; the spec must choose drain-on-archive versus tombstone-on-archive and pin retry, concurrency, and reactivation semantics before code changes.

Suggested runner: **Claude Opus 4.8 high** for the S spec because it must reconcile product semantics with the existing exactly-once queue, frozen batches, TTLs, and archive lifecycle; then **GPT-5.6 Sol high** for the M implementation because correctness depends on transaction, retry, and trigger behavior across the Functions subsystem.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **yes for implementation** because the work belongs in `functions/**`; the spec-only first step does not trip it if kept separate and under 300 lines.

Blocked-by: none; this ticket can start with the specification/decision step.

Project #7 Status: **Ready**.

## #851 — generic origin bundle must not bake one Event id

Priority: **P1** — attaching wildcard routes while the shared origin bakes Bodega silently routes a second hostname into the wrong Event, a cross-Event read/write failure; it gates cutover, not any merge.

Size: **S architecture/specification plus M implementation and end-to-end verification**; choose whether `fiveacross` becomes the generic hostname-resolved target or a separate router-origin target is introduced before changing target validation.

Suggested runner: **GPT-5.6 Sol high** for both steps because the work requires deep repository tooling across target builds, Vite resolution order, Firebase Hosting, Worker origin configuration, and end-to-end deployment checks, with a silent wrong-Event failure mode.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: no protected path is inherently required; it trips Phase 4 only if a combined implementation reaches 300 lines, so keep the S spec and M implementation separate.

Blocked-by: none; recorded the reverse cutover relation **#529 blocked by #851**.

Project #7 Status: **Ready**, beginning with the S architecture/specification step.

## #852 — sign-in on newly provisioned wildcard hosts

Priority: **P1** — working sign-in with no per-Event code change is a direct cutover prerequisite, and #549 plus merged PR #892 now provide the default central-handoff strategy and pre-mount readiness behavior this ticket must verify.

Size: **XS acceptance verification and closeout** now that #549 has closed; do not open a second implementation branch unless merged PR #892 fails one of #852's acceptance criteria.

Suggested runner: **GPT-5.6 Sol medium** for the verification because it must exercise the named acceptance matrix and inspect a large auth PR, but the expected task is bounded validation rather than new design.

Hot-file footprint: none of `src/types.ts`, `firestore.rules`, `src/index.css`, `CONTEXT.md`, `src/App.tsx`, or `src/domainTypes.d.ts`; the superseding work instead touches `src/auth/**`, `src/auth-domain.ts`, and `src/main.tsx`.

Phase 4: **yes for the superseding work** because PR #892 touched `src/auth/**` and was also well above 300 lines; the XS closeout itself does not.

Blocked-by: recorded native edge **#852 blocked by #549**, now satisfied by #549's completion, and the reverse cutover relation **#529 blocked by #852** until acceptance is verified.

Project #7 Status: **Ready** for acceptance verification and closeout rather than duplicate implementation.

## #853 — bug-report submission idempotency

Priority: **P2** — a lost callable response can duplicate one report and its admin-alert row, but the failure duplicates rather than loses evidence and is bounded by the intake rate limit.

Size: **S contract specification plus M implementation** across the client draft lifecycle, shared callable contract, deterministic report/storage identity, retry semantics, cleanup, and rate-limit ordering.

Suggested runner: **GPT-5.6 Sol high** for both steps because exact-once behavior depends on reconciling the client retry token, callable validation, Firestore create semantics, screenshot lifetime, `ALREADY_EXISTS`, and rate limiting without introducing a third duplicate helper.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **yes for implementation** because it changes `functions/**`; a separate under-300-line contract spec does not.

Blocked-by: none; the S contract step is startable now.

Project #7 Status: **Ready**.

## #854 — codebase-qualified selectors bypass invoker reconciliation

Priority: **P1** — a supported scoped deploy can silently skip the invoker repair and leave `submitBugReport` or `emailUnsubscribe` returning 403 in production.

Size: **XS** because the cause, matching seam, sibling implementation, and required selector-order tests are all pinned.

Suggested runner: **Claude Sonnet 5 low** because this is a narrow mechanical extension of the already-tested handoff selector parser with explicit regression cases.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **no** expected protected path and comfortably under 300 lines; `scripts/deploy.sh` is operationally sensitive but is not in the configured protected-path list.

Blocked-by: none.

Project #7 Status: **Ready**.

## #858 — freeze-boundary residual after the rules-budget repair

Priority: **P2** — the mixed-standings window requires an early ceremonial Day, later competitive Days, no stamped freeze, and a scheduler gap; neither live Event has that schedule shape.

Size: **S** after #850 because the required boundary resolver, rule guard, and one early-ceremonial regression fixture are explicit.

Suggested runner: **GPT-5.6 Sol low** because the cause and seam are pinned and the work is narrow once #850 restores expression headroom; Phase 4 review supplies the extra scrutiny appropriate to a rules change.

Hot-file footprint: `src/types.ts` no; `firestore.rules` **yes**; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **yes** because `firestore.rules` is protected regardless of line count.

Blocked-by: recorded native edge **#858 blocked by #850**; #850 already blocks #804 alongside #802 and #807, and those existing edges were not duplicated.

Project #7 Status: **Backlog**.

## #868 — Leaderboard eligibility footnote contradicts the tutorial rule

Priority: **P2** — the shipped player copy misstates a real eligibility rule for Bodega and future Events, but the affected pilot is over and ranking computation itself is correct.

Size: **XS** for conditional copy, component coverage, and the parity wireframe quote.

Suggested runner: **Claude Sonnet 5 low** because this is localized presentational work with a fully pinned domain rule and no behavioral algorithm change.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **no** protected path and expected under 300 lines.

Blocked-by: none.

Project #7 Status: **Ready**.

## #888 — App Check-compatible hostname lookup for the edge router

Priority: **P1** — Firestore App Check enforcement and the Worker's intentionally unauthenticated public point-read are incompatible, so attaching the routes would make uncached hostname resolution fail closed; weakening App Check is not acceptable.

Size: **M architecture/security specification plus L implementation** because the design must choose and prove a least-privilege lookup path, credential/IAM posture or replicated routing store, abuse controls, cache invalidation, failure semantics, and rollout/rollback.

Suggested runner: **Claude Opus 4.8 high** for the M spec because the dominant work is ambiguous cross-system architecture and threat-boundary reconciliation across Cloudflare, Firebase App Check, Firestore, IAM, and provisioning; then **GPT-5.6 Sol high** for the L implementation because it will require broad tool use and exact integration/verification across the chosen services.

Hot-file footprint: `src/types.ts` no; `firestore.rules` **conditional** only if the selected design changes the public `hostnames` read posture; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **yes for implementation** because the likely server-side design touches `functions/**`, and a Worker/replication design is still expected to exceed 300 lines; the M spec should remain a separate under-threshold PR where possible.

Blocked-by: none; recorded the reverse cutover relation **#529 blocked by #888**.

Project #7 Status: **Ready**, but only for the architecture/security specification first.

## #895 — 18+ acknowledgement is not carried across handoff sign-in

Priority: **P2** — the current path safely asks for one redundant tap and never fabricates a durable cross-Event age attestation; it is player-visible friction, not an auth-integrity failure.

Size: **M** because the fix must bind acknowledgement evidence to the handoff transaction while preserving the redirect-return correlation, TTL, abandoned-flow, and no-checkbox invariants.

Suggested runner: **GPT-5.6 Sol high** because correctness requires reconciling the newly hardened `AuthContext` completion races with the new handoff transaction and custom-token boot path across several auth subsystems.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **yes** because the implementation touches `src/auth/**`, regardless of line count.

Blocked-by: #836 and #549 have merged, so the stale blocker was replaced with native edge **#895 blocked by #549** and is now satisfied; PR #892 created the handoff client seam this residual must build on.

Project #7 Status: **Ready**.

## #897 — stored Event and Day Themes are unvalidated at the read boundary

Priority: **P2** — a malformed direct admin write can silently render an unstyled Event, but the ordinary admin UI already offers only registered, Edition-valid, non-chrome Themes.

Size: **S** for one read-boundary normalizer, a defined Edition fallback, and converter/ThemeProvider regressions covering unknown, retired, off-Edition, and chrome ids.

Suggested runner: **GPT-5.6 Sol low** because the cause and converter seam are pinned, the type contract already exists, and the main work is a small validation helper plus focused tests.

Hot-file footprint: `src/types.ts` no; `firestore.rules` no; `src/index.css` no; `CONTEXT.md` no; `src/App.tsx` no; `src/domainTypes.d.ts` no.

Phase 4: **no** protected path and expected under 300 lines.

Blocked-by: none; PR #893 has merged, so the pickable-registry distinction this ticket consumes is available on `main`.

Project #7 Status: **Ready**.

## Native dependency results

Recorded **#844 blocked by #802** for the superseding membership contract.

Recorded **#852 blocked by #549** for the central-handoff implementation in merged PR #892; that prerequisite is now satisfied, while #852 remains open for acceptance verification.

Recorded **#858 blocked by #850** for the rules-expression budget prerequisite.

Recorded **#895 blocked by #549** because #549 and merged PR #892 provide the handoff client seam; the satisfied edge records the sequencing without preventing #895 from starting.

Recorded **#529 blocked by #851, #852, and #888** so the router epic cannot be treated as cutover-ready while its generic bundle, wildcard sign-in, or App Check lookup prerequisite remains open; these edges gate route attachment, not the merge of any prerequisite.

Keep the already-present **#804 blocked by #802, #850, and #807** relationships unchanged.
