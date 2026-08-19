---
spec_id: event-router-registry
status: accepted
tested: false
reason: Design-only — selects and pins the App Check-compatible control plane, Durable Object registry, and cutover gates; runtime tests land in the implementation tickets in § Implementation split.
---

# App Check-compatible Event-router registry (`event-router-registry`)

This is the implementation contract for [ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md) and issue #888. It replaces only the edge lookup seam in `specs/event-router.md`; `specs/hostnames-lookup.md` remains the browser-facing source contract, and `specs/event-resolution.md` remains the independent client resolution contract. Until the implementation tickets land, the deployed-but-unrouted Worker still carries its Firestore REST reader and **must remain unrouted**.

## Invariants and threat model

1. **App Check is never weakened for the router.** The Worker sends neither an App Check token nor a Firebase request in the target architecture.
2. **The router is not authorization.** A stale or forged routing projection can make a public shell available or unavailable; it cannot mint a Firebase session or bypass App Check, Firestore Rules, Storage Rules, or Event membership. The client never accepts the edge's `eventId` as its own Resolution.
3. **Firestore is canonical; the edge is a projection.** Only the trusted hostname mutation path changes canonical state. No registry-service path writes back to `hostnames/*`; the separately authorized human recovery tool may use the explicit ledger-repair transaction defined below.
4. **The registry is not a directory.** Public traffic can point-get the value for its already-present hostname only. The public router has no Durable Object namespace binding and neither its service binding nor any public endpoint exposes list.
5. **Address states move monotonically.** Normal publication accepts only the exact successor per-host revision. Recovery never lowers the accepted revision. Retries, gaps, older deliveries, and previously signed payloads cannot overwrite a newer state. A deleted address leaves a permanent tombstone and is not reusable.
6. **One transactional store owns acceptance and lookup.** The per-host Durable Object atomically stores the committed projection, revision, recovery lock, and audit history. No KV, Cache API, database, queue acknowledgement, or other external write participates in the accepted state.
7. **Failure closes.** Missing bindings, invalid schemas, unsupported versions, unavailable Durable Objects, and unknown/inactive/tombstoned hosts never proxy the origin. There is no stale or Firestore fallback.

The actors considered are an unauthenticated Internet caller, a modified browser client, a bearer-token thief, a compromised publisher runtime, a compromised public-router deployment, and a compromised registry-service deployment. The protected assets are routing integrity/availability, the hostname registry's non-enumeration property, Firestore data, cross-cloud credentials, and bounded platform cost. GCP/Cloudflare account administrators and a compromised Firebase Hosting origin are outside this contract; both already control the served system. Hostnames, Event IDs, Slugs, Editions, statuses, and individual replica revisions are public metadata, not secrets.

## Architecture and ownership

```text
trusted hostname writer
      │ one Firestore transaction
      ├── hostnames/{host}             public point-get source
      └── routerReplicas/{host}        private desired state + revision
                    │ Firestore event, retry enabled
                    ▼
       replica publisher Function      dedicated service identity + KMS signer
                    │ Google OIDC ID token + signed request bytes
                    ▼
       registry service ──────────────► per-host Durable Object
                    ▲                         │ atomic committed projection
                    │                         │ + revision/recovery/audit
public request ─► Event router               │
                    ├── point-only service binding: registry.lookup(host)
                    └── active + matching ───► Firebase Hosting origin
```

| Surface | May read | May write | Explicitly may not do |
|---|---|---|---|
| Browser/app | one named `hostnames/{host}` under existing rules | no hostname/replica writes | list either registry; read `routerReplicas` |
| Hostname writer | hostname plus its replica ledger | both in one transaction | report success before replica convergence |
| Publisher Function | its event payload, metadata-server ID token, one KMS signing operation | authenticated signed sync request | call Firestore/Admin SDK; export a key; hold a Cloudflare API token |
| Registry service/DO | validated request and one named object's storage | one host's transactional state | read Firestore; bind another store; attach routes; select an origin |
| Public router | one registry `lookup(host)` result after the host guard | nothing | bind/list Durable Objects; call Firestore; accept edge identity as app Resolution |
| Audit operator | Firestore source/ledger list plus authenticated per-host DO state | nothing in audit mode | consume the publisher identity or enumerate through the edge |
| Recovery operator | one transactionally compared Firestore source/ledger and one compared DO state | lock, monotonic source-attested repair, audit history, and a separately authorized exact-host WAF rule | use the publisher identity/key; lower a revision; invent a projection; attach routes |

