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
4. **The replica is not a directory.** Public traffic can point-get the value for its already-present hostname only. The public router has no KV binding and neither its service binding nor any public endpoint exposes list.
5. **Address states move contiguously.** Every projected change has the exact successor per-host revision. Retries, gaps, and older deliveries cannot overwrite a newer edge state. A deleted address leaves a permanent tombstone and is not reusable.
6. **Failure closes.** Missing bindings, invalid schemas, unsupported versions, unavailable KV, and unknown/inactive/tombstoned hosts never proxy the origin. There is no Firestore fallback.

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
       registry service (private lookup) ─► per-host Durable Object ─► Workers KV

public request ─► Event router / Namespace + Slug guard
                    │
                    ├── private service binding: registry.lookup(host) ─► Workers KV point-get
                    └── active + matching ──────────────────────────────► Firebase Hosting origin
```

| Surface | May read | May write | Explicitly may not do |
|---|---|---|---|
| Browser/app | one named `hostnames/{host}` under existing rules | no hostname/replica writes | list either registry; read `routerReplicas` |
| Hostname writer | hostname plus its replica ledger | both in one transaction | report success before replica convergence |
| Publisher Function | its event payload, metadata-server ID token, one KMS signing operation | authenticated signed sync request | call Firestore/Admin SDK; export a key; hold a Cloudflare API token |
| Registry service/DO | validated request, DO state, bound KV | one host's exact successor KV value and high-water state | read Firestore; attach routes; select an origin |
| Public router | one registry `lookup(host)` result after the host guard | nothing | bind/list KV; call Firestore; accept edge identity as app Resolution |
| Audit operator | Firestore source/ledger list plus authenticated per-host edge state | nothing in audit mode | consume the publisher identity or enumerate through the edge |
| Recovery operator | one compared host state and incident reference | compare-and-set repair plus an exact-host WAF block through a separate human token | use the publisher identity/key; list through the edge; attach routes |

### Google service identity and edge authentication

Use a dedicated runtime service account, provisionally `event-router-replica-publisher@fiveacross.iam.gserviceaccount.com`. It receives only the roles required for a v2 Firestore event receiver/logging plus `cloudkms.cryptoKeyVersions.useToSign` on one dedicated `RSA_SIGN_PKCS1_2048_SHA256` CryptoKey. Cloud KMS does not support IAM policies on an individual CryptoKeyVersion ([Cloud KMS permissions and roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles)), so this CryptoKey is the narrowest real grant boundary. It contains no unrelated versions: only the publisher's current version is enabled at steady state, and only the current plus replacement versions are enabled during the bounded rotation overlap. The selected version resource name is immutable publisher configuration and an explicit registry allowlist, so signing authority on another key or disabled/non-allowlisted version is rejected. The account receives **no** `datastore.*`, Firebase Admin, Secret Manager, service-account-key, or Cloudflare permission. Control-plane grants needed to attach the identity belong to the deployer/service agents, not to the runtime principal, and must be reported separately in the IAM verification.

For each delivery the Function obtains a Google-signed ID token from the metadata server for one configured audience and sends it as `Authorization: Bearer`. The endpoint verifies `alg=RS256`, a signing key from `https://www.googleapis.com/oauth2/v3/certs`, `iss=https://accounts.google.com`, exact `aud`, `exp`, `iat` no more than 60 seconds in the future, and the configured stable numeric `sub`. Email is diagnostic only and never the authorization key. JWKS refresh is single-flight; an unknown `kid` permits one refresh per five-minute cooldown so invalid tokens cannot force an outbound fetch each time. Refresh failure returns retryable `503`, while a bad token returns generic `401`.

OIDC authenticates the workload but is still a bearer credential, so the Function also asks Cloud KMS to sign `v1\nPOST\n<path>\n<issued-at-ms>\n<sha256-of-exact-body>` and sends the key-version resource name, issued-at, and base64 signature in fixed headers. The registry pins the public key for each allowed version, accepts a signature timestamp within 60 seconds, and verifies the signature before applying a payload. The private key never leaves KMS. A stolen OIDC token cannot sign altered bytes; an intercepted complete request can only replay the identical revision. Rotation deploys the new public key before the publisher changes versions, overlaps for one maximum token lifetime plus retry window, then removes the old key after audit shows no use.

