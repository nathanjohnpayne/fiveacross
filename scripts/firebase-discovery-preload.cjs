#!/usr/bin/env node
"use strict";

/**
 * Preloaded into the Firebase Functions SDK's own discovery process, ahead of
 * the artifact, to record whether anything consulted `CLOUD_RUNTIME_CONFIG`.
 *
 * Everything else about that environment the classifier can reproduce, and the
 * fields of `FIREBASE_CONFIG` it cannot are covered by running discovery twice
 * under two different values (see `CONFIG_PROBES`). That technique does not
 * work for the legacy runtime config: its `functions.config()` namespaces are
 * user-chosen, so a branch on an unknown one reads `undefined` under both
 * probes while the real value could be anything.
 *
 * So that variable is all-or-nothing. Any read forfeits the inventory — which
 * costs nothing in practice, because its only consumer is the deprecated v1
 * `functions.config()` API. Every access form is trapped, not just `get`: a
 * membership test or a descriptor read hands the value over just as well.
 *
 * The verdict reaches the classifier over FILE DESCRIPTOR 3, which the parent
 * opened and holds. This module has no channel to the HTTP response the SDK
 * serves, and a marker FILE was the wrong substitute: its path had to be in the
 * environment for this module to find it, which put it within reach of the very
 * code being watched — an artifact could consult the runtime config and then
 * unlink the evidence (Codex P2, round 16). A descriptor cannot be unlinked, and
 * closing it only makes the write throw, which fails closed.
 */

const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
/**
 * `Error.prepareStackTrace` as it was when this preload loaded — before any
 * artifact code could replace it. `calledFromCodebase` restores it for the one
 * capture it makes (Codex P2, round 24 on #1107).
 */
const PRISTINE_PREPARE_STACK_TRACE = Error.prepareStackTrace;

// Captured before any codebase code runs, for the same reason the marker is
// written with a captured `writeFileSync`: this module shares its process with
// the artifact, so anything it needs later must be held now.
const writeSync = fs.writeSync;
const abortProcess = process.abort;

/** The descriptor the parent passes as the fourth stdio slot. */
const VERDICT_FD = 3;
const watching = process.env.FIREBASE_DEPLOY_SCOPE_WATCH_RUNTIME_CONFIG === "1";
// Out of the environment before the artifact can read it: nothing downstream
// needs to know this process is being watched.
delete process.env.FIREBASE_DEPLOY_SCOPE_WATCH_RUNTIME_CONFIG;

// This module is loaded with `--require`, which node consumes rather than
// placing in `process.argv` — but it leaves the trace in three other places the
// codebase can read, and the real discovery process has none of them. All three
// are erased HERE, at the top of the only module that runs before the codebase,
// so the host this classifier presents is the host the deploy presents (Codex
// P2, rounds 15 and 17).
//
// The comparison that fixes what "erased" means is a plain `node main.js` with
// no `--require` at all: there `process.execArgv` is `[]`, `require.cache` holds
// only the main module, and `process._preload_modules` is an EMPTY ARRAY — not
// absent. So the list is emptied rather than deleted; deleting the property
// would be a difference of its own.
process.execArgv.length = 0;
// `require.cache` is `Module._cache`, one object shared with every module the
// artifact loads, so `Object.keys(require.cache)` from the artifact would list
// this file by absolute path. Nothing requires this module again — node has
// already run it — so dropping the entry costs nothing.
delete require.cache[__filename];
// `process._preload_modules` is the raw `--require` list node keeps for
// `Module._preloadModules`. The property is non-writable but the ARRAY is
// mutable, and emptying it in place is what leaves the unpreloaded shape.
if (Array.isArray(process._preload_modules)) process._preload_modules.length = 0;
// Preloads are children of node's internal `internal/preload` parent module,
// whose `children` array is reachable from any module object. Splice this one
// out of it.
{
  const parent = module.parent;
  const at = parent && Array.isArray(parent.children) ? parent.children.indexOf(module) : -1;
  if (at !== -1) parent.children.splice(at, 1);
}

/**
 * The codebase's own compiled files, as the SDK binary was pointed at them.
 *
 * The filter matters because the SDK's discovery host reads the environment
 * itself — libraries in its graph copy the environment wholesale, which reads
 * every key's descriptor. Counting those would refuse every codebase there is.
 * A branch that could change the deployed surface lives in the codebase's own
 * files, so a codebase frame ON THE STACK is the discriminator.
 */