### Google service identity and edge authentication

Use a dedicated runtime service account, provisionally `event-router-replica-publisher@fiveacross.iam.gserviceaccount.com`. It receives only the roles required for a v2 Firestore event receiver/logging plus `cloudkms.cryptoKeyVersions.useToSign` on one dedicated `RSA_SIGN_PKCS1_2048_SHA256` CryptoKey. Cloud KMS does not support IAM policies on an individual CryptoKeyVersion ([Cloud KMS permissions and roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles)), so this CryptoKey is the narrowest real grant boundary. It contains no unrelated versions: only the publisher's current version is enabled at steady state, and only the current plus replacement versions are enabled during the bounded rotation overlap. The selected version resource name is immutable publisher configuration and an explicit registry allowlist. The account receives **no** `datastore.*`, Firebase Admin, Secret Manager, service-account-key, or Cloudflare permission. Control-plane grants needed to attach the identity belong to deployer/service agents, not the runtime principal, and are reported separately in IAM verification.

For each delivery the Function obtains a Google-signed ID token from the metadata server for one configured audience and sends it as `Authorization: Bearer`. The endpoint verifies `alg=RS256`, a signing key from `https://www.googleapis.com/oauth2/v3/certs`, `iss=https://accounts.google.com`, exact `aud`, `exp`, `iat` no more than 60 seconds in the future, and the configured stable numeric `sub`. Email is diagnostic only. JWKS refresh is single-flight; an unknown `kid` permits one refresh per five-minute cooldown. Refresh failure returns retryable `503`, while a bad token returns generic `401`.

OIDC authenticates the workload but is still a bearer credential, so the Function asks Cloud KMS to sign `v1\nPOST\n<path>\n<issued-at-ms>\n<publisher-epoch>\n<sha256-of-exact-body>` and sends the key-version resource name, canonical positive-decimal publisher epoch, issued-at, and base64 signature in fixed headers. The registry maps each allowed epoch to one subject/key-version set, accepts a signature timestamp within 60 seconds, and verifies the signature before applying a payload. The private key never leaves KMS. A stolen OIDC token cannot sign altered bytes; an intercepted complete request can replay only the identical revision/epoch. Ordinary rotation deploys the new epoch/key before the publisher changes versions, overlaps for one maximum token lifetime plus retry window, then removes the old mapping after audit shows no use.

The exact audience is the separately deployed registry service's `workers.dev` origin plus `/__internal/hostname-replicas/v1`; it is immutable deployment configuration on both sides. That service has no wildcard route. Its public `fetch` surface admits only the signed sync, audit, and recovery paths below; point lookup is an RPC/service-entrypoint method available only through the Event router's Cloudflare service binding. The Event router's own `workers.dev` behavior remains out-of-Namespace. Local tests inject token/signature acquisition and verification; no test key or bypass compiles into production.

## Data and mutation contract

`routerReplicas/{host}` is denied to every Firebase client (`get`, `list`, and all writes). It persists after hostname deletion and has exactly:

```ts
type RouterReplicaDesired = {
  schemaVersion: 1;
  revision: string; // canonical positive decimal, no leading zeroes; compare as BigInt
  host: string;     // hostnameKey(host), identical to the document ID
  desired:
    | { kind: 'route'; eventId: string; status: 'active' | 'disabled' | 'archived'; slug: string; edition: Edition; pathNamespace: 'fiveacross.app' | 'vacaybingo.com' | null }
    | { kind: 'root'; root: 'doorway' | 'not-found'; edition: Edition; pathNamespace: 'fiveacross.app' | 'vacaybingo.com' | null }
    | { kind: 'tombstone' };
  updatedAt: Timestamp; // observability only; never orders writes
};
```

