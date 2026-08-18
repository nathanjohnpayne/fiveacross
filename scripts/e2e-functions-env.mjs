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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The TypeScript scanner, used to read declarations out of Functions modules.
// Already a devDependency (`npm run typecheck` runs tsc), so this costs the
// runner nothing it did not already install.
import ts from 'typescript';
// The dotenv reader these files are written for. Imported rather than
// re-implemented because every round of review on PR #730 found the same thing:
// a hand-written approximation of this parser disagrees with it somewhere, and
// disagreeing in the accepting direction is a hang. firebase-tools is a
// devDependency and `npx firebase` runs moments later in the same script, so
// this adds no dependency the runner did not already have.
import { KeyValidationError, parse, parseStrict } from 'firebase-tools/lib/functions/env.js';

/**
 * A firebase-functions/params constructor, by its EXPORTED name.
 *
 * Not an enumeration of the ones in use: firebase-functions 5.1.1 exports
 * defineInt, defineFloat and defineList too, and a listed subset fails in the
 * worst available way — the omitted constructor is skipped, the existing
 * declarations keep the zero-match guard quiet, and every test passes while the
 * new param hangs the emulator (Codex P2 on PR #730; `defineFloat` was in fact
 * missing). Matching the convention means a constructor a future SDK adds is
 * caught with no edit here.
 */
const CONSTRUCTOR_RE = /^define([A-Z][A-Za-z]*)$/;

/** The module whose constructors declare params. */
const PARAMS_MODULE = 'firebase-functions/params';

/**
 * Sentinel key `reExportedParamsBindings` sets on its result Map when a
 * barrel does `export * from 'firebase-functions/params'` (#738, Codex P2
 * round 3 on PR #826): a wildcard re-export forwards EVERY named export
 * from the params module, unchanged, and there is no static list of that
 * package's exports to pre-populate here (unlike a named re-export, which
 * names the constructors it forwards up front). A `Symbol` key can never
 * collide with a real (string) local export name, so its presence is a safe
 * "resolve anything constructor-shaped on request" flag alongside whatever
 * concrete bindings the Map already holds. It propagates automatically
 * through a CHAIN of `export * from './barrel'` re-exports too, since that
 * forwarding path already copies every entry — Symbol keys included — from
 * `upstream` into `result`.
 */
const WILDCARD_PARAMS = Symbol('wildcard-params-reexport');

/**
 * The constructor kind `name` resolves to through a re-export map — a
 * direct hit if the barrel named it explicitly, otherwise (only if the
 * barrel wildcard-re-exported the params module) whatever `CONSTRUCTOR_RE`
 * says about `name` itself.
 */
function resolveFromReExports(upstream, name) {
  const direct = upstream.get(name);
  if (direct) {
    return direct;
  }
  if (upstream.has(WILDCARD_PARAMS)) {
    return CONSTRUCTOR_RE.exec(name)?.[1];
  }
  return undefined;
}

/**
 * Local name → constructor kind, for every params-module constructor a source
 * binds, however it binds it.
 *
 * Resolving the binding is what makes an ALIAS work rather than merely be
 * detected: `defineString as stringParam` now yields calls through
 * `stringParam`, where three earlier attempts could only reject the import and
 * hope nobody needed it (Codex P2 x3 on PR #730). A namespace import resolves
 * through the property access instead, and is handled at the call site.
 *
 * `filePath` is the scanned file's own path, used only to resolve a LOCAL
 * re-export barrel (see `reExportedParamsBindings`) — a synthetic label from
 * a unit test that names no real file simply fails to resolve and this
 * degrades to exactly the prior behavior (#738).
 */
