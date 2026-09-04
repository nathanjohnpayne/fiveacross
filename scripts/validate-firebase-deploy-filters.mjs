#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const commander = require("commander");
const ts = require("typescript");
const {
  command: firebaseDeployCommand,
} = require("firebase-tools/lib/commands/deploy");
const {
  checkValidTargetFilters,
} = require("firebase-tools/lib/checkValidTargetFilters");
const { Config } = require("firebase-tools/lib/config");
const { VALID_DEPLOY_TARGETS } = require("firebase-tools/lib/deploy");
const { filterTargets } = require("firebase-tools/lib/filterTargets");
const {
  extract,
  filterExcept,
  filterOnly,
} = require("firebase-tools/lib/hosting/config");

// Deploy-command options come directly from the pinned firebase-tools module.
// This small global subset covers options that change destination or whose
// value can look like another flag, without loading the full Firebase CLI for
// every local preflight.
const FIREBASE_GLOBAL_OPTIONS = Object.freeze([
  ["-P, --project <alias_or_project_id>", "the Firebase project to use"],
  ["--account <email>", "the Google account to use"],
  ["--token <token>", "the Firebase authorization token"],
  ["-c, --config <path>", "path to firebase.json"],
  ["-j, --json", "output JSON"],
  ["--non-interactive", "disable interactive prompts"],
  ["-i, --interactive", "force interactive prompts"],
  ["--debug", "enable debug logging"],
]);

export function assertNoNamedDestinationOverride(args) {
  const projectOverride = args.some(
    (argument) =>
      argument === "-P" ||
      argument.startsWith("-P") ||
      argument === "--project" ||
      argument.startsWith("--project="),
  );
  if (projectOverride) {
    throw new Error(
      "A named deploy target cannot override the pinned Firebase project with -P/--project. " +
        "Nothing has been built or published.",
    );
  }

  const configOverride = args.some(
    (argument) =>
      argument === "-c" ||
      argument.startsWith("-c") ||
      argument === "--config" ||
      argument.startsWith("--config="),
  );
  if (configOverride) {
    throw new Error(
      "A named deploy target cannot override the pinned Firebase config with -c/--config. " +
        "Nothing has been built or published.",
    );
  }
}

function hasNamedDestinationOverride(args) {
  try {
    assertNoNamedDestinationOverride(args);
    return false;
  } catch {
    return true;
  }
}

function normalizeAttachedDestinationOptions(args) {
  return args.flatMap((argument) => {
    if (/^-P.+/.test(argument)) return ["-P", argument.slice(2)];
    if (/^-c.+/.test(argument)) return ["-c", argument.slice(2)];
    return [argument];
  });
}

function parseFirebaseOptions(args) {
  const parser = new commander.Command("deploy");
  parser.unknownOption = (flag) => {
    throw new Error(`unknown option '${flag}'`);
  };
  parser.optionMissingArgument = (option) => {
    throw new Error(`option '${option.flags}' requires a value`);
  };
  for (const option of FIREBASE_GLOBAL_OPTIONS) parser.option(...option);
  for (const option of firebaseDeployCommand.options) parser.option(...option);

  const parsed = parser.parseOptions(
    parser.normalize(normalizeAttachedDestinationOptions(args)),
  );
  if (parsed.unknown.length > 0) parser.unknownOption(parsed.unknown[0]);
  return { operands: parsed.args, options: parser.opts() };
}

function normalizedFilter(value) {
  // firebase-tools splits filter lists on commas only. Whitespace remains part
  // of the selector and must reach its pinned validators unchanged.
  return value || undefined;
}

const EVENT_INVITATION_EXPORTS = Object.freeze([
  ["mintEventInvitation", "mint"],
  ["redeemEventInvitation", "redeem"],
  ["revokeEventInvitation", "revoke"],
]);

