**Track:** security · **Phase:** 0 · **Wave:** 0 · **Size:** L · **ADR(s):** 0001, 0002, 0004
**Epic:** #__NUM_epic-foundation__
**Labels:** agent-action, track:security, phase-0, wave-0, size:L, needs-phase-4

## Context & scope
Reconcile `firestore.rules` to the ADRs and PROVE it with `@firebase/rules-unit-testing`. The load-bearing decision: the self-writable `boards/{uid}` and `players/{uid}` rules are INTENTIONAL (ADR 0001 — Marks are client-authoritative), so the tests ASSERT they are ALLOWED; "locking them down" is a misread. Add rules for the greenfield `tally`, `doubts`, and `moments` collections and `users.attestedAdultAt`, keep `items` report-only-increment, keep the `proofs` payload pinning, and validate `settings.reportHideThreshold`. Every Mark must be able to publish an attributed entry to the public per-Prompt Tally (ADR 0002). HOT-file owner of `firestore.rules`.

## Current state (scaffold)
- **Exists:** helpers `signedIn/isOwner/isAdmin`; `users/{uid}` self-write (`:14-17`); `events/{eventId}` admin-write; `items/{itemId}` create-if-valid + report-only-increment update (`25-41`); `players/{uid}` self create/update `isOwner||isAdmin` (`45-49`, INTENTIONAL); `boards/{uid}` self read/write (`52-54`, INTENTIONAL); `proofs/{proofId}` (`57-125`) read active-only for non-admins + strict create payload with exact Event/actor/Proof storagePath pinning with null mediaURL and thumbURL + report-only update; `claims/{claimId}` (`129-133`).
- **Missing:** rules for `tally`, `doubts`, `moments`; a `users.attestedAdultAt` write allowance; `settings.reportHideThreshold` validation; any emulator tests.
- **Contradicts:** none in the rules themselves — but `docs/app/phase-1-deploy.md` advising admin-only player-stat writes is the ADR-0001 misread this ticket must NOT follow.

## Files to create / modify
- `firestore.rules` — add `tally`/`doubts`/`moments` collection rules; allow `users/{uid}.attestedAdultAt` self-write; validate `settings.reportHideThreshold` on Event update; keep boards/players self-writable; keep items report-only-increment; keep proofs payload pinning.
- `tests/rules/firestore.test.ts` (new) — the emulator assertions (harness from `w0-test-harness`).

## Implementation notes
- ADR 0001: `boards/{uid}` + `players/{uid}` stay self-writable; add a rules COMMENT marking them self-writable-by-design so a reviewer does not "fix" them (the fuller doc treatment is `w3-security-hardening`).
- ADR 0002: `tally/{itemId}` — a signed-in Player may add/update THEIR OWN attributed entry (uid + displayName); reads are public; forged attribution is denied. No anonymity. A bare Mark still posts nothing to the Feed (a Feed concern, not the Tally).
- `moments/{id}` — a Player may create a Moment for their own big beat (BINGO/Blackout/First to BINGO); public read. `doubts/{id}` — a Player may raise a Doubt on another's marked Prompt; public read; a Proof satisfies it, never a gate (ADR 0001).
- ADR 0004: keep `items` update as report-only-increment (only `reportCount` +1); validate `settings.reportHideThreshold` is a number; do NOT reintroduce `blackoutEnabled`.
- `firestore.rules` is not a protected path in `.github/review-policy.yml` today, so `needs-phase-4` here is the planning marker: keep the PR < 300 lines and expect external review.

## Tests to add
- `tests/rules/firestore.test.ts` — owner write to `boards/{uid}` and `players/{uid}` ALLOWED; cross-uid DENIED (layer: rules-emulator; ADR 0001).
- a Mark writes an owner-attributed `tally` entry ALLOWED; forged-uid attribution DENIED (layer: rules-emulator; ADR 0002).
- an `items` update that only increments `reportCount` ALLOWED; mutating any other field DENIED (layer: rules-emulator; ADR 0004).
- a `proofs` create with a valid pinned payload ALLOWED; a foreign storagePath or any non-null mediaURL/ thumbURL DENIED (layer: rules-emulator).
- `users/{uid}.attestedAdultAt` self-write ALLOWED; cross-user DENIED (layer: rules-emulator).

## Acceptance criteria
- **Given** the emulator + rules **When** an owner writes their own board/player **Then** it is ALLOWED (ADR 0001 — self-writable by design).
- **Given** a Mark **When** it writes its Tally entry **Then** an owner-attributed write is ALLOWED and publicly readable with uid + displayName, and a forged-attribution write is DENIED (ADR 0002).
- **Given** an `items` update touching more than `reportCount` **Then** it is DENIED (report-only increment; ADR 0004).
- [ ] Self-writable board/player asserted ALLOWED (no lock-down).
- [ ] `tally`/`doubts`/`moments` + `attestedAdultAt` rules added and tested.
- [ ] `items` report-only-increment + `reportHideThreshold` validation asserted.
- [ ] PR kept < 300 lines.

## Definition of Done
- [ ] Spec `specs/w0-firestore-rules.md` created/updated **with a matching test** (checker `scripts/ci/check_spec_test_alignment` matches basename → a test under `tests/**` or `src/**/*.test.*`; design-only specs use frontmatter `tested: false` + `reason:`)
- [ ] `npm run typecheck` · `npm test` · `npm run build` green locally (no `lint` script; app tests are not CI-run — record in the commit `Verified:` trailer)
- [ ] Repo gates pass: `repo_lint` (incl. spec↔test alignment), `md-prose-wrap`, review-policy label gate
- [ ] Conventional commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body `Closes #<this issue>`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; driven to merge
- [ ] Board discipline per `docs/agents/ticket-workflow.md` (claim → In progress; PR → In review; merge → Done)

## Dependencies
- Depends on #__NUM_w0-test-harness__ — needs the `@firebase/rules-unit-testing` emulator harness.
- Blocks #__NUM_w1-adult-attestation__, #__NUM_w1-board-deal-join__, #__NUM_w1-prompt-pool__ — Wave-1 rules consumers.
- Blocks #__NUM_w2-tally__, #__NUM_w2-admin-console__ — Wave-2 rules consumers.
- Blocks #__NUM_w3-security-hardening__, #__NUM_w4-phase1-functions__ — later hardening / Phase 1.
