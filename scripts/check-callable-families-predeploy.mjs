#!/usr/bin/env node
// The authoritative HTTPS export guard (#1283), run by `firebase deploy` as a
// Functions `predeploy` hook right after the build (see firebase.json):
//
//   node scripts/check-callable-families-predeploy.mjs "$RESOURCE_DIR"
//
// Every HTTPS endpoint a Functions deploy publishes must belong to a Cloud Run
// invoker family that `scripts/deploy.sh` reconciles, or be listed in
// PRIVATE_HTTPS_EXPORTS; otherwise Domain Restricted Sharing leaves it answering
// Google's HTML 403 (see `callable-invoker-families.mjs`). The classifier's
// source scan cannot prove that: no syntactic scan is complete over TypeScript,
// and nine review rounds on #1281 each found another form it did not see.
//
// So this hook asks the artifact instead. It runs the same discovery the deploy
// runs next, through firebase-tools' own Node runtime delegate: a committed
// `functions.yaml` is read if there is one, otherwise the SDK's
// `firebase-functions` binary loads the just-built artifact and serves
// `/__/functions.yaml`. Any endpoint with an `httpsTrigger` (onRequest) or a
// `callableTrigger` (onCall) that is in no family and not private fails the
// hook, naming the endpoint, and `firebase deploy` stops before it prepares or
// releases anything. A discovery that cannot answer fails the hook too: the
// deploy's own discovery of the same artifact would have to answer for the
// release to go ahead.
//
// The ids checked are the ids the deploy publishes: `prepare.js` renames every
// discovered endpoint `<prefix>-<id>` when the codebase sets a `prefix` (and
// `kit-<instance>-<id>` for a kit), so the same renaming is applied here, read
// from the project's firebase.json for every Functions config whose source is
// this directory.
//
// Discovery runs with the environment `prepare.js` builds for it, from what a
// hook can know: the source directory's `.env` and `.env.<project id>` files,
// FIREBASE_CONFIG carrying the project id alone (the rest comes from the
// deploy's authenticated lookup), and no legacy runtime config. A codebase
// `configDir`, a `.env.<alias>` file and the fetched config values are not
// mirrored; an artifact whose HTTPS endpoint set depends on them is the
// residual. So is a `firebase deploy --config <other file>` run by hand: the
// prefixes are read from firebase.json, and `deploy.sh` refuses any other
// config for a deploy that may release Functions.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unfamiliedHttpsNames } from "./callable-invoker-families.mjs";

const require = createRequire(import.meta.url);
const { Delegate } = require("firebase-tools/lib/deploy/functions/runtimes/node");
const { getRuntimeChoice } = require("firebase-tools/lib/deploy/functions/runtimes/node/parseRuntimeAndValidateSDK");
const functionsEnv = require("firebase-tools/lib/functions/env");
const { isCallableTriggered, isHttpsTriggered } = require("firebase-tools/lib/deploy/functions/build");
const { addKitPrefix, isKitConfig } = require("firebase-tools/lib/functions/projectConfig");
const { Config } = require("firebase-tools/lib/config");

/** The ids of a discovered build's endpoints that serve HTTPS (onRequest or onCall), sorted. */
export function httpsEndpointIds(discovered) {
  return Object.entries(discovered?.endpoints ?? {})
    .filter(([, endpoint]) => isHttpsTriggered(endpoint) || isCallableTriggered(endpoint))
    .map(([id]) => id)
    .sort();
}

/**
 * The endpoint-id prefixes `firebase deploy` gives the codebase at `sourceDir`,
 * from `projectDir`'s firebase.json: `prepare.js` applies `applyEndpointPrefix`
 * after discovery, with a config's `prefix`, or `kit-<instance>` for each
 * instance of a kit. `""` is no prefix. Every Functions config whose source is
 * `sourceDir` contributes (firebase-tools allows one source under several
 * prefixes); a directory no config names is unprefixed.
 *
 * The config is read as the deploy (and the classifier) reads it, through
 * firebase-tools' own `Config`, so a `functions` key that is an import path is
 * materialized from the file it names. A Functions config the guard does not
 * recognise throws, and the caller refuses: an unreadable shape is never taken
 * to mean "no prefix".
 */