The exact audience is the separately deployed registry service's `workers.dev` origin plus `/__internal/hostname-replicas/v1`; it is immutable deployment configuration on both sides. That service has no wildcard route. Its public `fetch` surface admits only the sync, audit, and recovery paths below; point lookup is an RPC/service-entrypoint method available only through the Event router's Cloudflare service binding. The Event router's own `workers.dev` behavior remains out-of-Namespace. Local tests inject token/signature acquisition and verification; no test key or bypass compiles into production.

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

The sync request is `POST /__internal/hostname-replicas/v1`, exact `application/json`, at most 2 KiB, and contains the four fields above with `updatedAt` encoded as RFC 3339. Extra/missing fields, a non-canonical hostname/revision, an unknown status/version/Edition, a reserved or invalid label, a route whose `slug` does not equal the host's first label (Namespace apex exception preserved), an invalid body signature, and any non-POST method fail before storage. Validation reuses the router's Namespace, Slug, and Edition modules; it does not fork their lists. `edition` is copied because #546 must render the per-host manifest at this same edge before Gate 3; it must not create a second App Check-incompatible lookup.

Workers KV uses the exact key `hostname:v1:<normalized-host>`. Its ordinary value is the schema-validated `{schemaVersion, revision, desired}` projection; it contains no timestamp used for ordering. Tombstones are values, not KV deletions, so negative-cache behavior cannot resurrect a reusable address. Break-glass recovery alone may write `{schemaVersion:1,revision:<committed-or-pending-revision>,desired:{kind:'safety-block'}}`; lookup treats it as inactive and it never enters Firestore.

For comparison and audit, the projection digest is SHA-256 over the UTF-8 JSON array `[1, revision, host, "route", eventId, status, slug, edition]`, `[1, revision, host, "tombstone"]`, or the recovery-only `[1, revision, host, "safety-block"]`; constructing that array is the only canonicalizer. The Durable Object is named from the normalized host. An uninitialized object accepts revision 1 only. Thereafter it compares the incoming canonical decimal revision with its stored high-water state:

| Incoming revision | Payload relation | Result |
|---|---|---|
| lower | any | `200 ignored-stale`; no KV write |
| equal | byte-equivalent canonical payload | `200 replay`; no state change |
| equal | different payload | `409 revision-conflict`; no write; alert |
| exactly current + 1 | valid | durably claim pending, publish that payload, then commit; return `200 applied` only after all three succeed |
| greater than current + 1 | any | `409 revision-gap`; no write; retry/alert |

Admission and publication use a durable pending/commit protocol because KV cannot participate in a Durable Object storage transaction:

1. In one DO-storage transaction, compare the committed high-water state (which retains its exact KV payload) and create `pending:{operation:'sync',revision,digest,payload,startedAt}` for the valid successor. While a pending record exists, only an identical revision/digest may resume it. The same revision with another digest returns `409 revision-conflict`; every other publisher mutation returns retryable `503 publication-pending`. No publisher may replace or skip the pending payload.
2. Write the exact pending payload to KV. A failure leaves pending durable and returns `503`; retry resumes that same write.
3. In one DO-storage transaction, require the same pending record and predecessor, advance committed revision/digest/payload, and clear pending. A failure leaves the fence in place; retry may rewrite the identical KV value and finalize. If another identical resumption already cleared pending and committed the same revision/digest, finalization is an idempotent success.

KV can therefore expose a pending value before finalization, but no conflicting payload can pass the DO fence during that interval. Audit exposes the state and an alert fires if pending is older than one minute. Firestore event retries are enabled; every non-2xx or invalid success body is thrown. A gap can heal when the missing delivery arrives; a persistent gap or conflict pages rather than guessing which payload wins.

### Audit and recovery wire

The audit command obtains the authoritative hostname set by listing `hostnames` and `routerReplicas` with the existing interactive, Admin-authorized operator credential. It never asks Cloudflare to list. For each known host it calls `GET /__internal/hostname-replicas/v1/<percent-encoded-host>?afterRecoverySequence=<cursor>` with a short-lived ID token impersonating a dedicated keyless audit service account. The registry pins that account's `sub` and an audit-only audience. The cursor is optional on the first call (equivalent to `0`) and otherwise is the canonical non-negative decimal `nextAfter` from the preceding response; malformed or unknown-ahead cursors return `400`. The exact response is:

