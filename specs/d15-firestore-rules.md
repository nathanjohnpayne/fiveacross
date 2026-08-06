---
spec_id: d15-firestore-rules
status: accepted
---

# Phase 1.5 Firestore rules: day-scoped boards + unlock gating + pending-item visibility + day-meta firstBingo (`d15-firestore-rules`)

Reconciles `firestore.rules` to the day-scoped Board model in `plans/daily-cards-spec.md` § "Security rules and functions (shape only)" and § "Item pools and the approval flow". This is a rules-only ticket: it proves the rule shape with emulator tests over hand-built payloads. The client write paths that produce these payloads (dealing, approvals, day meta) are separate Wave-1/2 tickets. Guarded by `tests/rules/d15-firestore-rules.test.ts` (Vitest rules-emulator layer) and `scripts/ci/check_spec_test_alignment`.

## Contract

`firestore.rules`, HOT owner. Three changes, plus one frozen posture kept exactly as-is.

- **Boards move under `days/{dayIndex}` with an unlock-time gate.** `events/{eventId}/boards/{uid}` becomes `events/{eventId}/days/{dayIndex}/boards/{uid}`—one Board per Player per Day. `days` is an ARRAY field on the Event doc (a `DayDef[]`, #200), not a subcollection, so there is no `days/{dayIndex}` document; the match block hangs off the path segment and the write gate indexes into that array by the path's `{dayIndex}`:
  - `read`: `isOwner(uid) || isAdmin(eventId)`—ungated, so owner/admin can always inspect existing Board state.
  - `write`: `(isOwner(uid) || isAdmin(eventId))` AND the Day is canonical (`string(int(dayIndex)) == dayIndex`, rejecting numerically-equivalent aliases like `00` that would mint a parallel Day-0 board at a distinct path) AND `request.time >= get(/databases/$(database)/documents/events/$(eventId)).data.days[int(dayIndex)].unlockAt`. `int(dayIndex)` coerces the string path segment to the numeric list index. An out-of-range or non-numeric `dayIndex` errors the lookup, which denies (the safe default). This keeps the ADR-0001 self-writable-by-design posture and adds only a TIME gate on top—it does not remove the self-write. A deal (the doc does not yet exist) and a mark (the owner's existing doc) both reduce to `isOwner(uid)`; the doc path is `boards/{uid}` either way.
- **Pending/rejected item visibility carve-out.** The `items/{itemId}` read rule gains a submitter carve-out for `pending` only:
  - `read`: `signedIn() && (isAdmin(eventId) || status == 'active' || (status == 'pending' && createdBy == request.auth.uid))`.
  - A `pending` submission is invisible everywhere except the Admin queue and—as "pending review"—to its own submitter. A `rejected` item is kept for audit and hidden from ALL non-admins, INCLUDING its original submitter once rejected, so it falls through to the admin-only arm with no submitter carve-out. The carve-out is `pending` only, deliberately not `pending || rejected`.
- **Day-meta `firstBingo` write-once.** A new `events/{eventId}/days/{dayIndex}/meta/{metaId}` match block (one doc per Day, id == the encoded `dayIndex`), mirroring the `moments/{momentId}` immutability pattern:
  - `read`: `signedIn()` (the honor is pinned on that day's view).
  - `create`: `signedIn()` AND `metaId == dayIndex` (the honor doc is bound to its Day—one canonical `meta/{dayIndex}` per Day) AND the Day is canonical (`string(int(dayIndex)) == dayIndex`, rejecting aliases like `00`) AND `request.time >= days[int(dayIndex)].unlockAt` (the SAME day-unlock gate as the Board write—a future Day's canonical honor cannot be squatted before it unlocks, since the doc is write-once) AND either own-attributed (`firstBingo.uid == request.auth.uid`) OR written by an event admin resolving an `admin_confirmed` claim for the achieving Player AND `firstBingo.displayName` a non-empty string ≤ 100 chars AND `firstBingo.at is number`. Written via the same client path that posts first-bingo Moments today, or via the admin claim-resolution path when the Player's bingo is only confirmed by an admin.
  - NO `update` path at all—a second write to the same day-meta doc is a doc-exists update, denied for EVERYONE including admins, exactly like the deny-all update on a Moment. The per-day honor cannot be reassigned once claimed.
  - `delete`: `isAdmin(eventId)` for moderation.
- **Frozen, kept as-is.** The `proofs`/`claims`/`tally`/`doubts`/`moments` blocks are unchanged. The self-writable-by-design posture on `players`/`boards` (ADR 0001) stays intentional—a reviewer "locking it down" has misread the design.

## Acceptance criteria

- Given a Day with `unlockAt` in the future, when any Player attempts a Board write under that day's path, then it is DENIED.
- Given a Day with `unlockAt` in the past and no existing Board doc for a Player, when that Player writes one, then it is ALLOWED as a deal; a second Player's write to the first Player's doc is DENIED.
- Given a `pending` item, when anyone other than an admin or its own submitter reads it, then it is DENIED; a `rejected` item is denied even to its own former submitter.
- Given a day-meta doc that already carries `firstBingo`, when any client (including an admin) writes to it again, then it is DENIED.
- Given an admin confirms a Player's claim that creates that Day's first BINGO, when the admin creates the write-once `firstBingo` honor for that Player, then it is ALLOWED.
- Given a Day with `unlockAt` in the future, when a Player creates that Day's `firstBingo` honor doc, then it is DENIED—the write-once honor cannot be squatted before its Day unlocks, exactly like the Board write.
- Given a non-canonical day segment (e.g. `00`), when a Player writes a Board or a `firstBingo` honor under it, then it is DENIED, so no parallel Day-0 board or second write-once honor slot can be minted under an alias.
- The existing self-writable-by-design assertions (owner board write ALLOWED, cross-uid DENIED) still pass under the new day-scoped path, so the ADR-0001 posture is provably unchanged.
