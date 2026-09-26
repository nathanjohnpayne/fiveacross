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
// Discovery runs with the environment `prepare.js` builds for it, from what a
// hook can know: the source directory's `.env` and `.env.<project id>` files,
// FIREBASE_CONFIG carrying the project id alone (the rest comes from the
// deploy's authenticated lookup), and no legacy runtime config. A codebase
// `configDir`, a `.env.<alias>` file and the fetched config values are not
// mirrored; an artifact whose HTTPS endpoint set depends on them is the
// residual.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unfamiliedHttpsNames } from "./callable-invoker-families.mjs";

const require = createRequire(import.meta.url);
const { Delegate } = require("firebase-tools/lib/deploy/functions/runtimes/node");
const { getRuntimeChoice } = require("firebase-tools/lib/deploy/functions/runtimes/node/parseRuntimeAndValidateSDK");
const functionsEnv = require("firebase-tools/lib/functions/env");
const { isCallableTriggered, isHttpsTriggered } = require("firebase-tools/lib/deploy/functions/build");

/** The ids of a discovered build's endpoints that serve HTTPS (onRequest or onCall), sorted. */
export function httpsEndpointIds(discovered) {
  return Object.entries(discovered?.endpoints ?? {})
    .filter(([, endpoint]) => isHttpsTriggered(endpoint) || isCallableTriggered(endpoint))
    .map(([id]) => id)
    .sort();
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
  try {
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
  const endpoints = httpsEndpointIds(discovered);
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
