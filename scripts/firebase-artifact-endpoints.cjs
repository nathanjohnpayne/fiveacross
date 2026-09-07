#!/usr/bin/env node
"use strict";

/**
 * Inventory the endpoint ids a BUILT Firebase Functions codebase would deploy.
 *
 * `firebase deploy --only functions:<name>` matches deployed endpoint IDS, and
 * those ids come from the artifact `package.json.main` points at — never from
 * `src/index.ts`. The predeploy hook, the npm build script (plus npm's implicit
 * `pre`/`post` lifecycle scripts), and tsconfig all sit between the two, and any
 * of them can make the artifact export a surface the source never mentions.
 * Modelling those shells statically is unbounded, so this script does what the
 * deploy does: it loads the artifact and asks it.
 *
 * Run as a CHILD process
 * (`node firebase-artifact-endpoints.cjs <sourceDir> <outFile>`) against a
 * scratch copy of an ALREADY-BUILT codebase, because loading customer code is
 * exactly the thing that must not touch the caller's process. It writes ONE
 * JSON object SYNCHRONOUSLY to `<outFile>`:
 *
 *     {"authoritative":true,"endpoints":[…],"groups":[…]}
 *
 * A file rather than stdout because customer code prints at module scope and
 * because `process.stdout` is asynchronous on a pipe, so an exit could truncate
 * the answer. `authoritative: false` (with a `reason`) is the answer to every
 * uncertainty: an ESM artifact, an unexpected top-level export shape, a cyclic
 * or absurdly deep export graph, or any thrown error. The caller treats an
 * absent or malformed file the same way, so a crash, a signal, or a timeout
 * also fails closed.
 *
 * Discovery is mirrored from the pinned SDK, not paraphrased:
 * `firebase-functions/lib/runtime/loader.js` `extractStack` treats a value as an
 * endpoint when it is a FUNCTION carrying an `__endpoint` OBJECT, recurses into
 * any other object under a `parent-child` id, and skips extension descriptors.
 * `firebase-tools`' Node delegate spawns the SDK's own binary with the source
 * dir as both argv and cwd, and the SDK's `loadModule` does `require(sourceDir)`
 * — so Node's own directory resolution (`package.json.main`, else `index.js`)
 * picks the artifact, and this script resolves it the same way.
 */

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// A group id nested this deep is not a real Functions surface; it is a runaway
// object graph. The SDK's loader has no such bound and would recurse forever.
const MAX_DEPTH = 32;

/**
 * The SDK modules whose `onX` factories BUILD endpoints: the package root, the
 * `v1`/`v2` roots, and their provider subpaths (`v2/scheduler`,
 * `v2/alerts/billing`, …). Deliberately NOT `firebase-functions/params`,
 * `/logger` or `/options`: those export helpers such as `select`, whose real
 * return value is a plain object the loader recurses INTO, so stubbing them as
 * endpoint factories would claim one endpoint where the deploy has several.
 * They load for real (or, if unresolvable, become inert like any other bare
 * module) and their real shapes flow through the walk.
 */
const BUILDER_MODULE = /^firebase-functions(?:\/(?:v1|v2)(?:\/[A-Za-z0-9_.-]+)*)?$/;

/**
 * Native or network-backed packages a Functions entrypoint commonly pulls in at
 * require time. Stubbing them keeps classification offline and credential-free;
 * none of them can produce an endpoint, so an inert value loses no information.
 */
const INERT_MODULE =
  /^(?:firebase-admin|@google-cloud\/[^/]+|@grpc\/[^/]+|sharp|resend|nodemailer)(?:\/.*)?$/;

/**
 * A proxy that answers any access without ever looking like an endpoint.
 *
 * Every stub here wraps a FUNCTION target on purpose. `typeof` is then
 * "function", so the loader's `isObject` never recurses into a stub; a
 * function's own properties (`length`, `name`, `prototype`) are all
 * non-enumerable, so `Object.entries` of one is empty with no `ownKeys` trap
 * (which could not report an empty list anyway — `prototype` is
 * non-configurable); and it is both callable and constructible, which is what a
 * stubbed client such as `new vision.ImageAnnotatorClient()` needs.
 */
