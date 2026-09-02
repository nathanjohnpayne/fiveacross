---
spec_id: event-invitations
status: proposed
---

# Event invitations: mint, redeem, revoke, and membership grant (`event-invitations`)

Implements #803 under epic #801. An Invitation is the organizer-issued, high-entropy capability that creates one Event Membership. It is distinct from an Event hostname or Slug: those are public addresses and grant no admission.

This specification is `proposed` only because the product-policy rows in [Owner decisions](#owner-decisions) are not yet answered. The transaction, authorization, secrecy, rules, and client-ordering contracts below can be implemented and reviewed provisionally, but no production callable is exported until the owner accepts a complete package. Some choices (notably transferable versus identity-bound capability and the issuer authority model) change the wire or data model rather than a numeric constant; if the proposal is rejected, the provisional core changes before export rather than pretending those choices were injectable.

## Sources and scope

- Membership authority and record shape come from [`event-membership`](event-membership.md). In particular, issuance and revocation use `mayAdministerMembership()`, never `admits()`.
- The single-use transaction and secret-at-rest patterns come from [`auth-handoff`](auth-handoff.md), while the invitation remains a true bearer capability: unlike an auth handoff, it has no private verifier.
- Recipient presentation follows [`plans/daily-cards-wireframes.html#sec-entry`](../plans/daily-cards-wireframes.html#sec-entry). Organizer output is illustrated at [`#fx-setup-launch-fa`](../plans/daily-cards-wireframes.html#fx-setup-launch-fa), but no organizer UI ships in this ticket.

This ticket owns the three callable Functions, their server-only Firestore state, thin client transport/capture seams, and tests. Ticket #804 owns the client and Firestore admission gate around `joinAndDeal`; it must consume the ordering contract below. Ticket #805 owns production backfill and rollout.

## Glossary

**Invitation** — the server-owned record describing a revocable grant for one Event. It is stored under the hash of its code. *Avoid:* Slug, Event link, address, Membership.

**Invitation code** — an unguessable, URL-borne bearer secret that identifies one Invitation. It is returned once at mint, never stored raw, and is never a Slug. *Avoid:* token in user-visible copy.

**Invitation id** — the SHA-256 hex digest of an Invitation code. This is safe to persist as grant provenance and safe for an Admin to submit when revoking; it is not redeemable.

**Redemption** — the transaction that consumes an available Invitation use and creates the recipient's Membership. It is distinct from sign-in and from `joinAndDeal`.

## Owner decisions

The coordinating owner must answer these rows before this spec becomes `accepted` and before the callable exports choose a production policy. The decision-neutral core takes them as explicit server-owned policy; none is accepted from callable input.

| Decision | Options still open | Safe minimal package proposed for approval |
|---|---|---|
| D4 — capability shape | transferable bearer or identity-bound; exact TTL; grant role; single versus capped multi-use | transferable single-use bearer, 24-hour TTL, `member` only |
| D8 — issuer | current Admins only, or a new Host permission | current live Admin roster **and** active issuer Membership |
| Redeemed-grant revocation | revoke only future redemption, or also revoke the Membership created by this Invitation | revoke the Invitation and its one provenance-matching Membership atomically |
| Enforcement-off revocation | refuse until enforcement, or write the revoked Membership now and report that access continues until enforcement | write the durable revocation now and return `pending-enforcement` until the Event is enforced |
| Public failure detail | distinguish lifecycle failures, or collapse them | unknown, consumed, expired, and revoked share one terminal client message |
| Per-caller rate windows | operation-specific window and cap for mint, redeem, and revoke | 30 attempts per 10 minutes for each operation |

The following are already fixed by repository authority and are not choices:

- The code is 32 random bytes encoded as 43 unpadded base64url characters.
- The code travels only in `#fa_invite=...`, never a query or path.
- The stored Invitation determines the Event and grant role; redemption input cannot override either.
- Redemption is create-only. A revoked Membership is never overwritten or reactivated.
- Decision D-A's transitional Admin bypass does not apply to callables.
- A Host remains social identity rather than permission unless D8 explicitly creates a new authority model.
- If a future accepted policy permits `admin` grants, redemption is the product's first server-side write path to `EventDoc.admins`; the proposed production policy disables that path by granting `member` only.

## Wire contract

All three endpoints are `firebase-functions/v2/https` callables in `us-central1`, pinned to the repository's Admin-SDK service account. All derive the caller UID from `request.auth`; no payload accepts a UID.

### `mintEventInvitation`

```ts
// Request
{ eventId: string }

// Response
{
  eventId: string;
  invitationId: string; // SHA-256(code), management/audit identifier
  invitationUrl: string; // complete server-built canonical URL
  expiresAt: number; // ms epoch
}
```

The server resolves an active canonical hostname for `eventId` and returns the complete `https://<canonical-host>/#fa_invite=<code>` URL. The client does not assemble a hostname, path, Slug, role, or expiry. Missing, inactive, ambiguous, or malformed canonical-host metadata fails closed.

### `redeemEventInvitation`

```ts
// Request
{ code: string; expectedEventId: string }

// Response
{
  eventId: string;
  outcome: 'membership-created' | 'already-member';
}
```

`expectedEventId` is a fail-closed client-context check, not authority. The stored Invitation remains authoritative; a mismatch consumes nothing. The recipient must already be signed in. An existing active Membership is an idempotent success and consumes no additional use. An existing revoked or malformed Membership is a terminal refusal and is never rewritten.

### `revokeEventInvitation`

```ts
// Request
{ eventId: string; invitationId: string }

// Response
{
  eventId: string;
  invitationId: string;
  outcome: 'revoked' | 'already-revoked';
  membershipAccess: 'invitation-only' | 'pending-enforcement' | 'revoked';
}
```

Revocation uses the non-secret Invitation id, not the bearer code. The stored Invitation must name the requested Event. The policy row above decides whether an already-created, provenance-matching Membership is revoked in the same transaction. `membershipAccess` reports the observable scope truthfully: `invitation-only` means no Membership was changed, `pending-enforcement` means the Membership is durably revoked but the Event's access gate is still off, and `revoked` means that gate is enforced. Absent or malformed `membershipEnforcement` reads as `off`, matching the canonical Membership contract.

## Data model

### `eventInvitations/{invitationId}`

`invitationId` is `hex(SHA-256(code))`; neither the path nor the document contains the raw code.

| Field | Type | Contract |
|---|---|---|
| `schemaVersion` | `1` | Exact envelope version |
| `eventId` | string | Granting Event; authoritative at redemption |
| `role` | `MembershipRole` | Server policy output, never caller input |
| `createdBy` | string | Issuing Admin UID |
| `createdAt` | Timestamp | Server mint time |
| `expiresAt` | Timestamp | Server deadline; physical cleanup is not an authorization boundary |
| `status` | `active \| consumed \| revoked` | Exact lifecycle sentinel |
| `maxUses` | integer | Immutable policy output; bounded to keep cascade transactions below Firestore limits |
| `remainingUses` | integer | Exactly `maxUses - grantedUids.length`; single-use policy starts at `1` |
| `grantedUids` | string[] | Unique recipients whose Membership this Invitation created |
| `revokedBy` | string \| `null` | Exact revocation sentinel |
| `revokedAt` | Timestamp \| `null` | Exact revocation sentinel |

Every sentinel is written explicitly. Missing fields and malformed timestamps fail closed; absent is never interpreted as `null`, unused, or unexpired.

### `eventInvitationRateLimits/{bucketId}`

Server-owned rolling-window state. Bucket ids are domain-separated SHA-256 digests of the authenticated caller identity and operation, not raw UIDs and not guessed invitation codes. Mint, redemption, and revocation have distinct buckets and limits. Every well-formed call consumes one request attempt, including an idempotent redemption; idempotency preserves the Invitation use, not an unlimited request budget. Once a bucket is exhausted, the transaction reads only that bucket and returns before touching Event, Membership, Invitation, or hostname state. A well-formed unknown-code redemption still commits its rate charge.

## One membership implementation

Authorization-sensitive membership helpers have one hand-maintained source: `src/data/eventMembership.ts`. Functions cannot runtime-import that file under their separate `rootDir`, so the Functions copy is generated, carries `do_not_edit` and `source_ref`, and is audited byte-for-byte by `scripts/materialize-event-membership-functions.mjs --check`.

The generated block includes `membershipPath`, `isActiveMembershipData`, and `mayAdministerMembership`. A hand-maintained mirror plus fixture parity is not acceptable for an authorization predicate.

## Authorization

Mint and revoke authorize inside the transaction that commits their write. The transaction reads the live Event document and the issuer's own Membership, then requires all of:

1. authenticated, non-empty caller UID;
2. active Event;
3. UID present in the live `EventDoc.admins` roster;
4. active Membership at `events/{eventId}/memberships/{uid}`.

This is `mayAdministerMembership()`. It is enforcement-blind, never calls `admits()`, never consults grant-time `MembershipRole`, and never applies D-A's transitional rules bypass. A concurrent demotion, Event archive, or issuer Membership revocation invalidates the transaction and is re-read on retry.

Redemption is different by construction: it is authorized by an authenticated recipient plus a valid bearer capability. Requiring a prior Membership would make first-time redemption impossible.

## Transactions

### Mint

The code is generated once per outer collision attempt. One transaction reads the Event, issuer Membership, mint rate bucket, Invitation id, and canonical hostname evidence before writing. It re-checks authority, charges the bucket, and creates the Invitation. Creation is create-if-absent; a hash collision causes a bounded retry with fresh entropy and never overwrites an existing row.

### Redeem

One transaction reads the redemption bucket, Invitation, stored Event, and recipient Membership before any write. The server clock is sampled inside each transaction attempt, so a retry crossing `expiresAt` refuses.

Expected lifecycle failures return a typed internal outcome from the transaction rather than throwing inside it. That lets the rate-limit write commit for well-formed unknown, expired, revoked, consumed, archived, and malformed attempts. The callable seam throws only after commit, with a uniform public response.

For an absent Membership, the same transaction:

1. creates (never sets) the active Membership at its deterministic path;
2. stores `invitationId`, `createdBy`, and server grant time as provenance;
3. decrements `remainingUses` and marks the final use consumed;
4. records the recipient on the Invitation; the created Membership records the server grant time.

Two different recipients racing a single use yield exactly one Membership. Two calls by the same recipient serialize; the retry sees their active Membership and returns idempotent success without consuming twice.

### Revoke

One transaction re-checks issuer authority and Invitation/Event binding, then marks the Invitation revoked idempotently. If the approved policy cascades, the transaction reads the named recipient Membership and changes it to `revoked` only when its `invitationId` still matches. It preserves all grant provenance, adds `revokedAt`/`revokedBy`, and removes that UID from the live Admin roster if present. A provenance mismatch fails closed; there is no partial or best-effort cascade.

A revoke/redeem race has only two valid serial outcomes: revoke first blocks admission; redeem first creates the Membership and the subsequent revoke removes its future access.

## Secret handling and client ordering

The invitation is a stronger URL capability than the auth-handoff code because possession alone is enough to redeem it. Therefore:

- it appears only in a fragment and only in the callable request body;
- `entry.tsx` captures and clears it before the Firebase, analytics, or React module graph is imported;
- failure to confirm removal suppresses telemetry for that page load;
- a guarded, origin-bound, TTL-bounded pending record survives the central-auth round trip;
- compare-and-delete prevents an old attempt from clearing a newer Invitation;
- the code never enters query strings, route telemetry, logs, rendered DOM, error text, analytics properties, or Firestore.

Ticket #804's admission coordinator must order:

1. sign-in;
2. required profile and 18+ authority;
3. Invitation redemption;
4. `joinAndDeal`.

While redemption is pending, retryable, or terminally blocked, `joinAndDeal` must remain at zero calls. A transient network failure retains the bounded pending record and offers Retry. Unknown, consumed, expired, revoked, and a concurrent loser clear it and share: “This invitation is no longer valid. Ask the organizer for a new one.”

## Rules

Both server-owned collections contain leaf documents only and deny every client credential:

```rules
match /eventInvitations/{invitationId} {
  allow read, write: if false;
}
match /eventInvitationRateLimits/{bucketId} {
  allow read, write: if false;
}
```

No subcollection is part of either schema. The collection id `markers` is globally reserved for the Tally collection-group query; it must never be added beneath either server-only root because Firestore ORs overlapping grants and a deny cannot veto that collection-group allow. Any future descendant therefore requires a new collection id and a security-rules review. Functions tests pin the complete Admin writer inventory to one root document path per Invitation or rate bucket. Membership documents remain client-unwritable; #804 owns their self-get and Admin-list read posture.

## Deployment

The projects' Domain Restricted Sharing policy rejects Firebase's `allUsers` Cloud Run invoker binding. A Firebase-authenticated callable still needs the network-layer invoker IAM check disabled: a Firebase ID token is not a Google IAM caller identity. The canonical deploy wrapper therefore preflights and reconciles all three Invitation services after any selected Functions release, including partial deploy failures and exact one-function scopes. No live deployment is part of this ticket's code merge.

## Acceptance criteria

- A non-Admin, a roster-only Admin, and a Membership-only caller cannot mint or revoke.
- Mint/revoke re-read the live roster and issuer Membership in the committing transaction; concurrent authority loss denies.
- Codes are 256-bit, hashed at rest, fragment-only, and absent from logs and telemetry.
- A valid Invitation creates exactly one create-only Membership in the stored Event and consumes its use atomically.
- Cross-Event request tampering consumes nothing.
- Existing active Membership redemption is idempotent and consumes no use; revoked or malformed Memberships are never overwritten.
- Unknown, expired, revoked, consumed, malformed, archived, and exhausted Invitations produce no partial Membership write and still charge a well-formed attempt.
- Two-recipient concurrency has exactly one winner against real Firestore.
- Revoke/redeem concurrency converges according to transaction order with no partial cascade.
- No client, including an Event Admin, can read or mutate Invitation, rate, or Membership grant state directly.
- The public `hostnames/{host}` point lookup remains unchanged.

## Test coverage

- `tests/functions/event-invitations.test.ts` — injected decision layer: transaction-retry harness guard, mint/redeem/revoke branch matrix, authority races, hashing, canonical-host resolution, strict stored shapes, rate-limit boundaries, create-only/idempotent grants, and revoke/redeem convergence.
- `tests/rules/event-invitations.test.ts` — leaf-collection client denial and the neighboring hostname control.
- `tests/rules/event-invitations-core.test.ts` — real Firestore replay and concurrent-redemption convergence through an Admin-context adapter.
- `src/pendingEventInvitation.test.ts` and `src/handoffBoot.test.ts` — strict fragment capture, dual-store persistence, compare-delete, removal-before-app, and telemetry suppression.
- `src/data/eventInvitations.test.ts` — exact callable names, payloads, sanitized results, and safe error mapping.
- `scripts/materialize-event-membership-functions.test.mjs` — generated authorization source audit and fail-closed marker/drift handling.
- `scripts/event-invitations-invoker.test.mjs`, `scripts/event-invitations-deploy.test.mjs`, and `tests/test_deploy.sh` — exact/whole/unknown Functions scopes preflight and reconcile all selected Invitation services without tolerating a selected service being absent.
