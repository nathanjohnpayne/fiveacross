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
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The dotenv reader these files are written for. Imported rather than
// re-implemented because every round of review on PR #730 found the same thing:
// a hand-written approximation of this parser disagrees with it somewhere, and
// disagreeing in the accepting direction is a hang. firebase-tools is a
// devDependency and `npx firebase` runs moments later in the same script, so
// this adds no dependency the runner did not already have.
import { parse } from 'firebase-tools/lib/functions/env.js';

/**
 * `defineString('NAME'` / `defineBoolean('NAME'` / `defineSecret('NAME'` …
 *
 * Deliberately NOT an enumeration of the constructors in use. firebase-functions
 * 5.1.1 also exports `defineInt`, `defineFloat` and `defineList`, and a listed
 * subset fails in the worst possible way: the omitted constructor is skipped
 * silently, the existing declarations keep the zero-match guard from firing, and
 * every test still passes while the new param goes uncovered and hangs the
 * emulator (Codex P2 on PR #730 — `defineFloat` was in fact missing). Matching
 * any `define<Name>(` means a constructor added by a future SDK is caught
 * without an edit here, and an over-match fails in the safe direction: a loud
 * "no value for X" rather than a silent omission.
 *
 * The first argument is CAPTURED rather than matched, so a name this file
 * cannot resolve statically is rejected rather than skipped — see
 * `declaredParamNames`. Skipping it would be the same silent-omission bug in a
 * new costume (Codex P2 on PR #730).
 */
const DEFINE_CALL_RE = /\bdefine([A-Z][A-Za-z]*)\s*\(\s*([^,)]*)/g;

/**
 * A param name this file can resolve: one string literal, in any of the three
 * quote styles, holding a bare identifier. Backticks count — a template literal
 * with no substitution is an ordinary string, and rejecting one would be a
 * silent skip rather than a loud failure.
 */
