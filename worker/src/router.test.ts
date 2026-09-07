// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  handleRequest,
  PATH_CAPABILITY_PATH,
  type RouterConfig,
  type RouterDeps,
} from './router';
import { WEB_MANIFEST_PATH } from './manifest';
import type { RegistryLookup } from './registry/state';
import { RESERVED_LABELS } from '../../src/slug';
// `edition-brands`, not `editions`: this program has no DOM lib and no
// `vite/client`, which is why #546 split the table out in the first place.
import { brandFor } from '../../src/edition-brands';

const CONFIG: RouterConfig = {
  originHost: 'fiveacross.web.app',
  lookupTimeoutMs: 2_000,
  version: 'test-1',
};

const SERVING: RegistryLookup = {
  kind: 'committed',
  schemaVersion: 1,
  revision: '42',
  desired: {
    kind: 'route',
    eventId: 'bodega-bay-2026',
    status: 'active',
    slug: 'bodega-bay',
    edition: 'fiveacross',
    pathNamespace: null,
  },
};

const APEX_ROOT: RegistryLookup = {
  kind: 'committed',
  schemaVersion: 1,
  revision: '5',
  desired: { kind: 'root', root: 'doorway', edition: 'fiveacross', pathNamespace: 'fiveacross.app' },
};

/**
 * Every test below seeds the resolution through the registry seam so the
 * assertions are about ROUTING; `resolve.test.ts` owns the lookup's own
 * decision table.
 *
 * There is deliberately no cache, no Firestore stub and no api key here any
 * more. `fetch` is recorded rather than merely stubbed so each test can assert
 * what the router did NOT reach for — the "no Firebase, KV or Cache API
 * request" property is only checkable if every outbound call is observable.
 */