let sourceRootCache;
function sourceRoot() {
  if (sourceRootCache === undefined) {
    try {
      // Realpath, because Node reports module filenames resolved (a scratch
      // dir's `/var/…` is `/private/var/…` on macOS) and a prefix test against
      // the unresolved path would silently never match — failing OPEN.
      sourceRootCache = fs.realpathSync(path.resolve(process.argv[2] ?? "."));
    } catch {
      sourceRootCache = null;
    }
  }
  return sourceRootCache;
}

/**
 * Whether the codebase is anywhere in the call that is reading the environment.
 *
 * The WHOLE stack, not just its first frame. Stopping at the first non-preload
 * frame missed the very API this watch exists for: `functions.config()` reads
 * `CLOUD_RUNTIME_CONFIG` inside `firebase-functions/lib/v1/config.js`, so the
 * nearest frame is the SDK's and the codebase's own frame — the one that CALLED
 * it — sat one line further down. A `functions.config().feature?.enabled`
 * branch therefore selected a group during deployment while both synthetic
 * probes read `undefined`, agreed on one endpoint, and reported no consultation
 * (Codex P2, round 18).
 *
 * Frames inside any `node_modules` are skipped rather than answered on: the SDK
 * reading the value on the codebase's behalf is the codebase reading it, and a
 * dependency reading it for reasons of its own is not — what settles it either
 * way is whether a file the codebase itself supplied is still on the stack.
 */
function calledFromCodebase() {
  const root = sourceRoot();
  if (!root) return false;
  // The WHOLE stack, not Node's default ten frames (Phase 4b P2, run 5): a
  // dependency reading the value through enough helper frames would otherwise
  // push the codebase frame past the limit, and every remaining frame is a
  // skipped dependency frame — the read would be waved through.
  // Generated under the stack machinery captured BEFORE any artifact code
  // ran (Codex P2, round 24 on #1107): an artifact that installs its own
  // `Error.prepareStackTrace` before reading the value would otherwise format
  // this stack — and a formatter that drops the codebase frames would turn a
  // consulted read into a waved-through one.
  const previousLimit = Error.stackTraceLimit;
  const previousPrepare = Error.prepareStackTrace;
  Error.stackTraceLimit = Infinity;
  Error.prepareStackTrace = PRISTINE_PREPARE_STACK_TRACE;
  let stack;
  try {
    stack = new Error().stack ?? "";
  } finally {
    Error.stackTraceLimit = previousLimit;
    Error.prepareStackTrace = previousPrepare;
  }
  // A module-loader frame between the reader and the codebase means the read
  // happened while a dependency was being LOADED — `firebase-functions`'s own
  // v1 `config.js` reads the variable at module load, beneath the codebase's
  // top-level `require` — which is the dependency initialising itself, not the
  // codebase consulting the value. A codebase that does consult it calls into
  // the SDK directly, with no loader frame in between; and a dependency that
  // reads it through a long chain of helper frames (Phase 4b P2, run 5) has no
  // loader frame in between either, so the full stack above finds the caller.
  let loaderBetween = false;
  for (const line of stack.split("\n").slice(1)) {
    if (/\bModule\.(?:_load|_compile|require|load)\b|node:internal\/modules\//.test(line)) {
      loaderBetween = true;
      continue;
    }
    // An ESM frame is reported as a `file://` URL rather than a path (Phase 4b
    // P2, run 4); it is converted before the root test so an ESM artifact's
    // own frames count as the codebase reading the value.
    const match = /\(?((?:file:\/\/\/|\/|[A-Za-z]:\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    let file = match[1];
    if (file.startsWith("file://")) {
      try {
        file = url.fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (file === __filename) continue;
    if (file.split(path.sep).includes("node_modules")) continue;
    if (file.startsWith(root)) return !loaderBetween;
  }
  return false;
}

if (watching) {
  const env = process.env;
  let recorded = false;
  const noticed = (property) => {
    if (property !== "CLOUD_RUNTIME_CONFIG" || recorded) return;
    if (!calledFromCodebase()) return;
    recorded = true;
    try {
      writeSync(VERDICT_FD, "consulted");
    } catch {
      // The classifier reads SILENCE as "not consulted", so a swallowed write
      // failure would be a false negative in the fail-OPEN direction. If the
      // descriptor is gone there is no honest way to report, so die: discovery
      // then never answers and the classifier refuses (Codex P2, rounds 15-16).
      abortProcess.call(process);
    }
  };
  Object.defineProperty(process, "env", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: new Proxy(env, {
      get(target, property) {
        noticed(property);
        return target[property];
      },
      has(target, property) {
        noticed(property);
        return property in target;
      },
      getOwnPropertyDescriptor(target, property) {
        noticed(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }),
  });
}