function constructorBindings(sourceFile, filePath) {
  const bindings = new Map();
  const namespaces = new Set();

  const takeNamed = (exported, local) => {
    const kind = CONSTRUCTOR_RE.exec(exported);
    if (kind) {
      bindings.set(local, kind[1]);
    }
  };

  for (const statement of sourceFile.statements) {
    // ESM: import { defineString [as alias] } / import * as params
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const named = statement.importClause?.namedBindings;
      const isTypeOnlyImport = statement.importClause?.isTypeOnly ?? false;
      if (specifier === PARAMS_MODULE && !isTypeOnlyImport) {
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            takeNamed((element.propertyName ?? element.name).text, element.name.text);
          }
        } else if (named && ts.isNamespaceImport(named)) {
          namespaces.add(named.name.text);
        }
      } else if (specifier.startsWith('.') && named && ts.isNamedImports(named) && !isTypeOnlyImport) {
        // Local re-export barrel (#738): `import { defineString } from
        // './barrel'`, where `./barrel` itself does `export { defineString }
        // from 'firebase-functions/params'` — directly, or through a chain of
        // further local barrels. Provenance still traces back to the params
        // module; it is just one (or more) hop away.
        const resolved = resolveRelative(filePath, specifier);
        if (resolved) {
          const upstream = reExportedParamsBindings(resolved);
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            const kind = resolveFromReExports(upstream, (element.propertyName ?? element.name).text);
            if (kind) {
              bindings.set(element.name.text, kind);
            }
          }
        }
      }
      continue;
    }
    // CommonJS: const { defineString } = require('…') / const params = require('…')
    // / const defineString = require('…').defineString.
    // A `.cjs` module in this tree binds its constructors this way, and only this
    // way (Codex P2 on PR #730 — the fixture that motivated scanning `.cjs` was
    // itself written in ESM, so it never exercised the real syntax).
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        continue;
      }
      if (isParamsRequire(declaration.initializer)) {
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            const exported = element.propertyName ?? element.name;
            if (ts.isIdentifier(exported) && ts.isIdentifier(element.name)) {
              takeNamed(exported.text, element.name.text);
            }
          }
        } else if (ts.isIdentifier(declaration.name)) {
          namespaces.add(declaration.name.text);
        }
        continue;
      }
      // const defineString = require('firebase-functions/params').defineString;
      // (#738) — a direct property-access binding, distinct from the
      // destructured form above: the require call is the PROPERTY ACCESS's
      // expression, not the declaration's own initializer.
      if (
        ts.isIdentifier(declaration.name) &&
        ts.isPropertyAccessExpression(declaration.initializer) &&
        isParamsRequire(declaration.initializer.expression)
      ) {
        takeNamed(declaration.initializer.name.text, declaration.name.text);
      }
    }
  }
  return { bindings, namespaces };
}

/**
 * Local export name → constructor kind, for names `filePath` re-exports
 * (directly, or through a chain of further local re-export barrels) from the
 * params module (#738).
 *
 * Read straight off disk rather than reusing `functionsSources`' reachable-
 * tree scan: a barrel a consumer imports from need not itself be REACHED by
 * the entrypoint walk (an unrelated import inside it could easily fail to
 * resolve), and re-deriving it here costs one extra small-file read, not a
 * second full-tree walk.
 *
 * `visited` tracks files on the CURRENT traversal path — an on-the-stack DFS
 * visited set, not a "seen anywhere, ever" set — so a genuine re-export
 * cycle (`./a` re-exporting from `./b`, which re-exports back from `./a`)
 * still returns empty rather than looping forever, while two SEPARATE,
 * non-cyclic statements that converge on the same upstream module (a barrel
 * re-exporting `defineString` from one statement and `defineSecret` from
 * another, both `from './shared'`) are each free to resolve it in full.
 * `finally` is what makes this correct: a file removes ONLY ITSELF, exactly
 * once, when its OWN call is about to return — not a caller deleting a
 * child's entry after each individual statement, which (Codex P2 round 2 on
 * PR #826) could delete an ancestor that a DIFFERENT sibling statement,
 * still active higher up the same call stack, still depends on being
 * marked — letting a later sibling edge re-enter that ancestor and recurse
 * until the call stack overflows. A namespace re-export barrel (`import *
 * as params from './barrel'`) is NOT resolved here — only named re-exports —
 * a narrower, still-useful scope for the common idiom.
 */
function reExportedParamsBindings(filePath, visited = new Set()) {
  const result = new Map();
  if (!filePath || visited.has(filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return result;
  }
  visited.add(filePath);
  try {
    const text = readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (specifier === PARAMS_MODULE) {
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            const kind = CONSTRUCTOR_RE.exec((element.propertyName ?? element.name).text);
            if (kind) {
              result.set(element.name.text, kind[1]);
            }
          }
        } else if (!clause) {
          // `export * from 'firebase-functions/params'` — see WILDCARD_PARAMS.
          result.set(WILDCARD_PARAMS, true);
        }
        continue;
      }
      if (!specifier.startsWith('.')) {
        continue;
      }
      const resolved = resolveRelative(filePath, specifier);
      if (!resolved) {
        continue;
      }
      const upstream = reExportedParamsBindings(resolved, visited);
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const kind = resolveFromReExports(upstream, (element.propertyName ?? element.name).text);
          if (kind) {
            result.set(element.name.text, kind);
          }
        }
      } else if (!clause) {
        // `export * from './barrel'` — forward every re-exported params
        // binding as-is; there is no local alias to rename it through.
        for (const [name, kind] of upstream) {
          result.set(name, kind);
        }
      }
    }
    return result;
  } finally {
    visited.delete(filePath);
  }
}

