---
status: accepted
implemented: true
---

# The Event is resolved from the hostname through a world-readable `hostnames/{host}` lookup

> **Implemented in #542 (rules) and #543 (resolver).** A multi-Event build resolves its Event from `window.location.hostname` before first paint; a single-Event build still uses build-time `VITE_EVENT_ID` for routing and does not consult the lookup for Event identity. Every build shape may still read and watch its hostname document for the server-derived 18+ posture (ADR 0012). The membership gate referred to below remains a target contract, not a property of the current rules.

`EVENT_ID` was a build-time constant (`src/firebase.ts`), so one bundle served exactly one Event. Serving many Events from wildcard subdomains means resolving the Event **before** the app has an authenticated user—which rules out reading the Event doc itself, since that read requires `signedIn()`. The decision is a deliberately **world-readable** `hostnames/{host}` collection: one document per public address, holding `eventId`, `canonicalHost`, `edition`, and `status`. Keying by full hostname (rather than by Slug) makes the PRD's "exactly one canonical hostname, plus validated aliases" directly representable—`bodega-bay.vacaybingo.com` and `bodega-bay.fiveacrossbingo.com` are two documents pointing at one Event, the alias naming its canonical—and gives the edge Worker and client one server-backed mapping to revalidate against.

A world-readable collection in an app whose intended posture is membership isolation looks wrong until you know that **a Slug is not a secret**. Knowing an address grants nothing; after membership enforcement lands, every read of Event data must still pass that gate.

## Considered options

- **Static slug→ID map compiled into the bundle**—rejected: every new Event would need a code edit and redeploy, which is precisely what "make event addresses automatic" forbids.
- **Worker injects the Event ID into the served HTML**—rejected: it makes the Worker an authority rather than a router, and the app can no longer boot on the direct-to-Hosting fallback path.
- **Slug-keyed rather than hostname-keyed**—rejected: the client would have to duplicate the Worker's namespace rules to know whether it is on a valid alias.
- **A path prefix on one shared origin (`fiveacross.app/<slug>`)**—rejected: it trades a bounded one-time build for a permanent ceiling on installed-PWA isolation. Reasoning below, because this is the option a future reader is most likely to re-open.

## Why not one origin with a path prefix

Addressing Events by path rather than by subdomain is genuinely attractive for one reason, and it is not the URL: it would make [ADR 0010](0010-centralised-auth-origin-with-handoff.md) unnecessary. Google's exact-redirect-URI rule stops binding when there is one origin per Namespace instead of one per Event, so the central auth origin, the `authHandoffs` collection, the transactional consuming Function, and the four-platform verification all evaporate. That is real work avoided, and the client-side churn on the other side of the ledger is small—a `BrowserRouter` `basename`, the wildcard fallback in `src/App.tsx`, the NavLink table, and a sweep of prefix-unaware absolute URLs. Routing churn was never the deciding cost.

What decides it is that **the parts of installed-app isolation that matter here are properties of the origin, and the browser grants them per origin or not at all.** On one origin, every Event shares cookies, `localStorage`, IndexedDB, and Cache Storage with no browser-enforced boundary between them; they share one storage quota, so eviction crosses Event boundaries; the browser's own site-data clearing is all-or-nothing, so a guest who clears data for one Event clears every Event on that origin; and permissions are origin-scoped, so a camera denial at one Event denies proof capture at every Event on that origin ([web.dev, on hosting multiple PWAs per domain](https://web.dev/articles/building-multiple-pwas-on-the-same-domain), which ranks separate origins first and same-origin nested paths last). Three of those land on this app rather than on a generic PWA: it is offline-first by design ([ADR 0006](0006-offline-resilience.md), `specs/x-offline-cold-boot.md`, the durable card cache), proof capture needs the camera, and an app carrying photo proof and an 18+ posture has to be able to express "delete my data for this Event."

Be precise about which of those application code can buy back, because overstating it is how a rejected option gets re-proposed on a technicality. **Per-Event deletion is implementable**—`localStorage` keys, IndexedDB databases, and Cache Storage caches can all be namespaced by Event and selectively removed, and this repo already keys durable snapshots that way—so an in-app "delete my data for this Event" survives the move to one origin at the cost of building and maintaining that partitioning. What does not survive is anything the browser arbitrates rather than the app: the shared quota and its cross-Event eviction, the origin-scoped permission grants, the absence of a security boundary, and the guest-initiated site-data clear that the app never sees. Those are the ceilings.

