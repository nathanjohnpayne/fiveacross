// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  handleRequest,
  PATH_CAPABILITY_PATH,
  type RouterConfig,
  type RouterDeps,
} from './router';
import type { HeadIdentityEdit } from './htmlHead';
import { WEB_MANIFEST_PATH } from './manifest';
import type { RegistryLookup } from './registry/state';
import { RESERVED_LABELS } from '../../src/slug';
// `edition-brands`, not `editions`: this program has no DOM lib and no
// `vite/client`, which is why #546 split the table out in the first place.
import { brandFor } from '../../src/edition-brands';
import { headIdentityEdits } from '../../src/html-head-identity';
import { webManifestForEdition } from '../../src/web-manifest';

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
  options: {
    seed?: Record<string, RegistryLookup>;
    origin?: Response;
    /** Takes the outbound subrequest, so a stub origin can answer the way the
     *  real one does — a `304` to a forwarded validator, say. */
    originFor?: (request: Request) => Response;
    originError?: Error;
  } = {},
) {
  const seed = options.seed ?? {};
  const lookup = vi.fn(async (host: string): Promise<RegistryLookup> => seed[host] ?? { kind: 'unknown-host' });

  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(request);
    if (options.originError) throw options.originError;
    if (options.originFor) return options.originFor(request);
    return options.origin ?? new Response('<!doctype html><title>app</title>', { status: 200 });
  });

  // The HTML transform is recorded rather than performed: `HTMLRewriter` is a
  // workerd global this program does not have, and what belongs HERE is the
  // decision — which responses reach the rewrite and with what edits — rather
  // than the transform itself, which `routerHtmlHead.integration.test.ts`
  // proves against the real runtime.
  const rewrites: { response: Response; edits: readonly HeadIdentityEdit[] }[] = [];
  const htmlRewriter = vi.fn((response: Response, edits: readonly HeadIdentityEdit[]) => {
    rewrites.push({ response, edits });
    return response;
  });

  const deps: RouterDeps = {
    fetch: fetchImpl as unknown as RouterDeps['fetch'],
    registry: { lookup },
    htmlRewriter,
  };
  return { deps, requests, lookup, rewrites, htmlRewriter };
}

/** An origin response the `<head>` rewrite is allowed to touch: 200, HTML,
 *  with a body. Built per call because a `Response` body is single-use. */
