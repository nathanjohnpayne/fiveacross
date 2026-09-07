import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { precacheEntries, precachedUrls } from './sw-precache-audit';
import { WEB_MANIFEST_FILENAME } from './web-manifest';

// Two halves, and both are load-bearing.
//
// The first proves the READER works, on hand-written sources whose expected
// answer is obvious. Without it the second half is worthless: a reader that
// stopped matching returns an empty list, and "the manifest is not in an empty
// list" passes while the defect ships.
//
// The second reads the real emitted worker. It is the only place the truth is
// visible — `vite.config.ts` never mentions `manifest.webmanifest`, the glob
// pattern excludes `.webmanifest` entirely, and the entry arrived from a plugin
// default downstream of both. And `grep` CANNOT read it: `dist/sw.js` is
// minified past the point where grep classifies it as binary, so a search
// reports nothing and exits 1. That false all-clear is how the entry went
// unnoticed for three tickets (#546, 2026-08-19).

// The path goes through a VARIABLE, which is load-bearing rather than stylistic:
// Vite rewrites `new URL('<literal>', import.meta.url)` into an asset-URL
// lookup, so a literal here resolves to `http://localhost:3000/...` and
// `fileURLToPath` rejects it. Same idiom as `recon-share-og.test.ts`.
const repoFile = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url).href);

const swPath = repoFile('../dist/sw.js');
const builtWorker = existsSync(swPath) ? readFileSync(swPath, 'utf8') : null;

describe('reading a precache list out of an emitted worker', () => {
  it('reads entries whichever order the serializer wrote the keys in', () => {
    const source = 'x([{"revision":"abc","url":"index.html"},{"url":"a.js","revision":null}]);';
    expect(precacheEntries(source)).toEqual([
      { revision: 'abc', url: 'index.html' },
      { url: 'a.js', revision: null },
    ]);
  });

  it('does not end the array early on a bracket inside a URL', () => {
    const source = 'x([{"revision":"a","url":"assets/we[i]rd.js"},{"revision":"b","url":"index.html"}]);';
    expect(precachedUrls(source)).toEqual(['assets/we[i]rd.js', 'index.html']);
  });

  it('does not end the array early on an escaped quote inside a URL', () => {
    const source = 'x([{"revision":"a","url":"assets/qu\\"ote].js"},{"revision":"b","url":"index.html"}]);';
    expect(precachedUrls(source)).toEqual(['assets/qu"ote].js', 'index.html']);
  });

  it('ignores an array that is not precache entries', () => {
    expect(precachedUrls('const days=[{"revision":1}];const x=[1,2,3];')).toEqual([]);
  });

  it('returns nothing rather than throwing on an unparseable array', () => {
    expect(precachedUrls('x([{"revision":"a","url":')).toEqual([]);
  });

  it('finds nothing in a worker that precaches nothing — which callers must treat as a FAILURE', () => {
    // Stated as its own case because it is the trap: this is what a reader that
    // has stopped understanding the format also returns.
    expect(precachedUrls('self.addEventListener("fetch", () => {});')).toEqual([]);
  });
});

describe.skipIf(builtWorker === null)('the built service worker (dist/sw.js)', () => {
  it('precaches the app shell — the positive control for the assertion below', () => {
    const urls = precachedUrls(builtWorker!);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain('index.html');
  });

  it(`does NOT precache ${WEB_MANIFEST_FILENAME}`, () => {
    // The whole point of #546's bundle half. A precached manifest is answered
    // cache-first, so the edge Worker's per-hostname manifest never reaches a
    // client the service worker controls; and the entry's `revision` is an MD5
    // of the build-time bytes, so redeploying the same Edition reuses the hash
    // and an already-installed shell never re-fetches it either. Those are the
    // two acceptance criteria this ticket's Worker half cannot satisfy alone.
    expect(precachedUrls(builtWorker!)).not.toContain(WEB_MANIFEST_FILENAME);
  });
});

// A skipped assertion is not a passing one. `npm test` runs BEFORE `npm run
// build` in CI, so the block above is skipped on the run that matters — which is
// exactly why `vite.config.ts` carries `precacheExclusionGuard`, a build-time
// check over the same reader that fails the BUILD rather than a test. This
// assertion pins that the guard is still wired, so the coverage cannot quietly
// become "skipped in CI and nowhere else".
describe('the build-time guard that covers the skipped case', () => {
  const viteConfig = readFileSync(repoFile('../vite.config.ts'), 'utf8');

  it('is registered as a plugin', () => {
    expect(viteConfig).toMatch(/precacheExclusionGuard\(\),/);
  });

  it('reads the emitted worker through this module rather than grepping it', () => {
    expect(viteConfig).toMatch(/from '\.\/src\/sw-precache-audit'/);
  });
});
