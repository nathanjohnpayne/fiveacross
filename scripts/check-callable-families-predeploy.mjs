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
// from the project's firebase.json for the Functions config this hook runs for.
// firebase-tools runs a config's predeploy chain once per selected config but
// tells the hook only the source directory (#1329), so when several configs
// share this directory under different prefixes each config's hook entry names
// its codebase (or kit instance) with `--codebase <name>`, and an unnamed hook
// refuses rather than guess or check the union. A config whose own entry names
// a sibling config refuses too, so a copied hook cannot check the wrong prefix.
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
 * instance of a kit. `""` is no prefix. A directory no config names is
 * unprefixed. firebase-tools allows one source under several configs, and a
 * scoped deploy runs the hook only for the selected ones (#1329), so
 * `codebase` (a codebase name, `default` when a config sets none, or a kit
 * instance) selects the config the hook runs for. Unnamed, the configs sharing
 * the source must agree on their prefixes, or this throws naming them.
 *
 * The config is read as the deploy (and the classifier) reads it, through
 * firebase-tools' own `Config`, so a `functions` key that is an import path is
 * materialized from the file it names. A Functions config the guard does not
 * recognise throws, and the caller refuses: an unreadable shape is never taken
 * to mean "no prefix".
 */
export function codebasePrefixes({ sourceDir, projectDir, codebase }) {
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
  const sharing = [];
  for (const entry of functions === undefined ? [] : [functions].flat()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw unrecognised(entry);
    if (entry.source !== undefined && typeof entry.source !== "string") throw unrecognised(entry);
    if (entry.prefix !== undefined && typeof entry.prefix !== "string") throw unrecognised(entry);
    // A remote codebase has no local source; `Config` defaults only a codebase
    // with neither to the CLI's `functions/`.
    if (entry.source === undefined && entry.remoteSource !== undefined) continue;
    if (resolve(projectDir, entry.source ?? "functions") !== resolve(sourceDir)) continue;
    let shared;
    if (isKitConfig(entry)) {
      if (!entry.instances || typeof entry.instances !== "object" || Array.isArray(entry.instances)) throw unrecognised(entry);
      const instances = Object.keys(entry.instances);
      shared = { label: `kit ${entry.kit}`, names: instances, prefixes: instances.map(addKitPrefix) };
    } else {
      const name = entry.codebase ?? "default";
      shared = { label: name, names: [name], prefixes: [entry.prefix ?? ""] };
    }
    // firebase-tools never tells the hook which config it runs for, so the
    // `--codebase` a config's own predeploy entry passes is bound to that config
    // here: a hook copied from a sibling config that still names the sibling
    // would check the sibling's prefixes and pass while this config's ids went
    // unchecked (Codex P1 on #1333), so it refuses instead.
    if (entry.predeploy !== undefined && typeof entry.predeploy !== "string" && !Array.isArray(entry.predeploy)) {
      throw unrecognised(entry);
    }
    for (const named of guardCodebaseArgs(entry.predeploy)) {
      if (!shared.names.includes(named)) {
        throw new Error(
          `the predeploy entry of the Functions config ${shared.label} runs the export guard with --codebase "${named}", ` +
            "which is not that config; each config's guard entry must name its own codebase",
        );
      }
    }
    sharing.push(shared);
  }
  if (codebase !== undefined) {
    const selected = sharing.find(({ names }) => names.includes(codebase));
    if (!selected) {
      throw new Error(`firebase.json has no Functions config for ${sourceDir} with codebase "${codebase}"`);
    }
    return selected.prefixes;
  }
  if (sharing.length === 0) return [""];
  const distinct = new Set(sharing.map(({ prefixes }) => JSON.stringify([...prefixes].sort())));
  if (distinct.size > 1) {
    throw new Error(
      `${sharing.length} Functions configs share ${sourceDir} under different prefixes (${sharing.map(({ label }) => label).join(", ")}), ` +
        "and the hook does not say which one it runs for; pass --codebase <name> after the source directory in each config's predeploy entry",
    );
  }
  return sharing[0].prefixes;
}

/**
 * The `--codebase` values a Functions config's `predeploy` passes to this
 * guard: every name after `--codebase`, bare or quoted, in a shell command that
 * runs `check-callable-families-predeploy.mjs`. firebase-tools runs each hook
 * through a shell, so a hook string is split at `&&`, `||`, `;`, `|` and
 * newlines first, and another command's `--codebase` is not the guard's.
 */
export function guardCodebaseArgs(predeploy) {
  const named = [];
  for (const hook of predeploy === undefined ? [] : [predeploy].flat()) {
    if (typeof hook !== "string") continue;
    for (const command of hook.split(/&&|\|\||[;|\n]/)) {
      if (!command.includes("check-callable-families-predeploy.mjs")) continue;
      for (const match of command.matchAll(/--codebase(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
        named.push(match[1] ?? match[2] ?? match[3]);
      }
    }
  }
  return named;
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
export async function checkBuiltArtifact({ sourceDir, projectDir, projectId, codebase }) {
  let discovered;
  let prefixes;
  try {
    prefixes = codebasePrefixes({ sourceDir, projectDir, codebase });
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
  // `<source dir> [--codebase <name>]`; anything else is a miswired hook.
  const [first, ...rest] = process.argv.slice(2);
  const sourceArg = first ?? process.env.RESOURCE_DIR;
  const projectId = process.env.GCLOUD_PROJECT;
  const wellFormed = rest.length === 0 || (rest.length === 2 && rest[0] === "--codebase" && rest[1] !== "");
  let verdict;
  if (!sourceArg || sourceArg.startsWith("--") || !projectId || !wellFormed) {
    verdict = {
      ok: false,
      message:
        "✗ HTTPS export guard: run it as a Functions predeploy hook, with the built source directory as its argument " +
        '(node scripts/check-callable-families-predeploy.mjs "$RESOURCE_DIR", optionally followed by --codebase <name>) ' +
        "and GCLOUD_PROJECT set by firebase deploy.",
    };
  } else {
    verdict = await checkBuiltArtifact({
      sourceDir: resolve(sourceArg),
      projectDir: resolve(process.env.PROJECT_DIR ?? process.cwd()),
      projectId,
      codebase: rest[1],
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
