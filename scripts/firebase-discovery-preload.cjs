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
 * The verdict reaches the classifier as a MARKER FILE rather than a return
 * value, because this module has no channel to the HTTP response the SDK
 * serves. `FIREBASE_DEPLOY_SCOPE_RUNTIME_CONFIG_MARKER` names it. Writing is
 * done with a captured `fs.writeFileSync` for the same reason the rest of this
 * design does not trust the loaded artifact: it shares this process.
 */

const fs = require("node:fs");
const path = require("node:path");

const writeFileSync = fs.writeFileSync;
const marker = process.env.FIREBASE_DEPLOY_SCOPE_RUNTIME_CONFIG_MARKER;

// This module is loaded with `--require`, which node consumes rather than
// placing in `process.argv` — but it DOES leave it in `process.execArgv`, and
// the real discovery process has none. Remove the trace before any codebase
// code can read it, so the host this classifier presents is the host the deploy
// presents (Codex P2, round 15).
process.execArgv.length = 0;

/**
 * The codebase's own compiled files, as the SDK binary was pointed at them.
 *
 * The filter matters because the SDK's discovery host reads the environment
 * itself — its own config module consults `CLOUD_RUNTIME_CONFIG` at import
 * time, and libraries in its graph copy the environment wholesale, which reads
 * every key's descriptor. Counting those would refuse every codebase there is.
 * A branch that could change the deployed surface lives in the codebase's own
 * files, so the caller's frame is the discriminator.
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

function calledFromCodebase() {
  const root = sourceRoot();
  if (!root) return false;
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = /\(?((?:\/|[A-Za-z]:\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1];
    if (file === __filename) continue;
    if (!file.startsWith(root)) return false;
    return !file.split(path.sep).includes("node_modules");
  }
  return false;
}

if (marker) {
  const env = process.env;
  let recorded = false;
  const noticed = (property) => {
    if (property !== "CLOUD_RUNTIME_CONFIG" || recorded) return;
    if (!calledFromCodebase()) return;
    recorded = true;
    try {
      writeFileSync(marker, "consulted");
    } catch {
      // The classifier reads the ABSENCE of this file as "not consulted", so a
      // swallowed write failure would be a false negative in the fail-OPEN
      // direction. There is no other channel out of this process that the
      // codebase cannot also reach, so the honest report is to die: discovery
      // then never answers and the classifier refuses (Codex P2, round 15).
      process.abort();
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