The sync request is `POST /__internal/hostname-replicas/v1`, exact `application/json`, at most 2 KiB, and contains the four fields above with `updatedAt` encoded as RFC 3339. Extra/missing fields, a non-canonical hostname/revision, an unknown status/version/Edition/root/path namespace, a reserved or invalid label, a route whose `slug` does not equal the host's first label (Namespace apex exception preserved), an invalid body signature, and any non-POST method fail before storage. `pathNamespace` is explicit null or one of the two namespace apexes and is valid only on the matching Namespace apex/brand mirror, never an Event subdomain or GCB host. Root shape is valid only on the apex/mirror classes defined by `specs/path-addressing-and-root.md` and forbids `eventId`, `status`, and `slug`. Validation reuses the router's Namespace, Slug, and Edition modules. `edition`, root shape, and capability are copied because #546 and the accepted path-addressing spec must render per-host identity and `/.well-known/fiveacross-path-capability` without another lookup. `adultContent`, `canonicalHost`, `preview`, `apexPath`, membership, Event data, and any hostname catalogue are not projected.

The projection digest is SHA-256 over the UTF-8 JSON array `[1, revision, host, "route", eventId, status, slug, edition, pathNamespace]`, `[1, revision, host, "root", root, edition, pathNamespace]`, or `[1, revision, host, "tombstone"]`; constructing that array is the only canonicalizer. Explicit JSON `null` prevents absent/capable values from colliding. The Durable Object ID is derived from the normalized hostname and is never exposed to the public router.

The object's transactional state is:

```ts
type RegistryState = {
  committed: null | { revision: string; digest: string; payload: RouterReplicaDesired };
  minimumPublisherEpoch: string; // canonical positive decimal; initialized to 1
  recoveryLock: null | { lockId: string; acquiredAt: string; expectedCommitted: null | { revision: string; digest: string }; operatorSub: string; incidentUrl: string; reason: string };
  recoverySequence: string; // canonical non-negative decimal
};
```

Recovery records live under sequence-addressed keys in the same object's storage rather than in an unbounded array. A transaction that changes committed/lock state increments `recoverySequence` and writes the corresponding record atomically; no path updates or deletes an existing record.

Normal sync first requires an allowlisted subject/key for the signed epoch and rejects an epoch below `minimumPublisherEpoch`; it then rejects any non-null `recoveryLock` with retryable `503 recovery-locked` and applies this table inside one DO-storage transaction:

| Incoming revision | Payload relation | Result |
|---|---|---|
| lower | any | `200 ignored-stale`; no state change |
| equal | byte-equivalent canonical payload | `200 replay`; no state change |
| equal | different payload | `409 revision-conflict`; no state change; alert |
| exactly current + 1 | valid | atomically commit payload/revision/digest; `200 applied` |
| greater than current + 1 | any | `409 revision-gap`; no state change; retry/alert |

An uninitialized object accepts revision 1 only. The transaction response is emitted only after storage commit. If the response is lost, retry sees equal state and succeeds as replay. There is no external side effect whose outcome can outlive or contradict that transaction.

## Audit and recovery

The audit command obtains the authoritative hostname set by listing `hostnames` and `routerReplicas` with the existing interactive, Admin-authorized operator credential. It never asks Cloudflare to list. For each known host it calls `GET /__internal/hostname-replicas/v1/<percent-encoded-host>?afterRecoverySequence=<cursor>` with a short-lived ID token impersonating a dedicated keyless audit service account. The registry pins that account's numeric `sub` and an audit-only audience. The cursor is absent/`0` on the first page and otherwise is the preceding response's canonical `nextAfter`; malformed or unknown-ahead cursors return `400`. The response exposes committed revision/digest, recovery-lock metadata, lookup outcome, and at most 100 append-only recovery records ordered by sequence. It exposes no route payload, public list, or mutation. `nextAfter` is the last returned sequence only when more records exist; the command follows pages to null.

```ts
type CommittedRef = null | { revision: string; digest: string };
type SourceAudit = { revision: string; digest: string; observedAt: string; payload: RouterReplicaDesired };
type WafEvidence = { zoneId: string; ruleId: string; host: string; verifiedAt: string; probes: [{ location: string; observedAt: string; expectedStatus: 403; observedStatus: 403 }, { location: string; observedAt: string; expectedStatus: 403; observedStatus: 403 }, { location: string; observedAt: string; expectedStatus: 403; observedStatus: 403 }] };
type PublicProbe = { location: string; observedAt: string; rayId: string; host: string; expectedStatus: number; observedStatus: number; expectedReason: null | 'inactive' | 'unknown-host'; observedReason: null | 'inactive' | 'unknown-host'; expectedRevision: string; observedRevision: string; expectedServesOrigin: boolean; observedServesOrigin: boolean; originRequestId: string | null };
type RecoveryAction =
  | { kind: 'acquire-lock'; wafEvidence: WafEvidence }
  | { kind: 'apply'; lockId: string; nextPublisherEpoch: string | null }
  | { kind: 'clear-lock'; lockId: string; wafRemovedAt: string; probes: [PublicProbe, PublicProbe, PublicProbe] }
  | { kind: 'abort-lock'; lockId: string };
type RecoveryRequest = { schemaVersion: 1; host: string; expectedCommitted: CommittedRef; sourceAudit: SourceAudit; action: RecoveryAction; incidentUrl: string; reason: string };
```

