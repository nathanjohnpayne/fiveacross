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

// A variable whose initializer calls an HTTPS builder outside any nested
// function: `onCall(...)`, `https.onRequest(...)`, or a wrapper around one.
function initializerBuildsHttps(node, localBuilders) {
  let found = false;
  const visit = (child) => {
    if (found || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return;
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

/**
 * The exported names in `file` (and the local modules it re-exports from)
 * whose value is an onCall / onRequest function. Read-only, syntax-only.
 */
export function httpsFunctionExports(file, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const result = new Set();
  seen.set(file, result);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const localBuilders = new Set(HTTPS_BUILDERS);
  const localHttps = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (HTTPS_BUILDERS.has(imported)) localBuilders.add(element.name.text);
        }
      }
    }
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (!initializerBuildsHttps(declaration.initializer, localBuilders)) continue;
        localHttps.add(declaration.name.text);
        if (exported) result.add(declaration.name.text);
      }
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
    const upstream = target ? httpsFunctionExports(target, seen) : localHttps;
    if (!statement.exportClause) {
      for (const name of upstream) result.add(name);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      if (upstream.has(local)) result.add(element.name.text);
    }
  }
  return result;
}

/** HTTPS exports of `indexFile` that no invoker family reconciles. */
export function unfamiliedHttpsExports(indexFile) {
  const familied = new Set(CALLABLE_INVOKER_FAMILIES.flatMap((family) => family.exports));
  return [...httpsFunctionExports(indexFile)]
    .filter((name) => !familied.has(name) && !Object.hasOwn(PRIVATE_HTTPS_EXPORTS, name))
    .sort();
}
