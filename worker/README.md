# `worker/` — the Five Across Event router

One versioned Cloudflare Worker in front of the wildcard Namespaces `*.fiveacross.app` and `*.vacaybingo.com`, so a new Event needs no DNS record, no Hosting custom domain, no certificate and no Worker route of its own. Implements [#545](https://github.com/nathanjohnpayne/gaycruisebingo/issues/545) under epic [#529](https://github.com/nathanjohnpayne/gaycruisebingo/issues/529); the behavioural contract is [`specs/event-router.md`](../specs/event-router.md), and the Event-identity model it consumes is [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md).

## What it is, and the two things it is not

It is a **router** and a **namespace guard**. It validates the hostname's Namespace and first label against the Slug contract, resolves the address against the same world-readable `hostnames/{host}` collection the client reads, fails closed on anything that is not an explicit active match, and proxies what survives to the Firebase Hosting origin with a rewritten `Host` header.

It is **not a canonicaliser**. [#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) as amended removed edge canonicalization: every registered host serves in place, and a serving domain is never bounced off itself. There is no code path in this directory that constructs a redirect, and `router.test.ts` sweeps every outcome asserting none appears. The canonical hostname still exists — its job is analytics aggregation and being the name printed on things, not being a redirect target — and share links deliberately carry the entry-point host ([#607](https://github.com/nathanjohnpayne/gaycruisebingo/issues/607)).

It is **not an authorization layer**. The application still verifies membership before reading any Event data. The router holds the Firebase *web* API key and no service-account credential, so it can read exactly what a browser standing on the same address can read, and `firestore.rules` is what enforces that rather than a promise this code makes about itself.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | The only file that knows it is running on Cloudflare: env parsing, the `caches.default` adapter, the exported handler. |
| `src/router.ts` | The request pipeline — guard, auth passthrough, resolve, proxy or fail closed. |
| `src/host.ts` | The pure Namespace and reserved-label guard. |
| `src/resolve.ts` | The `hostnames/{host}` lookup, its cache, and the fail-closed decision table. |
| `src/notFound.ts` | The rendered Event-not-found page. |
| `../src/slug.ts` | The Slug contract, shared with the Event-setup wizard's address step. One list, never two. |

Everything with a decision in it is free of Cloudflare types and takes its platform seams (`fetch`, `cache`, `now`) as injected arguments — the convention [`specs/event-resolution.md`](../specs/event-resolution.md) sets for the client resolver, for the same reason: it lets the whole decision table be proved by the repo's ordinary `npm test`, with no workerd, no emulator and no network.

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

## Deploying and attaching

**The deliverable of #545 ends at "deployable, tested, documented". Attaching the routes is the cutover, and the cutover is a human step** — it depends on the DNS work in [#539](https://github.com/nathanjohnpayne/gaycruisebingo/issues/539) and on the PRD's Gate ladder. `wrangler.toml` therefore ships with `routes` commented out, so no deploy command can perform a cutover by accident.

### 1. Configure and deploy, unrouted

```bash
npm --prefix worker ci                                       # pinned wrangler, from the committed lockfile
npm --prefix worker exec -- wrangler secret put FIREBASE_API_KEY   # the fiveacross project's WEB api key
npm run worker:deploy                                        # from the repo root
```

Install first, and invoke wrangler through the local binary rather than a bare `npx wrangler`: `npx` would fetch whatever version the registry currently resolves, which defeats the point of pinning the toolchain in `worker/package-lock.json`.

This uploads the Worker and publishes it on its `*.workers.dev` address only. Nothing about what the public sees changes.

**Deploy through `npm run worker:deploy`, never a bare `wrangler deploy`.** `wrangler` publishes the caller's working directory, not `origin/main`, and once the routes are attached this Worker fronts every wildcard Event hostname — so a bare deploy from a feature branch or a dirty tree would replace the router for every Event at once with code no reviewer has seen. `scripts/worker-deploy.sh` calls the same shared guard as `scripts/deploy.sh`: `--force` is limited to branch/freshness checks, while a dirty tree requires the separately auditable `DEPLOY_ALLOW_DIRTY=1` escape hatch.

Between this step and the next, the Worker is deployed but **unconfigured** if the secret has not been set — a state this procedure passes through on purpose. It answers `404` with `x-event-router-reason: lookup-unavailable` on every address rather than erroring, which is the last row of the table below.

### 2. Verify against production data, before any route exists

**Do not try to smoke-test this by curling the `*.workers.dev` address with a `Host` override.** It cannot work, and the reason is worth stating so nobody rediscovers it during a cutover: a request dispatched to the workers.dev address carries *that* hostname in `request.url`, and overriding `Host` changes the authority Cloudflare routes on (or is rejected as domain fronting) rather than presenting a different hostname to the router. The Worker would classify every such request as `out-of-namespace` and return `404`. That is correct behaviour — `host.test.ts` pins it — but it means workers.dev can only ever prove the refusal path.

Use `wrangler dev --remote` instead. It executes **this deployed code on Cloudflare's network** with real bindings, a real Cache API, real Firestore reads and the real Hosting origin, while serving on `localhost`, where the URL the Worker sees *is* built from the `Host` header you send. That is a genuine end-to-end rehearsal with no production route and no test-only bypass compiled into the router.

```bash
npm --prefix worker ci                                  # if you have not already
npm --prefix worker exec -- wrangler dev --remote       # leave running; requests below go to localhost:8787
```

| Check | `curl -sI http://localhost:8787/ …` | Expected |
|---|---|---|
| A serving Event address | `-H 'Host: bodega-bay.fiveacross.app'` | `200`, the app shell, `x-event-router: v1` |
| The same Event on its other host | `-H 'Host: bodega-bay.vacaybingo.com'` | `200` and **no** `location` header — it serves in place |
| A reserved label | `-H 'Host: admin.fiveacross.app'` | `404`, `x-event-router-reason: reserved-label` |
| The PostHog ingest label | `-H 'Host: d.fiveacross.app'` | `404`, `x-event-router-reason: reserved-label` |
| An unknown Event | `-H 'Host: no-such-event.fiveacross.app'` | `404`, `x-event-router-reason: unknown-host`, `cache-control: no-store` |
| A foreign hostname | `-H 'Host: example.com'` | `404`, `x-event-router-reason: out-of-namespace` |
| The auth helper | `-H 'Host: bodega-bay.fiveacross.app' http://localhost:8787/__/auth/handler` | `200` or the origin's own status — never a router `404` |
| Misconfiguration | with `FIREBASE_API_KEY` unset | `404`, `x-event-router-reason: lookup-unavailable` on **every** address |

The `wrangler deploy` from step 1 is still worth doing first: it proves the bundle builds and uploads, and its workers.dev address gives you a liveness check (expect `404` / `out-of-namespace` — that *is* the pass condition there).

Then confirm the routing document for **every serving host** carries a `slug` field. The router cross-checks `hostnames/{host}.slug` against the address's first label and fails closed with `slug-missing` when it is absent, so a document written before that field became load-bearing would 404 the moment the routes were attached. This is the single most likely way a correct router still takes an Event down, and it is checkable in advance.

### 3. Prerequisites that are NOT this Worker's code — and that block a multi-Event cutover

A correct router is not sufficient. Two properties live in the application and the origin bundle, and until both hold, attaching the wildcards serves at most the one Event that is already live. Both were surfaced in review of this PR and each has its own follow-up issue — [#851](https://github.com/nathanjohnpayne/gaycruisebingo/issues/851) and [#852](https://github.com/nathanjohnpayne/gaycruisebingo/issues/852).

- **The origin bundle must stop baking `VITE_EVENT_ID`.** `scripts/build-target.mjs` sets `VITE_EVENT_ID: 'bodega-bay-2026'` for the `fiveacross` target, and `specs/event-resolution.md` rule 1 is that a present `VITE_EVENT_ID` short-circuits hostname resolution with no network read. So a second Event's hostname would pass this router correctly and then mount **Bodega** in the browser — the Worker validating one `eventId` while the client uses another. Before the wildcards carry a second Event, `ORIGIN_HOST` must point at a bundle built with an empty `VITE_EVENT_ID` (or a separate hostname-resolved Hosting site).
- **Sign-in must be reachable on a newly provisioned host.** `isSignInReachableOnHost` (`src/auth-domain.ts`) admits an exact set of first-party hosts plus local origins plus the documented handoff. An arbitrary new `*.fiveacross.app` label is in none of those, so the app renders `auth-unconfigured` rather than a sign-in button — even after the OAuth redirect URI is registered. Delivering "a new Event needs no code change" needs the [ADR 0010](../docs/adr/0010-centralised-auth-origin-with-handoff.md) handoff or a registration-aware readiness check.

Neither is a defect in `worker/`, and neither blocks *this* Worker from serving the Event that is already live on its existing hosts. They block the wildcard from being useful for Event number two, which is the point of the epic — so treat them as gates on step 4, not as paperwork.

### 4. Attach the routes — the cutover

Uncomment the `routes` block in `wrangler.toml` and redeploy. Attach **one Namespace at a time**, verify, and only then attach the second.

Before doing so, note the constraint carried forward from the closed Gate 3 issue ([#569](https://github.com/nathanjohnpayne/gaycruisebingo/issues/569)): the epic's original protective rule — do not let real players install the PWA before the cutover — is spent. Real players are already carrying installed shells and service workers minted from the direct-to-Hosting path, so this cutover has to be verified against **already-installed** shells, not clean installs. Open the app on a device that already has it installed from the home screen, not just in a fresh browser tab.

Both apexes stay off the route list. `fiveacross.app` and `vacaybingo.com` are exact Firebase Hosting custom domains today; the router classifies an apex correctly and would serve it, but moving them is a separate decision from lighting up the wildcards, and doing both at once leaves nothing to roll back to.

### 5. Rolling back

Comment the `routes` block out and redeploy, or delete the routes in the Cloudflare dashboard. Traffic returns to the exact-record Hosting path immediately. Nothing in this Worker writes anything, so a rollback has no state to unwind.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `ORIGIN_HOST` | `[vars]` | Firebase Hosting origin to proxy to. |
| `FIREBASE_PROJECT_ID` | `[vars]` | Firestore project holding `hostnames/{host}`. |
| `FIREBASE_API_KEY` | `wrangler secret` | The Firebase **web** api key. Not a secret; kept out of the committed config only to avoid a standing secret-scanner false positive. |
| `ROUTER_VERSION` | `[vars]` | Stamped on every response as `x-event-router`. |
| `LOOKUP_TIMEOUT_MS` | `[vars]`, optional | Hard bound on the Firestore read. Default `2000`. |
| `HOSTNAME_CACHE_TTL_MS` | `[vars]`, optional | Freshness window for a cached positive resolution. Default `300000`. |

## Diagnosing a live router

Every response carries `x-event-router`. Every fail-closed response also carries `x-event-router-reason`, drawn from a closed set:

`out-of-namespace` · `nested-label` · `reserved-label` · `invalid-slug:<rule>` · `unknown-host` · `inactive` · `malformed` · `slug-mismatch` · `slug-missing` · `lookup-unavailable`

`invalid-slug` is qualified with the rule the first label broke — `invalid-slug:too-short`, `invalid-slug:edge-hyphen`, `invalid-slug:invalid-characters`, `invalid-slug:reserved-tag` — so the class stays greppable as a prefix while the specific failure is still named.

`lookup-unavailable` is the only one that is about the router rather than about the address: it means the `hostnames/{host}` read could not be completed and no cached answer existed. Seeing it on **every** address, including `/__/auth/*`, points at configuration (a missing `FIREBASE_API_KEY` or `FIREBASE_PROJECT_ID`); seeing it intermittently points at Firestore.
