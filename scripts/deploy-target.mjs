import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configForTarget, DEPLOY_TARGETS } from './build-target.mjs';

export const DEPLOY_WRAPPER_FLAGS = Object.freeze([
  '--force',
  '--skip-cf-purge',
  '--skip-synthetic',
  '--skip-invoker',
]);

function deployArguments(args) {
  if (args.includes('--skip-build')) {
    throw new Error('A named target deploy always rebuilds its selected target; --skip-build is not allowed.');
  }
  const separator = args.indexOf('--');
  if (separator === -1) return { wrapperArgs: [], deployArgs: args };

  const wrapperArgs = args.slice(0, separator);
  const unsupported = wrapperArgs.filter((argument) => !DEPLOY_WRAPPER_FLAGS.includes(argument));
  if (unsupported.length > 0) {
    throw new Error(
      `Before the deploy-wrapper separator, expected only: ${DEPLOY_WRAPPER_FLAGS.join(', ')}. ` +
        `Unexpected: ${unsupported.join(', ')}.`,
    );
  }
  return { wrapperArgs, deployArgs: args.slice(separator + 1) };
}

export function deployRequest(argv) {
  const args = [...argv];
  const hostingOnly = args[0] === '--hosting';
  if (hostingOnly) args.shift();

  const [target, ...targetArgs] = args;
  if (!target) {
    throw new Error(
      `A deploy target is required. Choose one of: ${Object.keys(DEPLOY_TARGETS).join(', ')}.`,
    );
  }

  const { wrapperArgs, deployArgs } = deployArguments(targetArgs);
  return {
    target,
    wrapperArgs,
    deployArgs: hostingOnly ? ['--only', 'hosting', ...deployArgs] : deployArgs,
  };
}

export function deployInvocation(target, deployArgs = [], inheritedEnv = process.env, wrapperArgs = []) {
  if (wrapperArgs.includes('--skip-build')) {
    throw new Error('A named target deploy always rebuilds its selected target; --skip-build is not allowed.');
  }
  const config = configForTarget(target);
  const args = [...wrapperArgs];
  if (config.skipCloudflarePurge && !args.includes('--skip-cf-purge')) args.push('--skip-cf-purge');
  if (config.skipInvokerReconcile && !args.includes('--skip-invoker')) args.push('--skip-invoker');
  args.push('--', config.firebaseProject, ...deployArgs);

  const environment = {
    ...inheritedEnv,
    BUILD_CMD: `npm run build:${target}`,
  };
  environment.CF_ZONE_ID = config.cloudflareZoneId ?? '';
  environment.SYNTHETIC_URL = config.syntheticUrl;

  return {
    command: resolve(process.cwd(), 'scripts', 'deploy.sh'),
    args,
    environment,
  };
}

function usage() {
  console.error(`Usage: npm run deploy -- <${Object.keys(DEPLOY_TARGETS).join('|')}> [Firebase deploy options]`);
  console.error(`       npm run deploy:hosting -- <${Object.keys(DEPLOY_TARGETS).join('|')}>`);
  console.error('       npm run deploy:<target> -- [deploy-wrapper flags] -- [Firebase deploy options]');
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

  const invocation = deployInvocation(request.target, request.deployArgs, process.env, request.wrapperArgs);
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
