// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
// The dotenv reader these files are actually written for. Asserting against it
// rather than against a hand-rolled parser is the point: both of the Codex P2
// findings on PR #730 were cases where a plausible-looking regex disagreed with
// this module. It is a devDependency, so it is present wherever `npm test` runs.
import { loadUserEnvs, parse, parseStrict } from 'firebase-tools/lib/functions/env.js';
import {
  E2E_SECRET_VALUES,
  FUNCTIONS_EMULATOR_PORT,
  declaredParamNames,
  declaredParamNamesAcross,
  e2eFunctionsEnv,
  e2eParamValues,
  emulatorDotenvFiles,
  formatAssignment,
  functionsSources,
  parseDotenv,
  unassignedNames,
  unusableSecretNames,
} from './e2e-functions-env.mjs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const PARAMS_SOURCE = read('../functions/src/params.ts');
const ENTRYPOINT = new URL('../functions/src/index.ts', import.meta.url).pathname;
/** What the emulator will actually resolve: the reachable module graph. */
const DISCOVERED = declaredParamNamesAcross(functionsSources(ENTRYPOINT));
const PROJECT_ID = 'demo-gaycruisebingo-e2e';
// Provenance is what marks a call as a param declaration, so every fragment
// below imports for real rather than relying on a name-shaped guess.
const IMPORT =
  "import { defineString, defineBoolean, defineSecret, defineInt, defineFloat, defineList } from 'firebase-functions/params';";

