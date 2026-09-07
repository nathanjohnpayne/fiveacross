#!/usr/bin/env node
// Fail-closed check that the configuration `wrangler deploy` will actually read
// binds the registry lookup entrypoint EXPLICITLY, for `scripts/worker-deploy.sh`
// to run before it installs a toolchain or publishes anything.
//
// It is a separate file rather than an inline `node -e` in the shell script so
// the validator it calls stays the single shared definition, and so the failure
// is a normal non-zero exit the wrapper can explain rather than a quoting
// accident inside a one-liner.
//
// On success it prints `routes=true` or `routes=false` on stdout: whether this
// deploy attaches routes is read from the same parsed document, because the
// wrapper announces "changes nothing the public sees" on the strength of it.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, '../../worker');
const CONFIG = resolve(WORKER, 'wrangler.toml');

/**
 * Wrangler resolves its configuration by filename PRECEDENCE FIRST and only
 * then by directory: it searches every ancestor of the working directory for
 * `wrangler.json`, then every ancestor for `wrangler.jsonc`, and only then for
 * `wrangler.toml`. `npm --prefix worker run deploy` runs with the working
 * directory set to `worker/`, so a `wrangler.json` anywhere from `worker/` up
 * to the filesystem root wins over the file validated here — silently, with no
 * warning that the TOML was ignored, and from outside the repository where no
 * clean-tree or freshness guard can see it.
 */
const OUTRANKING_NAMES = ['wrangler.json', 'wrangler.jsonc'];

/**
 * `wrangler deploy` also honours a REDIRECT: `.wrangler/deploy/config.json`
 * names another configuration to deploy in place of this one. That directory is
 * gitignored, so the redirect is invisible to `git status` and therefore to the
 * clean-tree guard as well.
 *
 * It is resolved the way the outranking filenames are — by ANCESTOR WALK, not
 * at `worker/` alone. Wrangler looks the redirect up through the same
 * ancestor-walking helper it uses for its ordinary configuration lookup, so a
 * `.wrangler/deploy/config.json` at the repository root, or anywhere above it,
 * redirects the deploy just as effectively as one inside `worker/` — and from
 * outside the repository, where no guard here could otherwise see it.
 */
const REDIRECT_PATH = '.wrangler/deploy/config.json';

/** Exit code for "the check could not be performed", distinct from a refusal. */
const UNAVAILABLE = 69;

/** A real FILE, the way Wrangler's own resolver tests it — a directory of that
 *  name is not a configuration and refusing it would be a false positive. */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every ancestor of `worker/`, nearest first, the way Wrangler walks them. */
function ancestors(from) {
  const chain = [];
  let current = from;
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

// Imported dynamically so a missing root install is reported AS a missing root
// install. The validator parses the configuration with `smol-toml`, a root
// devDependency, and a static import of an absent module aborts the process
// before any of this file runs. Still fail-closed either way: every path below
// exits non-zero and nothing is published.
let validateRouterServiceBinding;
let declaresRoutes;
try {
  ({ validateRouterServiceBinding, declaresRoutes } = await import('./harness-config.mjs'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(UNAVAILABLE);
}

const outranking = ancestors(WORKER).flatMap((directory) =>
  OUTRANKING_NAMES.map((name) => resolve(directory, name)).filter(isFile),
);
if (outranking.length > 0) {
  process.stderr.write(`${outranking.join('\n')}\n`);
  process.stderr.write('Wrangler would read the file(s) above instead of worker/wrangler.toml\n');
  process.exit(1);
}

const redirects = ancestors(WORKER)
  .map((directory) => resolve(directory, REDIRECT_PATH))
  .filter(isFile);
if (redirects.length > 0) {
  process.stderr.write(`${redirects.join('\n')}\n`);
  process.stderr.write('redirect(s) above send the deploy away from worker/wrangler.toml\n');
  process.exit(1);
}

let config;
try {
  config = readFileSync(CONFIG, 'utf8');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(UNAVAILABLE);
}

try {
  validateRouterServiceBinding(config);
  process.stdout.write(`routes=${String(declaresRoutes(config))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
