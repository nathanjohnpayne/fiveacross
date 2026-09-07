// The Worker Event router (#545, epic #529; registry seam #972, epic #888).
//
// One versioned service in front of `*.fiveacross.app` and `*.vacaybingo.com`,
// so a new Event needs no DNS record, no Hosting custom domain, no certificate
// and no Worker route of its own. It does five things and refuses a sixth:
//
//   1. guards the Namespace and the reserved infrastructure labels (`host.ts`)
//   2. resolves the address through the named lookup-only registry entrypoint
//      (`resolve.ts`)
//   3. fails CLOSED on anything that is not an explicit, active, matching
//      committed projection (`notFound.ts`)
//   4. answers the exact `/.well-known/fiveacross-path-capability` projection
//      from that same lookup, so the service worker needs no second source
//   5. proxies what survives to the Firebase Hosting origin with a rewritten
//      Host header, leaving the public hostname in the browser untouched
//
// The sixth — the one it refuses — is REDIRECTING. This Worker is not a
// canonicaliser. #599 as amended removed edge canonicalization outright: every
// registered host serves in place, and a serving domain is never bounced off
// itself. The canonical hostname still exists, but its job is analytics
// aggregation and being the name printed on things, not being a redirect
// target; share links deliberately carry the entry-point host (#607). It is
// also not an authorization layer — the application still verifies membership
// before reading any Event data, and nothing in this file is load-bearing for
// that.
//
// `handleRequest` takes its config and its seams as arguments rather than
// reading globals, so `router.test.ts` drives the entire decision table with a
// fake fetch and a plain object for the registry. `index.ts` is the only file
// that knows it is running on Cloudflare.

import { classifyHost, NAMESPACES } from './host';
import { notFoundResponse } from './notFound';
import { resolveHost, type ResolveDeps, type ServedRecord } from './resolve';

export interface RouterConfig {
  /** The Firebase Hosting host to proxy to — the site's own `*.web.app`
   *  address, which serves regardless of which public hostname the guest
   *  typed. */
  originHost: string;
  /** Hard bound on the whole registry service call. */
  lookupTimeoutMs: number;
  /** Echoed on every response as `x-event-router`. The one cheap way an
   *  operator can tell, from outside, whether this Worker is in front of a
   *  host yet — which is exactly the question the cutover ladder asks. */
  version: string;
  namespaces?: readonly string[];
}

export interface RouterDeps extends ResolveDeps {
  fetch: typeof fetch;
}

/** Firebase Hosting's reserved namespace, which serves the Google sign-in
 *  helper (`/__/auth/handler`, `/__/auth/iframe`). */
const AUTH_PREFIX = '/__/auth';

/** The same-origin host-capability projection the service worker reads before
 *  it decides whether a first path segment is an address
 *  (`specs/path-addressing-and-root.md` § D3). */
export const PATH_CAPABILITY_PATH = '/.well-known/fiveacross-path-capability';

/** Bumped only alongside a change to the projection's shape, so a service
 *  worker built against an older contract can refuse it rather than coerce
 *  it. */
export const PATH_CAPABILITY_SCHEMA_VERSION = 1;

