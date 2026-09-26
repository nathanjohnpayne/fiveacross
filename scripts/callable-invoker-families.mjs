// Every HTTPS Function (onCall / onRequest) this repository exports belongs to
// exactly one Cloud Run invoker family, or is listed as intentionally private
// (#1277).
//
// Domain Restricted Sharing rejects the `allUsers` invoker binding Firebase
// adds to a Gen2 HTTPS function, so an HTTPS export that no family wrapper
// reconciles is published unreachable: an unauthenticated request gets Google's
// HTML 403 instead of the function's own answer (a callable's 401 JSON, or an
// onRequest endpoint's application response). unlockDayNow shipped that way.
//
// The tables below are enforced from the BUILT artifact (#1283): the Functions
// predeploy hook `check-callable-families-predeploy.mjs` asks the SDK's own
// discovery what the just-built codebase deploys and stops `firebase deploy`,
// naming the endpoint, when an HTTPS endpoint is in neither table. The syntax
// scan in this file is advisory only: the deploy classifier
// (`validate-firebase-deploy-filters.mjs`) runs it before anything is built and
// warns, never refuses, because no syntactic scan is complete over TypeScript.
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

export function resolveModule(fromFile, specifier) {
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
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const isDefault = Boolean(statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
      // `export default function () {}` is the exported binding `default`.
      if (isDefault) bindings.push({ name: "default", init: statement, exported: isExported(statement) });
      if (statement.name) {
        bindings.push({ name: statement.name.text, init: statement, exported: !isDefault && isExported(statement) });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        bindings.push({ name: declaration.name.text, init: declaration.initializer, exported: isExported(statement) });
      }
    }
  }
  return bindings;
}

// Strip type-only and grouping wrappers: `(x)`, `x as T`, `<T>x`, `x!`,
// `x satisfies T` all evaluate to `x`.
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

// What a (non-function, non-object) value is: "builder" when calling it builds
// an HTTPS function, "https" when it is one, else null. `scope` carries the
// module's builders, endpoints and local namespace imports.
function valueKind(node, scope) {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) {
    if (scope.builders.has(value.text)) return "builder";
    if (scope.https.has(value.text)) return "https";
    return null;
  }
  // `admin.unlockDayNow` of `import * as admin from './admin'`.
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && scope.namespaces.has(value.expression.text)) {
    const upstream = scope.namespaces.get(value.expression.text);
    if (upstream.factories.has(value.name.text)) return "builder";
    if (upstream.https.has(value.name.text)) return "https";
  }
  return callsHttpsBuilder(value, scope.builders) ? "https" : null;
}

// The member names of an object-literal Functions group whose values are
// HTTPS functions: `{ endpoint }`, `{ name: endpoint }`, `{ name: onCall(...) }`,
// `{ name: admin.endpoint }`, and nested groups, which Firebase names
// `outer-inner-endpoint`.
function groupMembers(object, scope) {
  const members = [];
  for (const property of object.properties) {
    // `{ ...group }` spreads a local group's or a namespace import's members.
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrap(property.expression);
      if (ts.isIdentifier(spread) && scope.groups.has(spread.text)) members.push(...scope.groups.get(spread.text));
      else if (ts.isIdentifier(spread) && scope.namespaces.has(spread.text)) members.push(...scope.namespaces.get(spread.text).https);
      else if (ts.isObjectLiteralExpression(spread)) members.push(...groupMembers(spread, scope));
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const key = property.name.text;
      if (scope.https.has(key)) members.push(key);
      // `{ inner }` of a local group or namespace import nests that group.
      else if (scope.groups.has(key)) for (const inner of scope.groups.get(key)) members.push(`${key}-${inner}`);
      else if (scope.namespaces.has(key)) for (const inner of scope.namespaces.get(key).https) members.push(`${key}-${inner}`);
    } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      const value = unwrap(property.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        for (const inner of groupMembers(value, scope)) members.push(`${property.name.text}-${inner}`);
        continue;
      }
      if (ts.isIdentifier(value) && (scope.groups.has(value.text) || scope.namespaces.has(value.text))) {
        const inner = scope.groups.get(value.text) ?? [...scope.namespaces.get(value.text).https];
        for (const member of inner) members.push(`${property.name.text}-${member}`);
        continue;
      }
      if (!isFunctionNode(value) && valueKind(value, scope) === "https") members.push(property.name.text);
    }
  }
  return members;
}