```ts
type BlockProbe = { phase: 'blocked-before-worker'; location: string; observedAt: string; rayId: string; host: string; zoneId: string; ruleId: string; expectedStatus: 403; observedStatus: 403; expectedProviderAction: 'block'; observedProviderAction: 'block'; providerEventQuery: { dataset: 'firewallEventsAdaptive'; queriedAt: string; matches: 1; responseDigest: string } }; type SafetyProbe = { phase: 'safety-block'; location: string; observedAt: string; registryRequestId: string; host: string; expectedReason: 'safety-block'; observedReason: 'safety-block'; expectedRevision: string; observedRevision: string; expectedServesOrigin: false; observedServesOrigin: false }; type CanonicalProbe = { phase: 'canonical-after-unblock'; location: string; observedAt: string; rayId: string; host: string; expectedStatus: number; observedStatus: number; expectedRouterReason: null | 'inactive' | 'unknown-host'; observedRouterReason: null | 'inactive' | 'unknown-host'; expectedRevision: string; observedRevision: string; expectedServesOrigin: boolean; observedServesOrigin: boolean; originRequestId: string | null };
type ReplicaAuditResponse = {
  schemaVersion: 1;
  host: string;
  durable: null | {
    committed: null | { revision: string; digest: string };
    safetyBlock: null | { ruleId: string; establishedAt: string; confirmedAt: string | null; sourceAudit: { revision: string; digest: string; observedAt: string } };
    pending: null | {
      operation: 'sync' | 'recovery-apply' | 'recovery-resume' | 'recovery-abort';
      revision: string;
      digest: string;
      startedAt: string; // RFC 3339, observability only
    };
  };
  kv: null | { revision: string; digest: string };
  lookup: { servesOrigin: boolean; reason: 'active' | 'inactive' | 'tombstone' | 'safety-block' | 'missing' | 'malformed'; revision: string | null };
  recoveryPage: {
    records: Array<{
      sequence: string; // per-host positive decimal, append-only
      occurredAt: string; // RFC 3339
      action: 'apply' | 'resume-pending' | 'abort-pending' | 'confirm-block' | 'clear-block';
      before: null | { revision: string; digest: string };
      abandonedPending: null | { operation: 'sync' | 'recovery-apply' | 'recovery-resume' | 'recovery-abort'; revision: string; digest: string; startedAt: string };
      after: null | { revision: string; digest: string };
      sourceAudit: { revision: string; digest: string; observedAt: string };
      blockEvidence: null | { zoneId: string; ruleId: string; host: string; verifiedAt: string; probes: [BlockProbe, BlockProbe, BlockProbe] };
      safetyEvidence: null | { confirmedAt: string; probes: [SafetyProbe, SafetyProbe, SafetyProbe] }; clearEvidence: null | { removedAt: string; probes: [CanonicalProbe, CanonicalProbe, CanonicalProbe] };
      operatorSub: string;
      keyVersion: string;
      incidentUrl: string;
      reason: string;
    }>;
    nextAfter: string | null;
  };
};
```

Each page contains at most 100 recovery records ordered by sequence. `nextAfter` is the last returned sequence only when more records exist; the command follows it to `null` and includes every record in its audit output. `lookup` is computed by the same point-lookup helper as the private service binding without exposing its payload. The endpoint exposes no route payload, list, or mutation. Pagination over hostnames exists only on the Firestore source list; recovery pagination remains inside one already-named host. Audit-token theft permits guessed point reads of public metadata and that host's break-glass evidence, not enumeration or mutation.

Repair uses a different human-impersonated recovery service account, audience, and Cloud KMS signing key; the publisher has neither. `POST /__internal/hostname-replicas/v1/recover` carries `{schemaVersion:1,host,expected:{committed,pending,safetyBlock:<the exact audit values>},action:{kind:'apply',replacement:<RouterReplicaDesired>}|{kind:'resume-pending'}|{kind:'abort-pending'}|{kind:'confirm-block',probes:[SafetyProbe,SafetyProbe,SafetyProbe]}|{kind:'clear-block',removedAt,probes:[CanonicalProbe,CanonicalProbe,CanonicalProbe]},sourceAudit:{revision,digest,observedAt},blockEvidence:null|{zoneId,ruleId,host,verifiedAt,probes:[BlockProbe,BlockProbe,BlockProbe]},incidentUrl,reason}` and the same signed-request envelope. Every request requires an exact DO-state compare, a nonempty HTTPS incident URL/reason, and an operator-attested Firestore audit no older than five minutes (nor future); `apply` additionally requires no pending and a source digest equal to its replacement. `resume-pending`/`abort-pending` require the compared pending to be at least one minute old. Resume requires source audit to equal pending and takes over its stored payload. Only an abort whose source-audit revision and digest exactly equal stored committed may restore that payload; every other abort must first verify an exact-host Cloudflare block, then writes the KV safety-block value instead of restoring a possibly active committed value.