const NAME_LITERAL_RE = /^(['"`])([A-Za-z_][A-Za-z0-9_]*)\1$/;

/**
 * Source with comments removed, so prose ABOUT a constructor is not mistaken for
 * a call to one — `visionGate.ts` carries exactly such a comment, and this file
 * has to tell the two apart now that an unparseable call is an error rather than
 * something to ignore. The `[^:]` guard keeps a `https://` inside a string from
 * being eaten as a line comment.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The named-import block for the params module, if the source has one. */
const PARAMS_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]firebase-functions\/params['"]/;

/**
 * Rejects an aliased constructor import — `defineString as stringParam` — which
 * would make every call site invisible to `DEFINE_CALL_RE` (Codex P2 on PR
 * #730). The alias is legal TypeScript, so the convention it violates has to be
 * enforced rather than assumed; the alternative is resolving bindings, which
 * means parsing TypeScript for a file that has never needed one.
 *
 * Checked only when the import is present, so the synthetic call fragments the
 * sibling spec builds are still parseable on their own. A source that stops
 * importing from this module entirely has changed shape far past an alias, and
 * the zero-match guard below is what catches that.
 */
function rejectAliasedConstructors(source) {
  const imported = PARAMS_IMPORT_RE.exec(source);
  if (!imported) {
    return;
  }
  const aliased = imported[1]
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => /\sas\s/.test(specifier));
  if (aliased.length > 0) {
    throw new Error(
      `functions/src/params.ts imports ${aliased.join(', ')} from firebase-functions/params. ` +
        'This generator finds params by their constructor name at the call site, so an alias ' +
        'hides every declaration made through it — and a hidden declaration is one the ' +
        'emulator blocks on. Import the constructors unaliased, or teach ' +
        'scripts/e2e-functions-env.mjs to resolve the binding.',
    );
  }
}

/**
 * The characters firebase-tools' dotenv parser unescapes, and their escapes —
 * mirrored from `ALL_ESCAPABLE_CHARACTERS_RE` / `CHARACTERS_TO_ESCAPE_SEQUENCES`
 * in its `lib/functions/env.js`, which is the reader these files are written for.
 */
const ESCAPABLE_RE = /[\n\r\t\v\\'"]/g;
const ESCAPE_SEQUENCES = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
};

/**
 * One dotenv assignment, serialized so firebase-tools reads back the value it
 * was given.
 *
 * Its own writer escapes and quotes only when escaping changed something, which
 * leaves two silent lossy cases its READER creates: an unquoted `#` opens a
 * comment (`LABEL=QA #1` reads back as `QA`), and an unquoted value is trimmed.
 * Both would corrupt a future param value with no error and no failing
 * assertion-line count, so quote for those too. The sibling spec proves the
 * round trip against the real parser rather than against this reasoning.
 */
export function formatAssignment(key, value) {
  const escaped = value.replace(ESCAPABLE_RE, (character) => ESCAPE_SEQUENCES[character]);
  const lossyUnquoted = escaped !== value || value.includes('#') || value !== value.trim();
  return lossyUnquoted ? `${key}="${escaped}"` : `${key}=${escaped}`;
}

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
export function e2eParamValues(projectId) {
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
export const E2E_SECRET_VALUES = {
  RESEND_API_KEY: 'e2e-not-used',
};

/**
 * Every param name `functions/src/params.ts` declares, split by where its
 * value belongs: `params` → `.env.local`, `secrets` → `.secret.local`.
 */
export function declaredParamNames(source) {
  const params = [];
  const secrets = [];
  const unresolvable = [];
  rejectAliasedConstructors(source);
  for (const [, kind, argument] of withoutComments(source).matchAll(DEFINE_CALL_RE)) {
    const literal = NAME_LITERAL_RE.exec(argument.trim());
    if (!literal) {
      unresolvable.push(`define${kind}(${argument.trim()})`);
      continue;
    }
    (kind === 'Secret' ? secrets : params).push(literal[2]);
  }
  // A name this file cannot read statically — `defineString(PARAM_NAME, …)` —
  // must stop the run rather than be dropped from the key set. Dropping it is
  // indistinguishable from the param not existing, which is the exact hang this
  // module exists to prevent, and every test would still pass.
  if (unresolvable.length > 0) {
    throw new Error(
      `functions/src/params.ts declares ${unresolvable.join(', ')} with a name this ` +
        'generator cannot resolve statically. Use a plain string literal for the param ' +
        'name, or teach scripts/e2e-functions-env.mjs to resolve the expression — ' +
        'silently skipping it would let the emulator block on a prompt for that param.',
    );
  }
  if (params.length === 0 && secrets.length === 0) {
    throw new Error(
      'No firebase-functions/params declarations found in the params source. ' +
        'If params.ts was restructured, update DEFINE_CALL_RE in scripts/e2e-functions-env.mjs — ' +
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
  return names.map((name) => formatAssignment(name, values[name])).join('\n') + '\n';
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
 * Declared names a dotenv body does not assign. Used to hold a developer's OWN
 * pre-existing `functions/.env.local` to the same rule — a file written before a
 * param was added hangs exactly like a missing one, and is the case least likely
 * to be noticed, since the person who has one never sees the bug that a fresh
 * checkout hits.
 *
 * Delegated to the consumer's parser rather than pattern-matched, after two
 * rounds of finding that no regex agrees with it (Codex P2 x2 on PR #730). Line
 * matching was wrong in both directions: it rejected `export KEY=x` and
 * `KEY = x`, which that parser accepts, and — worse, because this direction
 * ends in a hang rather than an error — it accepted a `KEY=` that appears
 * INSIDE a multiline quoted value, which the parser does not treat as an
 * assignment at all.
 */
export function unassignedNames(fileBody, names) {
  const assigned = parse(fileBody).envs;
  return names.filter((name) => !Object.hasOwn(assigned, name));
}

/**
 * Secret names a `.secret.local` body does not usefully supply — present but
 * EMPTY counts as missing here, mirroring the emulator's own test.
 *
 * `resolveSecretEnvs` filters with `!secretEnvs[s.key]` and reaches for the real
 * Secret Manager for anything falsey, so a leftover `RESEND_API_KEY=` would send
 * a supposedly self-contained e2e run looking for live credentials (Codex P2 on
 * PR #730). A names-only check cannot see that.
 */
export function unusableSecretNames(fileBody, names) {
  const assigned = parse(fileBody).envs;
  return names.filter((name) => !assigned[name]);
}

/**
 * The dotenv files the Functions emulator MERGES before resolving params, in
 * firebase-tools' order (`findEnvfiles` in `lib/functions/env.js`): the common
 * file, the per-project file, then the emulator overlay. Whichever exist are
 * layered, later winning.
 *
 * Coverage has to be judged against that union, not against `.env.local` alone.
 * Keeping shared values in `functions/.env` and only an override in `.env.local`
 * is a supported layout, and checking the overlay in isolation would abort a run
 * the emulator would have served happily (Codex P2 on PR #730). `.secret.local`
 * has no equivalent layering — it is a single file
 * (`LOCAL_SECRETS_FILE` in `lib/emulator/functionsEmulatorShared.js`).
 */
export function emulatorDotenvFiles(projectId) {
  return ['.env', `.env.${projectId}`, '.env.local'];
}

/**
 * Concatenation is the right merge here precisely because this only ever asks
 * "is this name assigned anywhere the emulator will read": last-wins ordering
 * cannot change the answer, so no value resolution is needed.
 */
function mergedDotenvBody(directory, projectId) {
  return emulatorDotenvFiles(projectId)
    .map((file) => join(directory, file))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function ensureFile(path, names, body, { coverageBody, unmet, consequence }) {
  if (!existsSync(path)) {
    writeFileSync(path, body);
    return;
  }
  const missing = unmet(coverageBody ?? readFileSync(path, 'utf8'), names);
  if (missing.length > 0) {
    const one = missing.length === 1;
    throw new Error(
      `${path} exists, but functions/src/params.ts declares ${missing.join(', ')} — ` +
        `${one ? 'that name is' : 'those names are'} ${consequence}. Add the missing ` +
        `line(s) to ${path}, or delete ${path} to have npm run test:e2e regenerate it.`,
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
  ensureFile(envPath, params, env, {
    coverageBody: mergedDotenvBody(dirname(envPath), projectId),
    unmet: unassignedNames,
    consequence:
      'not set in any dotenv file the emulator merges, and it would block forever ' +
      'prompting for a value',
  });
  ensureFile(secretPath, secrets, secret, {
    unmet: unusableSecretNames,
    consequence:
      'missing or empty here, and the emulator treats an empty secret as absent — it would ' +
      'go looking for the real Secret Manager secret instead of staying self-contained',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
