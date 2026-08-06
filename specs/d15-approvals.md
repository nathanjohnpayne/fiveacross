---
spec_id: d15-approvals
status: accepted
---

# d15-approvals—item approval flow: submissions → pending; Admin Approvals queue; grandfathering

> **Vocabulary note (#565/#566):** this spec's persisted-contract language was updated for the neutral vocabulary — Day/Event fields `place`/`placeEmoji` and `startsOn`/`endsOn` (legacy `port`/`portEmoji`, `sailStart`/`sailEnd` coerced on read by `eventConverter`), and Pool values `easy`/`closing` (both live Events still PERSIST the legacy `embark`/`farewell` spellings; reads normalize via `migratePool`/`normalizePool`, rules accept both, and writes keep emitting the legacy values until the post-Event cleanup).


Implements `plans/daily-cards-spec.md` § "Item pools and the approval flow". Today any signed-in Player's submitted Prompt goes straight to `status: 'active'` and is immediately dealable. This ticket adds an approval gate on the `main` pool: a submission now lands `pending`—invisible everywhere except the Admin queue and (as "pending review") its own submitter—and only an admin's approve/reject decision makes it `active` (or `rejected`, kept for audit). It also gives the Admin console an Approvals tab and relies on the Day Snapshot mechanism (owned elsewhere) to pick approved items up on every not-yet-unlocked Day.

Depends on #200 (`d15-schema-contract`, the `ItemDoc.pool`/`status: 'pending'|'rejected'`/`approvedBy`/`approvedAt` fields this ticket is the first consumer of) and #201 (`d15-firestore-rules`, the pending/rejected item **read**-visibility carve-out). This ticket's own scope is the write path: the item **create** rule (`firestore.rules`) still required `status == 'active'` after #201 landed—#201's spec explicitly scoped itself to the read carve-out only ("items gain a pending-only submitter read carve-out")—so this ticket widens the create rule's allowed `status` set to `['active', 'pending']` as well, or a non-admin could never actually create a `pending` row for the read-side carve-out to apply to. `rejected` is deliberately NOT allowed on create—only an admin `update` may transition a row to `rejected`.

## What already shipped (consumed, not rebuilt)

- `ItemDoc.status: 'active' | 'hidden' | 'pending' | 'rejected'`, `ItemDoc.pool: 'main' | 'easy' | 'closing'`, `ItemDoc.approvedBy?: string`, `ItemDoc.approvedAt?: number` (`src/types.ts`, #200).
- `firestore.rules` `items/{itemId}` read rule: `isAdmin(eventId) || status == 'active' || (status == 'pending' && createdBy == request.auth.uid)` (#201).
- `useItems` already filters `pool == 'main'` alongside `status == 'active'` (`src/hooks/useData.ts`).
- The Admin console's report queue, Ban roster, Claim mode, theme picker, pending-claims, and full Prompts list (`src/components/Admin.tsx`)—untouched by this ticket except for the new Approvals tab toggle.

## The change

- `src/data/api.ts`—`addItem` now writes `status: 'pending'` (was `'active'`). `pool: 'main'` is unchanged (main-pool submissions only; curated pools are seeded/admin-edited directly, out of scope here).
- `firestore.rules`—the `items/{itemId}` `create` rule's `status` check widens from `== 'active'` to `in ['active', 'pending']`, so the write side actually allows the `pending` row the #201 read carve-out was written to expect. `rejected` stays excluded from `create`—only the `isAdmin(eventId)` `update` arm can set it.
- `src/data/admin.ts`—`approveItem(id, adminUid)` (→ `active` + `approvedBy`/`approvedAt`), `rejectItem(id, adminUid)` (→ `rejected` + `approvedBy`/`approvedAt`, row kept for audit, never deleted), `bulkApproveItems(items, adminUid)` (one `writeBatch`, all rows stamped with the same `approvedAt` instant), and `setItemSpicy(id, spicy)` (lets an admin correct the 🔞 tag from the queue before approving).
- `src/hooks/useData.ts`—`usePendingItems()` (the Admin Approvals queue: `where('status','==','pending')`, oldest-first, own subscription so the tab does not re-filter the whole `useAllItems` collection) and `useMyPendingItems(uid)` (the submitter's own pending rows: `where('createdBy','==',uid) && where('status','==','pending')`, both-equality so no composite index, mirroring `useMyProofs`'s shape).
- `src/components/ItemPool.tsx`—a companion `APPROVAL_NOTE` caption next to `PRESAIL_NOTE` (additive, not a replacement—`PRESAIL_NOTE` explains freeze-on-deal, this explains the new review gate). The submitter's own pending items (`useMyPendingItems`) render appended to the list, tagged "pending review", with no Report control (reporting your own not-yet-live Prompt is meaningless).
- `src/components/Admin.tsx`—the Approvals queue lists `usePendingItems()` rows with submitter attribution, a spicy toggle, Approve/Reject buttons, and an "Approve all" bulk control. *Re-housed by `admin-console-ia`*: originally a local Moderation/Approvals sub-tab, it is now the Approvals group of the merged Review queue at `/more/admin/queue` (`src/components/admin/ReviewQueue.tsx`)—rows and write paths unchanged.

## Grandfathering

Every item that is already `active` when this ships stays `active`—the gate is additive (a widened `status` union, no migration, no backfill) and applies only to submissions made **after** deploy through `addItem`. Curated pools (`embark`/`farewell`) are unaffected: they are seeded and admin-edited directly (`d15-tutorial-seed`), never through the player submission form, so they never pass through the `status: 'pending'` write this ticket adds.

## Why the create-rule widening belongs in this ticket, not a rules-only follow-up

`d15-firestore-rules` (#201) is a rules-only ticket that "proves the rule shape with hand-built payloads; the client write paths that produce them are separate Wave-1/2 tickets" (its own spec, verbatim)—and its own contract section lists exactly three changes: day-scoped boards, the pending/rejected **read** carve-out, and day-meta `firstBingo`. The `create` rule's `status` check was never in that list. Without widening it here, `addItem`'s new `status: 'pending'` write would be **denied** in production—the feature would build, typecheck, and pass every mocked unit test while being non-functional end-to-end. This ticket is `needs-phase-4` regardless of size (it touches the items read/write visibility contract), so widening the create rule alongside its one first-and-only consumer does not change the merge gate—it would be held for human review either way—and leaves no dangling half-shipped state where the write path is typed but rules-denied.

## Acceptance criteria

- Given a signed-in Player submits a Prompt to the main pool, when the write commits, then the item is `status: 'pending'` and absent from `useItems` (the live player-facing pool) and from every deal.
- Given a pending item, when the submitter views the pool, then it renders labeled "pending review"; when any other non-admin Player views the pool, then it is entirely absent.
- Given an admin approves a pending item, when the write commits, then it becomes `active` with `approvedBy`/`approvedAt` stamped and is eligible for the next not-yet-unlocked Day's snapshot.
- Given an admin rejects a pending item, then it becomes `rejected`, stays out of every player-facing surface, and remains visible to admins for audit.
- An item that was already `active` before this ships stays `active` with no admin action required.
- Only the `main` pool gates on approval; the `easy`/`closing` curated pools are unaffected (the rules validator accepts both the canonical and legacy persisted spellings during the #565 transition).
- Bulk approve works on the full pending list in one action.
- A non-admin can create an item with `status: 'pending'` but never `status: 'rejected'`; only an admin's `update` can transition `pending → active`/`rejected`.

## Claim → test

Basename-aligned to this spec (`d15-approvals`).

### Data layer—`addItem` writes `pending`

Runner: `npm test` (Vitest). Test: `src/data/api.test.ts`.

- `addItem` writes `status: 'pending'` (not `'active'`) alongside `pool: 'main'`.

### Component—ItemPool

Runner: `npm test` (Vitest, jsdom). Test: `src/components/ItemPool.test.tsx`.

- A submission calls `addItem` (the write itself lands `pending`, pinned at the data layer above); the "goes to admin review" caption renders.
- A submitter's own pending item (`useMyPendingItems`) renders in their list, tagged "pending review".

### Component—Admin Approvals group (re-housed in the Review queue by `admin-console-ia`)

Runner: `npm test` (Vitest, jsdom). Test: `src/components/Admin.test.tsx`.

- The Approvals group lists pending items with submitter attribution.
- Approve invokes the write with `active` + `approvedBy`/`approvedAt`.
- Reject invokes the write with `rejected`.
- Bulk-approve approves every listed row in one action.

### Rules—the write side (create) + the transition (update)

Runner: `npm run test:rules` (Firestore emulator). Test: `tests/rules/d15-approvals.test.ts`.

- A non-admin CAN create an item with `status: 'pending'`; a non-admin creating `status: 'rejected'` is DENIED.
- A non-admin cannot read another Player's `pending`/`rejected` item; the submitter CAN read their own pending item (re-pins the #201 read carve-out this ticket's write path now actually feeds).
- Only an admin can transition `pending → active` or `pending → rejected`; a non-admin's attempt to flip `status` on their own pending item is DENIED (their only permitted update is the unrelated `reportCount` increment path).

## Test-mock updates required by the surface change (stated honestly)

`ItemPool.test.tsx`, `Admin.test.tsx`, and `src/data/api.test.ts` are new files. Two existing suites needed updates because this ticket changed behavior they pinned:

- `src/components/w1-prompt-pool.test.tsx` mocks `../hooks/useData` with a bare `{ useItems }` factory; `ItemPool` now also calls `useMyPendingItems`, so the mock gained a `useMyPendingItems: () => ({ items: [], loading: false })` no-op arm—every assertion in that file still exercises only the pre-existing active-pool + throttle behavior.
- `src/data/d15-schema-contract.test.ts`'s `addItem` pool-stamp assertion expected `status: 'active'` (the pre-#210 write); updated to `status: 'pending'`, the write this ticket's `src/data/api.test.ts` pins in depth.