function htmlOrigin(init: ResponseInit = {}): Response {
  return new Response('<!doctype html><html><head><title>app</title></head><body></body></html>', {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });
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

  it('reports the absent binding through the diagnostic seam, ahead of the auth exemption', async () => {
    // Codex P2 on #1120: the unconfigured early return bypasses `resolveHost`,
    // which was the only path that reported, so production answered
    // `lookup-unavailable` with no `event-router.diagnostic` line — invisible
    // to the alerting the spec's Failure semantics require for exactly this case.
    const events: unknown[] = [];
    const { deps } = harness({ seed: { 'bodega-bay.fiveacross.app': VACAY } });
    const unconfigured = { ...deps, registry: null, diagnostics: (event: unknown) => events.push(event) };
    await handleRequest(get(manifestUrl('bodega-bay.fiveacross.app')), CONFIG, unconfigured);
    await handleRequest(get('https://bodega-bay.fiveacross.app/__/auth/handler'), CONFIG, unconfigured);
    expect(events).toEqual([
      { event: 'event-router.diagnostic', outcome: 'lookup-unavailable', host: 'bodega-bay.fiveacross.app' },
      { event: 'event-router.diagnostic', outcome: 'lookup-unavailable', host: 'bodega-bay.fiveacross.app' },
    ]);
    // Foreign and malformed hosts are refused before the binding is consulted,
    // so they never report: the guard ordering keeps invalid traffic silent.
    events.length = 0;
    await handleRequest(get('https://bodega-bay.example.com/'), CONFIG, unconfigured);
    await handleRequest(get('https://x.fiveacross.app/'), CONFIG, unconfigured);
    expect(events).toEqual([]);
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

describe('the per-hostname HTML head rewrite (#1118)', () => {
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
  const vacaySeed = {
    'bodega-bay.fiveacross.app': VACAY,
    'bodega-bay.vacaybingo.com': VACAY,
  };

  /** What an edit list says for one selector, so an assertion can name the tag
   *  rather than an array index. */
  const contentFor = (edits: readonly HeadIdentityEdit[], selector: string) =>
    edits.find((edit) => edit.selector === selector)?.content;

  it.each(['bodega-bay.fiveacross.app', 'bodega-bay.vacaybingo.com'])(
    'brands the share block for the Edition %s resolved to',
    async (host) => {
      const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      const response = await handleRequest(get(`https://${host}/`), CONFIG, deps);

      expect(response.status).toBe(200);
      expect(rewrites).toHaveLength(1);
      const brand = brandFor('vacay');
      const { edits } = rewrites[0]!;
      // Every tag a crawler reads, from the Edition THIS hostname resolved to
      // — not the one the single bundle happened to be built with.
      expect(contentFor(edits, 'meta[name="description"]')).toBe(brand.metaDescription);
      expect(contentFor(edits, 'meta[property="og:site_name"]')).toBe(brand.documentTitle);
      expect(contentFor(edits, 'meta[property="og:title"]')).toBe(brand.documentTitle);
      expect(contentFor(edits, 'meta[property="og:image"]')).toBe(brand.ogImage);
      expect(contentFor(edits, 'meta[property="og:image:alt"]')).toBe(brand.ogImageAlt);
      expect(contentFor(edits, 'meta[name="twitter:image"]')).toBe(brand.ogImage);
      // ...and the whole list is exactly what the shared table produces, so a
      // row added there cannot be silently dropped on the way to the edge.
      expect(edits).toEqual(headIdentityEdits(brand, host));
    },
  );

  it.each(['bodega-bay.fiveacross.app', 'bodega-bay.vacaybingo.com'])(
    'emits %s’s own origin as og:url, not the brand row’s static value',
    async (host) => {
      // The one value whose truth is per-EVENT rather than per-Edition: the
      // vacay row names a single Event's canonical host because a build has
      // nowhere else to put it, and a guest who shares from the other
      // registered host must not send a link filed under the first one.
      const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      await handleRequest(get(`https://${host}/board?day=3`), CONFIG, deps);

      expect(contentFor(rewrites[0]!.edits, 'meta[property="og:url"]')).toBe(`https://${host}/`);
    },
  );

  it('does not hand the alternate host the canonical host the brand row carries', async () => {
    // The brand row can only carry ONE origin, and it carries the Event's
    // canonical one. Before this, a guest who shared from
    // bodega-bay.vacaybingo.com sent a link an unfurl filed under
    // bodega-bay.fiveacross.app — a host they did not enter through.
    const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
    await handleRequest(get('https://bodega-bay.vacaybingo.com/'), CONFIG, deps);
    expect(contentFor(rewrites[0]!.edits, 'meta[property="og:url"]')).not.toBe(
      brandFor('vacay').ogUrl,
    );
  });

  it('keeps theme-color byte-identical to the manifest this same host serves', async () => {
    // `specs/w1-pwa.md` requires the two to match exactly, and they are now
    // per-Edition — so the assertion compares the rewritten tag against the
    // manifest the SAME router answers on the SAME host, rather than against a
    // restatement of either value.
    const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
    await handleRequest(get('https://bodega-bay.vacaybingo.com/'), CONFIG, deps);
    const manifest = await handleRequest(
      get(`https://bodega-bay.vacaybingo.com${WEB_MANIFEST_PATH}`),
      CONFIG,
      deps,
    );

    const themeColor = contentFor(rewrites[0]!.edits, 'meta[name="theme-color"]');
    expect(themeColor).toBe(((await manifest.json()) as { theme_color: string }).theme_color);
    expect(themeColor).toBe(brandFor('vacay').chromeColor);
  });

  it('gives two Editions two different chrome colours, so the equality is not vacuous', async () => {
    const { deps, rewrites } = harness({
      seed: { 'bodega-bay.fiveacross.app': VACAY, 'fiveacross.app': APEX_ROOT },
      originFor: () => htmlOrigin(),
    });
    await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    await handleRequest(get('https://fiveacross.app/'), CONFIG, deps);

    const colours = rewrites.map((rewrite) => contentFor(rewrite.edits, 'meta[name="theme-color"]'));
    expect(colours).toEqual([brandFor('vacay').chromeColor, brandFor('fiveacross').chromeColor]);
    expect(new Set(colours).size).toBe(2);
  });

  it('drops the origin’s content-length, which describes the pre-rewrite bytes', async () => {
    const { deps, rewrites } = harness({
      seed: vacaySeed,
      originFor: () => htmlOrigin({ headers: { 'content-length': '71' } }),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(rewrites).toHaveLength(1);
    expect(response.headers.get('content-length')).toBeNull();
  });

  describe('a conditional revalidation of a document', () => {
    const CONDITIONAL = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'if-none-match': '"origin-index"',
      'if-modified-since': 'Wed, 01 Jul 2026 00:00:00 GMT',
    };

    it('reaches the origin with neither validator, so a body comes back to rewrite', async () => {
      // The origin serves one baked `index.html` to every hostname, so its
      // validators are still current after the registry has repointed this
      // hostname to another Edition. Forwarding them invites a `304` that is
      // true of the origin and false of what this host must serve.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => htmlOrigin(),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', { headers: CONDITIONAL }),
        CONFIG,
        deps,
      );

      const proxied = requests.at(-1)!;
      expect(proxied.headers.get('if-none-match')).toBeNull();
      expect(proxied.headers.get('if-modified-since')).toBeNull();
      expect(proxied.headers.get('accept')).toBe(CONDITIONAL.accept);
      expect(response.status).toBe(200);
      expect(rewrites).toHaveLength(1);
      expect(contentFor(rewrites[0]!.edits, 'meta[property="og:site_name"]')).toBe(
        brandFor('vacay').documentTitle,
      );
    });

    it('is answered with none of the origin’s own validators', async () => {
      // They describe the pre-rewrite bytes, identically for every hostname.
      // Handing them back would re-open the same window one cache generation
      // later; emitting nothing closes it after one unconditional fetch.
      const { deps } = harness({
        seed: vacaySeed,
        originFor: () =>
          htmlOrigin({
            headers: {
              etag: '"origin-index"',
              'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT',
              'cache-control': 'no-cache',
            },
          }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', { headers: CONDITIONAL }),
        CONFIG,
        deps,
      );

      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('last-modified')).toBeNull();
      // Everything else the origin said about caching is still its own.
      expect(response.headers.get('cache-control')).toBe('no-cache');
    });

    it.each([
      ['a browser', CONDITIONAL.accept],
      ['a crawler', '*/*'],
    ])('takes the Range and If-Range off %s ranged document request', async (_who, accept) => {
      // A `206` is refused by the rewrite, so a ranged document used to be
      // relayed exactly as the origin wrote it. Safe alone, wrong in company:
      // the same URL answers an ordinary `GET` with the REWRITTEN
      // representation, a different length, so a client resuming or
      // assembling the document splices baked bytes into rewritten ones and a
      // range covering the head hands back the Edition the bundle was built
      // with. A byte range over the SPA shell has no legitimate use, and a
      // server may always answer one with the full `200` instead.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: (request) =>
          request.headers.get('range') !== null
            ? new Response('<!doctype html><head>', {
                status: 206,
                headers: {
                  'content-type': 'text/html; charset=utf-8',
                  'content-range': 'bytes 0-20/4096',
                },
              })
            : htmlOrigin(),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', {
          headers: { accept, 'if-range': '"origin-index"', range: 'bytes=0-99' },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('range')).toBeNull();
      // Nothing left for it to qualify.
      expect(requests.at(-1)!.headers.get('if-range')).toBeNull();
      // The stub answers `206` to any forwarded range, so a `200` here is the
      // proof that none was forwarded.
      expect(response.status).toBe(200);
      expect(response.headers.get('content-range')).toBeNull();
      expect(rewrites).toHaveLength(1);
    });

    it('leaves an asset request’s Range alone and relays its 206 byte for byte', async () => {
      // Where a `206` can still arise, and the reason it is safe there: an
      // asset is never rewritten, so the origin's representation is the only
      // one this URL has and its byte offsets still describe it.
      const partial = 'export cons';
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () =>
          new Response(partial, {
            status: 206,
            headers: {
              'content-type': 'application/javascript',
              'content-range': 'bytes 0-10/36',
              'content-length': String(partial.length),
            },
          }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/assets/app.js', {
          headers: { accept: '*/*', 'if-range': '"asset"', range: 'bytes=0-10' },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('range')).toBe('bytes=0-10');
      expect(requests.at(-1)!.headers.get('if-range')).toBe('"asset"');
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-10/36');
      expect(response.headers.get('content-length')).toBe(String(partial.length));
      expect(await response.text()).toBe(partial);
      expect(rewrites).toHaveLength(0);
    });

    it('leaves an asset request’s validators alone and relays its 304', async () => {
      // The other half of the rule: an asset is not rewritten, so its
      // revalidation is still worth exactly what it was worth before.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => new Response(null, { status: 304, headers: { etag: '"asset"' } }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/assets/app.js', {
          headers: { accept: '*/*', 'if-none-match': '"asset"' },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('if-none-match')).toBe('"asset"');
      expect(response.status).toBe(304);
      expect(response.headers.get('etag')).toBe('"asset"');
      expect(rewrites).toHaveLength(0);
    });

    it('leaves the /__/auth/* exemption’s validators alone, like everything else about it', async () => {
      const { deps, requests } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/__/auth/handler', { headers: CONDITIONAL }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('if-none-match')).toBe('"origin-index"');
    });
  });

  describe('the encoding a document subrequest negotiates', () => {
    const NAVIGATION = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
    };

    it('asks the origin for identity, so what reaches the transform is markup', async () => {
      // An origin that honours the forwarded encoding answers a document in
      // `gzip` or `br`, and `HTMLRewriter` then parses bytes no HTML parser
      // can read: it matches nothing, changes nothing, reports success, and
      // the client receives the bundle's baked Edition.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => htmlOrigin(),
      });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/', { headers: NAVIGATION }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('identity');
      expect(rewrites).toHaveLength(1);
    });

    const CRAWLER = {
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    };

    it.each(['/', '/board', '/board/', '/index.html'])(
      'asks for identity at %s for a crawler that names no media type',
      async (path) => {
        // The client the rewrite exists for. `facebookexternalhit`,
        // `Twitterbot`, `Slackbot`, `LinkedInBot`, `Discordbot` and the
        // iMessage fetcher all ask with `*/*` or with no `Accept` at all, so a
        // rule keyed on an explicit HTML `Accept` would negotiate identity for
        // browsers and leave every link preview reading compressed bytes.
        const { deps, requests, rewrites } = harness({
          seed: vacaySeed,
          originFor: () => htmlOrigin(),
        });
        await handleRequest(
          get(`https://bodega-bay.fiveacross.app${path}`, { headers: CRAWLER }),
          CONFIG,
          deps,
        );
        expect(requests.at(-1)!.headers.get('accept-encoding'), path).toBe('identity');
        expect(rewrites, path).toHaveLength(1);
        expect(contentFor(rewrites[0]!.edits, 'meta[property="og:url"]')).toBe(
          'https://bodega-bay.fiveacross.app/',
        );
        expect(contentFor(rewrites[0]!.edits, 'meta[name="theme-color"]')).toBe(
          webManifestForEdition('vacay').theme_color,
        );
      },
    );

    it('takes that crawler’s validators off too, against an origin that would answer 304', async () => {
      // One predicate decides both, and this is why it has to. A crawler that
      // caches the document revalidates with `if-none-match`; the origin's
      // baked `index.html` really is unchanged, so it answers `304` truthfully
      // — and `isHeadRewritable` refuses a bodyless response, so the rewrite
      // never runs and the crawler keeps the Edition metadata it already had.
      // The stub below answers `304` to any forwarded validator, so this case
      // fails outright if either header travels.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: (request) =>
          request.headers.get('if-none-match') === '"origin-index"' ||
          request.headers.get('if-modified-since') !== null
            ? new Response(null, { status: 304, headers: { etag: '"origin-index"' } })
            : htmlOrigin({ headers: { etag: '"origin-index"' } }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', {
          headers: {
            ...CRAWLER,
            'if-none-match': '"origin-index"',
            'if-modified-since': 'Wed, 01 Jul 2026 00:00:00 GMT',
          },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('if-none-match')).toBeNull();
      expect(requests.at(-1)!.headers.get('if-modified-since')).toBeNull();
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('identity');
      expect(response.status).toBe(200);
      expect(rewrites).toHaveLength(1);
      expect(contentFor(rewrites[0]!.edits, 'meta[property="og:site_name"]')).toBe(
        brandFor('vacay').documentTitle,
      );
      // And nothing for it to revalidate with next time.
      expect(response.headers.get('etag')).toBeNull();
    });

    it('still lets a conditional asset request be answered 304 under the same wildcard Accept', async () => {
      // The other half of the rule, and the reason the path test rather than
      // the `Accept` test is what protects an asset: the crawler headers are
      // identical, only the extension differs.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => new Response(null, { status: 304, headers: { etag: '"asset"' } }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/assets/app.js', {
          headers: { ...CRAWLER, 'if-none-match': '"asset"' },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('if-none-match')).toBe('"asset"');
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, deflate, br');
      expect(response.status).toBe(304);
      expect(rewrites).toHaveLength(0);
    });

    it('leaves a request that NAMES html and refuses it exactly as it arrived', async () => {
      // `application/json, text/html;q=0` names `text/html` and rejects it in
      // the same header. A parser that dropped the parameters read that as a
      // document request and took this client's validators, its Range and its
      // compression away, turning the `304` it was entitled to into a full
      // uncompressed `200`.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: (request) =>
          request.headers.get('if-none-match') === '"origin-index"'
            ? new Response(null, { status: 304, headers: { etag: '"origin-index"' } })
            : htmlOrigin(),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/board', {
          headers: {
            accept: 'application/json, text/html;q=0',
            'accept-encoding': 'gzip, br',
            'if-none-match': '"origin-index"',
            range: 'bytes=0-99',
          },
        }),
        CONFIG,
        deps,
      );

      expect(requests.at(-1)!.headers.get('if-none-match')).toBe('"origin-index"');
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, br');
      expect(requests.at(-1)!.headers.get('range')).toBe('bytes=0-99');
      expect(response.status).toBe(304);
      expect(response.headers.get('etag')).toBe('"origin-index"');
      expect(rewrites).toHaveLength(0);
    });

    it('still takes a grudging but positive HTML quality as a document request', async () => {
      // The other side of the same rule: `q=0.1` is a preference, not a
      // refusal, and reading every q as a rejection would drop real
      // navigations out of the candidate set.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => htmlOrigin(),
      });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/board', {
          headers: {
            accept: 'application/json, text/html;q=0.1',
            'accept-encoding': 'gzip, br',
            'if-none-match': '"origin-index"',
          },
        }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('if-none-match')).toBeNull();
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('identity');
      expect(rewrites).toHaveLength(1);
    });

    it('leaves a document path asked for as JSON with both its validators', async () => {
      // A client that named a media type, and named one that is not HTML. Its
      // path is never second-guessed, on either half of the rule.
      const { deps, requests } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/board', {
          headers: {
            accept: 'application/json',
            'accept-encoding': 'gzip, br',
            'if-none-match': '"origin-index"',
            'if-modified-since': 'Wed, 01 Jul 2026 00:00:00 GMT',
          },
        }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('if-none-match')).toBe('"origin-index"');
      expect(requests.at(-1)!.headers.get('if-modified-since')).toBe(
        'Wed, 01 Jul 2026 00:00:00 GMT',
      );
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, br');
    });

    it('leaves a document path asked for as JSON to negotiate its own encoding', async () => {
      // A client that named a media type, and named one that is not HTML. The
      // path shape is only ever consulted for a client that stated no
      // preference, so this one is never second-guessed.
      const { deps, requests } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/board', {
          headers: { accept: 'application/json', 'accept-encoding': 'gzip, br' },
        }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, br');
    });

    it('leaves an asset request’s accept-encoding exactly as it arrived', async () => {
      // An asset is relayed rather than parsed, so making the bundle travel
      // uncompressed would be a bandwidth bill with no defect behind it.
      const { deps, requests, rewrites } = harness({
        seed: vacaySeed,
        originFor: () => new Response('export const x = 1;', { headers: { 'content-type': 'application/javascript' } }),
      });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/assets/app.js', {
          headers: { accept: '*/*', 'accept-encoding': 'gzip, br' },
        }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, br');
      expect(rewrites).toHaveLength(0);
    });

    it.each(['/assets/app.js', '/pwa-192.png', '/assets/inter.woff2', '/assets/app.css.map'])(
      'leaves %s alone even with the crawler’s own wildcard Accept',
      async (path) => {
        // The file extension is what separates an asset from a document when
        // the client states no preference, which is the shape a browser uses
        // to fetch a script. Without it the whole bundle would travel
        // uncompressed on the origin hop. (`/manifest.webmanifest` is absent
        // because the router answers it itself and never proxies it;
        // `htmlHead.test.ts` covers that extension on the pure predicate.)
        const { deps, requests } = harness({
          seed: vacaySeed,
          originFor: () =>
            new Response('x', { headers: { 'content-type': 'application/javascript' } }),
        });
        await handleRequest(
          get(`https://bodega-bay.fiveacross.app${path}`, { headers: CRAWLER }),
          CONFIG,
          deps,
        );
        expect(requests.at(-1)!.headers.get('accept-encoding'), path).toBe('gzip, deflate, br');
      },
    );

    it('leaves the /__/auth/* exemption’s accept-encoding alone too', async () => {
      const { deps, requests } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
      await handleRequest(
        get('https://bodega-bay.fiveacross.app/__/auth/handler', { headers: NAVIGATION }),
        CONFIG,
        deps,
      );
      expect(requests.at(-1)!.headers.get('accept-encoding')).toBe('gzip, deflate, br');
    });

    it('answers with no content-encoding and no Vary naming one', async () => {
      const { deps, rewrites } = harness({
        seed: vacaySeed,
        originFor: () =>
          htmlOrigin({ headers: { 'content-encoding': 'identity', vary: 'Accept-Encoding' } }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', { headers: NAVIGATION }),
        CONFIG,
        deps,
      );
      expect(rewrites).toHaveLength(1);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('vary')).toBeNull();
    });

    it('relays an encoded document whole rather than parsing it', async () => {
      // The residue of the request-side predicate: a client that does not say
      // it accepts HTML keeps the runtime's negotiated encoding, so the origin
      // may still answer compressed. That answer is relayed with its framing
      // intact — the bundle's baked Edition, correctly encoded, which is what
      // such a client received before this rewrite existed.
      const { deps, rewrites } = harness({
        seed: vacaySeed,
        originFor: () =>
          htmlOrigin({ headers: { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } }),
      });
      const response = await handleRequest(
        get('https://bodega-bay.fiveacross.app/', { headers: { accept: '*/*' } }),
        CONFIG,
        deps,
      );
      expect(rewrites).toHaveLength(0);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
    });
  });

  it.each([
    ['a 404 from the origin', () => htmlOrigin({ status: 404 })],
    ['a 500 from the origin', () => htmlOrigin({ status: 500 })],
    ['an origin redirect', () => htmlOrigin({ status: 302, headers: { location: '/elsewhere' } })],
    [
      'a 206 partial representation',
      () =>
        htmlOrigin({
          status: 206,
          headers: { 'content-range': 'bytes 0-71/4096' },
        }),
    ],
    ['a 203 from a transforming proxy', () => htmlOrigin({ status: 203 })],
    [
      'a non-HTML asset',
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ],
    [
      'a JavaScript bundle whose type merely starts alike',
      () =>
        new Response('export{}', {
          status: 200,
          headers: { 'content-type': 'text/htmlx' },
        }),
    ],
    ['a response with no content-type at all', () => new Response('hi', { status: 200 })],
  ])('relays %s untouched rather than rewriting it', async (_label, originFor) => {
    // "Rewriting a streamed response cannot turn an origin failure into a
    // Worker runtime error" is an acceptance criterion, and the way it is kept
    // is that a response the rewrite cannot safely touch is never handed to
    // the transform at all.
    const { deps, rewrites } = harness({ seed: vacaySeed, originFor });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(rewrites).toHaveLength(0);
    expect(response.headers.get('x-event-router')).toBe('test-1');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it('relays a 206 byte-for-byte, content-range and content-length intact', async () => {
    // A `Range` answer is a WINDOW described by byte offsets. Substituting a
    // string of a different length inside it while relaying the offsets that
    // frame it is how a client assembling or resuming the document ends up
    // reassembling a corrupted one — so the partial representation is relayed
    // whole, including the `content-length` a rewritten 200 loses.
    const window = '<!doctype html><html><head><title>app</title>';
    const { deps, rewrites } = harness({
      seed: vacaySeed,
      originFor: () =>
        new Response(window, {
          status: 206,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-range': `bytes 0-${window.length - 1}/4096`,
            'content-length': String(window.length),
          },
        }),
    });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/', { headers: { range: 'bytes=0-43' } }),
      CONFIG,
      deps,
    );

    expect(rewrites).toHaveLength(0);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-${window.length - 1}/4096`);
    expect(response.headers.get('content-length')).toBe(String(window.length));
    expect(await response.text()).toBe(window);
  });

  it('relays a bodyless HEAD response untouched', async () => {
    const { deps, rewrites } = harness({
      seed: vacaySeed,
      originFor: () =>
        new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/', { method: 'HEAD' }),
      CONFIG,
      deps,
    );
    expect(rewrites).toHaveLength(0);
    expect(response.status).toBe(200);
  });

  it('still answers a rejected origin fetch with the generic 502', async () => {
    const { deps, rewrites } = harness({
      seed: vacaySeed,
      originError: new Error('tls handshake failed'),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Origin temporarily unavailable.');
    expect(rewrites).toHaveLength(0);
  });

  it('never touches the /__/auth/* passthrough, which resolves no Edition', async () => {
    // The exemption exists so a registry blip cannot break sign-in
    // mid-transaction. It resolves no record, so there is no Edition to brand
    // with — and the OAuth redirect leg is the last response to put a body
    // transform in front of.
    const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
    const response = await handleRequest(
      get('https://bodega-bay.fiveacross.app/__/auth/handler?state=abc'),
      CONFIG,
      deps,
    );
    expect(response.status).toBe(200);
    expect(rewrites).toHaveLength(0);
  });

  it.each([
    ['admin.fiveacross.app', 'reserved-label'],
    ['unknown-event.fiveacross.app', 'unknown-host'],
    ['bodega-bay.example.com', 'out-of-namespace'],
    ['ab.fiveacross.app', 'invalid-slug:too-short'],
  ] as const)('never runs for %s, which fails closed as %s', async (host, reason) => {
    // Same ordering claim the manifest route makes: the rewrite sits after the
    // namespace guard and after resolution, so an address that does not serve
    // an app does not get an app's identity written into anything.
    const { deps, requests, rewrites } = harness({
      seed: { 'admin.fiveacross.app': VACAY },
      originFor: () => htmlOrigin(),
    });
    const response = await handleRequest(get(`https://${host}/`), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
    expect(requests).toHaveLength(0);
    expect(rewrites).toHaveLength(0);
  });

  it('never runs for an inactive Event', async () => {
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
    const { deps, rewrites } = harness({
      seed: { 'bodega-bay.fiveacross.app': disabled },
      originFor: () => htmlOrigin(),
    });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe('inactive');
    expect(rewrites).toHaveLength(0);
  });

  it('never runs for an unconfigured router', async () => {
    const { deps, rewrites } = harness({ seed: vacaySeed, originFor: () => htmlOrigin() });
    const response = await handleRequest(get('https://bodega-bay.fiveacross.app/'), CONFIG, {
      ...deps,
      registry: null,
    });
    expect(response.status).toBe(404);
    expect(rewrites).toHaveLength(0);
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
    // it. `RouterDeps` has exactly three members and only ONE of them can
    // answer a question — `htmlRewriter` transforms a body the origin already
    // sent — so there is nowhere else for a lookup to come from, which is what
    // "no Firestore, KV, negative, stale or other fallback" means in code
    // rather than in prose.
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

    expect(Object.keys(deps).sort()).toEqual(['fetch', 'htmlRewriter', 'registry']);
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