The human recovery command holds a separate 1Password-backed Cloudflare token with only `Zone WAF Edit` and `Account Analytics Read`, resource-limited to the Five Across and Vacay Bingo zones; it has no DNS, Workers, KV, routes, logs, or account-write permission, and no runtime receives it. For each distinct-location block probe, the command reads the exact Ray ID back from Cloudflare's authenticated `firewallEventsAdaptive` API and requires the expected zone, host, rule, `block` action, 403, and exactly one event. That provider-recorded WAF disposition is the complete proof the request terminated before Worker/origin; separate negative log evidence would be retention/sampling-sensitive as well as redundant, so no log backend or credential is part of this contract. The command binds the closed observation and response digest into the recovery signature/history; arbitrary or missing provider events fail before admission. Admission atomically replaces the compared pending with a recovery-owned operation containing the output and exact history record. KV is written, then one transaction commits output/history, clears pending, and retains `safetyBlock` when used. Partial failure leaves the fence resumable. The semantic fingerprint is SHA-256 over every canonical request/evidence field plus operator `sub`, excluding expiring auth/signature envelope; a fresh authenticated signature with the same fingerprint resumes it.

While `safetyBlock` is set, the external rule stops public traffic before the Worker/point lookup. `confirm-block` requires refreshed matching WAF evidence, the exact safety-block revision, and three distinct authenticated regional audit lookups whose expected and observed host, reason, revision, and `servesOrigin:false` agree, then records them and `confirmedAt` atomically. Publisher sync and recovery finalization never clear the latch; canonical `apply` requires that confirmation plus refreshed matching WAF evidence. The external block survives crashes through safety write, DO/history commit, canonical apply, zero-pending audit, and three-region canonical DO/KV convergence. Only then may the operator remove it. `clear-block` requires pending null, source = committed = KV and three distinct public probes whose closed expected/observed host, status, reason, revision, serve, and origin results equal each other and the stored canonical payload; it rejects wrong-phase, stale, or mismatched evidence, records removal, and clears the latch atomically. A crash before removal stays blocked; a crash after removal has already-converged canonical KV/DO and may retry only the history/latch transaction. Recovery history is bounded/auditable and never deletable.

## Provisioning, mutation, and deletion

One transaction helper owns every projected hostname mutation. Current `adultContent` derivation may continue updating its non-projected field without a revision. Any mutation of `eventId`, `status`, `slug`, or `edition`, and any create/delete, must also read the persistent replica ledger, increment its revision, and write the matching desired state in the same transaction. A direct or partial Admin SDK write is a contract violation caught by the audit.

- **Provision:** validate Namespace/Slug/reserved labels; reject any existing hostname or tombstone; create `hostnames/{host}` initially `disabled` and the matching route projection at revision 1. Wait for publisher acceptance and edge inspection before continuing. Activation is a second transaction/revision, and the hostname is not announced until the activation convergence gate passes.
- **Ordinary update:** non-projected fields do not churn the edge. A status or Edition change produces one new revision. An `eventId` or `slug` change while active is rejected.
- **Repoint:** active → disabled and converge; change `eventId`/`slug` while disabled and converge; active and converge. Skipping or combining those barriers is prohibited even though the source writes are transactional. An Edition-only correction need not disable the host, but its manifest cache verification is part of convergence.
- **Disable/archive:** write the inactive status and its revision atomically. Normal completion waits for convergence. If immediate withdrawal is required, install a Cloudflare hostname block first; KV has no promised global convergence bound.
- **Delete:** reject an active delete. After inactive convergence, atomically delete `hostnames/{host}` and advance `routerReplicas/{host}` to `tombstone`. Wait for tombstone convergence. Never delete the ledger or reuse the address.

