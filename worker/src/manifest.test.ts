// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isWebManifestRequest, webManifestResponse, WEB_MANIFEST_PATH } from './manifest';
import { EDITION_IDS } from '../../src/edition-registry';
// `edition-brands`, NOT `editions`: this program has no DOM lib and no
// `vite/client`, so importing the app-facing module would not compile —
// `import.meta.env` and `document` are exactly what the #546 extraction split
// away from the table.
import { brandFor } from '../../src/edition-brands';
import { serializeWebManifest, webManifestForEdition } from '../../src/web-manifest';

// The response shape only. `src/web-manifest.test.ts` owns the document itself
// (its members, their order, and the unknown-Edition fallback), and
// `router.test.ts` owns WHERE in the pipeline this sits — that the guard and
// the resolution still run first.

describe('which requests are the manifest request', () => {
  it.each(['GET', 'HEAD'])('answers %s', (method) => {
    expect(isWebManifestRequest(method, WEB_MANIFEST_PATH)).toBe(true);
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])(
    'leaves %s to the proxy, rather than newly refusing a method the router used to relay',
    (method) => {
      expect(isWebManifestRequest(method, WEB_MANIFEST_PATH)).toBe(false);
    },
  );

  it.each([
    '/',
    '/manifest.webmanifest/',
    '/manifest.webmanifest.bak',
    '/x/manifest.webmanifest',
    '/MANIFEST.WEBMANIFEST',
  ])('does not claim %s', (pathname) => {
    expect(isWebManifestRequest('GET', pathname)).toBe(false);
  });
});

describe('the manifest response', () => {
  it.each([EDITION_IDS.GAY_CRUISE_BINGO, EDITION_IDS.VACAY_BINGO, EDITION_IDS.FIVE_ACROSS])(
    'serves the installed identity of %s',
    async (edition) => {
      const response = webManifestResponse(edition, 'test-1', 'GET');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        name: brandFor(edition).appName,
        short_name: brandFor(edition).appShortName,
      });
    },
  );

  it('serves the same bytes the build emits for the same Edition', async () => {
    // The one-builder-two-consumers property, asserted rather than asserted
    // about: an edge manifest that merely LOOKS right is how an installed shell
    // and a fresh install end up disagreeing.
    const response = webManifestResponse(EDITION_IDS.VACAY_BINGO, 'test-1', 'GET');
    expect(await response.text()).toBe(
      serializeWebManifest(webManifestForEdition(EDITION_IDS.VACAY_BINGO)),
    );
  });

  it.each([null, '', 'not-an-edition'])(
    'falls back to the default Edition for %s rather than serving an unbranded manifest',
    async (edition) => {
      const response = webManifestResponse(edition, 'test-1', 'GET');
      expect(await response.text()).toBe(serializeWebManifest(webManifestForEdition(edition)));
      expect(await webManifestResponse(edition, 'test-1', 'GET').json()).toMatchObject({
        name: brandFor(EDITION_IDS.GAY_CRUISE_BINGO).appName,
      });
    },
  );

  it('declares the registered media type and revalidates rather than caching blind', () => {
    const response = webManifestResponse(EDITION_IDS.VACAY_BINGO, 'test-1', 'GET');
    expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    // `no-cache`, matching what Firebase Hosting already serves the built file
    // with: this document decides an installed app's NAME, so a stale copy is a
    // defect that outlives the deploy that caused it. Not `no-store` —
    // revalidation is cheap and a 304 keeps the install path fast.
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('carries the version stamp, so an operator can tell the edge answered', () => {
    expect(webManifestResponse(EDITION_IDS.VACAY_BINGO, 'v9', 'GET').headers.get('x-event-router')).toBe('v9');
  });

  it('answers HEAD with the same headers and no body', async () => {
    const head = webManifestResponse(EDITION_IDS.VACAY_BINGO, 'test-1', 'HEAD');
    const get = webManifestResponse(EDITION_IDS.VACAY_BINGO, 'test-1', 'GET');
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(await head.text()).toBe('');
    for (const header of ['content-type', 'cache-control', 'x-event-router']) {
      expect(head.headers.get(header)).toBe(get.headers.get(header));
    }
  });

  it('never redirects — the router constructs no 3xx anywhere', () => {
    for (const method of ['GET', 'HEAD']) {
      const response = webManifestResponse(EDITION_IDS.VACAY_BINGO, 'test-1', method);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});
