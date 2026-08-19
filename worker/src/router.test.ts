// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleRequest, type RouterConfig, type RouterDeps } from './router';
import { CACHE_VERSION, type CacheEnvelope, type HostnameCache } from './resolve';
import { RESERVED_LABELS } from '../../src/slug';

const CONFIG: RouterConfig = {
  originHost: 'fiveacross.web.app',
  projectId: 'fiveacross',
  apiKey: 'test-web-api-key',
  lookupTimeoutMs: 2_000,
  cacheTtlMs: 300_000,
  version: 'test-1',
};

const SERVING: CacheEnvelope = {
  version: CACHE_VERSION,
  fetchedAt: 1_000_000,
  record: { eventId: 'bodega-bay-2026', status: 'active', slug: 'bodega-bay' },
};

/** Every test below seeds the resolution through the cache so the assertions
 *  are about ROUTING; `resolve.test.ts` owns the lookup's own decision table. */
function harness(options: { seed?: Record<string, CacheEnvelope>; origin?: Response } = {}) {
  const store = new Map<string, CacheEnvelope>(Object.entries(options.seed ?? {}));
  const cache: HostnameCache = {
    read: async (host) => store.get(host) ?? null,
    write: async (host, envelope) => void store.set(host, envelope),
    drop: async (host) => void store.delete(host),
  };

  // The lookup calls `fetch(urlString, init)` and the proxy calls
  // `fetch(request)`; normalise both so assertions can read either.
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(request);
    // Compare the parsed ORIGIN, not a URL prefix: a `startsWith` test would
    // also match `https://firestore.googleapis.com.example.test/…`, and a
    // harness that mis-routes a request is a harness that proves the wrong
    // thing (CodeQL js/incomplete-url-substring-sanitization).
    if (new URL(request.url).origin === 'https://firestore.googleapis.com') {
      return new Response('{}', { status: 404 });
    }
    return options.origin ?? new Response('<!doctype html><title>app</title>', { status: 200 });
  });

  const deps: RouterDeps = {
    fetch: fetchImpl as unknown as RouterDeps['fetch'],
    cache,
    now: () => 1_000_000,
  };
  return { deps, requests, store };
}

const servingSeed = {
  'bodega-bay.fiveacross.app': SERVING,
  'bodega-bay.vacaybingo.com': SERVING,
};