Recovery uses `POST /__internal/hostname-replicas/v1/recover` with exact `application/json` and the `RecoveryRequest` union above. A different human-impersonated service account, audience, and dedicated KMS signing key authorizes it; the publisher has neither. The exact body is bounded to 16 KiB before parsing and its signature covers every expected state, action, source audit, incident URL, and reason. `sourceAudit` is an operator-attested, transactionally consistent read of `hostnames/{host}` plus `routerReplicas/{host}` and must be no older than five minutes nor future. Its payload must hash to its digest, carry the same host/revision, and byte-match the exact ledger projection. A nonempty HTTPS incident URL and reason are mandatory. Extra/missing fields or evidence on the wrong action are rejected.

Recovery is a closed state machine, each step requiring the current `lockId`, an exact committed-state compare, the recovery identity/signature, and an atomic history append:

1. **Contain and acquire.** The human command installs an exact-host Cloudflare WAF block with a separate 1Password-backed token limited to `Zone WAF Edit` on the two served zones, reads the rule back, and observes direct 403 probes before requesting `acquire-lock`. The DO rechecks expected committed state and source freshness, then atomically creates `recoveryLock`. Publisher sync is rejected for the entire lock lifetime. If state changed before acquisition, CAS fails and the operator starts from a new audit.
2. **Apply canonical source.** `apply` retains the lock and atomically replaces committed state plus appends history. It may repair a different payload at the equal revision or jump to a higher source revision, recording every skipped revision range; it never lowers the high-water mark. If the DO is ahead of Firestore, recovery fails `409 source-behind`: an explicit Admin recovery transaction must first advance `routerReplicas/{host}` beyond the DO revision with the current canonical hostname projection, then a fresh signed audit may apply it. An equal-revision repair or any incident where publisher integrity is not proven requires `nextPublisherEpoch` greater than the stored minimum plus registry deployment evidence mapping that epoch to a replacement subject/CryptoKey unavailable to the quarantined runtime; the same transaction raises the minimum. Pre-signed requests from every older epoch are then rejected even when they carry a higher revision. A simple missing-delivery jump from an otherwise trusted publisher may keep the epoch by sending null.
3. **Prove and clear.** Before WAF removal, private audit must show lock held, source = committed, no drift, and any required replacement publisher epoch active while every lower per-host epoch is fenced. The command removes the exact-host rule while the lock still rejects all publisher changes, then runs the closed public router/host/status/reason/revision/serve/origin checks from at least three configured probe locations. A failure reinstalls the WAF rule and keeps the lock. `clear-lock` requires fresh source = committed plus the complete probe results, appends them, and atomically clears the lock. Queued publisher retries may proceed only afterwards; if Firestore advanced during recovery, the fresh-source compare prevents clear until that revision is applied.
4. **Abort without mutation.** `abort-lock` is allowed only when a fresh source audit exactly equals committed state. It records the reason and clears the lock; it cannot change committed state or bypass the monotonic rule.

The recovery history record includes action (`acquire-lock|apply|clear-lock|abort-lock`), before/after, skipped range, source audit, publisher epoch/config evidence, WAF rule/config/probe evidence where required, public probe results, operator subject, key version, incident URL, and reason. It is append-only and paginated. No adaptive analytics or sampled log is an admission source. A compromised publisher cannot invoke recovery; a compromised recovery identity can write only a fresh, source-attested, non-decreasing projection for one compared host.

## Provisioning, mutation, and deletion

One transaction helper owns every projected hostname mutation. Current `adultContent` derivation may continue updating its non-projected field without a revision. Any mutation of `eventId`, `status`, `slug`, `edition`, `root`, or `pathNamespace`, and any create/delete, must also read the persistent replica ledger, increment its revision, and write the matching desired state in the same transaction. `apexPath` remains target/client resolution data and is deliberately not copied. A direct or partial Admin SDK write is a contract violation caught by audit.