The first implementation includes a dry-run-by-default backfill/reconciler. It lists with Admin credentials outside the request path, computes the exact projection, creates missing ledgers without changing public documents, and refuses conflicting histories. Its audit mode uses the authenticated point-read wire above to compare canonical host documents, desired-state ledgers, Durable Object committed/pending state, and KV revisions/digests. It reports pending separately from drift and emits counts plus host/revision identifiers but no bearer tokens or credential material. There is deliberately no runtime “ack” write into Firestore: granting the publisher database write permission merely to record its own delivery would undo the IAM narrowing.

## Cache and abuse posture

The resolver calls only the registry service binding's `lookup(host)` method, whose registry implementation performs the exact KV point read. The public router receives no KV namespace binding. Both services remove the current `caches.default` positive envelope and add no application TTL, negative cache, stale-serve cache, or Firestore fallback. KV's own edge caches and eventual propagation remain the single cache layer. A write acknowledgement proves acceptance, not global visibility; operational convergence is established by probes. A region may continue to observe an older accepted revision during propagation, which is why an urgent withdrawal uses the independent Cloudflare block rather than waiting on KV. The existing strict digit parser keeps the lookup timeout at 2,000 ms by default and bounds the service-binding call as one operation.

The Namespace/reserved/Slug guard runs before the service binding, so foreign and structurally invalid traffic costs no registry/KV read. Wildcard zones must have Cloudflare rate-limit/WAF rules for unknown-host floods before a route is attached, plus the reserved-label exclusions already required by `specs/event-router.md`. The registry's public sync/audit/recovery paths enforce exact route/method, content type where applicable, and 2 KiB mutation length before JSON/JWT work; use Cloudflare's per-IP rate-limiting binding for invalid callers; cache valid JWKS by their response policy and cooldown; and never reflect validation details. Rate limits are an abuse signal, not an authentication substitute. Automated DDoS protection and account spend alerts remain enabled.

## Failure semantics

| Condition | Router result | Retry/fallback |
|---|---|---|
| unknown KV key | rendered not-found, `unknown-host` | none |
| valid inactive/tombstone | rendered not-found, `inactive` / `unknown-host` | none |
| recovery safety block | rendered not-found, `safety-block` | external hostname block also remains; never proxy |
| malformed or unsupported replica | rendered not-found, `replica-malformed` | alert; no Firestore |
| Slug mismatch/missing | existing `slug-mismatch` / `slug-missing` | none |
| registry binding absent, or registry/KV lookup rejects/times out | rendered not-found, `lookup-unavailable` | alert; no stale or Firestore fallback |
| `/__/auth/*` on a configured router | preserve the existing lookup bypass and origin pass-through | missing required bindings still fail closed first |
| publisher token rejected | sync `401` | Function throws; token refresh then platform retry |
| publisher body signature rejected | sync `401` | Function throws; no storage write |
| JWKS dependency unavailable for an unknown key | sync `503` | Function throws; platform retry |
| stale/replayed delivery | `200 ignored-stale` / `200 replay` | idempotent success |
| same revision, different payload | sync `409 revision-conflict` | no write; retry plus page |
| future non-successor revision | sync `409 revision-gap` | no write; missing delivery may heal, otherwise page |
| another mutation while publication/recovery is pending | sync/recovery `503 publication-pending` | identical request resumes; others retry after alert/reconciliation |
| audit/recovery caller rejected | `401` | no data/state returned; operator reauthenticates |
| recovery compare/block evidence fails | `409` | no write; repeat audit/block probes before retry |
| recovery takeover before pending is one minute old | `409 pending-not-stale` | wait or use the independent hostname block; never clear the fence |
| origin fetch fails | existing generic `502 origin-unavailable` | unchanged |

Every public response keeps `x-event-router`; fail-closed responses keep a closed `x-event-router-reason`. A resolved edge record also carries `x-event-router-revision`, a validated decimal string, so a probe can name what it observed. It exposes no new secret.

## Observability and operations

Structured logs use closed outcomes and include router/registry version, host, revision when known, lookup/sync latency, KMS key-version identifier, and `applied|replay|ignored-stale|publication-pending|gap|conflict|recovered`; they exclude OIDC tokens, signatures, JWT claims other than the accepted subject identifier, request bodies, Firebase keys, and Event data. Metrics/alerts required before routing are:

