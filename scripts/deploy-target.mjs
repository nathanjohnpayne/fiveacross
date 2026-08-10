import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configForTarget, DEPLOY_TARGETS } from './build-target.mjs';

export function deployRequest(argv) {
  const args = [...argv];
  const hostingOnly = args[0] === '--hosting';
  if (hostingOnly) args.shift();

  const [target, ...deployArgs] = args;
  if (!target) {
    throw new Error(
      `A deploy target is required. Choose one of: ${Object.keys(DEPLOY_TARGETS).join(', ')}.`,
    );
  }

  return {
    target,
    deployArgs: hostingOnly ? ['--only', 'hosting', ...deployArgs] : deployArgs,
  };
}

export function deployInvocation(target, deployArgs = [], inheritedEnv = process.env) {
  const config = configForTarget(target);
  const args = [];
  if (config.skipCloudflarePurge) args.push('--skip-cf-purge');
  args.push('--', config.firebaseProject, ...deployArgs);

  const environment = {
    ...inheritedEnv,
    BUILD_CMD: `npm run build:${target}`,
  };
  if (config.cloudflareZoneId) environment.CF_ZONE_ID = config.cloudflareZoneId;
  if (config.syntheticUrl) environment.SYNTHETIC_URL = config.syntheticUrl;

  return {
    command: resolve(process.cwd(), 'scripts', 'deploy.sh'),
    args,
    environment,
  };
}

function usage() {
  console.error(`Usage: npm run deploy -- <${Object.keys(DEPLOY_TARGETS).join('|')}> [Firebase deploy options]`);
  console.error(`       npm run deploy:hosting -- <${Object.keys(DEPLOY_TARGETS).join('|')}>`);
}

function main() {
  let request;
  try {
    request = deployRequest(process.argv.slice(2));
    configForTarget(request.target);
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
    return;
  }

  const invocation = deployInvocation(request.target, request.deployArgs);
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.environment,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
