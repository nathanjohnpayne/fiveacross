**Track:** security · **Phase:** 0 · **Wave:** 0 · **Size:** S · **ADR(s):** 0004
**Epic:** #__NUM_epic-foundation__
**Labels:** agent-action, track:security, phase-0, wave-0, size:S, needs-phase-4

## Context & scope
Prove `storage.rules` with `@firebase/rules-unit-testing`: the MIME + size caps (`okImage()` image/* < 8 MB, `okAudio()` audio/* < 12 MB) are the upload-time moderation surface (ADR 0004). Assert the avatar and Proof-object paths, the inert `/og/**` block, and — critically — that the Storage Proof-object pinning matches the Firestore `proofs` create-payload contract, so a Proof that passes Storage also passes Firestore. HOT-file owner of `storage.rules`; this is a small (S) test-first ticket that mostly adds coverage.

## Current state (scaffold)
- **Exists:** `okImage()` (image/* < 8 MB) and `okAudio()` (audio/* < 12 MB); `/avatars/{file}` write if `file == uid+'.jpg' && okImage()`; `/proofs/{eventId}/{uid}/{file}` owner create/update image||audio, owner/admin delete; `/og/{**}` public read, `write:false` (inert). `uploadProofMedia` writes `proofs/{EVENT_ID}/{uid}/{proofId}.{jpg|webm}`; `uploadAvatar` writes `avatars/{uid}.jpg`.
- **Missing:** any Storage emulator tests.
- **Contradicts:** none — but the Storage Proof-object pinning MUST be cross-checked against the Firestore `proofs` create-payload contract (`firestore.rules:57-125`); tighten `storage.rules` only if they diverge.

## Files to create / modify
- `tests/rules/storage.test.ts` (new) — the Storage emulator assertions.
- `storage.rules` — modify only if the cross-check reveals a mismatch with the Firestore Proof-create contract; otherwise unchanged (file owner).

## Implementation notes
- ADR 0004: the size/MIME caps are the moderation gate at upload; assert `okImage` rejects > 8 MB or non-image and `okAudio` rejects > 12 MB or non-audio.
- avatars: only the owner may write `avatars/{uid}.jpg`; a different filename or a different uid is DENIED.
- proofs: only the owner may create/update `proofs/{eventId}/{uid}/{proofId}.{jpg|webm}`; owner/admin may delete; a non-owner write is DENIED.
- og: `/og/**` is public-read, `write:false` — assert writes are DENIED (the OG renderer is dropped per ADR 0005 in `recon-share-og`; the block stays inert).
- Cross-check: a Proof object path that satisfies `storage.rules` must also satisfy the exact Event/actor/Proof storagePath that the Firestore `proofs` create rule pins, with mediaURL and thumbURL both null; `w0-storage-rules` keeps the two in lockstep.
- `storage.rules` is not a protected path today, so `needs-phase-4` is the planning marker: tiny PR, expect external review.

## Tests to add
- `tests/rules/storage.test.ts` — `okImage`: a 7 MB image ALLOWED, a 9 MB image DENIED, a non-image DENIED (layer: rules-emulator).
- `okAudio`: an 11 MB audio ALLOWED, a 13 MB audio DENIED, a non-audio DENIED (layer: rules-emulator).
- `avatars/{uid}.jpg` owner write ALLOWED; `avatars/{other}.jpg` and a wrong filename DENIED (layer: rules-emulator).
- `proofs/{eventId}/{uid}/{proofId}.{jpg|webm}` owner create ALLOWED; non-owner DENIED; owner/admin delete ALLOWED (layer: rules-emulator).
- `/og/**` write DENIED, read ALLOWED (layer: rules-emulator).
- cross-check: a valid Proof object path satisfies both `storage.rules` and the Firestore Proof-create contract (layer: rules-emulator).

## Acceptance criteria
- **Given** a > 8 MB image **When** uploaded to a proofs/avatars path **Then** Storage DENIES it (`okImage` cap).
- **Given** `avatars/{uid}.jpg` **When** the owner writes it **Then** ALLOWED; a different uid's path is DENIED.
- **Given** a valid Proof object path **When** checked against the Firestore Proof-create contract **Then** both accept it (pinning in lockstep).
- [ ] `okImage`/`okAudio` size + MIME caps asserted.
- [ ] avatar + Proof-object owner-only paths asserted.
- [ ] inert `/og/**` write-deny asserted.
- [ ] Storage↔Firestore Proof pinning cross-checked.

## Definition of Done
- [ ] Spec `specs/w0-storage-rules.md` created/updated **with a matching test** (checker `scripts/ci/check_spec_test_alignment` matches basename → a test under `tests/**` or `src/**/*.test.*`; design-only specs use frontmatter `tested: false` + `reason:`)
- [ ] `npm run typecheck` · `npm test` · `npm run build` green locally (no `lint` script; app tests are not CI-run — record in the commit `Verified:` trailer)
- [ ] Repo gates pass: `repo_lint` (incl. spec↔test alignment), `md-prose-wrap`, review-policy label gate
- [ ] Conventional commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body `Closes #<this issue>`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; driven to merge
- [ ] Board discipline per `docs/agents/ticket-workflow.md` (claim → In progress; PR → In review; merge → Done)

## Dependencies
- Depends on #__NUM_w0-test-harness__ — needs the `@firebase/rules-unit-testing` emulator harness.
- Blocks #__NUM_w1-profile-avatar__ — avatar upload relies on the emulator-tested `avatars/{uid}.jpg` rule.
- Blocks #__NUM_w2-proof-capture__ — Proof upload relies on the emulator-tested `proofs/**` pinning.
