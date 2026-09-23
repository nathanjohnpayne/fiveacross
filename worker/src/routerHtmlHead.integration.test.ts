// @vitest-environment node
//
// The per-hostname `<head>` rewrite on the PLATFORM (#1118, epic #529;
// specs/event-router.md § Contract).
//
// `router.test.ts` proves the decision — which responses reach the rewrite and
// with which edits — against an injected seam, which is the right shape for a
// decision and the wrong shape for the claim this file has to make. The
// rewrite is a STREAMING transform performed by `HTMLRewriter`, a workerd
// global the repo's ordinary Vitest program does not have, and the thing worth
// proving is not that the router called a function: it is that the bytes a
// crawler receives on a given hostname carry that hostname's Edition. A stub
// cannot say that, because the transform is exactly what is in question.
//
// So the deployed router bundle runs under Miniflare against the REAL
// `index.html` — branded for the default Edition the way a build would, since
// that is precisely the document a hostname-resolved bundle serves from the
// origin — and every outbound fetch is answered by a second Worker. The
// registry is a stub here on purpose: `registry/routerRegistry.integration.
// test.ts` owns the real binding's capability contract, and standing the
// Durable Object up again would prove that a second time instead of proving
// this.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Log, LogLevel, Miniflare } from 'miniflare';
// `edition-brands` / `html-head-identity`, NOT `editions`: this program has no
// DOM lib and no `vite/client`, which is the split both modules exist for.
import { brandFor } from '../../src/edition-brands';
import { brandHtmlIdentity } from '../../src/html-head-identity';
import { webManifestForEdition } from '../../src/web-manifest';

const ORIGIN_HOST = 'fiveacross.web.app';
const COMPATIBILITY_DATE = '2026-07-30';
const VACAY_CANONICAL = 'bodega-bay.fiveacross.app';
const VACAY_ALTERNATE = 'bodega-bay.vacaybingo.com';
const GCB_HOST = 'med-2026.fiveacross.app';

let routerBundle = '';
const instances: Miniflare[] = [];

/**
 * What the origin actually serves: the shipped `index.html`, with the default
 * Edition's copy baked in.
 *
 * Reading the real file rather than a fixture is the whole point — the rewrite
 * targets tags by selector, and a selector that has drifted out of the markup
 * rewrites nothing while reporting success.
 */
const boundIndexHtml = () =>
  brandHtmlIdentity(readFileSync(resolve(process.cwd(), 'index.html'), 'utf8'), brandFor('gcb'));

/** A lookup-only entrypoint with a canned table, standing in for the registry.
 *  The router binds to this class by name exactly as it binds to the real one. */
const registryStub = `
import { WorkerEntrypoint } from 'cloudflare:workers';
// Every committed envelope names the host it was projected for (#1133), so a
// table entry is built FOR its own key rather than shared between two — the
// same binding router.test.ts's \`servingAt\` helper applies.
const route = (host, slug, edition) => ({
  kind: 'committed',
  schemaVersion: 1,
  revision: '42',
  host,
  desired: { kind: 'route', eventId: slug + '-event', status: 'active', slug, edition, pathNamespace: null },
});
const TABLE = {
  '${VACAY_CANONICAL}': route('${VACAY_CANONICAL}', 'bodega-bay', 'vacay'),
  '${VACAY_ALTERNATE}': route('${VACAY_ALTERNATE}', 'bodega-bay', 'vacay'),
  '${GCB_HOST}': route('${GCB_HOST}', 'med-2026', 'gcb'),
};
export class RegistryLookupEntrypoint extends WorkerEntrypoint {
  async lookup(host) {
    return TABLE[host] ?? { kind: 'unknown-host' };
  }
}
export default { fetch: () => new Response('control plane', { status: 404 }) };
`;

