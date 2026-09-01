---
spec_id: event-scoped-marker-delivery
status: accepted
---

# Event-scoped marker delivery (`event-scoped-marker-delivery`)

Implements [#1072](https://github.com/nathanjohnpayne/fiveacross/issues/1072), the delivery seam between Event-scoped client state and membership enforcement. Marker documents keep their existing path,

`events/{eventId}/tally/{itemId}/markers/{uid}`,

but now carry the same Event identity as an additive `eventId` field. The Feed subscribes with `where('eventId', '==', capturedEventId)`, so Event B markers no longer cross the wire to an Event A listener. The callback still checks the ancestor path during the first cutover release; that is a corruption alarm and defense-in-depth, not the isolation mechanism.

## Product and visual boundary

This change is delivery plumbing only. The Tally Cards remain the cards drawn in the Daily Cards wireframes for [Gay Cruise Bingo](../plans/daily-cards-wireframes.html#fx-feed-gcb), [Vacay Bingo](../plans/daily-cards-wireframes.html#fx-feed-vacay), and [Five Across](../plans/daily-cards-wireframes.html#fx-feed-fa): the first two names plus `+N`, the live who-list, `＋ Proof` / `🙋 Got it too`, the ten-minute bump debounce, and no heart action are unchanged.

The declined Event switcher and cross-Event admin hub in [`#fx-admin-hub-fa`](../plans/daily-cards-wireframes.html#fx-admin-hub-fa) and [`#fx-admin-hub-tri`](../plans/daily-cards-wireframes.html#fx-admin-hub-tri) remain out of scope.

## Stored invariant

Every post-cutover marker written by this client carries a string `eventId` equal to the Event segment in its path. This applies to all full-value writers:

- a normal Mark;
- an Echo reconciliation; and
- attaching Proof to a Mark.

Proof attachment preserves the marker's additive Day/Prompt fields instead of replacing the row with a smaller payload. Deletes keep using the existing direct path. `TallyEntry.eventId` stays optional in TypeScript only for the bounded compatibility period; making it required before old documents and queued old-client writes have drained would describe a state production cannot yet guarantee.

Client Security Rules enforce the path/field invariant. An exact string identity is accepted. A missing field is accepted only while the server-owned compatibility cutoff is open. A present mismatch or a present non-string value is always denied; neither the migration nor the normalizer launders it into a valid identity.

Direct Square-badge and Doubt behavior stays path-scoped. A direct marker collection list remains available to the signed-in Event flow, and a point read accepts an old fieldless marker or an exact identity while refusing a present mismatch. The project-wide collection-group list is separately authorized because Firestore evaluates it through the recursive marker rule.

## Bounded legacy compatibility

`markerDeliveryCompatibility/current` is a deny-all-to-clients control document:

```text
schemaVersion: 1
projectId: <selected Firebase project>
acceptLegacyUntil: <absolute milliseconds since epoch>
```

The cutoff is explicit operator input to the migration, not a duration guessed by the application. It must be a positive millisecond value before `2100-01-01T00:00:00.000Z` and be in the future when opened. Apply rechecks it inside every compatibility-transaction attempt immediately before scheduling the write, so a slow inventory scan or transaction retry cannot open an already-expired window. Re-running with the same cutoff is idempotent; an intentional later cutoff extends or reopens the window; shortening an existing window is refused. The document remains after expiry so delayed trigger delivery and the rollout decision stay auditable.

Security Rules can shape-check `projectId` as a nonblank string but cannot compare it with the runtime Firebase project id. The migration and normalizer enforce the exact selected/runtime project instead; because clients cannot access the control document, its project identity remains part of the trusted Admin-IAM boundary.

While `request.time <= acceptLegacyUntil`:

- an old client may create or replace its own marker without `eventId`;
- the recursive rule permits the old unfiltered collection-group listener; and
- the retry-enabled Firestore normalizer transactionally adds the path Event to a currently fieldless marker whose commit time is no later than the bounded grace described below.

After the cutoff:

- missing-field client writes are denied;
- the unfiltered legacy collection-group query is denied, not returned as a successful empty result;
- an equality-filtered query remains authorized because every possible result proves a string `eventId`; and
- a delayed normalizer invocation may repair a still-current marker version committed no later than one minute after the cutoff, but refuses a fieldless version committed beyond that grace.

Security Rules compare the old client's request against `request.time`, while the trigger can observe only the later Firestore commit/update timestamp. The one-minute normalizer grace bridges that timestamp boundary; it does not extend client admission after the cutoff. An Admin write can bypass Rules, so the trusted Admin-IAM boundary also owns the narrow grace interval. The normalizer re-reads the current document and compatibility record inside one transaction. Deletion and an already-exact field are no-ops. A mismatch or malformed field is logged and acknowledged without a write, rather than retried forever. Its own additive repair retriggers the function and takes the already-exact no-op path.

The compatibility cutoff is also the accepted offline horizon. An old offline mutation that reaches Firestore after it expires is deliberately rejected. The operator therefore chooses a cutoff long enough for the rollout's supported offline queue horizon and may extend it before expiry if observed legacy traffic has not drained.

## Collection-group trust seam

Firestore rules are not filters. The client must issue the `eventId == capturedEventId` predicate; callback filtering alone cannot authorize or isolate the query. The single-field `markers.eventId` collection-group index is checked in with the rules.

The collection-group rule authorizes from the denormalized field. It cannot also prove, for a project-wide query, which dynamic Event ancestor path every possible result has. That invariant is established instead at every client write, by a migration that refuses the entire initial plan on any mismatch, by a normalizer that refuses mismatches, and by the Admin-IAM boundary. The retained callback path check rejects an anomalous result in the client as a final backstop. A design that must tolerate arbitrary Admin-seeded path/field corruption would require a different physical projection; it cannot be obtained by treating this collection-group rule as a filter.

## Migration

`scripts/migrate-marker-event-id.mjs` runs separately against the explicitly named `gaycruisebingo` and `fiveacross` deploy targets. Dry-run is the default; apply requires a clean `main` checkout at exact `origin/main` plus the selected project's exact preflight deployer credential.

The migration enumerates every project marker and accepts only the exact path shape above. It requires the document id to equal the payload `uid`, classifies exact and missing identities, and treats a malformed path, uid mismatch, non-string identity, or path/field Event mismatch as a blocking anomaly. Any anomaly in the initial inventory prevents the compatibility document and every marker write. Apply then revalidates the cutoff inside the retried compatibility transaction, opens the compatibility record, and transactionally re-reads each planned missing row before adding one field. A row that disappeared, changed shape, or became mismatched aborts; a row another writer already normalized is an idempotent no-op. A full post-write enumeration and control-document readback must converge before the run succeeds.

## Rollout order

The order is fail-closed and must be completed for each Firebase project independently:

1. Merge the reviewed code. From a clean exact-main checkout, choose and record the supported legacy/offline horizon. Run the migration dry-run with the target and absolute cutoff; resolve every anomaly.
2. Apply the migration. This opens compatibility and backfills the inventory before a rule can require the field.
3. Deploy the retry-enabled marker normalizer Function. Old rules still admit fieldless writes, but the already-open control record lets the trigger normalize them.
4. Re-run the same migration/apply and require a clean readback. This closes the small interval between the first backfill and Function availability.
5. Deploy the collection-group index and wait until it is ready. Deploy the compatibility rules only after the control document exists.
6. Deploy Hosting with the Event equality predicate. Verify two Events containing the same item/marker ids deliver only the selected Event, and verify direct Square/Doubt reads.
7. Before declaring the window drained, require another zero-missing migration readback and no unexplained normalizer refusals. Let the explicit cutoff expire. Remove the compatibility trigger and make the TypeScript field required only in a separately reviewed cleanup after the supported old-client/offline horizon has passed.

No repository merge performs these live steps. They are operator actions under the deployment authorization and named-target preflight.

## Rollback

- **Before cutoff:** roll Hosting back to the prior unfiltered listener. The open recursive compatibility arm still authorizes it, and the normalizer continues making old writes query-visible.
- **After cutoff:** extend/reopen the compatibility record with a reviewed migration run _before_ rolling Hosting back. An expired window intentionally denies the old unfiltered query and old fieldless writes.
- **Normalizer rollback:** if normalization itself must be removed while legacy traffic remains, first keep/reopen compatibility and roll Hosting back. A filtered new client without the normalizer can temporarily miss a later old-client full-set write.
- **Rules/index rollback:** never remove the field index while filtered Hosting is live. Roll Hosting back first; after cutoff, reopen compatibility first as above.

## Verification

Automated coverage pins:

- all full-value writers stamp the captured path Event and Proof attachment preserves marker metadata;
- an offline new-client Mark queues `eventId`;
- exact, legacy, mismatch, malformed, expired, signed-out, direct-read, and collection-group rule shapes;
- identical marker ids in Events A and B return only A from A's scoped query;
- the #804 preview admits a same-Event member and returns permission denied for a nonmember or other Event rather than an empty success;
- normalizer deletion, idempotency, mismatch refusal, stale-delivery, one-minute commit grace, and cutoff behavior; and
- migration path parsing, project/credential guards, bounded cutoff validation, dry-run immutability, cutoff recheck on transaction retry, transaction drift, idempotency, and post-write convergence.

The binding gates are `npm run typecheck`, `npm test`, `npm run test:rules`, `npm run test:offline`, and `GITHUB_ACTIONS=1 npm run build`.