function eventInvitationServicesFromSource(source) {
  const exportedNames = new Set();
  let hasRuntimeExportStar = false;
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
      }
      continue;
    }
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.exportClause) {
      // Resolving an export-star requires traversing the module graph. Treat it
      // as possibly exporting every protected callable instead of silently
      // skipping invoker repair for a service Firebase may discover.
      hasRuntimeExportStar = true;
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        if (!specifier.isTypeOnly) exportedNames.add(specifier.name.text);
      }
    }
  }
  if (hasRuntimeExportStar) {
    for (const [exportName] of EVENT_INVITATION_EXPORTS) exportedNames.add(exportName);
  }
  return EVENT_INVITATION_EXPORTS.filter(([exportName]) =>
    exportedNames.has(exportName),
  ).map(([, service]) => service);
}

/**
 * The exported names in a Functions source that are provably a SINGLE endpoint
 * rather than a group, plus whether that answer is authoritative.
 *
 * This exists because `--only functions:X` is ambiguous at the string level.
 * Firebase's own grammar gives a group the same bare shape as an endpoint —
 * `exports.metrics = require('./metrics')` deploys as `--only functions:metrics`
 * (https://firebase.google.com/docs/functions/organize-functions) — so a
 * selector alone cannot say whether it releases one endpoint or a module's
 * whole surface, which may include a protected callable.
 *
 * The discriminator is therefore the INITIALIZER, not the name. A single
 * endpoint is `export const NAME = <builder>(...)` where `<builder>` was
 * imported from `firebase-functions`. That deliberately excludes the two group
 * shapes: `require('./x')` is also a CallExpression but its callee is not a
 * firebase-functions import, and an object literal is not a call at all.
 *
 * FAILS CLOSED on every uncertainty. An unparsable file, a runtime
 * `export *` (whose module graph is not traversed here, matching
 * `eventInvitationServicesFromSource`), a re-export, or a builder reached
 * through a namespace import all leave the name out of the set, which returns
 * the caller to the conservative branch it would have taken anyway. The set
 * only ever REMOVES false conservatism; it can never mark a protected callable
 * as unrelated, because those match their own explicit selector branches long
 * before the fallback consults this.
 */
function singleEndpointExportsFromSource(source) {
  const builders = new Set();
  const endpoints = new Set();
  // Every exported binding, endpoint or not. A name that is exported but NOT
  // proven to be a builder call (a group, a re-export) must veto the
  // unqualified exemption rather than merely fail to support it.
  const exports = new Set();
  let authoritative = true;
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(
      "index.ts",
      source,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
  } catch {
    return { endpoints, exports, authoritative: false };
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    // EXACT package boundary. A prefix test would trust
    // `firebase-functions-wrapper`, whose factory may return an object the
    // runtime loader then discovers as a group of separate endpoints.
    const from = specifier.text;
    if (from !== "firebase-functions" && !from.startsWith("firebase-functions/"))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) builders.add(element.name.text);
      }
    }
  }

  // TypeScript preserves a CommonJS assignment in its emit, and the runtime
  // loader recursively discovers an object's members as separate endpoints — so
  // `export const daily = onSchedule(...)` followed by
  // `exports.daily = require('./group')` deploys a GROUP under a name this
  // parser proved was an endpoint. Any such mutation forfeits authority.
  if (/(^|[^.\w])(?:module\s*\.\s*)?exports\s*(?:\.|\[)/.test(source)) {
    authoritative = false;
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (!statement.exportClause) authoritative = false;
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    // CONST ONLY. `export let daily = onSchedule(...)` followed by
    // `daily = { submitBugReport }` rebinds the export with no `exports.` text
    // for the mutation guard to see; TypeScript updates the binding in its emit
    // and the loader then discovers the object's members. A `const` cannot be
    // reassigned, so requiring it removes the whole class rather than hunting
    // for assignments.
    const isConst =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exports.add(declaration.name.text);
      }
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      exports.add(declaration.name.text);
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      if (!ts.isIdentifier(initializer.expression)) continue;
      if (!builders.has(initializer.expression.text)) continue;
      endpoints.add(declaration.name.text);
    }
  }

  return { endpoints, exports, authoritative };
}

