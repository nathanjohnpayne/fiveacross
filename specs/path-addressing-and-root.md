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
| What `/` serves on that host | the Event itself | the doorway (D1) | **the host's flagship Event** (#625, unchanged) |
| Governing decision | ADR 0009, unchanged | #766, new here | #626, new here |
| Why this regime | Subdomains are purchasable—a DNS record we control—and only a separate origin buys installed-app isolation | The root is wanted for creation, and an archive has no isolation left to protect | `<slug>.<project>.vercel.app` is Vercel's namespace, not ours; paths are the *only* mechanism, not the cheaper one |
| Router `basename` | none | `/<slug>` | `/<slug>` |
| Installable | **yes** | **no** (§ Non-installability) | **no** (§ Non-installability) |
| Manifest served | yes, per-host (#546) | **never at the path** | **never at the path** |
| Service-worker scope | origin root | must not claim the path (§ Non-installability) | must not claim the path |
| Offline cold boot | yes (ADR 0006) | no | no |
| Camera / proof capture | yes | no—read-only | inherits the Event's own posture, minus install |
| Event lifecycle admitted | `active` only | `active` (migration window) and `archived` | `active` and `archived` |
| Share URL composed as | this origin, no prefix | this origin **plus** `/<slug>` | this origin **plus** `/<slug>` |
| Analytics host dimension | the Event's canonical host | the Event's canonical host | the Event's canonical host |
| Sign-in reachable | yes | yes | yes—all three mirrors are first-party (D7) |

The single sentence a reader should leave with: **(a) is the full product; (b) and (c) are narrower reaches at the same `eventId`, and the narrowing is the reason they are allowed to exist on a shared origin at all.**

## Binding constraints this spec designs against

Restated rather than re-litigated, because every decision below is shaped by them.

- **Every serving host serves in place.** #625's mirror-only rule ("the backup must work precisely when the canonical host is blocked"), generalised by #599's 2026-08-05 amendment to the whole system. **A path-addressed archive or mirror-host Event must never HTTP-redirect to a subdomain**, and no domain that legitimately serves is ever bounced off itself.
- **A slug is not a secret.** `specs/hostnames-lookup.md`: knowing one grants nothing, because every read of Event data still passes the membership gate. A path segment inherits this exactly—`/bodega-bay` in a URL bar discloses nothing `hostnames/{host}` does not already.
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

**The root does not host the wizard's steps.** #788's shell owns the wizard's own route; the doorway links to it. Mounting a five-step flow at `/` would put the wizard on the one path that must stay cheap, dependency-light and correct before any Event is known—and would collide with the reserved-path rule the moment a step wanted a sub-path.

### D2 — Path and hostname are not equivalent origins

`fiveacross.app/bodega-bay` is **not** the same identity as `bodega-bay.vacaybingo.com` for sessions, install or offline cache, and is not meant to become one.

For the mirror regime this is arithmetic: a different origin is a different origin, so cookies, storage and permissions are separate by construction. For the apex-archive regime it is a deliberate choice, and the more important half. The path surface shares an origin with every other archive on that apex and with the doorway itself, so it inherits precisely the ceilings ADR 0009 named—one storage quota, origin-scoped permission grants, all-or-nothing site-data clearing, no browser-enforced boundary. The resolution is not to buy those back with application code; it is to **not need them**, by never granting the path surface a capability that depends on them (D4).

So the contract to state plainly, because the tempting reading is the wrong one: the path surface is a *narrower reach at the same `eventId`*, not an alias of the subdomain. Two consequences follow and both are intended. A Player signed in on the subdomain is not thereby signed in on the apex path; that is one sign-in per origin, the same as any two web apps. And an Event reachable both ways during the migration window (D8) genuinely has two surfaces of different capability at once—which is the same shape regime (c) has always had, not a new hazard.

**Serve-in-place forbids fixing this with a redirect, and does not forbid saying so.** A path surface must never navigate a visitor to the subdomain automatically. It **may** render an explicit, user-initiated affordance—#625 already specified its exact shape for the mirror case, and the same shape applies to an apex archive path: "when the canonical IS reachable, a dismissible 'continue on `<canonical>`' banner, never automatic." A banner the Player chooses to follow is not a domain bouncing a visitor off itself. On an archived Event there is no such link to offer, because there is no longer a subdomain serving (D8).

### D3 — Resolution and the router `basename`

**Parse before you resolve, and resolve before you mount.** `specs/event-resolution.md` already requires the Event to be known before first paint; path addressing adds one step in front of it and no new network read.

1. **Parse.** A pure function—call it `parseAddress(hostname, pathname)`—splits the first path segment off `location.pathname`. It answers `{ slug: string | null, basename: string }` and nothing else: no I/O, no Firestore, no router. A segment that is reserved (§ Reserved paths) or that contains a `.` yields `slug: null` and an empty basename, so an app route and an asset request are never mistaken for an Event address.
2. **Resolve.** The serving host's own `hostnames/{host}` document is read exactly as today. **Whether that host does path addressing is decided by one optional field on it, `pathNamespace`—not by whether it is an Event document or a root marker.** When `pathNamespace` is present and a slug was parsed, resolution reads `hostnames/{slug}.{pathNamespace}` and serves that Event; otherwise the host's own document answers and the path segment is an app route.

   Keeping those two facts independent is what makes regime (c) work. A brand mirror's document names a **flagship Event** (#625) *and* carries `pathNamespace`, so `/` serves the flagship and `/<slug>` reaches any other Event in the mirrored namespace—exactly #626's own sketch: "Resolution maps (mirror-host brand, slug) → the canonical `hostnames/{slug}.<brand-domain>` document — reusing the existing world-readable get, no new data shape. Bare mirror root falls back to the `hostnames/{mirror-host}` flagship doc." A doorway apex carries a root marker *and* `pathNamespace`, so `/` serves the doorway and `/<slug>` serves an archive. A live Event subdomain carries neither a marker nor a `pathNamespace`, so every path on it is an app route and the basename stays empty—regime (a), unchanged.
3. **Thread.** The parsed basename is passed to `<BrowserRouter basename>` in `src/main.tsx`, which mounts with none today. The frozen tab table (`src/components/tabs.ts`) and every `NavLink` re-base together for free, which is exactly why the basename is the mechanism rather than a prefix-aware route table.

**Deriving the subdomain from the path is the load-bearing trick, and it is what keeps the disclosure contract intact.** No new collection, no new rules, no reverse index: `hostnames/{host}` stays `allow get: if true; allow list: if false`, and resolving `/bodega-bay` is still a `get` of an address the caller already typed. A slug→Event index would have been the obvious alternative and is rejected on exactly that ground—it is the shape that turns a set of unguessable addresses into something a directory could be built from, which is the property `specs/hostnames-lookup.md` exists to protect.

`pathNamespace` is one optional field on the root marker, and its absence is the fail-closed default: **a host with no `pathNamespace` does not do path addressing at all**, and every path on it is an app route. The mirrors map to the namespace they mirror (`fiveacross.vercel.app` → `fiveacross.app`; `vacaybingo.vercel.app` → `vacaybingo.com`; `gaycruisebingo.vercel.app` → `gaycruisebingo.com`), which is also the mapping that makes regime (c) work for an Edition apex that issues no subdomains: the mirror addresses by path what its apex addresses by being.

**An unresolvable slug renders not-found, never the doorway.** `fiveacross.app/nope` must not silently become `fiveacross.app`, because a wildcard fallback to `/` is precisely how a mistyped address would look like a working one. The existing `<Route path="*">` fallback in `src/App.tsx` stays correct *inside* a resolved basename and must not be the thing that swallows an unknown first segment—the parse in step 1 runs before the router exists, which is what keeps those two cases distinguishable.

### D4 — Non-installability is a requirement, not a guideline

**Every path-addressed surface is non-installable.** Regimes (b) and (c) both, and this is stated as a requirement because it is the condition on which ADR 0009's rejection is narrowed rather than contradicted. Concretely, and each clause is separately checkable:

- **No manifest is served at, or linked from, a path-addressed document.** The `<link rel="manifest">` is absent. The per-host manifest #546's Worker serves is a property of a host, and a path is not a host.
- **`beforeinstallprompt` is never consumed on a path-addressed surface.** `src/hooks/useInstallPrompt.ts` gates on the address regime, and `InstallPrompt` never mounts—including the iOS "Show me" branch, which fires no event and would otherwise slip through a listener-shaped guard.
- **The service worker never claims a path-addressed route.** Registration scope is the origin root, so a worker registered by the *doorway* would otherwise control every archive path under it. The requirement is on the navigation route, not on registration: the worker's `NavigationRoute` gains a denylist for path-addressed routes, the same mechanism and the same file (`src/sw.ts`) that already keeps it off Firebase's `/__/*` namespace (`specs/sw-auth-handler-denylist.md`). Reusing that seam matters—#182 is the shipped proof that a navigation fallback silently swallowing a route it should not own is a live failure mode here, not a theoretical one.
- **A path-addressed navigation is never served the precached shell.** It falls through to the network, which is the same statement as the bullet above from the Player's side, and the reason regime (b) has no offline cold boot to promise.

This is ADR 0009's own named mitigation—"the nested-install breakage … is avoidable by never making the origin root installable"—promoted from a note to a requirement and extended from the root to every path under it. #626 reached the identical conclusion independently from the collision direction: path-scoped installs on a shared origin collide, so the only safe number of installable surfaces per origin is one, and on a doorway origin it is zero.

**The doorway itself is not installable either.** An organiser does not install a create form, and an installable root is the exact thing ADR 0009 says never to build.

**A brand mirror's flagship root is the one deliberate exception, and it is consistent rather than grudging.** The rule the whole section rests on is that the only safe number of installable surfaces per origin is **one**, and on a doorway origin it is zero. A mirror origin serves exactly one Event at `/` (#625) and everything else by path, so leaving `/` installable spends that single budget on the surface #625 exists for and leaves nothing for a path to collide with. The invariant to implement against is therefore not "paths are non-installable" but **"at most one installable surface per origin, and never a path"**—stated this way because a guard written as "suppress install when a basename is present" satisfies both readings, while a guard written as "suppress install on mirrors" would wrongly dark the flagship.

### D5 — Share URLs keep the entry-point surface, path included

[#607](https://github.com/nathanjohnpayne/gaycruisebingo/issues/607)'s rule—a share is composed from the origin the sharer is standing on, never rewritten to the Event's canonical host—applies to path-addressed surfaces **symmetrically**, and applies to the path as well as the origin. A share from `fiveacross.vercel.app/bodega-bay` is `https://fiveacross.vercel.app/bodega-bay/...`; a share from `fiveacross.app/bodega-bay` keeps that apex and that prefix. Neither is rewritten to `bodega-bay.vacaybingo.com`.

The reason is #607's own: every serving host stays live and brands dynamically, so a link rewritten to another host unfurls and lands the recipient under a different Edition's brand—and, worse on a mirror, sends them back to the host that was blocked when the sharer reached for the backup.

**This is a real seam, not an inherited property.** `shareOrigin()` (`src/canonicalHost.ts`) returns `window.location.origin` and nothing else, so a share composed from it today would **drop the path prefix and land recipients on the doorway**. The three Web Share call sites (`Leaderboard.tsx`, `FarewellPodium.tsx`, `Celebration.tsx`) compose against it. Path addressing therefore needs share composition to go through the resolved basename—stated here so the implementation ticket is filed against a known defect rather than discovering it in production.

### D6 — Analytics canonicalise the host and record the surface

Both halves, because they are different dimensions answering different questions.

**The host dimension stays canonical.** Per #599, analytics report the Event's one resolved canonical host regardless of entry point, so cross-host traffic aggregates instead of splitting three ways. Path addressing changes nothing here: `applyResolvedCanonicalHost` installs the value the *Event's* routing document names—reached by path or by host, it is the same document, so it is the same value. `canonicalizeOrigin` (`src/posthog.ts`) and `currentPageLocation()` (`src/analytics.ts`) already rewrite only the **origin** of a URL, which means the path prefix survives canonicalisation untouched and needs no new code to be preserved.

**The entry surface is recorded separately, as its own dimension.** Which of the three regimes a visit arrived through is useful signal (#584/#601)—it is how "the canonical host is blocked again" becomes visible, and how archive traffic is told apart from live play. It must not be recovered by string-matching `$pathname`, which would silently conflate an archive path with an app route the moment either changes. A first-class regime dimension (`live-subdomain` / `apex-path` / `mirror-path`) is the contract.

The two together are the point: **the Event aggregates, the door is counted.**

### D7 — Auth reachability is a property of the host, and stays one

`isSignInReachableOnHost` (`src/auth-domain.ts`) gates on hostname and takes no path, and that is correct rather than a gap to close. The OAuth helper lives at `/__/auth/*`, an **origin-level** reserved namespace: Firebase Hosting serves it same-origin, `vercel.json`'s rewrites are host-conditional, and the Google OAuth client matches `redirect_uri` per origin. Nothing about a path can make sign-in more or less completable, so the predicate is asked the same question on `fiveacross.app/bodega-bay` as on `fiveacross.app`, and `parseAddress` discards the path before it is consulted—the shape `firebaseAuthOriginRedirectUrl` already uses, which takes a location and keeps only the hostname.

**#799's premise on the mirrors needs correcting, and the code is the evidence.** All three brand mirrors are in `FIRST_PARTY_AUTH_HOSTS`, so `isAuthConfiguredForHost` is true for them and sign-in completes. `specs/event-resolution.md` says so in its own acceptance criteria: the `auth-unconfigured` developer note fires on a `*.vercel.app` hostname "by construction a per-deployment preview host, **since every registered Vercel host is in `FIRST_PARTY_AUTH_HOSTS`**." The developer note is for unregistered per-deployment preview hosts, not for the three registered mirrors. **A path-addressed Event on a brand mirror needs no `auth-unconfigured` treatment**, and ADR 0010's central-auth handoff is not a blocker for regime (c).

**An archive requires sign-in exactly as the live Event did.** It is not world-readable. Every read of Event data passes `signedIn()` today and the membership gate after it lands, and an archive is the same data at the same paths—`EventDoc.status` changes what serves it, not who may read it. What renders before sign-in is what already renders before sign-in: the gate, branded by the resolved Edition, with the `preview` postcard from `hostnames/{host}` when the document carries one (#647). That is display copy the page shows anyone regardless, so nothing widens. This is also what keeps the retained non-goal true—an archive at a path is not a public directory entry, because reaching it still gets you a sign-in screen.

### D8 — The archive interlock, proposed for #134

[#134](https://github.com/nathanjohnpayne/gaycruisebingo/issues/134) is the ticket that will start setting `EventDoc.status: 'archived'`; nothing reads the field today. Rather than let #134 discover this requirement, the condition is proposed here.

**The interlock rides the `hostnames/{host}` document's own `status`, not `EventDoc.status`.** This is forced, not preferred: the Event document requires `signedIn()`, so its status cannot be consulted before first paint, which is when the addressing decision has to be made. The routing document's `status` is already `active | disabled | archived` (`specs/hostnames-lookup.md`) and already world-readable. The interlock is therefore a rule about which statuses serve **through which door**:

| `hostnames/{host}.status` | Served at its own host | Served by path on its namespace root |
|---|---|---|
| `active` | **yes**—regime (a) | **yes**—regimes (b) and (c) |
| `archived` | **no**—not-found | **yes**—regimes (b) and (c) |
| `disabled` | no | no |

Read off the three answers #799 asks for:

- **Does path-addressability require `status: 'archived'`? No.** An `active` Event is reachable at a path today, which is what makes the migration window work and what makes regime (c) possible at all—mirrors serve live Events by path as their entire purpose.
- **Does the subdomain keep serving after archival? No, and the same write ends it.** Flipping one document from `active` to `archived` retires the subdomain and promotes the path in a single atomic change. There is no window where both serve and none where neither does. This also needs no new field and no rules change: `specs/event-resolution.md` already refuses to serve a non-`active` status at its own host, and already **drops** the cached entry rather than expiring it, so an installed client stops serving the archived Event on its next boot instead of at the 12-hour TTL.
- **Does path-addressing replace the subdomain? Yes—on archival, and only then.** Before it, the two coexist with different capabilities (D2).

**#134 owns two obligations this creates.** First, the flip must write both documents in one transaction when an Event has more than one routing document—Bodega has three—or the Event is archived on one host and live on another. Second, the Event's *own* `status: 'archived'` is what the app reads after mount to draw a read-only surface; the routing status decides addressing, the Event status decides behaviour, and #134 sets both. They are deliberately two fields because they answer to two different audiences at two different times, and collapsing them would put an authenticated read on the pre-paint path.

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

**D2 — path is not an equivalent origin**

- **Given** a Player signed in at `bodega-bay.vacaybingo.com`, **when** they open `fiveacross.app/bodega-bay`, **then** they are not signed in there—the surfaces share an `eventId`, not a session.
- **Given** a path-addressed surface, **when** it renders, **then** it never navigates the visitor to the Event's subdomain automatically; **and given** the Event is still live, **then** it may offer a user-initiated link to the installable address.
- **Given** an archived Event, **when** its path surface renders, **then** no link to a subdomain is offered, because none serves.

**D3 — parsing, resolution and basename**

- **Given** `location.pathname` of `/bodega-bay/feed` on a root-marker host, **when** `parseAddress` runs, **then** it answers `slug: 'bodega-bay'`, `basename: '/bodega-bay'`, performing no I/O.
- **Given** a first segment that is reserved or contains a `.`, **when** `parseAddress` runs, **then** it answers `slug: null` and an empty basename.
- **Given** a root marker with `pathNamespace: 'fiveacross.app'` and the slug `bodega-bay`, **when** resolution runs, **then** it reads `hostnames/bodega-bay.fiveacross.app` by `get`, and issues no collection query at any point.
- **Given** a brand mirror whose document names a flagship Event **and** carries `pathNamespace`, **when** `/` is loaded, **then** the flagship Event serves; **when** `/<slug>` is loaded, **then** that slug's Event serves—the two coexist on one document.
- **Given** a serving host with no `pathNamespace`, **when** any path is requested, **then** no path addressing is attempted and the segment is treated as an app route.
- **Given** a first segment that resolves to no routing document, **when** the app starts, **then** it renders not-found—never the doorway, and never a redirect to `/`.
- **Given** a live Event subdomain, **when** the app mounts, **then** the router mounts with no basename and the frozen tab paths are unchanged.
- **Given** a resolved basename, **when** a tab `NavLink` navigates, **then** the prefix is preserved without any per-link change to the frozen tab table.

**D4 — non-installability**

- **Given** a path-addressed surface in either regime, **when** the document renders, **then** it links no manifest.
- **Given** a path-addressed surface, **when** the browser fires `beforeinstallprompt`, **then** the app does not consume it and no install affordance renders—including the iOS branch, which fires no event.
- **Given** a service worker registered at the origin root of a doorway host, **when** a navigation to a path-addressed route occurs, **then** the navigation route does not match it and the precached shell is not served.
- **Given** the worker source, **when** it registers the navigation route, **then** that route carries a denylist covering path-addressed routes alongside the existing `/^\/__\//` pattern.
- **Given** a doorway host, **when** `/` renders, **then** it is not installable either.
- **Given** a brand mirror, **when** its flagship Event renders at `/`, **then** it remains installable exactly as today; **when** any `/<slug>` renders on that same origin, **then** it is not—at most one installable surface per origin, and never a path.

**D5 — share composition**

- **Given** a share initiated from `fiveacross.vercel.app/bodega-bay`, **when** the URL is composed, **then** it carries that origin **and** the `/bodega-bay` prefix, and is not rewritten to the Event's canonical subdomain.
- **Given** a share initiated from `fiveacross.app/bodega-bay`, **when** the URL is composed, **then** the same holds—the rule is symmetric across regimes (b) and (c).
- **Given** a share initiated from a live Event subdomain, **when** the URL is composed, **then** it carries no path prefix, exactly as today.

**D6 — analytics**

- **Given** a visit through any of the three regimes, **when** analytics report the host dimension, **then** it is the Event's one resolved canonical host.
- **Given** a path-addressed visit, **when** the URL is canonicalised for analytics, **then** only the origin is rewritten and the path prefix survives.
- **Given** a visit, **when** it is recorded, **then** the entry surface is reported as a first-class regime dimension (`live-subdomain` / `apex-path` / `mirror-path`), not inferred by string-matching a pathname.

**D7 — auth reachability**

- **Given** any path-addressed surface, **when** `isSignInReachableOnHost` is consulted, **then** it is passed the hostname only and its answer is identical to the answer for that host's `/`.
- **Given** a path-addressed Event on any of the three brand mirrors, **when** the app boots, **then** it mounts and offers sign-in—no `auth-unconfigured` state and no developer note, because every registered Vercel host is first-party.
- **Given** an archived Event reached at a path, **when** a signed-out visitor loads it, **then** the sign-in gate renders—branded by the resolved Edition, with the `preview` postcard when the routing document carries one—and no Event data is readable without signing in.

**D8 — archive interlock**

- **Given** a routing document with `status: 'active'`, **when** it is reached at its own host **or** by path on its namespace root, **then** it serves in both cases.
- **Given** a routing document flipped to `status: 'archived'`, **when** it is reached at its own host, **then** it renders not-found and the cached entry is **dropped**; **when** it is reached by path, **then** it serves.
- **Given** `status: 'disabled'`, **when** it is reached either way, **then** it serves in neither.
- **Given** an Event with more than one routing document, **when** #134 archives it, **then** every one of those documents flips in a single transaction—no Event is archived on one host and live on another.
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
- **The archive interlock** (D8) — rules and resolver tests over the status matrix, and a transactional-flip test on #134's writer.

Validation for *this* ticket is review-based, per #799: every one of the nine questions has a decision with Given/When/Then criteria above; the three regimes are one table; the reserved list, the non-installability requirement and the archive interlock are stated as requirements; and `specs/x-multi-event-schema.md` no longer contradicts any of it.
