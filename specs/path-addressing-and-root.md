---
spec_id: path-addressing-and-root
status: accepted
tested: false
reason: Design-only — decides the three addressing regimes, the root's shape per host class, and the archive interlock on paper; no runtime surface ships from this spec, and each seam's tests land with the implementation ticket that builds it (see § Test coverage).
---

# Path addressing and the root—historical Events, brand-mirror slugs, and what serves `/` (`path-addressing-and-root`)

Three accepted decisions have to compose here, and each was correct inside the scope it was written for. [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md) rejected addressing Events by path on one shared origin. [#625](https://github.com/nathanjohnpayne/gaycruisebingo/issues/625), as generalised by [#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599), made every registered domain a first-class serving host that never bounces a visitor off itself. And the platform PRD makes self-service Event creation a Phase 5 goal, which gives the canonical root a job it did not have when ADR 0009 was written. This spec decides how the three fit together, because the answer is not one policy: **path addressing is rejected for one class of Event and required for another**, and getting that boundary wrong in two separate designs is the drift [#799](https://github.com/nathanjohnpayne/gaycruisebingo/issues/799) exists to prevent.

Nothing ships from this spec. It answers the nine questions #799 enumerates as decisions, states the reserved-path list, the non-installability requirement and the #134 archive interlock as requirements rather than open questions, and names the seams the implementation tickets get filed from. It supersedes, in part, `specs/x-multi-event-schema.md` § "Recommended migration seam (deferred)", which still recommends the opposite; ADR 0009 carries a matching scope note.

## Glossary

**Addressing regime**—the rule pairing a class of serving host with the way an Event is named on it. There are exactly three (§ The three regimes), and they differ in capability, not only in URL shape. *Avoid:* routing mode, URL scheme.

**Path-addressed surface**—a rendering of an Event reached as `<host>/<slug>` rather than as `<slug>.<namespace>`. Deliberately a **narrower** way to reach the same `eventId`, never an alias of the subdomain's capability set. *Avoid:* path alias, mirror route.

**Canonical apex**—`fiveacross.app`: the platform's own address, and also a namespace apex. **Namespace apex**—an apex under which Event subdomains are issued (`fiveacross.app`, `vacaybingo.com`). **Edition apex**—an apex that brands one Edition and issues no Event subdomains (`gaycruisebingo.com`). **Brand mirror**—one of the three `*.vercel.app` backup hosts (`gaycruisebingo.vercel.app`, `fiveacross.vercel.app`, `vacaybingo.vercel.app`, `src/auth-domain.ts`). *Avoid:* "the apex" unqualified—three different host classes answer `/` differently.

**Root marker**—a `hostnames/{host}` document that names no Event, so the host serves a doorway rather than a game. The third resolution outcome, beside `event` and `not-found`. *Avoid:* landing page (that is what it renders, not what it is).

**Doorway**—what a root marker renders: the host's Edition brand plus, where the host class allows it, the create-Event affordance. *Avoid:* home page (every Event's Card tab is also `/`).

## The three regimes

One table rather than scattered prose, because the whole point of folding #766 and #626 into one design is that a later implementer must not be able to miss that these differ.