/**
 * Per-codebase single-endpoint inventory, plus the codebase names Firebase
 * treats as selector targets. Mirrors the pinned CLI rather than paraphrasing
 * it; each rule below cites the behaviour it matches.
 *
 * `codebaseNames` mirrors `getCodebasesFromConfig`: the EXPLICIT `codebase`
 * values (and a kit config's instance keys). An implicit default contributes
 * nothing, exactly as `[c.codebase]` contributes `undefined` there. This set is
 * what gives a codebase name precedence over an endpoint id, so it must include
 * codebases this parser cannot read — a `remoteSource` codebase is still a
 * configured codebase (`projectConfig.js` accepts `source` OR `remoteSource`),
 * and omitting its name would let `functions:<name>` be read as a same-named
 * local endpoint while Firebase deploys that codebase's whole surface.
 *
 * Authority is tracked PER CODEBASE. `endpointMatchesFilter` rejects an
 * endpoint whose codebase differs from the filter's, so uncertainty in `beta`
 * cannot widen an explicitly qualified `alpha` deployment.
 */
async function singleEndpointInventory(configSource, configPath) {
  const functionsConfigs = Array.isArray(configSource.functions)
    ? configSource.functions
    : [configSource.functions];
  /** @type {Map<string, { endpoints: Set<string>, exports: Set<string>, authoritative: boolean }>} */
  const byCodebase = new Map();
  const codebaseNames = new Set();

  const entryFor = (codebase) => {
    let entry = byCodebase.get(codebase);
    if (!entry) {
      entry = { endpoints: new Set(), exports: new Set(), authoritative: true };
      byCodebase.set(codebase, entry);
    }
    return entry;
  };

  for (const functionsConfig of functionsConfigs) {
    if (!functionsConfig || typeof functionsConfig !== "object") continue;

    if ("kit" in functionsConfig) {
      // Kit instance keys are codebase names; their endpoints come from
      // somewhere this parser does not read.
      for (const instance of Object.keys(functionsConfig.instances ?? {})) {
        codebaseNames.add(instance);
        entryFor(instance).authoritative = false;
      }
      continue;
    }

    const explicitCodebase =
      typeof functionsConfig.codebase === "string" && functionsConfig.codebase
        ? functionsConfig.codebase
        : "";
    if (explicitCodebase) codebaseNames.add(explicitCodebase);
    const codebase = explicitCodebase || "default";
    const entry = entryFor(codebase);

    if (typeof functionsConfig.source !== "string" || !functionsConfig.source) {
      // A remoteSource codebase (or any shape without a readable local source)
      // exists and can be deployed; it simply cannot be proven from here.
      entry.authoritative = false;
      continue;
    }

    // The CLI picks its runtime delegate from the configured runtime, so a
    // `python311` codebase with decoy TypeScript would otherwise be "proven"
    // from source Firebase never reads.
    const runtime = functionsConfig.runtime;
    if (typeof runtime === "string" && !runtime.startsWith("nodejs")) {
      entry.authoritative = false;
      continue;
    }

    // A configured `prefix` rewrites deployed ids to `<prefix>-<name>`, so an
    // inventory of RAW export names no longer describes what a selector
    // matches. Refuse rather than model the rewrite.
    if (functionsConfig.prefix) {
      entry.authoritative = false;
      continue;
    }

    // The CLI loads `package.json.main || "index.js"` — the BUILT artifact, not
    // the TypeScript this parser reads. Only the conventional Firebase TS
    // layout lets one stand in for the other, so anything else forfeits
    // authority instead of assuming the mapping holds.
    if (
      !(await entrypointIsConventionalTypeScript(
        resolve(dirname(configPath), functionsConfig.source),
      ))
    ) {
      entry.authoritative = false;
      continue;
    }

    const sourcePath = resolve(
      dirname(configPath),
      functionsConfig.source,
      "src",
      "index.ts",
    );
    let source;
    try {
      source = await readFile(sourcePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        // "Unreadable" must not degrade to "exports nothing dangerous".
        entry.authoritative = false;
        continue;
      }
      throw error;
    }
    const parsed = singleEndpointExportsFromSource(source);
    if (!parsed.authoritative) entry.authoritative = false;
    for (const name of parsed.endpoints) entry.endpoints.add(name);
    for (const name of parsed.exports) entry.exports.add(name);
  }
  return { byCodebase, codebaseNames };
}

