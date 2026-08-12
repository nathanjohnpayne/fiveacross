// Derives the emulator-only functions/.env.local and functions/.secret.local
// content from the params actually declared in functions/src/params.ts (via
// the built functions/lib/params.js), instead of a hand-maintained copy that
// silently drifts out of sync (#724).
//
// The failure mode this closes: a StringParam/BooleanParam declared in
// params.ts with a code-level `default` but omitted from a hand-written
// list doesn't error — the Functions emulator instead blocks on an
// interactive "enter a value" prompt for it, even under `--non-interactive`
// (a firebase-tools param-resolution quirk: a default in *code* isn't
// enough, the emulator wants every declared param present in the dotenv
// file it loads). `npm run test:e2e` then hangs forever on a checkout that
// doesn't already have a `functions/.env.local` lying around. Two params hit
// this already — EMAIL_REPLY_TO and EMAIL_UNSUBSCRIBE_URL — and a two-line
// patch adding just those two would only set up the third.
//
// Value params (StringParam/BooleanParam/...) are handled generically: any
// param carrying a code-level `default` is fully derived here, so adding a
// new one to params.ts is automatically picked up — closing the bug class
// instead of patching known instances. A value param declared WITHOUT a
// default has no safe value to synthesize, so this script fails loudly at
// generation time (before the emulator ever starts, with a clear message)
// rather than risking a silent hang; the fix is to give the param a default
// or to extend this script with an explicit e2e value.
//
// Secret params (SecretParam, via `defineSecret`) never carry a `default` by
// design (Secret Manager values), so they can't be derived the same way.
// KNOWN_SECRET_TEST_VALUES is the explicit, human-reviewed value each secret
// resolves to under the emulator. An unregistered secret param fails loudly
// here too, rather than leaving the emulator to hang or silently guessing a
// value that might matter.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KNOWN_SECRET_TEST_VALUES = Object.freeze({
  RESEND_API_KEY: 'e2e-not-used',
});

// A value param's code-level `default` is the right e2e value for almost
// every param (that's the whole point of this script), but two predate it
// with a deliberately DIFFERENT e2e value rather than the production
// default: EMAIL_FROM uses an obviously-fake `*.invalid` domain so a sent
// e2e email is never mistakable for a real one even if Resend's fake key
// somehow didn't reject it, and APP_BASE_URL points at the locally-running
// preview server rather than the production host so any deep link built
// during a test targets the thing actually running. Keep this map small —
// it exists only for values that must diverge from their code default, not
// as a second copy of every param.
export const KNOWN_ENV_OVERRIDES = Object.freeze({
  EMAIL_FROM: 'Gay Cruise Bingo <e2e@example.invalid>',
  APP_BASE_URL: 'http://127.0.0.1:4173',
});

// firebase-functions/params `Param` instances are duck-typed here rather
// than checked with `instanceof` so this script never needs its own
// dependency on firebase-functions: every param carries `name`; value
// params (String/Boolean/Int/...) additionally carry an `options` object
// (empty `{}` when no options were passed); Secret params carry only `name`.
export function classifyParams(paramsModule) {
  const valueParams = [];
  const secretParams = [];
  for (const param of Object.values(paramsModule)) {
    if (!param || typeof param !== 'object' || typeof param.name !== 'string') continue;
    if (Object.hasOwn(param, 'options')) {
      valueParams.push(param);
    } else {
      secretParams.push(param);
    }
  }
  return { valueParams, secretParams };
}

export function envFileLines(valueParams, overrides = KNOWN_ENV_OVERRIDES) {
  const missingDefaults = valueParams.filter(
    (p) => !Object.hasOwn(overrides, p.name) && (!p.options || !Object.hasOwn(p.options, 'default')),
  );
  if (missingDefaults.length > 0) {
    throw new Error(
      `functions/src/params.ts declares ${missingDefaults.map((p) => p.name).join(', ')} without a default. ` +
        'scripts/gen-functions-env.mjs can only derive the e2e emulator env for params that carry a default ' +
        '(the Functions emulator will otherwise block on an interactive prompt for it, even under ' +
        '--non-interactive) — give it a default, or register an explicit e2e value in KNOWN_ENV_OVERRIDES.',
    );
  }
  return valueParams
    .map((p) => `${p.name}=${Object.hasOwn(overrides, p.name) ? overrides[p.name] : String(p.options.default)}`)
    .sort()
    .join('\n');
}

export function secretFileLines(secretParams, knownValues = KNOWN_SECRET_TEST_VALUES) {
  const unregistered = secretParams.filter((p) => !Object.hasOwn(knownValues, p.name));
  if (unregistered.length > 0) {
    throw new Error(
      `functions/src/params.ts declares secret param(s) ${unregistered.map((p) => p.name).join(', ')} with no ` +
        'registered e2e test value. Add one to KNOWN_SECRET_TEST_VALUES in scripts/gen-functions-env.mjs (the ' +
        'Functions emulator will otherwise block on an interactive prompt for it, even under --non-interactive).',
    );
  }
  return secretParams
    .map((p) => `${p.name}=${knownValues[p.name]}`)
    .sort()
    .join('\n');
}

// The built functions/lib/params.js is CommonJS; `createRequire` gives a
// `require()` rooted at functionsDir so `require('firebase-functions/params')`
// resolves against functions/node_modules rather than the repo root's (which
// doesn't depend on firebase-functions at all).
export function loadBuiltParamsModule(functionsDir) {
  const scopedRequire = createRequire(path.join(functionsDir, 'package.json'));
  const paramsPath = scopedRequire.resolve(path.join(functionsDir, 'lib', 'params.js'));
  return scopedRequire(paramsPath);
}

function usage() {
  console.error('Usage: node scripts/gen-functions-env.mjs <env|secrets> <functionsDir>');
  console.error('Prints the derived dotenv content to stdout; run `npm --prefix functions run build` first.');
}

function main() {
  const [kind, functionsDirArg] = process.argv.slice(2);
  if ((kind !== 'env' && kind !== 'secrets') || !functionsDirArg) {
    usage();
    process.exitCode = 1;
    return;
  }

  const functionsDir = path.resolve(functionsDirArg);
  let paramsModule;
  try {
    paramsModule = loadBuiltParamsModule(functionsDir);
  } catch (error) {
    console.error(`Failed to load ${path.join(functionsDir, 'lib', 'params.js')}: ${error.message}`);
    console.error('Has `npm --prefix functions run build` run yet?');
    process.exitCode = 1;
    return;
  }

  const { valueParams, secretParams } = classifyParams(paramsModule);
  try {
    const body = kind === 'env' ? envFileLines(valueParams) : secretFileLines(secretParams);
    process.stdout.write(body.length > 0 ? `${body}\n` : '');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
