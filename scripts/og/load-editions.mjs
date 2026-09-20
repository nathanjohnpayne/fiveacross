// Loads the brand table (`src/editions.ts`) into a plain Node process, for the
// OG and share-card renderers next door.
//
// The module is BUNDLED here, not merely transpiled. Each renderer used to
// carry its own copy of this loader, transpiling the single file and handing
// it a `require` that returned `{}` on a comment asserting "the only import is
// a type-only one" — which stopped being true once `src/editions.ts` started
// importing `EDITION_IDS` and `brandFor` for real values. Every copy then died
// on load with `TypeError: Cannot read properties of undefined (reading
// 'VACAY_BINGO')`, while `docs/app/og-artwork.md` went on naming those scripts
// as the supported way to change this artwork. Bundling resolves the sibling
// modules instead of stubbing them, so the loader cannot rot the next time the
// brand table grows an import — and it lives here, once, so it cannot rot in
// three places independently.
//
// `import.meta.env.VITE_EDITION` is defined away because `seedEdition()` reads
// it. No caller reaches that path — every lookup in the renderers passes an
// explicit Edition id — but esbuild will not emit a CJS bundle containing
// `import.meta` without being told what it is.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Evaluate `src/editions.ts` and hand back its module exports — `editionBrand`,
 * `wordmarkSegments` and the rest of the brand table's public surface.
 */
export function loadEditions() {
  const bundled = buildSync({
    entryPoints: [join(repo, 'src', 'editions.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    define: { 'import.meta.env.VITE_EDITION': 'undefined' },
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(
    module,
    module.exports,
    () => ({}),
  );
  return module.exports;
}