/**
 * Whether `<source>/src/index.ts` is provably the TypeScript that compiles to
 * the entry point Firebase will load. Requires the conventional layout:
 * `package.json.main` = `<outDir>/index.js`, tsconfig `rootDir` = `src`.
 * Everything else — a custom main, a non-Node runtime, an unreadable or
 * unparsable manifest — returns false and costs only the exemption.
 */
async function entrypointIsConventionalTypeScript(sourceDir) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  // With no configured runtime the CLI detects one; only a declared Node
  // engine makes "this TypeScript is the entry point" a safe reading.
  if (!pkg.engines || typeof pkg.engines.node === "undefined") return false;
  const main = typeof pkg.main === "string" ? pkg.main : "index.js";
  let tsconfig;
  try {
    const raw = await readFile(resolve(sourceDir, "tsconfig.json"), "utf8");
    tsconfig = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return false;
  }
  const options = tsconfig.compilerOptions ?? {};
  if (options.rootDir !== "src") return false;
  if (typeof options.outDir !== "string" || !options.outDir) return false;
  const normalize = (value) => value.replace(/^\.\//, "").replace(/\/+/g, "/");
  return normalize(main) === normalize(`${options.outDir}/index.js`);
}

/**
 * Whether `selector` provably releases exactly one endpoint that is not a
 * protected callable. Fails closed on every uncertainty.
 */
function selectorIsProvableSingleEndpoint(selector, inventory) {
  const tail = selector.slice("functions:".length);
  if (!tail) return false;
  const fragments = tail.split(":");
  if (fragments.length > 2) return false;

  let codebase;
  let name;
  if (fragments.length === 2) {
    // Both branches of parseFunctionSelector that see two fragments yield
    // `{codebase: fragments[0], idChunks: fragments[1]}` — whether or not the
    // first fragment is a CONFIGURED codebase. An unconfigured one simply
    // matches no endpoint, and falls out below as an absent inventory entry.
    codebase = fragments[0];
    name = fragments[1];
  } else if (inventory.codebaseNames.has(fragments[0])) {
    // Codebase precedence with no id fragment: the filter carries no idChunks,
    // so `endpointMatchesFilter` admits that codebase's every endpoint.
    return false;
  } else {
    // `fragments.length < 2` resolves to DEFAULT_CODEBASE, so an unqualified
    // selector never reaches another codebase and must not be vetoed by one.
    codebase = "default";
    name = fragments[0];
  }

  // idChunks split the ID fragment on `-` and `.`, then match
  // `id === prefix || id.startsWith(prefix + "-")`. Either separator makes the
  // selector a prefix/group filter rather than one endpoint. Applied to the ID
  // fragment ONLY: hyphens are valid in codebase names (`validateCodebase`).
  if (name.includes(".") || name.includes("-")) return false;

  const entry = inventory.byCodebase.get(codebase);
  if (!entry || !entry.authoritative) return false;
  // Exported but unproven (a group, a re-export) vetoes rather than abstains.
  if (entry.exports.has(name) && !entry.endpoints.has(name)) return false;
  return entry.endpoints.has(name);
}

