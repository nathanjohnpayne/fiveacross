// The Worker Event router (#545, epic #529).
//
// One versioned service in front of `*.fiveacross.app` and `*.vacaybingo.com`,
// so a new Event needs no DNS record, no Hosting custom domain, no certificate
// and no Worker route of its own. It does four things and refuses a fifth:
//
//   1. guards the Namespace and the reserved infrastructure labels (`host.ts`)
//   2. resolves the address against `hostnames/{host}` (`resolve.ts`)
//   3. fails CLOSED on anything that is not an explicit, active, matching
//      record (`notFound.ts`)
//   4. proxies what survives to the Firebase Hosting origin with a rewritten
//      Host header, leaving the public hostname in the browser untouched
//
// The fifth — the one it refuses — is REDIRECTING. This Worker is not a
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
// fake fetch and a map for a cache. `index.ts` is the only file that knows it
// is running on Cloudflare.

import { classifyHost, NAMESPACES } from './host';
import { notFoundResponse } from './notFound';
import { isLookupConfigured, resolveHost, type HostnameCache, type ResolveDeps } from './resolve';

export interface RouterConfig {
  /** The Firebase Hosting host to proxy to — the site's own `*.web.app`
   *  address, which serves regardless of which public hostname the guest
   *  typed. */
  originHost: string;
  projectId: string;
  apiKey: string;
  lookupTimeoutMs: number;
  cacheTtlMs: number;
  /** Echoed on every response as `x-event-router`. The one cheap way an
   *  operator can tell, from outside, whether this Worker is in front of a
   *  host yet — which is exactly the question the cutover ladder asks. */
  version: string;
  namespaces?: readonly string[];
}

export interface RouterDeps extends ResolveDeps {
  cache: HostnameCache;
}

/** Firebase Hosting's reserved namespace, which serves the Google sign-in
 *  helper (`/__/auth/handler`, `/__/auth/iframe`). */
const AUTH_PREFIX = '/__/auth';

function isAuthPassthrough(pathname: string): boolean {
  return pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`);
}

/**
 * Whether this router can do its job at all.
 *
 * Wider than `isLookupConfigured` by exactly one field, and the extra field is
 * the one an auth-path request would otherwise reach: with no `ORIGIN_HOST`
 * there is nothing to proxy TO, so a passthrough would fail somewhere inside
 * the URL rewrite rather than as the documented fail-closed response. Every
 * check here is against `''` rather than against nullishness, because
 * `config.ts` has already normalised an unbound binding to the empty string —
 * that normalisation is what makes "deployed but not yet configured", a state
 * the cutover procedure deliberately passes through, a rendered 404 instead of
 * a Worker runtime error.
 */
export function isRouterConfigured(config: RouterConfig): boolean {
  return config.originHost.length > 0 && isLookupConfigured(config);
}

export async function handleRequest(
  request: Request,
  config: RouterConfig,
  deps: RouterDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const classified = classifyHost(url.hostname, config.namespaces ?? NAMESPACES);

  if (classified.kind === 'rejected') {
    // `detail` names WHICH Slug rule a malformed label broke. Carrying it into
    // the reason header is what lets an operator tell `too-short` from
    // `reserved-tag` from outside, without which every malformed address looks
    // alike during a cutover. Both halves come from closed unions, so nothing
    // caller-controlled reaches the header.
    return notFoundResponse(classified.reason, config.version, classified.detail);
  }

  // An unconfigured router fails closed for EVERY request, and this check sits
  // ahead of the auth exemption on purpose. A missing api key is not the
  // transient dependency failure that exemption exists to survive; leaving
  // `/__/auth/*` proxying under a misconfigured deployment would make the
  // documented "fails closed on every address" posture quietly untrue for the
  // one path hardest to notice.
  if (!isRouterConfigured(config)) {
    return notFoundResponse('lookup-unavailable', config.version);
  }

  // `/__/auth/*` passes through intact, and it skips the lookup ON PURPOSE.
  //
  // The guards above still apply, so a reserved label's auth path is refused
  // like any other request to a reserved label. What this exemption buys is
  // that a transient `hostnames/{host}` failure cannot break the sign-in
  // round-trip on a host that is perfectly valid — the OAuth redirect leg is
  // the single worst place to introduce a new dependency, because a guest hits
  // it mid-transaction with credentials already in flight. The surface it
  // opens is narrow and grants nothing: these paths serve Firebase Hosting's
  // own helper, carry no Event data, and Google matches `redirect_uri` exactly
  // against a registration this router cannot create (ADR 0010).
  if (isAuthPassthrough(url.pathname)) {
    return proxyToOrigin(request, url, config, deps);
  }

  const resolution = await resolveHost(classified.host, classified.slug, config, deps);
  if (resolution.kind === 'not-found') {
    return notFoundResponse(resolution.reason, config.version);
  }

  return proxyToOrigin(request, url, config, deps);
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

  const originResponse = await deps.fetch(new Request(originUrl.toString(), init));

  const responseHeaders = new Headers(originResponse.headers);
  responseHeaders.set('x-event-router', config.version);

  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: responseHeaders,
  });
}