| | **(a) Live subdomain** | **(b) Archived apex path** | **(c) Mirror path** |
|---|---|---|---|
| Address | `<slug>.fiveacross.app`, `<slug>.vacaybingo.com` | `fiveacross.app/<slug>`, `vacaybingo.com/<slug>` | `fiveacross.vercel.app/<slug>`, and the other two mirrors |
| What `/` serves on that host | the Event itself | the doorway (D1) | **the host's flagship Event** (#625, unchanged)—served, but no longer installable (D4) |
| Governing decision | ADR 0009, unchanged | #766, new here | #626, new here |
| Why this regime | Subdomains are purchasable—a DNS record we control—and only a separate origin buys installed-app isolation | The root is wanted for creation, and an archive has no isolation left to protect | `<slug>.<project>.vercel.app` is Vercel's namespace, not ours; paths are the *only* mechanism, not the cheaper one |
| Router `basename` | none | `/<slug>` | `/<slug>` |
| Installable | **yes** | **no** (§ Non-installability) | **no** (§ Non-installability) |
| Manifest served | yes, per-host (#546) | **never at the path** | **never at the path** |
| Service-worker scope | origin root | must not claim the path (§ Non-installability) | must not claim the path; existing root workers force-retired before paths go live |
| Origin installable at all | yes | **no**—whole origin | **no**—whole origin, flagship included (D4) |
| Offline cold boot | yes (ADR 0006) | no | no |
| Camera / proof capture | yes | **no**—read-only | yes, with the origin-shared grant accepted explicitly (D2) |
| Event lifecycle admitted | `active` only | `active` (migration window) and `archived`—**and only with `apexPath` set on the target** (D8) | `active` and `archived`, namespace-wide (no per-Event opt-in) |
| Durable caching | yes | **must be disabled** (D4) | permitted, namespacing required (D4) |
| Share URL composed as | this origin, no prefix | this origin **plus** `/<slug>` | this origin **plus** `/<slug>` |
| Analytics host dimension | the Event's canonical host | the Event's canonical host | the Event's canonical host |
| Sign-in reachable | yes | **only once the apex is registered**—`vacaybingo.com` is not yet (D7) | yes—all three mirrors are already first-party (D7) |
| Namespaces in play | all | `fiveacross.app`, `vacaybingo.com` | `fiveacross.vercel.app`, `vacaybingo.vercel.app` only—**not** the GCB mirror (D3) |

The single sentence a reader should leave with: **(a) is the full product; (b) and (c) are narrower reaches at the same `eventId`, and the narrowing is the reason they are allowed to exist on a shared origin at all.**

## Binding constraints this spec designs against

Restated rather than re-litigated, because every decision below is shaped by them.

- **Every serving host serves in place.** #625's mirror-only rule ("the backup must work precisely when the canonical host is blocked"), generalised by #599's 2026-08-05 amendment to the whole system. **A path-addressed archive or mirror-host Event must never HTTP-redirect to a subdomain**, and no domain that legitimately serves is ever bounced off itself.
- **A slug is not a secret**—but be precise about what backs that today, because an archive implementer who over-reads it will assume an isolation that does not exist. `specs/hostnames-lookup.md` says knowing an address grants nothing "because every read of Event data still passes the membership gate," and ADR 0009 is explicit that the gate "remains a target contract, not a property of the current rules." **Today reads are only SIGN-IN-gated:** any signed-in account can read most data under any Event, per `specs/x-multi-event-schema.md`'s honest inventory, and the tenant-isolation workstream that would change this has not landed. Path addressing neither widens nor narrows that—it changes which URL reaches a document, not who may read it—and `/bodega-bay` in a URL bar still discloses nothing `hostnames/{host}` does not already. But **any member-only guarantee about an archive depends on the tenant-isolation workstream, not on this spec**, and must not be claimed before it ships.
- **Fail closed on unknown Events.** `specs/event-resolution.md`'s decision table: not-found is a state the app draws, never inferred-active. An unrecognised path segment gets the same discipline, and it gets it *before* the router exists.
- **Gay Cruise Bingo is not sanitised by universalisation.** The platform PRD § Launch Edition is explicit: "No universalization task should silently sanitize or overwrite the Gay Cruise Bingo edition." D1 is written to that.

## Decisions

Each decision answers one of #799's nine questions. Acceptance criteria for all nine are collected in § Acceptance criteria, keyed `D1`–`D9`, so a reviewer can check the list off directly.

### D1 — What renders at `/`, per host class

`/` is answered by host class, not by one rule.

- **Canonical apex (`fiveacross.app`)** renders the platform doorway: the `fiveacross` brand and the create-Event affordance (D9 decides that affordance's state today). This is the change #766 asked for.
- **Namespace and Edition apexes (`vacaybingo.com`, `gaycruisebingo.com`)** render **that Edition's own doorway**, not the platform create page. GCB's apex keeps its cruise-specific doorway; a create affordance is not added there. Creation is a platform act performed at the platform's address, and putting it on an Edition apex would be exactly the silent overwrite the PRD forbids. `vacaybingo.com` is the same shape for the same reason, minus the preservation clause.
- **Brand mirrors keep serving their flagship Event at `/`, and get no doorway at all.** This is #625's shipped behaviour and it is deliberately not disturbed: `hostnames/vacaybingo.vercel.app` names an Event, and the mirror exists so that a Player whose canonical host is blocked still lands *in the game* rather than on a page about the platform. A doorway there would answer the emergency with a form. Path addressing on a mirror is therefore purely **additive**—`/` keeps its flagship, `/<slug>` reaches any other Event in the mirrored namespace—and the create affordance never appears on a mirror in either position, because starting a permanent, slug-claiming act from a backup surface adds a failure mode to the surface whose whole job is to have fewer of them.

**The root is a resolution outcome, not a hardcoded route.** A host serving a doorway carries a **root marker**: a `hostnames/{host}` document with no `eventId`, carrying `edition` and `pathNamespace` (D3). Resolution gains a third outcome—`{ kind: 'root', edition, pathNamespace }`—beside `event` and `not-found`. Encoding it as data keeps `specs/event-resolution.md`'s existing properties intact: the answer is still pre-auth, still cacheable, still `get`-only, still never enumerable, and adding a doorway host stays a data change rather than a deploy.

**A root marker is what makes a doorway; it is not what makes path addressing.** The two are independent, which is what lets regime (c) coexist with a flagship Event—see D3.

**This is a live repoint, not a greenfield add.** `hostnames/fiveacross.app` today resolves to the Bodega Event (`scripts/provision-bodega-preview.mjs` provisions its postcard on exactly that host alongside the two subdomains). Turning the canonical apex into a doorway means repointing that document from an Event to a root marker, which is the same write [#601](https://github.com/nathanjohnpayne/gaycruisebingo/issues/601)'s post-Event repoint already has to make. The two must be sequenced deliberately rather than discovered in conflict: **the apex does not become a doorway while it is still Bodega's serving address.**

**The repoint must also retire the service worker already installed at that root.** This is the part a data-plus-deploy plan misses entirely. Devices that installed Bodega from `fiveacross.app` hold a **root-scoped service worker** with a precached, env-pinned shell. Omitting the manifest and denylisting path-addressed navigations (D4) does neither of the two things that matter here: it does not unregister that worker, and it does not stop it answering `/`. So the old worker keeps launching the retired Bodega Event—most visibly offline, and also while a replacement worker sits in `waiting` under this repo's deliberate `registerType: 'prompt'`, which never activates without the Player accepting the prompt.

The migration therefore carries an explicit requirement: **before the doorway is treated as live, the old root worker must be forcibly advanced and its precache cleaned up.** This repo already owns the machinery rather than needing new invention—`src/sw-rescue.ts` and the `build-floor.json` install-time floor (#342/#514) exist precisely to reach a client whose shell is stale and whose page cannot cooperate—so the requirement is to *use* that path for the repoint, and to verify the retirement rather than assume it. A doorway that is correct on the server and shadowed by a stale worker on the device is the same class of outage as the blank-screen chain this repo has already shipped three fixes for.

**And the repoint alone is not sufficient—a rebuild is a hard precondition.** Both registered production targets bake a non-empty `VITE_EVENT_ID` (`scripts/build-target.mjs`: `med-2026` and `bodega-bay-2026`), and a non-empty value is the build-mode switch that makes `resolveEvent` answer from env and **never consult `hostnames/{host}` at all** (ADR 0009, `specs/event-resolution.md` step 1). Repointing `hostnames/fiveacross.app` under today's deployed bundle therefore changes nothing: the build keeps mounting its baked Event. The same short-circuit blocks path parsing generally, so **no** regime in this spec takes effect on an env-pinned build. The precondition, stated so an implementation ticket cannot skip it: **every host that serves a doorway or a path-addressed Event must be served by a hostname-resolved build (empty `VITE_EVENT_ID`).** That is a deploy, not a data change—and the claim above that adding a doorway "stays a data change rather than a deploy" is true only *after* the serving target is hostname-resolved, which is the state this spec assumes and today's targets do not satisfy.

**The root does not host the wizard's steps.** #788's shell owns the wizard's own route; the doorway links to it. Mounting a five-step flow at `/` would put the wizard on the one path that must stay cheap, dependency-light and correct before any Event is known—and would collide with the reserved-path rule the moment a step wanted a sub-path.

### D2 — Path and hostname are not equivalent origins

`fiveacross.app/bodega-bay` is **not** the same identity as `bodega-bay.vacaybingo.com` for sessions, install or offline cache, and is not meant to become one.

For the mirror regime this is arithmetic: a different origin is a different origin, so cookies, storage and permissions are separate by construction. For the apex-archive regime it is a deliberate choice, and the more important half. The path surface shares an origin with every other archive on that apex and with the doorway itself, so it inherits precisely the ceilings ADR 0009 named—one storage quota, origin-scoped permission grants, all-or-nothing site-data clearing, no browser-enforced boundary. The resolution is not to buy those back with application code; it is to **not need them**, by never granting the path surface a capability that depends on them (D4).

**One capability is granted on a mirror path anyway, and the exception is stated rather than smuggled.** Proof capture needs the camera, the camera grant is origin-scoped, and a mirror origin serves many Events—so a grant (or a denial) on `fiveacross.vercel.app` applies to every Event reached under it. That is exactly the coupling ADR 0009 names, and regime (c) **accepts it deliberately** instead of pretending it away. The reason is that the alternative is worse in the only situation the mirror exists for: a mirror is the break-glass surface a Player reaches when the canonical host is blocked, and a break-glass surface that cannot capture proof is a Player locked out of half the game with no other door. Regime (b) needs no such exception—an archive is read-only, so it asks for no camera at all and the isolation argument stays whole there.

The consequences are therefore bounded and worth stating, because a later reader must not "fix" this by quietly granting install too:

- A camera **denial** on a mirror denies proof capture for every Event on that mirror until the visitor clears it. This is a real degradation of the backup, not a theoretical one.
- The coupling does **not** stop at capture, and D4 is explicit about the rest of it rather than implying non-installability sweeps it away.
- The accepted exception is scoped to a **mirror path**. It is not a precedent for regime (b), and it is not a precedent for install anywhere.

So the contract to state plainly, because the tempting reading is the wrong one: the path surface is a *narrower reach at the same `eventId`*, not an alias of the subdomain. Two consequences follow and both are intended. A Player signed in on the subdomain is not thereby signed in on the apex path; that is one sign-in per origin, the same as any two web apps. And an Event reachable both ways during the migration window (D8) genuinely has two surfaces of different capability at once—which is the same shape regime (c) has always had, not a new hazard.

**Serve-in-place forbids fixing this with a redirect, and does not forbid saying so.** A path surface must never navigate a visitor to the subdomain automatically. It **may** render an explicit, user-initiated affordance—#625 already specified its exact shape for the mirror case, and the same shape applies to an apex archive path: "when the canonical IS reachable, a dismissible 'continue on `<canonical>`' banner, never automatic." A banner the Player chooses to follow is not a domain bouncing a visitor off itself. On an archived Event there is no such link to offer, because there is no longer a subdomain serving (D8).

### D3 — Resolution and the router `basename`

**Parse before you resolve, and resolve before you mount.** `specs/event-resolution.md` already requires the Event to be known before first paint; path addressing adds one step in front of it and no new network read.

1. **Parse.** A pure function—call it `parseAddress(hostname, pathname)`—splits the first path segment off `location.pathname`. It answers `{ slug: string | null, basename: string }` and nothing else: no I/O, no Firestore, no router. A segment that is reserved (§ Reserved paths) or that contains a `.` yields `slug: null` and an empty basename, so an app route and an asset request are never mistaken for an Event address.
2. **Resolve.** The serving host's own `hostnames/{host}` document is read exactly as today. **Whether that host does path addressing is decided by one optional field on it, `pathNamespace`—not by whether it is an Event document or a root marker.** When `pathNamespace` is present and a slug was parsed, resolution reads `hostnames/{slug}.{pathNamespace}` and serves that Event; otherwise the host's own document answers and the path segment is an app route.

   Keeping those two facts independent is what makes regime (c) work. A brand mirror's document names a **flagship Event** (#625) *and* carries `pathNamespace`, so `/` serves the flagship and `/<slug>` reaches any other Event in the mirrored namespace—exactly #626's own sketch: "Resolution maps (mirror-host brand, slug) → the canonical `hostnames/{slug}.<brand-domain>` document — reusing the existing world-readable get, no new data shape. Bare mirror root falls back to the `hostnames/{mirror-host}` flagship doc." A doorway apex carries a root marker *and* `pathNamespace`, so `/` serves the doorway and `/<slug>` serves an archive. A live Event subdomain carries neither a marker nor a `pathNamespace`, so every path on it is an app route and the basename stays empty—regime (a), unchanged.
3. **Thread—but thread the EFFECTIVE basename, not the parsed one.** These are two different values and conflating them rebases ordinary subdomain routes by accident. Step 1 runs before the host's capability is known, so its basename is **speculative**: it says "this segment could be a slug," not "this host addresses by path." Only step 2 knows whether `pathNamespace` is present. So resolution emits an **effective basename**, which is the parsed one when path addressing was actually selected and **explicitly empty otherwise**—including on every live Event subdomain, where a first segment like `/feed` would otherwise be parsed as a candidate slug and then wrongly re-based. `<BrowserRouter basename>` in `src/main.tsx` (which mounts with none today) is given the effective value and never the parsed one. With that, the frozen tab table (`src/components/tabs.ts`) and every `NavLink` re-base together for free, which is why the basename is the mechanism rather than a prefix-aware route table.

**Deriving the subdomain from the path is the load-bearing trick, and it is what keeps the disclosure contract intact.** No new collection, no new rules, no reverse index: `hostnames/{host}` stays `allow get: if true; allow list: if false`, and resolving `/bodega-bay` is still a `get` of an address the caller already typed. A slug→Event index would have been the obvious alternative and is rejected on exactly that ground—it is the shape that turns a set of unguessable addresses into something a directory could be built from, which is the property `specs/hostnames-lookup.md` exists to protect.

`pathNamespace` is one optional field, and its absence is the fail-closed default: **a host with no `pathNamespace` does not do path addressing at all**, and every path on it is an app route. Two mirrors map to the namespace they mirror—`fiveacross.vercel.app` → `fiveacross.app`, `vacaybingo.vercel.app` → `vacaybingo.com`.

**`gaycruisebingo.vercel.app` deliberately gets no `pathNamespace`, and the reason is a real dead end rather than caution.** Mapping it to `gaycruisebingo.com` would make `/<slug>` a `get` of `hostnames/{slug}.gaycruisebingo.com`—documents that by construction never exist, because D1 defines `gaycruisebingo.com` as an **Edition apex that issues no Event subdomains**. Every secondary slug on that mirror would resolve not-found, which is a fail-closed dead end rather than a feature. GCB is a single-Event Edition, so its mirror mirrors that one Event at `/` (#625) and path addressing simply does not apply. The general rule the omission encodes: **a `pathNamespace` may only name an apex that actually issues Event subdomains.** Pointing one at an Edition apex is a configuration error, not a way to invent a namespace.

### The three contract details a naive implementation gets wrong

Each of these is a property of the *existing* resolver that path addressing breaks unless it is stated.

- **The cache key must be the derived target, not the serving host.** `specs/event-resolution.md` keys the resolution cache by hostname, which was sound while one origin selected one Event. It is now unsafe: many `/<slug>` Events share one origin, so a key of `fiveacross.app` would let the first resolved path write a mapping that a later visit to a *different* slug consumes before doing its own derivation—silently mounting the wrong Event. The key is the **derived target hostname** (equivalently `{servingHost, slug}`), and the root marker's own document caches under a separate key. The existing hostname-keyed entry for a live subdomain is unchanged.
- **The resolved routing-document key must survive into live subscriptions.** `watchAdultContent()` subscribes to `window.location.hostname` (`src/data/hostnames.ts`), which on a path visit is the root marker or the mirror flagship—not the Event being served. Left alone it would apply the flagship's adult-content posture to a path Event, clear the target's `preview`, and miss later posture changes on the document that actually governs. Resolution therefore carries the resolved routing key in its result, and **every** live `hostnames/{host}` subscription reads it instead of `window.location.hostname`. ADR 0012's monotone posture makes this load-bearing rather than cosmetic: watching the wrong document can only fail in the un-gating direction.
- **Both reads share ONE timeout budget.** A cold path boot needs two sequential `get`s—the serving host's document to learn `pathNamespace`, then the derived target. `specs/event-resolution.md` bounds pre-paint resolution at one server read hard-bounded by `timeoutMs`, and giving each read its own timeout would double the worst-case block before first paint, which is the blank-screen failure class this repo has shipped three fixes for. The budget is **one `timeoutMs` spanning both reads**; exhausting it mid-chain is a not-found (or a stale-cache serve), never a longer wait. A fresh cached entry for the derived target skips the chain entirely, so the two-read cost is a cold-boot cost only.

**An unresolvable slug renders not-found, never the doorway.** `fiveacross.app/nope` must not silently become `fiveacross.app`, because a wildcard fallback to `/` is precisely how a mistyped address would look like a working one. The existing `<Route path="*">` fallback in `src/App.tsx` stays correct *inside* a resolved basename and must not be the thing that swallows an unknown first segment—the parse in step 1 runs before the router exists, which is what keeps those two cases distinguishable.

### D4 — Non-installability is a requirement, not a guideline

**Every path-addressed surface is non-installable.** Regimes (b) and (c) both, and this is stated as a requirement because it is the condition on which ADR 0009's rejection is narrowed rather than contradicted. Concretely, and each clause is separately checkable:

- **No manifest is served at, or linked from, a path-addressed document.** The `<link rel="manifest">` is absent. The per-host manifest #546's Worker serves is a property of a host, and a path is not a host.
- **`beforeinstallprompt` is never consumed on a path-addressed surface.** `src/hooks/useInstallPrompt.ts` gates on the address regime, and `InstallPrompt` never mounts—including the iOS "Show me" branch, which fires no event and would otherwise slip through a listener-shaped guard.
- **The service worker never claims a path-addressed route.** Registration scope is the origin root, so a worker registered by the *doorway* would otherwise control every archive path under it. The requirement is on the navigation route, not on registration: the worker's `NavigationRoute` gains a denylist for path-addressed routes, the same mechanism and the same file (`src/sw.ts`) that already keeps it off Firebase's `/__/*` namespace (`specs/sw-auth-handler-denylist.md`). Reusing that seam matters—#182 is the shipped proof that a navigation fallback silently swallowing a route it should not own is a live failure mode here, not a theoretical one.
- **A path-addressed navigation is never served the precached shell.** It falls through to the network, which is the same statement as the bullet above from the Player's side, and the reason regime (b) has no offline cold boot to promise.

**What non-installability does NOT buy, stated so it cannot be over-read.** Refusing install removes the *install* collision. It does not make the app's durable, origin-scoped storage stop being shared, and claiming otherwise would be the same overreach this spec criticises elsewhere. Once a path Event mounts, the ordinary app still uses Firestore's origin-scoped persistence, Event- and card-keyed `localStorage`, and—on a mirror, where the flagship's service worker deliberately stays registered—the worker's CacheFirst proof-media route. So proof media and durable snapshots for several path Events share one Cache Storage and one quota, and a site-data clear still crosses Event boundaries exactly as ADR 0009 warns.

That residue is **accepted, not refused**, and bounded the same way the camera exception is:

- **Namespacing is required where the app already does it.** Every durable key a path Event writes—`localStorage` entries, the card cache, the resolution cache (D3)—is keyed by the resolved Event, never by the serving host. This is the partitioning ADR 0009 calls buildable, and this repo already keys durable snapshots that way, so it is applied rather than invented.
- **What remains genuinely shared is the browser's to arbitrate:** the single quota and its cross-Event eviction, and the all-or-nothing site-data clear. Those do not become per-Event on a shared origin no matter how the app is written, which is exactly why regime (a) still exists and why a live Event's home is still its own subdomain.
- **An apex archive MUST opt out of durable caching entirely—this is a requirement, not an implementation choice.** No Firestore persistence, no card cache, no durable snapshots. The reason it cannot be left optional: both ADR 0009's scope note and `x-multi-event-schema.md`'s supersession note justify the apex-archive regime on the premise that a read-only archive *has no durable or offline cache for origin isolation to protect*. If an implementation were free to leave persistence on, it would invalidate the premise the whole regime was approved on while still passing every other criterion here. An archive reads once and keeps nothing, so it gives up nothing it was promised—regimes (b) and (c) have no offline cold boot by construction.
- **A mirror path may keep durable caching**, because its premise is different and stated differently: regime (c) accepts the storage coupling explicitly (above) rather than claiming it is absent, and a break-glass surface that re-fetches everything on a degraded network is a worse backup. What it owes is the namespacing requirement, not abstention.

This is ADR 0009's own named mitigation—"the nested-install breakage … is avoidable by never making the origin root installable"—promoted from a note to a requirement and extended from the root to every path under it. #626 reached the identical conclusion independently from the collision direction: path-scoped installs on a shared origin collide, so the only safe number of installable surfaces per origin is one, and on a doorway origin it is zero.

**The doorway itself is not installable either.** An organiser does not install a create form, and an installable root is the exact thing ADR 0009 says never to build.

**A mirror origin that gains path addressing stops being installable at all—including its flagship.** An earlier draft of this spec kept the flagship installable and called it "at most one installable surface per origin." That does not hold, and the reason is scope: **an installed PWA's manifest `scope` is a path prefix, and a flagship installed from `/` has a scope containing every `/<slug>` under it.** Omitting a `<link rel="manifest">` on the path does not remove that URL from the already-installed flagship's scope, and neither does denylisting Workbox's navigation handler. So on a device with the flagship installed, opening a mirror path Event can launch *inside* the flagship's app window and inherit its identity and windowing—which is precisely the isolation failure the one-installable-surface rule was invented to prevent. The rule was counting install *prompts* when the thing that matters is install *scope*.

The invariant is therefore simpler and stricter than the one it replaces: **an origin that does path addressing is not installable, anywhere on it.** Doorway origins, mirror origins, flagship root included.

**This costs less than it appears, because #625 asked for reachability and not installability.** A mirror exists so that a Player whose canonical host is blocked still *reaches* the game; it says nothing about installing from there, and a Player who wants an installed app installs it from the Event's own subdomain, where regime (a) gives them real origin isolation. So the mirror keeps serving its flagship at `/` exactly as today—#625's actual requirement is untouched—and simply stops offering to install. This is also what ADR 0009 already says to do in as many words: never make the shared origin installable. The earlier draft carved an exception into that sentence; this one stops carving.

**Making the origin non-installable only stops FUTURE installs, so legacy installed clients need their own answer.** A device that already installed the flagship holds a stored manifest whose `scope` is `/`, and nothing the server does removes it: not dropping the manifest link, not suppressing prompts, not retiring the worker and its precache. **A web app cannot uninstall itself**—that is a browser and OS action a Player performs. So on exactly those devices, a `/<slug>` URL can still open inside the flagship's app window, which is the identity inheritance this section exists to prevent.

The requirement is therefore a **runtime refusal rather than a claim of prevention**, and it is stated as its own obligation because the non-installability rule above does not imply it:

- **A path-addressed route must refuse to mount inside an installed app window.** When a path-addressed surface resolves and the display mode is standalone (or any installed-app display mode rather than a browser tab), the app does **not** mount the Event. It renders an explicit screen saying this address must be opened in a browser, with the reason and a one-tap way to do it. Refusing is correct rather than unhelpful: mounting would give the Player an Event wearing another Event's identity, offline shell and permissions, which is worse than a clear redirection.
- **Full remediation requires the Player to uninstall, and the spec says so rather than implying we can do it.** The refusal screen is what bounds the damage in the meantime; it is not a fix for the stored scope.
- **The refusal is keyed on display mode plus path addressing**, not on "is this a mirror," so it also covers a doorway origin whose Event was previously installed at `/`—the repoint case D1 describes, which has the identical stored-scope problem.

**Existing installed mirror clients must be retired too, not just repointed roots.** The same forced-advancement requirement D1 states for a root being repointed to a doorway applies verbatim to **a mirror gaining path addressing**, and for the same mechanism: a client carrying the current root-scoped worker keeps its navigation fallback and env-pinned flagship shell indefinitely under `registerType: 'prompt'`, so opening a new `/<slug>` on that client can mount the **flagship** instead of the requested Event. Enabling mirror paths is therefore gated on the same forced worker advancement and precache retirement, verified rather than assumed, before those routes go live. Treat "a root-scoped worker already exists on this origin" as the trigger for the requirement, rather than enumerating the two situations that currently produce one.

**The guard must key on the resolved regime, never on the presence of a basename.** This is stated as a prohibition because the basename test is the obvious shortcut and it is wrong in both directions: a **doorway root resolves with an empty basename, exactly like a live Event subdomain** (and after the effective-basename rule in D3, so does every non-path-addressing host), so "suppress install when a basename is present" would leave the doorway installable and contradict the requirement above. The decision input is **the serving host's addressing capability**, which resolution already knows: an origin that does path addressing—doorway or mirror, at `/` or at any path—is not installable; only a host serving regime (a) is. That input is available precisely because D1 makes the root a resolution outcome rather than a hardcoded route.

### D5 — Share URLs keep the entry-point surface, path included

[#607](https://github.com/nathanjohnpayne/gaycruisebingo/issues/607)'s rule—a share is composed from the origin the sharer is standing on, never rewritten to the Event's canonical host—applies to path-addressed surfaces **symmetrically**, and applies to the path as well as the origin. A share from `fiveacross.vercel.app/bodega-bay` is `https://fiveacross.vercel.app/bodega-bay/...`; a share from `fiveacross.app/bodega-bay` keeps that apex and that prefix. Neither is rewritten to `bodega-bay.vacaybingo.com`.

The reason is #607's own: every serving host stays live and brands dynamically, so a link rewritten to another host unfurls and lands the recipient under a different Edition's brand—and, worse on a mirror, sends them back to the host that was blocked when the sharer reached for the backup.

**This is a real seam, not an inherited property.** `shareOrigin()` (`src/canonicalHost.ts`) returns `window.location.origin` and nothing else, so a share composed from it today would **drop the path prefix and land recipients on the doorway**. The three Web Share call sites (`Leaderboard.tsx`, `FarewellPodium.tsx`, `Celebration.tsx`) compose against it. Path addressing therefore needs share composition to go through the resolved basename—stated here so the implementation ticket is filed against a known defect rather than discovering it in production.

### D6 — Analytics canonicalise the host and record the surface

Both halves, because they are different dimensions answering different questions.

**The host dimension stays canonical.** Per #599, analytics report the Event's one resolved canonical host regardless of entry point, so cross-host traffic aggregates instead of splitting three ways. Path addressing changes nothing here: `applyResolvedCanonicalHost` installs the value the *Event's* routing document names—reached by path or by host, it is the same document, so it is the same value. `canonicalizeOrigin` (`src/posthog.ts`) and `currentPageLocation()` (`src/analytics.ts`) already rewrite only the **origin** of a URL, which means the path prefix survives canonicalisation untouched and needs no new code to be preserved.

**The entry surface is recorded separately, as its own dimension.** Which of the three regimes a visit arrived through is useful signal (#584/#601)—it is how "the canonical host is blocked again" becomes visible, and how archive traffic is told apart from live play. It must not be recovered by string-matching `$pathname`, which would silently conflate an archive path with an app route the moment either changes. A first-class regime dimension is the contract, and it needs **four** values rather than three: `live-subdomain`, `apex-path`, `mirror-path`, and **`mirror-root`**. That fourth one is the mirror flagship visit at `/`, which is neither a subdomain nor a path and which D1 and D4 deliberately treat as its own case—it serves the flagship, it is no longer installable, and it is the surface #625's whole backup story runs through. Leaving it out would force implementations either to mislabel it as `live-subdomain` (hiding exactly the "the canonical host is blocked again" signal this dimension exists to surface) or to invent an incompatible fourth value of their own.

The two together are the point: **the Event aggregates, the door is counted.**

### D7 — Auth reachability is a property of the host, and stays one

`isSignInReachableOnHost` (`src/auth-domain.ts`) gates on hostname and takes no path, and that is correct rather than a gap to close. The OAuth helper lives at `/__/auth/*`, an **origin-level** reserved namespace: Firebase Hosting serves it same-origin, `vercel.json`'s rewrites are host-conditional, and the Google OAuth client matches `redirect_uri` per origin. Nothing about a path can make sign-in more or less completable, so the predicate is asked the same question on `fiveacross.app/bodega-bay` as on `fiveacross.app`, and `parseAddress` discards the path before it is consulted—the shape `firebaseAuthOriginRedirectUrl` already uses, which takes a location and keeps only the hostname.

**#799's premise on the mirrors needs correcting, and the code is the evidence.** All three brand mirrors are in `FIRST_PARTY_AUTH_HOSTS`, so `isAuthConfiguredForHost` is true for them and sign-in completes. `specs/event-resolution.md` says so in its own acceptance criteria: the `auth-unconfigured` developer note fires on a `*.vercel.app` hostname "by construction a per-deployment preview host, **since every registered Vercel host is in `FIRST_PARTY_AUTH_HOSTS`**." The developer note is for unregistered per-deployment preview hosts, not for the three registered mirrors. **A path-addressed Event on a brand mirror needs no `auth-unconfigured` treatment**, and ADR 0010's central-auth handoff is not a blocker for regime (c).

**Regime (b) does not get the same free pass, and one of its two apexes is not ready.** The predicate is per-host, so each apex has to be checked individually rather than as a class. `fiveacross.app` **is** in `FIRST_PARTY_AUTH_HOSTS`. **`vacaybingo.com` is not**—the allowlist carries `vacaybingo.vercel.app` and `bodega-bay.fiveacross.app` but never the Vacay apex itself, and the shipped Bodega bundle bakes `bodega-bay.vacaybingo.com` as its `authDomain`. So `isSignInReachableOnHost('vacaybingo.com')` is **false** today, and archives parked at `vacaybingo.com/<slug>` would render `auth-unconfigured` rather than the sign-in gate this spec otherwise promises.

That is a precondition, not a defect in the design, and it is stated as one: **an apex may not serve regime (b) until it is registered as a first-party auth host**—an exact entry in `FIRST_PARTY_AUTH_HOSTS`, in Firebase Auth's authorized domains, and as `https://<host>/__/auth/handler` on that project's Google OAuth web client. The last of those is console-only and human-performed, so it is lead time rather than code. Until it is done for `vacaybingo.com`, Vacay archives belong at `fiveacross.app/<slug>`, which is registered and serves the same Event.

**An archive requires sign-in exactly as the live Event did.** It is not world-readable. Every read of Event data passes `signedIn()` today and the membership gate after it lands, and an archive is the same data at the same paths—`EventDoc.status` changes what serves it, not who may read it. What renders before sign-in is what already renders before sign-in: the gate, branded by the resolved Edition, with the `preview` postcard from `hostnames/{host}` when the document carries one (#647). That is display copy the page shows anyone regardless, so nothing widens. This is also what keeps the retained non-goal true—an archive at a path is not a public directory entry, because reaching it still gets you a sign-in screen.

### D8 — The archive interlock, proposed for #134

[#134](https://github.com/nathanjohnpayne/gaycruisebingo/issues/134) is the ticket that will start setting `EventDoc.status: 'archived'`; nothing reads the field today. Rather than let #134 discover this requirement, the condition is proposed here.

**The interlock rides the `hostnames/{host}` document's own `status`, not `EventDoc.status`.** This is forced, not preferred: the Event document requires `signedIn()`, so its status cannot be consulted before first paint, which is when the addressing decision has to be made. The routing document's `status` is already `active | disabled | archived` (`specs/hostnames-lookup.md`) and already world-readable. The interlock is therefore a rule about which statuses serve **through which door**:

| `hostnames/{host}.status` | Served at its own host | Served by path on its namespace root |
|---|---|---|
| `active` | **yes**—regime (a) | **yes**—regimes (b) and (c) |
| `archived` | **no**—not-found | **yes**—regimes (b) and (c) |
| `disabled` | no | no |

**The status matrix alone is not sufficient, because `pathNamespace` is host-wide.** Taken by itself, "an `active` target serves when reached by path" plus a namespace-wide `pathNamespace` on `fiveacross.app` would make **every active Event in that namespace permanently reachable at an apex path**, for its whole active life rather than during a migration. That is not the migration-only exception this decision intends, and it would hand every live Event a shared-origin alias competing with its own installable subdomain—reintroducing exactly what ADR 0009 rejects. Host-wide capability has to be paired with **per-Event eligibility**.

So the apex-path regime carries a second condition, on the **target** document rather than the serving host: a field—`apexPath`—that the Event's own routing document must carry before it is reachable at an apex path at all. Absent is the fail-closed default, so no Event acquires an apex path merely because its namespace gained one.

| | `apexPath` absent | `apexPath` present |
|---|---|---|
| `active` target reached at apex path | **not-found** | serves—this is the migration window |
| `archived` target reached at apex path | **not-found** | serves—this is the archive |

**This condition is deliberately scoped to regime (b) and does not apply to mirrors.** The two regimes are asking for different things. An apex path competes with the Event's own subdomain on a shared origin, so it must be opted into per Event and, during a migration, deliberately and temporarily. A **mirror** path is the break-glass backup #626 exists to provide: the mirror origin is already non-installable throughout (D4), it offers no competing installable surface, and the whole point is that *any* Event in the mirrored namespace is reachable when the canonical host is blocked. Requiring per-Event opt-in there would mean discovering, mid-outage, that the one Event you needed had never been enrolled. So regime (c) stays namespace-wide and regime (b) is opt-in.

#134 sets `apexPath` as part of the same archival transaction below. A migration sets it explicitly, and is expected to clear it when the migration ends if the Event is not being archived.

Read off the three answers #799 asks for:

- **Does path-addressability require `status: 'archived'`? No—but on an apex it requires `apexPath`.** An `active` Event is reachable at an apex path during a migration, which is what the migration window is, and on a **mirror** it is reachable with no per-Event condition at all, which is regime (c)'s entire purpose. What an `active` Event never gets is an apex path it did not opt into.
- **Does the subdomain keep serving after archival? No, and the same transaction ends it—at the origin.** Moving a routing document from `active` to `archived` retires the subdomain and promotes the path together, with no window where both serve and none where neither does. It needs **no rules change** (`specs/event-resolution.md` already refuses to serve a non-`active` status at its own host) though it does need the two new fields this spec introduces, `pathNamespace` and `apexPath`.

**The cache does not carry that flip promptly, and the interlock must not pretend it does.** An earlier draft of this decision claimed the cache-drop makes an installed client stop on its next boot. That is wrong, and the correction matters because #134 would otherwise ship believing archival takes effect immediately:

- A **fresh** entry—inside the 12-hour TTL and `active`—resolves with **no network read at all** (`specs/event-resolution.md` step 2). A client holding one never learns about the flip. The drop-not-expire behaviour applies to an entry that is *revalidated*, so it is reached only once the entry has already gone stale.
- Worse on cold boot: the cached Event mounts first and the entry is dropped only on the subsequent revalidation, so a naive implementation needs **two** boots to reach the archived state.
- The live watcher drops the cache but does not itself re-resolve or unmount, so an open session keeps running the retired Event.

So the archive contract carries an explicit obligation rather than an inherited one. **#134's flip must produce a bounded, observable transition**, by one of two means the implementation ticket chooses between and states: either the live `hostnames/{host}` watcher drives a real re-resolution (and an unmount to the archived surface) when it observes the status change, or **the Event's own host** mandates a status revalidation on boot before mounting a cached entry.

**Be exact about which host that second option applies to, because the obvious phrasing names the wrong one.** The client that must stop serving is the one installed on the retired **subdomain**—and by D3 a live Event subdomain carries no `pathNamespace` at all, so it is precisely *not* a path-capable host. Scoping the revalidation to "path-capable hosts" (doorway and mirror origins) would leave the subdomain's fresh cache mounting the retired Event for up to twelve hours while dutifully revalidating the origins that were never the problem. So: revalidation is required **on the Event's own host**, or the watcher-driven transition is required **universally**. Those are the only two shapes that close the hole.

What is **not** acceptable is relying on TTL expiry. Until one of the two lands, the honest statement is that archival is prompt at the origin and lagging on cached clients—and this spec says so rather than letting #134 discover it.
- **Does path-addressing replace the subdomain? Yes—on archival, and only then.** Before it, the two coexist with different capabilities (D2).

**#134's flip is ONE transaction over every document involved—routing and Event alike.** An earlier draft asked only that the routing documents flip atomically with each other and left `EventDoc.status` as a separate obligation. That ordering is exploitable: if routing flips first, path resolution begins serving the Event as an archive while a still-`active` `EventDoc` renders **writable** gameplay behaviour—an "archive" a Player can still mark, claim and post into. The reverse order is merely useless rather than harmful, but neither is acceptable when one batch avoids both.

So the transaction includes, atomically: **every** routing document for that Event (Bodega has three), each moving `active → archived`; the `apexPath` field on whichever routing document is to become the archive address; and `EventDoc.status → 'archived'`. Nothing observes a half-archived Event.

The two status fields stay deliberately separate even though they now move together, because they answer different questions for different audiences at different times: the **routing** status decides addressing and is read world-readably before first paint, while the **Event** status decides behaviour and is read after mount behind `signedIn()`. Collapsing them would put an authenticated read on the pre-paint path, which is the thing ADR 0009 exists to avoid. Moving together is a property of the write; being separate is a property of the read.

### D9 — What the root's create affordance does today

#787's `EventDraft` is device-local and holds no claimed slug until launch; the launch provisioner (#793) sits behind the Phase 3 membership gate. So the honest answer for today is not the fully-shipped one.

**The doorway always renders; the create affordance has two states, and the switch is configuration, not a probe.** When provisioning is available, the affordance links to the wizard's own route (#788's shell)—it does not mount the wizard at `/` (D1). When provisioning is not available, the affordance renders an explicit not-yet-open state that names what it is waiting on. **Today it is the second.**

Two things this deliberately refuses. It does not mount the wizard's draft steps behind a launch that cannot complete: #787's contract is explicit that a draft "neither reserves nor squats an address," and a draft is device-local, so an organiser who spent fifteen minutes filling one in would be holding something they cannot launch and can lose to a cache clear. A create form that cannot create is worse than a closed door, because it costs the organiser the work before it tells them. And the state is decided by configuration rather than by probing #793 at runtime, because a pre-paint network read to decide what the doorway looks like is exactly the blank-screen failure class `specs/event-resolution.md` bounds everywhere else.

**The doorway is a consumer of #787's contract, not a fork of it.** When the affordance opens, it hands off to the wizard's shipped `EventDraft` / `OccasionDef` surface (`src/data/eventDraft.ts`, `src/data/occasions.ts`, `src/data/draftValidation.ts`) and re-derives no draft semantics of its own.

## Reserved paths

A first path segment that is reserved is never a slug. The list is **one shared module**—`src/slug.ts`-shaped, per #790's note that #545 and #793 both need to consume it framework-clean—read by the client parse (D3), by the Worker's reserved-label check (#545), and by the wizard's availability check and the provisioner (#790/#793). Three independently maintained copies is the failure this consolidation exists to prevent: a slug accepted by the wizard and rejected by the router is an Event nobody can reach.

**The module holds a union of two floors, and neither may shrink the other.** #790 introduces the **hostname-label** floor the PRD names—`www`, `auth`, `api`, `admin`, `play`, `status`, `d`—which exists because those labels are or will be real subdomains. This spec adds the **path-segment** floor below, which exists because those segments are real routes. A slug must clear both, since a slug is simultaneously a subdomain label in regime (a) and a path segment in regimes (b) and (c). `admin` is in both floors and would be reserved twice over; nothing else overlaps, which is exactly why one list has to be the union rather than either list alone.

Sources, so the list can be re-derived rather than trusted:

- **The frozen tab table** (`src/components/tabs.ts`, the hot-file owner's mount-point table): `/` itself, `feed`, `leaderboard`, `more`. `more` mounts with a splat (`/more/*`), so everything under it is reserved with it.
- **`items` and `admin`**—reserved although neither is a top-level route any more: #203/#208 moved them inside More (`/more/admin[/section]`, `specs/admin-console-ia.md`). Reserved anyway, because links minted before that move still exist and because an Event slugged `admin` is a trap regardless of which route table is current.
- **`__`**—Firebase Hosting's reserved OAuth-helper namespace (`/__/auth/handler`, `/__/auth/iframe`), already denylisted in the service worker for exactly this class of reason (`specs/sw-auth-handler-denylist.md`) and rewritten host-conditionally in `vercel.json`.
- **`unsubscribe`**—a Hosting rewrite to the `emailUnsubscribe` Function (`firebase.json`), so it never reaches the SPA at all. An Event slugged `unsubscribe` would be unreachable and would look like a Function bug.
- **`assets`**—Vite's hashed-output directory.
- **A structural rule, not an entry: a segment containing a `.` is never a slug.** This covers `sw.js`, `manifest.webmanifest`, `registerSW.js`, `workbox-*.js`, `build-floor.json`, `favicon.svg`, `apple-touch-icon.png`, `pwa-192.png`, `pwa-512.png` and every `og-*.png` without enumerating a build output that churns. Enumerating them instead would guarantee the list goes stale silently, which is the same defect as maintaining three copies.

The list is a floor. #545 and #790 may reserve more (platform words, profanity, single characters); nothing here may be removed without a route table changing under it.

## Contracts this spec extends, and what each amendment must say

This spec introduces a `hostnames/{host}` document with **no `eventId`**, a **third** resolution outcome, and a **new optional field**. Two accepted specs currently exclude all three, and an implementation that reuses today's resolver against today's written contract would reject the root marker or mount the wrong branch. Naming the required amendments here—rather than leaving an implementer to infer them—is part of this spec's job, but the amendments themselves land with the implementation ticket, since changing an accepted contract ahead of the code that honours it would leave both specs describing something that does not exist.

**`specs/hostnames-lookup.md` must gain:**

- The **root marker** as a documented variant: `eventId` becomes optional, and its absence is what makes the document a doorway rather than a malformed Event mapping. Today's coercion (`coerceHostnameDoc`) must read a missing `eventId` as a root marker, never as null-and-drop.
- **`pathNamespace`** as an optional field on a **serving** host, with the fail-closed default (absent ⇒ no path addressing) and the validity rule (it may only name an apex that issues Event subdomains).
- **`apexPath`** as an optional field on a **target** Event's routing document, fail-closed absent, gating apex-path eligibility per Event (D8). It is deliberately a different field on a different document from `pathNamespace`: one says "this host can address by path," the other says "this Event may be addressed that way on an apex," and conflating them is what would alias every live Event onto the shared origin.
- A note that neither addition changes the rules contract: still `allow get: if true; allow list: if false`, still no client writes. Nothing here is rules-gated, so the disclosure posture is unchanged.

**`specs/event-resolution.md` must gain:**

- The **third outcome** `{ kind: 'root', edition, pathNamespace }` alongside `event` and `not-found`, and `src/main.tsx`'s handling of it—the doorway mounts, so this is not the `EventNotFound` branch and must not be folded into it.
- The **derived-target cache key** for path resolution, kept separate from the root marker's own entry.
- The **single `timeoutMs` budget spanning both reads**, and the failure behaviour when it is exhausted mid-chain.
- The **resolved routing key** in the resolution result, and the requirement that live `hostnames/{host}` subscriptions read it rather than `window.location.hostname`.
- The **route-aware status rule**: `archived` is not-found at its own host and servable by path, so status can no longer be evaluated without knowing which door was used.

The last point is the one most likely to be missed, because today's contract states a status rule that is unconditionally true and would stay compiling while becoming wrong.

## Deliberately not in this spec

- **The rules workstream for tenant isolation.** `specs/x-multi-event-schema.md` § "Rules / indexes / hosting implications" already carries the honest inventory: today's rules are path-scoped, not membership-scoped. Path addressing changes no rule and widens no read—it changes which URL reaches a document, not who may read it.
- **Slug format, length, reservation, expiry and rename.** #790's contract; this spec names only the reserved *floor* the router forces.
- **Whether an archive renders differently once mounted.** #134's subject. This spec decides addressing; the read-only surface is behaviour.
- **Per-host manifest and OG injection.** #546's Worker. D4 constrains it (never serve a manifest at a path) and adds nothing else.
- **The Worker's own routing.** #545. D3's derivation is the client's; the Worker consuming the same reserved list and the same `pathNamespace` field is a coordination point, not a decision made here. One warning for whoever lands it: #545's acceptance has the Worker fail closed on "unknown, reserved, disabled, **archived** and domain-ineligible slugs." That is right for **subdomain** routing and is the same rule as D8's first column—but it must not be applied to a path route on a host carrying `pathNamespace`, where an `archived` slug is precisely what is supposed to serve. The two routes read the same field and want opposite answers from it, which is the kind of thing that is obvious here and invisible in a Worker diff.
- **Creation on a namespace apex.** D1 refuses it for now; whether `vacaybingo.com` ever creates Vacay Events is a product decision, not a routing one.

## Acceptance criteria

**D1 — root shape per host class**

- **Given** the canonical apex `fiveacross.app` with a root-marker routing document, **when** a visitor loads `/`, **then** the platform doorway renders with the `fiveacross` brand and a create affordance, and no Event is mounted.
- **Given** `gaycruisebingo.com` or `vacaybingo.com`, **when** a visitor loads `/`, **then** that Edition's own doorway renders and **no** create affordance appears.
- **Given** any of the three brand mirrors, **when** a visitor loads `/`, **then** that mirror's **flagship Event** renders exactly as it does today (#625)—no doorway, no create affordance, and the backup path is unchanged.
- **Given** a `hostnames/{host}` document that names an `eventId`, **when** the app starts, **then** the host resolves to that Event and no doorway renders—the root marker is the only thing that produces a doorway.
- **Given** `hostnames/fiveacross.app` still pointing at the Bodega Event, **when** the doorway work is scheduled, **then** it is sequenced behind #601's repoint and the apex is not converted while it is Bodega's serving address.
- **Given** a build with a non-empty `VITE_EVENT_ID`, **when** it is served on a host carrying a root marker or a `pathNamespace`, **then** it still short-circuits to its baked Event and no doorway or path addressing takes effect—so **given** any host intended to serve regime (b) or (c), **then** it must first be served by a hostname-resolved build (empty `VITE_EVENT_ID`).

**D2 — path is not an equivalent origin**

- **Given** a Player signed in at `bodega-bay.vacaybingo.com`, **when** they open `fiveacross.app/bodega-bay`, **then** they are not signed in there—the surfaces share an `eventId`, not a session.
- **Given** a path-addressed surface, **when** it renders, **then** it never navigates the visitor to the Event's subdomain automatically; **and given** the Event is still live, **then** it may offer a user-initiated link to the installable address.
- **Given** an archived Event, **when** its path surface renders, **then** no link to a subdomain is offered, because none serves.
- **Given** an Event reached on a mirror path, **when** the Player captures proof, **then** capture works, and **then** the camera grant is understood to be shared with every other Event on that mirror origin—an accepted, documented consequence, not an oversight.
- **Given** an Event reached on an apex archive path, **when** the surface renders, **then** it offers no capture at all, so the shared-grant question never arises there.

**D3 — parsing, resolution and basename**

- **Given** `location.pathname` of `/bodega-bay/feed` on a root-marker host, **when** `parseAddress` runs, **then** it answers `slug: 'bodega-bay'`, `basename: '/bodega-bay'`, performing no I/O.
- **Given** a first segment that is reserved or contains a `.`, **when** `parseAddress` runs, **then** it answers `slug: null` and an empty basename.
- **Given** a root marker with `pathNamespace: 'fiveacross.app'` and the slug `bodega-bay`, **when** resolution runs, **then** it reads `hostnames/bodega-bay.fiveacross.app` by `get`, and issues no collection query at any point.
- **Given** a brand mirror whose document names a flagship Event **and** carries `pathNamespace`, **when** `/` is loaded, **then** the flagship Event serves; **when** `/<slug>` is loaded, **then** that slug's Event serves—the two coexist on one document.
- **Given** a serving host with no `pathNamespace`, **when** any path is requested, **then** no path addressing is attempted and the segment is treated as an app route.
- **Given** `gaycruisebingo.vercel.app`, **when** its routing document is provisioned, **then** it carries no `pathNamespace`; **and given** any `pathNamespace` value, **then** it names an apex that issues Event subdomains—naming an Edition apex is a configuration error.
- **Given** a path resolved on a shared origin, **when** the mapping is cached, **then** the key is the derived target hostname (or `{servingHost, slug}`) and never the serving host alone, so a later visit to a different slug cannot consume it; **and** the root marker's own document caches under a separate key.
- **Given** a path-resolved Event, **when** any live `hostnames/{host}` subscription is opened—`watchAdultContent()` included—**then** it subscribes to the **resolved** routing document, never to `window.location.hostname`.
- **Given** a cold path-addressed boot needing both reads, **when** resolution runs, **then** the two `get`s share one `timeoutMs` budget; **when** it is exhausted mid-chain, **then** resolution completes as not-found or a stale-cache serve, never as a longer block before first paint.
- **Given** a fresh cached entry for the derived target, **when** the app starts, **then** the two-read chain is skipped entirely.
- **Given** a first segment that resolves to no routing document, **when** the app starts, **then** it renders not-found—never the doorway, and never a redirect to `/`.
- **Given** a live Event subdomain, **when** the app mounts, **then** the router mounts with no basename and the frozen tab paths are unchanged.
- **Given** `parseAddress` produced a speculative non-empty basename on a host that turns out to have no `pathNamespace`—a live Event subdomain requesting `/feed`, say—**when** resolution completes, **then** the **effective** basename is explicitly empty and that is what reaches `BrowserRouter`; the speculative value is never threaded directly, or ordinary subdomain routes would be rebased by accident.
- **Given** a resolved basename, **when** a tab `NavLink` navigates, **then** the prefix is preserved without any per-link change to the frozen tab table.

**D4 — non-installability**

- **Given** a path-addressed surface in either regime, **when** the document renders, **then** it links no manifest.
- **Given** a path-addressed surface, **when** the browser fires `beforeinstallprompt`, **then** the app does not consume it and no install affordance renders—including the iOS branch, which fires no event.
- **Given** a service worker registered at the origin root of a doorway host, **when** a navigation to a path-addressed route occurs, **then** the navigation route does not match it and the precached shell is not served.
- **Given** the worker source, **when** it registers the navigation route, **then** that route carries a denylist covering path-addressed routes alongside the existing `/^\/__\//` pattern.
- **Given** a doorway host, **when** `/` renders, **then** it is not installable either.
- **Given** a brand mirror that has gained path addressing, **when** its flagship renders at `/`, **then** it still serves exactly as today (#625 preserved) but is **no longer installable**; **and given** any origin that does path addressing, **then** no surface on it is installable.
- **Given** a device with the flagship already installed from a mirror root, **when** a `/<slug>` on that origin is opened, **then** it must not launch inside the flagship's app window—because the flagship's manifest `scope` is a path prefix covering `/<slug>`, omitting a manifest at the path does not remove it from that scope, which is why the origin is made non-installable rather than the path merely unadvertised.
- **Given** an origin that already carries a root-scoped service worker, **when** path addressing is enabled on it—whether by repointing a root to a doorway **or** by a mirror gaining paths—**then** the old worker is forcibly advanced and its precache retired, verified, before those routes go live.
- **Given** a doorway root, **which resolves with an empty basename exactly like a live Event subdomain**, **when** the install guard evaluates it, **then** it is still suppressed—so **given** any implementation, **then** the guard keys on the resolved regime and never on the presence of a basename.
- **Given** a device that installed the Event previously served at a root being repointed to a doorway, **when** the repoint lands, **then** the old root-scoped service worker is forcibly advanced and its precache cleaned up **before** the doorway is treated as live—omitting the manifest neither unregisters it nor stops it answering `/`, and `registerType: 'prompt'` means a replacement worker may sit in `waiting` indefinitely.
- **Given** a path-addressed surface, **when** it writes any durable state, **then** every key it controls is keyed by the resolved Event rather than the serving host; **and given** the quota, cross-Event eviction and site-data clear, **then** those remain shared and are accepted as such, not claimed to be refused by non-installability.
- **Given** an apex archive path, **when** it renders, **then** durable caching is **disabled**—no Firestore persistence, no card cache—because ADR 0009 and `x-multi-event-schema.md` both justify this regime on the premise that an archive keeps nothing durable; leaving it optional would let an implementation invalidate that premise while passing every other criterion.
- **Given** a mirror path, **when** it renders, **then** durable caching is permitted and every key it writes is namespaced per Event.
- **Given** a device with the Event previously installed at that origin's root, **when** a path-addressed route is opened **in an installed-app display mode**, **then** the app refuses to mount the Event and renders an explicit open-in-a-browser screen—because a stored manifest scope cannot be revoked from the server and a web app cannot uninstall itself; making the origin non-installable prevents only future installs.

**D5 — share composition**

- **Given** a share initiated from `fiveacross.vercel.app/bodega-bay`, **when** the URL is composed, **then** it carries that origin **and** the `/bodega-bay` prefix, and is not rewritten to the Event's canonical subdomain.
- **Given** a share initiated from `fiveacross.app/bodega-bay`, **when** the URL is composed, **then** the same holds—the rule is symmetric across regimes (b) and (c).
- **Given** a share initiated from a live Event subdomain, **when** the URL is composed, **then** it carries no path prefix, exactly as today.

**D6 — analytics**

- **Given** a visit through any of the three regimes, **when** analytics report the host dimension, **then** it is the Event's one resolved canonical host.
- **Given** a path-addressed visit, **when** the URL is canonicalised for analytics, **then** only the origin is rewritten and the path prefix survives.
- **Given** a visit, **when** it is recorded, **then** the entry surface is reported as a first-class regime dimension, not inferred by string-matching a pathname.
- **Given** a mirror flagship visit at `/`, **when** it is recorded, **then** it reports **`mirror-root`**—a distinct fourth value alongside `live-subdomain`, `apex-path` and `mirror-path`—so it is neither mislabelled as a subdomain visit (which would hide the "canonical host blocked again" signal) nor left for an implementation to invent a value for.

**D7 — auth reachability**

- **Given** any path-addressed surface, **when** `isSignInReachableOnHost` is consulted, **then** it is passed the hostname only and its answer is identical to the answer for that host's `/`.
- **Given** a path-addressed Event on `fiveacross.vercel.app` or `vacaybingo.vercel.app`, **when** the app boots, **then** it mounts and offers sign-in—no `auth-unconfigured` state and no developer note, because every registered Vercel host is first-party.
- **Given** `vacaybingo.com`, **when** `isSignInReachableOnHost` is consulted today, **then** it is **false**—so **given** an apex not registered as a first-party auth host, **then** it may not serve regime (b), and Vacay archives are parked at `fiveacross.app/<slug>` until the registration lands.
- **Given** an apex being made regime-(b) capable, **when** the enabling work is done, **then** it has an exact `FIRST_PARTY_AUTH_HOSTS` entry, a Firebase Auth authorized-domain entry, and a `https://<host>/__/auth/handler` registration on that project's OAuth web client—the last being console-only and human-performed.
- **Given** an archived Event reached at a path, **when** a signed-out visitor loads it, **then** the sign-in gate renders—branded by the resolved Edition, with the `preview` postcard when the routing document carries one—and no Event data is readable without signing in.

**D8 — archive interlock**

- **Given** a routing document with `status: 'active'`, **when** it is reached at its own host, **then** it serves; **when** it is reached by path on a **mirror**, **then** it serves; **when** it is reached at an **apex** path, **then** it serves only if that document carries `apexPath`, and renders not-found otherwise.
- **Given** a namespace apex that has gained `pathNamespace`, **when** an active Event in that namespace has **no** `apexPath`, **then** it is **not** reachable at an apex path—host-wide capability never confers per-Event eligibility, so enabling the apex does not alias every live Event onto the shared origin.
- **Given** a mirror, **when** any Event in the mirrored namespace is reached by path, **then** it serves without per-Event opt-in—so an outage cannot reveal that the one Event needed was never enrolled.
- **Given** a routing document flipped to `status: 'archived'`, **when** it is reached at its own host by a client with no fresh cache, **then** it renders not-found; **when** it is reached by path, **then** it serves.
- **Given** a client holding a **fresh** (`active`, within TTL) cached entry, **when** the document is flipped to `archived`, **then** that client does **not** learn of the flip from the cache alone—so **given** #134's implementation, **then** it must drive a bounded, observable transition rather than relying on TTL expiry.
- **Given** the boot-revalidation option is chosen, **when** its scope is defined, **then** it applies to **the Event's own host** (the retired subdomain) and not to "path-capable hosts"—the subdomain that must stop serving carries no `pathNamespace`, so the path-capable scoping would revalidate only origins that were never the problem; the alternative is the watcher-driven transition applied universally.
- **Given** an open session, **when** the live watcher observes the archival, **then** the session does not continue running the retired Event indefinitely.
- **Given** `status: 'disabled'`, **when** it is reached either way, **then** it serves in neither.
- **Given** an Event with more than one routing document, **when** #134 archives it, **then** every routing document, the `apexPath` field, **and** `EventDoc.status` change in **one** transaction—no observer ever sees routing archived while the Event document is still `active`, which would serve an "archive" that still accepts marks, claims and posts.
- **Given** an archived Event, **when** the app has mounted, **then** the read-only surface is driven by `EventDoc.status`, while addressing was driven by the routing document's `status`—two fields, two audiences, two times.

**D9 — the root's create affordance today**

- **Given** provisioning is not available, **when** the doorway renders, **then** the create affordance shows an explicit not-yet-open state naming what it waits on, and the wizard is not mounted. **This is the state today.**
- **Given** provisioning is available, **when** the doorway renders, **then** the create affordance links to the wizard's own route and does not mount the wizard at `/`.
- **Given** either state, **when** the doorway renders, **then** it performs no pre-paint network read to decide which state it is in.
- **Given** the affordance opens, **when** the wizard is entered, **then** it consumes #787's shipped `EventDraft` / `OccasionDef` contract and re-derives no draft semantics.

## Test coverage

**None here, and that is the deliverable's shape rather than a gap.** This spec ships no runtime surface: no route, no Worker, no rule, no component. Its frontmatter carries `tested: false` with a `reason:`, which is this repo's CI-enforced convention for a spec with nothing to execute (`scripts/ci/check_spec_test_alignment`; the precedent is `specs/x-multi-event-schema.md`, likewise design-only).

Tests land with the implementation tickets this spec blocks, each against the criteria above, and each ticket carries its own obligation rather than inheriting a vague one:

- **The address parser and the resolution extension** (D3) — unit tests over `parseAddress` and the third resolution outcome, in the shape `src/eventResolution.test.ts` already uses: pure, injected `fetchDoc`, no network. Must include the reserved-segment and dot-segment refusals, the `get`-not-`list` assertion, and the missing-`pathNamespace` fail-closed default.
- **The reserved-path module** (§ Reserved paths) — a shared-source test asserting the client parse, the Worker check (#545) and the wizard validation (#790/#793) all read one list, plus a guard that every frozen tab path is in it, so a tab table edit cannot silently free a reserved word.
- **The root doorway** (D1, D9) — component tests per host class, including that a mirror never renders a create affordance and that the not-yet-open state does no network read.
- **Non-installability** (D4) — a worker-source guard extending `src/sw-auth-handler-denylist.test.ts`'s existing pattern, plus component tests that no manifest link and no install affordance render on a path-addressed surface.
- **Share composition** (D5) — extends the existing per-surface share-`url` pins in `src/components/w2-share-cards.test.tsx` and `src/canonicalHost.test.ts` to assert the prefix survives.
- **The archive interlock** (D8) — rules and resolver tests over the status matrix **and the `apexPath` eligibility matrix** (an active Event in a path-enabled namespace without `apexPath` must be not-found at an apex path, while remaining reachable on a mirror), a single-transaction test covering every routing document plus `EventDoc.status` together, and — the case the first draft of this spec got wrong — a test that a **fresh** cached `active` entry does not silently outlive the flip.
- **The installed-app refusal** (D4) — a test that a path-addressed route in a standalone display mode refuses to mount and renders the open-in-a-browser screen, since this is the only defence available against a stored manifest scope that cannot be revoked from the server.
- **The mandatory archive cache opt-out** (D4) — a test that an apex archive runs with Firestore persistence and the card cache disabled, guarding the premise ADR 0009 and `x-multi-event-schema.md` both rest on.
- **The resolution contract's three hazards** (D3) — a cache-key test proving two slugs on one origin cannot consume each other's mapping, a subscription test proving `watchAdultContent()` follows the resolved routing document rather than `window.location.hostname`, and a timing test proving both reads share one `timeoutMs` rather than two.
- **The env short-circuit precondition** (D1) — a guard that a target baking `VITE_EVENT_ID` cannot also be declared a doorway or path-addressing host, so the rebuild precondition fails loudly in config rather than silently at runtime.

Validation for *this* ticket is review-based, per #799: every one of the nine questions has a decision with Given/When/Then criteria above; the three regimes are one table; the reserved list, the non-installability requirement and the archive interlock are stated as requirements; and `specs/x-multi-event-schema.md` no longer contradicts any of it.
