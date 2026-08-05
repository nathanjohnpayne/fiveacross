---
status: accepted
implemented: false
---

# The Event is resolved from the hostname through a world-readable `hostnames/{host}` lookup

> **Decision accepted; resolver, rules, and cache are not yet implemented.** The current bundle still uses build-time `VITE_EVENT_ID`; it has no `hostnames/{host}` lookup, canonical-host field, or routing cache. The membership gate described below is likewise a target contract, not a property of the current rules.

`EVENT_ID` is currently a build-time constant (`src/firebase.ts`), so one bundle serves exactly one Event. Serving many Events from wildcard subdomains will require resolving the Event **before** the app has an authenticated user — which rules out reading the Event doc itself once that read requires `signedIn()`. The implementation will introduce a deliberately **world-readable** `hostnames/{host}` collection: one document per public address, holding `eventId`, `canonicalHost`, `edition`, and `status`. Keying by full hostname (rather than by Slug) makes the PRD's "exactly one canonical hostname, plus validated aliases" directly representable — `bodega-bay.vacaybingo.com` and `bodega-bay.fiveacrossbingo.com` are two documents pointing at one Event, the alias naming its canonical — and gives the edge Worker and client one server-backed mapping to revalidate against.

A world-readable collection in an app whose intended posture is membership isolation looks wrong until you know that **a Slug is not a secret**. Knowing an address grants nothing; after membership enforcement lands, every read of Event data must still pass that gate.

## Considered options

- **Static slug→ID map compiled into the bundle** — rejected: every new Event would need a code edit and redeploy, which is precisely what "make event addresses automatic" forbids.
- **Worker injects the Event ID into the served HTML** — rejected: it makes the Worker an authority rather than a router, and the app can no longer boot on the direct-to-Hosting fallback path.
- **Slug-keyed rather than hostname-keyed** — rejected: the client would have to duplicate the Worker's namespace rules to know whether it is on a valid alias.

## Consequences

- Rules will be `allow get: if true; allow list: if false` — resolvable, never enumerable.
- The result will be cached in localStorage keyed by hostname **only as a bounded bootstrap hint**. Each entry carries a cache-schema version and `fetchedAt`; it can hydrate neutral shell copy for at most five minutes while the client revalidates with a server read. A cached mapping must never select an Event, subscribe to its data, or start sign-in until that revalidation succeeds. If the server mapping differs (including status or canonical host), the client discards the entry and follows the current mapping; if it cannot revalidate an expired entry, it shows a recoverable unavailable state rather than opening an old Event. This keeps the cache from becoming an indefinitely authoritative router while avoiding a blank first paint.
- `edition` on this document will let the **sign-in screen** show edition-correct copy — the one surface that most needs it and that an Event-doc-based answer arrives too late for.
- Renaming a Slug means repointing documents and deciding a redirect policy; addresses are durable by default.