- publisher deliveries, signature failures, gaps/conflicts, pending age, retry age, and latency; page on any conflict, pending older than one minute, a gap persisting five minutes, an unexpected recovery, or a retry age over five minutes;
- replica audit counts by missing, mismatched, pending, safety-blocked, and ahead/behind; cutover requires every count to be zero;
- router outcomes and KV latency; page if three consecutive probes of any serving host fail or `lookup-unavailable` exceeds 1% of routed requests for five minutes;
- rate-limit/WAF actions and Workers/KV/DO spend alerts; and
- a synthetic active, inactive, tombstone, and unknown host probe, with alerts carrying hostname, expected revision, observed reason, and router version.

## Rollout, cutover gates, and rollback

These gates insert a registry rung before the PRD's existing Gate 1–3 ladder. Evidence is recorded with the deployed Worker version, source commit, expected revisions, timestamps, probe locations, and App Check enforcement state.

1. **R0 — resources and IAM:** provision the private Firestore collection/rules; separate registry service; point-lookup service binding; publisher, audit, and recovery identities/audiences; distinct dedicated publisher/recovery KMS CryptoKeys; KV namespace; per-host Durable Object migration; rate-limiter; and observability. Verify from IAM policy output that the publisher has only its event/logging requirements plus use-to-sign on its publisher CryptoKey, the recovery identity can use only its recovery CryptoKey, and the audit identity has no data/signing role. Inventory every CryptoKeyVersion: at steady state exactly one publisher version is enabled and allowlisted; during a recorded rotation exactly the current and replacement are enabled and allowlisted until the bounded overlap ends. Verify none of the identities has a user-managed key/Secret Manager/Cloudflare credential, only the registry—not the public router—has KV/DO bindings, and the public Worker has no `FIREBASE_API_KEY`/`FIREBASE_PROJECT_ID` lookup binding.
2. **R1 — backfill and shadow:** deploy publisher, registry, and replica-capable router with wildcard routes still absent. Backfill every serving `hostnames` document. Audit source → ledger → DO/KV at zero missing/mismatch/pending/safety-block/conflict, then exercise active→disabled→active and tombstone synthetic records. Hold 24 hours with zero unexplained drift, no pending older than one minute, no retry older than five minutes, and no conflict.
3. **R2 — failure rehearsal:** automated/deployed checks prove unauthorized/expired/wrong-audience sync, stolen-bearer altered-body refusal, out-of-order/gap/equal-conflict revisions, pending resume/abort before and after KV/commit failure, non-source abort refusal without verified WAF plus safety-tombstone fencing through canonical convergence/unblock, stale/CAS refusal and durable recovery history, non-enumerable public binding, malformed KV, KV/JWKS/origin failures, unknown/inactive/tombstone hosts, auth passthrough, and no Firestore outbound request. Multi-region probes from at least three regions, five passes 30 seconds apart, must observe every serving host's expected revision. This is evidence, not a false global-consistency proof.
4. **R3 — App Check invariant:** enable Firestore App Check enforcement through #44's own monitor/enforce procedure while routes remain grey. Browser resolution, adult-content watch, auth handoff, and Functions pass their enforcement checks. Re-run R2. App Check stays enforced for every later gate.
5. **PRD Gate 1:** direct Hosting, `same_origin`, full real-host game as the PRD specifies.
6. **PRD Gate 2:** direct Hosting, `handoff`, four-platform sign-in matrix. #547 provisioning and #852 acceptance must be complete.
7. **PRD Gate 3:** require #539 reserved-label/DNS work, #546 per-host identity, #852 wildcard sign-in, #960 analytics disposition, #961 cold-client/predeploy check, #888's implementation children, all checks green, zero unresolved review conversations, and a fresh R1/R2 audit. Attach `*.fiveacross.app` only; verify serving/unknown/reserved hosts, deep links, `/__/auth/*`, manifest, service worker, offline cold boot, an already-installed PWA, response revision/version, App Check still enforced, and zero Firestore calls from Worker telemetry. Observe one hour with no alert, then attach and repeat for `*.vacaybingo.com`. Apexes remain direct Hosting.