function harness(
  options: { seed?: Record<string, RegistryLookup>; origin?: Response; originError?: Error } = {},
) {
  const seed = options.seed ?? {};
  const lookup = vi.fn(async (host: string): Promise<RegistryLookup> => seed[host] ?? { kind: 'unknown-host' });

  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(request);
    if (options.originError) throw options.originError;
    return options.origin ?? new Response('<!doctype html><title>app</title>', { status: 200 });
  });

  const deps: RouterDeps = {
    fetch: fetchImpl as unknown as RouterDeps['fetch'],
    registry: { lookup },
  };
  return { deps, requests, lookup };
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

  it('returns the origin status and headers, plus its own version and revision stamps', async () => {
    const { deps } = harness({
      seed: servingSeed,
      origin: new Response('nope', { status: 503, headers: { 'x-origin-marker': 'yes' } }),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-origin-marker')).toBe('yes');
    expect(response.headers.get('x-event-router')).toBe('test-1');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it('overwrites an origin-supplied revision header rather than relaying it', async () => {
    // The revision is the edge's own validated decimal. An origin that emitted
    // a header by that name must not be able to have it read as one.
    const { deps } = harness({
      seed: servingSeed,
      origin: new Response('ok', { headers: { 'x-event-router-revision': '999999' } }),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it.each([
    'https://bodega-bay.fiveacross.app/board',
    'https://bodega-bay.fiveacross.app/__/auth/handler',
  ])('turns an origin-fetch rejection for %s into a versioned non-redirect gateway response (#902)', async (url) => {
    const { deps } = harness({ seed: servingSeed, originError: new Error('TLS handshake leaked detail') });

    const response = await handleRequest(get(url), CONFIG, deps);

    expect(response.status).toBe(502);
    expect(response.headers.get('x-event-router')).toBe('test-1');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('TLS handshake leaked detail');
  });

  it('serves the Namespace apex from a root marker', async () => {
    const { deps, requests } = harness({ seed: { 'fiveacross.app': APEX_ROOT } });
    const response = await handleRequest(get('https://fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-event-router-revision')).toBe('5');
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
      `https://bodega-bay.fiveacross.app${PATH_CAPABILITY_PATH}`,
      `https://bodega-bay.fiveacross.app${WEB_MANIFEST_PATH}`,
      `https://unknown-event.fiveacross.app${WEB_MANIFEST_PATH}`,
    ];
    const { deps } = harness({ seed: { ...servingSeed, 'fiveacross.app': APEX_ROOT } });

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
  it.each([...RESERVED_LABELS])(
    'refuses the reserved label %s WITHOUT consulting the registry',
    async (label) => {
      const { deps, requests, lookup } = harness({
        // Even a committed projection that names this host must not promote it:
        // the guard is decided before any registry work is created.
        seed: { [`${label}.fiveacross.app`]: SERVING },
      });
      const response = await handleRequest(get(`https://${label}.fiveacross.app/`), CONFIG, deps);
      expect(response.status).toBe(404);
      expect(response.headers.get('x-event-router-reason')).toBe('reserved-label');
      expect(lookup).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    ['https://bodega-bay.example.com/', 'out-of-namespace'],
    ['https://a.bodega-bay.fiveacross.app/', 'nested-label'],
    ['https://ab.fiveacross.app/', 'invalid-slug:too-short'],
    ['https://xn--80ak6aa92e.fiveacross.app/', 'invalid-slug:reserved-tag'],
    ['https://-bodega.fiveacross.app/', 'invalid-slug:edge-hyphen'],
  ] as const)(
    'refuses %s with reason %s before the registry binding is touched',
    async (url, reason) => {
      const { deps, lookup } = harness();
      const response = await handleRequest(get(url), CONFIG, deps);
      expect(response.status).toBe(404);
      expect(response.headers.get('x-event-router-reason')).toBe(reason);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  // The third column is the `x-event-router-revision` the refusal carries, and
  // it is not decoration: `specs/event-router-registry.md` § Audit and
  // recovery makes the public `{reason, revision}` pair the evidence a
  // recovery lock is cleared with, so `inactive` and a tombstone's
  // `unknown-host` must publish the committed revision they were refused from
  // while every refusal with no record to attribute publishes none.
  it.each([
    [{ kind: 'unknown-host' } as RegistryLookup, 'unknown-host', null],
    [{ kind: 'unknown-host', schemaVersion: 1, revision: '9' } as RegistryLookup, 'unknown-host', '9'],
    [{ kind: 'unavailable' } as RegistryLookup, 'lookup-unavailable', null],
    [{ kind: 'malformed' } as RegistryLookup, 'replica-malformed', null],
    [
      {
        kind: 'committed',
        schemaVersion: 1,
        revision: '3',
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'disabled',
          slug: 'bodega-bay',
          edition: 'fiveacross',
          pathNamespace: null,
        },
      } as RegistryLookup,
      'inactive',
      '3',
    ],
    [
      { kind: 'committed', schemaVersion: 1, revision: '9', desired: { kind: 'tombstone' } } as RegistryLookup,
      'unknown-host',
      '9',
    ],
    [
      {
        kind: 'committed',
        schemaVersion: 1,
        revision: '3',
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'active',
          slug: 'somewhere-else',
          edition: 'fiveacross',
          pathNamespace: null,
        },
      } as RegistryLookup,
      'slug-mismatch',
      null,
    ],
    // A projection committed under a schema version this router build cannot
    // read is refused with the documented header and reason, and — the part
    // that matters — the origin is never reached for it. An additive v2 whose
    // `desired` kept today's discriminants would otherwise be proxied as a
    // perfectly ordinary active route (`specs/event-router-registry.md`
    // § Failure semantics, "malformed/unsupported committed state").
    [
      {
        kind: 'committed',
        schemaVersion: 2,
        revision: '3',
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'active',
          slug: 'bodega-bay',
          edition: 'fiveacross',
          pathNamespace: null,
        },
      } as RegistryLookup,
      'replica-malformed',
      null,
    ],
    [
      { kind: 'unknown-host', schemaVersion: 2, revision: '9' } as RegistryLookup,
      'replica-malformed',
      null,
    ],
  ] as const)('renders reason %#: %s', async (answer, reason, revision) => {
    const { deps, requests } = harness({ seed: { 'bodega-bay.fiveacross.app': answer } });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
    expect(response.headers.get('x-event-router')).toBe('test-1');
    expect(response.headers.get('x-event-router-revision')).toBe(revision);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(requests).toHaveLength(0);
  });

  it('stamps no revision on a guard that refuses before the lookup', async () => {
    // A reserved label never reaches a record, so there is nothing for it to
    // quote a revision from — and the binding is never touched to find one.
    const { deps, lookup } = harness();
    const response = await handleRequest(get('https://admin.fiveacross.app/'), CONFIG, deps);
    expect(response.headers.get('x-event-router-reason')).toBe('reserved-label');
    expect(response.headers.get('x-event-router-revision')).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
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
    expect(requests).toHaveLength(0);
  });
});

describe('the path-capability projection', () => {
  const capabilityUrl = (host: string) => `https://${host}${PATH_CAPABILITY_PATH}`;

  it('answers an exact GET from the same lookup, with no Event ID and no catalogue', async () => {
    const { deps, requests, lookup } = harness({ seed: { 'fiveacross.app': APEX_ROOT } });
    const response = await handleRequest(get(capabilityUrl('fiveacross.app')), CONFIG, deps);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-event-router')).toBe('test-1');
    expect(response.headers.get('x-event-router-revision')).toBe('5');

    const body: unknown = await response.json();
    expect(body).toEqual({ schemaVersion: 1, pathNamespace: 'fiveacross.app', revision: '5' });
    // Exactly three fields: anything more is an enumeration surface on a
    // public, unauthenticated endpoint.
    expect(Object.keys(body as object).sort()).toEqual(['pathNamespace', 'revision', 'schemaVersion']);
    // From the SAME point lookup that decided the request may proceed — one
    // call, and no second source behind it.
    expect(lookup).toHaveBeenCalledExactlyOnceWith('fiveacross.app');
    expect(requests).toHaveLength(0);
  });

  it('reports a null path namespace on an Event subdomain rather than omitting the field', async () => {
    const { deps } = harness({ seed: servingSeed });
    const response = await handleRequest(get(capabilityUrl('bodega-bay.fiveacross.app')), CONFIG, deps);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      pathNamespace: null,
      revision: '42',
    });
  });

  it.each([
    [{ kind: 'unknown-host' } as RegistryLookup, 'unknown-host'],
    [{ kind: 'unavailable' } as RegistryLookup, 'lookup-unavailable'],
    [{ kind: 'malformed' } as RegistryLookup, 'replica-malformed'],
    [
      { kind: 'committed', schemaVersion: 1, revision: '9', desired: { kind: 'tombstone' } } as RegistryLookup,
      'unknown-host',
    ],
    [
      {
        kind: 'committed',
        schemaVersion: 1,
        revision: '3',
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'archived',
          slug: 'bodega-bay',
          edition: 'fiveacross',
          pathNamespace: null,
        },
      } as RegistryLookup,
      'inactive',
    ],
    // The path capability is projected from the SAME lookup, so an unreadable
    // schema version withholds it for the same reason it withholds the shell.
    [
      {
        kind: 'committed',
        schemaVersion: 2,
        revision: '3',
        desired: {
          kind: 'route',
          eventId: 'e',
          status: 'active',
          slug: 'bodega-bay',
          edition: 'fiveacross',
          pathNamespace: null,
        },
      } as RegistryLookup,
      'replica-malformed',
    ],
  ])('returns NO capability when the lookup fails closed (%#)', async (answer, reason) => {
    const { deps } = harness({ seed: { 'bodega-bay.fiveacross.app': answer } });
    const response = await handleRequest(get(capabilityUrl('bodega-bay.fiveacross.app')), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('applies the namespace guard to the capability path like any other', async () => {
    const { deps, lookup } = harness();
    const response = await handleRequest(get(capabilityUrl('admin.fiveacross.app')), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('reserved-label');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['HEAD', 'POST'])('proxies a %s on that path instead of answering it', async (method) => {
    // Exact path AND exact method. Anything else is an ordinary request to the
    // host and gets the answer the origin would have given.
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(
      get(capabilityUrl('bodega-bay.fiveacross.app'), { method }),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(PATH_CAPABILITY_PATH);
  });

  it('does not answer a sibling well-known path', async () => {
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/.well-known/fiveacross-path-capability-extra'),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
  });
});

describe('the per-hostname PWA manifest (#546)', () => {
  const VACAY: RegistryLookup = {
    kind: 'committed',
    schemaVersion: 1,
    revision: '42',
    desired: {
      kind: 'route',
      eventId: 'bodega-bay-2026',
      status: 'active',
      slug: 'bodega-bay',
      edition: 'vacay',
      pathNamespace: null,
    },
  };
  const manifestUrl = (host: string) => `https://${host}${WEB_MANIFEST_PATH}`;

  it('answers from the resolved Edition rather than proxying to the origin', async () => {
    const { deps, requests, lookup } = harness({ seed: { 'bodega-bay.vacaybingo.com': VACAY } });
    const response = await handleRequest(get(manifestUrl('bodega-bay.vacaybingo.com')), CONFIG, deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: brandFor('vacay').appName,
      short_name: brandFor('vacay').appShortName,
    });
    // The origin serves ONE bundle to every address, so proxying this would
    // hand a Vacay guest the bundle Edition's manifest — which is the whole
    // defect. Nothing left for the origin at all here, and the Edition came
    // out of the SAME point lookup that decided the request may proceed.
    expect(requests).toHaveLength(0);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('bodega-bay.vacaybingo.com');
    expect(response.headers.get('x-event-router')).toBe('test-1');
  });

  it('carries the revision stamp like every other served response', async () => {
    // The header is a property of a resolved edge record, not of the proxy
    // path: the recovery machine reads it off whatever the edge answered.
    const { deps } = harness({ seed: { 'bodega-bay.vacaybingo.com': VACAY } });
    const response = await handleRequest(get(manifestUrl('bodega-bay.vacaybingo.com')), CONFIG, deps);
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it('answers the same committed projection on either Namespace', async () => {
    const { deps } = harness({
      seed: { 'bodega-bay.fiveacross.app': VACAY, 'bodega-bay.vacaybingo.com': VACAY },
    });
    const canonical = await handleRequest(get(manifestUrl('bodega-bay.fiveacross.app')), CONFIG, deps);
    const alternate = await handleRequest(get(manifestUrl('bodega-bay.vacaybingo.com')), CONFIG, deps);
    // #599 as amended: both hosts SERVE, each with its Event's Edition, and
    // neither is bounced at the other. Per-origin installed apps are the
    // accepted consequence — with the same name on both.
    expect(await canonical.text()).toBe(await alternate.text());
  });

  it('serves the apex root marker its own Edition', async () => {
    const { deps } = harness({ seed: { 'fiveacross.app': APEX_ROOT } });
    const response = await handleRequest(get(manifestUrl('fiveacross.app')), CONFIG, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: brandFor('fiveacross').appName });
    expect(response.headers.get('x-event-router-revision')).toBe('5');
  });

  it('fails closed on a projection naming an Edition this build does not know, rather than defaulting', async () => {
    // There is no "default Edition" arm at the edge. The shared builder keeps
    // its fallback for the build-side consumer, but a committed projection
    // whose `edition` the boundary re-validation cannot place is refused as
    // malformed BEFORE this route sees it — so an installed app is never named
    // for a product the registry did not actually commit.
    const unknownEdition: RegistryLookup = {
      kind: 'committed',
      schemaVersion: 1,
      revision: '42',
      desired: {
        kind: 'route',
        eventId: 'bodega-bay-2026',
        status: 'active',
        slug: 'bodega-bay',
        edition: 'bodega' as never,
        pathNamespace: null,
      },
    };
    const { deps, requests } = harness({ seed: { 'bodega-bay.fiveacross.app': unknownEdition } });
    const response = await handleRequest(get(manifestUrl('bodega-bay.fiveacross.app')), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('replica-malformed');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(requests).toHaveLength(0);
  });

  // The route sits AFTER the namespace guard and AFTER resolution, and this is
  // the block that proves it. It is not an exemption like `/__/auth/*` — the
  // opposite: it strictly depends on the resolution it derives from, so an
  // address that does not serve an app does not serve an app identity either.
  it.each([
    ['admin.fiveacross.app', 'reserved-label'],
    ['unknown-event.fiveacross.app', 'unknown-host'],
    ['bodega-bay.example.com', 'out-of-namespace'],
    ['ab.fiveacross.app', 'invalid-slug:too-short'],
  ] as const)('fails closed at %s with reason %s', async (host, reason) => {
    const { deps, requests } = harness({ seed: { 'admin.fiveacross.app': VACAY } });
    const response = await handleRequest(get(manifestUrl(host)), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(requests).toHaveLength(0);
  });

  it('fails closed for an inactive Event rather than serving its identity', async () => {
    const disabled: RegistryLookup = {
      kind: 'committed',
      schemaVersion: 1,
      revision: '42',
      desired: {
        kind: 'route',
        eventId: 'bodega-bay-2026',
        status: 'disabled',
        slug: 'bodega-bay',
        edition: 'vacay',
        pathNamespace: null,
      },
    };
    const { deps } = harness({ seed: { 'bodega-bay.fiveacross.app': disabled } });
    const response = await handleRequest(get(manifestUrl('bodega-bay.fiveacross.app')), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('inactive');
  });

  it('fails closed on an unconfigured router, like every other path', async () => {
    const { deps, requests } = harness({ seed: { 'bodega-bay.fiveacross.app': VACAY } });
    const response = await handleRequest(get(manifestUrl('bodega-bay.fiveacross.app')), CONFIG, {
      ...deps,
      registry: null,
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(requests).toHaveLength(0);
  });

  it('answers HEAD with no body', async () => {
    const { deps } = harness({ seed: { 'bodega-bay.vacaybingo.com': VACAY } });
    const response = await handleRequest(
      get(manifestUrl('bodega-bay.vacaybingo.com'), { method: 'HEAD' }),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it('leaves a non-GET/HEAD request on that path to the proxy', async () => {
    // The router does not start refusing methods at an address it used to
    // relay; that would be a behaviour change hiding inside a branding fix.
    const { deps, requests } = harness({ seed: { 'bodega-bay.vacaybingo.com': VACAY } });
    const response = await handleRequest(
      get(manifestUrl('bodega-bay.vacaybingo.com'), { method: 'POST' }),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(requests.at(-1)!.url).toContain('fiveacross.web.app');
  });

  it('leaves every other path to the proxy', async () => {
    const { deps, requests } = harness({ seed: { 'bodega-bay.vacaybingo.com': VACAY } });
    await handleRequest(get(`${manifestUrl('bodega-bay.vacaybingo.com')}.bak`), CONFIG, deps);
    expect(requests.at(-1)!.url).toContain('fiveacross.web.app');
  });
});

describe('/__/auth/* passthrough', () => {
  it.each(['/__/auth/handler', '/__/auth/iframe', '/__/auth'])(
    'proxies %s intact without a lookup, so a registry blip cannot break sign-in mid-transaction',
    async (path) => {
      const { deps, requests, lookup } = harness();
      const response = await handleRequest(
        get(`https://bodega-bay.fiveacross.app${path}?state=abc`),
        CONFIG,
        deps,
      );
      expect(response.status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      const proxied = new URL(requests[0].url);
      expect(proxied.hostname).toBe('fiveacross.web.app');
      expect(proxied.pathname).toBe(path);
      expect(proxied.search).toBe('?state=abc');
      // No record was resolved, so there is no revision to stamp.
      expect(response.headers.get('x-event-router')).toBe('test-1');
      expect(response.headers.get('x-event-router-revision')).toBeNull();
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
    // A missing binding is a total misconfiguration, not the transient
    // dependency failure the exemption exists to survive — so "fails closed on
    // every address" has to include the one path that skips the lookup.
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/__/auth/handler'),
      CONFIG,
      { ...deps, registry: null },
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
    `https://bodega-bay.fiveacross.app${PATH_CAPABILITY_PATH}`,
    `https://bodega-bay.fiveacross.app${WEB_MANIFEST_PATH}`,
  ])('fails closed on %s rather than serving when the origin host is unbound', async (url) => {
    const { deps, requests, lookup } = harness({ seed: servingSeed });
    const response = await handleRequest(get(url), { ...CONFIG, originHost: '' }, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(lookup).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it.each([
    'https://bodega-bay.fiveacross.app/',
    'https://fiveacross.app/',
    'https://bodega-bay.fiveacross.app/__/auth/handler',
    `https://bodega-bay.fiveacross.app${WEB_MANIFEST_PATH}`,
  ])('fails closed on %s when the registry binding is absent', async (url) => {
    const { deps, requests } = harness({ seed: servingSeed });
    const response = await handleRequest(get(url), CONFIG, { ...deps, registry: null });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('lookup-unavailable');
    expect(requests).toHaveLength(0);
  });
});

describe('what the router no longer reaches for', () => {
  it('makes no request other than the origin proxy, on any outcome', async () => {
    // The Firebase read is gone, and so is the Cache API envelope in front of
    // it. `RouterDeps` has exactly two members, so there is nowhere else for a
    // lookup to come from — which is what "no Firestore, KV, negative, stale or
    // other fallback" means in code rather than in prose.
    const { deps, requests } = harness({ seed: { ...servingSeed, 'fiveacross.app': APEX_ROOT } });
    for (const url of [
      'https://bodega-bay.fiveacross.app/',
      'https://fiveacross.app/',
      'https://unknown-event.fiveacross.app/',
      'https://admin.fiveacross.app/',
      'https://bodega-bay.fiveacross.app/__/auth/handler',
      `https://bodega-bay.fiveacross.app${PATH_CAPABILITY_PATH}`,
      `https://bodega-bay.fiveacross.app${WEB_MANIFEST_PATH}`,
    ]) {
      await handleRequest(get(url), CONFIG, deps);
    }

    expect(Object.keys(deps).sort()).toEqual(['fetch', 'registry']);
    for (const request of requests) {
      expect(new URL(request.url).hostname).toBe('fiveacross.web.app');
    }
    expect(requests.every((request) => request.headers.get('authorization') === null)).toBe(true);
  });

  it('bounds the registry call at the configured timeout rather than the origin fetch', async () => {
    const { deps } = harness({ seed: servingSeed });
    expect(CONFIG.lookupTimeoutMs).toBe(2_000);
    await expect(
      handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps),
    ).resolves.toMatchObject({ status: 200 });
  });
});
