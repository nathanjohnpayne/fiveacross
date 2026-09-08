#!/usr/bin/env node
"use strict";

/**
 * Preloaded into the Firebase Functions SDK's own discovery process, ahead of
 * the artifact, to record whether the codebase consulted any part of the
 * project configuration this classifier cannot obtain.
 *
 * WHY AGREEMENT BETWEEN THE PROBES IS NOT INDEPENDENCE. `CONFIG_PROBES` runs
 * discovery twice, once with the unreproducible `FIREBASE_CONFIG` fields absent
 * and once with them present under obviously synthetic values, and trusts the
 * surface when both runs report the same endpoint ids. That catches an artifact
 * whose branch the two probes happen to separate. It does NOT catch an artifact
 * whose branch is false in both and true for the real project:
 * `config.storageBucket?.startsWith(config.projectId + ".")` is false with no
 * bucket and false for `firebase-deploy-scope-probe.appspot.com`, and true for
 * every real project, whose bucket IS named after it. Both probes agree, one
 * endpoint is reported, and the deploy exports a group.
 *
 * So dependence on configuration this classifier cannot supply is treated as
 * unprovable in its own right, whatever the probes then agree on. Two paths
 * carry it and both are watched:
 *
 *  - the ENVIRONMENT — `CLOUD_RUNTIME_CONFIG`, whose `functions.config()`
 *    namespaces are user-chosen so that a branch on an unknown one reads
 *    `undefined` under both probes, and `FIREBASE_CONFIG`, which is the
 *    project's `adminSdkConfig` and comes from an authenticated lookup;
 *  - the firebase-admin APP OPTIONS, which are the same values read back
 *    through the SDK: `initializeApp()` loads `FIREBASE_CONFIG` itself, so a
 *    codebase reading `admin.app().options.storageBucket` never touches
 *    `process.env` at all.
 *
 * The line in both cases is whether this classifier can REPRODUCE the value, not
 * whether the value came from the project. The pinned project id can be and is
 * reproduced, so a branch on it is rehearsed rather than guessed at and neither
 * `GCLOUD_PROJECT` nor `options.projectId` is watched — see
 * `PROJECT_CONFIG_VARS`, which states what that costs and why the alternative
 * costs more.
 *
 * Each watched value is all-or-nothing, and every access form is trapped rather
 * than just `get`: a membership test or a descriptor read hands the value over
 * just as well.
 *
 * The reads that are NOT consultations are the Firebase SDKs initialising
 * themselves. `firebase-functions`'s v1 `config.js` reads the legacy runtime
 * config while the codebase's top-level `require` is still running, and
 * `firebase-admin`'s `initializeApp()` reads `FIREBASE_CONFIG` to build the very
 * options object the proxy below then watches. Both exemptions are settled by
 * the READER — the frame that actually touched the value — so they belong to
 * those two packages and to nothing else: any other dependency can read a value
 * as it loads and export what it found for the entrypoint to branch on, which is
 * the codebase consulting it with a `require` frame in the way. A codebase that
 * reads the admin options for itself is on the other side of that line, which is
 * exactly what makes the round trip through `initializeApp()` provable rather
 * than a way around the watch.
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
const Module = require("node:module");
/**
 * `Error.prepareStackTrace` as it was when this preload loaded — before any
 * artifact code could replace it. `readingFrames` restores it for the one
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
 * Whether a stack frame's file sits inside an installed copy of `pkg`.
 *
 * Matched on the package DIRECTORY (`node_modules/<pkg>/...`), so a nested or
 * pnpm-style install answers the same while a package whose name merely starts
 * with it does not.
 */
function insidePackage(file, pkg) {
  if (!file) return false;
  const segments = file.split(path.sep);
  for (let at = 0; at + 1 < segments.length; at += 1) {
    if (segments[at] === "node_modules" && segments[at + 1] === pkg) return true;
  }
  return false;
}

/**
 * The two packages whose own reads of the project configuration are the SDK
 * initialising itself rather than the codebase consulting a value.
 *
 * `firebase-functions` reads the legacy runtime config in its v1 `config.js`
 * and the project id wherever an endpoint needs one; `firebase-admin` reads
 * `FIREBASE_CONFIG` in `initializeApp()`, which is the documented way to
 * configure it and the source of the options object this module then watches.
 * Exempting them is what makes the watch land on the codebase's own reads
 * instead of refusing every codebase there is — and it costs nothing, because
 * what `firebase-admin` read on the codebase's behalf is readable back only
 * through those options.
 */
function insideFirebaseSdk(file) {
  return insidePackage(file, "firebase-functions") || insidePackage(file, "firebase-admin");
}

