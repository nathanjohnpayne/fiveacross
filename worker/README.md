# `worker/` — the Five Across Event router

One versioned Cloudflare Worker in front of the wildcard Namespaces `*.fiveacross.app` and `*.vacaybingo.com`, so a new Event needs no DNS record, no Hosting custom domain, no certificate and no Worker route of its own. Implements [#545](https://github.com/nathanjohnpayne/fiveacross/issues/545) under epic [#529](https://github.com/nathanjohnpayne/fiveacross/issues/529); the behavioural contract is [`specs/event-router.md`](../specs/event-router.md), and the Event-identity model it consumes is [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md).

## What it is, and the two things it is not

It is a **router** and a **namespace guard**. It validates the hostname's Namespace and first label against the Slug contract, resolves the address through the registry's named lookup-only entrypoint, fails closed on anything that is not an explicit active match, and proxies what survives to the Firebase Hosting origin with a rewritten `Host` header. It also answers one same-origin endpoint from that same lookup — `/.well-known/fiveacross-path-capability` — so the service worker can decide whether a first path segment is an address without a second source of truth.

It answers exactly one address itself: `GET`/`HEAD /manifest.webmanifest`, with the installed-app identity of the Edition the requested hostname resolved to ([#546](https://github.com/nathanjohnpayne/fiveacross/issues/546)). That route sits **after** the namespace guard and **after** resolution, so it is not an exemption like `/__/auth/*` — an address that does not serve an app does not serve an app identity either. The document comes from `src/web-manifest.ts`, the same module `vite.config.ts` emits `dist/manifest.webmanifest` from, so the origin's file and the edge's response are the same bytes for the same Edition.

It is **not a canonicaliser**. [#599](https://github.com/nathanjohnpayne/fiveacross/issues/599) as amended removed edge canonicalization: every registered host serves in place, and a serving domain is never bounced off itself. There is no code path in this directory that constructs a redirect, and `router.test.ts` sweeps every outcome asserting none appears. The canonical hostname still exists — its job is analytics aggregation and being the name printed on things, not being a redirect target — and share links deliberately carry the entry-point host ([#607](https://github.com/nathanjohnpayne/fiveacross/issues/607)).

It is **not an authorization layer**. The application still verifies membership before reading any Event data. As of [#972](https://github.com/nathanjohnpayne/fiveacross/issues/972) the router holds no Firebase credential at all — not a service-account key, and no longer the web API key either — so the ceiling is enforced by the shape of its one binding rather than by a promise this code makes about itself.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | The only file that knows it is running on Cloudflare: binding parsing and the exported handler. Two seams, no platform stores. |
| `src/router.ts` | The request pipeline — guard, auth passthrough, resolve, path capability, manifest, proxy or fail closed. |
| `src/host.ts` | The pure Namespace and reserved-label guard, including the two closed rehearsal classes. |
| `src/resolve.ts` | The bounded registry lookup and the fail-closed decision table. |
| `src/manifest.ts` | The per-hostname PWA manifest response (#546) — with the path capability, one of the two bodies the router constructs besides the fail-closed page, and answered from the same lookup. |
| `../src/web-manifest.ts` | The manifest document itself, shared with `vite.config.ts`. One builder, two consumers, so the built file and the edge response cannot drift. |
| `../src/edition-brands.ts` | The Edition brand table, shared with the app. Split out of `src/editions.ts` in #546 because this program has no DOM lib and no `vite/client`. |
| `src/notFound.ts` | The rendered Event-not-found page. |
| `../src/slug.ts` | The Slug contract, shared with the Event-setup wizard's address step. One list, never two. |
| `src/registry/` | The separately deployed private registry control plane: signed sync/recovery, per-host Durable Object state, named lookup-only entrypoint, and synthetic-only harness adapter. |
| `router-configuration.d.ts` | Wrangler's generated binding types for `wrangler.toml`; `npm --prefix worker run check:router-types` re-checks it. See § The registry lookup binding. |
| `wrangler.registry.toml` | Registry-owned Durable Object, rate limiter, observability, and workers.dev control endpoint; it has no Namespace route or KV. |
| `wrangler.registry-harness.toml` | Unrouted synthetic harness bound explicitly to `RegistryLookupEntrypoint`; it cannot reach the registry's default `fetch`. |

The registry configurations are intentionally separate from the public router's `wrangler.toml`. Building or dry-running them does not attach a wildcard, apex, real-Event, or synthetic exact route. Ticket #970 leaves their immutable identity/public-key records fail-closed until reviewed provisioning and performs no deployment; later rehearsal tickets may consume only the bounded synthetic manifest described by the registry spec.

Everything with a decision in it is free of Cloudflare types and takes its platform seams (`fetch`, `registry`) as injected arguments — the convention [`specs/event-resolution.md`](../specs/event-resolution.md) sets for the client resolver, for the same reason: it lets the whole decision table be proved by the repo's ordinary `npm test`, with no workerd, no emulator and no network.

## The registry lookup binding

The router resolves addresses through a Cloudflare **service binding** to the separately deployed registry Worker, and the binding names its entrypoint explicitly:

```toml
[[services]]
binding = "REGISTRY"
service = "five-across-event-registry"
entrypoint = "RegistryLookupEntrypoint"
```

That third line is the capability boundary, and it is one word away from being the opposite of one. `RegistryLookupEntrypoint` is a `WorkerEntrypoint` exposing a single method, `lookup(host)`. Omit `entrypoint`, or write `default`, and the identical-looking binding reaches the registry's *default export* instead — the signed sync/audit/recovery control plane — handing a public edge Worker the private control surface. Neither spelling is left to review: `scripts/event-router-registry/harness-config.mjs` validates the block, `scripts/worker-deploy.sh` runs that validator before it installs or publishes anything, and `src/routerBinding.test.ts` rejects the omitted, `default` and wrong-entrypoint forms.

The validator parses the **whole** configuration with a TOML parser (`smol-toml`) and then judges the parsed object, rather than scanning for lines that look like a binding. It requires the top level to declare exactly one `services` entry carrying exactly the three keys above, and refuses anything it cannot read — an undefined escape, a duplicated key, a `services` value that is not an array of tables — because "unreadable" and "absent" must not be the same answer in a capability check. The key set is exact rather than minimal because the binding's other schema fields change what it reaches: `environment = "…"` binds a named environment of the *target* service, a different deployment of the registry whose `RegistryLookupEntrypoint` is whatever that deployment exports.

**This file may also declare no `unsafe` table.** `[[unsafe.bindings]]` is Wrangler's escape hatch for bindings its schema does not model, and an entry with `type = "service"` is a service binding like any other — a second one, needing no environment and no command-line flag. A gate that counted only the `services` array would certify a file that uploads two.

**And the top level is an allowlist, not a deny-list.** Only the keys in the validator's `TOP_LEVEL_KEYS` may appear — `name`, `main`, `account_id`, `compatibility_date`, `compatibility_flags`, `workers_dev`, `preview_urls`, `observability`, `logpush`, `upload_source_maps`, `send_metrics`, `keep_vars`, `minify`, `limits`, `placement`, `vars`, `services`, `routes` and singular `route` — and anything else is refused by name. The list is longer than the boundary needs because refusing a capability-free deployment setting would be a gate to switch off rather than a gate: `preview_urls = false` and `send_metrics = false` are hardening, `placement` and `limits` are runtime shape, and none of them can reach another Worker's bindings. A binding does not have to be a `services` entry to reach the registry — `[[durable_objects.bindings]]` carrying `script_name = "five-across-event-registry"` binds its `HOST_REGISTRY` namespace directly, which is precisely the capability the named entrypoint exists to withhold, and it adds nothing for a count of service bindings to find. Enumerating the binding types to forbid would leave whatever Cloudflare ships next unlisted; enumerating what this file may contain does not, and makes a new top-level key a deliberate review moment. (`routes` is on the list because attaching it *is* the cutover and the guarded deploy supports a route-bearing run; keeping the wildcard blocks commented is `src/routerBinding.test.ts`'s assertion, not the validator's.)

Finally, the guard checks that `wrangler.toml` is the file Wrangler would actually read, which is a question about the filesystem rather than about the file. Wrangler resolves by **filename precedence first and directory second**: it searches every ancestor of the working directory for `wrangler.json`, then every ancestor for `wrangler.jsonc`, and only then for `wrangler.toml`. `npm --prefix worker run deploy` runs with the working directory set to `worker/`, so a `wrangler.json` anywhere from `worker/` up to the filesystem root wins — silently, with no warning that the TOML was ignored, and from outside the repository where no clean-tree guard can see it. `wrangler deploy` also honours a redirect at `worker/.wrangler/deploy/config.json`, which is gitignored and therefore invisible to `git status` too. The guard refuses both, testing for a real file the way Wrangler's own resolver does so a *directory* of that name is not a false positive.

Route-bearing is read the same way, off the same parsed document: the guard prints whether the configuration attaches routes and the wrapper announces "changes nothing the public sees" only on that answer. It was a line grep for `^\s*routes\s*=`, which is blind to `[[routes]]` and to a quoted `"routes" = [ … ]` — both of which Wrangler resolves into real routes, and the first of which is the shape the commented cutover block uses.

One boundary this gate does not cover, stated rather than implied: it certifies the configuration, not the command. `scripts/worker-deploy.sh` runs `npm --prefix worker run deploy`, so `worker/package.json`'s `deploy` script is trusted to be a plain `wrangler deploy` — `src/routerBinding.test.ts` asserts exactly that, which is a CI check on the committed file rather than a runtime one.

**This file may declare no named environment.** Wrangler does not inherit service bindings into one — its schema says they are "not automatically inherited from the top level environment" and "must be specified in every named environment" — and `CLOUDFLARE_ENV` selects an environment with no command-line flag, which `scripts/worker-deploy.sh` forwards like any other variable. So an `[env.<name>]` has only two possible contents and this gate can certify neither. Declare a binding there and it is a second copy of the capability boundary, selectable through an environment variable, that no reviewer of the top-level block would see. Declare none and `CLOUDFLARE_ENV=<name>` publishes a router carrying no registry binding at all, which answers `lookup-unavailable` on every address while reporting a clean deploy. [`specs/event-router-registry.md`](../specs/event-router-registry.md) authorises no routed environment, so the deploy gate refuses the `env` key outright; wanting one changes what this gate claims and belongs in that spec first. (The temporary preview environment in § *2. Rehearse the code* below is `wrangler dev --remote`'s own, not an `[env.<name>]` block.) Refusing the key rather than its spellings is what makes the refusal total: a table header, a dotted key, an inline table and a quoted key all parse to the same root `env`.

`router-configuration.d.ts` is Wrangler's own generated view of the same binding — `Service<typeof RegistryLookupEntrypoint>` — committed as evidence and held against `wrangler.toml` by that test. It is deliberately outside `tsconfig.json`'s `include`: it declares `Cloudflare.GlobalProps.mainModule`, as does the harness's generated file, and two conflicting declarations of the same property cannot merge in one program. `src/config.ts` therefore types `REGISTRY` as the one-method seam by hand, and a compile-time assertion in `src/routerBinding.test.ts` proves Wrangler's generated type satisfies it. Regenerate after any `wrangler.toml` edit:

```bash
npm --prefix worker exec -- wrangler types router-configuration.d.ts \
  --config wrangler.toml --config wrangler.registry.toml \
  --env-interface RouterBindings --include-runtime=false
```

**There is nothing behind the binding.** No Firestore, no KV, no `caches.default`, no negative cache and no stale-serve. The registry's per-host Durable Object is the single transactional owner of acceptance and lookup, so a second cached answer could only ever disagree with it; a lookup that cannot be completed within the 2,000 ms bound fails closed as `lookup-unavailable` rather than reaching for another source. That is the property that makes this router compatible with enforced Firestore App Check ([ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md)) instead of dependent on an exemption from it.

## Testing

```bash
npm test                 # from the repo root — worker/**/*.test.ts runs in the main suite
npm run typecheck        # includes worker/tsconfig.json (Cloudflare types, separate program)
npm run worker:dev       # real workerd via `wrangler dev`, for the things a unit test cannot prove
```

`npm run worker:dev` installs `worker/`'s own dependencies first, mirroring how `npm run test:functions` handles the separately-rooted Functions project. Point a request at it with an explicit `Host`, since local wrangler serves on `localhost`:

```bash
curl -sI http://localhost:8787/ -H 'Host: bodega-bay.fiveacross.app'
curl -sI http://localhost:8787/ -H 'Host: admin.fiveacross.app'      # expect 404, reason reserved-label
```

**It starts BOTH Workers** — `wrangler dev -c wrangler.toml -c wrangler.registry.toml` — because a service binding connects to another Wrangler dev process rather than to a config file. Started with the router's config alone, Wrangler reports `env.REGISTRY … local [not connected]` and every otherwise-valid address answers `lookup-unavailable`: the guard, the auth pass-through and the fail-closed paths still work, but the one thing local dev exists to exercise does not.

Two things to know before you debug the wrong thing:

- **The pinned Wrangler must bundle a `workerd` at least as new as `wrangler.registry.toml`'s `compatibility_date`.** When it does not, the registry service refuses to start with `service core:user:five-across-event-registry: This Worker requires compatibility date "…", but the newest date supported by this server binary is "…"`, and the binding stays unconnected. The fix is a Wrangler bump in `worker/package.json`, never a change to the registry's compatibility date, which is a property of the deployed service rather than of your laptop.
- **Local dev gives the registry an EMPTY Durable Object**, so every host resolves as `unknown-host` until something publishes a projection into it. That is itself the useful signal that the binding is live — `unknown-host` means the RPC reached an empty object, where `lookup-unavailable` means it did not reach one at all. Use `wrangler dev --remote` (below) when you need real committed state.

## Deploying and attaching

**The deliverable of #545 ends at "deployable, tested, documented". Attaching the routes is the cutover, and the cutover is a human step** — it depends on the DNS work in [#539](https://github.com/nathanjohnpayne/fiveacross/issues/539) and on the PRD's Gate ladder. `wrangler.toml` therefore ships with `routes` commented out, so no deploy command can perform a cutover by accident.

### 0. The registry Worker must exist first

The router's `[[services]]` binding names `five-across-event-registry`, and Cloudflare rejects an upload whose service binding points at a script that does not exist. **Deploy the registry before the router**, per the R0 provisioning step in [`specs/event-router-registry.md`](../specs/event-router-registry.md) § Observability, rollout, and rollback. Ordering it this way is not an inconvenience to route around: a router that could deploy without its only lookup source would answer `lookup-unavailable` on every address while reporting a clean deploy.

### 1. Deploy, unrouted

```bash
npm ci --include=dev                 # ROOT: the deploy guard's TOML validator (smol-toml)
npm --prefix worker ci --include=dev  # pinned wrangler, from the committed lockfile
npm run worker:deploy                 # from the repo root
```

Both installs, and in that order. The guard verifies the registry binding **before** it installs the Worker toolchain, and it does that by parsing `wrangler.toml` with `smol-toml`, a root devDependency — so on a fresh deployment checkout a missing root install stops the deploy at the guard rather than at the publish. `npm ci`, never `npm install`: both lockfiles are part of the reviewed deploy. And `--include=dev` on both, because both things the deploy needs from these lockfiles — `smol-toml` and `wrangler` — are devDependencies, and a shell carrying `NODE_ENV=production` or `NPM_CONFIG_OMIT=dev` omits them without saying so; `npm config get omit` reports `dev` under either. `scripts/worker-deploy.sh` already forces it on the Worker install it runs itself, and the root install is the operator's to run.

Invoke wrangler through the local binary rather than a bare `npx wrangler`: `npx` would fetch whatever version the registry currently resolves, which defeats the point of pinning the toolchain in `worker/package-lock.json`.

There is **no `wrangler secret put` step any more.** The Firestore REST reader is gone, so the Worker carries no Firebase api key, project id, or other credential ([#972](https://github.com/nathanjohnpayne/fiveacross/issues/972), [ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md)). If a previous deployment still holds `FIREBASE_API_KEY`, remove it — the guarded deploy refuses to finish while it is bound:

```bash
npm --prefix worker exec -- wrangler secret delete FIREBASE_API_KEY
```

This uploads the Worker and publishes it on its `*.workers.dev` address only. Nothing about what the public sees changes.

**Deploy through `npm run worker:deploy`, never a bare `wrangler deploy`.** `wrangler` publishes the caller's working directory, not `origin/main`, and once the routes are attached this Worker fronts every wildcard Event hostname — so a bare deploy from a feature branch or a dirty tree would replace the router for every Event at once with code no reviewer has seen. `scripts/worker-deploy.sh` accepts only its explicit `--force` guard override; it refuses forwarded Wrangler flags, so neither an alternate entrypoint/configuration nor route attachment can piggyback on the guarded command. `--force` is limited to branch/freshness checks, while a dirty tree requires the separately auditable `DEPLOY_ALLOW_DIRTY=1` escape hatch.

Between this step and the next, the Worker is deployed but has nothing to resolve against if the registry holds no committed projection for a host — a state this procedure passes through on purpose. It answers `404` with `x-event-router-reason: unknown-host` on those addresses rather than erroring, which is a row of the table below.

### 2. Verify against production data, before any route exists

**Do not try to smoke-test this by curling the `*.workers.dev` address with a `Host` override.** It cannot work, and the reason is worth stating so nobody rediscovers it during a cutover: a request dispatched to the workers.dev address carries *that* hostname in `request.url`, and overriding `Host` changes the authority Cloudflare routes on (or is rejected as domain fronting) rather than presenting a different hostname to the router. The Worker would classify every such request as `out-of-namespace` and return `404`. That is correct behaviour — `host.test.ts` pins it — but it means workers.dev can only ever prove the refusal path.

Use `wrangler dev --remote` instead — as a **rehearsal of the code, not verification of the deployed artifact**. Be precise about what it does and does not prove, because the difference is where a cutover goes wrong:

- It **does** run this code on Cloudflare's network against the real registry service and the real Hosting origin, with the URL built from the `Host` header you send. That genuinely exercises routing, the reserved labels, the fail-closed paths, the path capability and the origin proxy.
- It **does not** execute the version you deployed in step 1. `wrangler dev --remote` uploads your local checkout into a temporary preview environment, so a green run here says nothing about what the deployed artifact holds.

```bash
npm --prefix worker ci                                  # if you have not already
npm --prefix worker exec -- wrangler dev --remote       # leave running; requests below go to localhost:8787
```

There is no `worker/.dev.vars` step: the router has no secret to supply. Its one dependency is the `REGISTRY` service binding, and `wrangler dev --remote` resolves that against the deployed registry Worker.

| Check | `curl -sI http://localhost:8787/ …` | Expected |
|---|---|---|
| A serving Event address | `-H 'Host: bodega-bay.fiveacross.app'` | `200`, the app shell, `x-event-router: v1`, `x-event-router-revision: <decimal>` |
| The same Event on its other host | `-H 'Host: bodega-bay.vacaybingo.com'` | `200` and **no** `location` header — it serves in place |
| A reserved label | `-H 'Host: admin.fiveacross.app'` | `404`, `x-event-router-reason: reserved-label` |
| The PostHog ingest label | `-H 'Host: d.fiveacross.app'` | `404`, `x-event-router-reason: reserved-label` |
| An unknown Event | `-H 'Host: no-such-event.fiveacross.app'` | `404`, `x-event-router-reason: unknown-host`, `cache-control: no-store`, **no** `x-event-router-revision` |
| A disabled or archived Event | `-H 'Host: <inactive>.fiveacross.app'` | `404`, `x-event-router-reason: inactive`, **and** `x-event-router-revision: <decimal>` — the committed revision it was refused from |
| A deleted (tombstoned) address | `-H 'Host: <tombstoned>.fiveacross.app'` | `404`, `x-event-router-reason: unknown-host`, **and** `x-event-router-revision: <decimal>` — a tombstone reads as unknown but keeps its revision |
| A foreign hostname | `-H 'Host: example.com'` | `404`, `x-event-router-reason: out-of-namespace` |
| The auth helper | `-H 'Host: bodega-bay.fiveacross.app' http://localhost:8787/__/auth/handler` | `200` or the origin's own status — never a router `404` |
| An unbound registry | with the `[[services]]` block removed | `404`, `x-event-router-reason: lookup-unavailable` on **every** address |

The path capability needs its own command, because every row above uses `curl -sI` and `-I` sends a **`HEAD`**. The router answers this endpoint on an exact `GET` only and proxies anything else on that path to the origin, so a `HEAD` here would test the proxy rather than the capability — and would report a plausible-looking `404` from Hosting:

```bash
curl -si http://localhost:8787/.well-known/fiveacross-path-capability \
  -H 'Host: bodega-bay.fiveacross.app'
# expect 200, content-type: application/json, cache-control: no-store,
# x-event-router-revision: <decimal>, body {"schemaVersion":1,"pathNamespace":…,"revision":"…"}
```

The `wrangler deploy` from step 1 is still worth doing first: it proves the bundle builds and uploads, and its workers.dev address gives you a liveness check (expect `404` / `out-of-namespace` — that *is* the pass condition there).

Then confirm the registry holds a committed projection for **every serving host**, and that each route projection's `slug` equals the address's first label. The router cross-checks it and fails closed with `slug-mismatch` or `slug-missing` otherwise, so a replica written from a half-migrated source would 404 the moment the routes were attached. That is checkable in advance through the registry's audit endpoint, and the backfill/audit gate in R1 exists to do it.

### 3. Verify the DEPLOYED artifact's configuration

`npm run worker:deploy` runs two checks, and they answer different questions.

**Before it installs or publishes anything**, it parses the committed `wrangler.toml` through the shared validator in `scripts/event-router-registry/harness-config.mjs` and exits `65` unless the file's one and only service binding is `REGISTRY`, at the top level, bound explicitly to `RegistryLookupEntrypoint`, with no named environment declared — per § The registry lookup binding. The binding travels with the upload, so the committed configuration *is* the deployed configuration — which is exactly why the check can, and must, run while nothing has changed yet. The validator imports a root devDependency, which is why step 1 above runs `npm ci --include=dev` at the repository root first. Without it the guard exits **`69`**, not `65`, and tells you to run that exact command — a check that could not run is not a binding that is wrong, and reporting it as one would send you to edit the one block that is correct.

**After publishing** (and, on a route-bearing deploy, before it too), it lists the deployed Worker's secrets and exits `1` if `FIREBASE_API_KEY` is still bound. The code no longer reads it, so it grants nothing on its own; it is refused because R0's evidence claim is that the public router carries no Firebase, KV, cache or Durable Object binding at all, and a credential that outlived the code that used it would quietly falsify that. An uninspectable Worker exits `75` — a failed verification, not a skipped one, so automation cannot record an unverified deploy as a verified one. The name is compared for exact equality, so an unrelated `OLD_FIREBASE_API_KEY` neither trips the refusal nor masks a live binding. To check by hand at any time:

```bash
npm --prefix worker exec -- wrangler secret list        # names and types only — never values
```

It should list nothing. If `FIREBASE_API_KEY` appears, delete it with `wrangler secret delete FIREBASE_API_KEY` and redeploy before going near a route.

### 4. Prerequisites the cutover depends on and this Worker's code cannot satisfy

A correct router is not sufficient. Four properties block the cutover, each in a different way. Two are code that does not exist yet, with their own follow-up issues — [#1118](https://github.com/nathanjohnpayne/fiveacross/issues/1118) and [#852](https://github.com/nathanjohnpayne/fiveacross/issues/852); one is evidence still owed under [#888](https://github.com/nathanjohnpayne/fiveacross/issues/888) now that #972 has shipped its router half; and the first is an ORDERING constraint on shipped code, the newest of the four.

- **The bundle change #546 shipped must be DEPLOYED, and installed shells must have taken it, before the routes are attached.** This is an ordering constraint the manifest route creates, and it is the one prerequisite on this list that is about a deploy rather than about code that does not exist yet. Until #546, `manifest.webmanifest` rode in the service worker's Workbox precache, so `precacheAndRoute` answered it cache-first and an edge-served manifest could never reach a client the worker controlled. Worse, the precache entry's `revision` is an MD5 of the build-time bytes, so redeploying the same Edition produces the same hash and an already-installed shell never re-fetches it. Attaching routes in front of shells built before #546 therefore changes nothing about installed identity — the route answers, and the worker ignores it. Ship a post-#546 build to the origin first, then confirm shells have taken the update through `UpdatePrompt` (the #569 carry-forward below is the same audience), and only then attach.
- **A non-Vacay hostname still needs per-host static HTML identity (#1118).** The `fiveacross` origin builds with an empty `VITE_EVENT_ID`, so runtime Event, Edition and adult-content posture come from `hostnames/{host}` before mount, and since #546 the PWA manifest comes from this Worker per host. What is still baked once per build is the crawler-facing `<head>` — the `og:*` / `twitter:*` block, `<meta name="description">` and `<meta name="theme-color">` — because a crawler never runs JS and correcting those means rewriting a proxied HTML response rather than constructing one. The trusted Vacay static fallback preserves the existing Bodega hosts' crawler identity meanwhile. Do not attach a non-Vacay Edition hostname until #1118 rewrites that block per host.
- **Sign-in must be reachable on a newly provisioned host.** `isSignInReachableOnHost` (`src/auth-domain.ts`) admits an exact set of first-party hosts plus local origins plus the documented handoff. An arbitrary new `*.fiveacross.app` label is in none of those, so the app renders `auth-unconfigured` rather than a sign-in button — even after the OAuth redirect URI is registered. Delivering "a new Event needs no code change" needs the [ADR 0010](../docs/adr/0010-centralised-auth-origin-with-handoff.md) handoff or a registration-aware readiness check.
- **Firestore App Check enforcement needed a compatible lookup design, and #972 delivered the router half of it.** The Worker no longer reads Firestore at all: the REST reader, the web api key and the project id are gone, replaced by the registry lookup binding described above, so enforced Cloud Firestore has nothing of this Worker's to reject. `lookup-forbidden` was retired with the reader that produced it. What remains open under #888 is operational rather than code: #971's backfill and #973's R0–R3 evidence, including the App Check-enforced re-run that only closes once [#44](https://github.com/nathanjohnpayne/fiveacross/issues/44) has completed its own monitor/enforce procedure. Do not weaken enforcement to make a route work, and do not roll back to the Firestore reader — [ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md) prohibits it once enforcement is a cutover invariant.

The first makes attachment a no-op for installed shells rather than a failure, which is the more dangerous shape: the cutover appears to succeed while every phone that matters keeps its old identity. The second and third block the wildcard from being useful for Event number two, which is the point of the epic. The fourth no longer blocks on this Worker's design, but its evidence gate still blocks attachment. Treat all four as gates on step 4, not as paperwork.

### 5. Attach the routes — the cutover

**First, exclude every reserved label from the wildcard.** A wildcard Worker *route* is not a wildcard DNS *record*: exact DNS records beat wildcard DNS records, but `*.fiveacross.app/*` still matches every **proxied (orange-clouded)** hostname in the zone, reserved infrastructure labels included. Attach it as-is and `d.fiveacross.app` (the PostHog ingest proxy), `auth.fiveacross.app` and any other orange-clouded reserved label begin resolving to this Worker, which correctly refuses them with `reserved-label` — a 404 planted in front of live infrastructure. The guard in `host.ts` cannot rescue this: once the route matches, the request belongs to this Worker, and refusing it is the most correct thing it can do.

So for each reserved label (`www`, `auth`, `api`, `admin`, `play`, `send`, `status`, `d`), either confirm its record is **DNS-only** (grey-cloud — Worker routes never see it), or install a more-specific route that excludes it. A more specific pattern wins, and Cloudflare's **"no script"** route is exactly this tool: `d.fiveacross.app/*` bound to no Worker. Those are created in the dashboard or via the API, not in `wrangler.toml`, whose `routes` can only attach *this* Worker.

Then uncomment the `[[routes]]` blocks at the end of `wrangler.toml` — exactly where they sit, which is what their array-of-tables shape is for; a `routes = [ … ]` uncommented below the `[[services]]` header would become a key of the service binding, and Wrangler would accept it without a warning and attach nothing — and redeploy. Attach **one Namespace at a time**, verify, and only then attach the second. Immediately after attaching, request each reserved hostname: anything answering `x-event-router-reason: reserved-label` is being intercepted and needs its exclusion before you go further.

Before doing so, note the constraint carried forward from the closed Gate 3 issue ([#569](https://github.com/nathanjohnpayne/fiveacross/issues/569)): the epic's original protective rule — do not let real players install the PWA before the cutover — is spent. Real players are already carrying installed shells and service workers minted from the direct-to-Hosting path, so this cutover has to be verified against **already-installed** shells, not clean installs. Open the app on a device that already has it installed from the home screen, not just in a fresh browser tab.

That is also where the #546 ordering constraint is checked, and it can only be checked from INSIDE an already-installed shell. `curl` talks to the edge and bypasses the browser and its service worker entirely, so after the routes are attached it will always reach this Worker and always show `x-event-router`, even while every pre-#546 shell keeps serving its precached manifest: a `curl` that "passes" here proves nothing about installed identity. Instead, open the installed app from the home screen on a device that already had it before the cutover, attach DevTools to that page (desktop: `chrome://inspect` for an Android shell, Safari's Develop menu for an iOS shell), reload, and read the `manifest.webmanifest` request in the Network panel:

- **Served by the service worker** (Chrome labels the size column `(ServiceWorker)`; the response carries no `x-event-router`): the shell is still on a pre-#546 build and answered from its own precache. Resolve by deploying the post-#546 bundle and letting `UpdatePrompt` take the shell forward; do not attach more routes.
- **Fetched from the network with `x-event-router` present** and a body whose `name` is the requested host's Edition: the shell has taken a post-#546 build and the edge is answering it. This is the state the ordering gate requires.

The DevTools **Application → Manifest** panel reads the manifest the browser last parsed, which is a useful second signal, but the Network row is the one that says WHO answered. Keep `curl` for what it can prove, namely that the edge routes and resolves the hostname at all:

```bash
# Edge-routing check only. Says nothing about what an installed shell serves.
curl -s https://<slug>.vacaybingo.com/manifest.webmanifest -D - -o /dev/stdout | head -20
```

Both apexes stay off the route list. `fiveacross.app` and `vacaybingo.com` are exact Firebase Hosting custom domains today; the router classifies an apex correctly and would serve it, but moving them is a separate decision from lighting up the wildcards, and doing both at once leaves nothing to roll back to.

### 6. Rolling back

Comment the `routes` block out and redeploy, or delete the routes in the Cloudflare dashboard. Traffic returns to the exact-record Hosting path immediately. Nothing in this Worker writes anything, so a rollback has no state to unwind. A **code** rollback selects the last known-good DO-schema-compatible router; it never restores the Firestore REST reader, KV, or a stale cache lookup once App Check enforcement is a cutover invariant (ADR 0014).

## The synthetic exact-route rehearsal — an operator step, not a code step

The only real-Namespace evidence the cutover can be measured on comes from a bounded set of synthetic exact routes, because neither service's `workers.dev` origin is a Namespace request path and waiting for the wildcard cutover would make R0–R3 circular. The rehearsal is **run by a human operator**; nothing in this repository's test suite or CI invokes it, and no code change may.

The router half of it is what #972 delivers: `host.ts` addresses the two closed classes `r2-<26 lowercase base32>.<Namespace>` and `r2-root-<20 lowercase base32>.<Namespace>`, and `src/registry/routerRegistry.integration.test.ts` proves the full active / inactive / root-test / tombstone / unknown behaviour, the exact path capability and the auth bypass against a real Durable Object under Miniflare. Everything below is #971's backfill and #973's evidence.

1. **Preconditions.** The registry and the router are deployed from a clean `main` at the reviewed commit; R0 provisioning is complete (identities, pinned public keys, the `wnam` object namespace, the reviewed wildcard/WAF unique-host-flood rule); `wrangler.toml` still has both wildcard blocks commented; the operator holds the human-only 1Password token scoped to DNS and Workers-route edit on the two zones.
2. **Reserve and manifest.** `scripts/event-router-registry/rehearsal-controller.mjs` transactionally reserves at most 64 aggregate hosts in the deny-all `routerRehearsals/{host}` collection and signs a run manifest recording the run ID, host class, exact hosts/routes/DNS candidates, script version and source commit, expected synthetic state, creator, and expiry. It refuses an apex, a wildcard, a non-manifest or non-reserved host, any label outside the two closed classes, a dirty or non-`main` artifact, and any script version other than the recorded candidate.
3. **Provision.** For each manifested host the controller creates a proxied DNS record and then an exact `<host>/*` route to the reviewed Event-router script, validating each provider readback and journaling the actual provider-assigned ID to the durable append-only artifact journal before the next side effect. Route creation cannot begin until its DNS ID is journaled.
4. **Publish state and observe.** Publish the synthetic active / inactive / root-test / tombstone projections through the ordinary publisher path, leave the unknown and the 30 cold markers unpublished, and record the public outcomes, `x-event-router` / `x-event-router-revision` headers, exact path-capability responses, auth pass-through, and the provider-visible Ray/colo/rule evidence.
5. **Clean up, and verify the cleanup.** Before removing any route, tombstone every synthetic hostname and ledger and wait for Durable Object convergence. Then read and validate the journal, remove every journaled route and DNS record **by its provider-assigned ID**, verify provider absence, and alert until cleanup succeeds. Permanent reservations, replica tombstones, object state and recovery history are retained on purpose.

A failed cleanup can expose only manifest-listed, globally reserved synthetic exact hosts — never a real Event, an apex, or a wildcard. No runtime ever receives DNS or route credentials, and [#529](https://github.com/nathanjohnpayne/fiveacross/issues/529) retains exclusive authority for wildcard or real-host attachment.

## Configuration

| Binding | Where | Meaning |
|---|---|---|
| `ORIGIN_HOST` | `[vars]` | Firebase Hosting origin to proxy to. |
| `ROUTER_VERSION` | `[vars]` | Stamped on every response as `x-event-router`. |
| `LOOKUP_TIMEOUT_MS` | `[vars]`, optional | Hard bound on the whole registry service call. Default `2000`. |
| `REGISTRY` | `[[services]]` | The registry's `RegistryLookupEntrypoint`, named explicitly. The router's only lookup source; see § The registry lookup binding. |

There are no `wrangler secret` bindings, and that absence is checked at deploy time rather than assumed.

## Diagnosing a live router

Every response carries `x-event-router`. A response decided from a resolved registry record also carries `x-event-router-revision`, a validated canonical decimal — it is the edge's own value and any header of that name from the origin is discarded, so it is safe to read as the projection the edge actually read. That includes two REFUSALS: an `inactive` route and a tombstone's `unknown-host` each report the committed revision they were refused from, which is what lets a recovery probe compare the public answer against committed state. The auth pass-through, an unknown (never-published) address, a malformed or unavailable lookup, a slug-mismatched projection, and every guard that runs before the lookup carry none, because none of them has a revision to attribute to the address.

Every fail-closed response carries `x-event-router-reason`, drawn from a closed set:

`out-of-namespace` · `nested-label` · `reserved-label` · `invalid-slug:<rule>` · `unknown-host` · `inactive` · `replica-malformed` · `slug-mismatch` · `slug-missing` · `lookup-unavailable`

`invalid-slug` is qualified with the rule the first label broke — `invalid-slug:too-short`, `invalid-slug:edge-hyphen`, `invalid-slug:invalid-characters`, `invalid-slug:reserved-tag` — so the class stays greppable as a prefix while the specific failure is still named.

Two of them changed meaning in #972, and the old names are gone rather than repurposed. `malformed` (a `hostnames/{host}` document with no `eventId`) became **`replica-malformed`**: a committed projection the registry cannot parse or this Worker does not support. `lookup-forbidden` (Firestore answering 401/403) was **removed with the Firestore reader**; there is no longer a lookup that can be refused rather than merely unavailable.

`/manifest.webmanifest` is the one address that answers with a BODY an operator can read a decision out of: its `name` is the Edition this router resolved for the requested hostname, taken from the committed projection's `edition` — the same lookup that decided the request may proceed. `curl -s https://<host>/manifest.webmanifest` returning the wrong product's name (with `x-event-router` present) means the projection committed for that host names the wrong Edition, not that the router is misbehaving; a projection naming an Edition this build does not know never reaches the route at all, because the boundary re-validation refuses it as `replica-malformed`. The precache case is different: only a request made from a page the installed shell controls can be answered by that shell's service worker, so "no `x-event-router` header" is a diagnosis you read in that page's DevTools Network panel (see step 5), never from `curl`, which never passes through a service worker.

`lookup-unavailable` remains the only reason that is about the router rather than about the address: the registry binding is absent, or the service call rejected or exceeded the 2,000 ms bound. Seeing it on **every** address, including `/__/auth/*`, points at the binding — the registry service missing, or the `[[services]]` block wrong. Seeing it intermittently points at the registry Worker or its Durable Object. Seeing `replica-malformed` on one host points at that host's committed projection and should page: it will not heal on a retry. Seeing it on **every** committed host at once, immediately after a registry deploy, points instead at version skew: each lookup result carries the `schemaVersion` its record was committed under, the router refuses any version outside the exact set its own build interprets before it reads the projection, and the fix is to ship the router that understands the new schema rather than to touch the registry.
