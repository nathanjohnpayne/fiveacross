// Loads the brand table (`src/editions.ts`) into a plain Node process, for the
// OG and share-card renderers next door.
//
// The module is BUNDLED here, not merely transpiled. Each renderer used to
// carry its own copy of a loader that transpiled the one file and evaluated
// it with a `require` that returned `{}`, on a comment asserting "the only
// import is a type-only one, which esbuild has already erased". That stopped
// being true once `src/editions.ts` started importing `EDITION_IDS` from
// `edition-registry.ts` and `brandFor` / `DEFAULT_EDITION` / `isKnownEdition`
// from `edition-brands.ts` for real values: the stub handed the module body
// `{}` for both, and every copy of the loader died on load with
// `TypeError: Cannot read properties of undefined (reading 'VACAY_BINGO')`
// while `docs/app/og-artwork.md` went on naming those scripts as the supported
// way to change this artwork. Bundling resolves the sibling modules instead of
// stubbing them, so the loader cannot rot the next time the brand table grows
// an import — and it lives here, once, so it cannot rot in several places
// independently. `load-editions.test.mjs` runs it in `npm test`.
//
// Two deliberate choices in the build:
//
//   - `import.meta.env.VITE_EDITION` is defined away because `seedEdition()`
//     reads it. No renderer reaches that path — every lookup passes an
//     explicit Edition id — but esbuild will not emit a CJS bundle containing
//     `import.meta` without being told what it is.
//   - Packages stay external and the evaluated bundle gets a REAL `require`,
//     resolved from the entry point, rather than a stub. Sibling source is
//     what bundling is for; anything else the brand table might one day
//     import (a node builtin, a dependency) should resolve for real or fail
//     loudly, never silently arrive as `{}` — which is exactly the failure
//     this module exists to end.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

/** The brand table's runtime entry point (`src/editions.ts`). */
export const EDITIONS_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'editions.ts');

/**
 * Evaluate `src/editions.ts` and hand back its module exports — `editionBrand`,
 * `wordmarkSegments`, `DEFAULT_EDITION` and the rest of its public surface.
 */
export function loadEditions() {
  const { outputFiles } = buildSync({
    entryPoints: [EDITIONS_SOURCE],
    bundle: true,
    packages: 'external',
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    define: { 'import.meta.env.VITE_EDITION': 'undefined' },
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(
    module,
    module.exports,
    createRequire(EDITIONS_SOURCE),
  );
  return module.exports;
}
