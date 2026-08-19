---
spec_id: event-router-registry
status: accepted
tested: false
reason: Design-only — selects and pins the App Check-compatible control plane, edge replica, and cutover gates; runtime tests land in the implementation tickets in § Implementation split.
---

# App Check-compatible Event-router registry (`event-router-registry`)

This is the implementation contract for [ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md) and issue #888. It replaces only the edge lookup seam in `specs/event-router.md`; `specs/hostnames-lookup.md` remains the browser-facing source contract, and `specs/event-resolution.md` remains the independent client resolution contract. Until the implementation tickets land, the deployed-but-unrouted Worker still carries its Firestore REST reader and **must remain unrouted**.

## Invariants and threat model

1. **App Check is never weakened for the router.** The Worker sends neither an App Check token nor a Firebase request in the target architecture.
2. **The router is not authorization.** A stale or forged routing projection can make a public shell available or unavailable; it cannot mint a Firebase session or bypass App Check, Firestore Rules, Storage Rules, or Event membership. The client never accepts the edge's `eventId` as its own Resolution.
3. **Firestore is canonical; the edge is a projection.** Only the trusted hostname mutation path changes canonical state. No Cloudflare path writes back to `hostnames/*`.
4. **The replica is not a directory.** Public traffic can point-get the value for its already-present hostname only. No public list endpoint exists.
5. **Address states move monotonically.** Every projected change has a per-host revision. Retries and older deliveries cannot overwrite a newer edge state. A deleted address leaves a permanent tombstone and is not reusable.
6. **Failure closes.** Missing bindings, invalid schemas, unsupported versions, unavailable KV, and unknown/inactive/tombstoned hosts never proxy the origin. There is no Firestore fallback.

The actors considered are an unauthenticated Internet caller, a modified browser client, a bearer-token thief, a compromised publisher runtime, and a compromised Worker deployment. The protected assets are routing integrity/availability, Firestore data, cross-cloud credentials, and bounded platform cost. GCP/Cloudflare account administrators and a compromised Firebase Hosting origin are outside this contract; both already control the served system. Hostnames, Event IDs, Slugs, statuses, and replica revisions are public metadata, not secrets.

## Architecture and ownership

```text
trusted hostname writer
      │ one Firestore transaction
      ├── hostnames/{host}             public point-get source
      └── routerReplicas/{host}        private desired state + revision
                    │ Firestore event, retry enabled
                    ▼
       replica publisher Function      dedicated keyless service identity
                    │ Google OIDC ID token
                    ▼
       authenticated sync endpoint ──► per-host Durable Object ──► Workers KV
                                                                        │
public request ─► Namespace/Slug guard ─────────────────────────────────┘
                    │ active + matching
                    ▼
              Firebase Hosting origin
```

| Surface | May read | May write | Explicitly may not do |
|---|---|---|---|
| Browser/app | one named `hostnames/{host}` under existing rules | no hostname/replica writes | list either registry; read `routerReplicas` |
| Hostname writer | hostname plus its replica ledger | both in one transaction | report success before replica convergence |
| Publisher Function | its event payload and metadata-server ID token | authenticated sync request | call Firestore/Admin SDK; hold a key or Cloudflare API token |
| Sync endpoint/DO | validated request, DO state, bound KV | one host's newer KV value and high-water state | list Firestore/KV; attach routes; select an origin |
| Public router | one KV key selected after the host guard | nothing by design | call Firestore or accept edge identity as app Resolution |

### Google service identity and edge authentication

Use a dedicated runtime service account, provisionally `event-router-replica-publisher@fiveacross.iam.gserviceaccount.com`. It receives only the roles required for a v2 Firestore event receiver and logging; it receives **no** `datastore.*`, Firebase Admin, Secret Manager, service-account-key, or Cloudflare permission. Control-plane grants needed to attach the identity belong to the deployer/service agents, not to the runtime principal, and must be reported separately in the IAM verification.

For each delivery the Function obtains a Google-signed ID token from the metadata server for one configured audience and sends it as `Authorization: Bearer`. The endpoint verifies `alg=RS256`, a Google signing key from cached JWKS, the documented Google issuer, exact `aud`, `exp`/`iat`, and the configured stable numeric `sub`. Email is diagnostic only and never the authorization key. Unknown signing keys trigger one bounded JWKS refresh; refresh failure returns retryable `503`, while a bad token returns generic `401`. Token contents and Authorization headers are never logged.

The exact audience is the deployed `workers.dev` origin plus `/__internal/hostname-replicas/v1`; it is immutable deployment configuration on both sides. Only that path is admitted on `workers.dev`; the existing public router continues to reject every other `workers.dev` path as out-of-Namespace. Local tests inject token acquisition and verification; no test key or bypass compiles into production.