- **Provision:** validate Namespace/Slug/reserved labels; reject any existing hostname or tombstone; create `hostnames/{host}` initially `disabled` and the matching route projection at revision 1. Wait for publisher acceptance and edge inspection before activation.
- **Ordinary update:** non-projected fields do not churn the edge. Status, Edition, root, or path-capability changes produce one new revision. Root/route transitions and capability enablement obey `specs/path-addressing-and-root.md`'s archive transaction and deployment barrier. Active `eventId`/`slug` changes are rejected.
- **Repoint:** active → disabled and converge; change `eventId`/`slug` while disabled and converge; active and converge. Skipping or combining barriers is prohibited. An Edition-only correction need not disable the host, but manifest verification remains part of convergence.
- **Disable/archive:** write inactive state and its revision atomically. Normal completion waits for DO convergence. Immediate withdrawal installs the exact-host WAF block before the source mutation.
- **Delete:** reject active delete. After inactive convergence, atomically delete `hostnames/{host}` and advance `routerReplicas/{host}` to tombstone. Wait for tombstone convergence. Never delete the ledger/DO state or reuse the address.

The first implementation includes a dry-run-by-default backfill/reconciler. It lists with Admin credentials outside the request path, computes the exact projection, creates missing ledgers without changing public documents, and refuses conflicting histories. Its audit mode compares canonical host documents, desired-state ledgers, and per-host DO committed/lock/history state. It emits counts plus host/revision identifiers but no bearer tokens or credential material. There is deliberately no runtime acknowledgement write into Firestore: granting the publisher database write permission merely to record its delivery would undo the IAM narrowing.

## Lookup, cache, and abuse posture

The resolver calls only `registry.lookup(host)`. The registry derives one DO ID and returns that object's committed projection; an absent object is unknown. The public router receives neither the registry's DO namespace nor any list method. From the same result it serves exact `GET /.well-known/fiveacross-path-capability` as `{schemaVersion:1,pathNamespace:'fiveacross.app'|'vacaybingo.com'|null,revision:string}` with `Cache-Control: no-store`; missing/malformed/inactive/tombstone lookup fails closed and returns no capability. Root markers are valid configured origins: `doorway` or `not-found` controls the app's `/` outcome, not whether the edge may serve its shell/capability.

The current `caches.default` envelope is removed and neither service adds application, negative, stale-serve, or Firestore fallback caching. Every accepted lookup is strongly consistent with that object's committed state. The deliberate cost is that a cold global request travels to one object's location; hibernation/reset may add storage-read latency, and a DO outage removes the only lookup. The existing strict digit parser bounds the entire service call at 2,000 ms and every failure closes.

The Namespace/reserved/Slug guard runs before the service binding, so foreign/invalid traffic creates no DO work. A random valid hostname can still instantiate/read an empty object, so wildcard WAF/rate limits must bound unique-host floods before routes attach. Alerts track lookup count/cardinality, empty-object rate, cold/warm latency by colo, hibernation/reset/error outcomes, CPU/storage requests, and spend. The sync/audit/recovery fetch paths enforce exact route/method/content type and the 2 KiB/16 KiB bounds before JSON/JWT work, use Cloudflare per-IP rate limiting for invalid callers, single-flight cached JWKS, and generic errors. Automated DDoS protection and account spend alerts remain enabled.

## Failure semantics

| Condition | Router/result | Retry/fallback |
|---|---|---|
| uninitialized DO | rendered not-found, `unknown-host` | none; no negative cache |
| valid inactive/tombstone | rendered not-found, `inactive` / `unknown-host` | none |
| malformed/unsupported committed state | rendered not-found, `replica-malformed` | alert; no Firestore |
| Slug mismatch/missing | existing `slug-mismatch` / `slug-missing` | none |
| registry binding absent, or service/DO lookup rejects/times out | rendered not-found, `lookup-unavailable` | alert; no stale/Firestore fallback |
| `/__/auth/*` on configured router | preserve existing lookup bypass/origin pass-through | missing required bindings still fail closed first |
| publisher token/body signature/epoch rejected | sync `401` | Function throws; no state change |
| JWKS unavailable for unknown key | sync `503` | Function throws; platform retry |
| stale/replayed delivery | `200 ignored-stale` / `200 replay` | idempotent success |
| same revision, different payload | sync `409 revision-conflict` | no change; retry plus page |
| future non-successor revision | sync `409 revision-gap` | missing delivery may heal; otherwise recovery |
| publisher while recovery locked | sync `503 recovery-locked` | retry after source-attested recovery clears |
| audit/recovery caller rejected | `401` | no data/state returned; operator reauthenticates |
| recovery CAS/source/monotonic/probe check fails | `409` | no change; repeat source/DO audit and containment |
| origin fetch fails | existing generic `502 origin-unavailable` | unchanged |

