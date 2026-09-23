// @vitest-environment node
//
// Pins the shared brand-table loader, and the fact that both renderers next
// door get through it. The defect this guards was a crash at MODULE LOAD:
// `render-og-editions.mjs` and `render-share-footer.mjs` each carried a private
// loader that transpiled `src/editions.ts` alone and stubbed its `require`, so
// the day the module gained a real import both scripts died before parsing
// their arguments — and nothing in `npm test` executed either script's load
// path, so the runbook kept pointing people at a command that crashed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EDITION_IDS } from '../../src/edition-registry.ts';
import { DEFAULT_EDITION, editionBrand, wordmarkSegments } from '../../src/editions.ts';
import { loadEditions } from './load-editions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// #887 adds a third: the share-card raster generator reads the brand table
// through the same loader, to rewrite the footer line from it before a
// capture, and is exposed to exactly the same load-time rot.
const RENDERERS = ['render-og-editions.mjs', 'render-share-footer.mjs', 'render-share-rasters.mjs'];

describe('loadEditions', () => {
  const loaded = loadEditions();

  it("evaluates src/editions.ts with the module's own imports resolved", () => {
    // The transpile-and-stub loader this replaced threw here — `EDITION_IDS`
    // came back `{}` from the stubbed `require` and the module body fell over
    // building its `ogUrl` table — so there was no `editionBrand` to destructure.
    expect(loaded.DEFAULT_EDITION).toBe(DEFAULT_EDITION);
    expect(typeof loaded.editionBrand).toBe('function');
    expect(typeof loaded.wordmarkSegments).toBe('function');
  });

  it('hands the renderers the same rows the app compiles', () => {
    for (const id of Object.values(EDITION_IDS)) {
      const brand = loaded.editionBrand(id);
      expect(brand).toEqual(editionBrand(id));
      expect(loaded.wordmarkSegments(brand)).toEqual(wordmarkSegments(editionBrand(id)));
    }
  });
});

