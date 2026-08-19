import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';

export const REQUIRED_NONBLANK_PRODUCTION_VITE_KEYS = Object.freeze([
  'VITE_FIREBASE_API_KEY',
  'VITE_POSTHOG_KEY',
]);

// Production Firebase web-app identifiers (below) are intentionally public client
// identifiers. These values are the same as those shipped in the client bundle and
// are subject to API restrictions. This registry is the canonical source of truth
// for the deployment targets' configuration.
export const DEPLOY_TARGETS = Object.freeze({
  gaycruisebingo: Object.freeze({
    envFile: '.env.gaycruisebingo',
    firebaseProject: 'gaycruisebingo',
    identity: Object.freeze({
      VITE_FIREBASE_API_KEY: 'AIzaSyDlFSLJD2NVqiheppZBAOvTNAasigJYLoc',
      VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
      VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
      VITE_FIREBASE_STORAGE_BUCKET: 'gaycruisebingo.firebasestorage.app',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '849798007162',
      VITE_FIREBASE_APP_ID: '1:849798007162:web:70dffafa77cc65a8306ec3',
      VITE_FIREBASE_MEASUREMENT_ID: 'G-42N7WYDYT5',
      VITE_EVENT_ID: 'med-2026',
      VITE_EDITION: 'gcb',
      VITE_ADULT_CONTENT: 'true',
      VITE_POSTHOG_HOST: '',
    }),
    cloudflareZoneId: '8066dd2b105ad564c45bb8c898859343',
    skipCloudflarePurge: false,
    syntheticUrl: 'https://gaycruisebingo.com/',
    // submitBugReport / emailUnsubscribe's Cloud Run invoker-IAM workaround
    // (#768) is provisioned only for THIS project — scripts/deploy.sh
    // reconciles it here automatically.
    skipInvokerReconcile: false,
  }),
  fiveacross: Object.freeze({
    envFile: '.env.fiveacross',
    firebaseProject: 'fiveacross',
    identity: Object.freeze({
      VITE_FIREBASE_API_KEY: 'AIzaSyA-JHRrQOmxXzD2rK4FcpyYz_fRMHQdhMQ',
      VITE_FIREBASE_PROJECT_ID: 'fiveacross',
      VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
      VITE_AUTH_HANDOFF_ORIGIN: 'https://auth.fiveacross.app',
      VITE_FIREBASE_STORAGE_BUCKET: 'fiveacross.firebasestorage.app',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '5297095641',
      VITE_FIREBASE_APP_ID: '1:5297095641:web:aff3537cf7c95dec220fc8',
      VITE_FIREBASE_MEASUREMENT_ID: 'G-42N7WYDYT5',
      VITE_EVENT_ID: '',
      VITE_EDITION: 'vacay',
      VITE_ADULT_CONTENT: 'false',
      VITE_POSTHOG_HOST: '',
    }),
    // Static browser/PWA identity for direct-serving Bodega hosts while the
    // shared runtime resolves Event + Edition per hostname. This is deliberately
    // outside VITE_* so it never becomes a runtime routing input (#851/#546).
    staticFallbackEdition: 'vacay',
    syntheticUrl: 'https://bodega-bay.fiveacross.app/',
    skipCloudflarePurge: true,
    // Opted out because this target's deploy credential — the fiveacross
    // Firebase-vault SA key — is not known to hold run.services.update on this
    // project, and Step 1.6 ABORTS BEFORE PUBLISHING on a PERMISSION_DENIED.
    // Enabling it on an unverified assumption would therefore not degrade to a
    // warning; it would break every Five Across deploy outright.
    //
    // The ORIGINAL reason recorded here — that the wrappers would target
    // gaycruisebingo's services from a fiveacross credential — no longer holds:
    // scripts/deploy.sh pins BUG_REPORT_PROJECT / EMAIL_UNSUBSCRIBE_PROJECT /
    // AUTH_HANDOFF_PROJECT to the selected deploy target (#768 r4), so the
    // reconciliation is same-project now. What remains is purely the unproven
    // IAM grant above.
    //
    // ⚠️  THIS SKIP NOW HIDES A REAL GAP (#548, Codex P1 round 4). The auth
    // handoff lives in THIS project, and Domain Restricted Sharing applies
    // here too, so a routine `npm run deploy:fiveacross` releases
    // mintAuthHandoff and exchangeAuthHandoff and leaves both 403 — which is
    // sign-in unavailable on every Event origin, not one degraded feature.
    // deploy.sh prints a loud warning naming the manual repair whenever it
    // skips a release that included the handoff, so the gap is visible rather
    // than silent, and it is harmless only while the handoff has no caller
    // (#549 client half and #547 central origin are both outstanding).
    //
    // TO CLOSE IT: grant the fiveacross deploy SA run.services.update on
    // fiveacross, confirm the wrappers succeed there, then flip this to false.
    // That is a console/IAM action, so it cannot ship in a code PR.
    skipInvokerReconcile: true,
  }),
});