async function eventInvitationServiceInventory(configSource, configPath) {
  const functionsConfigs = Array.isArray(configSource.functions)
    ? configSource.functions
    : [configSource.functions];
  const services = new Set();
  for (const functionsConfig of functionsConfigs) {
    if (!functionsConfig || typeof functionsConfig.source !== "string") continue;
    const sourcePath = resolve(
      dirname(configPath),
      functionsConfig.source,
      "src",
      "index.ts",
    );
    let source;
    try {
      source = await readFile(sourcePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const service of eventInvitationServicesFromSource(source))
      services.add(service);
  }
  return EVENT_INVITATION_EXPORTS.map(([, service]) => service).filter(
    (service) => services.has(service),
  );
}

function classifyInvokerScope(
  only,
  exceptTargets,
  exportedEventInvitationServices,
  singleEndpointExports = { byCodebase: new Map(), codebaseNames: new Set() },
) {
  const exportedInvitationServices = new Set(exportedEventInvitationServices);
  const exportedInvitationCsv = EVENT_INVITATION_EXPORTS.map(
    ([, service]) => service,
  )
    .filter((service) => exportedInvitationServices.has(service))
    .join(",");
  let functionsAttempted = true;
  let hostingAttempted = true;
  let bugReportInvokerSelected = true;
  let emailUnsubscribeInvokerSelected = true;
  let authHandoffInvokerSelected = true;
  let eventInvitationsInvokerSelected = exportedInvitationServices.size > 0;
  let bugReportInvokerConservative = false;
  let emailUnsubscribeInvokerConservative = false;
  let authHandoffInvokerConservative = false;
  let eventInvitationsInvokerConservative = false;
  let authHandoffStrictHalf = "";
  let eventInvitationsStrictServices = exportedInvitationCsv;

  if (only) {
    functionsAttempted = false;
    hostingAttempted = false;
    bugReportInvokerSelected = false;
    emailUnsubscribeInvokerSelected = false;
    authHandoffInvokerSelected = false;
    eventInvitationsInvokerSelected = false;
    let mintNamed = false;
    let exchangeNamed = false;
    let fullEventInvitationScopeNamed = false;
    let unknownFunctionsSelectorNamed = false;
    const namedEventInvitationServices = new Set();

    for (const selector of only.split(",")) {
      if (selector === "hosting" || selector.startsWith("hosting:")) {
        hostingAttempted = true;
      } else if (selector === "functions" || selector === "functions:default") {
        functionsAttempted = true;
        bugReportInvokerSelected = true;
        emailUnsubscribeInvokerSelected = true;
        authHandoffInvokerSelected = true;
        eventInvitationsInvokerSelected = exportedInvitationServices.size > 0;
        mintNamed = true;
        exchangeNamed = true;
        fullEventInvitationScopeNamed = true;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
        eventInvitationsInvokerConservative = false;
      } else if (/^functions:(?:[^:]+:)?submitBugReport$/.test(selector)) {
        functionsAttempted = true;
        bugReportInvokerSelected = true;
        bugReportInvokerConservative = false;
      } else if (/^functions:(?:[^:]+:)?emailUnsubscribe$/.test(selector)) {
        functionsAttempted = true;
        emailUnsubscribeInvokerSelected = true;
        emailUnsubscribeInvokerConservative = false;
      } else if (/^functions:(?:[^:]+:)?mintAuthHandoff$/.test(selector)) {
        functionsAttempted = true;
        authHandoffInvokerSelected = true;
        mintNamed = true;
      } else if (/^functions:(?:[^:]+:)?exchangeAuthHandoff$/.test(selector)) {
        functionsAttempted = true;
        authHandoffInvokerSelected = true;
        exchangeNamed = true;
      } else if (/^functions:(?:[^:]+:)?mintEventInvitation$/.test(selector)) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("mint");
      } else if (
        /^functions:(?:[^:]+:)?redeemEventInvitation$/.test(selector)
      ) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("redeem");
      } else if (
        /^functions:(?:[^:]+:)?revokeEventInvitation$/.test(selector)
      ) {
        functionsAttempted = true;
        eventInvitationsInvokerSelected = true;
        namedEventInvitationServices.add("revoke");
      } else if (selector.startsWith("functions:")) {
        functionsAttempted = true;
        // `functions:[codebase:]name` — a DOTTED tail is a group path
        // (`--only functions:group1.subgroup1`), never a single endpoint, so it
        // is left to the conservative branch below along with everything the
        // inventory cannot vouch for.
        if (selectorIsProvableSingleEndpoint(selector, singleEndpointExports)) {
          // A named endpoint that the source proves is a builder call, not a
          // group. It cannot release a protected callable, so it selects no
          // invoker and forces no conservatism. Protected callables never reach
          // here — each has its own branch above.
          continue;
        }
        unknownFunctionsSelectorNamed = true;
        if (!bugReportInvokerSelected) bugReportInvokerConservative = true;
        if (!emailUnsubscribeInvokerSelected)
          emailUnsubscribeInvokerConservative = true;
        if (!authHandoffInvokerSelected) authHandoffInvokerConservative = true;
        if (!eventInvitationsInvokerSelected)
          eventInvitationsInvokerConservative = true;
        bugReportInvokerSelected = true;
        emailUnsubscribeInvokerSelected = true;
        authHandoffInvokerSelected = true;
        eventInvitationsInvokerSelected = true;
      }
    }

    if (authHandoffInvokerSelected) {
      if (mintNamed && exchangeNamed) {
        authHandoffInvokerConservative = false;
      } else if (mintNamed) {
        authHandoffInvokerConservative = false;
        authHandoffStrictHalf = "mint";
      } else if (exchangeNamed) {
        authHandoffInvokerConservative = false;
        authHandoffStrictHalf = "exchange";
      }
    }

    if (eventInvitationsInvokerSelected) {
      if (fullEventInvitationScopeNamed) {
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = exportedInvitationCsv;
      } else if (namedEventInvitationServices.size > 0) {
        // An explicit endpoint name is a fact even when another unfamiliar
        // selector appears in the same request. Keep every explicitly named
        // service strict and tolerate absence only for its unselected peers.
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = ["mint", "redeem", "revoke"]
          .filter((service) => namedEventInvitationServices.has(service))
          .join(",");
      } else {
        eventInvitationsInvokerConservative = unknownFunctionsSelectorNamed;
        eventInvitationsStrictServices = "";
      }
    } else {
      eventInvitationsStrictServices = "";
    }
  } else if (exceptTargets) {
    for (const selector of exceptTargets.split(",")) {
      if (selector === "hosting") hostingAttempted = false;
      if (selector === "functions") {
        functionsAttempted = false;
        bugReportInvokerSelected = false;
        emailUnsubscribeInvokerSelected = false;
        authHandoffInvokerSelected = false;
        eventInvitationsInvokerSelected = false;
        bugReportInvokerConservative = false;
        emailUnsubscribeInvokerConservative = false;
        authHandoffInvokerConservative = false;
        eventInvitationsInvokerConservative = false;
        eventInvitationsStrictServices = "";
      }
      // firebase-tools subtracts --except selectors from exact top-level
      // target names. Every colon-qualified Functions exclusion is a no-op.
    }
  }

  return {
    functionsAttempted,
    hostingAttempted,
    bugReportInvokerSelected,
    emailUnsubscribeInvokerSelected,
    authHandoffInvokerSelected,
    eventInvitationsInvokerSelected,
    bugReportInvokerConservative,
    emailUnsubscribeInvokerConservative,
    authHandoffInvokerConservative,
    eventInvitationsInvokerConservative,
    authHandoffStrictHalf,
    eventInvitationsStrictServices,
  };
}