// `groups` maps an exported object-group name to its member names; `opaque`
// records a star re-export this scan cannot see into (a package, or a module
// that does not resolve), directly or through a local star.
const newAnalysis = () => ({ https: new Set(), factories: new Set(), groups: new Map(), opaque: false });
const EMPTY = Object.freeze(newAnalysis());

// One pass over `file`. `results` persists across passes and its sets only
// grow; `visited` is per pass, so a module reached again through an import
// cycle answers with what earlier passes proved, and the caller repeats passes
// until nothing grows.
function analyzeModule(file, results, visited) {
  if (!results.has(file)) results.set(file, newAnalysis());
  const analysis = results.get(file);
  if (visited.has(file)) return analysis;
  visited.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // Names that build an HTTPS function when called: the SDK builders, their
  // aliases, and factories whose own body calls one.
  const localBuilders = new Set(HTTPS_BUILDERS);
  const localHttps = new Set();
  // `import * as admin from './admin'` of a local module, by local name.
  const namespaceImports = new Map();
  // Group member names of every top-level object literal (and every imported
  // group), by local name, so a later `export { grouped as admin }` names the
  // same group.
  const localGroups = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
    const target = resolveModule(file, specifier);
    const upstream = target ? analyzeModule(target, results, visited) : EMPTY;
    // `import x from './m'` binds m's `default` export.
    const imports = clause.name ? [{ imported: "default", local: clause.name.text }] : [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        imports.push({ imported: (element.propertyName ?? element.name).text, local: element.name.text });
      }
    }
    if (target && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaceImports.set(clause.namedBindings.name.text, upstream);
    }
    for (const { imported, local } of imports) {
      // `import { admin } from './admin'` of an object group keeps its members.
      if (upstream.groups.has(imported)) localGroups.set(local, upstream.groups.get(imported));
      if (HTTPS_BUILDERS.has(imported) || upstream.factories.has(imported)) localBuilders.add(local);
      // An imported endpoint re-exported later (`export { x }`) or aliased
      // (`export const y = x`) is still that endpoint.
      if (upstream.https.has(imported)) localHttps.add(local);
    }
  }
  // Iterate so an alias or factory declared before what it refers to counts.
  // `const { onCall: makeCallable } = https` destructures a builder under a
  // new name; the binding pattern has no identifier for the pass below.
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
        const property = element.propertyName ?? element.name;
        if (!ts.isIdentifier(property) || !HTTPS_BUILDERS.has(property.text)) continue;
        localBuilders.add(element.name.text);
        if (isExported(statement)) analysis.factories.add(element.name.text);
      }
    }
  }
  const scope = { builders: localBuilders, https: localHttps, namespaces: namespaceImports, groups: localGroups };
  const declared = topLevelBindings(source);
  // `export default <expression>` is an exported binding named `default`.
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      declared.push({ name: "default", init: statement.expression, exported: true });
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, init: rawInit, exported } of declared) {
      if (localBuilders.has(name) || localHttps.has(name)) continue;
      const init = unwrap(rawInit);
      let kind = null;
      if (isFunctionNode(init)) {
        if (init.body && callsHttpsBuilder(init.body, localBuilders)) kind = "builder";
      } else if (ts.isIdentifier(init) && namespaceImports.has(init.text)) {
        // `export const admin = grouped` of `import * as grouped` is a group;
        // recorded as a local group so a further alias keeps it.
        const members = [...namespaceImports.get(init.text).https];
        localGroups.set(name, members);
        if (exported) {
          analysis.groups.set(name, members);
          for (const member of members) analysis.https.add(`${name}-${member}`);
        }
      } else if (ts.isIdentifier(init) && localGroups.has(init.text)) {
        // `const grouped = { endpoint }; export const admin = grouped`.
        const members = localGroups.get(init.text);
        localGroups.set(name, members);
        if (exported) {
          analysis.groups.set(name, members);
          for (const member of members) analysis.https.add(`${name}-${member}`);
        }
      } else if (ts.isObjectLiteralExpression(init)) {
        // `export const admin = { endpoint }` deploys a Firebase group whose
        // members are named `admin-endpoint`.
        const members = groupMembers(init, scope);
        localGroups.set(name, members);
        if (exported) {
          analysis.groups.set(name, members);
          for (const member of members) analysis.https.add(`${name}-${member}`);
        }
      } else {
        kind = valueKind(init, scope);
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
    // A package re-export defines no endpoint this scan can see; a dangling
    // local one cannot build. A star of either is opaque to the inventory.
    if (specifier && !target) {
      if (!statement.exportClause) analysis.opaque = true;
      continue;
    }
    const upstream = target
      ? analyzeModule(target, results, visited)
      : { https: localHttps, factories: localBuilders, groups: localGroups, opaque: false };
    if (!statement.exportClause) {
      // `export *` never forwards the module's `default` export, nor the
      // `default-<member>` names this scan flattened out of a default-exported
      // group (#1286).
      const forwarded = (name) => name !== "default" && !name.startsWith("default-");
      for (const name of upstream.https) if (forwarded(name)) analysis.https.add(name);
      for (const name of upstream.factories) if (forwarded(name)) analysis.factories.add(name);
      for (const [name, members] of upstream.groups) if (forwarded(name)) analysis.groups.set(name, members);
      if (upstream.opaque) analysis.opaque = true;
      continue;
    }
    // `export * as admin from './admin'` deploys admin's endpoints as a
    // Firebase group, named `admin-<export>`, and is recorded as the group
    // `admin` so a later `import { admin }` or `export { admin as x } from`
    // keeps its members (#1285).
    if (ts.isNamespaceExport(statement.exportClause)) {
      const group = statement.exportClause.name.text;
      const members = [...upstream.https];
      analysis.groups.set(group, members);
      for (const name of members) analysis.https.add(`${group}-${name}`);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      if (upstream.https.has(local)) analysis.https.add(element.name.text);
      // `import * as admin from './admin'; export { admin }` is the same group.
      if (!target && namespaceImports.has(local)) {
        for (const name of namespaceImports.get(local).https) analysis.https.add(`${element.name.text}-${name}`);
      }
      // `const grouped = { endpoint }; export { grouped as admin }`, or a group
      // re-exported from a local module by name.
      const group = target ? upstream.groups.get(local) : localGroups.get(local);
      if (group) {
        analysis.groups.set(element.name.text, group);
        for (const member of group) analysis.https.add(`${element.name.text}-${member}`);
      }
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
  return httpsExportGraph(file).https;
}

/**
 * `httpsFunctionExports` plus `opaque`: whether `file` re-exports, directly or
 * through local stars, a star this scan cannot see into (a package or an
 * unresolvable module). A caller that needs the complete export list treats an
 * opaque graph conservatively.
 */
export function httpsExportGraph(file) {
  const results = new Map();
  const size = () =>
    [...results.values()].reduce(
      (n, a) => n + a.https.size + a.factories.size + a.groups.size + (a.opaque ? 1 : 0),
      0,
    );
  let before;
  do {
    before = size();
    analyzeModule(file, results, new Set());
  } while (size() !== before);
  const analysis = results.get(file);
  return { https: analysis.https, opaque: analysis.opaque };
}

/** The names in `names` that are in no invoker family and not private, sorted. */
export function unfamiliedHttpsNames(names) {
  const familied = new Set(CALLABLE_INVOKER_FAMILIES.flatMap((family) => family.exports));
  return [...names]
    .filter((name) => !familied.has(name) && !Object.hasOwn(PRIVATE_HTTPS_EXPORTS, name))
    .sort();
}

/** HTTPS exports of `indexFile` that no invoker family reconciles, by the syntax scan. */
export function unfamiliedHttpsExports(indexFile) {
  return unfamiliedHttpsNames(httpsFunctionExports(indexFile));
}