/** `require('firebase-functions/params')` — the CommonJS half of the same import. */
function isParamsRequire(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    expression.arguments[0].text === PARAMS_MODULE
  );
}

/**
 * Every identifier a binding target introduces — a plain name, or (#741) a
 * destructured object/array pattern, recursively (`{ defineString }`,
 * `[a, { b: defineString }]`, defaults and rest elements included).
 */
function bindingNames(nameNode, into) {
  if (ts.isIdentifier(nameNode)) {
    into.add(nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        bindingNames(element.name, into);
      }
    }
  }
}

/** Whether a `VariableDeclarationList` is `var` (function-scoped/hoisted), not `let`/`const`. */
function isHoistedDeclarationList(declarationList) {
  return (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
}

/**
 * Every `var`/function-declaration name bound ANYWHERE within `node` — at any
 * nesting depth through blocks, `if`/`for`/`while`/`try`/`catch`, etc. — but
 * never crossing into a nested function's own body (#741).
 *
 * `var` and function declarations are hoisted to the nearest enclosing
 * function (or the top level), not their lexical block, so a call OUTSIDE
 * the block that declares one is still shadowed by it — the earlier
 * ancestor-only walk could never see a sibling block's `var` (Codex P2 on PR
 * #730 caught the ancestor-only miss for the simple case; this closes the
 * nested-statement variant of the same gap).
 */
function collectHoistedNames(node, names) {
  // Annex B block-function hoisting is SLOPPY-MODE-ONLY behavior — it does
  // not apply in a module, which is always strict, regardless of the
  // `strict` compiler option (Codex P2 round 3 on PR #826, against an
  // earlier version of this fix that treated it as unconditionally safe
  // "can only ADD a shadow, never miss a real param" — backwards for a
  // strict file specifically, where a block-nested function declaration is
  // genuinely block-scoped: collecting it as though it hoists creates a
  // FALSE shadow over a call that, in the real module, still reaches the
  // outer import — dropping the exact real param this file exists to catch,
  // not adding a spurious one). Every `.ts` source in this tree is written
  // as ESM (`import`/`export`), making it a module by construction;
  // `ts.isExternalModule` is the general, syntax-driven test (any top-level
  // import or export makes a file a module) rather than assuming the
  // extension.
  if (ts.isFunctionDeclaration(node) && node.name && !ts.isExternalModule(node.getSourceFile())) {
    // Recorded BEFORE the function-like early return below, not after it —
    // `ts.isFunctionLike` also matches `FunctionDeclaration`, so putting
    // this in the `else if` chain after that check made it unreachable dead
    // code: a function declared two or more levels deep (inside an
    // `if`/`for` nested in the body, not directly in the function's own
    // top-level block — the shallow case is caught separately by
    // `scopeDeclares`'s own per-block scan) never had its name collected at
    // all (Codex P2 round 2 on PR #826).
    names.add(node.name.text);
  }
  if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) {
    // Stop descending: this node's own body is a new var/function-hoisting
    // scope boundary. A class STATIC BLOCK is one too (Codex P2 round 2 on
    // PR #826) — `var` inside `static { … }` is scoped to the block itself,
    // not hoisted out to whatever function contains the class, and was
    // previously walked into as though it were ordinary body code.
    return;
  }
  if (ts.isVariableStatement(node) && isHoistedDeclarationList(node.declarationList)) {
    for (const declaration of node.declarationList.declarations) {
      bindingNames(declaration.name, names);
    }
  } else if (
    ts.isForStatement(node) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    isHoistedDeclarationList(node.initializer)
  ) {
    for (const declaration of node.initializer.declarations) {
      bindingNames(declaration.name, names);
    }
  } else if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    ts.isVariableDeclarationList(node.initializer) &&
    isHoistedDeclarationList(node.initializer)
  ) {
    bindingNames(node.initializer.declarations[0].name, names);
  }
  ts.forEachChild(node, (child) => collectHoistedNames(child, names));
}