export async function classifyFirebaseDeployRequest(
  args,
  {
    defaultProject = "",
    defaultConfigPath = "firebase.json",
    rejectDestinationOverrides = false,
  } = {},
) {
  if (rejectDestinationOverrides && hasNamedDestinationOverride(args)) {
    assertNoNamedDestinationOverride(args);
  }

  const { operands, options } = parseFirebaseOptions(args);
  if (operands.length > 1)
    throw new Error("too many Firebase deploy project arguments");

  const positionalProject = operands[0] ?? "";
  let project = options.project || defaultProject || positionalProject;
  if (!project) {
    try {
      const rc = JSON.parse(await readFile(resolve(".firebaserc"), "utf8"));
      project = rc.projects?.default ?? "";
    } catch {
      // firebase-tools reports the missing project later. Classification stays
      // useful for repos whose local-only deploy checks do not need one.
    }
  }
  const configPath = resolve(options.config ?? defaultConfigPath);
  const only = normalizedFilter(options.only);
  const exceptTargets = normalizedFilter(options.except);
  const configSource = JSON.parse(await readFile(configPath, "utf8"));
  const exportedEventInvitationServices =
    await eventInvitationServiceInventory(configSource, configPath);
  const singleEndpointExports = await singleEndpointInventory(
    configSource,
    configPath,
  );
  // deploy's before-chain runs this target reduction before
  // checkValidTargetFilters. It is the pinned rejection boundary for an
  // option-looking required value such as `--only --dry-run`: Commander owns
  // `--dry-run` as the --only value, then filterTargets rejects that value as
  // an unknown deploy target before any build can start.
  filterTargets(
    {
      only,
      except: exceptTargets,
      config: new Config(configSource, { projectDir: dirname(configPath) }),
    },
    [...VALID_DEPLOY_TARGETS],
  );
  await checkValidTargetFilters({ only, except: exceptTargets });
  const hostingOptions = {
    config: { src: configSource },
    site: project || undefined,
  };
  let hostingConfigs = extract(hostingOptions);
  hostingConfigs = filterOnly(hostingConfigs, only);
  hostingConfigs = filterExcept(hostingConfigs, exceptTargets);

  return {
    project,
    configPath,
    only: only ?? "",
    except: exceptTargets ?? "",
    firebaseDryRun: options.dryRun === true,
    ...classifyInvokerScope(
      only,
      exceptTargets,
      exportedEventInvitationServices,
      singleEndpointExports,
    ),
    hostingAttempted: hostingConfigs.length > 0,
  };
}

