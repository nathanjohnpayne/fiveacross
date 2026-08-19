import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configForTarget, DEPLOY_TARGETS } from './build-target.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = resolve(SCRIPT_DIR, 'deploy.sh');
const AUTH_HANDOFF_INVOKER_SCRIPT = resolve(SCRIPT_DIR, 'set-auth-handoff-invoker.sh');

export const DEPLOY_WRAPPER_FLAGS = Object.freeze([
  '--force',
  '--skip-cf-purge',
  '--skip-synthetic',
  '--skip-invoker',
  '--skip-env-check',
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

function deployInvocationForConfig(target, config, deployArgs, inheritedEnv, wrapperArgs) {
  if (wrapperArgs.includes('--skip-build')) {
    throw new Error('A named target deploy always rebuilds its selected target; --skip-build is not allowed.');
  }
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
  // Pins the Cloud Run invoker reconciliation to the SELECTED target (#768).
  // scripts/deploy.sh clears every ambient BUG_REPORT_* / EMAIL_UNSUBSCRIBE_*
  // override on the automatic path and re-pins the project from this value, so
  // a stale export from an earlier manual repair — `EMAIL_UNSUBSCRIBE_PROJECT=
  // fiveacross` left over in the shell — cannot silently redirect a
  // gaycruisebingo deploy's reconciliation at Five Across while the
  // just-reset gaycruisebingo services keep 403ing. Assigned unconditionally
  // so an inherited value is overwritten, never merged.
  environment.DEPLOY_TARGET_PROJECT = config.firebaseProject;

  return {
    command: DEPLOY_SCRIPT,
    args,
    environment,
  };
}

export function deployInvocation(target, deployArgs = [], inheritedEnv = process.env, wrapperArgs = []) {
  return deployInvocationForConfig(
    target,
    configForTarget(target),
    deployArgs,
    inheritedEnv,
    wrapperArgs,
  );
}

function assertTargetDeployReady(target, config) {
  const handoffOrigin = config.identity?.VITE_AUTH_HANDOFF_ORIGIN?.trim();
  if (!handoffOrigin || !config.skipInvokerReconcile) return;

  throw new Error(
    `Refusing to deploy ${target}: VITE_AUTH_HANDOFF_ORIGIN is active while skipInvokerReconcile is true. ` +
      `Complete #547: grant the Five Across deploy service account run.services.update, ` +
      `successfully apply AUTH_HANDOFF_PROJECT=fiveacross scripts/set-auth-handoff-invoker.sh to both callables, ` +
      `then set skipInvokerReconcile to false. ` +
      `Nothing has been built or published.`,
  );
}

export function executeDeployRequest(
  request,
  config = configForTarget(request.target),
  inheritedEnv = process.env,
  spawn = spawnSync,
) {
  assertTargetDeployReady(request.target, config);

  const handoffOrigin = config.identity?.VITE_AUTH_HANDOFF_ORIGIN?.trim();
  if (handoffOrigin) {
    const readinessEnvironment = { ...inheritedEnv };
    delete readinessEnvironment.AUTH_HANDOFF_PROJECT;
    delete readinessEnvironment.AUTH_HANDOFF_REGION;
    delete readinessEnvironment.AUTH_HANDOFF_MINT_SERVICE;
    delete readinessEnvironment.AUTH_HANDOFF_EXCHANGE_SERVICE;
    readinessEnvironment.AUTH_HANDOFF_PROJECT = config.firebaseProject;

    const readiness = spawn(AUTH_HANDOFF_INVOKER_SCRIPT, [], {
      env: readinessEnvironment,
      stdio: 'inherit',
    });
    if (readiness.error || readiness.status !== 0) {
      const cause = readiness.error ? ` (${readiness.error.message})` : '';
      throw new Error(
        `Refusing to deploy ${request.target}: the pre-build auth-handoff invoker readiness apply failed${cause}; ` +
          `both auth-handoff callables must be reachable before the client build can ship. ` +
          `Complete #547 with AUTH_HANDOFF_PROJECT=${config.firebaseProject} ` +
          `scripts/set-auth-handoff-invoker.sh. Nothing has been built or published.`,
      );
    }
  }

  const invocation = deployInvocationForConfig(
    request.target,
    config,
    request.deployArgs,
    inheritedEnv,
    request.wrapperArgs,
  );
  return spawn(invocation.command, invocation.args, {
    env: invocation.environment,
    stdio: 'inherit',
  });
}

function usage() {
  console.error(`Usage: npm run deploy -- <${Object.keys(DEPLOY_TARGETS).join('|')}> [Firebase deploy options]`);
  console.error(`       npm run deploy:hosting -- <${Object.keys(DEPLOY_TARGETS).join('|')}>`);
  console.error('       npm run deploy:<target> -- [deploy-wrapper flags] -- [Firebase deploy options]');
}

function main() {
  let request;
  let result;
  try {
    request = deployRequest(process.argv.slice(2));
    const config = configForTarget(request.target);
    result = executeDeployRequest(request, config, process.env, spawnSync);
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
    return;
  }

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
