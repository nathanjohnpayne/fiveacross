#!/usr/bin/env node
/**
 * Generates (and verifies) the throwaway `functions/.env.local` and
 * `functions/.secret.local` that `scripts/test-e2e.sh` hands the Functions
 * emulator.
 *
 * WHY THIS IS A GENERATOR AND NOT FOUR LITERAL LINES OF BASH (#724). The
 * emulator prompts for every param declared in `functions/src/params.ts` that
 * the loaded dotenv files do not already name — and it blocks on that prompt
 * forever, with no timeout and no error. Three separate properties of
 * firebase-tools conspire:
 *
 *   1. `resolveParams` partitions params purely on "is this name present in
 *      the user's env files". A `default:` does NOT keep a param out of the
 *      prompt list; it only pre-fills the answer. So EVERY declared param
 *      needs a line here, including the ones defaulting to an empty string.
 *   2. The Functions emulator calls `resolveBackend({ ..., nonInteractive:
 *      false })` — hardcoded, in `lib/emulator/functionsEmulator.js`. The
 *      CLI's own `--non-interactive` flag never reaches param resolution.
 *   3. Whether that turns into a hang or a silent default depends on the
 *      CLI version: 15.26.0 (this repo's pin) added a global non-interactive
 *      guard in `lib/prompt.js` that returns the default instead of asking,
 *      but 15.22.4 — a plausible global `firebase` on a developer's PATH, and
 *      what `npx firebase` falls back to in a worktree whose `node_modules`
 *      is not installed — has no such guard and hangs on
 *      `? Enter a string value for EMAIL_REPLY_TO:`.
 *
 * So the omission is silent, version-dependent, and only bites a checkout with
 * no pre-existing `functions/.env.local` — which is exactly a fresh clone or a
 * new agent worktree. It has now bitten twice: `EMAIL_REPLY_TO` (#724) and
 * `EMAIL_UNSUBSCRIBE_URL` (#616's param, added after that report). Deriving
 * the key set from `params.ts` instead of restating it makes the third time
 * fail loudly at the naming step rather than hanging the suite.
 *
 * The deploy path has the same failure mode and its own answer: every param is
 * also declared in the committed `functions/.env.example` template, for the
 * reason its `BUG_REPORT_APP_CHECK` comment records (#158). The sibling spec
 * holds that file to the same coverage rule.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * `defineString('NAME'` / `defineBoolean('NAME'` / `defineSecret('NAME'` …
 *
 * Anchored on the quoted name literal that must follow the paren, so prose
 * references to a `defineBoolean(...)` call in a doc comment cannot match.
 */
const DEFINE_RE = /\bdefine(String|Boolean|Int|List|Secret)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;

/** The e2e run's functions emulator port — firebase.json `emulators.functions.port`. */
export const FUNCTIONS_EMULATOR_PORT = 5001;

/**
 * Values for the non-secret params, keyed by the name `params.ts` declares.
 *
 * Every value is deliberately local or non-routable: `specs/x-e2e-happy-path.md`
 * holds the e2e layer to being hermetic, so nothing here may name a live host.
 * `EMAIL_UNSUBSCRIBE_URL` therefore points at the emulator's own
 * `emailUnsubscribe` endpoint rather than the production default in `params.ts`.
 */
function e2eParamValues(projectId) {
  return {
    EMAIL_FROM: 'Gay Cruise Bingo <e2e@example.invalid>',
    EMAIL_REPLY_TO: '',
    ADMIN_NOTIFY_EMAIL: '',
    APP_BASE_URL: 'http://127.0.0.1:4173',
    BUG_REPORT_APP_CHECK: 'false',
    EMAIL_UNSUBSCRIBE_URL: `http://127.0.0.1:${FUNCTIONS_EMULATOR_PORT}/${projectId}/us-central1/emailUnsubscribe`,
  };
}

/**
 * Values for the `defineSecret` params, which live in `.secret.local` rather
 * than `.env.local`. No e2e path performs a real send; the key only has to
 * exist so the emulator does not ask for one.
 */