export function validateTargetOperationalMetadata(target, config) {
  if (typeof config.syntheticUrl !== 'string' || !config.syntheticUrl.trim()) {
    throw new Error(`Refusing target ${target}: register a nonblank syntheticUrl.`);
  }
  if (typeof config.skipCloudflarePurge !== 'boolean') {
    throw new Error(`Refusing target ${target}: register skipCloudflarePurge as an explicit boolean.`);
  }
  if (
    config.staticFallbackEdition !== undefined &&
    (typeof config.staticFallbackEdition !== 'string' || !config.staticFallbackEdition.trim())
  ) {
    throw new Error(`Refusing target ${target}: staticFallbackEdition must be a nonblank Edition id.`);
  }
  // Required rather than defaulted (#768). An omitted skipInvokerReconcile
  // reads as `false`, which is the DANGEROUS default for a new target: it
  // sends scripts/deploy.sh at gaycruisebingo's Cloud Run services carrying
  // the new target's own project-scoped deploy credential, which cannot
  // describe them — so the deploy fails on a permissions error for a check
  // that target never needed. The choice is per-project (does this project's
  // org policy impose the same invoker constraint, and is its credential
  // provisioned for it?), so it has to be stated, not inherited.
  if (typeof config.skipInvokerReconcile !== 'boolean') {
    throw new Error(`Refusing target ${target}: register skipInvokerReconcile as an explicit boolean.`);
  }
  if (config.skipCloudflarePurge) {
    if (config.cloudflareZoneId !== undefined) {
      throw new Error(`Refusing target ${target}: a skipped Cloudflare purge must not carry a cloudflareZoneId.`);
    }
    return;
  }
  if (typeof config.cloudflareZoneId !== 'string' || !config.cloudflareZoneId.trim()) {
    throw new Error(`Refusing target ${target}: an enabled Cloudflare purge requires cloudflareZoneId.`);
  }
}

export function configForTarget(target) {
  const config = DEPLOY_TARGETS[target];
  if (!config) {
    throw new Error(`Unknown deploy target "${target}". Expected one of: ${Object.keys(DEPLOY_TARGETS).join(', ')}.`);
  }
  validateTargetOperationalMetadata(target, config);
  return config;
}

export function envFileForTarget(target, root = process.cwd()) {
  return resolve(root, configForTarget(target).envFile);
}

export function requiredViteKeys(templateEnv) {
  return Object.keys(templateEnv).filter((key) => key.startsWith('VITE_'));
}

export function buildEnvironment(target, parsedTargetEnv, inheritedEnv = process.env, requiredKeys = []) {
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(parsedTargetEnv, key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Refusing to build ${target}: its target env file must define every VITE_* key from .env.example. ` +
        `Missing: ${missingKeys.join(', ')}.`,
    );
  }

  const blankProductionKeys = REQUIRED_NONBLANK_PRODUCTION_VITE_KEYS.filter(
    (key) => !parsedTargetEnv[key]?.trim(),
  );
  if (blankProductionKeys.length > 0) {
    throw new Error(
      `Refusing to build ${target}: its production target env file must set nonblank ${blankProductionKeys.join(', ')}.`,
    );
  }

  const { identity, staticFallbackEdition } = configForTarget(target);
  const mismatchedIdentity = Object.entries(identity).filter(
    ([key, expectedValue]) => parsedTargetEnv[key] !== expectedValue,
  );
  if (mismatchedIdentity.length > 0) {
    const incorrectKeys = mismatchedIdentity
      .map(([key, expectedValue]) => `${key}=${JSON.stringify(expectedValue)}`)
      .join(', ');
    throw new Error(
      `Refusing to build ${target}: its registered Firebase web app, auth handoff, Event, Edition, and audience seed must match this target. ` +
        `Set: ${incorrectKeys}.`,
    );
  }

  // Vite gives existing process variables priority over .env.local. Remove all
  // ambient Vite values, then provide a complete selected target. An incomplete
  // target could otherwise inherit another project's Firebase or Event config.
  const nonViteInheritedEnv = Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => !key.startsWith('VITE_')),
  );
  // `vite build` normally reloads root env files after this wrapper has
  // started it. `DEPLOY_TARGET_BUILD` tells vite.config.ts to use only this
  // selected environment and to disable that second env-file load.
  return {
    ...nonViteInheritedEnv,
    ...parsedTargetEnv,
    NODE_ENV: 'production',
    DEPLOY_TARGET_BUILD: '1',
    // Always overwrite this non-VITE build-only input so a target with no
    // fallback cannot inherit another target's ambient value.
    DEPLOY_TARGET_STATIC_EDITION: staticFallbackEdition ?? '',
  };
}

function usage() {
  console.error(`Usage: node scripts/build-target.mjs <${Object.keys(DEPLOY_TARGETS).join('|')}>`);
}

function main() {
  const [target, ...extraArgs] = process.argv.slice(2);
  if (!target || extraArgs.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  let envFile;
  try {
    envFile = envFileForTarget(target);
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
    return;
  }

  if (!existsSync(envFile)) {
    console.error(`Missing ${envFile}. Copy .env.example and fill the ${target} Firebase web-app config.`);
    process.exitCode = 1;
    return;
  }

  const templateFile = resolve(process.cwd(), '.env.example');
  if (!existsSync(templateFile)) {
    console.error(`Missing ${templateFile}; cannot verify the ${target} target env file is complete.`);
    process.exitCode = 1;
    return;
  }

  let environment;
  try {
    environment = buildEnvironment(
      target,
      parse(readFileSync(envFile)),
      process.env,
      requiredViteKeys(parse(readFileSync(templateFile))),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const vite = resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const result = spawnSync(vite, ['build', '--mode', 'production'], { env: environment, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
