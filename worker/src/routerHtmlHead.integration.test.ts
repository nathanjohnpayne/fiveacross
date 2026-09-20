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
const route = (slug, edition) => ({
  kind: 'committed',
  schemaVersion: 1,
  revision: '42',
  desired: { kind: 'route', eventId: slug + '-event', status: 'active', slug, edition, pathNamespace: null },
});
const TABLE = {
  '${VACAY_CANONICAL}': route('bodega-bay', 'vacay'),
  '${VACAY_ALTERNATE}': route('bodega-bay', 'vacay'),
  '${GCB_HOST}': route('med-2026', 'gcb'),
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
 */
const originWorker = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fail = /^\\/fail\\/(\\d+)$/.exec(url.pathname);
    if (fail) {
      const body = '<!doctype html><meta property="og:title" content="Gay Cruise Bingo"><p>nope';
      return new Response(body, { status: Number(fail[1]), headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/asset.js') {
      return new Response('export const og = "Gay Cruise Bingo";', {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      });
    }
    if (url.pathname === '/no-type') {
      return new Response('<!doctype html><meta property="og:title" content="Gay Cruise Bingo">', { status: 200 });
    }
    const body = env.INDEX_HTML;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(new TextEncoder().encode(body).byteLength),
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

async function request(instance: Miniflare, host: string, path = '/'): Promise<Response> {
  return instance.dispatchFetch(`https://${host}${path}`) as unknown as Promise<Response>;
}

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

  it('leaves the two runtime-repaired tags to the app', async () => {
    // `applyEditionDocumentIdentity` owns `<title>` and the iOS label after
    // resolution. The edge deliberately does not add a second writer for them,
    // so the proxied document still carries the build's copy.
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
    expect(response.headers.get('x-event-router')).toBe('head-1');
    expect(response.headers.get('x-event-router-revision')).toBe('42');
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