export function codebasePrefixes({ sourceDir, projectDir }) {
  const configFile = join(projectDir, "firebase.json");
  if (!existsSync(configFile)) return [""];
  const config = new Config(JSON.parse(readFileSync(configFile, "utf8")), {
    projectDir,
    cwd: projectDir,
    configPath: "firebase.json",
  });
  const functions = config.get("functions");
  const unrecognised = (entry) =>
    new Error(`firebase.json has a Functions config the export guard does not recognise: ${JSON.stringify(entry)}`);
  const prefixes = new Set();
  for (const entry of functions === undefined ? [] : [functions].flat()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw unrecognised(entry);
    if (entry.source !== undefined && typeof entry.source !== "string") throw unrecognised(entry);
    if (entry.prefix !== undefined && typeof entry.prefix !== "string") throw unrecognised(entry);
    // A remote codebase has no local source; `Config` defaults only a codebase
    // with neither to the CLI's `functions/`.
    if (entry.source === undefined && entry.remoteSource !== undefined) continue;
    if (resolve(projectDir, entry.source ?? "functions") !== resolve(sourceDir)) continue;
    if (isKitConfig(entry)) {
      if (!entry.instances || typeof entry.instances !== "object" || Array.isArray(entry.instances)) throw unrecognised(entry);
      for (const instance of Object.keys(entry.instances)) prefixes.add(addKitPrefix(instance));
    } else {
      prefixes.add(entry.prefix ?? "");
    }
  }
  return prefixes.size > 0 ? [...prefixes] : [""];
}

/** `ids` as the deploy publishes them under each of `prefixes`, sorted. */
export function prefixedEndpointIds(ids, prefixes) {
  const published = new Set();
  for (const prefix of prefixes) for (const id of ids) published.add(prefix ? `${prefix}-${id}` : id);
  return [...published].sort();
}

/**
 * What `firebase deploy` would discover in the built codebase at `sourceDir`,
 * asked through firebase-tools' own Node runtime delegate with the environment
 * `prepare.js` hands it.
 */
export async function discoverBuiltEndpoints({ sourceDir, projectDir, projectId }) {
  // The runtime only labels the build; discovery itself runs the SDK binary.
  let runtime;
  try {
    runtime = getRuntimeChoice(sourceDir, undefined);
  } catch {
    runtime = undefined;
  }
  const delegate = new Delegate(projectId, projectDir, sourceDir, runtime);
  const firebaseConfig = { projectId };
  const userEnvs = functionsEnv.loadUserEnvs({ functionsSource: sourceDir, projectId, projectDir });
  return delegate.discoverBuild(
    { firebase: firebaseConfig },
    { ...userEnvs, ...functionsEnv.loadFirebaseEnvs(firebaseConfig, projectId), GOOGLE_CLOUD_QUOTA_PROJECT: projectId },
  );
}

/**
 * The guard's verdict for one built codebase: `{ ok, message }`. Never throws;
 * a discovery that fails is a refusal.
 */
export async function checkBuiltArtifact({ sourceDir, projectDir, projectId }) {
  let discovered;
  let prefixes;
  try {
    prefixes = codebasePrefixes({ sourceDir, projectDir });
    discovered = await discoverBuiltEndpoints({ sourceDir, projectDir, projectId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `✗ HTTPS export guard: could not discover what the built Functions artifact in ${sourceDir} deploys — ${reason}. ` +
        "Nothing has been released.",
    };
  }
  const endpoints = prefixedEndpointIds(httpsEndpointIds(discovered), prefixes);
  const unfamilied = unfamiliedHttpsNames(endpoints);
  if (unfamilied.length > 0) {
    return {
      ok: false,
      message:
        `✗ Unreconciled HTTPS Function: the built Functions artifact in ${sourceDir} deploys ${unfamilied.join(", ")}, ` +
        "an onCall/onRequest endpoint that belongs to no Cloud Run invoker family, so this deploy would publish it answering an HTML 403. " +
        "Add it to a family in scripts/callable-invoker-families.mjs and that family's scripts/set-*-invoker.sh wrapper (with its deploy.sh registration), " +
        "or list it in PRIVATE_HTTPS_EXPORTS there with the reason it must stay private. Nothing has been released.",
    };
  }
  return {
    ok: true,
    message: `✔ HTTPS export guard: every HTTPS endpoint in the built Functions artifact belongs to an invoker family (${endpoints.length} checked).`,
  };
}

async function main() {
  const sourceArg = process.argv[2] ?? process.env.RESOURCE_DIR;
  const projectId = process.env.GCLOUD_PROJECT;
  let verdict;
  if (!sourceArg || !projectId) {
    verdict = {
      ok: false,
      message:
        "✗ HTTPS export guard: run it as a Functions predeploy hook, with the built source directory as its argument " +
        '(node scripts/check-callable-families-predeploy.mjs "$RESOURCE_DIR") and GCLOUD_PROJECT set by firebase deploy.',
    };
  } else {
    verdict = await checkBuiltArtifact({
      sourceDir: resolve(sourceArg),
      projectDir: resolve(process.env.PROJECT_DIR ?? process.cwd()),
      projectId,
    });
  }
  // Exit explicitly, once the verdict is written: the runtime delegate's
  // teardown arms a ten-second kill timer for the discovery process that would
  // otherwise hold every deploy open after that process has already exited.
  const stream = verdict.ok ? process.stdout : process.stderr;
  stream.write(`${verdict.message}\n`, () => process.exit(verdict.ok ? 0 : 1));
}

// Compared by real path: a hook that reaches this file through a symlinked
// `scripts/` (the classifier's staged project does) must still run the check
// rather than load the module and exit 0 having checked nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
