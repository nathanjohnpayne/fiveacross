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
import { validateRouterServiceBinding } from './harness-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(HERE, '../../worker/wrangler.toml');

try {
  validateRouterServiceBinding(readFileSync(CONFIG, 'utf8'));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
