#!/usr/bin/env node
// Fail-closed check that `worker/wrangler.toml` binds the registry lookup
// entrypoint EXPLICITLY, for `scripts/worker-deploy.sh` to run before it
// installs a toolchain or publishes anything.
//
// It is a separate file rather than an inline `node -e` in the shell script so
// the validator it calls stays the single shared definition, and so the failure
// is a normal non-zero exit the wrapper can explain rather than a quoting
// accident inside a one-liner.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(HERE, '../../worker/wrangler.toml');

// Imported dynamically so a missing root install is reported AS a missing root
// install. The validator parses the configuration with `smol-toml`, a root
// devDependency, and a static import of an absent module aborts the process
// before any of this file runs — leaving the wrapper to announce a binding
// problem that does not exist. Still fail-closed either way: both paths exit
// non-zero and nothing is published.
let validateRouterServiceBinding;
try {
  ({ validateRouterServiceBinding } = await import('./harness-config.mjs'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(
    'Could not load the registry binding validator. Run `npm ci` at the repository root first.\n',
  );
  process.exit(1);
}

try {
  validateRouterServiceBinding(readFileSync(CONFIG, 'utf8'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