/**
 * Who is reading, and whether the codebase is anywhere in the call.
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
function readingFrames() {
  const root = sourceRoot();
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
  // happened while a dependency was being LOADED, beneath the codebase's own
  // top-level `require`. That is the SDK initialising itself — and ONLY the
  // SDK (barrier round on #1107). Exempting every load-time read let any
  // dependency read the value as it loaded and export what it found for the
  // entrypoint to branch on, which is the codebase consulting a value this
  // classifier cannot reproduce with one `require` frame standing in the way.
  // So a load-time read is settled by the READER — the frame that actually
  // touched `process.env` — rather than by the mere presence of a loader
  // frame. A codebase that consults the value itself calls in directly, with
  // no loader frame in between; and a dependency that reads it through a long
  // chain of helper frames (Phase 4b P2, run 5) has no loader frame in between
  // either, so the full stack above finds the caller.
  let loaderBetween = false;
  /** The frame that read the value: the first frame that is not this preload. */
  let reader = null;
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
    if (reader === null) reader = file;
    if (file.split(path.sep).includes("node_modules")) continue;
    if (root && file.startsWith(root)) return { codebase: true, reader, loaderBetween };
  }
  return { codebase: false, reader, loaderBetween };
}

/**
 * Whether a `CLOUD_RUNTIME_CONFIG` read is the codebase consulting the legacy
 * `functions.config()` namespaces.
 *
 * Unchanged: the codebase on the stack settles it, except for a read reached
 * through a module loader, which is exempt only when `firebase-functions`
 * itself is the frame that made it.
 */
function consultedRuntimeConfig() {
  const { codebase, reader, loaderBetween } = readingFrames();
  if (!codebase) return false;
  if (!loaderBetween) return true;
  return !insidePackage(reader, "firebase-functions");
}

/**
 * Whether a read of the project's identity or its `adminSdkConfig` is the
 * codebase consulting a value this classifier cannot reproduce.
 *
 * The same shape as the rule above and the same load-time discrimination — the
 * READER settles it — with the exempt set being the two Firebase SDKs rather
 * than one, because `firebase-admin` reads `FIREBASE_CONFIG` to build the app
 * options and the codebase's own read of THOSE is watched separately.
 */
function consultedProjectConfig() {
  const { codebase, reader } = readingFrames();
  if (!codebase) return false;
  return !insideFirebaseSdk(reader);
}

/**
 * Whether a read of a firebase-admin app option is one this classifier cannot
 * vouch for.
 *
 * No codebase frame is required here, unlike the environment rules above: the
 * options object is handed out by `initializeApp`, so anything holding it that
 * is neither `firebase-admin` nor `firebase-functions` is reading a project
 * value on its own account, and what it does with the answer is exactly what
 * this classifier cannot rehearse.
 */
function consultedAdminOption(property) {
  if (typeof property !== "string" || !ADMIN_OPTION_KEYS.has(property)) return false;
  return !insideFirebaseSdk(readingFrames().reader);
}

/**
 * The environment variable that carries values this classifier cannot obtain.
 *
 * `prepare.js` fills `FIREBASE_CONFIG` from the project's `adminSdkConfig`, an
 * authenticated lookup, and `CONFIG_PROBES` can only guess at what it holds — so
 * a branch on it is a branch this rehearsal cannot reproduce, however the two
 * probes then agree on the endpoint ids.
 *
 * THE PROJECT ID IS ON THE OTHER SIDE OF THAT LINE, deliberately, and it is the
 * one place this watch is narrower than the finding that prompted it.
 * `discoveryEnvironment` sets `GCLOUD_PROJECT` — and `FIREBASE_CONFIG.projectId`
 * — to the pinned project, which is the real id and the same one the deploy will
 * pass, in both probes. A branch on it is therefore REPRODUCED rather than
 * guessed at, and recording it would refuse an inventory this classifier can in
 * fact vouch for. `GCP_PROJECT`, `GOOGLE_CLOUD_PROJECT` and `FIREBASE_PROJECT`
 * are reproduced the same way, by being absent from `spawnFunctionsProcess`'s
 * environment and from this one alike, unless a `.env` file this classifier also
 * loads supplies them.
 *
 * That distinction is load-bearing for this repository: `functions/src/index.ts`
 * builds `ADMIN_SDK_SERVICE_ACCOUNT` from `resolveProjectId()`, which reads
 * `process.env.GCLOUD_PROJECT` in its own file at module scope. Watching the
 * project id would make this repository's own Functions index unprovable for
 * every `--only functions:<endpoint>` deploy, while proving nothing: the value it
 * reads here is the value it will read then.
 */
const PROJECT_CONFIG_VARS = new Set(["FIREBASE_CONFIG"]);

/**
 * The firebase-admin app options this classifier cannot supply.
 *
 * The same line as above, drawn through the object `initializeApp()` builds:
 * `storageBucket` and `databaseURL` are exactly the `FIREBASE_CONFIG` fields
 * `CONFIG_PROBES` has to invent, and `credential` is the ADC document, which an
 * offline preflight can only shape rather than mint. `projectId` is left out for
 * the reason its environment spelling is: it is the pinned project, correct in
 * both probes.
 */