Every public response keeps `x-event-router`; fail-closed responses keep a closed `x-event-router-reason`. A resolved edge record carries `x-event-router-revision`, a validated decimal string. No caller-controlled diagnostic enters a header.

## Observability, rollout, and rollback

Structured logs use closed outcomes and include router/registry version, host, revision when known, lookup/sync latency, KMS key-version identifier, and `applied|replay|ignored-stale|gap|conflict|recovery-locked|recovered`; they exclude tokens, signatures, request bodies, Firebase keys, and Event data. Page on any conflict, recovery, retry/gap older than five minutes, three consecutive serving-host probe failures, `lookup-unavailable` over 1% for five minutes, cold p95 over the budget, unexpected empty-object cardinality, or spend threshold. Audit reports missing/mismatch/locked/ahead/behind counts; cutover requires zero.

These gates insert a registry rung before the PRD's existing Gate 1–3 ladder. Evidence records deployed versions/source commit, expected revisions, timestamps, probe locations, cold/warm latency, and App Check state.

1. **R0 — resources and IAM:** provision private Firestore collection/rules; separate registry service; registry-owned DO namespace/migration; point-only router service binding; publisher/audit/recovery identities/audiences; distinct publisher/recovery CryptoKeys; rate limiter; exact-host WAF capability; and observability. Verify the publisher has only event/logging plus use-to-sign on its one key, recovery only its key, audit no data/signing role, no user-managed key/Secret Manager/Cloudflare credential, and the public router no DO/KV/Firestore binding.
2. **R1 — backfill and shadow:** deploy publisher, registry, and replica-capable router with routes absent. Backfill every serving host. Audit source → ledger → DO at zero missing/mismatch/locked/conflict, exercise active→disabled→active/root/tombstone records, and hold 24 hours with no unexplained drift/retry over five minutes.
3. **R2 — failure/recovery and data-plane rehearsal:** prove auth/signature/epoch rotation/replay/gap/conflict, old-epoch higher-revision refusal, transaction response loss, concurrent sync/recovery-lock races, equal-repair/higher-jump/lower-refusal/source-behind recovery, WAF containment and failed-probe relock, hibernation/reset, DO storage/unavailability/malformed state, random-valid-host floods, non-enumerable binding, exact path capability, auth pass-through, and no Firebase/KV/cache request. From at least three real probe locations, run five passes 30 seconds apart against active/inactive/root/tombstone/unknown hosts; record cold and warm p50/p95/max, revision/result equality, timeout headroom, object/error/cardinality cost, and spend. The single DO state is strongly consistent; these probes prove the synchronous public path and latency, not replica convergence.
4. **R3 — App Check invariant:** enable Firestore App Check enforcement through #44's monitor/enforce procedure while routes remain grey. Browser resolution, adult-content watch, auth handoff, and Functions pass. Re-run R2. App Check stays enforced thereafter.
5. **PRD Gate 1:** direct Hosting, `same_origin`, full real-host game as the PRD specifies.
6. **PRD Gate 2:** direct Hosting, `handoff`, four-platform sign-in matrix. #547 provisioning and #852 acceptance must be complete.
7. **PRD Gate 3:** require #539 reserved-label/DNS work, #546 per-host identity, #852 wildcard sign-in, #960 analytics disposition, #961 cold-client/predeploy check, #888's implementation children, all checks green, zero unresolved conversations, and fresh R1/R2 evidence. Attach `*.fiveacross.app` only; verify serving/unknown/reserved hosts, deep links, auth, manifest/service worker/offline/PWA, response revision/version, App Check, zero Firebase edge calls, and cold/warm latency/error budget. Observe one hour, then attach/repeat for `*.vacaybingo.com`. Apexes remain direct Hosting.