// The regression this file exists for (#724). `npm run test:e2e` is a local
// smoke runner that app-ci deliberately does not execute, so nothing in CI ever
// starts the emulator — a param added to functions/src/params.ts without a
// matching value would otherwise reach main unnoticed and hang the suite for
// whoever ran it next on a checkout with no functions/.env.local.
describe('e2e functions dotenv generation', () => {
  it('has a value for every param functions/src/params.ts declares', () => {
    expect(() => e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID)).not.toThrow();
  });

  it('assigns each declared param exactly one line in the file the emulator loads', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);
    const { env, secret } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);

    expect(unassignedNames(parseDotenv(env, 'env'), params)).toEqual([]);
    expect(unassignedNames(parseDotenv(secret, 'secret'), secrets)).toEqual([]);
    expect(env.trimEnd().split('\n')).toHaveLength(params.length);
  });

  it('names the uncovered param rather than generating a file that hangs the emulator', () => {
    const withNewParam = `${PARAMS_SOURCE}\nexport const SMTP_BRIDGE_URL = defineString('SMTP_BRIDGE_URL', { default: '' });\n`;

    expect(() => e2eFunctionsEnv(withNewParam, PROJECT_ID)).toThrow('SMTP_BRIDGE_URL');
  });

  it('refuses to emit an empty file set when the declarations stop parsing', () => {
    expect(() => declaredParamNames('export const nothing = 1;\n')).toThrow(/CONSTRUCTOR_RE/);
  });

  // Codex P2 on PR #730: an enumerated list of constructors fails silently —
  // the omitted one is skipped, the existing declarations keep the zero-match
  // guard quiet, and every assertion still passes.
  it('catches every param constructor, including ones this repo does not use yet', () => {
    const exotic = [
      // `defineDuration` is not an SDK export today: a constructor a future
      // firebase-functions adds must be caught without an edit to CONSTRUCTOR_RE.
      "import { defineFloat, defineInt, defineList, defineDuration } from 'firebase-functions/params';",
      "export const A = defineFloat('SAMPLE_RATE', { default: 0.5 });",
      "export const B = defineInt('BATCH_SIZE', { default: 10 });",
      "export const C = defineList('ALLOWED_HOSTS', { default: [] });",
      "export const D = defineDuration('RETRY_BACKOFF');",
    ].join('\n');

    expect(declaredParamNames(exotic).params).toEqual([
      'SAMPLE_RATE',
      'BATCH_SIZE',
      'ALLOWED_HOSTS',
      'RETRY_BACKOFF',
    ]);
  });

  it('ignores a prose reference to a constructor in a doc comment', () => {
    const lineComment = `${PARAMS_SOURCE}\n// equally a defineBoolean(...) read, not a declaration\n`;
    const blockComment = `${PARAMS_SOURCE}\n/**\n * a defineString(SOME_CONSTANT, …) call, described\n */\n`;

    expect(declaredParamNames(lineComment)).toEqual(declaredParamNames(PARAMS_SOURCE));
    expect(declaredParamNames(blockComment)).toEqual(declaredParamNames(PARAMS_SOURCE));
  });

  // Codex P2 on PR #730: a name the regex cannot read must stop the run. Being
  // skipped is indistinguishable from not existing — the hang comes back and
  // every assertion here still passes.
  it('reads a backtick literal, and rejects a name it cannot resolve', () => {
    const backticked = `${IMPORT}\nexport const A = defineString(\`SMTP_BRIDGE_URL\`, { default: '' });`;
    const computed = `${IMPORT}\nexport const A = defineString(PARAM_NAME, { default: '' });`;

    expect(declaredParamNames(backticked).params).toEqual(['SMTP_BRIDGE_URL']);
    expect(() => declaredParamNames(computed)).toThrow(/defineString\(…\)/);
    expect(() => declaredParamNames(computed)).toThrow(/cannot resolve statically/);
  });

  // Codex P2 x3 on PR #730 pushed this from "detect the alias and refuse" to
  // "resolve the binding". Reading the import is what makes an alias WORK, so
  // there is no convention left to enforce and nothing to hide behind one.
  it('resolves a constructor imported under an alias', () => {
    const aliased = [
      "import { defineString as stringParam } from 'firebase-functions/params';",
      "export const A = stringParam('SMTP_BRIDGE_URL', { default: '' });",
    ].join('\n');

    expect(declaredParamNames(aliased).params).toEqual(['SMTP_BRIDGE_URL']);
  });

  it('resolves a constructor reached through a namespace import', () => {
    const namespaced = [
      "import * as params from 'firebase-functions/params';",
      "export const A = params.defineSecret('MY_SECRET');",
    ].join('\n');

    expect(declaredParamNames(namespaced).secrets).toEqual(['MY_SECRET']);
  });

  it('leaves the real unaliased import alone', () => {
    expect(PARAMS_SOURCE).toMatch(/from 'firebase-functions\/params'/);
    expect(() => declaredParamNames(PARAMS_SOURCE)).not.toThrow();
  });

  // Codex P2 on PR #730, against the first version of the check above: the
  // module exports Expression, select, declaredParams, projectID and more
  // alongside its constructors. Aliasing one of those hides nothing, so
  // rejecting it would abort a run that works.
  it('allows aliasing an export that is not a param constructor', () => {
    const aliasedHelper = [
      "import { Expression as ParamExpression, defineString } from 'firebase-functions/params';",
      "export const A = defineString('SMTP_BRIDGE_URL', { default: '' });",
    ].join('\n');

    expect(declaredParamNames(aliasedHelper).params).toEqual(['SMTP_BRIDGE_URL']);
  });

  // Codex P2 on PR #730: a second import statement is legal, and the earlier
  // first-match-only lookup never saw it.
  it('reads every params import, not just the first', () => {
    const twoImports = [
      "import { defineString } from 'firebase-functions/params';",
      "import { defineFloat as floatParam } from 'firebase-functions/params';",
      "export const A = defineString('SMTP_BRIDGE_URL');",
      "export const B = floatParam('SAMPLE_RATE');",
    ].join('\n');

    expect(declaredParamNames(twoImports).params).toEqual(['SMTP_BRIDGE_URL', 'SAMPLE_RATE']);
  });

  // Codex P2 on PR #730. The old comment-stripping regex deleted everything
  // between a `/*` and a `*/` wherever they appeared — including when both sat
  // inside string data with a real declaration between them. A scanner does not
  // confuse the two.
  it('does not lose a declaration bracketed by comment delimiters inside strings', () => {
    const stringsWithDelimiters = [
      IMPORT,
      'const opening = `/* this is data, not a comment`;',
      "export const A = defineString('NEW_PARAM');",
      'const closing = `and this closes it */`;',
    ].join('\n');

    expect(declaredParamNames(stringsWithDelimiters).params).toEqual(['NEW_PARAM']);
  });

  // Codex P2 on PR #730: the alias check read raw source, so a commented-out
  // experiment aborted the run even though every active import was unaliased.
  it('ignores a commented-out import', () => {
    const commentedExperiment = [
      "// import { defineFloat as floatParam } from 'firebase-functions/params';",
      "import { defineString } from 'firebase-functions/params';",
      "export const A = defineString('SMTP_BRIDGE_URL');",
    ].join('\n');

    expect(declaredParamNames(commentedExperiment).params).toEqual(['SMTP_BRIDGE_URL']);
  });

  // Codex P2 on PR #730: Firebase resolves params from every loaded module, so a
  // handler declaring one beside itself would be invisible to a params.ts-only
  // scan — and the declarations already in params.ts keep the zero-match guard
  // satisfied while the emulator hangs on the new name.
  it('finds a param declared outside params.ts', () => {
    const spread = [
      { label: 'functions/src/params.ts', text: PARAMS_SOURCE },
      { label: 'functions/src/handler.ts', text: `${IMPORT}\nexport const S = defineString('SMTP_BRIDGE_URL');` },
    ];

    expect(declaredParamNamesAcross(spread).params).toContain('SMTP_BRIDGE_URL');
  });

  it('scans the real Functions tree and still lands on the params.ts set', () => {
    const reachable = functionsSources(ENTRYPOINT);

    expect(reachable.length).toBeGreaterThan(1);
    expect(declaredParamNamesAcross(reachable)).toEqual(declaredParamNames(PARAMS_SOURCE));
  });

  // Codex P2 on PR #730: the earlier fallback classified a call by how it was
  // SPELLED, so an unrelated local helper or object method named defineString
  // read as a Firebase param — and the generator then aborted every run
  // demanding a value the emulator has never heard of.
  it('ignores a look-alike call that did not come from the params module', () => {
    const impostors = [
      'function defineString(name) { return name; }',
      "export const A = defineString('NOT_A_PARAM');",
      'const schema = { defineString: (name) => name };',
      "schema.defineString('ALSO_NOT_A_PARAM');",
    ].join('\n');

    const scanned = declaredParamNamesAcross([
      { label: 'functions/src/params.ts', text: PARAMS_SOURCE },
      { label: 'functions/src/impostor.ts', text: impostors },
    ]);

    expect(scanned.params).not.toContain('NOT_A_PARAM');
    expect(scanned.params).not.toContain('ALSO_NOT_A_PARAM');
    expect(scanned).toEqual(declaredParamNames(PARAMS_SOURCE));
  });

  // Codex P2 on PR #730: the tree ships bugReportContract.cjs, loaded from
  // bugReportCore.ts, so a `.ts`-only filter had a real blind spot.
  it('scans non-TypeScript modules the Functions build can load', () => {
    const scanned = functionsSources(ENTRYPOINT);

    expect(scanned.map(({ label }) => label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/bugReportContract\.cjs$/)]),
    );
    expect(
      declaredParamNamesAcross([
        { label: 'functions/src/params.ts', text: PARAMS_SOURCE },
        { label: 'functions/src/legacy.cjs', text: `${IMPORT}\nexports.A = defineString('CJS_PARAM');` },
      ]).params,
    ).toContain('CJS_PARAM');
  });

  // Codex P2 on PR #730: the .cjs fixture that motivated the extension fix was
  // written in ESM, which is not executable CommonJS. A real .cjs module binds
  // its constructors through require.
  it('resolves constructors bound by a CommonJS require', () => {
    const destructured = [
      "const { defineString } = require('firebase-functions/params');",
      "exports.A = defineString('CJS_PARAM');",
    ].join('\n');
    const namespaced = [
      "const params = require('firebase-functions/params');",
      "exports.A = params.defineSecret('CJS_SECRET');",
    ].join('\n');

    expect(declaredParamNames(destructured).params).toEqual(['CJS_PARAM']);
    expect(declaredParamNames(namespaced).secrets).toEqual(['CJS_SECRET']);
  });

  // Codex P2 on PR #730: a file-wide name lookup cannot see that an inner scope
  // rebound the name, so a shadowed call read as a param and aborted every run.
  it('ignores a call whose name is shadowed in an inner scope', () => {
    const shadowing = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(defineString) {',
      "  return defineString('LOCAL_NOT_A_PARAM');",
      '}',
    ].join('\n');

    expect(declaredParamNames(shadowing).params).toEqual(['REAL_PARAM']);
  });

  // Codex P2 on PR #730, and the exact counterpart of the earlier finding that a
  // params.ts-only scan misses too much: presence on disk is not reachability,
  // and Firebase discovery runs the entrypoint's import graph.
  it('ignores a module nothing imports', () => {
    const reachable = functionsSources(ENTRYPOINT).map(({ label }) => label);

    expect(reachable).toEqual(expect.arrayContaining([expect.stringMatching(/params\.ts$/)]));
    // The .d.cts declaration file is on disk beside a module that IS reachable,
    // and is itself imported by nothing.
    expect(reachable).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/bugReportContract\.d\.cts$/)]),
    );
  });

  it('separates secrets from plain params', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);

    expect(secrets).toEqual(['RESEND_API_KEY']);
    expect(params).not.toContain('RESEND_API_KEY');
  });

  it('keeps every value hermetic, so no e2e run can address a live host', () => {
    const { env } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);

    expect(env).toContain(
      `EMAIL_UNSUBSCRIBE_URL=http://127.0.0.1:${FUNCTIONS_EMULATOR_PORT}/${PROJECT_ID}/us-central1/emailUnsubscribe`,
    );
    expect(env).not.toMatch(/=https:\/\//);
    expect(env).not.toContain('gaycruisebingo.com');
  });

  it('addresses the unsubscribe endpoint on the port firebase.json emulates', () => {
    const firebaseJson = JSON.parse(read('../firebase.json'));

    expect(firebaseJson.emulators.functions.port).toBe(FUNCTIONS_EMULATOR_PORT);
  });

  it('reports the missing keys in a stale file a developer already had', () => {
    const stale = 'EMAIL_FROM=Gay Cruise Bingo <e2e@example.invalid>\nAPP_BASE_URL=http://127.0.0.1:4173\n';

    expect(unassignedNames(parseDotenv(stale, 'stale'), declaredParamNames(PARAMS_SOURCE).params)).toContain(
      'EMAIL_UNSUBSCRIBE_URL',
    );
  });

  // Codex P2 on PR #730: this check aborts someone else's run, so it must not
  // be stricter than the parser it is standing in for.
  it('accepts every assignment form the emulator itself accepts', () => {
    const emulatorLegal = 'export EMAIL_FROM=a\nEMAIL_REPLY_TO = b\n  APP_BASE_URL=c\n';

    expect(parse(emulatorLegal).envs).toEqual({
      EMAIL_FROM: 'a',
      EMAIL_REPLY_TO: 'b',
      APP_BASE_URL: 'c',
    });
    expect(unassignedNames(parseDotenv(emulatorLegal, 'legal'), ['EMAIL_FROM', 'EMAIL_REPLY_TO', 'APP_BASE_URL'])).toEqual(
      [],
    );
  });

  it('does not count a commented-out key as assigned', () => {
    expect(unassignedNames(parseDotenv('# EMAIL_FROM=a\n', 'commented'), ['EMAIL_FROM'])).toEqual(['EMAIL_FROM']);
  });

  // Codex P2 on PR #730, and the direction that actually hurts: a false ACCEPT
  // ends in the hang, where a false reject is only an annoying abort. A `KEY=`
  // inside a multiline quoted value is not an assignment to the parser.
  it('does not count a key that only appears inside another value', () => {
    const decoy = 'OTHER="first\nEMAIL_FROM=not-a-key\nlast"\n';

    expect(Object.keys(parse(decoy).envs)).toEqual(['OTHER']);
    expect(unassignedNames(parseDotenv(decoy, 'decoy'), ['EMAIL_FROM'])).toEqual(['EMAIL_FROM']);
  });
});