/**
 * Names a scope introduces itself, which therefore shadow anything outer
 * (#741). Three binding sources, matched to real JS/TS scoping:
 *
 *   - A function-like scope: its (possibly destructured) parameters, its own
 *     name when it is a NAMED function expression (binds only within
 *     itself), and — UNLESS `child` is one of its own parameters — every
 *     `var`/function-declaration hoisted anywhere within its body,
 *     regardless of nesting depth.
 *   - A `catch` clause: its (possibly destructured) binding, block-scoped to
 *     the clause.
 *   - A block (or the source file): `let`/`const`/`class`/function
 *     declarations bound DIRECTLY in its own statement list — lexically
 *     block-scoped, so NOT recursed into nested blocks; a nested block is
 *     itself a later ancestor in `isShadowed`'s walk and gets its own check.
 *
 * `child` is the node `isShadowed` ascended FROM to reach `scope` — the
 * direct child of `scope` on the path back down to the original call. It
 * exists for exactly one distinction: a call inside a PARAMETER's own
 * default-value initializer (`function f(x = defineString('P')) {…}`) runs
 * in a separate parameter scope that cannot see the function BODY's
 * `var`/function-declaration bindings — only a call actually inside the body
 * can be hoisting-shadowed by one (Codex P2 round 2 on PR #826).
 */
function scopeDeclares(scope, name, child) {
  const names = new Set();
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      bindingNames(parameter.name, names);
    }
    // A named FUNCTION EXPRESSION's own name is a real local binding inside
    // its own body (`const f = function g() { g(); }` calls itself via `g`).
    // `ts.isFunctionLike` also matches methods, accessors, and arrow
    // functions — a class or object-literal method named `defineString`
    // does NOT bind that name as a bare identifier inside its own body (you
    // would need `this.defineString(…)`), so treating its `.name` the same
    // way falsely marked an unrelated, unshadowed call as shadowed and
    // silently dropped a real param (Codex P2 on PR #826).
    if (ts.isFunctionExpression(scope) && scope.name && ts.isIdentifier(scope.name)) {
      names.add(scope.name.text);
    }
    if (names.has(name)) {
      return true;
    }
    const cameFromParameter = scope.parameters.some((parameter) => parameter === child);
    if (scope.body && !cameFromParameter) {
      collectHoistedNames(scope.body, names);
    }
    return names.has(name);
  }
  if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) {
      bindingNames(scope.variableDeclaration.name, names);
    }
    return names.has(name);
  }
  const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : null;
  if (!statements) {
    return false;
  }
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindingNames(declaration.name, names);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      // An import binding is only legal at the file top, but this branch
      // also runs for an ordinary block — harmless there, since a block can
      // never contain one. `import require from './loader'` (default),
      // `import { x as require } from './loader'` (named, possibly
      // aliased), and `import * as require from './loader'` (namespace) are
      // all real local bindings a reachable module can legally name
      // `require`, shadowing Node's global the same way a `const require =
      // …` does — and the require-shadow check (#740) reuses this same
      // lexical scan for the file top specifically because `require` is not
      // necessarily imported, so import forms have to count too (Codex P2
      // round 3 on PR #826).
      const clause = statement.importClause;
      if (clause.name) {
        names.add(clause.name.text);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.add(clause.namedBindings.name.text);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            names.add(element.name.text);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names.has(name);
}

/**
 * Whether an inner scope rebinds `name` between this call and the file top —
 * EXCLUSIVE of the file top itself.
 *
 * A file-wide name lookup reads `function f(defineString) { defineString('LOCAL') }`
 * as declaring a param, and the generator then aborts every run demanding a value
 * the emulator never registers (Codex P2 on PR #730). Walking up from the call
 * settles it; the alternative — `ts.createProgram` and a real type checker — buys
 * exact symbol resolution at the cost of module resolution and a compile, on a
 * path that runs before every e2e suite.
 *
 * Deliberately does NOT check the file top: a param constructor is always
 * IMPORTED, so a top-level redeclaration of its name is a TypeScript
 * duplicate-identifier error and could never legitimately shadow it here —
 * BUT the CommonJS binding form this file also supports
 * (`const { defineString } = require('firebase-functions/params')`, #738) is
 * itself an ordinary top-level `VariableStatement`. Checking the file top
 * would make `scopeDeclares` rediscover THAT SAME statement as though it
 * were an unrelated shadow of the very binding it defines — a self-
 * referential false positive that broke every CJS-bound param (caught by
 * this file's own pre-existing CJS tests when a round-2 attempt at the
 * `require`-shadow fix below tried reusing this function directly, Codex P2
 * round 2 on PR #826). The `require`-identifier check needs file-top
 * coverage for a different, legitimate reason — see its call site.
 */
function isShadowed(call, name) {
  let child = call;
  for (let scope = call.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
    if (scopeDeclares(scope, name, child)) {
      return true;
    }
    child = scope;
  }
  return false;
}

