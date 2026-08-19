// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOY_TARGETS } from './build-target.mjs';
import { deployInvocation, deployRequest, executeDeployRequest } from './deploy-target.mjs';
import { classifyFirebaseDeployRequest } from './validate-firebase-deploy-filters.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployTargetScript = resolve(repoRoot, 'scripts', 'deploy-target.mjs');
const deployScript = resolve(repoRoot, 'scripts', 'deploy.sh');

describe('deploy target selection', () => {
  it("classifies Firebase argv, Hosting config, dry-run, and readiness through one public adapter", async () => {
    const result = await classifyFirebaseDeployRequest(
      ["fiveacross", "--account", "--dry-run", "--only", "hosting"],
      { defaultConfigPath: resolve(repoRoot, "firebase.json") },
    );

    expect(result).toMatchObject({
      project: "fiveacross",
      only: "hosting",
      firebaseDryRun: false,
      hostingAttempted: true,
      functionsAttempted: false,
      authHandoffInvokerSelected: false,
    });
  });

  it("rejects a Firebase-invalid option value before returning any scope classification", async () => {
    await expect(
      classifyFirebaseDeployRequest(["fiveacross", "--only", "--dry-run"], {
        defaultConfigPath: resolve(repoRoot, "firebase.json"),
      }),
    ).rejects.toThrow(/Cannot understand what targets/);
  });

  it.each(["hosting functions", "hosting\tfunctions"])(
    "preserves Firebase's comma-only --only grammar for whitespace value %j",
    async (only) => {
      await expect(
        classifyFirebaseDeployRequest(["fiveacross", "--only", only], {
          defaultConfigPath: resolve(repoRoot, "firebase.json"),
        }),
      ).rejects.toThrow(/Cannot understand what targets/);
    },
  );

  it.each(["functions hosting", "functions\thosting"])(
    "preserves Firebase's comma-only --except grammar for whitespace value %j",
    async (except) => {
      const result = await classifyFirebaseDeployRequest(
        ["fiveacross", "--except", except],
        { defaultConfigPath: resolve(repoRoot, "firebase.json") },
      );

      expect(result).toMatchObject({
        except,
        functionsAttempted: true,
        hostingAttempted: true,
        bugReportInvokerSelected: true,
        emailUnsubscribeInvokerSelected: true,
        authHandoffInvokerSelected: true,
      });
    },
  );

  it('requires an explicit deploy target', () => {
    expect(() => deployRequest([])).toThrow('A deploy target is required');
  });

  it.each([
    ["-P", "other-project"],
    ["-Pother-project"],
    ["--project", "other-project"],
    ["--project=other-project"],
    ["-c", "other.firebase.json"],
    ["-cother.firebase.json"],
    ["--config", "other.firebase.json"],
    ["--config=other.firebase.json"],
  ])(
    "rejects named target destination override %s before spawning deploy.sh",
    (...deployArgs) => {
      const calls = [];
      const spawn = (...args) => {
        calls.push(args);
        return { status: 0 };
      };

      expect(() =>
        executeDeployRequest(
          { target: "gaycruisebingo", wrapperArgs: [], deployArgs },
          DEPLOY_TARGETS.gaycruisebingo,
          {},
          spawn,
        ),
      ).toThrow(/cannot override the pinned Firebase (project|config)/);
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["-P", "other-project"],
    ["--project=other-project"],
    ["-cother.firebase.json"],
    ["--config", "other.firebase.json"],
  ])(
    "rejects the actual named CLI destination override %s before deploy.sh",
    (...deployArgs) => {
      const result = spawnSync(
        process.execPath,
        [deployTargetScript, "gaycruisebingo", ...deployArgs],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /cannot override the pinned Firebase (project|config)/,
      );
      expect(result.stderr).toContain("Nothing has been built or published.");
    },
  );

  it('turns the generic hosting entry point into an explicit target deployment', () => {
    expect(deployRequest(['--hosting', 'fiveacross'])).toEqual({
      target: 'fiveacross',
      wrapperArgs: [],
      deployArgs: ['--only', 'hosting'],
    });
  });

  it('refuses Five Across before build or publish while handoff invoker reconciliation is skipped', () => {
    const result = spawnSync(process.execPath, [deployTargetScript, 'fiveacross'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^Refusing to deploy fiveacross: VITE_AUTH_HANDOFF_ORIGIN is active while skipInvokerReconcile is true\./,
    );
    expect(result.stderr).toContain(
      'Complete #547: grant firebase-deployer@fiveacross.iam.gserviceaccount.com run.services.update, ' +
        'successfully run AUTH_HANDOFF_PROJECT=fiveacross scripts/set-auth-handoff-invoker.sh --prove-update ' +
        'under that exact identity for both callables, ' +
        'then set skipInvokerReconcile to false.',
    );
    expect(result.stderr).toContain('Nothing has been built or published.\nUsage:');
  });

  it('refuses the actual Five Across CLI when --skip-invoker would suppress post-Functions repair', () => {
    const result = spawnSync(
      process.execPath,
      [deployTargetScript, 'fiveacross', '--skip-invoker', '--'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Refusing to deploy fiveacross: --skip-invoker is not allowed/);
    expect(result.stderr).toContain('post-Functions handoff repair cannot be skipped');
    expect(result.stderr).toContain('Nothing has been built or published.\nUsage:');
  });

  it('pins Five Across readiness into the canonical hosting deploy entry point', () => {
    const calls = [];
    const readyConfig = {
      ...DEPLOY_TARGETS.fiveacross,
      skipInvokerReconcile: false,
    };
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    const result = executeDeployRequest(
      {
        target: 'fiveacross',
        wrapperArgs: [],
        deployArgs: ['--only', 'hosting'],
      },
      readyConfig,
      {
        KEEP_ME: 'yes',
        AUTH_HANDOFF_PROJECT: 'gaycruisebingo',
        AUTH_HANDOFF_REGION: 'elsewhere',
        AUTH_HANDOFF_MINT_SERVICE: 'wrong-mint',
        AUTH_HANDOFF_EXCHANGE_SERVICE: 'wrong-exchange',
      },
      spawn,
    );

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][1]).toEqual(['--skip-cf-purge', '--', 'fiveacross', '--only', 'hosting']);
    expect(calls[0][2]).toMatchObject({
      cwd: repoRoot,
      env: {
        KEEP_ME: 'yes',
        BUILD_CMD:
          'scripts/firebase/op-firebase-deploy fiveacross --verify-fiveacross-hostnames && npm run build:fiveacross',
        DEPLOY_TARGET_PROJECT: 'fiveacross',
        AUTH_HANDOFF_DEPLOY_READINESS_PROJECT: 'fiveacross',
      },
      stdio: 'inherit',
    });
    expect(calls[0][2].env).not.toHaveProperty('AUTH_HANDOFF_PROJECT');
    expect(calls[0][2].env).not.toHaveProperty('AUTH_HANDOFF_REGION');
    expect(calls[0][2].env).not.toHaveProperty('AUTH_HANDOFF_MINT_SERVICE');
    expect(calls[0][2].env).not.toHaveProperty('AUTH_HANDOFF_EXCHANGE_SERVICE');
  });

  it('pins Five Across readiness into the canonical full deploy entry point', () => {
    const calls = [];
    const readyConfig = {
      ...DEPLOY_TARGETS.fiveacross,
      skipInvokerReconcile: false,
    };
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest({ target: 'fiveacross', wrapperArgs: [], deployArgs: [] }, readyConfig, {}, spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][1]).toEqual(['--skip-cf-purge', '--', 'fiveacross']);
    expect(calls[0][2].env.AUTH_HANDOFF_DEPLOY_READINESS_PROJECT).toBe('fiveacross');
  });

  it('passes only the existing --force break-glass choice into the canonical pre-readiness source guard', () => {
    const calls = [];
    const readyConfig = {
      ...DEPLOY_TARGETS.fiveacross,
      skipInvokerReconcile: false,
    };
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest(
      {
        target: 'fiveacross',
        wrapperArgs: ['--force'],
        deployArgs: ['--only', 'hosting'],
      },
      readyConfig,
      {},
      spawn,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][1][0]).toBe('--force');
  });

  it('delegates source guarding and readiness to one canonical deploy process', () => {
    const calls = [];
    const readyConfig = {
      ...DEPLOY_TARGETS.fiveacross,
      skipInvokerReconcile: false,
    };
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest({ target: 'fiveacross', wrapperArgs: [], deployArgs: [] }, readyConfig, {}, spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][2].env.AUTH_HANDOFF_DEPLOY_READINESS_PROJECT).toBe('fiveacross');
  });

  it('delegates Firebase dry-run while leaving wrapper-owned readiness to deploy.sh', () => {
    const calls = [];
    const readyConfig = {
      ...DEPLOY_TARGETS.fiveacross,
      skipInvokerReconcile: false,
    };
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest({ target: 'fiveacross', wrapperArgs: [], deployArgs: ['--dry-run'] }, readyConfig, {}, spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][1]).toContain('--dry-run');
    expect(calls[0][2].env.AUTH_HANDOFF_DEPLOY_READINESS_PROJECT).toBe('fiveacross');
  });

  it.each(['-m', '--message', '-p', '--public', '--only', '--except'])(
    'forwards the %s value named --dry-run to the canonical scanner unchanged',
    (valueTakingOption) => {
      const calls = [];
      const readyConfig = {
        ...DEPLOY_TARGETS.fiveacross,
        skipInvokerReconcile: false,
      };
      const spawn = (...args) => {
        calls.push(args);
        return { status: 0 };
      };

      const trailingScope = valueTakingOption === '--except' ? [] : ['--only', 'hosting'];
      executeDeployRequest(
        {
          target: 'fiveacross',
          wrapperArgs: [],
          deployArgs: [valueTakingOption, '--dry-run', ...trailingScope],
        },
        readyConfig,
        {},
        spawn,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(deployScript);
      expect(calls[0][1]).toEqual([
        '--skip-cf-purge',
        '--',
        'fiveacross',
        valueTakingOption,
        '--dry-run',
        ...trailingScope,
      ]);
      expect(calls[0][2].env.AUTH_HANDOFF_DEPLOY_READINESS_PROJECT).toBe('fiveacross');
    },
  );

  it('removes an ambient readiness target from Gay Cruise Bingo deploys', () => {
    const calls = [];
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest(
      {
        target: 'gaycruisebingo',
        wrapperArgs: [],
        deployArgs: ['--only', 'hosting'],
      },
      DEPLOY_TARGETS.gaycruisebingo,
      { AUTH_HANDOFF_DEPLOY_READINESS_PROJECT: 'fiveacross' },
      spawn,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][2].env).not.toHaveProperty('AUTH_HANDOFF_DEPLOY_READINESS_PROJECT');
  });

  it('keeps Gay Cruise Bingo on its unchanged single deploy spawn', () => {
    const calls = [];
    const spawn = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    executeDeployRequest(
      {
        target: 'gaycruisebingo',
        wrapperArgs: [],
        deployArgs: ['--only', 'hosting'],
      },
      DEPLOY_TARGETS.gaycruisebingo,
      {},
      spawn,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(deployScript);
    expect(calls[0][1]).toEqual(['--', 'gaycruisebingo', '--only', 'hosting']);
  });

  it('keeps deploy-wrapper flags before Firebase options', () => {
    expect(deployRequest(['gaycruisebingo', '--skip-synthetic', '--', '--only', 'hosting'])).toEqual({
      target: 'gaycruisebingo',
      wrapperArgs: ['--skip-synthetic'],
      deployArgs: ['--only', 'hosting'],
    });
  });

  it('rejects skipping a named target build', () => {
    expect(() => deployRequest(['gaycruisebingo', '--skip-build', '--'])).toThrow('--skip-build');
    expect(() => deployInvocation('gaycruisebingo', [], {}, ['--skip-build'])).toThrow('--skip-build');
  });

  it('keeps Five Across project, build, synthetic, and cache choices together', () => {
    const invocation = deployInvocation('fiveacross', ['--only', 'firestore:rules'], { NODE_ENV: 'production' });

    // fiveacross still plans to skip same-project Cloud Run invoker
    // reconciliation until #547 grants its deploy service account
    // run.services.update on fiveacross. The public CLI guard above refuses
    // before this plan is spawned while the handoff origin is active.
    expect(invocation.args).toEqual([
      '--skip-cf-purge',
      '--skip-invoker',
      '--',
      'fiveacross',
      '--only',
      'firestore:rules',
    ]);
    expect(invocation.environment).toMatchObject({
      NODE_ENV: 'production',
      BUILD_CMD:
        'scripts/firebase/op-firebase-deploy fiveacross --verify-fiveacross-hostnames && npm run build:fiveacross',
      CF_ZONE_ID: '',
      SYNTHETIC_URL: 'https://bodega-bay.fiveacross.app/',
    });
  });

  it('keeps Gay Cruise Bingo project, build, and synthetic choices explicit', () => {
    const invocation = deployInvocation('gaycruisebingo', ['--only', 'hosting'], {
      CF_ZONE_ID: 'an-unrelated-zone',
    });

    // Unlike fiveacross, gaycruisebingo does NOT auto-skip the invoker
    // reconciliation — it is the one project it's provisioned for (#768).
    expect(invocation.args).toEqual(['--', 'gaycruisebingo', '--only', 'hosting']);
    expect(invocation.environment).toMatchObject({
      BUILD_CMD: 'npm run build:gaycruisebingo',
      CF_ZONE_ID: '8066dd2b105ad564c45bb8c898859343',
      SYNTHETIC_URL: 'https://gaycruisebingo.com/',
    });
  });

  // #768 r4 (Codex P2): a stale override from an earlier manual invoker repair
  // must not survive into an automatic reconciliation. deployInvocation is the
  // one place that knows which target was selected, so it stamps the project
  // and scripts/deploy.sh clears the rest.
  it('pins the invoker reconciliation project to the selected target, overriding a stale export', () => {
    const gcb = deployInvocation('gaycruisebingo', [], {
      EMAIL_UNSUBSCRIBE_PROJECT: 'fiveacross',
      BUG_REPORT_PROJECT: 'fiveacross',
      DEPLOY_TARGET_PROJECT: 'fiveacross',
    });
    expect(gcb.environment.DEPLOY_TARGET_PROJECT).toBe('gaycruisebingo');

    const five = deployInvocation('fiveacross', [], { DEPLOY_TARGET_PROJECT: 'gaycruisebingo' });
    expect(five.environment.DEPLOY_TARGET_PROJECT).toBe('fiveacross');
  });

  it('accepts --skip-invoker as a deploy-wrapper flag and keeps it before the separator', () => {
    expect(deployRequest(['gaycruisebingo', '--skip-invoker', '--', '--only', 'hosting'])).toEqual({
      target: 'gaycruisebingo',
      wrapperArgs: ['--skip-invoker'],
      deployArgs: ['--only', 'hosting'],
    });
  });

  // #767: the break-glass escape for the functions/.env.<projectId>
  // param-coverage guard must reach scripts/deploy.sh the same way the other
  // deploy-wrapper flags do.
  it('accepts --skip-env-check as a deploy-wrapper flag and keeps it before the separator', () => {
    expect(deployRequest(['gaycruisebingo', '--skip-env-check', '--', '--only', 'hosting'])).toEqual({
      target: 'gaycruisebingo',
      wrapperArgs: ['--skip-env-check'],
      deployArgs: ['--only', 'hosting'],
    });
  });

  it('preserves the target environment when a wrapper flag is needed', () => {
    const invocation = deployInvocation(
      'gaycruisebingo',
      ['--only', 'hosting'],
      {},
      ['--skip-synthetic'],
    );

    expect(invocation.args).toEqual([
      '--skip-synthetic',
      '--',
      'gaycruisebingo',
      '--only',
      'hosting',
    ]);
    expect(invocation.environment).toMatchObject({
      BUILD_CMD: 'npm run build:gaycruisebingo',
      CF_ZONE_ID: '8066dd2b105ad564c45bb8c898859343',
      SYNTHETIC_URL: 'https://gaycruisebingo.com/',
    });
  });
});