## Data and wire contracts

`routerReplicas/{host}` is denied to every Firebase client (`get`, `list`, and all writes). It persists after a hostname deletion and has exactly:

```ts
type RouterReplicaDesired = {
  schemaVersion: 1;
  revision: string; // canonical positive decimal, no leading zeroes; compare as BigInt
  host: string;     // hostnameKey(host), identical to the document ID
  desired:
    | { kind: 'route'; eventId: string; status: 'active' | 'disabled' | 'archived'; slug: string; edition: Edition }
    | { kind: 'tombstone' };
  updatedAt: Timestamp; // observability only; never orders writes
};
```

The sync request is `POST /__internal/hostname-replicas/v1`, exact `application/json`, at most 2 KiB, and contains the four fields above with `updatedAt` encoded as RFC 3339. Extra/missing fields, a non-canonical hostname/revision, an unknown status/version/Edition, a reserved or invalid label, a route whose `slug` does not equal the host's first label (Namespace apex exception preserved), and any non-POST method fail before storage. Validation reuses the router's Namespace, Slug, and Edition modules; it does not fork their lists. `edition` is copied because #546 must render the per-host manifest at this same edge before Gate 3; it must not create a second App Check-incompatible lookup.

Workers KV uses the exact key `hostname:v1:<normalized-host>`. Its value is the schema-validated `{schemaVersion, revision, desired}` projection; it contains no timestamp used for ordering. Tombstones are values, not KV deletions, so negative-cache behavior cannot resurrect a reusable address.

The Durable Object is named from the normalized host. For one request it compares the incoming canonical decimal revision with its stored high-water state:

| Incoming revision | Payload relation | Result |
|---|---|---|
| lower | any | `200 ignored-stale`; no KV write |
| equal | byte-equivalent canonical payload | `200 replay`; no state change |
| equal | different payload | `409 revision-conflict`; no write; alert |
| higher | valid | write KV, then durably store the same revision/payload; return `200 applied` only after both succeed |

If the KV write fails, the high-water state does not advance and the Function retry can apply it. Durable Object request handling must not interleave the compare/write/store critical section. Firestore event retries are enabled; every non-2xx or invalid success body is thrown. A permanent `409` remains loud through retries and pages an operator rather than guessing which payload wins.

## Provisioning, mutation, and deletion

One transaction helper owns every projected hostname mutation. Current `adultContent` derivation may continue updating its non-projected field without a revision. Any mutation of `eventId`, `status`, `slug`, or `edition`, and any create/delete, must also read the persistent replica ledger, increment its revision, and write the matching desired state in the same transaction. A direct or partial Admin SDK write is a contract violation caught by the audit.

- **Provision:** validate Namespace/Slug/reserved labels; reject any existing hostname or tombstone; create `hostnames/{host}` initially `disabled` and the matching route projection at revision 1. Wait for publisher acceptance and edge inspection before continuing. Activation is a second transaction/revision, and the hostname is not announced until the activation convergence gate passes.
- **Ordinary update:** non-projected fields do not churn the edge. A status or Edition change produces one new revision. An `eventId` or `slug` change while active is rejected.
- **Repoint:** active → disabled and converge; change `eventId`/`slug` while disabled and converge; active and converge. Skipping or combining those barriers is prohibited even though the source writes are transactional. An Edition-only correction need not disable the host, but its manifest cache verification is part of convergence.
- **Disable/archive:** write the inactive status and its revision atomically. Normal completion waits for convergence. If immediate withdrawal is required, install a Cloudflare hostname block first; KV has no promised global convergence bound.
- **Delete:** reject an active delete. After inactive convergence, atomically delete `hostnames/{host}` and advance `routerReplicas/{host}` to `tombstone`. Wait for tombstone convergence. Never delete the ledger or reuse the address.

The first implementation includes a dry-run-by-default backfill/reconciler. It lists with Admin credentials outside the request path, computes the exact projection, creates missing ledgers without changing public documents, and refuses conflicting histories. Its audit mode compares canonical host documents, desired-state ledgers, Durable Object high-water revisions, and observed KV values. It emits counts and host/revision identifiers but no bearer tokens or credential material. There is deliberately no runtime “ack” write into Firestore: granting the publisher database write permission merely to record its own delivery would undo the IAM narrowing.

## Cache and abuse posture

