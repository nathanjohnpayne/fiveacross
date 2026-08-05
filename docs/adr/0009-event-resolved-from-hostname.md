---
status: accepted
implemented: true
---

# The Event is resolved from the hostname through a world-readable `hostnames/{host}` lookup

> **Implemented in #542 (rules) and #543 (resolver).** A multi-Event build resolves its Event from `window.location.hostname` before first paint; a single-Event build still uses build-time `VITE_EVENT_ID` and never consults the lookup. The membership gate referred to below remains a target contract, not a property of the current rules.

`EVENT_ID` was a build-time constant (`src/firebase.ts`), so one bundle served exactly one Event. Serving many Events from wildcard subdomains means resolving the Event **before** the app has an authenticated user — which rules out reading the Event doc itself, since that read requires `signedIn()`. The decision is a deliberately **world-readable** `hostnames/{host}` collection: one document per public address, holding `eventId`, `canonicalHost`, `edition`, and `status`. Keying by full hostname (rather than by Slug) makes the PRD's "exactly one canonical hostname, plus validated aliases" directly representable — `bodega-bay.vacaybingo.com` and `bodega-bay.fiveacrossbingo.com` are two documents pointing at one Event, the alias naming its canonical — and gives the edge Worker and client one server-backed mapping to revalidate against.

A world-readable collection in an app whose intended posture is membership isolation looks wrong until you know that **a Slug is not a secret**. Knowing an address grants nothing; after membership enforcement lands, every read of Event data must still pass that gate.

## Considered options

- **Static slug→ID map compiled into the bundle** — rejected: every new Event would need a code edit and redeploy, which is precisely what "make event addresses automatic" forbids.
- **Worker injects the Event ID into the served HTML** — rejected: it makes the Worker an authority rather than a router, and the app can no longer boot on the direct-to-Hosting fallback path.
- **Slug-keyed rather than hostname-keyed** — rejected: the client would have to duplicate the Worker's namespace rules to know whether it is on a valid alias.

## What shipped

`firestore.rules` carries the `get`-yes / `list`-no grant with every write denied (`specs/hostnames-lookup.md`). `src/eventResolution.ts` holds the pure decision table, `src/data/hostnames.ts` the Firestore seam, and `src/main.tsx` awaits resolution before mounting, so listeners never start against the wrong Event and a hostname that resolves to nothing renders `EventNotFound` instead of the app.

Four refinements the review surfaced, each stated because the naive version is tempting:

- **A single-Event build never consults the lookup at all.** `VITE_EVENT_ID`'s presence means the bundle serves exactly one Event, so reading the mapping and discarding the answer would be incoherent — and since resolution gates first paint, it would cost the legacy build a round trip it cannot use, or the full timeout on captive Wi-Fi.
- **The cache is bounded, not permanent.** A hostname's Event assignment is durable, which is why caching is safe at all, but an unbounded cache would keep a browser booting an *archived* Event forever.
- **Revalidation must reach the server to count.** The seam uses `getDocFromServer`, not `getDoc`. A plain `getDoc` may answer from Firestore's own cache, so an offline or captive client would read a stale mapping, treat it as a successful revalidation, and restamp the entry for another full TTL — a bound that renews itself is not a bound.
- **Status must be explicit.** A routing document with no recognised `status` is not servable. Defaulting a missing field to active would let a half-written document publish an Event before the record opts in.

## The cache, precisely

`localStorage`, keyed by hostname (not by Slug: two hostnames can resolve to one Event, and a shared key would let an alias serve the canonical's cached Edition on the wrong origin). Each entry is an envelope carrying a schema version and `fetchedAt`; a version mismatch reads as a miss rather than being coerced.

- A **fresh** entry — inside the 12-hour TTL and `status: 'active'` — selects the Event outright, with no network read. This is what makes offline cold boot work (ADR 0006), and it is a deliberate reversal of this ADR's original draft, which said a cached mapping must never select an Event and capped the hint at five minutes. That design paid a mandatory round trip on every boot to protect against a change that is rare by construction, and it could not survive the offline case this app exists to handle.
- A **stale** entry triggers a server revalidation. If the mapping changed, the new one wins and is restamped. If the mapping is **gone or inactive**, the entry is dropped outright — not merely expired — so the browser stops serving that Event immediately.
- If revalidation **fails**, a stale-but-active entry still serves, without restamping. An expired mapping beats a dead app when the network is simply unreachable; it just stops counting as evidence the mapping is still good.

## Consequences

- Rules are `allow get: if true; allow list: if false` — resolvable, never enumerable.
- `edition` on this document brands the **pre-auth shell** (`src/editions.ts`): the signed-out gate's wordmark, its one-line description, and its offline note. This is the surface that most needs it and the one an Event-doc answer arrives too late for — `events/{eventId}` requires `signedIn()`, so the Event doc cannot brand the screen whose job is to get you signed in.
- The not-found branch renders the analytics disclosure alongside it. Analytics initialise at module scope, before resolution, so a visitor who never reaches the app has still been counted.
- Renaming a Slug means repointing documents and deciding a redirect policy; addresses are durable by default.
