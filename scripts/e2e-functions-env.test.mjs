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

  // #738 (Phase 4b post-review on PR #730): the destructured CJS form above
  // is not the only way to bind a constructor off a `require` call — a
  // direct property access (`require(...).defineString`) is a distinct AST
  // shape (the require call is the property access's EXPRESSION, not the
  // declaration's own initializer) that the destructured-only check missed.
  it('resolves a constructor bound by a direct require property access', () => {
    const propertyAccess = [
      "const defineString = require('firebase-functions/params').defineString;",
      "exports.A = defineString('CJS_PROPERTY_PARAM');",
    ].join('\n');

    expect(declaredParamNames(propertyAccess).params).toEqual(['CJS_PROPERTY_PARAM']);
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

  // #741 (Phase 4b post-review on PR #730): the earlier shadowing check only
  // recognized a plain-identifier parameter or a top-level plain-identifier
  // `var`/`let`/`const` — a destructured parameter, a catch binding, a named
  // function expression's own name, and a `var` hoisted out of a NESTED
  // statement (not a direct ancestor of the call) all rebind the name too,
  // and were previously invisible to it.
  it('ignores a call shadowed by a destructured parameter', () => {
    const destructuredParam = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper({ defineString }) {',
      "  return defineString('LOCAL_NOT_A_PARAM');",
      '}',
    ].join('\n');

    expect(declaredParamNames(destructuredParam).params).toEqual(['REAL_PARAM']);
  });

  it('ignores a call shadowed by a catch binding', () => {
    const catchBound = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper() {',
      '  try {',
      '    risky();',
      '  } catch (defineString) {',
      "    return defineString('LOCAL_NOT_A_PARAM');",
      '  }',
      '}',
    ].join('\n');

    expect(declaredParamNames(catchBound).params).toEqual(['REAL_PARAM']);
  });

  it("ignores a call shadowed by a named function expression's own name", () => {
    const namedFnExpression = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export const helper = function defineString() {',
      "  return defineString('LOCAL_NOT_A_PARAM');",
      '};',
    ].join('\n');

    expect(declaredParamNames(namedFnExpression).params).toEqual(['REAL_PARAM']);
  });

  it('ignores a call shadowed by a var hoisted out of a sibling nested block', () => {
    // `var` is function-scoped, so a call textually BEFORE and OUTSIDE the
    // `if` block that declares it is still shadowed, by hoisting — the
    // straight ancestor-chain walk alone cannot see this.
    const hoistedFromSibling = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(flag) {',
      "  const early = defineString('LOCAL_NOT_A_PARAM');",
      '  if (flag) {',
      '    var defineString = (name) => name;',
      '  }',
      '  return early;',
      '}',
    ].join('\n');

    expect(declaredParamNames(hoistedFromSibling).params).toEqual(['REAL_PARAM']);
  });

  // #830 (Phase 4b post-review on PR #826): `using`/`await using`
  // declarations (TS 5.2+ explicit resource management) are block-scoped
  // exactly like `let`/`const`, but `isHoistedDeclarationList` checked only
  // for the ABSENCE of `Let`/`Const` — so a `using` inside a sibling block
  // was collected as a function-hoisted `var`, creating a false shadow over
  // a call outside that block and dropping a real param, the mirror image
  // of the `var` case proven above. `ts.NodeFlags.BlockScoped` is
  // TypeScript's own union of every block-scoped flag, `using`/`await
  // using` included, so this call keeps resolving to the real import.
  it('does not treat a using declaration in a sibling block as hoisted', () => {
    const usingInSibling = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(flag) {',
      "  const early = defineString('SHOULD_STILL_RESOLVE');",
      '  if (flag) {',
      '    using defineString = getResource();',
      '  }',
      '  return early;',
      '}',
    ].join('\n');

    expect(declaredParamNames(usingInSibling).params).toEqual(['REAL_PARAM', 'SHOULD_STILL_RESOLVE']);
  });

  // Codex P2 on PR #826: a class/object-literal METHOD or accessor's own
  // name is a property name, not a local binding inside its body — unlike a
  // named FUNCTION EXPRESSION, calling the bare identifier from inside a
  // same-named method does NOT call the method itself, it still resolves to
  // the outer import. `ts.isFunctionLike` matches methods too, and the first
  // version of this fix treated a method's own name exactly like a function
  // expression's, falsely marking the call shadowed and dropping a real
  // param.
  it('does not treat a method or accessor name as self-shadowing its own body', () => {
    const methodNamedLikeConstructor = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export const schema = {',
      '  defineString() {',
      "    return defineString('REAL_PARAM_VIA_METHOD');",
      '  },',
      '};',
    ].join('\n');

    expect(declaredParamNames(methodNamedLikeConstructor).params).toEqual([
      'REAL_PARAM',
      'REAL_PARAM_VIA_METHOD',
    ]);
  });

  // Codex P2 round 2 on PR #826: a class STATIC BLOCK is its own
  // var-hoisting scope boundary, distinct from an ordinary block — `var`
  // inside `static { … }` is scoped to the block itself, not hoisted out to
  // whatever function contains the class.
  it('does not hoist a var out of a class static block into the enclosing function', () => {
    const staticBlockVar = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper() {',
      "  const early = defineString('LOCAL_PARAM_NOT_SHADOWED');",
      '  class Box {',
      '    static {',
      '      var defineString = (name) => name;',
      '    }',
      '  }',
      '  return early;',
      '}',
    ].join('\n');

    expect(declaredParamNames(staticBlockVar).params).toEqual(['REAL_PARAM', 'LOCAL_PARAM_NOT_SHADOWED']);
  });

  // Codex P2 round 3 on PR #826, against the test above's ORIGINAL version:
  // Annex B block-function hoisting is sloppy-mode-only, and every source in
  // this file is written as ESM (`import`/`export`), which makes it a
  // MODULE — always strict, regardless of the `strict` compiler option.
  // Collecting the nested declaration's name here created a FALSE shadow: in
  // a real module, the earlier call still reaches the outer import, and
  // `.ts` sources under `functions/src/**` — what this scanner actually
  // reads — are ESM throughout, so this was not a hypothetical.
  it('does not let a block-nested function declaration hoist in a module', () => {
    const nestedFunctionDeclarationInModule = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(flag) {',
      "  const early = defineString('MODULE_PARAM_STILL_REAL');",
      '  if (flag) {',
      '    function defineString() { return null; }',
      '  }',
      '  return early;',
      '}',
    ].join('\n');

    expect(declaredParamNames(nestedFunctionDeclarationInModule).params).toEqual([
      'REAL_PARAM',
      'MODULE_PARAM_STILL_REAL',
    ]);
  });

  // The counterpart proving Annex B hoisting still applies where it
  // genuinely can: a real CommonJS SCRIPT with no `import`/`export` syntax
  // anywhere (`ts.isExternalModule` false). Also the regression guard for
  // the bug this whole fix chases: `ts.isFunctionLike` also matches
  // `FunctionDeclaration`, so an early version of the round-2 fix's early
  // return made the branch that records a function declaration's OWN name
  // unreachable dead code, dropping the hoisting for one declared two or
  // more levels deep (inside an `if`/`for` nested in the body, not directly
  // in the function's own top-level block, which `scopeDeclares`'s
  // per-block scan already catches on its own).
  it('still hoists a function declaration nested two levels deep in a genuine CommonJS script', () => {
    const nestedFunctionDeclarationInScript = [
      "const { defineString } = require('firebase-functions/params');",
      'function helper(flag) {',
      "  const early = defineString('CJS_LOCAL_NOT_A_PARAM');",
      '  if (flag) {',
      '    function defineString() { return null; }',
      '  }',
      '  return early;',
      '}',
      "exports.A = defineString('CJS_REAL_PARAM');",
      'exports.B = helper;',
    ].join('\n');

    expect(declaredParamNames(nestedFunctionDeclarationInScript).params).toEqual(['CJS_REAL_PARAM']);
  });

  // Codex P2 round 4 on PR #826: a `.cjs` file has no import/export syntax
  // (so `ts.isExternalModule` is false), but a leading `'use strict';`
  // directive disables Annex B hoisting there too — the same as a module.
  it('does not hoist a block-nested function declaration in a script with its own "use strict" directive', () => {
    const nestedFunctionDeclarationInStrictScript = [
      "'use strict';",
      "const { defineString } = require('firebase-functions/params');",
      'function helper(flag) {',
      "  const early = defineString('STRICT_CJS_PARAM_STILL_REAL');",
      '  if (flag) {',
      '    function defineString() { return null; }',
      '  }',
      '  return early;',
      '}',
      "exports.A = defineString('CJS_REAL_PARAM');",
      'exports.B = helper;',
    ].join('\n');

    expect(declaredParamNames(nestedFunctionDeclarationInStrictScript).params).toEqual([
      'STRICT_CJS_PARAM_STILL_REAL',
      'CJS_REAL_PARAM',
    ]);
  });

  // Codex P2 round 2 on PR #826: a call inside a PARAMETER's own default-
  // value initializer runs in a separate parameter scope that cannot see
  // the function BODY's `var`/function-declaration bindings — only a call
  // actually inside the body can be hoisting-shadowed by one.
  it('does not let a body var shadow a call in a parameter default initializer', () => {
    const paramDefaultNotShadowed = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      "export function helper(value = defineString('PARAM_IN_DEFAULT')) {",
      '  var defineString = (name) => name;',
      '  return value;',
      '}',
    ].join('\n');

    expect(declaredParamNames(paramDefaultNotShadowed).params).toEqual(['REAL_PARAM', 'PARAM_IN_DEFAULT']);
  });

  // Codex P2 round 5 on PR #826: a `let`/`const` FOR-loop initializer is its
  // own lexical scope, distinct from the loop body's Block, and was never
  // checked.
  it('ignores a call shadowed by a for-loop initializer', () => {
    const forLoopInitializerShadow = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(items) {',
      "  for (let defineString = (name) => name; items.length; items.pop()) {",
      "    defineString('LOCAL_NOT_A_PARAM');",
      '  }',
      '}',
    ].join('\n');

    expect(declaredParamNames(forLoopInitializerShadow).params).toEqual(['REAL_PARAM']);
  });

  // The `for…of`/`for…in` counterpart — the bound name lives directly on the
  // statement, not wrapped in a `VariableDeclarationList.declarations` array
  // of more than one, but is still the same lexical-scope shape.
  it('ignores a call shadowed by a for-of loop binding', () => {
    const forOfShadow = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(items) {',
      '  for (const defineString of items) {',
      "    defineString('LOCAL_NOT_A_PARAM');",
      '  }',
      '}',
    ].join('\n');

    expect(declaredParamNames(forOfShadow).params).toEqual(['REAL_PARAM']);
  });

  // Codex P2 round 5 on PR #826: every clause of a `switch` shares ONE
  // lexical scope — the same reason redeclaring a name across two case
  // labels without braces is an error — so a binding introduced under one
  // case label shadows a call under a DIFFERENT case label too.
  it('ignores a call shadowed by a binding declared under a different switch case', () => {
    const switchCaseShadow = [
      IMPORT,
      "export const REAL = defineString('REAL_PARAM');",
      'export function helper(mode) {',
      '  switch (mode) {',
      "    case 'a':",
      '      let defineString = (name) => name;',
      '      break;',
      "    case 'b':",
      "      defineString('LOCAL_NOT_A_PARAM');",
      '      break;',
      '  }',
      '}',
    ].join('\n');

    expect(declaredParamNames(switchCaseShadow).params).toEqual(['REAL_PARAM']);
  });

  // Codex P2 round 5 on PR #826: `isParamsRequire` (the CJS destructured and
  // property-access binding checks) looked only at the call's spelling, so a
  // locally shadowed `require` was still accepted as Node's loader.
  it('does not treat a require call through a locally shadowed require as a params binding', () => {
    const shadowedRequireBinding = [
      'function localLoader(name) { return { defineString: () => "not-a-param" }; }',
      'function helper() {',
      '  const require = localLoader;',
      "  const defineString = require('firebase-functions/params').defineString;",
      "  return defineString('NOT_A_FIREBASE_PARAM');",
      '}',
      'exports.A = helper;',
    ].join('\n');

    expect(() => declaredParamNames(shadowedRequireBinding)).toThrow(/CONSTRUCTOR_RE/);
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

// #738/#739/#740 (Phase 4b post-review on PR #730): the reachable-tree walk
// (`functionsSources`/`relativeDependencies`) and the barrel-resolution half
// of `constructorBindings` both need REAL files on disk — they resolve
// relative specifiers with `resolveRelative`, which is an `existsSync` check
// — so these live in their own on-disk fixture tree, mirroring the
// `dotenv layering` describe block's pattern below.
describe('functions source-tree reachability and barrel resolution', () => {
  const makeTree = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-functions-sources-'));
    for (const [relativePath, contents] of Object.entries(files)) {
      writeFileSync(join(dir, relativePath), contents);
    }
    return dir;
  };

  // #738: a params constructor reached through a LOCAL re-export barrel —
  // `import { defineString } from './barrel'`, where `./barrel` re-exports
  // it from `firebase-functions/params` — is bound by provenance through the
  // barrel, not just a direct import from the params module itself.
  it('resolves a constructor reached through a local re-export barrel', () => {
    const dir = makeTree({
      'barrel.ts': "export { defineString } from 'firebase-functions/params';\n",
      'index.ts': ["import { defineString } from './barrel';", "defineString('BARRELED_PARAM');"].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['BARRELED_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // #738: the same, through TWO barrels, aliasing at each hop — proves the
  // resolution is recursive, not a single fixed lookup, and that a rename
  // along the chain is followed rather than losing the binding.
  it('resolves a constructor reached through a chain of re-export barrels', () => {
    const dir = makeTree({
      'inner-barrel.ts': "export { defineString as innerString } from 'firebase-functions/params';\n",
      'outer-barrel.ts': "export { innerString as outerString } from './inner-barrel';\n",
      'index.ts': [
        "import { outerString } from './outer-barrel';",
        "outerString('CHAINED_BARREL_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['CHAINED_BARREL_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 3 on PR #826: `export * from 'firebase-functions/params'`
  // has no `exportClause` at all (unlike a named re-export), so it reached
  // the direct-module branch and recorded nothing — there is no static list
  // of the params module's own exports to pre-populate. A wildcard
  // re-export forwards EVERY constructor unchanged, so a consumer naming one
  // through it has to resolve against CONSTRUCTOR_RE directly instead.
  it('resolves a constructor reached through a wildcard (export *) barrel', () => {
    const dir = makeTree({
      'barrel.ts': "export * from 'firebase-functions/params';\n",
      'index.ts': [
        "import { defineString } from './barrel';",
        "defineString('WILDCARD_BARREL_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['WILDCARD_BARREL_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // The wildcard marker has to propagate through a CHAIN of `export *`
  // barrels too, not just a direct one hop from the params module.
  it('resolves a constructor reached through a chain of wildcard barrels', () => {
    const dir = makeTree({
      'inner-barrel.ts': "export * from 'firebase-functions/params';\n",
      'outer-barrel.ts': "export * from './inner-barrel';\n",
      'index.ts': [
        "import { defineSecret } from './outer-barrel';",
        "defineSecret('WILDCARD_CHAIN_SECRET');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.secrets).toEqual(['WILDCARD_CHAIN_SECRET']);

    rmSync(dir, { recursive: true, force: true });
  });

  // #832 (Phase 4b post-review on PR #826): the local-barrel handling above
  // only recognized a NAMED import (`import { defineString } from
  // './barrel'`) — `import * as params from './barrel'`, where `./barrel`
  // re-exports from `firebase-functions/params`, was never added to
  // `namespaces` at all, so `params.defineSecret(...)` reached through such
  // a barrel was silently missed entirely: no env value would ever be
  // generated for it, and the emulator would go looking for the live Secret
  // Manager secret instead of staying self-contained.
  it('resolves a constructor reached through a namespace import of a local barrel', () => {
    const dir = makeTree({
      'barrel.ts': "export { defineSecret } from 'firebase-functions/params';\n",
      'index.ts': [
        "import * as params from './barrel';",
        "params.defineSecret('BARRELED_NAMESPACE_SECRET');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.secrets).toEqual(['BARRELED_NAMESPACE_SECRET']);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex + CodeRabbit, independently, on the first version of the test
  // above (PR #834): a valid barrel can re-export ONE params constructor and
  // separately export its OWN unrelated, constructor-shaped local helper —
  // `defineSecret` from the params module alongside a local `defineString`
  // that has nothing to do with Firebase. Treating the whole namespace as
  // trusted (accepting ANY `defineX`-shaped property, the way a direct
  // `firebase-functions/params` namespace import legitimately can) would
  // misclassify `params.defineString(...)` as a real param declaration. The
  // namespace has to resolve each property against what the barrel actually
  // re-exports, not against the property's name alone.
  it('does not treat an unrelated same-shaped local export as a namespace params constructor', () => {
    const dir = makeTree({
      'barrel.ts': [
        "export { defineSecret } from 'firebase-functions/params';",
        "export function defineString() { return 'not a Firebase param'; }",
      ].join('\n'),
      'index.ts': [
        "import * as params from './barrel';",
        "params.defineSecret('BARRELED_ONLY_SECRET');",
        "params.defineString('NOT_A_REAL_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.secrets).toEqual(['BARRELED_ONLY_SECRET']);
    expect(declared.params).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 4 on PR #826: the "import, then separately export" form
  // — `import { defineString } from 'firebase-functions/params'; export {
  // defineString };` — has no `moduleSpecifier` on its export declaration at
  // all, unlike `export { defineString } from '...'`, and was skipped
  // entirely.
  it('resolves a constructor reached through an import-then-export barrel', () => {
    const dir = makeTree({
      'barrel.ts': [
        "import { defineString } from 'firebase-functions/params';",
        'export { defineString };',
      ].join('\n'),
      'index.ts': [
        "import { defineString } from './barrel';",
        "defineString('IMPORT_THEN_EXPORT_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['IMPORT_THEN_EXPORT_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 5 on PR #826: the round-4 fix for "import, then export"
  // only resolved an import DIRECTLY from the params module — a chained
  // form, where the barrel imports from a RELATIVE re-export of its own
  // before bare-exporting it, fell through unhandled.
  it('resolves a constructor reached through an import-then-export barrel chained via a relative import', () => {
    const dir = makeTree({
      'inner.ts': "export { defineString } from 'firebase-functions/params';\n",
      'middle.ts': [
        "import { defineString } from './inner';",
        'export { defineString };',
      ].join('\n'),
      'index.ts': [
        "import { defineString } from './middle';",
        "defineString('CHAINED_IMPORT_THEN_EXPORT_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['CHAINED_IMPORT_THEN_EXPORT_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 on PR #826: two SIBLING barrels that both re-export from the
  // SAME shared upstream module are two separate, non-cyclic paths, not a
  // cycle — the first version of the cycle guard shared one `visited` set
  // across the whole traversal, so the first sibling's resolution left the
  // shared module permanently "visited" and the second sibling's own,
  // unrelated re-export silently resolved to nothing.
  it('resolves constructors reached through sibling barrels sharing an upstream module', () => {
    const dir = makeTree({
      'shared.ts': [
        "export { defineString } from 'firebase-functions/params';",
        "export { defineSecret } from 'firebase-functions/params';",
      ].join('\n'),
      'string-barrel.ts': "export { defineString } from './shared';\n",
      'secret-barrel.ts': "export { defineSecret } from './shared';\n",
      'index.ts': [
        "import { defineString } from './string-barrel';",
        "import { defineSecret } from './secret-barrel';",
        "defineString('DIAMOND_STRING_PARAM');",
        "defineSecret('DIAMOND_SECRET_PARAM');",
      ].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['DIAMOND_STRING_PARAM']);
    expect(declared.secrets).toEqual(['DIAMOND_SECRET_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 on PR #826: `require` is an ordinary identifier a reachable
  // module can rebind locally (a param NAME, a test helper — anything), not
  // a keyword. A call through that local binding is not a module specifier
  // at all, and — now that a non-literal argument fails closed (#740) —
  // wrongly treating it as one would abort validation over unrelated
  // application code instead of just missing a dependency.
  it('does not fail closed on a non-literal call through a locally shadowed require', () => {
    const dir = makeTree({
      'index.ts': [
        'function helper(require) {',
        '  return require(computeSomethingUnrelated());',
        '}',
        'export { helper };',
      ].join('\n'),
    });

    expect(() => functionsSources(join(dir, 'index.ts'))).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 2 on PR #826: a top-level `const require = …;` shadows
  // Node's global for the whole module. Unlike a param constructor, `require`
  // is not necessarily imported, so `isShadowed`'s own file-top-exclusive
  // walk (safe for a constructor name, which IS always imported) is not
  // enough on its own here — the file-top itself has to be checked too.
  it('does not fail closed on a non-literal call through a require shadowed at the file top', () => {
    const dir = makeTree({
      'index.ts': ['const require = (name) => name;', 'require(computeSomethingUnrelated());'].join('\n'),
    });

    expect(() => functionsSources(join(dir, 'index.ts'))).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 3 on PR #826: the file-top shadow check only looked at
  // function/class/variable declarations — an IMPORTED `require` (default,
  // named-possibly-aliased, or namespace) is just as real a local binding,
  // and was missed.
  it('does not fail closed on a non-literal call through a require shadowed by an import', () => {
    const dir = makeTree({
      'loader.ts': 'export default function loader(name) { return name; }\n',
      'index.ts': [
        "import require from './loader';",
        'require(computeSomethingUnrelated());',
      ].join('\n'),
    });

    expect(() => functionsSources(join(dir, 'index.ts'))).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 4 on PR #826: `var` hoists to the module/script top the
  // same way it hoists to a function — including from inside a nested `if`
  // at the file's own top level, not just a direct top-level statement.
  it('does not fail closed on a non-literal call through a require shadowed by a var nested at the file top', () => {
    const dir = makeTree({
      'index.ts': [
        'if (typeof globalThis.flag !== "undefined") {',
        '  var require = (name) => name;',
        '}',
        'require(computeSomethingUnrelated());',
      ].join('\n'),
    });

    expect(() => functionsSources(join(dir, 'index.ts'))).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  // Codex P2 round 2 on PR #826: a genuine cycle where BOTH sides re-export
  // through MULTIPLE statements each used to overflow the call stack — an
  // earlier fix for the sibling-barrel case (round 1) deleted a resolved
  // path from the shared `visited` set in the CALLER, right after each
  // statement, which could remove an entry a DIFFERENT sibling statement —
  // still active higher up the same call stack — still depended on being
  // marked, letting it re-enter and recurse without bound. `a` and `b` here
  // cycle back and forth on their SECOND statement each, while their FIRST
  // statement is the one that actually reaches the real params module
  // through `c` — proving the cycle both terminates and does not corrupt the
  // real resolution alongside it.
  it('resolves through a cycle where both sides have multiple re-export statements, without overflowing the stack', () => {
    const dir = makeTree({
      'c.ts': "export { defineString } from 'firebase-functions/params';\n",
      'a.ts': ["export { defineString } from './b';", "export { defineInt } from './b';"].join('\n'),
      'b.ts': ["export { defineString } from './c';", "export { defineFloat } from './a';"].join('\n'),
      'index.ts': ["import { defineString } from './a';", "defineString('CYCLE_PARAM');"].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['CYCLE_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // #739: `import type` is erased entirely at compile time — Firebase never
  // executes the module it names, so a param declared there is never
  // registered. The old walk followed it anyway and could abort a run
  // demanding a value for a param the emulator will never ask for.
  it('does not follow a type-only import into a module Firebase never loads', () => {
    const dir = makeTree({
      'types-only.ts': [IMPORT, "export const NEVER_LOADED = defineString('NEVER_LOADED_PARAM');"].join('\n'),
      'index.ts': ["import type { Foo } from './types-only';", 'export type { Foo };'].join('\n'),
    });

    const reachable = functionsSources(join(dir, 'index.ts')).map(({ label }) => label);
    expect(reachable).not.toEqual(expect.arrayContaining([expect.stringMatching(/types-only\.ts$/)]));

    rmSync(dir, { recursive: true, force: true });
  });

  // #739, the mixed-specifier case: `import { type X, y }` still loads the
  // module for the runtime binding `y`, so the whole specifier must NOT be
  // dropped just because ONE named binding in it is type-only.
  it('still follows an import that mixes a type-only and a runtime binding', () => {
    const dir = makeTree({
      'mixed.ts': [
        'export const answer = 42;',
        'export type Foo = string;',
      ].join('\n'),
      'index.ts': ["import { type Foo, answer } from './mixed';", 'export type { Foo }; export { answer };'].join(
        '\n',
      ),
    });

    const reachable = functionsSources(join(dir, 'index.ts')).map(({ label }) => label);
    expect(reachable).toEqual(expect.arrayContaining([expect.stringMatching(/mixed\.ts$/)]));

    rmSync(dir, { recursive: true, force: true });
  });

  // #740: `import x = require('./x')` is TypeScript's pre-ESM syntax for a
  // runtime require — not expressible as an `ImportDeclaration` at all — and
  // was invisible to the walk entirely, a false NEGATIVE (a missed
  // dependency) rather than #739's false positive.
  it('follows a TypeScript import-equals require', () => {
    const dir = makeTree({
      'legacy.ts': [IMPORT, "export const A = defineString('IMPORT_EQUALS_PARAM');"].join('\n'),
      'index.ts': "import legacy = require('./legacy');\nexport { legacy };\n",
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['IMPORT_EQUALS_PARAM']);

    rmSync(dir, { recursive: true, force: true });
  });

  // #740: a `require`/`import()` specifier this scanner cannot read
  // statically (not a string, not a no-substitution template literal) used
  // to be silently dropped — the exact "indistinguishable from not existing"
  // failure mode `scanSource`'s unresolvable-name guard already refuses for
  // param NAMES. A dependency specifier gets the same fail-closed treatment.
  it('fails closed on a require specifier it cannot resolve statically, rather than skipping it', () => {
    const dir = makeTree({
      'index.ts': ['const moduleName = computeModuleName();', "require(moduleName);"].join('\n'),
    });

    expect(() => functionsSources(join(dir, 'index.ts'))).toThrow(/cannot resolve statically/);

    rmSync(dir, { recursive: true, force: true });
  });

  // A no-substitution template literal is exactly as static as a plain
  // string, and is accepted the same way `literalNameOf` already accepts one
  // for a param name.
  it('accepts a no-substitution template literal require specifier as static', () => {
    const dir = makeTree({
      'legacy.ts': [IMPORT, "export const A = defineString('TEMPLATE_LITERAL_PARAM');"].join('\n'),
      'index.ts': ['require(`./legacy`);'].join('\n'),
    });

    const declared = declaredParamNamesAcross(functionsSources(join(dir, 'index.ts')));
    expect(declared.params).toEqual(['TEMPLATE_LITERAL_PARAM']);

    rmSync(dir, { recursive: true, force: true });
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

  // #742 (Phase 4b post-review on PR #730): `parseStrict` fails a
  // syntactically fine but semantically invalid key (lowercase, or a name
  // Firebase reserves) with ZERO entries in `parse(body).errors` — that array
  // only ever holds SYNTAX errors, and this is a KEY-validation error, a
  // different failure inside `parseStrict`. The old message pattern-matched
  // only that array and reported "0 malformed lines", which is true and
  // useless: it names no location and hides that the run failed at all.
  // Verified empirically against the installed firebase-tools: `parse(...)
  // .errors` is genuinely empty for a lowercase key, so this is not a
  // hypothetical.
  it('locates a strict-only key rejection instead of claiming 0 malformed lines', () => {
    const lowercaseKey = 'resend_api_key=sk_live_do_not_leak_me\n';

    expect(parse(lowercaseKey).errors).toEqual([]);

    let message = '';
    try {
      parseDotenv(lowercaseKey, 'functions/.secret.local');
    } catch (error) {
      message = error.message;
    }

    expect(message).not.toContain('0 malformed');
    expect(message).toContain('line 1');
    expect(message).toContain('1 invalid key');
  });

  // Codex P1 on PR #826, on an earlier version of this fix: `LINE_RE` (the
  // parser these files are written for) captures whatever text sits before
  // `=` as the key, with no check that it LOOKS like one — so a reversed
  // assignment in `.secret.local` puts the credential in the KEY position,
  // `validateKey` rejects it (lowercase), and a first version of this fix
  // surfaced `KeyValidationError.message`, which repeats the rejected key
  // verbatim. Neither `.message` nor the key itself may ever appear here.
  it('never echoes a credential that lands in the key position on a reversed assignment', () => {
    const reversedAssignment = 'sk_live_do_not_leak_me=RESEND_API_KEY\n';

    expect(parse(reversedAssignment).errors).toEqual([]);
    // The leak lives in `.children[].message`, not the top-level thrown
    // message (which is just "Validation failed") — confirming this is the
    // real vector a naive `error.children.map(c => c.message).join(...)`
    // would have exposed, and that this test is not a hypothetical.
    try {
      parseStrict(reversedAssignment);
      throw new Error('expected parseStrict to throw');
    } catch (error) {
      expect(error.children.map((child) => child.message).join('; ')).toContain('sk_live_do_not_leak_me');
    }

    let message = '';
    try {
      parseDotenv(reversedAssignment, 'functions/.secret.local');
    } catch (error) {
      message = error.message;
    }

    expect(message).not.toContain('sk_live_do_not_leak_me');
    expect(message).toContain('functions/.secret.local');
    expect(message).toContain('line 1');
  });

  it('locates every line when more than one key fails strict validation', () => {
    const reservedAndLowercase = 'FIREBASE_CONFIG=x\nlowercase_key=y\nGOOD_KEY=z\n';

    let message = '';
    try {
      parseDotenv(reservedAndLowercase, 'functions/.env.local');
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain('(line 1, 2)');
    expect(message).not.toContain(', 3');
    expect(message).toContain('2 invalid keys');
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
