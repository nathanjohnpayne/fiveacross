import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Cloud Vision gate for the `moderateProof` export (#126).
 *
 * Cloud Vision is deferred by default: the export is gated OFF until an operator
 * deliberately enables it, so a proof scanner is not deployed before it is
 * wanted (and before the Cloud Vision API is turned on). When enabled, the
 * export is pinned to `region: 'us-east1'` (in index.ts) to match the default
 * Storage bucket, so it deploys cleanly — a `us-central1` trigger on the
 * `us-east1` bucket was an invalid region pairing that failed Firebase's
 * deploy-plan validation and blocked the whole `functions` deploy (including
 * the #101 notifiers).
 *
 * The subtle part is WHERE the flag can be read so the gate actually flips at
 * DEPLOY. Firebase resolves the set of deployed functions during "trigger
 * discovery": firebase-tools spawns this module in a subprocess and reads the
 * endpoint manifest it exports. That subprocess env is SEALED — firebase-tools
 * builds it explicitly from `FIREBASE_CONFIG` + `GCLOUD_PROJECT` (+ a tiny
 * passthrough set) and does NOT load `functions/.env[.<projectId>]` into it
 * (`loadUserEnvs` runs only AFTER discovery, to populate the deployed
 * function's RUNTIME env and to resolve `params`). So a plain
 * `process.env.ENABLE_VISION_MODERATION` read — and equally a
 * `defineBoolean(...).value()`, which just reads the same `process.env` key —
 * is `undefined` at discovery no matter what the operator put in
 * `functions/.env.<projectId>`, and the export would never flip on.
 * (Verified against firebase-tools 15.x `runtimes/node/index.js`
 * `spawnFunctionsProcess`, `deploy/functions/prepare.js` `loadCodebases`, and
 * firebase-functions `params/types.js` `BooleanParam.runtimeValue`.)
 *
 * What firebase-tools DOES guarantee at discovery is `cwd = the functions
 * source dir` (`spawn(..., { cwd: this.sourceDir })`) plus `GCLOUD_PROJECT`.
 * So we read the operator's `.env` files ourselves, from `cwd`, only during
 * discovery. At RUNTIME the platform has already injected the same values into
 * `process.env`, so we short-circuit on `process.env` and never touch disk.
 * The result: `functions/.env.<projectId>` (`ENABLE_VISION_MODERATION=true`)
 * enables the export at deploy exactly as the operator expects, while the
 * default (absent / anything but `'true'`) keeps it OFF.
 */
export function visionModerationEnabled(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  // Runtime, emulator, or any context where the value is already in the
  // environment: trust it. This is the deployed-function path (the platform
  // injects the resolved .env values as real env vars) and keeps a truthy
  // string other than 'true' OFF.
  if (env.ENABLE_VISION_MODERATION !== undefined) {
    return env.ENABLE_VISION_MODERATION === 'true';
  }
  // Only the deploy TRIGGER-DISCOVERY subprocess reaches here with the flag
  // unset; it is the one marked by FUNCTIONS_CONTROL_API. Everywhere else,
  // an unset flag means OFF with no filesystem access.
  if (env.FUNCTIONS_CONTROL_API !== 'true') {
    return false;
  }
  const projectId = resolveProjectId(env);
  // Mirror firebase-tools' precedence: `.env` first, then `.env.<projectId>`
  // overrides it.
  const files = ['.env', projectId ? `.env.${projectId}` : undefined].filter(
    (f): f is string => typeof f === 'string',
  );
  let enabled = false;
  for (const file of files) {
    const value = readEnvKey(join(cwd, file), 'ENABLE_VISION_MODERATION');
    if (value !== undefined) {
      enabled = value === 'true';
    }
  }
  return enabled;
}

/**
 * The deploying/running project id, from the two sources firebase-tools
 * guarantees in the SEALED trigger-discovery subprocess (see the note on
 * `visionModerationEnabled`): `GCLOUD_PROJECT`, else `FIREBASE_CONFIG.projectId`.
 * Exported because `index.ts` needs the same answer to pin a per-project runtime
 * service account at discovery time, where `.env` files are not loaded.
 */
export function resolveProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GCLOUD_PROJECT) {
    return env.GCLOUD_PROJECT;
  }
  if (env.FIREBASE_CONFIG) {
    try {
      const projectId = JSON.parse(env.FIREBASE_CONFIG)?.projectId;
      return typeof projectId === 'string' ? projectId : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Read one KEY from a dotenv file, or `undefined` if the file or key is
 * absent. Deliberately minimal — a single well-known boolean key — but honors
 * the `export ` prefix, surrounding whitespace, trailing comments, and simple
 * single/double quotes, matching the shapes firebase-tools' own parser accepts.
 * Never throws: a missing or malformed file resolves to `undefined` (→ OFF).
 */
function readEnvKey(path: string, key: string): string | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`, 'm').exec(readFileSync(path, 'utf8'));
    if (!line) {
      return undefined;
    }
    const raw = line[1].trimStart();
    // A leading quoted value: take what is inside the quotes and ignore any
    // trailing comment. Otherwise the value runs up to the first `#` comment.
    const quoted = /^(["'])((?:\\.|[^\\])*?)\1/.exec(raw);
    return quoted ? quoted[2] : raw.split('#')[0].trim();
  } catch {
    return undefined;
  }
}

/**
 * #268 (daily-cards-spec § "Admin console" — "AI image screen … now
 * toggleable"): the RUNTIME half of the gate. `visionModerationEnabled`
 * (above) is the deploy-time master kill-switch — it decides whether the
 * moderateProof export exists at all. THIS decides whether an existing
 * deployment SCANS a given upload, by consulting the event's admin-editable
 * `settings.visionGate` at handler time, so the console toggle takes effect
 * without a redeploy.
 *
 * Semantics: scan unless the setting is EXPLICITLY false (absent = on, the
 * seeded default), and FAIL OPEN on a read error — moderation must not
 * silently disable on a transient Firestore hiccup. Takes a minimal
 * Firestore-like seam so the decision is unit-testable without firebase-admin.
 */
export async function shouldScanProof(
  dbLike: { doc(path: string): { get(): Promise<{ get(field: string): unknown }> } },
  eventId: string,
): Promise<boolean> {
  try {
    const snap = await dbLike.doc(`events/${eventId}`).get();
    return snap.get('settings.visionGate') !== false;
  } catch {
    return true;
  }
}
