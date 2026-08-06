---
spec_id: w0-firestore-rules
status: accepted
---

# Firestore rules baseline (`firestore.rules`)

`firestore.rules` is the security-rules contract for every Firestore document. This spec pins its Phase-0 reconciliation to the accepted ADRs and proves each invariant against the real Firestore emulator on the `w0-test-harness` rules layer. It is exercised by `tests/rules/w0-firestore-rules.test.ts` (rules-emulator) and validated by `scripts/ci/check_spec_test_alignment`.

## Marks are client-authoritative: boards/players stay self-writable (ADR 0001)

Because Marks are client-authoritative and the live Feed is the source of truth, a Player writes their own Board and denormalized stats directly. Self-writable `boards/{uid}` and `players/{uid}` are intentional, not a hole to close—a reviewer who "locks down" stat writes has misread the design.

- **Given** the emulator + rules **When** an owner writes their own `boards/{uid}` or `players/{uid}` **Then** the write is ALLOWED, and a write to another Player's board or stats is DENIED. (Test: "ADR 0001: boards/players are self-writable; cross-player writes denied".)

## A Mark is private on the Board but public as an attributed per-Prompt Tally (ADR 0002)

Marking is a deliberate public act at the per-Prompt grain: every Mark—proofed or not—publishes an attributed entry to its Prompt's Tally, even though the Board that holds it stays private. Attribution is enforced per marker at `tally/{itemId}/markers/{markerUid}`, whose doc id is the marker's uid, so a Player writes only their own entry and no anonymity is offered by design. The denormalized aggregate doc `tally/{itemId}` (the Square badge count) is public-read and admin/Cloud-Function-maintained, never client-forged.

- **Given** a Mark **When** a Player writes their own `markers/{uid}` entry (uid + displayName + markedAt) **Then** the write is ALLOWED, is publicly readable, and unmarking removes exactly that entry, while targeting another Player's slot or forging the entry's uid is DENIED. (Test: "ADR 0002: a Mark publishes an attributed Tally entry; forgery denied; reads public".)
- **Given** the denormalized aggregate **When** a non-admin writes `tally/{itemId}` **Then** it is DENIED, while an admin write is ALLOWED. (Same test.)

## Moments broadcast a big beat; Doubts are social pressure, never a gate (ADR 0002 / 0001)

A Player may post a `moments/{id}` announcement of their own BINGO / Blackout / First-to-BINGO beat (public read); a bare Mark broadcasts nothing to the Feed. A Player may raise a `doubts/{id}` on another Player's marked Prompt (public read); a Proof satisfies it but never blocks, unmarks, or discounts the Mark.

- **Given** a Moment **When** a Player posts it for their own beat **Then** it is ALLOWED and publicly readable, while a forged-uid Moment is DENIED. (Test: "ADR 0002: Moments broadcast a big beat—own-attributed, public".)
- **Given** a Doubt **When** a Player raises it on another's Mark **Then** it is ALLOWED and publicly readable, while a forged-`fromUid` Doubt is DENIED. (Test: "ADR 0001: Doubts are social pressure—own-attributed, public, never a gate".)

## Reactive moderation: report-only increments and a validated threshold (ADR 0004)

A Report only increments `reportCount`; when it crosses the Event's `reportHideThreshold` the content is presentationally hidden (Phase 0). An `items` update that touches any field other than a single `reportCount` increment is denied, `settings.reportHideThreshold` must be a number, and `blackoutEnabled` is not reintroduced.

- **Given** an `items` update **When** it only increments `reportCount` by 1 **Then** it is ALLOWED, and any other field change is DENIED. (Test: "ADR 0004: items are report-only increments; reportHideThreshold validated".)
- **Given** an `items` create **When** the Prompt carries `spicy: true` or `spicy: false` **Then** it is ALLOWED, while a missing or non-boolean `spicy` value is DENIED so the stratified Board composition input stays well-typed. (Test: "items create requires a boolean spicy tag for stratified board composition".)
- **Given** an Event update **When** an admin sets a numeric `settings.reportHideThreshold` **Then** it is ALLOWED, while a non-numeric value or a non-admin write is DENIED. (Same test.)

## Proof media is pinned to the proof's own Storage object

The existing `proofs/{proofId}` create payload is kept intact: the uploader owns the doc, the proof starts visible and unreported, and `storagePath`/`mediaURL` are pinned to the object named after the proof's own doc id so a client cannot point the record at a different, unscanned object.

- **Given** a proof create **When** the payload's storagePath + mediaURL match the proof's own object **Then** it is ALLOWED, while a mediaURL pointing at a different object is DENIED. (Test: "proofs media is pinned to the proof's own Storage object".)

## Honor-system 18+ self-attestation (ADR 0001)

A User records their own `attestedAdultAt` (a self-statement, not identity verification) under the `users/{uid}` self-write; when present it must be a numeric ms-epoch stamp, and a cross-user write is denied.

- **Given** a User **When** they self-write their own `attestedAdultAt` as a number **Then** it is ALLOWED, while a cross-user write or a non-numeric value is DENIED. (Test: "ADR 0001: a User self-attests 18+ (attestedAdultAt); cross/invalid denied".)