/**
 * Everything the router fetches. `INDEX_HTML` carries the real document;
 * `/fail/<status>`, `/asset.js` and `/no-type` let one instance exercise every
 * pass-through arm without a second Miniflare stack.
 *
 * `content-length` is set deliberately, and it is the interesting header: it
 * describes the bytes BEFORE the rewrite, so a router that relayed it would
 * truncate the document the moment a substituted string changed its length.
 *
 * It also behaves like the real origin in the three ways #1118's review turned
 * on: it answers a `Range` with a `206` framed by a `content-range`, it
 * answers a matching `if-none-match` with a `304`, and it HONOURS
 * `accept-encoding` — a document requested with `gzip` comes back gzipped,
 * under `content-encoding: gzip` and `vary: accept-encoding`. All three are
 * the origin telling the truth about its own baked document, which is exactly
 * why none of them may reach a client whose hostname resolves to a different
 * Edition. Every response echoes the `accept-encoding` it was asked with, so a
 * test can read what the router negotiated rather than infer it.
 */
const INDEX_ETAG = '"origin-index"';
const ASSET_ETAG = '"origin-asset"';
const LAST_MODIFIED = 'Wed, 01 Jul 2026 00:00:00 GMT';
const PARTIAL_BYTES = 200;

const originWorker = `
const INDEX_ETAG = '${INDEX_ETAG}';
const ASSET_ETAG = '${ASSET_ETAG}';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fail = /^\\/fail\\/(\\d+)$/.exec(url.pathname);
    if (fail) {
      const body = '<!doctype html><meta property="og:title" content="Gay Cruise Bingo"><p>nope';
      return new Response(body, { status: Number(fail[1]), headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const askedWith = request.headers.get('accept-encoding') ?? '';
    if (url.pathname === '/asset.js') {
      if (request.headers.get('if-none-match') === ASSET_ETAG) {
        return new Response(null, { status: 304, headers: { etag: ASSET_ETAG } });
      }
      const asset = new TextEncoder().encode('export const og = "Gay Cruise Bingo";');
      if (request.headers.get('range')) {
        const window = asset.slice(0, ${PARTIAL_BYTES});
        return new Response(window, {
          status: 206,
          headers: {
            'content-type': 'application/javascript',
            'content-range': 'bytes 0-' + (window.byteLength - 1) + '/' + asset.byteLength,
            'content-length': String(window.byteLength),
            etag: ASSET_ETAG,
            'x-origin-accept-encoding': askedWith,
          },
        });
      }
      return new Response(asset, {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
          etag: ASSET_ETAG,
          'x-origin-accept-encoding': askedWith,
        },
      });
    }
    if (url.pathname === '/no-type') {
      return new Response('<!doctype html><meta property="og:title" content="Gay Cruise Bingo">', { status: 200 });
    }
    const body = env.INDEX_HTML;
    const bytes = new TextEncoder().encode(body);
    if (request.headers.get('range')) {
      // Reachable only if the router forwarded a range for the document,
      // which it must not: the rewritten representation is a different length
      // from this one, so a client splicing the two corrupts the result. The
      // document range case below asserts a full 200 precisely because this
      // arm stays unreached. (No backticks in here: this whole worker is a
      // template literal.)
      const partial = bytes.slice(0, ${PARTIAL_BYTES});
      return new Response(partial, {
        status: 206,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-range': 'bytes 0-' + (partial.byteLength - 1) + '/' + bytes.byteLength,
          'content-length': String(partial.byteLength),
          etag: INDEX_ETAG,
        },
      });
    }
    if (request.headers.get('if-none-match') === INDEX_ETAG) {
      return new Response(null, { status: 304, headers: { etag: INDEX_ETAG } });
    }
    if (askedWith.toLowerCase().includes('gzip')) {
      return new Response(
        new Response(bytes).body.pipeThrough(new CompressionStream('gzip')),
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-encoding': 'gzip',
            vary: 'Accept-Encoding',
            etag: INDEX_ETAG,
            'last-modified': '${LAST_MODIFIED}',
            'x-origin-accept-encoding': askedWith,
            'x-origin-forwarded-host': request.headers.get('x-forwarded-host') ?? '',
          },
        },
      );
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(bytes.byteLength),
        etag: INDEX_ETAG,
        'last-modified': '${LAST_MODIFIED}',
        'x-origin-accept-encoding': askedWith,
        'x-origin-forwarded-host': request.headers.get('x-forwarded-host') ?? '',
      },
    });
  },
};
`;

