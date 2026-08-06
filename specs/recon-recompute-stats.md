---
spec_id: recon-recompute-stats
status: accepted
---

# Reconciliation: remove `recomputeStats` as anti-cheat (`functions/src/index.ts`, `docs/app/phase-1-deploy.md`)

ADR 0001 (the honor system) makes Marks client-authoritative and `players/{uid}` self-writable *by design*. The scaffolded `recomputeStats` Cloud Function was framed as authoritative / anti-cheat, but it read the same Player-written Board and rewrote the same Player stats—same data in, same data out—so it added no integrity and only re-derived what the client already wrote (its own comment conceded that real anti-cheat "would also validate individual mark transitions; out of scope"). This reconciliation removes it, keeps `moderateProof` (the real ADR-0004 Phase-1 moderation surface), and fixes the `phase-1-deploy.md` guidance that told operators to lock player-stat writes to admins-only. The removal and the doc fix are guarded by `src/recon-recompute-stats.test.ts` (unit; asserts on the two source files' contents and runs under `npm test`).

## `recomputeStats` is gone from the functions source

`functions/src/index.ts` no longer exports the `recomputeStats` trigger, and the imports that existed only to serve it are dropped too, so the functions build (`tsc`) stays green with no orphaned symbols.

- **Given** ADR 0001 supersedes recompute-as-anti-cheat **when** `functions/src/index.ts` is read **then** it contains no `recomputeStats` reference at all. (Test: "functions/src/index.ts no longer defines recomputeStats".)
- **Given** `recomputeStats` was the sole consumer of the board-logic helpers **when** it is removed **then** the `./logic` import (`completedLines` / `countMarked` / `isBlackout` / `Cell`) is gone and the file itself is deleted. The guard deliberately does not ban `onDocumentWritten` wholesale—#43 (w4-phase1-functions) legitimately adds document triggers for the server-authoritative hide; the pinned invariant is that nothing recomputes player stats. (Test: "drops the imports that only served recomputeStats".)

## `moderateProof` is kept intact

The removal is surgical—the ADR-0004 Phase-1 moderation Function is untouched (its ownership stays with #43). Note (post-#126): `moderateProof` is now CONDITIONALLY exported—gated behind the off-by-default `ENABLE_VISION_MODERATION` flag, so it is a deployed CloudFunction only when Cloud Vision is enabled (see `specs/w4-gate-vision-moderation.md`). The `export const moderateProof` declaration this reconciliation pins is still present in the source—which is all the guard below asserts—but it evaluates to `undefined`, and is skipped by Firebase's export discovery, when the flag is off.

- **Given** `moderateProof` is the real Phase-1 moderation surface **when** `functions/src/index.ts` is read **then** it still declares the `export const moderateProof` binding (conditionally a CloudFunction since #126). (Test: "keeps moderateProof intact".)

## `phase-1-deploy.md` no longer tells operators to lock player-stat writes

The "Optional hardening" block that advised tightening the `players/{uid}` rule to profile-fields-only (to make stats server-owned) is removed, because there is no server recompute to justify it and the lock would break the client stat writes.

- **Given** a future operator reading the deploy guide **when** they reach the storage & rules step **then** there is no `players/{uid}` stat-locking rule block, no "Optional hardening" block, and no guidance to keep, recreate, or harden around `recomputeStats`—the one permitted mention is the operator note that the next functions deploy implicitly deletes an already-deployed copy ("do not recreate the function"). (Test: "phase-1-deploy.md drops the players/{uid} stat-locking hardening block".)

## `phase-1-deploy.md` documents Players as self-writable by design

The corrected guide states the honor-system intent so no later reader "hardens" it back.

- **Given** ADR 0001 **when** the deploy guide is read **then** it states player stats stay client-authoritative and `players/{uid}` is self-writable by design. (Test: "phase-1-deploy.md documents players as self-writable by design (ADR 0001)".)