Rollback one Namespace at a time by removing its Worker route, returning exact/wildcard DNS behavior to Hosting; do not delete KV/DO/ledger state during rollback. A code rollback selects the last known-good **replica-capable** Worker. After R3, the Firestore REST reader is not an allowed rollback. Emergency containment is the per-host Cloudflare block or Namespace route removal. Recovery requires the same revision audit before reattachment.

The PRD's historical Gate 4 redirect is superseded by #599: registered serving hosts serve in place, so no alias-redirect gate is reintroduced here.

## Test seams and acceptance

All platform seams are injected. Tests require no live Google/Cloudflare account unless marked integration.

- Pure schema/hostname/revision parser tables, including decimal precision, reserved/apex cases, Edition validation, extra fields, and payload size.
- Pure OIDC/KMS verifier with injected clock/JWKS fetch/cache/public keys: good request, issuer/audience/subject/algorithm/expiry/signature failures, altered body/path/timestamp, unknown-key refresh cooldown, rotation, unavailable JWKS, and no sensitive log serialization.
- Durable Object storage/KV fakes proving initial 1, successor/equal/lower/gap/conflict, concurrent arrivals, pending admission, KV/final-commit failure, identical resume, conflicts while pending, tombstone non-reuse, and recovery apply/resume/abort with stale/CAS and closed probe-evidence checks (forged/arbitrary Ray ID, missing provider event, wrong phase/host/rule/revision/outcome), safety-tombstone point lookup, fresh-envelope resume, and crashes/retries at block→KV→DO/history→canonical apply→unblock boundaries.
- Publisher fakes proving metadata token audience, exact endpoint/body digest/KMS signing request, non-2xx/invalid-body throw, idempotent retry, stolen-token replay without mutation, and no Admin SDK dependency.
- Firestore emulator tests proving all client access to `routerReplicas` is denied and the trusted transaction helper keeps source/projection atomic across provision, status, repoint, and delete.
- Registry/public-router contract tests proving only `lookup(host)` crosses the service binding, the public router has no KV/list capability, and the registry's `fetch` surface exposes no public point-get/list route. Router tests also prove no Firebase fetch or Cache API envelope, every failure-table row, auth bypass ordering, revision header, and namespace-before-binding ordering.
- Reconciler dry-run/apply/audit fixtures for source-list pagination, point-read auth, zero/one/multiple bounded recovery-history pages, invalid/ahead cursors, missing, drifted, tombstoned, poisoned/conflicting, recovered, and already-correct records.
- Remote integration tests against an unrouted preview, followed by the exact R2 and Gate 3 probes. Tests must assert App Check enforcement stays enabled; disabling it is never test setup.

Acceptance for #888's implementation is all tests above, R0–R3 evidence, removal of the Worker Firestore code/bindings/deploy checks, updated `specs/event-router.md` and `worker/README.md`, and the route block still commented. Route attachment remains #529's separate human Gate 3 action.

## Implementation split

| Ticket | Size | Delivers | Depends on |
|---|---|---|---|
| **A — replicate one synthetic hostname end to end** | L | one deny-all desired-state record triggers the keyless OIDC+KMS publisher, passes the separate registry's contiguous DO fence, reaches KV, and is observable through authenticated audit and private point lookup; includes identity/binding guards, recovery, and tests; no public route | this spec |
| **B — make real hostname lifecycle converge** | M | the atomic mutation helper, revision ledger, provision/update/repoint/delete barriers, dry-run backfill, source-list plus point-audit reconciler, and emulator/integration tests make existing and future hostnames converge through A | A |
| **C — make the unrouted Event router consume the replica** | M | the public router resolves through A's non-enumerable service binding, removes Firestore/Cache API lookup and Firebase bindings, preserves failure/auth/header contracts, and passes full unit/remote tests with routes still absent | A; production rehearsal also needs B backfill |
| **D — prove App Check-on cutover readiness** | S human/ops + tests | provision/verify final IAM and resources, run backfill/audit/recovery and R0–R3 evidence, enable App Check through #44, and prove the unrouted artifact ready without attaching a Namespace | B, C, #44 |

A–C are tracer bullets sized for one implementation context and must share this exact contract rather than invent parallel schemas. D is an operational ticket, not bundled into a code PR, and is not authorized to attach routes. #888 remains the blocker of #529 until A–D and R0–R3 are complete; #529 owns Gate 3 and remains blocked by #888 plus its external prerequisites (#539, #546, #852, #960, and #961).
