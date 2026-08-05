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

## Implementation status

Implemented as of #542 (rules) and #543 (resolver). `firestore.rules` carries the `get`-yes / `list`-no grant with writes denied; `src/eventResolution.ts` holds the pure decision table, `src/data/hostnames.ts` the Firestore seam, and `src/main.tsx` awaits resolution before mounting so listeners never start against the wrong Event.

Two refinements the review surfaced, both worth stating because the naive version of each is tempting:

- **A single-Event build never consults the lookup at all.** `VITE_EVENT_ID`'s presence means the bundle serves exactly one Event, so reading the mapping and discarding the answer would be incoherent — and since resolution gates first paint, it would cost the legacy build a round trip it cannot use, or the full timeout on captive Wi-Fi.
- **The cache is bounded, not permanent.** A hostname's Event assignment is durable, which is why caching is safe at all, but an unbounded cache would keep a browser booting an *archived* Event forever. Entries carry a schema version and a fetch stamp, expire after 12 hours, and are dropped outright when the mapping is removed or goes inactive. A stale entry still serves when revalidation fails — offline beats dead — but never survives a mapping that has actually gone away.

## Consequences

- Rules will be `allow get: if true; allow list: if false` — resolvable, never enumerable.
- The result will be cached in localStorage keyed by hostname **only as a bounded bootstrap hint**. Each entry carries a cache-schema version and `fetchedAt`; it can hydrate neutral shell copy for at most five minutes while the client revalidates with a server read. A cached mapping must never select an Event, subscribe to its data, or start sign-in until that revalidation succeeds. If the server mapping differs (including status or canonical host), the client discards the entry and follows the current mapping; if it cannot revalidate an expired entry, it shows a recoverable unavailable state rather than opening an old Event. This keeps the cache from becoming an indefinitely authoritative router while avoiding a blank first paint.
- `edition` on this document will let the **sign-in screen** show edition-correct copy — the one surface that most needs it and that an Event-doc-based answer arrives too late for.
- Renaming a Slug means repointing documents and deciding a redirect policy; addresses are durable by default.
