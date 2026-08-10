import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';

export const DEPLOY_TARGETS = Object.freeze({
  gaycruisebingo: '.env.gaycruisebingo',
  fiveacross: '.env.fiveacross',
});

export function envFileForTarget(target, root = process.cwd()) {
  const envFile = DEPLOY_TARGETS[target];
  if (!envFile) {
    throw new Error(`Unknown deploy target "${target}". Expected one of: ${Object.keys(DEPLOY_TARGETS).join(', ')}.`);
  }
  return resolve(root, envFile);
}

export function buildEnvironment(target, parsedTargetEnv, inheritedEnv = process.env) {
  if (parsedTargetEnv.VITE_FIREBASE_PROJECT_ID !== target) {
    throw new Error(
      `Refusing to build ${target}: VITE_FIREBASE_PROJECT_ID must be "${target}", ` +
        `not "${parsedTargetEnv.VITE_FIREBASE_PROJECT_ID ?? ''}".`,
    );
  }

  // Vite gives existing process variables priority over .env.local. Apply the
  // selected target last so a developer's normal local config cannot bake the
  // other Firebase project into a production bundle.
  return { ...inheritedEnv, ...parsedTargetEnv };
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

  let environment;
  try {
    environment = buildEnvironment(target, parse(readFileSync(envFile)), process.env);
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