// Codex P2 on PR #730. `resolveSecretEnvs` filters with `!secretEnvs[s.key]`,
// so an empty value is not a value: the emulator reaches for the real Secret
// Manager, and a run that is supposed to be self-contained needs credentials.
describe('secret values the emulator can actually use', () => {
  it('treats a present-but-empty secret as missing', () => {
    expect(unusableSecretNames(parseDotenv('RESEND_API_KEY=\n', 'secret'), ['RESEND_API_KEY'])).toEqual([
      'RESEND_API_KEY',
    ]);
    expect(unusableSecretNames(parseDotenv('RESEND_API_KEY=""\n', 'secret'), ['RESEND_API_KEY'])).toEqual([
      'RESEND_API_KEY',
    ]);
  });

  it('accepts the generated secret file', () => {
    const { secrets } = declaredParamNames(PARAMS_SOURCE);
    const { secret } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);

    expect(unusableSecretNames(parseDotenv(secret, 'secret'), secrets)).toEqual([]);
  });

  // Codex P2 on PR #730. `resolveSecretEnvs` calls parseStrict, so one bad line
  // discards the WHOLE file rather than just that line — and the FirebaseError
  // it raises has no `code`, so the emulator's own catch does not even log it.
  // The lenient parse would have returned the good key and hidden all of that.
  it('rejects a secret file the emulator would discard entirely', () => {
    const oneBadLine = 'RESEND_API_KEY=real-value\nthis is not a valid line\n';

    expect(parse(oneBadLine).envs).toEqual({ RESEND_API_KEY: 'real-value' });
    expect(parse(oneBadLine).errors).toHaveLength(1);
    expect(() => parseDotenv(oneBadLine, 'functions/.secret.local')).toThrow(
      /functions\/\.secret\.local is not a dotenv file/,
    );
  });

  // Codex P2 on PR #730. parseStrict quotes each rejected line verbatim, and a
  // malformed line in .secret.local is by definition a line holding a
  // credential — so the message must locate the problem without repeating it.
  it('never echoes the contents of a malformed secret line', () => {
    const fumbledEquals = 'RESEND_API_KEY sk_live_do_not_leak_me\n';

    let message = '';
    try {
      parseDotenv(fumbledEquals, 'functions/.secret.local');
    } catch (error) {
      message = error.message;
    }

    expect(message).not.toContain('sk_live_do_not_leak_me');
    expect(message).toContain('functions/.secret.local');
    expect(message).toContain('line 1');
    // The parser's own message is what would have leaked it.
    expect(() => parseStrict(fumbledEquals)).toThrow(/sk_live_do_not_leak_me/);
  });

  it('still allows an empty PARAM value, which is a legitimate default', () => {
    expect(unassignedNames(parseDotenv('EMAIL_REPLY_TO=\n', 'empty'), ['EMAIL_REPLY_TO'])).toEqual([]);
  });
});