function get(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('routing a serving address', () => {
  it.each(['https://bodega-bay.fiveacross.app/board', 'https://bodega-bay.vacaybingo.com/board'])(
    'proxies %s to the Hosting origin in place',
    async (url) => {
      const { deps, requests } = harness({ seed: servingSeed });
      const response = await handleRequest(get(url), CONFIG, deps);

      expect(response.status).toBe(200);
      const proxied = requests.at(-1)!;
      const proxiedUrl = new URL(proxied.url);
      // Host rewritten to the origin...
      expect(proxiedUrl.hostname).toBe('fiveacross.web.app');
      // ...path, query and method preserved verbatim.
      expect(proxiedUrl.pathname).toBe('/board');
      // ...and the PUBLIC hostname forwarded, because the origin serves one
      // bundle to every address and cannot otherwise recover it.
      expect(proxied.headers.get('x-forwarded-host')).toBe(new URL(url).hostname);
      expect(proxied.headers.get('x-forwarded-proto')).toBe('https');
    },
  );

  it('preserves the query string and the request method', async () => {
    const { deps, requests } = harness({ seed: servingSeed });
    await handleRequest(
      get('https://bodega-bay.fiveacross.app/api/x?day=3&mode=easy', { method: 'HEAD' }),
      CONFIG,
      deps,
    );
    const proxied = requests.at(-1)!;
    expect(proxied.method).toBe('HEAD');
    expect(new URL(proxied.url).search).toBe('?day=3&mode=easy');
  });

  it('proxies a request that carries a body', async () => {
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/x', { method: 'POST', body: 'hello' }),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(requests.at(-1)!.method).toBe('POST');
  });

  it('returns the origin status and headers, plus its own version stamp', async () => {
    const { deps } = harness({
      seed: servingSeed,
      origin: new Response('nope', { status: 503, headers: { 'x-origin-marker': 'yes' } }),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-origin-marker')).toBe('yes');
    expect(response.headers.get('x-event-router')).toBe('test-1');
  });

  it('serves the Namespace apex', async () => {
    const { deps, requests } = harness({ seed: { 'fiveacross.app': SERVING } });
    const response = await handleRequest(get('https://fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(200);
    expect(new URL(requests.at(-1)!.url).hostname).toBe('fiveacross.web.app');
  });
});

describe('the no-redirect regression guard (#599 as amended)', () => {
  it('never emits a redirect of its own, on any outcome', async () => {
    const hosts = [
      'https://bodega-bay.fiveacross.app/',
      'https://bodega-bay.vacaybingo.com/',
      'https://fiveacross.app/',
      'https://admin.fiveacross.app/',
      'https://unknown-event.fiveacross.app/',
      'https://ab.fiveacross.app/',
      'https://bodega-bay.example.com/',
      'https://bodega-bay.fiveacross.app/__/auth/handler',
    ];
    const { deps } = harness({ seed: servingSeed });

    for (const url of hosts) {
      const response = await handleRequest(get(url), CONFIG, deps);
      // Serving, refused and passed-through all appear in this sweep; what
      // none of them may ever be is a 3xx, because there is no canonical host
      // in this Worker to bounce anyone to.
      expect(response.status < 300 || response.status >= 400, url).toBe(true);
      expect(response.headers.get('location'), url).toBeNull();
    }
  });

  it('passes an origin redirect through untouched instead of following it', async () => {
    // The router must not resolve the origin's own 3xx on the guest's behalf —
    // a followed redirect would silently land the guest on the origin host.
    const { deps } = harness({
      seed: servingSeed,
      origin: new Response(null, { status: 301, headers: { location: '/elsewhere' } }),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/x'), CONFIG, deps);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/elsewhere');
  });

  it('serves the alias in place rather than bouncing it to the canonical host', async () => {
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(get('https://bodega-bay.vacaybingo.com/board'), CONFIG, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(requests.at(-1)!.headers.get('x-forwarded-host')).toBe('bodega-bay.vacaybingo.com');
  });
});

describe('failing closed', () => {
  it.each([...RESERVED_LABELS])('refuses the reserved label %s WITHOUT consulting the lookup', async (label) => {
    const { deps, requests } = harness({
      // Even a routing document that names this host must not promote it: the
      // guard is decided before any data is read.
      seed: { [`${label}.fiveacross.app`]: SERVING },
    });
    const response = await handleRequest(get(`https://${label}.fiveacross.app/`), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('reserved-label');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['https://unknown-event.fiveacross.app/', 'unknown-host'],
    ['https://bodega-bay.example.com/', 'out-of-namespace'],
    ['https://a.bodega-bay.fiveacross.app/', 'nested-label'],
    ['https://ab.fiveacross.app/', 'invalid-slug:too-short'],
    ['https://xn--80ak6aa92e.fiveacross.app/', 'invalid-slug:reserved-tag'],
    ['https://-bodega.fiveacross.app/', 'invalid-slug:edge-hyphen'],
  ] as const)('refuses %s with reason %s', async (url, reason) => {
    const { deps } = harness();
    const response = await handleRequest(get(url), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
  });

  it('names the broken Slug rule while keeping the class greppable as a prefix', async () => {
    const { deps } = harness();
    const response = await handleRequest(get('https://ab.fiveacross.app/'), CONFIG, deps);
    expect(response.headers.get('x-event-router-reason')).toMatch(/^invalid-slug:/);
  });

  it('renders the not-found state rather than returning a bare status', async () => {
    const { deps } = harness();
    const response = await handleRequest(get('https://unknown-event.fiveacross.app/'), CONFIG, deps);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain("isn&rsquo;t in service");
    // Brand-neutral: the router does not know the Edition, so it names none.
    expect(body).not.toMatch(/bingo/i);
    expect(body).not.toMatch(/five across/i);
    // Nothing external to fetch, so nothing that can fail a second time.
    expect(body).not.toMatch(/<script|https?:\/\//i);
  });

  it('never caches the not-found state, so a just-provisioned address is not stuck behind a TTL', async () => {
    const { deps } = harness();
    const response = await handleRequest(get('https://unknown-event.fiveacross.app/'), CONFIG, deps);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('does not reach the origin on a fail-closed path', async () => {
    const { deps, requests } = harness();
    await handleRequest(get('https://unknown-event.fiveacross.app/assets/app.js'), CONFIG, deps);
    expect(requests.every((r) => !r.url.includes('fiveacross.web.app'))).toBe(true);
  });
});

describe('/__/auth/* passthrough', () => {
  it.each(['/__/auth/handler', '/__/auth/iframe', '/__/auth'])(
    'proxies %s intact without a lookup, so a Firestore blip cannot break sign-in mid-transaction',
    async (path) => {
      const { deps, requests } = harness();
      const response = await handleRequest(
        get(`https://bodega-bay.fiveacross.app${path}?state=abc`),
        CONFIG,
        deps,
      );
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      const proxied = new URL(requests[0].url);
      expect(proxied.hostname).toBe('fiveacross.web.app');
      expect(proxied.pathname).toBe(path);
      expect(proxied.search).toBe('?state=abc');
    },
  );

  it('still applies the namespace guard to an auth path', async () => {
    const { deps, requests } = harness();
    const response = await handleRequest(
      get('https://admin.fiveacross.app/__/auth/handler'),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it('does not exempt a path that merely starts with the same characters', async () => {
    const { deps } = harness();
    const response = await handleRequest(
      get('https://unknown-event.fiveacross.app/__/authorize'),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(404);
  });

  it('is NOT exempt from the unconfigured-router refusal', async () => {
    // A missing api key is a total misconfiguration, not the transient
    // dependency failure the exemption exists to survive — so "fails closed on
    // every address" has to include the one path that skips the lookup.
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/__/auth/handler'),
      { ...CONFIG, apiKey: '' },
      deps,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(requests).toHaveLength(0);
  });
});

describe('an unconfigured router', () => {
  it.each([
    'https://bodega-bay.fiveacross.app/',
    'https://bodega-bay.fiveacross.app/assets/app.js',
    'https://fiveacross.app/',
    'https://bodega-bay.fiveacross.app/__/auth/handler',
  ])('fails closed on %s rather than serving', async (url) => {
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(get(url), { ...CONFIG, projectId: '' }, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(requests).toHaveLength(0);
  });
});
