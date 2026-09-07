---
spec_id: cloud-vision-moderation
status: accepted
---

# Cloud Vision moderation: auto-hide extreme/illegal Vision flags (#133)

The **consumer** half of Cloud Vision. `moderateProof` (the producer, [`w4-gate-vision-moderation.md`](w4-gate-vision-moderation.md) and #132) scans an uploaded Proof photo with SafeSearch and, for extreme/illegal media only, merge-sets `{ status: 'flagged', visionFlag }` onto the Proof doc. Nothing acted on that flag: the shipped report-count auto-hide ([`w4-server-authoritative-hide.md`](w4-server-authoritative-hide.md), #43) is deliberately **active-only** and leaves a `'flagged'` doc alone, so an extreme Vision verdict surfaced to admins and was hidden by nobody. This spec records the path that closes it — a second server-authoritative writer that takes a Vision-flagged Proof to `status: 'hidden'` — plus the moderation-queue treatment that makes a Vision hide legible as one, and the Restore semantics that keep it reversible.

It completes reactive moderation's automated leg per [ADR 0004](../docs/adr/0004-reactive-moderation.md): automated flagging and hiding for illegal/extreme content only, never a posting gate and never a pre-moderation review queue. It is not authorization ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)) — hiding media touches no Mark, no stat, and no Board, and the honor system is unchanged.

## Why the report-count path could not simply be widened

`shouldHideAtThreshold`'s active-only gate exists so a stale report bump can never downgrade the stronger `'flagged'` state to a **plain** `'hidden'` — one that carries no reason, that the console renders identically to a community hide, and that an admin could Restore without ever learning the media had been Vision-flagged. Relaxing that gate to cover `'flagged'` docs would have produced exactly the outcome it was written to prevent.

So the fix is a second writer rather than a wider first one, and the split is the doc's own state:

| | `functions/src/autohide.ts` (#43) | `functions/src/visionHide.ts` (#133) |
|---|---|---|
| Owns | `'active'` docs | `'flagged'` docs |
| Reads | the Event's `settings.reportHideThreshold` | the Proof's own `visionFlag` |
| Applies to | Prompts and Proofs | Proofs |
| Lifted by | `Clear reports` (zero the counter) | `Restore` (there is no counter) |

Neither predicate can fire on a doc the other owns, so the two paths cannot contend for one write, and #43's decision path is untouched by this change: `autohide.ts` gains one additive `export` on its existing Firestore-handle factory (`adminFirestore`, shared so the second writer reaches Firestore exactly the way the first does) and no behavioural diff at all.

## The Vision hide

`hideProofOnVisionFlag`, an `onDocumentWritten` trigger over `events/{eventId}/proofs/{proofId}` in `functions/src/index.ts`, delegates to `applyVisionFlagHide` (`functions/src/visionHide.ts`). As with the threshold pair, the decision is a pure predicate and the Firestore surface is injected, so the whole flow is unit-testable without a Functions runtime. It inherits the module's global `us-central1` region and pins `ADMIN_SDK_SERVICE_ACCOUNT`, because the transactional re-read and the hide write are Firestore data-plane calls the project's default Gen2 compute identity cannot make.

### Extreme/illegal only, by allowlist

`AUTO_HIDE_VISION_FLAGS` is `['violence', 'extreme']` — exactly the two verdicts `moderateProof` emits for extreme/illegal media — and `isAutoHideVisionFlag` is a strict membership test. An **allowlist rather than a denylist** is the ADR 0004 guarantee rather than a style preference: the app is intentionally racy, and auto-hiding for raciness is the one outcome this feature must never produce. A denylist ("hide unless the verdict is `racy`") would auto-hide every flag a future producer learned to write the moment it appeared, with no change here. The allowlist fails the other way — an unrecognized verdict reaches admins as a `'flagged'` doc and is hidden by nobody.

### One state predicate, at both gates

`qualifiesForVisionHide(doc)` is true iff the doc is currently `'flagged'` **and** carries an allowlisted `visionFlag`. It is deliberately a **state** predicate where the report path's snapshot gate is a **transition** one (`shouldHideAtThreshold` needs "`reportCount` rose" to tell a fresh crossing from an admin restore that left the count over the bar). Here the status carries that distinction alone, so the same predicate serves the snapshot gate and the live write-time re-confirm, and three properties follow:

- **Loop guard.** The hide write makes the doc `'hidden'`, not `'flagged'`, so the re-fired `onDocumentWritten` no-ops. No infinite loop.
- **Admin Restore is preserved.** `restoreProof` (`src/data/admin.ts`) writes `status: 'active'` and leaves `visionFlag` in place; that doc is no longer `'flagged'`, so this path never re-hides it and the restore sticks. It is the same shape as the report path's restore, which survives because it leaves `reportCount` un-raised. A restored Proof is re-hidden only by a fresh scan (a re-upload re-flags it) or by an admin.
- **Retry-safe.** Because it reads state rather than a transition, any later write that leaves the doc `'flagged'` with an extreme verdict — a report bump, an admin `Clear reports` — re-attempts a hide an earlier swallowed best-effort failure never landed. A transition gate would have to see the verdict appear a second time, which nothing would ever do.

### The write is conditional on LIVE state, in a transaction

`applyVisionFlagHide` decides on the event snapshot and hands off to `hideVisionFlaggedIfQualifies`, which inside a Firestore transaction re-reads the Proof and writes `status: 'hidden'` (via `tx.update`, never a re-creating `set`) only if it still qualifies — the same guard `hideIfQualifies` gives the report path. So an admin who Restored or hand-Hid the Proof since the trigger fired is not silently reverted, a Proof deleted since the snapshot is never re-created, and a verdict no longer in the allowlist writes nothing.

It writes `status` and **nothing else**. Leaving `visionFlag` on the doc is the point of the whole ticket: the result is `hidden` *with its reason attached*, which is what lets the console tell a Vision hide from a report-count one, and what `notify.ts` `deriveReason` already labels with the verdict rather than `(reports >= threshold)`.

`applyVisionFlagHide` is best-effort and never throws: a write failure is swallowed (`console.error`, return `false`) so the trigger never crashes the proof pipeline, mirroring `applyThresholdHide`, `moderateProof`, and the #101 notifier. The snapshot predicate runs before any Firestore access, so every write that is not a flagged-and-extreme Proof — every create, every report bump, every admin action, and the hide's own re-fire — costs one predicate and no read. Nothing here reads the Event doc at all.

### It deploys independently of the producer

The trigger is exported **unconditionally**, unlike the `ENABLE_VISION_MODERATION`-gated `moderateProof`. With the producer off nothing ever writes a `visionFlag`, so the trigger short-circuits on every write; with it on, the consumer is already deployed and needs no second cutover. Gating it on the same flag would additionally mean a Proof flagged while Vision was enabled silently stops being auto-hidden the moment an operator turns the producer back off — the wrong direction to fail. The remaining #132 work (enable the Cloud Vision API, set `ENABLE_VISION_MODERATION=true`, deploy) is human provisioning that this half neither performs nor assumes.

- **Given** `moderateProof` merge-set `{ status: 'flagged', visionFlag: 'violence' }` (or `'extreme'`) **when** the trigger runs **then** the Proof is flipped to `status: 'hidden'` with `visionFlag` intact and nothing else written. (Tests: `tests/functions/cloud-vision-moderation.test.ts`.)
- **Given** a verdict outside the allowlist — `racy`, `adult`, an unknown or mis-cased string, a non-string, or no verdict at all — **then** nothing is hidden, with no Firestore read. (Tests: the `isAutoHideVisionFlag` and short-circuit cases.)
- **Given** an `'active'` (restored), `'pending'`, `'hidden'`, or deleted Proof **then** the path no-ops — so the loop guard holds, an admin Restore sticks, and a deleted Proof is never re-created. (Tests: the `qualifiesForVisionHide` and `hideVisionFlaggedIfQualifies` cases.)
- **Given** the live doc no longer qualifies at write time (an admin acted between the trigger and the write) **then** the transaction writes nothing and returns `false`. (Test: "re-confirms LIVE state".)
- **Given** the injected write throws **then** `applyVisionFlagHide` swallows it and resolves `false` — never rejects. (Test: "never throws".)
- **Given** #43's report path **then** it still refuses to hide a `'flagged'` doc, still hides a restored-then-re-reported `'active'` Proof, and the Vision path stands down for it — the two never contend. (Tests: the "composition with the #43 report-count auto-hide" cases.)

## `firestore.rules`: a second server writer, no new client surface

Adding the writer required no rules change, and the rules half of this spec is the pin that says so. `status` and `visionFlag` were already server/admin-only on Proofs: a non-admin's sole `update` is `hasOnly(['reportCount']) && reportCount == resource.data.reportCount + 1`, and `create` requires `visionFlag == null` with `status in ['active','pending']`. So a client can neither self-hide, un-hide, forge an AI verdict, nor **scrub** the one an admin's Restore deliberately leaves behind. The `proofs` update rule gains a comment recording the second admin-SDK writer; the read rule (`isAdmin(eventId) || resource.data.status == 'active'`) already makes both `'flagged'` and `'hidden'` admin-only, so the Vision hide is authoritative for the player Feed rather than presentational — `useProofFeed`'s `where('status','==','active')` query is what a non-admin is permitted to run.

- **Given** a non-admin (including the Proof's own uploader) **then** setting `status: 'hidden'` on a flagged Proof — alone or smuggled onto a report bump — is DENIED, un-hiding or demoting a Vision-hidden Proof is DENIED, and forging, changing, or clearing `visionFlag` is DENIED; **given** a create carrying `visionFlag`, `status: 'flagged'`, or `status: 'hidden'` **then** it is DENIED while the ordinary active create SUCCEEDS. (Tests: `tests/rules/cloud-vision-moderation.test.ts`.)
- **Given** a non-admin **then** the flagged and Vision-hidden Proofs are unreadable (single-doc gets), the Feed's `status == 'active'` query is ALLOWED and an unconstrained one DENIED; **given** an admin **then** every state reads, single-doc and unconstrained. (Tests: the read-gate cases.)
- **Given** an admin **then** Restore (`status: 'active'`) and a manual hide still SUCCEED, and a bare `reportCount + 1` from a non-admin still SUCCEEDS on a flagged or Vision-hidden Proof — #133 narrowed nothing. (Tests: the Restore and report-path cases.)

## The moderation queue: reason, distinct treatment, and a safe Restore

`useReportedProofs` (`src/hooks/useData.ts`) is the **only** admin surface for Proofs — there is no all-proofs list the way `useAllItems` lists every Prompt — so queue membership gains a `visionFlag` arm alongside reported / `'flagged'` / `'hidden'`. The Vision-hidden Proof already queued on the hidden arm; the arm this ticket adds matters one step later, when the admin's Restore writes `status: 'active'` with `reportCount` 0 and every older arm would drop the row out of the console, taking the AI verdict with it and leaving no way to re-hide it short of a community report. Membership on the verdict itself keeps every AI-screened Proof reachable for as long as that verdict stands, so the override is visible and reversible. It is a pure client-side filter over the queue's existing broad subscription — no second listener, no composite index.

`ProofQueueRow` (`src/components/admin/ReviewQueue.tsx`) renders the verdict as a **reason**, replacing the bare `visionFlag` enum echo: `AI screen: violence`, and `hidden · AI screen: violence` on the hidden-state pill when the Proof is currently hidden. That is deliberately **two facts the row already carries** — `hidden` from `status`, the verdict from `visionFlag` — and never an inference about cause, so a Proof an admin restored and the community later re-reported over the threshold reads truthfully instead of being labelled with whichever hide came first. The report-count treatment is untouched and stays visually distinct: its own `auto-hidden` pill, and its own lift (`Clear reports`, which zeroes the counter). A doubly-hidden Proof shows both pills and both affordances.

Restore keeps its exact label in every state — it is the same `restoreProof` write, and renaming it would change nothing but break the console's muscle memory — and gains a `title` saying what it is about to undo when an AI verdict stands: `Put this proof back in the Feed. The AI screen flagged it: violence.` That is the safe-restore contract in full: the admin is told what they are lifting, the write leaves `visionFlag` as the audit record of the override, the row keeps its reason pill and its place in the queue afterwards, and the Vision path will not fight the decision because the Proof is no longer `'flagged'`.

- **Given** a Vision-hidden Proof **then** the queue row reads `hidden · AI screen: <verdict>` and offers Restore, whose title names the verdict; **given** a Proof still awaiting its hide, or one an admin restored **then** the row reads `AI screen: <verdict>` and offers Hide. (Tests: `src/components/admin/cloud-vision-moderation.test.tsx`.)
- **Given** a report-count auto-hidden Proof with no verdict **then** the row shows `auto-hidden` and `Clear reports` and NO AI pill; **given** one that is both **then** it shows both pills and both affordances. (Tests: the "keeps the report-count hide DISTINCT" and "shows BOTH mechanisms" cases.)
- **Given** a Proof carrying a non-auto-hide verdict such as `racy` **then** it is queued for review and shown with its reason, and is never marked hidden — nothing auto-hides for raciness. (Tests: the raciness cases in the component and hook suites.)
- **Given** a Vision-flagged Proof at any lifecycle stage — flagged, hidden, or restored — **then** `useReportedProofs` queues it, while an active, unreported, never-screened Proof is not queued and the three pre-existing arms are unchanged. (Tests: `src/hooks/cloud-vision-moderation.test.tsx`.)

## What this does not do

- **No posting gate, no pre-moderation queue** (PRD non-goals). The scan runs on the uploaded object, so the hide is always reactive: the Proof exists, the Mark stands, and only the media stops being readable.
- **No stat or Mark effect** (ADR 0001). Hiding is not authorization; `recomputeStats` is neither re-added nor repurposed.
- **No raciness hiding** (ADR 0004), and no Prompt-side Vision path — SafeSearch scans proof media, and Prompts carry no media.
- **No producer change.** `moderateProof`, its `ENABLE_VISION_MODERATION` gate, and its region pin are untouched; enabling the Cloud Vision API and flipping that flag remain #132's human provisioning.