function printShellClassification(result) {
  const fields = {
    DEPLOY_PROJECT: result.project,
    FUNCTIONS_ATTEMPTED: result.functionsAttempted,
    HOSTING_ATTEMPTED: result.hostingAttempted,
    FIREBASE_DRY_RUN: result.firebaseDryRun,
    BUG_REPORT_INVOKER_SELECTED: result.bugReportInvokerSelected,
    EMAIL_UNSUBSCRIBE_INVOKER_SELECTED: result.emailUnsubscribeInvokerSelected,
    AUTH_HANDOFF_INVOKER_SELECTED: result.authHandoffInvokerSelected,
    EVENT_INVITATIONS_INVOKER_SELECTED: result.eventInvitationsInvokerSelected,
    BUG_REPORT_INVOKER_CONSERVATIVE: result.bugReportInvokerConservative,
    EMAIL_UNSUBSCRIBE_INVOKER_CONSERVATIVE:
      result.emailUnsubscribeInvokerConservative,
    AUTH_HANDOFF_INVOKER_CONSERVATIVE: result.authHandoffInvokerConservative,
    AUTH_HANDOFF_STRICT_HALF: result.authHandoffStrictHalf,
    EVENT_INVITATIONS_INVOKER_CONSERVATIVE:
      result.eventInvitationsInvokerConservative,
    EVENT_INVITATIONS_STRICT_SERVICES: result.eventInvitationsStrictServices,
  };
  for (const [key, value] of Object.entries(fields))
    console.log(`${key}=${value}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  try {
    const result = await classifyFirebaseDeployRequest(args, {
      defaultProject: process.env.FIREBASE_DEPLOY_DEFAULT_PROJECT ?? "",
      defaultConfigPath:
        process.env.FIREBASE_DEPLOY_DEFAULT_CONFIG ?? "firebase.json",
      rejectDestinationOverrides:
        process.env.FIREBASE_DEPLOY_REJECT_OVERRIDES === "true",
    });
    if (process.env.FIREBASE_DEPLOY_CLASSIFIER_FORMAT === "shell")
      printShellClassification(result);
    else console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Invalid Firebase deploy request: ${message}.`);
    console.error("  NOTHING HAS BEEN BUILT OR PUBLISHED.");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
