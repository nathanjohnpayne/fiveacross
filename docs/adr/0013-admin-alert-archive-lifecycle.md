# ADR 0013: Archive discards uncommitted admin alerts

Status: Accepted

Date: 2026-08-19

Issue: [#846](https://github.com/nathanjohnpayne/gaycruisebingo/issues/846)

## Context

The admin-alert consumer visits active Events. A moderation or abuse transition can enqueue a row while an Event is active and then lose the race to an archive write before the next five-minute sweep. The row has a thirty-day TTL, so its copy of private content is no longer retained forever, but the notification is still silently deferred until reactivation or expiry.

That ambiguity is not merely scheduling. The queue has an exactly-once protocol: rows are transactionally claimed under a persisted `batchId`, the exact outbound request is frozen before Resend is called, and retries replay those bytes under the same idempotency key. Archive handling must therefore decide both whether the product still wants the notification and where delivery becomes too committed to revoke safely.

## Decision

Archiving an Event deliberately discards admin-alert work that has not acquired a frozen outbound request. An archived Event has no live moderation surface, so archive is a terminal moderation decision for uncommitted alerts rather than a request to send one final digest.

A frozen claimed batch is the exception. The freeze is written before the external send, so its presence cannot distinguish “not sent yet” from “Resend accepted it and the response was lost.” Archive handling preserves and settles an authorization-valid batch by replaying the frozen bytes under its existing idempotency key. It never changes the recipient set, body, or `batchId` in place. If the frozen recipients are no longer authorized or a frozen abuse report has been deleted, the existing revalidation path releases the claim and deletes the freeze; because the Event is archived, the released rows are then discarded instead of re-batched for a new delivery.

The queue therefore has these archive states:

| Queue state when archive settlement serializes | Outcome |
|---|---|
| Pending and unclaimed | Replace with a payload-free discard tombstone. |
| Claimed, but no frozen batch document exists | Replace with a payload-free discard tombstone; the invariant “freeze before send” proves no delivery began. |
| Claimed and frozen | Preserve the row and frozen request, then use the ordinary replay path to settle the existing delivery identity. |
| Already delivered or discarded | Leave the terminal tombstone unchanged. |

### Transaction boundaries

Enqueue, claim, and discard each read the Event document in the same Firestore transaction that changes queue rows.

- Enqueue creates deterministic rows only while the Event is `active`. If archive commits first, the transaction observes `archived` and writes nothing. If enqueue commits first, archive settlement sees the row and disposes it according to the table above. Trigger redelivery reads the deterministic document ids and never overwrites an existing payload or tombstone.
- A new drain claim is valid only while the Event is `active`. The claim transaction reads the Event and every candidate row before stamping `batchId`. If archive commits first, no new delivery identity can be minted. If the claim commits first, archive settlement decides from the frozen-request boundary.
- Archive settlement re-reads the Event, candidate rows, and every referenced frozen batch in one transaction. It writes only while the Event is still `archived`, and only replaces rows that are still pending and either unclaimed or claimed without a frozen request. A concurrent freeze creation invalidates the transaction read and makes the retry preserve the batch.
- After creating a freeze, the sender revalidates that every row is still pending under that exact `batchId` before calling Resend. This closes the opposite ordering, where archive settlement commits before the concurrent freeze creation; the sender deletes the now-orphaned freeze and sends nothing.

The claim is not by itself the external-commit boundary. The frozen request is. This preserves exactly-once delivery where delivery may have happened, while allowing a crash between claim and freeze to be discarded safely.

### Tombstones and retention

A discard tombstone keeps the deterministic document id and contains `discardedAt` plus a timestamp-typed `expiresAt`; it contains no alert payload, `batchId`, or `sentAt`. Keeping the id makes a delayed redelivery of the original producer event fail idempotently instead of recreating the alert. Omitting `sentAt: null` keeps the document out of the pending query without falsely claiming that an email was sent.

Discard tombstones use the existing seven-day tombstone TTL. Pending rows retain the thirty-day TTL, and frozen requests retain their current longer deadline. TTL remains a retention backstop, not the archive state transition.

### Prompt handling and scheduled recovery

An `active` to `archived` Event transition invokes archive settlement promptly with retry enabled. The five-minute digest sweep also enumerates archived Events and runs the same settlement operation. The scheduled path is required because a producer invocation or archive handler can be delayed, retried, or temporarily fail after the Event write has committed.

Archive settlement is page-bounded and idempotent. Concurrent archive handlers can replace the same eligible rows with the same terminal shape without resurrecting payload. Concurrent replays use the same frozen bytes and Resend key. More work than one invocation can settle remains visible to later scheduled passes.

Required Functions coverage exercises the public queue boundaries through the existing in-memory Firestore seam:

- an archive transition discards an unclaimed row as a payload-free tombstone;
- an archive transition discards a claimed row when no freeze exists;
- an archive transition preserves and settles a claimed frozen batch under its original bytes and key;
- a concurrent freeze and archive transaction cannot discard the batch after its freeze exists or send after its rows were discarded;
- enqueue and new claim transactions cannot commit after archive wins the Event-document race;
- trigger redelivery and concurrent archive settlement remain idempotent;
- the archived-Event scheduled pass collects work left by a delayed producer or failed transition handler; and
- reactivation revives only rows that were not already terminally discarded.

### Reactivation

Reactivation does not resurrect a discard tombstone and does not rewrite a claimed batch identity. Deterministic producer redelivery still finds the tombstone and becomes a no-op.

A row that has not yet been terminally discarded when the Event becomes active again is live queue work. The active sweep may claim and deliver it. A stale archive-trigger invocation re-reads the Event transactionally and becomes a no-op after reactivation. This makes reactivation cancel unfinished archive cleanup without undoing cleanup that already committed.

## Consequences

- Admins are not sent new digests for moderation work that archive has made irrelevant.
- A delivery that may already have escaped to Resend retains its immutable identity and can finish exactly once.
- Archive, enqueue, claim, retry, and reactivation have an explicit serialization rule instead of depending on trigger arrival order.
- The scheduled sweep spends one additional indexed Event query for archived Events and bounded reads for their pending queues.
- A rapidly reactivated Event can deliver rows that archive settlement had not yet terminalized. That is deliberate: status is live again, while completed discard remains irreversible.

## Rejected alternatives

### Drain everything on archive

This would send admins a digest for an Event with no live moderation surface and would turn archive itself into an email-producing action. It also cannot safely promise a single “final” drain while delayed producer triggers can still arrive.

### Discard every claimed batch

A frozen request may already have been accepted by Resend even when the function has not recorded success. Deleting it and its claim would erase the only stable delivery identity and could turn a retry into either silent loss or a duplicate under a new key.

### Rely on pending-row TTL

TTL bounds retained content but does not express a product decision, preserve deterministic-id dedup during the redelivery window, or provide prompt cleanup. It remains the last backstop only.