function inertProxy() {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "__endpoint" || property === "__requiredAPIs") return undefined;
      return inertProxy();
    },
    apply: () => inertProxy(),
    construct: () => inertProxy(),
  });
}

/** The stand-in for a value a real `onX` factory returned. */
function endpointMarker(moduleName, factory) {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      // The loader's exact discriminator: a function whose `__endpoint` is an
      // object. Mirroring the shape rather than a private tag means a nested
      // provider subpath the SDK adds tomorrow is recognised with no edit here.
      if (property === "__endpoint") return { module: moduleName, factory };
      if (property === "__requiredAPIs") return undefined;
      return inertProxy();
    },
    apply: () => endpointMarker(moduleName, factory),
    construct: () => endpointMarker(moduleName, factory),
  });
}

/**
 * A stubbed SDK namespace. Reading an `onX` name yields a factory whose call
 * returns an endpoint marker; every other name yields another namespace, so
 * v1's chained forms (`functions.region("…").https.onRequest(…)`) resolve
 * without the real SDK, and non-builders (`HttpsError`, `setGlobalOptions`)
 * stay inert exactly as they are at runtime.
 */
function builderNamespace(moduleName, trail) {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "__endpoint" || property === "__requiredAPIs") return undefined;
      // TypeScript's `__importDefault`/`__importStar` helpers branch on this;
      // a truthy answer keeps them from rebuilding the namespace from the
      // target's (non-enumerable) own keys.
      if (property === "__esModule") return true;
      const next = trail ? `${trail}.${property}` : property;
      return /^on[A-Z]/.test(property)
        ? builderFactory(moduleName, next)
        : builderNamespace(moduleName, next);
    },
    apply: () => builderNamespace(moduleName, trail),
    construct: () => builderNamespace(moduleName, trail),
  });
}

/** An `onX` factory: calling it produces an endpoint, reading it does not. */
function builderFactory(moduleName, trail) {
  return new Proxy(function stub() {}, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "__endpoint" || property === "__requiredAPIs") return undefined;
      return builderNamespace(moduleName, `${trail}.${String(property)}`);
    },
    apply: () => endpointMarker(moduleName, trail),
    construct: () => endpointMarker(moduleName, trail),
  });
}

function installModuleStubs() {
  const load = Module._load;
  Module._load = function stubbedLoad(request, parent, isMain) {
    if (BUILDER_MODULE.test(request)) return builderNamespace(request, "");
    if (INERT_MODULE.test(request)) return inertProxy();
    // Everything else loads for real, and a failure PROPAGATES. Turning a
    // `MODULE_NOT_FOUND` into an inert value would change control flow rather
    // than preserve it: an entrypoint that catches an absent optional
    // dependency takes its `catch` branch under the real loader — and may
    // export a group from it — while a successful stub import keeps it on the
    // `try` branch (Codex P2, round 10). Failing closed is the only reading
    // that cannot invent a smaller surface than the deploy will discover.
    return load.call(this, request, parent, isMain);
  };
}

/**
 * `FIREBASE_CONFIG` is the one part of the discovery environment this
 * classifier cannot reproduce exactly: `prepare.js` passes the project's
 * `adminSdkConfig` (projectId, databaseURL, storageBucket, …), which comes from
 * an authenticated Management API call that a local preflight must not make.
 * The `projectId` IS known, and reading it is the ordinary case.
 *
 * So rather than forfeit on any read — which would refuse a codebase that only
 * wants its project id — this watches the boundary. The injected value is
 * parsed exactly once, by whoever consumes it, so wrapping the RESULT of a
 * `JSON.parse` of that exact string records which fields were actually asked
 * for. A field this classifier could not supply is a field whose real value
 * might have selected a different endpoint surface, so asking for one forfeits.
 */
let unsuppliedConfigField = null;
const SUPPLIED_CONFIG_FIELDS = new Set(["projectId"]);