Emergency per-host containment is the exact-host WAF rule. Namespace route removal is a withdrawal primitive only after the direct-Hosting destination is demonstrated to preserve the required fail-closed posture; otherwise the WAF remains while the route is changed. Code rollback selects the last known-good **DO-schema-compatible** registry/router. A rollback never restores Firestore REST, KV, or stale cache lookup after R3. Do not delete DO/ledger/history state. Reattachment requires the same source/DO audit and R2 evidence.

## Test seams and acceptance

All platform seams are injected. Tests require no live account unless marked integration.

- Pure schema/hostname/revision/digest tables: decimal precision, route/root/tombstone/pathNamespace, Edition/Slug/Namespace validation, extras, and exact 2 KiB sync / 16 KiB recovery boundaries.
- Pure OIDC/KMS verifier with injected clock/JWKS/cache/keys: issuer/audience/subject/algorithm/expiry/signature, altered bytes/path/time, cooldown, rotation, unavailable JWKS, and sensitive-log exclusion.
- Durable Object transaction tests: initial 1, successor/equal/lower/gap/conflict, response loss, concurrent arrivals, recovery lock versus queued publisher, epoch floor/rotation, equal repair, higher jump with skipped-range audit, lower/source-behind refusal, lock persistence across hibernation/reset, atomic append-only history/pagination, tombstone non-reuse, and no external storage call.
- Recovery tests: separate identity/key, exact Firestore source/ledger attestation and freshness, WAF-before-lock/CAS, publisher quarantine/epoch raise and old-epoch higher-revision rejection, source advance while locked, failed probes keep/reinstate containment, clear only on fresh source = committed, abort without mutation, forged/stale/wrong-host evidence, and monotonic replay refusal.
- Publisher tests: metadata audience, exact endpoint/body digest/KMS signing, non-2xx/invalid-body throw, idempotent retry, stolen-token replay, and no Admin SDK dependency.
- Firestore emulator tests: all client access to `routerReplicas` denied; trusted mutation and recovery-ledger helpers keep source/projection atomic across provision/status/repoint/delete/advance.
- Registry/router contracts: only `lookup(host)` crosses the binding; router has no DO/KV/list; registry public fetch has no lookup/list; route/root/capability, failure table, no Firebase/Cache API, auth ordering, revision header, namespace-before-binding, malformed/unavailable DO, and random-host rate/cost controls.
- Reconciler fixtures: source pagination, point audit/history pages/cursors, missing/drifted/tombstoned/conflicting/recovered/already-correct/source-behind states.
- Remote unrouted integration: complete R2/Gate 3 probe and cost matrix with App Check enforced; disabling it is never setup.

Acceptance for #888's implementation is all tests above, R0–R3 evidence, removal of Worker Firestore code/bindings/deploy checks, updated `specs/event-router.md` and `worker/README.md`, and routes still commented. Route attachment remains #529's separate human Gate 3 action.

## Implementation split

| Ticket | Size | Delivers | Depends on |
|---|---|---|---|
| **A — one synthetic hostname end to end** | L | deny-all desired state triggers keyless publisher, passes contiguous per-host DO transaction, serves private point lookup, supports source-attested recovery lock/history, and proves identity/latency/flood/failure seams; no public route | this spec |
| **B — real hostname lifecycle convergence** | M | atomic mutation helper, revision ledger, lifecycle barriers, backfill, source-list/point-audit reconciler, recovery-ledger advance, and emulator/integration tests | A |
| **C — unrouted router consumes registry** | M | router uses A's non-enumerable lookup, removes Firestore/Cache/Firebase bindings, preserves route/root/auth/header/path-capability contracts, and passes remote tests with routes absent | A; production rehearsal also needs B |
| **D — App Check-on cutover readiness** | S human/ops + tests | provision/verify IAM/resources, run backfill/audit/recovery and synchronous multi-colo R0–R3 evidence, enable App Check through #44, and prove the unrouted artifact without attaching a Namespace | B, C, #44 |

A–C are tracer bullets sized for one implementation context and share this contract. D is operational and cannot attach routes. #888 remains the blocker of #529 until A–D and R0–R3 complete; #529 owns Gate 3 and remains blocked by #888 plus #539, #546, #852, #960, and #961.