beforeAll(async () => {
  const router = await build({
    entryPoints: ['worker/src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['cloudflare:workers'],
  });
  routerBundle = router.outputFiles[0]!.text;
}, 60_000);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function miniflare(): Miniflare {
  const instance = new Miniflare({
    workers: [
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'router.mjs', contents: routerBundle }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: { ORIGIN_HOST, ROUTER_VERSION: 'head-1' },
        serviceBindings: { REGISTRY: { name: 'registry', entrypoint: 'RegistryLookupEntrypoint' } },
        outboundService: 'origin',
      },
      {
        name: 'registry',
        modules: [{ type: 'ESModule', path: 'registry.mjs', contents: registryStub }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
      },
      {
        name: 'origin',
        modules: [{ type: 'ESModule', path: 'origin.mjs', contents: originWorker }],
        modulesRoot: '/',
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: { INDEX_HTML: boundIndexHtml() },
      },
    ],
    log: new Log(LogLevel.NONE),
  });
  instances.push(instance);
  return instance;
}

/**
 * A request to the router, defaulting to a browser document NAVIGATION.
 *
 * The default carries headers because the origin stub honours
 * `accept-encoding` the way the real one does, so what the client asks for
 * decides whether the transform sees markup or compressed bytes. Spelling the
 * navigation out keeps each case saying which client it speaks for: a browser
 * here, a link-preview crawler and an asset fetch in the cases below.
 */
async function request(
  instance: Miniflare,
  host: string,
  path = '/',
  init: RequestInit = BROWSER_NAVIGATION,
): Promise<Response> {
  return instance.dispatchFetch(
    `https://${host}${path}`,
    init as Parameters<Miniflare['dispatchFetch']>[1],
  ) as unknown as Promise<Response>;
}

/** A cached copy of the origin's baked `index.html` to revalidate against. */
const CONDITIONAL_VALIDATORS = {
  'if-none-match': INDEX_ETAG,
  'if-modified-since': LAST_MODIFIED,
};

/** What a browser sends on a document navigation, with a cached copy of the
 *  origin's baked `index.html` to revalidate. */
const CONDITIONAL_NAVIGATION: RequestInit = {
  headers: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
    ...CONDITIONAL_VALIDATORS,
  },
};

/** The same navigation with no cached copy, and the compression a browser
 *  always offers. The origin honours it, so this is the request that decides
 *  whether the transform sees markup or gzip. */
const BROWSER_NAVIGATION: RequestInit = {
  headers: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
    'accept-encoding': 'gzip, br',
  },
};

/** What a link-preview crawler sends: no content-negotiation opinion at all.
 *  `facebookexternalhit`, `Twitterbot`, `Slackbot`, `LinkedInBot`,
 *  `Discordbot` and the iMessage fetcher all ask for the document this way,
 *  which makes this the client the whole rewrite exists for. */
const CRAWLER_FETCH: RequestInit = {
  headers: {
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  },
};

/** The `content` of one meta tag, read out of the served markup the way a
 *  crawler's parser would rather than by string inclusion. */