const E2E_SECRET_VALUES = {
  RESEND_API_KEY: 'e2e-not-used',
};

/**
 * Every param name `functions/src/params.ts` declares, split by where its
 * value belongs: `params` → `.env.local`, `secrets` → `.secret.local`.
 */
export function declaredParamNames(source) {
  const params = [];
  const secrets = [];
  for (const [, kind, name] of source.matchAll(DEFINE_RE)) {
    (kind === 'Secret' ? secrets : params).push(name);
  }
  if (params.length === 0 && secrets.length === 0) {
    throw new Error(
      'No firebase-functions/params declarations found in the params source. ' +
        'If params.ts was restructured, update DEFINE_RE in scripts/e2e-functions-env.mjs — ' +
        'a parse that silently finds nothing would let the emulator prompt for every param.',
    );
  }
  return { params, secrets };
}

function renderDotenv(names, values, target) {
  const uncovered = names.filter((name) => !Object.hasOwn(values, name));
  if (uncovered.length > 0) {
    throw new Error(
      `functions/src/params.ts declares ${uncovered.join(', ')}, which the e2e ` +
        `${target} has no value for. The Functions emulator prompts for any declared ` +
        'param its dotenv files do not name — and blocks on that prompt forever — so add ' +
        `each one to scripts/e2e-functions-env.mjs (a default in params.ts does NOT ` +
        'exempt it).',
    );
  }
  return names.map((name) => `${name}=${values[name]}`).join('\n') + '\n';
}

/**
 * The two dotenv file bodies for an e2e run against `projectId`, or a throw
 * naming any declared param that has no e2e value.
 */
export function e2eFunctionsEnv(paramsSource, projectId) {
  const { params, secrets } = declaredParamNames(paramsSource);
  return {
    env: renderDotenv(params, e2eParamValues(projectId), 'functions/.env.local'),
    secret: renderDotenv(secrets, E2E_SECRET_VALUES, 'functions/.secret.local'),
  };
}

/**
 * Declared names a dotenv file body fails to assign. Used to hold a developer's
 * OWN pre-existing `functions/.env.local` to the same rule — a file written
 * before a param was added hangs exactly like a missing one, and is the case
 * least likely to be noticed, since the person who has one never sees the bug
 * that a fresh checkout hits.
 */
export function unassignedNames(fileBody, names) {
  return names.filter((name) => !new RegExp(`^\\s*${name}=`, 'm').test(fileBody));
}

function ensureFile(path, names, body) {
  if (!existsSync(path)) {
    writeFileSync(path, body);
    return;
  }
  const missing = unassignedNames(readFileSync(path, 'utf8'), names);
  if (missing.length > 0) {
    throw new Error(
      `${path} exists but does not set ${missing.join(', ')}, which functions/src/params.ts ` +
        'declares. The Functions emulator would block forever prompting for it. Add the ' +
        `missing line(s), or delete ${path} to have npm run test:e2e regenerate the file.`,
    );
  }
}

function main(argv) {
  const [paramsPath, envPath, secretPath, projectId] = argv;
  if (!paramsPath || !envPath || !secretPath || !projectId) {
    throw new Error(
      'usage: e2e-functions-env.mjs <params.ts> <.env.local> <.secret.local> <projectId>',
    );
  }
  const source = readFileSync(paramsPath, 'utf8');
  const { params, secrets } = declaredParamNames(source);
  // Both bodies are rendered before either is written, so the failure this
  // exists to produce — a param with no e2e value — creates nothing at all,
  // rather than a half-written file the next run would accept as good. Cleanup
  // after any LATER failure belongs to the caller: scripts/test-e2e.sh decides
  // which of these two files it owns before calling here, and removes only
  // those on exit.
  const { env, secret } = e2eFunctionsEnv(source, projectId);
  ensureFile(envPath, params, env);
  ensureFile(secretPath, secrets, secret);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
