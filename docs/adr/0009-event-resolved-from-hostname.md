---
status: accepted
---

# The Event is resolved from the hostname through a world-readable `hostnames/{host}` lookup

`EVENT_ID` was a build-time constant (`src/firebase.ts`), so one bundle served exactly one Event. Serving many Events from wildcard subdomains means resolving the Event **before** the app has an authenticated user — which rules out reading the Event doc itself, since that read requires `signedIn()`. We therefore introduce a deliberately **world-readable** `hostnames/{host}` collection: one document per public address, holding `eventId`, `canonicalHost`, `edition`, and `status`. Keying by full hostname (rather than by Slug) makes the PRD's "exactly one canonical hostname, plus validated aliases" directly representable — `bodega-bay.vacaybingo.com` and `bodega-bay.fiveacrossbingo.com` are two documents pointing at one Event, the alias naming its canonical — and lets the edge Worker and the client consult the *same* collection, so they can never disagree about what an address means.

A world-readable collection in an app whose whole posture is membership isolation looks wrong until you know that **a Slug is not a secret**. Knowing an address grants nothing; every read of Event data still passes the membership gate.

## Considered options

- **Static slug→ID map compiled into the bundle** — rejected: every new Event would need a code edit and redeploy, which is precisely what "make event addresses automatic" forbids.
- **Worker injects the Event ID into the served HTML** — rejected: it makes the Worker an authority rather than a router, and the app can no longer boot on the direct-to-Hosting fallback path.
- **Slug-keyed rather than hostname-keyed** — rejected: the client would have to duplicate the Worker's namespace rules to know whether it is on a valid alias.

## Consequences

- Rules are `allow get: if true; allow list: if false` — resolvable, never enumerable.
- The result is **cached in localStorage keyed by hostname**. An uncached blocking network read before first paint is the blank-screen class this repo already shipped three fixes for; the cache is load-bearing, not an optimisation.
- `edition` riding on this document is what lets the **sign-in screen** show edition-correct copy — the one surface that most needs it and that an Event-doc-based answer arrives too late for.
- Renaming a Slug means repointing documents and deciding a redirect policy; addresses are durable by default.