Two mitigations exist and are worth naming so they are not mistaken for a way out. The manifest `id` member does distinguish multiple web apps under one domain (WWDC23, "What's new in web apps"), so per-Event home-screen icons are achievable—but `id` is install *identity*, and whether a given platform also gives same-origin installed web apps separate data containers is **not established here**: WWDC23 states only that a Home Screen web app has separate cookies and storage from the browser, and reports of same-origin WebClips sharing one service worker registration and storage point the other way. Treat per-app storage separation on iOS as unverified rather than as either a mitigation or a settled impossibility; the quota and permission ceilings above hold regardless of how it resolves. The other mitigation is real: the nested-install breakage—suppressed install banners, no `beforeinstallprompt`—is avoidable by never making the origin root installable.

So the handoff is the cheaper side: bounded work whose cost does not grow with the number of Events, against a ceiling that never rises.

## What shipped

`firestore.rules` carries the `get`-yes / `list`-no grant with every write denied (`specs/hostnames-lookup.md`). `src/eventResolution.ts` holds the pure decision table, `src/data/hostnames.ts` the Firestore seam, and `src/main.tsx` awaits resolution before mounting, so listeners never start against the wrong Event and a hostname that resolves to nothing renders `EventNotFound` instead of the app.

Four refinements the review surfaced, each stated because the naive version is tempting:

- **A single-Event build never consults the lookup for Event identity.** `VITE_EVENT_ID`'s presence means the bundle already knows which Event it serves, so startup routing short-circuits. The independent 18+ watcher may still consult `hostnames/{host}` after that short-circuit because a build-time non-adult seed must observe a later server-side raise (ADR 0012).
- **The cache is bounded, not permanent.** A hostname's Event assignment is durable, which is why caching is safe at all, but an unbounded cache would keep a browser booting an *archived* Event forever.
- **Revalidation must reach the server to count.** The seam uses `getDocFromServer`, not `getDoc`. A plain `getDoc` may answer from Firestore's own cache, so an offline or captive client would read a stale mapping, treat it as a successful revalidation, and restamp the entry for another full TTL—a bound that renews itself is not a bound.
- **Status must be explicit.** A routing document with no recognised `status` is not servable. Defaulting a missing field to active would let a half-written document publish an Event before the record opts in.

## The cache, precisely

`localStorage`, keyed by hostname (not by Slug: two hostnames can resolve to one Event, and a shared key would let an alias serve the canonical's cached Edition on the wrong origin). Each entry is an envelope carrying a schema version and `fetchedAt`; a version mismatch reads as a miss rather than being coerced.

- A **fresh** entry—inside the 12-hour TTL and `status: 'active'`—selects the Event outright, with no network read when its cached adult posture is `true`. A cached `adultContent: false` is not current proof and forces a bounded revalidation before it may un-gate; if that revalidation fails, Event identity may still come from the cache but the posture becomes gated. This preserves offline cold boot (ADR 0006) without letting a stale opt-out expose newly approved explicit content (ADR 0012).
- A **stale** entry triggers a server revalidation. If the mapping changed, the new one wins and is restamped. If the mapping is **gone or inactive**, the entry is dropped outright—not merely expired—so the browser stops serving that Event immediately.
- If revalidation **fails**, a stale-but-active entry still serves, without restamping. An expired mapping beats a dead app when the network is simply unreachable; it just stops counting as evidence the mapping is still good.

## Consequences

- Rules are `allow get: if true; allow list: if false`—resolvable, never enumerable.
- `edition` on this document brands the **pre-auth shell** (`src/editions.ts`): the signed-out gate's wordmark, its one-line description, and its offline note. This is the surface that most needs it and the one an Event-doc answer arrives too late for—`events/{eventId}` requires `signedIn()`, so the Event doc cannot brand the screen whose job is to get you signed in.
- `adultContent` on the same document is a server-derived, monotone pre-auth posture, not routing identity and not client-owned configuration. ADR 0012 owns its derivation, fail direction, and live watcher.
- The same table brands the **browser chrome** (#586)—document title, iOS home-screen label, PWA manifest names—but only a single-Event build can bake it, because `index.html` and the manifest are built once and the lookup answers per hostname. A hostname-resolved build corrects the title and the iOS label in the DOM after resolution and takes its manifest from the edge Worker (#546); the manifest is fetched as a file at install time, so it is the one part of the identity resolution cannot repair on its own.
- The not-found branch renders the analytics disclosure alongside it. Analytics initialise at module scope, before resolution, so a visitor who never reaches the app has still been counted.
- Renaming a Slug means repointing documents and deciding a redirect policy; addresses are durable by default.
