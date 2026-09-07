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
 * or absurdly deep export graph, a read of a config field only the deploy's
 * authenticated lookup could supply, or any thrown error. The caller treats an
 * absent or malformed file the same way, so a crash, a signal, or a timeout
 * also fails closed.
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
 * The environment variables whose CONTENT this classifier can only partly
 * reproduce, mapped to the fields it can vouch for.
 *
 * `prepare.js` hands discovery the project's `adminSdkConfig` in
 * `FIREBASE_CONFIG` and its legacy runtime config in `CLOUD_RUNTIME_CONFIG`,
 * both of which come from authenticated API calls a local preflight must not
 * make. The project id IS known, and reading it is the ordinary case — this
 * repository's own `visionGate.ts` does — so forfeiting on any read would
 * refuse the very codebase this exists to exempt.
 *
 * So the boundary is watched instead. Each variable's value is parsed by
 * whoever consumes it, so wrapping the RESULT of a `JSON.parse` of that exact
 * string records what was actually asked for. A field this classifier could not
 * supply is a field whose real value might have selected a different endpoint
 * surface, so touching one forfeits — and "touching" covers membership,
 * descriptor and enumeration access, not just reads, because `"x" in config`
 * discriminates just as well as `config.x` (Codex P2, round 11).
 */
const SUPPLIED_CONFIG_FIELDS = {
  FIREBASE_CONFIG: new Set(["projectId"]),
  // Only the `firebase` key is reproducible; every legacy `functions.config()`
  // namespace comes from the API. The nested value is itself the
  // FIREBASE_CONFIG object and is wrapped with those rules.
  CLOUD_RUNTIME_CONFIG: new Set(["firebase"]),
};

/** The first unsupplied field any watched config object was asked about. */
let unsuppliedConfigField = null;

/**
 * Whether the code that just touched a watched config object is the ARTIFACT's
 * own, as opposed to a dependency's.
 *
 * This matters because the SDKs read these objects themselves — `firebase-admin`
 * probes `credential`, `databaseURL` and `storageBucket` while initializing —
 * and those reads are not branches on the endpoint surface. Forfeiting on them
 * would refuse every codebase that calls `initializeApp()`, which is all of
 * them. A branch that could change what gets deployed lives in the codebase's
 * own compiled files, so the caller's frame is the discriminator.
 */
let artifactRootCache;
function artifactRoot() {
  if (artifactRootCache === undefined) {
    try {
      artifactRootCache = fs.realpathSync(path.resolve(process.argv[2] ?? ""));
    } catch {
      artifactRootCache = null;
    }
  }
  return artifactRootCache;
}

function calledFromArtifact() {
  // Realpath, because Node reports module filenames resolved (on macOS the
  // scratch dir's `/var/...` is `/private/var/...`) and a prefix test against
  // the unresolved path would silently never match — failing OPEN.
  const sourceDir = artifactRoot();
  if (!sourceDir) return false;
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = /\(?((?:\/|[A-Za-z]:\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1];
    if (file === __filename) continue;
    if (!file.startsWith(sourceDir)) return false;
    return !file.split(path.sep).includes("node_modules");
  }
  return false;
}

function watchedConfigObject(value, variable) {
  const supplied = SUPPLIED_CONFIG_FIELDS[variable];
  const flag = (property) => {
    if (typeof property !== "string" || supplied.has(property)) return;
    if (!calledFromArtifact()) return;
    unsuppliedConfigField = unsuppliedConfigField ?? `${variable}.${property}`;
  };
  const enumerated = () => {
    if (!calledFromArtifact()) return;
    unsuppliedConfigField = unsuppliedConfigField ?? `${variable} (enumerated)`;
  };
  return new Proxy(value, {
    get(target, property) {
      // A field that IS supplied and is itself a watched shape stays watched.
      if (variable === "CLOUD_RUNTIME_CONFIG" && property === "firebase") {
        const nested = target[property];
        return nested && typeof nested === "object"
          ? watchedConfigObject(nested, "FIREBASE_CONFIG")
          : nested;
      }
      // Reading an absent field is what a branch does; reading a supplied one
      // is the ordinary case and must stay free.
      if (target[property] === undefined) flag(property);
      return target[property];
    },
    has(target, property) {
      flag(property);
      return property in target;
    },
    getOwnPropertyDescriptor(target, property) {
      flag(property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target) {
      // Enumeration cannot say which key mattered, and the real object has
      // more of them, so any enumeration is a difference.
      enumerated();
      return Reflect.ownKeys(target);
    },
  });
}

function watchConfigReads() {
  const watched = Object.keys(SUPPLIED_CONFIG_FIELDS)
    .map((variable) => [variable, process.env[variable]])
    .filter(([, injected]) => typeof injected === "string");
  if (watched.length === 0) return;
  const parse = JSON.parse;
  JSON.parse = function watchedParse(text, reviver) {
    const value = parse.call(this, text, reviver);
    if (value === null || typeof value !== "object") return value;
    const match = watched.find(([, injected]) => text === injected);
    return match ? watchedConfigObject(value, match[0]) : value;
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

  watchConfigReads();

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
  if (unsuppliedConfigField) {
    emit({
      authoritative: false,
      reason:
        `the artifact consulted ${unsuppliedConfigField}, which only the deploy's ` +
        "authenticated project-config lookup can supply",
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
