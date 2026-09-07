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
 * NOTHING IS STUBBED. An early revision replaced `firebase-functions`,
 * `firebase-admin` and the native packages with proxies, which was a mistake of
 * the same shape as the static modelling it replaced: a stub changes control
 * flow. A caught `MODULE_NOT_FOUND` takes its `catch` branch under the real
 * loader; `admin.apps.length === 0` is true under the real uninitialized SDK and
 * false against a proxy; `onInit()` really returns `undefined` while a marker
 * factory returns something truthy — and each divergence can hide a nested
 * endpoint (Codex P2, rounds 10 and 11). The codebase's own dependencies are
 * installed, the deploy loads them, and so does this: the artifact is required
 * exactly as `firebase-functions/lib/runtime/loader.js` `loadModule` requires
 * it, under the environment `prepare.js` gives the discovery process.
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
 * The one part of the discovery environment the caller cannot reproduce is the
 * CONTENT of `FIREBASE_CONFIG` and `CLOUD_RUNTIME_CONFIG`, which come from
 * authenticated lookups. That is not handled here: the caller runs this script
 * TWICE under two different values for those variables and forfeits unless both
 * runs report the same ids, which is what makes the answer independent of the
 * fields it could not supply — however the artifact chose to inspect them.
 *
 * Discovery is mirrored from the pinned SDK, not paraphrased: `extractStack`
 * treats a value as an endpoint when it is a FUNCTION carrying an `__endpoint`
 * OBJECT, recurses into any other object under a `parent-child` id, and skips
 * extension descriptors. `firebase-tools`' Node delegate spawns the SDK's own
 * binary with the source dir as both argv and cwd, and the SDK's `loadModule`
 * does `require(sourceDir)` — so Node's own directory resolution
 * (`package.json.main`, else `index.js`) picks the artifact, and this script
 * resolves it the same way.
 */

const fs = require("node:fs");
const path = require("node:path");

// A group id nested this deep is not a real Functions surface; it is a runaway
// object graph. The SDK's loader has no such bound and would recurse forever.
const MAX_DEPTH = 32;

/**
 * Whether anything read `CLOUD_RUNTIME_CONFIG`.
 *
 * The caller's differential probe handles `FIREBASE_CONFIG`, whose schema is
 * fixed, by running twice with those fields absent and present. It cannot do
 * the same for the legacy runtime config, whose namespaces are user-chosen and
 * unbounded: a branch on `config().someNamespace` reads `undefined` under both
 * probes while the real value could be anything (Codex P2, round 12).
 *
 * So this variable is all-or-nothing. Reading it at all forfeits — and that
 * costs almost nothing, because the only consumer is `functions.config()`, the
 * deprecated v1 API, which a codebase using it cannot be classified offline
 * anyway.
 */
let readRuntimeConfig = false;

function watchRuntimeConfigReads() {
  const env = process.env;
  Object.defineProperty(process, "env", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: new Proxy(env, {
      get(target, property) {
        if (property === "CLOUD_RUNTIME_CONFIG") readRuntimeConfig = true;
        return target[property];
      },
      has(target, property) {
        if (property === "CLOUD_RUNTIME_CONFIG") readRuntimeConfig = true;
        return property in target;
      },
    }),
  });
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

  watchRuntimeConfigReads();

  // Customer code at module scope may print, and the caller captures this
  // stream for diagnostics. Silence both across the load and restore after.
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
  if (readRuntimeConfig) {
    emit({
      authoritative: false,
      reason:
        "the artifact consulted CLOUD_RUNTIME_CONFIG, whose legacy functions.config() " +
        "namespaces only the deploy's authenticated fetch can supply",
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
// Customer code can leave timers or handles open; the answer is already
// written, so exit rather than let the child outlive its usefulness.
process.exit(0);
