// Every HTTPS Function (onCall / onRequest) this repository exports belongs to
// exactly one Cloud Run invoker family, or is listed as intentionally private
// (#1277).
//
// Domain Restricted Sharing rejects the `allUsers` invoker binding Firebase
// adds to a Gen2 HTTPS function, so an HTTPS export that no family wrapper
// reconciles is published unreachable: an unauthenticated POST gets Google's
// HTML 403 instead of the function's own 401 JSON. unlockDayNow shipped that
// way. The deploy classifier (`validate-firebase-deploy-filters.mjs`) therefore
// refuses any Functions deploy whose index exports an HTTPS function that is in
// neither table below, naming the export, before anything is built.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const CALLABLE_INVOKER_FAMILIES = Object.freeze([
  { wrapper: "scripts/set-bug-report-invoker.sh", exports: ["submitBugReport"] },
  { wrapper: "scripts/set-email-unsubscribe-invoker.sh", exports: ["emailUnsubscribe"] },
  {
    wrapper: "scripts/set-auth-handoff-invoker.sh",
    exports: ["mintAuthHandoff", "exchangeAuthHandoff"],
  },
  {
    wrapper: "scripts/set-event-invitations-invoker.sh",
    exports: ["mintEventInvitation", "redeemEventInvitation", "revokeEventInvitation"],
  },
  {
    wrapper: "scripts/set-admin-callables-invoker.sh",
    exports: ["unlockDayNow", "approvePrompts"],
  },
]);

// HTTPS exports that are MEANT to stay behind the Cloud Run invoker IAM check
// (reachable only by an identity holding roles/run.invoker), mapped to the
// reason. Empty today: every HTTPS export this repository ships is called by
// signed-in players or admins and must be reconciled. Add an entry only with a
// reviewed reason; an entry here is a decision that the endpoint answers 403
// to every browser.
export const PRIVATE_HTTPS_EXPORTS = Object.freeze({});

const HTTPS_BUILDERS = new Set(["onCall", "onRequest"]);

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.(?:c|m)?js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  // A dangling local module fails the Functions build itself, so it cannot
  // publish anything this guard would need to see.
  return null;
}

// Whether `node` calls an HTTPS builder outside any nested function:
// `onCall(...)`, `https.onRequest(...)`, a wrapper around one, or a local or
// imported factory whose own body does (`createCallable(...)`).
function callsHttpsBuilder(node, localBuilders) {
  let found = false;
  const visit = (child) => {
    if (found || isFunctionNode(child)) return;
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (
        (ts.isIdentifier(callee) && localBuilders.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && HTTPS_BUILDERS.has(callee.name.text))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isFunctionNode(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

function isExported(statement) {
  return Boolean(statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

// The top-level bindings a file declares, by name: `function f() {}` and every
// `const x = <initializer>`.
function topLevelBindings(source) {
  const bindings = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      bindings.push({ name: statement.name.text, init: statement, exported: isExported(statement) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        bindings.push({ name: declaration.name.text, init: declaration.initializer, exported: isExported(statement) });
      }
    }
  }
  return bindings;
}

const EMPTY = Object.freeze({ https: new Set(), factories: new Set() });

// One pass over `file`. `results` persists across passes and its sets only
// grow; `visited` is per pass, so a module reached again through an import
// cycle answers with what earlier passes proved, and the caller repeats passes
// until nothing grows.
function analyzeModule(file, results, visited) {
  if (!results.has(file)) results.set(file, { https: new Set(), factories: new Set() });
  const analysis = results.get(file);
  if (visited.has(file)) return analysis;
  visited.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // Names that build an HTTPS function when called: the SDK builders, their
  // aliases, and factories whose own body calls one.
  const localBuilders = new Set(HTTPS_BUILDERS);
  const localHttps = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
    const target = resolveModule(file, specifier);
    const upstream = target ? analyzeModule(target, results, visited) : EMPTY;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (HTTPS_BUILDERS.has(imported) || upstream.factories.has(imported)) {
        localBuilders.add(element.name.text);
      }
      // An imported endpoint re-exported later (`export { x }`) or aliased
      // (`export const y = x`) is still that endpoint.
      if (upstream.https.has(imported)) localHttps.add(element.name.text);
    }
  }
  // Iterate so an alias or factory declared before what it refers to counts.
  const declared = topLevelBindings(source);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, init, exported } of declared) {
      if (localBuilders.has(name) || localHttps.has(name)) continue;
      let kind = null;
      if (isFunctionNode(init)) {
        if (init.body && callsHttpsBuilder(init.body, localBuilders)) kind = "builder";
      } else if (ts.isIdentifier(init)) {
        if (localBuilders.has(init.text)) kind = "builder";
        else if (localHttps.has(init.text)) kind = "https";
      } else if (callsHttpsBuilder(init, localBuilders)) {
        kind = "https";
      }
      if (!kind) continue;
      (kind === "builder" ? localBuilders : localHttps).add(name);
      if (exported) (kind === "builder" ? analysis.factories : analysis.https).add(name);
      changed = true;
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const target = specifier ? resolveModule(file, specifier) : null;
    // A package re-export defines no endpoint here; a dangling one cannot build.
    if (specifier && !target) continue;
    const upstream = target ? analyzeModule(target, results, visited) : { https: localHttps, factories: localBuilders };
    if (!statement.exportClause) {
      for (const name of upstream.https) analysis.https.add(name);
      for (const name of upstream.factories) analysis.factories.add(name);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      if (upstream.https.has(local)) analysis.https.add(element.name.text);
      if (upstream.factories.has(local)) analysis.factories.add(element.name.text);
    }
  }
  return analysis;
}

/**
 * The exported names in `file` (and the local modules it imports from or
 * re-exports) whose value is an onCall / onRequest function, built directly,
 * through an alias of a builder, or through a helper factory. Import cycles are
 * resolved to a fixed point. Read-only, syntax-only.
 */
export function httpsFunctionExports(file) {
  const results = new Map();
  const size = () => [...results.values()].reduce((n, a) => n + a.https.size + a.factories.size, 0);
  let before;
  do {
    before = size();
    analyzeModule(file, results, new Set());
  } while (size() !== before);
  return results.get(file).https;
}

/** HTTPS exports of `indexFile` that no invoker family reconciles. */
export function unfamiliedHttpsExports(indexFile) {
  const familied = new Set(CALLABLE_INVOKER_FAMILIES.flatMap((family) => family.exports));
  return [...httpsFunctionExports(indexFile)]
    .filter((name) => !familied.has(name) && !Object.hasOwn(PRIVATE_HTTPS_EXPORTS, name))
    .sort();
}
