import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/worker-deploy.sh');

/**
 * Run the guard with a stubbed `npm` (and optionally `node` and `grep`) on PATH.
 *
 * The verification is shell, and every finding it has drawn was a shell bug —
 * an unanchored match, a swallowed failure, an unconditional message. Stubbing
 * the commands it shells out to is what makes those assertable instead of
 * reasoned about.
 *
 * There is deliberately no test hook inside the wrapper itself. A deploy guard
 * with an environment-variable bypass is the thing a deploy guard exists to not
 * have, so the negative path is forced by replacing `node` on PATH rather than
 * by teaching the checker to fail on request; the checker's own decision table
 * is proved in `worker/src/routerBinding.test.ts`.
 */
function runWithStubbedNpm({
  secretListJson = null,
  secretListFails = false,
  bindingCheckFails = false,
  bindingCheckExit = 1,
  silentBindingCheck = false,
  routeBearing = false,
  extraEnv = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  const npmCallLog = join(dir, 'npm-calls.log');
  writeFileSync(npmCallLog, '', 'utf8');
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
# Stub: only the secret listing matters; ci/deploy are no-ops.
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
for arg in "$@"; do
  if [[ "$arg" == "secret" ]]; then
    ${secretListFails ? 'exit 1' : `cat <<'JSON'
${secretListJson ?? '[]'}
JSON
exit 0`}
  fi
done
exit 0
`,
    'utf8',
  );
  chmodSync(npm, 0o755);

  if (bindingCheckFails) {
    const node = join(bin, 'node');
    writeFileSync(node, `#!/usr/bin/env bash\nexit ${String(bindingCheckExit)}\n`, 'utf8');
    chmodSync(node, 0o755);
  }

  if (silentBindingCheck) {
    const node = join(bin, 'node');
    writeFileSync(node, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(node, 0o755);
  }

  if (routeBearing) {
    // Route-bearing is now read off the PARSED configuration by the binding
    // check, which prints its answer, rather than grepped for a line. Stubbing
    // `node` is therefore how a route-bearing config is simulated — and it is
    // the same seam `bindingCheckFails` uses, so the two are exclusive.
    const node = join(bin, 'node');
    writeFileSync(node, '#!/usr/bin/env bash\necho "routes=true"\nexit 0\n', 'utf8');
    chmodSync(node, 0o755);
  }

  // `--force` waives the branch/freshness guards; the clean-tree guard has its
  // own override. Both are needed to exercise the verification logic from a
  // working checkout — without DEPLOY_ALLOW_DIRTY the script exits 1 on a dirty
  // tree, which silently looks like a verification failure and lets a broken
  // assertion pass for the wrong reason.
  const result = spawnSync('bash', [script, '--force'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOY_ALLOW_DIRTY: '1',
      NPM_CALL_LOG: npmCallLog,
      ...extraEnv,
    },
  });
  return {
    ...result,
    npmCalls: readFileSync(npmCallLog, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('worker deploy guard — ambient Wrangler environment', () => {
  it('refuses an ambient WRANGLER_CI_OVERRIDE_NAME before certifying the binding', () => {
    // Wrangler deploys under that name while the secret readback still reads
    // the configured one, so the published Worker would go unverified.
    const result = runWithStubbedNpm({ extraEnv: { WRANGLER_CI_OVERRIDE_NAME: 'shadow-router' } });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('WRANGLER_CI_OVERRIDE_NAME is set');
    expect(result.stderr).toContain('unset WRANGLER_CI_OVERRIDE_NAME');
  });

  it('refuses a set CLOUDFLARE_ENV before certifying the binding', () => {
    // Wrangler selects an environment from the variable with no flag, and this
    // wrapper forwards the operator's environment to every Wrangler command it
    // runs. worker/wrangler.toml declares no `[env.<name>]`, and a MISSING
    // section is a warning rather than an error: Wrangler reuses the top-level
    // configuration under the name five-across-event-router-<env>. So the
    // guarded command would publish or inspect a different Worker while every
    // message reported on the production router.
    const result = runWithStubbedNpm({ extraEnv: { CLOUDFLARE_ENV: 'staging' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLOUDFLARE_ENV is set');
    expect(result.stderr).toContain('five-across-event-router-staging');
    expect(result.stderr).toContain('unset CLOUDFLARE_ENV');
    // Refused BEFORE the binding is certified, so no install or Wrangler call
    // runs against the wrong environment.
    expect(result.npmCalls).toEqual([]);
  });

  it('proceeds when it is empty or unset, which is the ordinary case', () => {
    for (const extraEnv of [{}, { CLOUDFLARE_ENV: '' }]) {
      const result = runWithStubbedNpm({ extraEnv });
      expect(result.stderr).not.toContain('CLOUDFLARE_ENV is set');
    }
  });
});

describe('worker deploy guard — argument handling', () => {
  it.each(['--route', '--config', '--cwd', '--domain', '--'])(
    'refuses forwarded Wrangler argument %s',
    (argument) => {
      const result = spawnSync('bash', [script, '--force', argument], { encoding: 'utf8' });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('does not accept Wrangler arguments');
    },
  );
});

describe('worker deploy guard — registry lookup binding', () => {
  it('verifies the committed binding before installing or publishing anything', () => {
    const result = runWithStubbedNpm();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('REGISTRY is bound explicitly to RegistryLookupEntrypoint');
  });

  it('stops before any npm command when the binding check fails', () => {
    // An omitted or `default` entrypoint binds the registry's control-plane
    // fetch. Publishing that and then noticing is the wrong order, so the
    // check runs while nothing has been installed or uploaded.
    const result = runWithStubbedNpm({ bindingCheckFails: true });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it('distinguishes a check that could not RUN from a binding that is wrong', () => {
    // The validator parses the configuration with a ROOT devDependency, and
    // this guard runs before any install. Reporting that as a binding problem
    // would send the operator to edit the one block that is correct, so the
    // "could not run" exit gets its own code and its own instruction.
    const result = runWithStubbedNpm({ bindingCheckFails: true, bindingCheckExit: 69 });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('Could not run the registry binding check');
    // And the instruction has to be the one that WORKS. `smol-toml` is a root
    // devDependency, so a shell carrying NODE_ENV=production or
    // NPM_CONFIG_OMIT=dev omits it — `npm config get omit` reports `dev` under
    // either — and a bare `npm ci` would land the operator back on this exact
    // exit with nothing to show for the install.
    expect(result.stderr).toContain('npm ci --include=dev');
    expect(result.stderr).not.toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it.each([
    // A missing `node`, and one that will not execute. Neither is a verdict
    // about the binding, and only exit 1 is.
    ['a missing interpreter', 127],
    ['an interpreter that cannot run', 126],
  ])('does not report %s as a wrong binding', (_label, exitCode) => {
    const result = runWithStubbedNpm({ bindingCheckFails: true, bindingCheckExit: exitCode });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('Could not run the registry binding check');
    expect(result.stderr).not.toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it('assumes a cutover when the check passes without answering about routes', () => {
    // Fail-closed in the direction that matters: a route-bearing deploy that
    // announced "changes nothing the public sees" is the reassurance this
    // variable exists to withhold.
    const result = runWithStubbedNpm({ silentBindingCheck: true, secretListJson: '[]' });
    expect(result.stderr).toContain('ROUTES CONFIGURED');
    expect(result.stderr).not.toContain('no routes configured');
  });
});

describe('worker deploy guard — no surviving Firebase credential', () => {
  it('passes when the deployed Worker carries no secrets at all', () => {
    // The App Check-compatible router reads no Firebase resource, so the
    // absence of the binding is the expected steady state (#972).
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No FIREBASE_* binding on the deployed Worker');
  });

  it('refuses a deploy that leaves the old edge credential bound', () => {
    const result = runWithStubbedNpm({
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is STILL bound on the deployed Worker: FIREBASE_API_KEY');
    expect(result.stderr).toContain('wrangler secret delete');
  });

  it.each([
    ['a service account', 'FIREBASE_SERVICE_ACCOUNT'],
    ['the project id', 'FIREBASE_PROJECT_ID'],
    ['a near-miss of the api key name', 'FIREBASE_API_KEY_BACKUP'],
  ])('refuses every other Firebase-prefixed secret too (%s)', (_label, name) => {
    // R0 claims the public router carries no Firebase credential of ANY kind,
    // and this readback is the same prefix policy the binding validator
    // applies to plain-text [vars] — the two cannot disagree about what a
    // Firebase credential is.
    const result = runWithStubbedNpm({
      secretListJson: `[{"name":"${name}","type":"secret_text"}]`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`is STILL bound on the deployed Worker: ${name}`);
  });

  it.each([
    ['an entry with no name', '[{}]'],
    ['an entry whose name is not a string', '[{"name":123,"type":"secret_text"}]'],
    ['a non-object entry', '["FIREBASE_API_KEY"]'],
  ])('fails closed when the listing carries %s', (_label, listing) => {
    // The command documents its output as the complete secret list; an element
    // the check cannot read is evidence of nothing, like a non-array listing.
    const result = runWithStubbedNpm({ secretListJson: listing });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unreadable listing');
  });

  it('anchors the prefix at the start of the name rather than matching a substring', () => {
    // An unanchored match would refuse a deploy over an unrelated leftover
    // that merely CONTAINS the prefix.
    const result = runWithStubbedNpm({
      secretListJson:
        '[{"name":"OLD_FIREBASE_API_KEY","type":"secret_text"},{"name":"NOT_A_FIREBASE_THING","type":"secret_text"}]',
    });
    expect(result.status).toBe(0);
  });

  it('treats an uninspectable Worker as a FAILED verification, not a skipped one', () => {
    // Exiting 0 with a warning let automation record an unverified deploy as
    // verified, while the README presents this as artifact verification.
    const result = runWithStubbedNpm({ secretListFails: true });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('FAILED verification');
  });

  it.each([
    ['is not the array it should be', '{"unexpected":"shape"}'],
    ['is not JSON at all', 'wrangler: unexpected diagnostic output'],
    ['is empty', ''],
  ])('fails closed when the secret listing %s', (_label, secretListJson) => {
    // Inverting a check inverts its failure mode. Under the old presence test
    // an unparseable listing made `jq` exit non-zero and the deploy failed
    // closed by accident; under the absence test the same accident would read
    // as proof that no credential is bound.
    const result = runWithStubbedNpm({ secretListJson });
    expect(result.status).toBe(1);
  });
});

describe('worker deploy guard — route-bearing deploys', () => {
  it('installs the locked Wrangler before the pre-publish verification', () => {
    const result = runWithStubbedNpm({
      routeBearing: true,
      secretListJson: '[]',
      extraEnv: { NPM_CONFIG_OMIT: 'dev', NODE_ENV: 'production' },
    });
    expect(result.status).toBe(0);
    expect(result.npmCalls.slice(0, 2)).toEqual([
      '--prefix worker ci --include=dev',
      '--prefix worker exec -- wrangler secret list --format json',
    ]);
  });

  it('does not claim routes are unattached when none are configured', () => {
    // The shipped wrangler.toml keeps `routes` commented out.
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.stderr).toContain('no routes configured');
    expect(result.stderr).not.toContain('CHANGES LIVE TRAFFIC');
  });
});
