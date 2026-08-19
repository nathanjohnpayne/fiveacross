---
status: accepted
implemented: false
---

# The Event router reads a server-published edge replica, never Firestore

## Context

The Event router currently point-gets the world-readable `hostnames/{host}` document through the Firestore REST API with the Firebase web API key. That is least-privilege only while Firestore App Check is not enforced: enforcement rejects a request without a valid App Check token even when Security Rules would allow the read. A Cloudflare Worker is not an attested browser or app instance, so manufacturing an App Check token for it would erase the caller property App Check exists to prove.

Giving the Worker a Google service-account credential is not a narrow substitute. Firestore's REST API treats a Google OAuth token as an IAM request which bypasses Security Rules ([Firestore REST authentication](https://firebase.google.com/docs/firestore/use-rest-api)). The permission needed for a point read is `datastore.entities.get`, and Firestore IAM is granted at database/project scope rather than at the `hostnames` collection or a field projection ([Firestore IAM](https://cloud.google.com/firestore/docs/security/iam)). A leaked edge credential could therefore read any known document path in the production database, not only the small public edge projection.

The router is a namespace guard and availability layer, not an authorization layer (ADR 0009). Its decision needs only the already-public routing projection; Gate 3's per-host manifest also needs the public `edition`. The app still resolves the Event independently and every protected data read keeps its own App Check, authentication, and rules boundary.

## Decision

The trusted hostname mutation path publishes a versioned, server-only desired-state document for each hostname in the same Firestore transaction as the public `hostnames/{host}` mutation. An event-driven Cloud Function forwards that projection to a separate Cloudflare registry service. The registry serializes contiguous revisions for one hostname through a per-host Durable Object and stores the accepted projection in Workers KV. The public router has only a service binding exposing one point-lookup method; it has no KV binding, list method, Firestore call, or Firestore runtime fallback.

The cross-cloud request is authenticated with a short-lived Google-signed OIDC ID token minted by the Function's attached service identity through the metadata server ([Google service identity tokens](https://cloud.google.com/docs/authentication/get-id-token)). Its exact request bytes are also signed by a dedicated asymmetric Cloud KMS key. Cloudflare accepts only the configured service-account subject, audience, token lifetime, KMS key version, and body signature. A stolen bearer token can replay only the already-signed revision, which is idempotent; it cannot invent a higher revision or payload. There is no downloaded service-account key, shared HMAC secret, Cloudflare API token in Google Secret Manager, or Google credential at Cloudflare.

Workers KV is selected behind the private registry service because this is a global, read-heavy, small-value projection. KV is eventually consistent and writes can take 60 seconds or more to become visible elsewhere ([KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)); that is an explicit availability trade-off, not an authorization claim. A Durable Object is used only on the write path to require the exact successor revision and reject out-of-order deliveries and same-revision conflicts. The router adds no Cache API layer on top of KV, so it does not extend KV staleness with another independent TTL.

[`specs/event-router-registry.md`](../../specs/event-router-registry.md) owns the wire schemas, mutation lifecycle, failure table, operational gates, and implementation seams.

## Why this is least privilege

- The public Worker receives no credential capable of reading Firestore and no App Check bypass. Its service binding can point-get a guessed hostname but cannot enumerate the KV namespace.
- The publisher service account has no Firestore data-plane role. Its trigger receives the desired state in the event payload; its only additional permission is asymmetric signing on one Cloud KMS key version.
- The replica contains only fields already exposed by a public, non-listable Firestore point read and consumed at the edge: `eventId`, `status`, `slug`, and `edition`. It does not copy `canonicalHost`, `preview`, `adultContent`, membership, Event data, or a hostname catalogue.
- The sync endpoint cannot list or read Firestore, mutate Cloudflare configuration, attach routes, or choose an origin. It can submit only the next schema-validated, identity- and KMS-signed hostname revision.
- A compromised public router can already decide what its wildcard traffic receives, but its point-read binding cannot turn the non-listable hostname registry into a directory. Compromise of the separately deployed registry service is a larger edge-control incident and can enumerate/alter the public projection, but still grants no Firebase data or Cloudflare account-management credential.

## Consequences

- App Check enforcement stays enabled. No rollout or rollback step may weaken it to recover the router.
- Hostname writes become a cross-store workflow. Firestore is the source of truth; the private desired-state document and an audit tool make lag and drift observable, while the edge replica is the router's only runtime lookup.
- Activation, repoint, disable, and delete are not complete when the Firestore transaction commits. The operator/provisioner waits for the intended edge revision and the rollout probes required by the spec.
- A stale edge replica may briefly serve the generic shell after a hostname is disabled. It cannot grant Event-data access, and the client re-resolves against Firestore. Emergency takedown therefore uses a Cloudflare hostname block or route removal, whose convergence is independent of KV.
- A compromised publisher runtime can use its intended KMS authority to sign bad contiguous revisions. Drift alerts and a separately authenticated human recovery path bound to a different identity/key are therefore part of the control plane, not optional operations polish.
- Once Firestore App Check enforcement is a cutover invariant, rolling back means selecting an earlier replica-capable Worker or removing the Worker route. Rolling back to the Firestore REST reader is prohibited.

## Considered alternatives

- **Keep the unauthenticated Firestore REST read and exempt it from App Check**—rejected because it weakens the production data-plane control #44 exists to add.
- **Mint or relay App Check tokens for the Worker**—rejected because the Worker is not a genuine app instance and must not impersonate one.
- **Put a service-account key or OAuth refresh credential in the Worker**—rejected because it bypasses Security Rules, cannot be IAM-scoped to `hostnames/*`, and turns an edge compromise into database read access.
- **Put an authenticated Cloud Function in every lookup path**—rejected because it retains a cross-cloud request, database read, and abuse-amplification cost on cache misses; an outage in either cloud then drains every hostname together.
- **Let the publisher write Workers KV through a Cloudflare API token**—rejected because a long-lived account credential has broader management semantics than an identity-authenticated, schema-limited service endpoint.
- **Bind the public router directly to KV**—rejected because a KV binding exposes `list()` as well as `get()`, violating the hostname registry's point-get/non-enumeration boundary under the explicitly considered compromised-router threat.
- **Write KV directly from unordered Firestore trigger deliveries**—rejected because retries and out-of-order delivery can resurrect an older active mapping. KV provides no compare-and-set primitive for this fence.
- **Use a Durable Object for every public lookup**—rejected for now because it makes every cold global request travel to one object's location. The per-host object is retained where strong ordering is required: the low-volume write path.