const ADMIN_OPTION_KEYS = new Set(["storageBucket", "databaseURL", "credential"]);

/** The module requests whose exports hand out a firebase-admin app. */
const ADMIN_ENTRYPOINTS = new Set(["firebase-admin", "firebase-admin/app"]);

/**
 * The exported names that answer with an app (or a list of them).
 *
 * `initializeApp`, `getApp` and `getApps` are the modular API; `app` and `apps`
 * are the same two under the older namespaced export, which is what
 * `admin.app().options` reaches. Wrapping both spellings costs nothing and
 * missing either would leave the options unwatched.
 */
const APP_FACTORIES = ["initializeApp", "getApp", "getApps", "app", "apps"];

if (watching) {
  let recorded = false;
  const record = () => {
    if (recorded) return;
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

  const env = process.env;
  const noticed = (property) => {
    if (recorded) return;
    if (property === "CLOUD_RUNTIME_CONFIG") {
      if (consultedRuntimeConfig()) record();
      return;
    }
    if (typeof property === "string" && PROJECT_CONFIG_VARS.has(property)) {
      if (consultedProjectConfig()) record();
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

  /** Apps already given a recording `options`, so a second lookup adds nothing. */
  const watchedApps = new WeakSet();
  /** Module exports already wrapped, so a cached `require` does not re-wrap them. */
  const watchedExports = new WeakSet();

  /**
   * One app, with its `options` replaced by a recording view of the same values.
   *
   * Defined as an OWN property, which shadows the class getter and leaves the
   * app's identity alone: `instanceof` still answers, and every firebase-admin
   * service that takes an app takes this one. The getter itself returns a fresh
   * deep copy on each read, so pinning one snapshot behind the proxy changes
   * nothing a caller can rely on.
   */
  const watchApp = (app) => {
    if (!app || typeof app !== "object" || watchedApps.has(app)) return app;
    let options;
    try {
      options = app.options;
    } catch {
      return app;
    }
    if (!options || typeof options !== "object") return app;
    watchedApps.add(app);
    const seen = (property) => {
      if (!recorded && consultedAdminOption(property)) record();
    };
    const view = new Proxy(options, {
      get(target, property) {
        seen(property);
        return target[property];
      },
      has(target, property) {
        seen(property);
        return property in target;
      },
      getOwnPropertyDescriptor(target, property) {
        seen(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    try {
      Object.defineProperty(app, "options", {
        configurable: true,
        enumerable: true,
        get: () => view,
      });
    } catch {
      // A frozen app cannot be watched this way. The environment watch above
      // still covers the `FIREBASE_CONFIG` such an app was built from, so this
      // loses a path rather than the whole signal.
    }
    return app;
  };

  const watchAdminExports = (exported) => {
    if (!exported || (typeof exported !== "object" && typeof exported !== "function")) {
      return exported;
    }
    if (watchedExports.has(exported)) return exported;
    watchedExports.add(exported);
    for (const name of APP_FACTORIES) {
      let factory;
      try {
        factory = exported[name];
      } catch {
        continue;
      }
      if (typeof factory !== "function") continue;
      const wrapped = function (...args) {
        const answer = factory.apply(this, args);
        return Array.isArray(answer) ? answer.map(watchApp) : watchApp(answer);
      };
      try {
        Object.defineProperty(exported, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: wrapped,
        });
      } catch {
        // Non-configurable: that spelling goes unwatched, and the others still
        // answer. Nothing here may throw into the codebase's own `require`.
      }
    }
    return exported;
  };

  /**
   * The one place every `require("firebase-admin")` passes through.
   *
   * The alternative — waiting for the codebase to hand an app over — does not
   * exist: `initializeApp()` returns before this module could be told, and the
   * options are read from the value it returned. So the module loader is
   * intercepted instead, which leaves a `Module._load` that is not node's own.
   * That is one more way to tell this process from the deploy's, in the same
   * class as the `process.env` Proxy installed above and answered the same way:
   * a program written to detect the rehearsal can already do so from
   * `$PROJECT_DIR` alone, while withholding this leaves the whole
   * `admin.app().options` path unwatched.
   *
   * An ESM artifact that imports `firebase-admin` reaches the CommonJS module
   * through this loader too. One that imports an ESM build of it would not, and
   * that is the stated residual — no such build is published today.
   */
  const loadModule = Module._load;
  try {
    Object.defineProperty(Module, "_load", {
      configurable: true,
      writable: true,
      value: function (request, parent, isMain) {
        const exported = loadModule.call(this, request, parent, isMain);
        return ADMIN_ENTRYPOINTS.has(request) ? watchAdminExports(exported) : exported;
      },
    });
  } catch {
    // Nothing to do: the environment watch above still covers the
    // `FIREBASE_CONFIG` an app would have been built from.
  }
}