describe('the renderers get through their brand-table load', () => {
  // An Edition id that does not exist is the cheapest way to execute a
  // renderer's load path for real: a working script reaches the `Unknown
  // edition` check and exits 1 on it, while the loader this replaced threw a
  // TypeError before either script got that far. No browser, no network, no
  // fonts, and nothing written — `render-og-editions.mjs` is pointed at a
  // scratch `--out` that must stay empty, and the two share-card scripts run
  // with `--check`.
  //
  // `render-og-editions.mjs` still calls `loadEditions()` at module scope. The
  // two share-card scripts (#887) import the loader statically but call it
  // inside `main`, because they are also imported by their own unit tests for
  // the staging seams they export and evaluating the brand table on import
  // would make every one of those tests shell out to esbuild. So the spawn
  // below reaches the loader only for `render-og-editions.mjs`: the share-card
  // scripts refuse the unknown Edition before their loader call, and the
  // valid-Edition runs in the next block are what reach it (#1257).
  const outDir = mkdtempSync(join(tmpdir(), 'og-load-editions-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  const cases = [
    ['render-og-editions.mjs', ['--out', outDir]],
    ['render-share-footer.mjs', ['--check']],
    ['render-share-rasters.mjs', ['--out', outDir, '--check']],
  ];
  for (const [script, extra] of cases) {
    it(`${script} rejects an unknown edition instead of crashing on load`, () => {
      const result = spawnSync(
        process.execPath,
        [join(here, script), '--edition', 'not-an-edition', '--allow-foreign-platform', ...extra],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.signal, 'the script must exit on its own').toBeNull();
      expect(result.stderr).not.toMatch(/TypeError|Cannot read properties/);
      expect(result.stderr).toMatch(/^Unknown edition "not-an-edition"\. Known: /m);
      expect(result.status).toBe(1);
    });
  }

  it('writes nothing while rejecting the edition', () => {
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe('the share-card renderers reach their real loader call with a valid Edition (#1257)', () => {
  // The unknown-Edition cases above stop the two share-card scripts BEFORE
  // `loadEditions()`, because those scripts call the loader inside `main`
  // after validating the Edition — so a failure at either script's loader
  // call, or in resolving a real Edition's brand row, passed every case
  // there. These runs take a real Edition all the way through the loader and
  // the brand-row resolution, and stop at the first thing after them:
  // Chromium's launch, which fails deterministically because
  // PLAYWRIGHT_BROWSERS_PATH points at an empty directory. No browser starts,
  // no network, and nothing is written (`--check`, plus a scratch `--out`
  // that must stay empty). A loader or brand-table failure surfaces as its
  // own error instead of the launch error, and fails the test.
  const scratch = mkdtempSync(join(tmpdir(), 'og-load-editions-valid-'));
  const noBrowsers = join(scratch, 'no-browsers');
  const outDir = join(scratch, 'out');
  mkdirSync(noBrowsers);
  mkdirSync(outDir);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const cases = [
    ['render-share-footer.mjs', ['--check']],
    ['render-share-rasters.mjs', ['--out', outDir, '--check']],
  ];
  // One named Edition, and `--all`, which resolves every Edition's brand row.
  const selectors = [
    { label: `--edition ${DEFAULT_EDITION}`, selector: ['--edition', DEFAULT_EDITION] },
    { label: '--all', selector: ['--all'] },
  ];
  for (const [script, extra] of cases) {
    it.each(selectors)(`${script} $label gets through loadEditions() and the brand rows`, ({ selector }) => {
      const result = spawnSync(
        process.execPath,
        [join(here, script), ...selector, '--allow-foreign-platform', ...extra],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: noBrowsers },
        },
      );
      expect(result.signal, 'the script must exit on its own').toBeNull();
      expect(result.stderr).not.toMatch(/TypeError|Cannot read properties|Unknown edition|esbuild/);
      expect(result.stderr).toMatch(/browserType\.launch: Executable doesn't exist/);
      expect(result.status).toBe(1);
    });

    it(`${script} calls the loader before it launches the browser`, () => {
      // What makes the run above a loader test: if the call moved after the
      // launch, the launch error would arrive first and the loader would go
      // unexercised again.
      const code = readFileSync(join(here, script), 'utf8');
      const loaderCall = code.indexOf('= loadEditions();');
      const launch = code.indexOf("await import('playwright')");
      expect(loaderCall).toBeGreaterThan(-1);
      expect(launch).toBeGreaterThan(loaderCall);
    });
  }

  it('writes nothing while stopping at the launch', () => {
    expect(readdirSync(outDir)).toEqual([]);
    expect(readdirSync(noBrowsers)).toEqual([]);
  });
});

describe('the renderers share one loader', () => {
  it.each(RENDERERS)('%s reads the brand table through the shared loader', (script) => {
    // One loader, not one per renderer: the previous arrangement rotted in two
    // places at once, and a re-inlined copy would pass the spawn cases above
    // for exactly as long as it happened to work.
    const code = readFileSync(join(here, script), 'utf8');
    expect(code).toContain("import { loadEditions } from './load-editions.mjs';");
    expect(code).not.toMatch(/from 'esbuild'/);
    // A dynamic `await import('./load-editions.mjs')` would satisfy neither
    // the line above nor a reader looking for the dependency at the top of the
    // file, and it is the shape a renderer drifts into when it wants to defer
    // the esbuild cost. Deferring the CALL is the supported way to do that.
    // The matcher tolerates whitespace inside the parentheses and a template
    // literal specifier, so `import ( './load-editions.mjs' )` and
    // import(`./load-editions.mjs`) are refused as well (CodeRabbit, PR #1246).
    expect(code).not.toMatch(/import\s*\(\s*[`'"]\.\/load-editions\.mjs[`'"]\s*\)/);
  });
});