// Codex P2 on PR #730. firebase-tools' own writer escapes only what its parser
// unescapes, which still round-trips lossily through its reader for an unquoted
// `#` or untrimmed value — silently, and invisibly to a test that only counts
// assignment lines.
describe('dotenv value round trip', () => {
  it('reads back every generated value exactly as configured', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);
    const { env, secret } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);
    const values = e2eParamValues(PROJECT_ID);

    for (const name of params) {
      expect(parse(env).envs[name]).toBe(values[name]);
    }
    for (const name of secrets) {
      expect(parse(secret).envs[name]).toBe(E2E_SECRET_VALUES[name]);
    }
  });

  it('survives values that would otherwise be truncated or trimmed', () => {
    const hostile = ['QA #1', 'a\nb', ' padded ', 'quote"and\'apostrophe', 'back\\slash', ''];

    for (const value of hostile) {
      expect(parse(formatAssignment('SOME_PARAM', value)).envs.SOME_PARAM).toBe(value);
    }
  });

  it('leaves an ordinary value unquoted, so the file stays readable', () => {
    expect(formatAssignment('APP_BASE_URL', 'http://127.0.0.1:4173')).toBe(
      'APP_BASE_URL=http://127.0.0.1:4173',
    );
  });
});

// Codex P2 on PR #730. firebase-tools layers `.env`, `.env.<projectId>` and
// `.env.local`, so judging coverage from the overlay alone would abort a run the
// emulator would have served. Asserted against its real loader rather than
// against the file list this module believes in.
// firebase-tools rejects a non-uppercase dotenv key, so the per-layer marker
// has to be uppercased before it can be written.
const layerKey = (file) => `FROM${file.replace(/[.-]/g, '_').toUpperCase()}`;