function metaContent(html: string, attribute: string, value: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*\\b${attribute}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`,
    'i',
  );
  const tag = pattern.exec(html)?.[0];
  if (tag === undefined) return null;
  return /\bcontent="([^"]*)"/.exec(tag)?.[1] ?? null;
}

describe('the head rewrite, on the runtime rather than on a seam', () => {
  it('serves each hostname the share block of the Edition IT resolved to', async () => {
    const instance = miniflare();
    const vacay = brandFor('vacay');
    const html = await (await request(instance, VACAY_ALTERNATE)).text();

    // The origin served the gcb-branded bundle; what reached the crawler is
    // Vacay, because that is what `hostnames/{host}` said for THIS hostname.
    expect(metaContent(html, 'property', 'og:site_name')).toBe(vacay.documentTitle);
    expect(metaContent(html, 'property', 'og:title')).toBe(vacay.documentTitle);
    expect(metaContent(html, 'name', 'description')).toBe(vacay.metaDescription);
    expect(metaContent(html, 'property', 'og:image')).toBe(vacay.ogImage);
    expect(metaContent(html, 'name', 'twitter:image')).toBe(vacay.ogImage);
    // The em dash is the encoding canary: a transform that mishandled UTF-8 at
    // a chunk boundary would corrupt exactly this string.
    expect(metaContent(html, 'property', 'og:image:alt')).toBe(vacay.ogImageAlt);
    expect(html).toContain('—');
    expect(html).not.toContain(brandFor('gcb').ogImage);
  });

  it('emits each hostname’s own origin as og:url', async () => {
    const instance = miniflare();
    for (const host of [VACAY_CANONICAL, VACAY_ALTERNATE]) {
      const html = await (await request(instance, host, '/board?day=3')).text();
      expect(metaContent(html, 'property', 'og:url'), host).toBe(`https://${host}/`);
    }
    // Both hosts serve the same Event; neither inherits the other's canonical
    // URL, and neither keeps the single value the brand row could carry.
    const alternate = await (await request(instance, VACAY_ALTERNATE)).text();
    expect(metaContent(alternate, 'property', 'og:url')).not.toBe(brandFor('vacay').ogUrl);
  });

  it('keeps theme-color byte-identical to the manifest the same host serves', async () => {
    const instance = miniflare();
    for (const [host, edition] of [
      [VACAY_ALTERNATE, 'vacay'],
      [GCB_HOST, 'gcb'],
    ] as const) {
      const html = await (await request(instance, host)).text();
      const manifest = (await (
        await request(instance, host, '/manifest.webmanifest')
      ).json()) as { theme_color: string };
      expect(metaContent(html, 'name', 'theme-color'), host).toBe(manifest.theme_color);
      expect(manifest.theme_color, host).toBe(webManifestForEdition(edition).theme_color);
    }
  });

  it('leaves the two edge-exempt tags to the app', async () => {
    // `applyEditionDocumentIdentity` owns `<title>` and the iOS label after
    // resolution. The edge deliberately does not add a second writer for them,
    // so the proxied document still carries the build's copy. (It does write
    // `theme-color`, which the DOM repair also corrects — for the installed
    // shell this response never reaches.)
    const html = await (await request(miniflare(), VACAY_ALTERNATE)).text();
    expect(html).toContain(`<title>${brandFor('gcb').documentTitle}</title>`);
    expect(metaContent(html, 'name', 'apple-mobile-web-app-title')).toBe(brandFor('gcb').appName);
  });

  it('returns a complete, unbuffered document rather than one framed by a stale content-length', async () => {
    const instance = miniflare();
    const response = await request(instance, VACAY_ALTERNATE);
    const html = await response.text();
    // The substituted strings are shorter than the gcb ones the origin sent,
    // so a relayed `content-length` would have truncated the tail.
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<script type="module"');
    expect(response.headers.get('content-length')).toBeNull();
    // The origin's validators go the same way and for the same reason: they
    // describe those pre-rewrite bytes, identically for every hostname.
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
    expect(response.headers.get('x-event-router')).toBe('head-1');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
  });

  it('answers a conditional navigation with a rewritten 200 rather than the origin’s 304', async () => {
    // The origin's `index.html` really is unchanged, so its `304` is true —
    // and wrong for this host, because the registry resolves it to an Edition
    // the cached copy was not branded for. The router must therefore not carry
    // the validators to it.
    const instance = miniflare();
    const response = await request(instance, VACAY_ALTERNATE, '/', CONDITIONAL_NAVIGATION);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(metaContent(html, 'property', 'og:site_name')).toBe(brandFor('vacay').documentTitle);
    // Nothing for the client to revalidate WITH next time, which is what makes
    // the fix converge instead of recurring one cache generation later.
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
  });

  it('answers a conditional CRAWLER fetch the same way, although it names no media type', async () => {
    // The half a narrow validator rule missed. A crawler that caches the
    // document revalidates with `if-none-match`; the origin's baked
    // `index.html` is genuinely unchanged, so it answers `304` truthfully, and
    // a bodyless response is refused by the rewrite — leaving the crawler on
    // the Edition metadata it already had. One predicate now decides the
    // validators and the encoding together, so this fetch reaches the origin
    // carrying neither validator and asking for `identity`.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/', {
      headers: { ...(CRAWLER_FETCH.headers as Record<string, string>), ...CONDITIONAL_VALIDATORS },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-origin-accept-encoding')).toBe('identity');
    const html = await response.text();
    expect(metaContent(html, 'property', 'og:site_name')).toBe(brandFor('vacay').documentTitle);
    expect(metaContent(html, 'name', 'theme-color')).toBe(
      webManifestForEdition('vacay').theme_color,
    );
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
  });

  it('still lets a conditional asset request be answered 304', async () => {
    // The other half: an asset is never rewritten, so its revalidation is
    // worth exactly what it was worth before, and its validators travel.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/asset.js', {
      headers: { accept: '*/*', 'if-none-match': ASSET_ETAG },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(ASSET_ETAG);
  });

  it('brands a document the origin would have gzipped, because the subrequest asked for identity', async () => {
    // The defect this case exists for: a browser navigation carries
    // `accept-encoding: gzip, br`, and a router that forwards it unchanged
    // hands `HTMLRewriter` compressed bytes. The parser finds no `<meta>` in
    // them, changes nothing, reports success, and the crawler receives the
    // Edition the bundle was baked for. Only a real workerd can show that —
    // a seam records the call and says nothing about the bytes.
    const instance = miniflare();
    const response = await request(instance, VACAY_ALTERNATE, '/', BROWSER_NAVIGATION);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-origin-accept-encoding')).toBe('identity');
    const html = await response.text();
    expect(metaContent(html, 'property', 'og:url')).toBe(`https://${VACAY_ALTERNATE}/`);
    expect(metaContent(html, 'name', 'theme-color')).toBe(
      webManifestForEdition('vacay').theme_color,
    );
    expect(metaContent(html, 'property', 'og:site_name')).toBe(brandFor('vacay').documentTitle);
    // Nothing is left describing bytes the transform replaced: no
    // `content-encoding` for a body that is no longer encoded, and no
    // `vary: accept-encoding` for a response the edge no longer negotiates.
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
  });

  it('leaves an asset subrequest to negotiate its own encoding', async () => {
    // Identity is bought for the documents the rewrite can act on and for
    // nothing else. An asset is relayed, so making it travel uncompressed
    // would be a bandwidth bill with no defect behind it — and a wildcard
    // `Accept` on a path with a file extension is exactly the shape a browser
    // uses to fetch a script, which is why the path test and not the `Accept`
    // is what separates it from the crawler above.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/asset.js', CRAWLER_FETCH);
    expect(response.status).toBe(200);
    // Whatever the runtime negotiated on its own behalf — never the `identity`
    // the router buys for a document.
    const negotiated = response.headers.get('x-origin-accept-encoding') ?? '';
    expect(negotiated).not.toBe('identity');
    expect(negotiated.toLowerCase()).toContain('gzip');
  });

  it.each(['/', '/board', '/board/', '/index.html'])(
    'brands %s for a crawler that sends no Accept opinion at all',
    async (path) => {
      // The client this rewrite exists for. A crawler names no media type, so
      // the narrow validator predicate does not describe it; if the encoding
      // rule were narrow too, every link-preview fetch would be answered in
      // gzip, skip the transform in silence and file the link under the
      // Edition the bundle was built with. The path shape is what qualifies
      // it instead.
      const response = await request(miniflare(), VACAY_ALTERNATE, path, CRAWLER_FETCH);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-origin-accept-encoding'), path).toBe('identity');
      const html = await response.text();
      expect(metaContent(html, 'property', 'og:url'), path).toBe(`https://${VACAY_ALTERNATE}/`);
      expect(metaContent(html, 'name', 'theme-color'), path).toBe(
        webManifestForEdition('vacay').theme_color,
      );
      expect(metaContent(html, 'property', 'og:site_name'), path).toBe(
        brandFor('vacay').documentTitle,
      );
      expect(response.headers.get('content-encoding')).toBeNull();
    },
  );

  it('relays a document asked for as JSON rather than parsing its compressed bytes', async () => {
    // What is left outside the encoding rule, pinned rather than left to be
    // discovered: a client that named a media type, and named one that is not
    // HTML. It is not a crawler and not a browser navigation, so its
    // negotiated encoding travels and the origin may answer `gzip`. The
    // rewrite refuses an encoded body: what comes back is the origin's own
    // response, correctly framed and carrying the bundle's baked Edition,
    // rather than markup a parser silently failed to touch.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/', {
      headers: { accept: 'application/json' },
    });
    expect(response.status).toBe(200);
    // The relay arm, not the rewrite arm: both headers the rewrite drops are
    // still here, and the document names the Edition the bundle was built
    // with rather than the one this hostname resolves to.
    expect(response.headers.get('etag')).toBe(INDEX_ETAG);
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    // The origin's own compressed bytes, relayed. Read as gzip deliberately:
    // the claim is that the body is still the encoded representation the
    // origin produced, not markup a parser was handed and quietly failed on.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const html = Buffer.from(gunzipSync(bytes)).toString('utf8');
    expect(metaContent(html, 'property', 'og:site_name')).toBe(brandFor('gcb').documentTitle);
  });

  it('relays an ASSET 206 byte-for-byte with its content-range intact', async () => {
    // A `Range` answer is a window described by byte offsets. Rewriting inside
    // it while relaying the offsets that frame it is how a client assembling
    // or resuming a resource reassembles a corrupted one. An asset is where a
    // `206` can still arise, because its range travels to the origin.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/asset.js', {
      headers: { accept: '*/*', range: `bytes=0-${PARTIAL_BYTES - 1}` },
    });
    const origin = new TextEncoder().encode('export const og = "Gay Cruise Bingo";');
    const window = origin.slice(0, PARTIAL_BYTES);

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${window.byteLength - 1}/${origin.byteLength}`,
    );
    expect(response.headers.get('content-length')).toBe(String(window.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(window);
  });

  it.each([
    ['a crawler', { accept: '*/*' }],
    ['a browser', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }],
  ])('answers %s ranged document request with the whole rewritten document', async (_who, headers) => {
    // The range never reaches the origin, so there is no second, baked
    // representation of this URL for a client to splice into the rewritten
    // one. The stub would answer `206` from the index if it did, which is what
    // makes this assertion sharp.
    const response = await request(miniflare(), VACAY_ALTERNATE, '/', {
      headers: { ...headers, range: `bytes=0-${PARTIAL_BYTES - 1}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    const html = await response.text();
    expect(metaContent(html, 'property', 'og:site_name')).toBe(brandFor('vacay').documentTitle);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it.each([404, 500, 502])('relays a %i from the origin untouched', async (status) => {
    // The acceptance criterion in one assertion: a rewrite over a failing
    // origin response is not a rewrite and not a Worker runtime error — it is
    // a relay. The failing body still names the bundle's Edition, which is
    // what "untouched" means.
    const response = await request(miniflare(), VACAY_ALTERNATE, `/fail/${status}`);
    expect(response.status).toBe(status);
    expect(metaContent(await response.text(), 'property', 'og:title')).toBe('Gay Cruise Bingo');
  });

  it.each(['/asset.js', '/no-type'])('relays %s untouched, because it is not HTML', async (path) => {
    const response = await request(miniflare(), VACAY_ALTERNATE, path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Gay Cruise Bingo');
  });

  it.each([
    ['admin.fiveacross.app', 'reserved-label'],
    ['unknown-event.fiveacross.app', 'unknown-host'],
    ['ab.fiveacross.app', 'invalid-slug:too-short'],
  ])('fails closed at %s with %s, ahead of any rewrite', async (host, reason) => {
    const response = await request(miniflare(), host);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-event-router-reason')).toBe(reason);
    const body = await response.text();
    // The not-found state is brand-neutral: the router does not know which
    // Edition the address belongs to, so it writes none of one into anything.
    expect(body).not.toContain('og:site_name');
    expect(body).not.toContain(brandFor('vacay').documentTitle);
  });
});
