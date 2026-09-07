#!/usr/bin/env node
// Fail-closed check that `worker/wrangler.toml` binds the registry lookup
// entrypoint EXPLICITLY, for `scripts/worker-deploy.sh` to run before it
// installs a toolchain or publishes anything.
//
// It is a separate file rather than an inline `node -e` in the shell script so
// the validator it calls stays the single shared definition, and so the failure
// is a normal non-zero exit the wrapper can explain rather than a quoting
// accident inside a one-liner.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, '../../worker');
const CONFIG = resolve(WORKER, 'wrangler.toml');
// Wrangler resolves its default configuration as `wrangler.json`, then
// `wrangler.jsonc`, then `wrangler.toml`. Validating the TOML while a JSON file
// sits beside it would certify a document Wrangler never reads — checked with
// a real `wrangler deploy --dry-run`, which bound the registry's DEFAULT export
// from the JSON while the TOML beside it named the lookup entrypoint.
const OUTRANKS = ['wrangler.json', 'wrangler.jsonc'];

/** Exit code for "the check could not be performed", distinct from a refusal. */
const UNAVAILABLE = 69;

// Imported dynamically so a missing root install is reported AS a missing root
// install. The validator parses the configuration with `smol-toml`, a root
// devDependency, and a static import of an absent module aborts the process
// before any of this file runs. Still fail-closed either way: every path below
// exits non-zero and nothing is published.
let validateRouterServiceBinding;
try {
  ({ validateRouterServiceBinding } = await import('./harness-config.mjs'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(UNAVAILABLE);
}

const outranking = OUTRANKS.filter((name) => existsSync(resolve(WORKER, name)));
if (outranking.length > 0) {
  process.stderr.write(
    `worker/${outranking.join(', worker/')} would be read by Wrangler instead of worker/wrangler.toml\n`,
  );
  process.exit(1);
}

try {
  validateRouterServiceBinding(readFileSync(CONFIG, 'utf8'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