describe('dotenv layering the emulator merges', () => {
  it('names the same files firebase-tools loads for an emulator run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-dotenv-'));
    for (const file of emulatorDotenvFiles(PROJECT_ID)) {
      writeFileSync(join(dir, file), `${layerKey(file)}=1\n`);
    }

    // `projectDir` is only used to render the "Loaded environment variables
    // from ..." log line relative to the project root, but firebase-tools 15.27
    // made it load-bearing: it passes the value straight to `path.relative`,
    // which throws on `undefined`. It was optional through 15.26, so the call
    // predates the requirement. `dir` is both roots here — the temp dir IS the
    // functions source — which keeps the logged paths bare filenames.
    const loaded = loadUserEnvs({
      functionsSource: dir,
      projectDir: dir,
      projectId: PROJECT_ID,
      isEmulator: true,
    });

    // Every file this module merges is one the emulator actually reads...
    expect(Object.keys(loaded).sort()).toEqual(
      emulatorDotenvFiles(PROJECT_ID).map(layerKey).sort(),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a param set split across the layers', () => {
    const { params } = declaredParamNames(PARAMS_SOURCE);
    const [first, ...rest] = params;
    const shared = `${first}=shared\n`;
    const overlay = rest.map((name) => `${name}=overlay\n`).join('');

    // The overlay alone is incomplete — the old check aborted here...
    expect(unassignedNames(parseDotenv(overlay, 'overlay'), params)).toEqual([first]);
    // ...but the merged view the emulator resolves against is not.
    expect(unassignedNames({ ...parseDotenv(shared, 'shared'), ...parseDotenv(overlay, 'overlay') }, params)).toEqual([]);
  });
});

// The deploy-side twin of the same failure. `firebase deploy` resolves the same
// params, so a param missing from the committed template stops a non-interactive
// deploy at parameter resolution — the reason functions/.env.example declares
// BUG_REPORT_APP_CHECK explicitly rather than leaning on its default (#158).
describe('functions/.env.example', () => {
  // Codex P2 on PR #730: derived from the DISCOVERED set, not from params.ts.
  // A param declared beside a reachable handler is one the extractor now
  // supports, and deriving the expectation from params.ts alone would let this
  // guard stay green while a non-interactive deploy stopped to prompt for it.
  it('declares every discovered param, so a non-interactive deploy never stops to prompt', () => {
    const template = read('../functions/.env.example');

    expect(unassignedNames(parseDotenv(template, 'functions/.env.example'), DISCOVERED.params)).toEqual(
      [],
    );
  });

  it('keeps RESEND_API_KEY out, since a secret is not a dotenv value', () => {
    expect(read('../functions/.env.example')).not.toMatch(/^\s*RESEND_API_KEY=/m);
  });
});
