---
status: accepted
implemented: false
---

# The Event router reads a server-published edge replica, never Firestore

## Context

The Event router currently point-gets the world-readable `hostnames/{host}` document through the Firestore REST API with the Firebase web API key. That is least-privilege only while Firestore App Check is not enforced: enforcement rejects a request without a valid App Check token even when Security Rules would allow the read. A Cloudflare Worker is not an attested browser or app instance, so manufacturing an App Check token for it would erase the caller property App Check exists to prove.

Giving the Worker a Google service-account credential is not a narrow substitute. Firestore's REST API treats a Google OAuth token as an IAM request which bypasses Security Rules ([Firestore REST authentication](https://firebase.google.com/docs/firestore/use-rest-api)). The permission needed for a point read is `datastore.entities.get`, and Firestore IAM is granted at database/project scope rather than at the `hostnames` collection or a field projection ([Firestore IAM](https://cloud.google.com/firestore/docs/security/iam)). A leaked edge credential could therefore read any known document path in the production database, not only the small public edge projection.

The router is a namespace guard and availability layer, not an authorization layer (ADR 0009). Its decision needs only the already-public routing projection; Gate 3's per-host manifest also needs the public `edition`, and the accepted path-addressing design needs the public root/path-capability fields. The app still resolves the Event independently and every protected data read keeps its own App Check, authentication, and rules boundary.

## Decision

The trusted hostname mutation path publishes a versioned, server-only desired-state document for each hostname in the same Firestore transaction as the public `hostnames/{host}` mutation. An event-driven Cloud Function forwards that projection to a separate Cloudflare registry service. One per-host Durable Object atomically owns the accepted projection, revision fence, minimum publisher epoch, recovery lock, and audit history. The public router has only a service binding exposing one point-lookup method; it has no Durable Object namespace, list method, Firestore call, or Firestore runtime fallback.

The cross-cloud request is authenticated with a short-lived Google-signed OIDC ID token minted by the Function's attached service identity through the metadata server ([Google service identity tokens](https://cloud.google.com/docs/authentication/get-id-token)). Its exact request bytes are also signed by a dedicated asymmetric Cloud KMS key ([`asymmetricSign`](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/asymmetricSign)). Cloudflare accepts only the configured service-account subject, audience, token lifetime, KMS key version, and body signature. A stolen bearer token can replay only the already-signed revision, which is idempotent; it cannot invent a higher revision or payload. There is no downloaded service-account key, shared HMAC secret, Cloudflare API token in Google Secret Manager, or Google credential at Cloudflare.

The Durable Object is also the lookup source. Keeping mutation and lookup in one strongly consistent store makes acknowledged state atomic: there is no eventually consistent pointer or value whose delayed side effect can overwrite a recovery. The trade-off is deliberate. Every cold global lookup travels to that hostname object's location, so the rollout must prove cold/warm multi-colo latency, hibernation/reset behavior, unknown-host flood cost, and fail-closed availability under the router's 2,000 ms bound. The router and registry add no Cache API or negative cache; a cache would reintroduce stale safety state without a compare-and-set invalidation boundary.

[`specs/event-router-registry.md`](../../specs/event-router-registry.md) owns the wire schemas, mutation lifecycle, failure table, operational gates, and implementation seams.

## Why this is least privilege

- The public Worker receives no credential capable of reading Firestore and no App Check bypass. Its service binding can point-get a guessed hostname but cannot enumerate or bind the Durable Object namespace.
- The publisher service account has no Firestore data-plane role. Its trigger receives the desired state in the event payload; its only additional permission is asymmetric signing on one dedicated Cloud KMS CryptoKey. Cloud KMS cannot grant IAM on an individual CryptoKeyVersion, so the registry separately allowlists the selected version and the key keeps only the current rotation set enabled.
- The replica contains only fields already exposed by a public, non-listable Firestore point read and consumed at the edge: the Event route fields, `edition`, and the accepted `root` / `pathNamespace` host capability. It does not copy `canonicalHost`, `preview`, `adultContent`, `apexPath`, membership, Event data, or a hostname catalogue.
- The sync endpoint cannot list or read Firestore, mutate Cloudflare configuration, attach routes, or choose an origin. It can submit only the next schema-validated, identity- and KMS-signed hostname revision.
- A compromised public router can already decide what its wildcard traffic receives, but its point-read binding cannot turn the non-listable hostname registry into a directory. Compromise of the separately deployed registry service is a larger edge-control incident and can enumerate/alter the public projection, but still grants no Firebase data or Cloudflare account-management credential.

## Consequences

- App Check enforcement stays enabled. No rollout or rollback step may weaken it to recover the router.
- Hostname writes become a cross-cloud workflow. Firestore is the source of truth; the private desired-state document and an audit tool make lag and drift observable, while the Durable Object replica is the router's only runtime lookup.
- Activation, repoint, disable, and delete are not complete when the Firestore transaction commits. The operator/provisioner waits for the intended edge revision and the rollout probes required by the spec.
- An acknowledged Durable Object revision is immediately authoritative for later lookups, but an undelivered Firestore event can leave the prior revision serving. It cannot grant Event-data access, and the client re-resolves against Firestore. Emergency takedown therefore uses an exact-host Cloudflare block; Namespace route removal is reserved for a demonstrated fail-closed rollback.
- A compromised publisher runtime can use its intended KMS authority to sign bad contiguous revisions. Drift alerts and a separately authenticated human recovery path bound to a different identity/key are therefore part of the control plane, not optional operations polish. Integrity recovery raises the per-host publisher epoch only after a replacement subject/key unavailable to the quarantined runtime is configured, so its pre-signed higher revisions cannot replay after repair.
- Once Firestore App Check enforcement is a cutover invariant, rolling back means selecting an earlier replica-capable Worker or removing the Worker route. Rolling back to the Firestore REST reader is prohibited.

## Considered alternatives

- **Keep the unauthenticated Firestore REST read and exempt it from App Check**—rejected because it weakens the production data-plane control #44 exists to add.
- **Mint or relay App Check tokens for the Worker**—rejected because the Worker is not a genuine app instance and must not impersonate one.
- **Put a service-account key or OAuth refresh credential in the Worker**—rejected because it bypasses Security Rules, cannot be IAM-scoped to `hostnames/*`, and turns an edge compromise into database read access.
- **Put an authenticated Cloud Function in every lookup path**—rejected because it retains a cross-cloud request, database read, and abuse-amplification cost on cache misses; an outage in either cloud then drains every hostname together.
- **Let the publisher write Workers KV through a Cloudflare API token**—rejected because a long-lived account credential has broader management semantics than an identity-authenticated, schema-limited service endpoint.
- **Use Workers KV behind the point-only service**—rejected because KV has no compare-and-set primitive. A Durable Object can order writes before KV, but a timed-out external write has unknown finality and can overwrite a later recovery; a mutable KV pointer has the same defect. Making lookup consult the Durable Object to validate every KV value removes KV's latency benefit while retaining a second failure surface.
- **Bind the public router directly to a storage namespace**—rejected because a KV or Durable Object namespace binding exposes capabilities beyond one point lookup under the explicitly considered compromised-router threat. A Workers [RPC service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) exposes only the point method.
- **Cache Durable Object lookups at the edge**—rejected because an independently expiring positive cache can outlive disable, recovery-lock, or tombstone state. The direct lookup's multi-colo latency/availability cost is accepted and measured before cutover rather than hidden behind an unsound invalidation promise.