The resolver calls the KV binding directly and removes the current `caches.default` positive envelope. It does not set an additional application TTL, negative cache, stale-serve cache, or Firestore fallback. KV's own edge caches and eventual propagation remain the single cache layer. A write acknowledgement proves acceptance, not global visibility; operational convergence is established by probes. A region may continue to observe an older accepted revision during propagation, which is why an urgent withdrawal uses the independent Cloudflare block rather than waiting on KV.

The Namespace/reserved/Slug guard runs before KV, so foreign and structurally invalid traffic costs no store read. Wildcard zones must have Cloudflare rate-limit/WAF rules for unknown-host floods before a route is attached, plus the reserved-label exclusions already required by `specs/event-router.md`. The sync path enforces method, content type, and 2 KiB length before JSON/JWT work; uses Cloudflare's per-IP rate-limiting binding for invalid callers; caches valid JWKS by their response policy; and never reflects validation details. Rate limits are an abuse signal, not an authentication substitute. Automated DDoS protection and account spend alerts remain enabled.

## Failure semantics

| Condition | Router result | Retry/fallback |
|---|---|---|
| unknown KV key | rendered not-found, `unknown-host` | none |
| valid inactive/tombstone | rendered not-found, `inactive` / `unknown-host` | none |
| malformed or unsupported replica | rendered not-found, `replica-malformed` | alert; no Firestore |
| Slug mismatch/missing | existing `slug-mismatch` / `slug-missing` | none |
| KV binding absent or read rejects/times out | rendered not-found, `lookup-unavailable` | alert; no stale or Firestore fallback |
| `/__/auth/*` on a configured router | preserve the existing lookup bypass and origin pass-through | missing required bindings still fail closed first |
| publisher token rejected | sync `401` | Function throws; token refresh then platform retry |
| JWKS dependency unavailable for an unknown key | sync `503` | Function throws; platform retry |
| stale/replayed delivery | `200 ignored-stale` / `200 replay` | idempotent success |
| same revision, different payload | sync `409` | no write; retry plus page |
| origin fetch fails | existing generic `502 origin-unavailable` | unchanged |

Every public response keeps `x-event-router`; fail-closed responses keep a closed `x-event-router-reason`. A resolved edge record also carries `x-event-router-revision`, a validated decimal string, so a probe can name what it observed. It exposes no new secret.

## Observability and operations

Structured logs use closed outcomes and include router version, host, revision when known, lookup/sync latency, and `applied|replay|ignored-stale|conflict`; they exclude OIDC tokens, JWT claims other than the accepted subject identifier, request bodies, Firebase keys, and Event data. Metrics/alerts required before routing are:

- publisher deliveries, failures, retry age, and latency; page on any `revision-conflict` or a retry age over five minutes;
- replica audit counts by missing, mismatched, and ahead/behind; cutover requires every count to be zero;
- router outcomes and KV latency; page if three consecutive probes of any serving host fail or `lookup-unavailable` exceeds 1% of routed requests for five minutes;
- rate-limit/WAF actions and Workers/KV/DO spend alerts; and
- a synthetic active, inactive, tombstone, and unknown host probe, with alerts carrying hostname, expected revision, observed reason, and router version.

## Rollout, cutover gates, and rollback

These gates insert a registry rung before the PRD's existing Gate 1–3 ladder. Evidence is recorded with the deployed Worker version, source commit, expected revisions, timestamps, probe locations, and App Check enforcement state.

1. **R0 — resources and IAM:** provision the private Firestore collection/rules, dedicated publisher identity, exact OIDC audience/subject, KV namespace, per-host Durable Object migration, rate-limiter, and observability. Verify from IAM policy output that the publisher principal has no Firestore/data-store role, no user-managed key, and no Secret Manager or Cloudflare credential. Verify the Worker has no `FIREBASE_API_KEY`/`FIREBASE_PROJECT_ID` lookup binding.
2. **R1 — backfill and shadow:** deploy publisher and replica-capable Worker with wildcard routes still absent. Backfill every serving `hostnames` document. Audit source → ledger → DO/KV at zero missing/mismatch/conflict, then exercise active→disabled→active and tombstone synthetic records. Hold 24 hours with zero unexplained drift, no retry older than five minutes, and no conflict.
3. **R2 — failure rehearsal:** automated/deployed checks prove unauthorized/expired/wrong-audience sync, out-of-order/equal-conflict revisions, malformed KV, KV/JWKS/origin failures, unknown/inactive/tombstone hosts, auth passthrough, and no Firestore outbound request. Multi-region probes from at least three regions, five passes 30 seconds apart, must observe every serving host's expected revision. This is evidence, not a false global-consistency proof.
4. **R3 — App Check invariant:** enable Firestore App Check enforcement through #44's own monitor/enforce procedure while routes remain grey. Browser resolution, adult-content watch, auth handoff, and Functions pass their enforcement checks. Re-run R2. App Check stays enforced for every later gate.
5. **PRD Gate 1:** direct Hosting, `same_origin`, full real-host game as the PRD specifies.
6. **PRD Gate 2:** direct Hosting, `handoff`, four-platform sign-in matrix. #547 provisioning and #852 acceptance must be complete.
7. **PRD Gate 3:** require #539 reserved-label/DNS work, #546 per-host identity, #852 wildcard sign-in, #888's implementation children, all checks green, zero unresolved review conversations, and a fresh R1/R2 audit. Attach `*.fiveacross.app` only; verify serving/unknown/reserved hosts, deep links, `/__/auth/*`, manifest, service worker, offline cold boot, an already-installed PWA, response revision/version, App Check still enforced, and zero Firestore calls from Worker telemetry. Observe one hour with no alert, then attach and repeat for `*.vacaybingo.com`. Apexes remain direct Hosting.