function isAuthPassthrough(pathname: string): boolean {
  return pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`);
}

/**
 * Whether this router can do its job at all.
 *
 * Two bindings, and the pairing is deliberate: with no `ORIGIN_HOST` there is
 * nothing to proxy TO, so an auth-path request would fail somewhere inside the
 * URL rewrite rather than as the documented fail-closed response, and with no
 * registry binding there is nothing to resolve WITH. The origin check is
 * against `''` rather than against nullishness because `config.ts` has already
 * normalised an unbound binding to the empty string — that normalisation is
 * what makes "deployed but not yet configured", a state the cutover procedure
 * deliberately passes through, a rendered 404 instead of a Worker runtime
 * error.
 */
export function isRouterConfigured(config: RouterConfig, deps: Pick<RouterDeps, 'registry'>): boolean {
  return config.originHost.length > 0 && deps.registry !== null;
}

export async function handleRequest(
  request: Request,
  config: RouterConfig,
  deps: RouterDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const classified = classifyHost(url.hostname, config.namespaces ?? NAMESPACES);

  // The Namespace / reserved-label / Slug guard runs BEFORE the service
  // binding is touched, and that ordering carries a cost property as well as a
  // security one: foreign or malformed traffic creates no registry work at all,
  // so a flood of invalid hostnames cannot instantiate Durable Objects.
  //
  // `detail` names WHICH Slug rule a malformed label broke. Carrying it into
  // the reason header is what lets an operator tell `too-short` from
  // `reserved-tag` from outside, without which every malformed address looks
  // alike during a cutover. Both halves come from closed unions, so nothing
  // caller-controlled reaches the header.
  if (classified.kind === 'rejected') {
    return notFoundResponse(classified.reason, config.version, classified.detail);
  }

  // An unconfigured router fails closed for EVERY request, and this check sits
  // ahead of the auth exemption on purpose. A missing binding is not the
  // transient dependency failure that exemption exists to survive; leaving
  // `/__/auth/*` proxying under a misconfigured deployment would make the
  // documented "fails closed on every address" posture quietly untrue for the
  // one path hardest to notice.
  if (!isRouterConfigured(config, deps)) {
    return notFoundResponse('lookup-unavailable', config.version);
  }

  // `/__/auth/*` passes through intact, and it skips the lookup ON PURPOSE.
  //
  // The guards above still apply, so a reserved label's auth path is refused
  // like any other request to a reserved label. What this exemption buys is
  // that a transient registry failure cannot break the sign-in round-trip on a
  // host that is perfectly valid — the OAuth redirect leg is the single worst
  // place to introduce a new dependency, because a guest hits it mid-
  // transaction with credentials already in flight. The surface it opens is
  // narrow and grants nothing: these paths serve Firebase Hosting's own helper,
  // carry no Event data, and Google matches `redirect_uri` exactly against a
  // registration this router cannot create (ADR 0010). It is also the only
  // PROXIED path whose response carries no `x-event-router-revision`, because
  // it is the only one that reaches the origin without resolving a record to
  // read a revision from.
  if (isAuthPassthrough(url.pathname)) {
    return proxyToOrigin(request, url, config, deps, null);
  }

  // A refusal that was decided FROM a committed record carries that record's
  // revision, so `inactive` and a tombstone's `unknown-host` are publicly
  // observable as the `{reason, revision}` pair the registry's recovery
  // evidence compares against committed state. Every other refusal resolves to
  // `null` and stamps no revision header.
  const resolution = await resolveHost(classified.host, classified.slug, config, deps);
  if (resolution.kind === 'not-found') {
    return notFoundResponse(resolution.reason, config.version, undefined, resolution.revision);
  }

  // Served from the SAME lookup that decided the request may proceed, with no
  // second source and no fallback. A capability answered from anywhere else
  // would be a second routing authority, which is exactly what the accepted
  // path-addressing contract forbids; and because it is gated on the resolution
  // above, a missing, malformed, inactive or tombstoned host returns the
  // fail-closed state rather than a capability.
  if (isPathCapabilityRequest(request, url)) {
    return pathCapabilityResponse(resolution.record, config.version);
  }

  return proxyToOrigin(request, url, config, deps, resolution.record.revision);
}

/**
 * Exact path AND exact method.
 *
 * A prefix match would hand every `/.well-known/…` sibling the capability
 * projection, and a method-agnostic match would answer a POST with a body the
 * caller cannot have meant. Anything else on that path — including `HEAD` —
 * falls through to the ordinary pipeline and is proxied like any other address
 * on the host, which is the same answer the origin would have given before this
 * endpoint existed.
 */
function isPathCapabilityRequest(request: Request, url: URL): boolean {
  return request.method === 'GET' && url.pathname === PATH_CAPABILITY_PATH;
}

/**
 * `{schemaVersion, pathNamespace, revision}` and nothing else.
 *
 * No Event ID, no Slug, no Edition, no hostname catalogue: the endpoint exists
 * so a service worker can decide whether an eligible first path segment is an
 * address, and every additional field would be an enumeration surface on a
 * public, unauthenticated endpoint. `no-store` because a capability cached past
 * a repoint would outlive the projection it describes, and the service worker's
 * conservative branch is cheap while a stale capability is not.
 */
function pathCapabilityResponse(record: ServedRecord, version: string): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: PATH_CAPABILITY_SCHEMA_VERSION,
      pathNamespace: record.pathNamespace,
      revision: record.revision,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-event-router': version,
        'x-event-router-revision': record.revision,
      },
    },
  );
}

/**
 * Proxy, never redirect.
 *
 * The Host rewrite is done by changing the URL's hostname rather than by
 * setting a `Host` header, because on Workers the outbound Host is derived
 * from the request URL and a header set would be ignored — quietly, which is
 * the dangerous kind. The guest's address bar is untouched because this is a
 * subrequest whose body we return, not a `Location` we emit.
 *
 * `redirect: 'manual'` is the regression guard #545 asks for made structural:
 * with it, a 3xx from the origin is handed to the browser exactly as the origin
 * wrote it, and this Worker has no code path anywhere that constructs a
 * redirect of its own. There is no canonical host in this file to bounce to.
 */
async function proxyToOrigin(
  request: Request,
  url: URL,
  config: RouterConfig,
  deps: RouterDeps,
  revision: string | null,
): Promise<Response> {
  const originUrl = new URL(url.toString());
  originUrl.protocol = 'https:';
  originUrl.hostname = config.originHost;
  originUrl.port = '';

  const headers = new Headers(request.headers);
  // The origin serves one bundle to every hostname, so the public host is only
  // recoverable from what we forward. Hosting does not consume these today;
  // they exist so a per-hostname response (the #546 manifest) has something to
  // key on without this file having to change again.
  headers.set('x-forwarded-host', url.hostname);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Required by undici (and harmless on workerd) when the body is a stream
    // rather than a buffered value; without it a proxied POST throws.
    init.duplex = 'half';
  }

  let originResponse: Response;
  try {
    originResponse = await deps.fetch(new Request(originUrl.toString(), init));
  } catch {
    // Keep transport failures inside the router's response contract. Letting
    // the rejection escape delegates the response to Cloudflare, which loses
    // the version stamp operators use to prove this Worker handled the host.
    // The body is deliberately generic so DNS/TLS/runtime details never leak.
    return new Response('Origin temporarily unavailable.', {
      status: 502,
      headers: stampRouterHeaders(
        new Headers({
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        }),
        config.version,
        revision,
      ),
    });
  }

  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: stampRouterHeaders(new Headers(originResponse.headers), config.version, revision),
  });
}

/**
 * The router's own diagnostic headers, applied last.
 *
 * `x-event-router-revision` is DELETED before it is conditionally set, so an
 * origin that ever emitted a header by that name cannot have it mistaken for
 * the edge's own validated revision — the closed-header rule the contract
 * states ("no caller-controlled diagnostic enters a header") applies to the
 * origin's headers as much as to the guest's. The value itself is a canonical
 * decimal `resolve.ts` validated before serving.
 */
function stampRouterHeaders(headers: Headers, version: string, revision: string | null): Headers {
  headers.set('x-event-router', version);
  headers.delete('x-event-router-revision');
  if (revision !== null) headers.set('x-event-router-revision', revision);
  return headers;
}