/**
 * The constructor kind a call invokes, or null when it is not a param
 * declaration.
 *
 * Resolved from the IMPORT, never from how the call is spelled. A module with an
 * unrelated local `defineString(…)` helper, or a `schema.defineString(…)` method,
 * would otherwise read as declaring a Firebase param — and the generator would
 * abort every e2e run demanding a value for a param the emulator has never heard
 * of (Codex P2 on PR #730). Provenance is the only thing that distinguishes the
 * two, and the earlier name-shaped fallback did not have it.
 */
function constructorKindOf(call, { bindings, namespaces }) {
  if (ts.isIdentifier(call.expression)) {
    const kind = bindings.get(call.expression.text);
    return kind && !isShadowed(call, call.expression.text) ? kind : null;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    namespaces.has(call.expression.expression.text) &&
    !isShadowed(call, call.expression.expression.text)
  ) {
    return CONSTRUCTOR_RE.exec(call.expression.name.text)?.[1] ?? null;
  }
  return null;
}

/**
 * The param name a declaration gives, or null when it is not a plain string.
 *
 * A no-substitution template literal counts — it is an ordinary string, and
 * treating it otherwise was a silent skip (Codex P2 on PR #730).
 */
function literalNameOf(call) {
  const [first] = call.arguments;
  if (!first) {
    return null;
  }
  return ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : null;
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
 * Every param name a source declares, split by where its value belongs:
 * `params` → `.env.local`, `secrets` → `.secret.local`.
 *
 * `label` names the file in any error. Firebase discovers params from every
 * loaded Functions module, not just `params.ts`, so callers scan the whole tree
 * (see `declaredParamNamesAcross`) — this only ever sees one file at a time.
 */
function scanSource(source, label) {
  const params = [];
  const secrets = [];
  const unresolvable = [];
  // A real TypeScript parse, not a pattern match. Eight rounds of review on PR
  // #730 each found the regex confusing code with something that only looked
  // like it — a constructor named in prose, a `/*` inside a string literal, an
  // aliased binding, a name that was not a literal. The scanner settles every
  // one of those by construction, and it costs a devDependency the repo already
  // installs for `npm run typecheck`.
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true);
  const bindings = constructorBindings(sourceFile, label);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = constructorKindOf(node, bindings);
      if (kind) {
        const name = literalNameOf(node);
        if (name === null) {
          unresolvable.push(`${node.expression.getText(sourceFile)}(…)`);
        } else {
          (kind === 'Secret' ? secrets : params).push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // A name this file cannot read statically — `defineString(PARAM_NAME, …)` —
  // must stop the run rather than be dropped from the key set. Dropping it is
  // indistinguishable from the param not existing, which is the exact hang this
  // module exists to prevent, and every test would still pass.
  if (unresolvable.length > 0) {
    throw new Error(
      `${label} declares ${unresolvable.join(', ')} with a name this ` +
        'generator cannot resolve statically. Use a plain string literal for the param ' +
        'name, or teach scripts/e2e-functions-env.mjs to resolve the expression — ' +
        'silently skipping it would let the emulator block on a prompt for that param.',
    );
  }
  return { params, secrets };
}
/**
 * One file's declarations, with the zero-match guard applied — the entry point
 * for a caller that expects THIS file to declare params (params.ts, or a spec
 * fragment). The tree scan uses `scanSource` directly, since almost every module
 * legitimately declares nothing.
 */
export function declaredParamNames(source, label = 'functions/src/params.ts') {
  const found = scanSource(source, label);
  if (found.params.length === 0 && found.secrets.length === 0) {
    throw new Error(
      `No firebase-functions/params declarations found in ${label}. If it was restructured, ` +
        'update CONSTRUCTOR_RE in scripts/e2e-functions-env.mjs — a parse that silently finds ' +
        'nothing would let the emulator prompt for every param.',
    );
  }
  return found;
}

/**
 * The union of every param declared anywhere under the Functions source tree.
 *
 * Scanning the tree rather than `params.ts` alone because Firebase resolves
 * params from every loaded module: a handler that declared one beside itself
 * would be invisible to a single-file scan, and the declarations already in
 * `params.ts` would keep the zero-match guard satisfied while the emulator hung
 * on the new name (Codex P2 on PR #730). Centralising params is this repo's
 * convention, but a convention nothing enforces is not a guarantee — and here
 * the enforcement costs one directory walk.
 *
 * The zero-match guard applies to the union, not to each file: almost every
 * module legitimately declares nothing.
 */
export function declaredParamNamesAcross(sources) {
  const params = new Set();
  const secrets = new Set();
  for (const { label, text } of sources) {
    const found = scanSource(text, label);
    found.params.forEach((name) => params.add(name));
    found.secrets.forEach((name) => secrets.add(name));
  }
  if (params.size === 0 && secrets.size === 0) {
    throw new Error(
      `No firebase-functions/params declarations found across ${sources.length} Functions ` +
        'source file(s). If the tree was restructured, update CONSTRUCTOR_RE in ' +
        'scripts/e2e-functions-env.mjs — a scan that silently finds nothing would let the ' +
        'emulator prompt for every param.',
    );
  }
  return { params: [...params], secrets: [...secrets] };
}

/** Extensions the Functions build can load, tried in resolution order. */
const LOADABLE_EXTENSIONS = ['.ts', '.cts', '.mts', '.tsx', '.js', '.cjs', '.mjs', '.jsx'];

/** The file a relative specifier names, or null when nothing on disk matches. */
function resolveRelative(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier);
  const candidates = [
    base,
    // A specifier may carry the COMPILED extension (`./x.js` for a `x.ts` source).
    ...LOADABLE_EXTENSIONS.map((extension) => base.replace(/\.[cm]?jsx?$/, extension)),
    ...LOADABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...LOADABLE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/**
 * Whether an `import` declaration is erased entirely at compile time — no
 * runtime reference to the module survives, so it declares no dependency
 * (#739). `import type { X } from './x'` (whole-declaration) and `import {
 * type X } from './x'` (every named binding individually type-only) both
 * qualify; a default import, a namespace import, or ANY non-type-only named
 * binding makes it a real runtime import (`import { type X, y } from './x'`
 * still loads the module for `y`). A side-effect-only `import './x'` has no
 * clause at all and is always a runtime import.
 */
function isFullyTypeOnlyImport(clause) {
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name) {
    return false;
  }
  const named = clause.namedBindings;
  if (!named || ts.isNamespaceImport(named)) {
    return false;
  }
  return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
}

/** The `export …` counterpart of `isFullyTypeOnlyImport` (#739). */
function isFullyTypeOnlyExport(node) {
  if (node.isTypeOnly) {
    return true;
  }
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) {
    // `export * from './x'` or `export * as ns from './x'` — always runtime.
    return false;
  }
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** A specifier this scanner can read statically: a plain string, or a template literal with no `${}` substitutions. */
function literalSpecifierOf(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

/**
 * Every relative specifier a module imports or requires.
 *
 * `label` names the file in the thrown error for a specifier this scanner
 * cannot resolve statically (#740) — never propagated otherwise.
 */
function relativeDependencies(sourceFile, label) {
  const specifiers = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isFullyTypeOnlyImport(node.importClause)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isFullyTypeOnlyExport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      // `import x = require('./x')` (#740) — TypeScript's pre-ESM syntax for
      // a runtime require, not expressible as an ImportDeclaration at all.
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        // `require` is an ordinary identifier, not a keyword — a reachable
        // module that declares its OWN local `require` (a param, a test
        // helper, anything) shadows Node's loader, and a call through it is
        // not a module specifier at all (Codex P2 round 1 on PR #826).
        // Treating it as one used to just miss a dependency silently; now
        // that a non-literal argument fails closed below, the same false
        // positive would abort validation over unrelated application code.
        //
        // Checked at EVERY level including the file top — `!isShadowed(...)`
        // covers every ancestor scope up to (but excluding) the file top,
        // and `!scopeDeclares(sourceFile, 'require')` covers the file top
        // itself. `require` needs that file-top coverage, unlike the
        // `isShadowed`-only check `constructorKindOf` uses for a param
        // constructor name: `require` is not necessarily imported, so a
        // plain top-level `const require = …;` is legal TS and genuinely
        // shadows Node's global for the whole module (Codex P2 round 2 on
        // PR #826) — where a param constructor's name always IS imported,
        // making a top-level redeclaration of ITS name a TypeScript
        // duplicate-identifier error, safe to not check for. `isShadowed`
        // itself stays file-top-EXCLUSIVE because reusing it, file-top
        // included, for the constructor-name check broke every CJS-bound
        // param — see `isShadowed`'s own comment.
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          !isShadowed(node, 'require') &&
          !scopeDeclares(sourceFile, 'require')))
    ) {
      const [first] = node.arguments;
      if (first) {
        const literal = literalSpecifierOf(first);
        if (literal !== null) {
          specifiers.push(literal);
        } else {
          // A non-literal specifier (#740) — `require(pathVar)`, a template
          // literal with a substitution — cannot be resolved statically.
          // Skipping it silently would miss a module that declares a
          // Firebase param exactly like the unresolvable-param-name case
          // below does, so this fails the same way: loud, not silent.
          throw new Error(
            `${label} calls ${node.expression.getText(sourceFile)}(…) with a specifier this ` +
              'generator cannot resolve statically. Use a plain string literal (or a ' +
              'no-substitution template literal) module specifier, or teach ' +
              'scripts/e2e-functions-env.mjs to resolve the expression — silently skipping it ' +
              'could miss a module that declares a Firebase param, letting the emulator prompt ' +
              'for it later.',
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

/**
 * Every module REACHABLE from the Functions entrypoint, with its path.
 *
 * Reachability, not presence on disk. Firebase discovery executes `lib/index.js`
 * and its transitive imports, so a module that compiles but nothing imports
 * declares no deployed param — counting it would make the generator demand an
 * e2e value for a param the emulator never registers, aborting every run (Codex
 * P2 on PR #730). This is the exact counterpart of the earlier finding that a
 * params.ts-only scan misses a param declared beside its handler: the right set
 * is neither one file nor every file, it is the import graph.
 *
 * Lazy `await import('./params')` counts — `dailyEmail.ts` reaches its params
 * that way — which is why dynamic imports and requires are followed too. A
 * specifier resolving to nothing on disk is skipped rather than fatal: it is a
 * bare package import or a type-only path, and neither declares a runtime param.
 */
export function functionsSources(entrypoint) {
  const seen = new Set();
  const sources = [];
  const walk = (file) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    sources.push({ label: file, text });
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const specifier of relativeDependencies(sourceFile, file)) {
      const resolved = resolveRelative(file, specifier);
      if (resolved) {
        walk(resolved);
      }
    }
  };
  walk(entrypoint);
  return sources;
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
  const { params, secrets } =
    typeof paramsSource === 'string' ? declaredParamNames(paramsSource) : paramsSource;
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
export function unassignedNames(assigned, names) {
  return names.filter((name) => !Object.hasOwn(assigned, name));
}

/**
 * A dotenv body as its consumers read it, or a throw naming the file.
 *
 * STRICT, because both consumers are: `loadUserEnvs` and `resolveSecretEnvs`
 * each call `parseStrict`, so one malformed line does not merely get skipped —
 * it discards the whole file. The lenient `parse` returns the good keys with the
 * failures in an `errors` array that is easy to ignore, which made this guard
 * accept a `.secret.local` the emulator would then treat as empty (Codex P2 on
 * PR #730).
 *
 * That case is silent in the worst way. `resolveSecretEnvs` catches the throw
 * and logs it only `if ("code" in e)` — and the FirebaseError parseStrict raises
 * has no `code` — so `secretEnvs` is left `{}`, every secret reads as absent,
 * and the run reaches for the real Secret Manager with nothing said.
 */
export function parseDotenv(body, label) {
  try {
    return parseStrict(body);
  } catch (error) {
    // NEVER propagate the parser's own message. It quotes each rejected line
    // verbatim, and a malformed line in `.secret.local` is by definition a line
    // holding a credential — `RESEND_API_KEY sk_live_…` with the `=` fumbled
    // would print the key into the terminal, the agent transcript, and any
    // captured test log (Codex P2 on PR #730). Line numbers locate the problem
    // without disclosing it.
    throw new Error(
      `${label} is not a dotenv file the emulator can read — ${describeBadLines(body, error)}. It ` +
        'parses strictly, so a single malformed line discards the whole file: for ' +
        '.secret.local that silently sends the run to the real Secret Manager. The ' +
        'offending content is withheld here because this file holds credentials.',
    );
  }
}

/**
 * Where the rejected lines are, never what they say.
 *
 * `parseStrict` fails two different ways (#742), and only one of them shows
 * up in `parse(body).errors`: a SYNTAX error (a line `parse` itself cannot
 * read) does, but a KEY validation error — reserved, not
 * `[A-Z_][A-Z0-9_]*`, or a reserved prefix — does not: `parse` accepts the
 * line just fine and only `validateKey` rejects the resulting key. Grepping
 * `parse(body).errors` for that second case found nothing and reported "0
 * malformed lines" — true of the (empty) syntax-error set, but not of why
 * the file was actually rejected.
 *
 * `KeyValidationError.message` (and `.key`) is NEVER surfaced in the
 * returned string, even though a key name is not itself normally a
 * credential: `LINE_RE` captures whatever text sits before `=` as the key,
 * with no check that it LOOKS like a key, so a reversed assignment in
 * `.secret.local` — `sk_live_do_not_leak_me=RESEND_API_KEY`, the `=`
 * fumbled the other way — puts the credential in the key position, and
 * `validateKey` rejects it (lowercase) with a message that repeats it
 * verbatim (Codex P1 on PR #826, on an earlier version of this function
 * that DID surface `.message`). A generic category, not the parser's
 * classification, is all this reports, matching the syntax-error path's
 * existing withholding below. `.key` is still used internally, only to
 * LOCATE the line via `lineAssignsKey` — never printed.
 */
function describeBadLines(body, error) {
  const keyErrors = (error?.children ?? []).filter((child) => child instanceof KeyValidationError);
  if (keyErrors.length > 0) {
    const numbers = body
      .split('\n')
      .map((line, index) => (keyErrors.some((keyError) => lineAssignsKey(line, keyError.key)) ? index + 1 : 0))
      .filter(Boolean);
    const count = keyErrors.length;
    const plural = count === 1 ? 'key' : 'keys';
    const location = numbers.length > 0 ? ` (line ${numbers.join(', ')})` : '';
    return (
      `${count} invalid ${plural}${location} — reserved for internal use, not ` +
      'ALL_CAPS_WITH_UNDERSCORES, or starting with a reserved prefix'
    );
  }
  const rejected = new Set(parse(body).errors.map((line) => line.trim()));
  const numbers = body
    .split('\n')
    .map((line, index) => (rejected.has(line.trim()) ? index + 1 : 0))
    .filter(Boolean);
  const count = rejected.size;
  const plural = count === 1 ? 'line' : 'lines';
  return numbers.length > 0
    ? `${count} malformed ${plural} (line ${numbers.join(', ')})`
    : `${count} malformed ${plural}`;
}

/** Whether `line` is a dotenv assignment for `key` — the key name only, never the value. */
function lineAssignsKey(line, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`).test(line);
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
export function unusableSecretNames(assigned, names) {
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
 * The dotenv files `firebase deploy` merges before resolving params — the
 * same `findEnvfiles` order as `emulatorDotenvFiles`, minus the
 * emulator-only `.env.local` overlay: `loadUserEnvs` is called with no
 * `isEmulator` key from the deploy path (`lib/deploy/functions/prepare.js`),
 * so `findEnvfiles` never appends `FUNCTIONS_EMULATOR_DOTENV` there. Reusing
 * `emulatorDotenvFiles` for deploy-time validation
 * (scripts/validate-functions-env.mjs, #767) would treat a
 * `.env.local`-only value as covering a param the deploy will never
 * actually see.
 */
export function deployDotenvFiles(projectId) {
  return ['.env', `.env.${projectId}`];
}

/**
 * The merged environment the emulator resolves params against.
 *
 * Parsed per file rather than by concatenating the bodies, because that is what
 * `loadUserEnvs` does — one file at a time, strictly — so a malformed layer is
 * attributed to the file that actually contains it instead of being blamed on
 * the join.
 */
function mergedDotenvEnvs(directory, projectId) {
  let merged = {};
  for (const file of emulatorDotenvFiles(projectId)) {
    const path = join(directory, file);
    if (existsSync(path)) {
      merged = { ...merged, ...parseDotenv(readFileSync(path, 'utf8'), path) };
    }
  }
  return merged;
}

function ensureFile(path, names, body, { coverageEnvs, unmet, consequence }) {
  if (!existsSync(path)) {
    writeFileSync(path, body);
    return;
  }
  const missing = unmet(coverageEnvs ?? parseDotenv(readFileSync(path, 'utf8'), path), names);
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
  const [functionsEntrypoint, envPath, secretPath, projectId] = argv;
  if (!functionsEntrypoint || !envPath || !secretPath || !projectId) {
    throw new Error(
      'usage: e2e-functions-env.mjs <functions/src/index.ts> <.env.local> <.secret.local> <projectId>',
    );
  }
  const declared = declaredParamNamesAcross(functionsSources(functionsEntrypoint));
  const { params, secrets } = declared;
  // Both bodies are rendered before either is written, so the failure this
  // exists to produce — a param with no e2e value — creates nothing at all,
  // rather than a half-written file the next run would accept as good. Cleanup
  // after any LATER failure belongs to the caller: scripts/test-e2e.sh decides
  // which of these two files it owns before calling here, and removes only
  // those on exit.
  const { env, secret } = e2eFunctionsEnv(declared, projectId);
  ensureFile(envPath, params, env, {
    coverageEnvs: mergedDotenvEnvs(dirname(envPath), projectId),
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