Rollback one Namespace at a time by removing its Worker route, returning exact/wildcard DNS behavior to Hosting; do not delete KV/DO/ledger state during rollback. A code rollback selects the last known-good **replica-capable** Worker. After R3, the Firestore REST reader is not an allowed rollback. Emergency containment is the per-host Cloudflare block or Namespace route removal. Recovery requires the same revision audit before reattachment.

The PRD's historical Gate 4 redirect is superseded by #599: registered serving hosts serve in place, so no alias-redirect gate is reintroduced here.

## Test seams and acceptance

All platform seams are injected. Tests require no live Google/Cloudflare account unless marked integration.

- Pure schema/hostname/revision parser tables, including decimal precision, reserved/apex cases, Edition validation, extra fields, and payload size.
- Pure OIDC verifier with injected clock/JWKS fetch/cache: good token, issuer/audience/subject/algorithm/expiry failures, rotation, unavailable JWKS, and no sensitive log serialization.
- Durable Object storage/KV fakes proving higher/equal/lower/conflict, concurrent arrivals, KV failure before high-water, retry after partial failure, and tombstone non-reuse.
- Publisher fakes proving metadata token audience, exact endpoint/body, non-2xx/invalid-body throw, idempotent retry, and no Admin SDK dependency.
- Firestore emulator tests proving all client access to `routerReplicas` is denied and the trusted transaction helper keeps source/projection atomic across provision, status, repoint, and delete.
- Router unit tests replacing the Firestore seam with KV: no Firebase fetch, no Cache API envelope, every failure-table row, auth bypass ordering, revision header, and namespace-before-store ordering.
- Reconciler dry-run/apply/audit fixtures for missing, drifted, tombstoned, conflicting, and already-correct records.
- Remote integration tests against an unrouted preview, followed by the exact R2 and Gate 3 probes. Tests must assert App Check enforcement stays enabled; disabling it is never test setup.

Acceptance for #888's implementation is all tests above, R0–R3 evidence, removal of the Worker Firestore code/bindings/deploy checks, updated `specs/event-router.md` and `worker/README.md`, and the route block still commented. Route attachment remains a separate human Gate 3 action.

## Implementation split

| Ticket | Size | Delivers | Depends on |
|---|---|---|---|
| **A — source ledger and mutation contract** | M | deny-all `routerReplicas`, schema/revision types, atomic hostname helper, tombstone/repoint invariants, dry-run backfill and emulator/unit tests | this spec |
| **B — ordered edge replica and authenticated ingest** | L | KV/DO bindings, OIDC verifier and sync endpoint, revision state machine, rate limiting, observability, unit/integration tests; routes stay absent | A's wire contract |
| **C — keyless publisher and reconciliation** | M | dedicated service identity/config, retrying Firestore trigger without Admin SDK, metadata ID-token client, audit/reconcile command and runbook | A and B contracts |
| **D — router lookup cutover** | M | KV resolver, removal of Firebase bindings/Cache API lookup, closed failure/header updates, deploy verification and full router tests; still unrouted | B plus backfilled C environment |
| **E — operational R0–R3 and Namespace cutover** | S human/ops | provision IAM/resources, backfill/audit, enforce App Check, capture gate evidence, then attach/verify/observe one Namespace at a time | A–D, #44, #539, #546, #547, #852 |

A–D are independently reviewable but must share this exact contract rather than inventing parallel schemas. E is not bundled into a code PR and is the only ticket authorized to attach routes. #888 remains the blocker of #529 until A–D and R0–R3 are complete; #529's Gate 3/cutover work remains blocked until E and its external prerequisites complete.