function watchFirebaseConfigReads() {
  const injected = process.env.FIREBASE_CONFIG;
  if (typeof injected !== "string") return;
  const parse = JSON.parse;
  JSON.parse = function watchedParse(text, reviver) {
    const value = parse.call(this, text, reviver);
    if (text !== injected || value === null || typeof value !== "object") return value;
    return new Proxy(value, {
      get(target, property) {
        if (
          typeof property === "string" &&
          !SUPPLIED_CONFIG_FIELDS.has(property) &&
          target[property] === undefined
        ) {
          unsuppliedConfigField = unsuppliedConfigField ?? property;
        }
        return target[property];
      },
    });
  };
}

const isObject = (value) => typeof value === "object" && value !== null;

// Extension descriptors, verbatim from the loader: recognised so they are
// neither counted as endpoints nor recursed into, exactly as the deploy does.
// The `events` clause is part of that predicate and is load-bearing here — a
// near-extension whose `events` is truthy but not an array is NOT an extension
// to the loader, which recurses into it and can find endpoints inside. Skipping
// it would hide them (Codex P2, round 10).
const isExtension = (value) =>
  isObject(value) &&
  typeof value.instanceId === "string" &&
  isObject(value.params) &&
  (!value.events || Array.isArray(value.events)) &&
  (typeof value.FIREBASE_EXTENSION_REFERENCE === "string" ||
    typeof value.FIREBASE_EXTENSION_LOCAL_PATH === "string");

/**
 * Port of `extractStack`. `endpoints` collects deployed ids; `groups` collects
 * the intermediate object names, which is what a `--only functions:<group>`
 * selector expands to.
 */
function walkExports(moduleExports, endpoints, groups, prefix, depth, ancestors) {
  if (depth > MAX_DEPTH) throw new Error("export graph deeper than the walk bound");
  for (const [name, value] of Object.entries(moduleExports)) {
    if (typeof value === "function" && value.__endpoint && typeof value.__endpoint === "object") {
      endpoints.push(prefix + name);
    } else if (isExtension(value)) {
      continue;
    } else if (isObject(value)) {
      // The loader has no cycle guard and would recurse forever; refusing is
      // the fail-closed reading of a graph the deploy could not enumerate.
      if (ancestors.has(value)) throw new Error("cyclic export graph");
      ancestors.add(value);
      groups.push(prefix + name);
      walkExports(value, endpoints, groups, `${prefix + name}-`, depth + 1, ancestors);
      ancestors.delete(value);
    }
  }
}

const outFile = process.argv[3];

function emit(result) {
  fs.writeFileSync(outFile, JSON.stringify(result));
}

function main() {
  const sourceDir = process.argv[2];
  if (!sourceDir || !outFile) {
    if (outFile) emit({ authoritative: false, reason: "no source directory given" });
    return;
  }

  installModuleStubs();
  watchFirebaseConfigReads();

  // Customer code at module scope may print, and the caller parses this
  // stream. Silence both streams across the load and restore them after.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;

  let moduleExports;
  try {
    // `require(<dir>)` is what the SDK's own `loadModule` does, so Node's
    // directory resolution (`package.json.main`, else `index.js`) picks the
    // same artifact the deploy loads.
    moduleExports = require(path.resolve(sourceDir));
  } catch (error) {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    const code = error && error.code ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : String(error);
    emit({ authoritative: false, reason: `artifact did not load — ${code}${message}` });
    return;
  }
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;

  if (!isObject(moduleExports) || Array.isArray(moduleExports)) {
    emit({ authoritative: false, reason: "artifact's top-level exports are not an object" });
    return;
  }

  const endpoints = [];
  const groups = [];
  try {
    walkExports(moduleExports, endpoints, groups, "", 0, new Set());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ authoritative: false, reason: `export walk failed — ${message}` });
    return;
  }
  if (unsuppliedConfigField) {
    emit({
      authoritative: false,
      reason:
        `the artifact read FIREBASE_CONFIG.${unsuppliedConfigField}, which only the ` +
        "deploy's authenticated adminSdkConfig lookup can supply",
    });
    return;
  }
  emit({ authoritative: true, endpoints, groups });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    emit({ authoritative: false, reason: `unexpected failure — ${message}` });
  } catch {
    // An unwritable output path is itself a fail-closed answer: the caller
    // finds no file and refuses.
  }
}
// Customer code can leave timers or handles open; the answer is already on
// stdout, so exit rather than let the child outlive its usefulness.
process.exit(0);
