import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';

export const DEPLOY_TARGETS = Object.freeze({
  gaycruisebingo: Object.freeze({
    envFile: '.env.gaycruisebingo',
    identity: Object.freeze({
      VITE_FIREBASE_PROJECT_ID: 'gaycruisebingo',
      VITE_FIREBASE_AUTH_DOMAIN: 'gaycruisebingo.com',
      VITE_EVENT_ID: 'med-2026',
      // The app maps this intentionally blank value to its gcb default.
      VITE_EDITION: '',
    }),
  }),
  fiveacross: Object.freeze({
    envFile: '.env.fiveacross',
    identity: Object.freeze({
      VITE_FIREBASE_PROJECT_ID: 'fiveacross',
      VITE_FIREBASE_AUTH_DOMAIN: 'bodega-bay.vacaybingo.com',
      VITE_EVENT_ID: 'bodega-bay-2026',
      VITE_EDITION: 'vacay',
    }),
  }),
});

export function configForTarget(target) {
  const config = DEPLOY_TARGETS[target];
  if (!config) {
    throw new Error(`Unknown deploy target "${target}". Expected one of: ${Object.keys(DEPLOY_TARGETS).join(', ')}.`);
  }
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

  const { identity } = configForTarget(target);
  const mismatchedIdentity = Object.entries(identity).filter(
    ([key, expectedValue]) => parsedTargetEnv[key] !== expectedValue,
  );
  if (mismatchedIdentity.length > 0) {
    const incorrectKeys = mismatchedIdentity
      .map(([key, expectedValue]) => `${key}=${JSON.stringify(expectedValue)}`)
      .join(', ');
    throw new Error(
      `Refusing to build ${target}: its Firebase project, auth domain, Event, and Edition must match this target. ` +
        `Set: ${incorrectKeys}.`,
    );
  }

  // Vite gives existing process variables priority over .env.local. Remove all
  // ambient Vite values, then provide a complete selected target. An incomplete
  // target could otherwise inherit another project's Firebase or Event config.
  const nonViteInheritedEnv = Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => !key.startsWith('VITE_')),
  );
  return { ...nonViteInheritedEnv, ...parsedTargetEnv };
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
