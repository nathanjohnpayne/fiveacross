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
    writeFileSync(node, '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    chmodSync(node, 0o755);
  }

  if (routeBearing) {
    const grep = join(bin, 'grep');
    writeFileSync(
      grep,
      `#!/usr/bin/env bash
if [[ "$*" == *"worker/wrangler.toml"* ]]; then
  exit 0
fi
exec /usr/bin/grep "$@"
`,
      'utf8',
    );
    chmodSync(grep, 0o755);
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
});

describe('worker deploy guard — no surviving Firebase credential', () => {
  it('passes when the deployed Worker carries no secrets at all', () => {
    // The App Check-compatible router reads no Firebase resource, so the
    // absence of the binding is the expected steady state (#972).
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No FIREBASE_API_KEY binding on the deployed Worker');
  });

  it('refuses a deploy that leaves the old edge credential bound', () => {
    const result = runWithStubbedNpm({
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is STILL bound');
    expect(result.stderr).toContain('wrangler secret delete FIREBASE_API_KEY');
  });

  it('compares the name exactly rather than by substring', () => {
    // The exactness requirement survived the inversion: an unanchored match
    // would refuse a deploy over an unrelated leftover, or — worse, in the
    // other direction — read a near-miss as the live binding.
    const result = runWithStubbedNpm({
      secretListJson:
        '[{"name":"OLD_FIREBASE_API_KEY","type":"secret_text"},{"name":"FIREBASE_API_KEY_BACKUP","type":"secret_text"}]',
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

  it('fails closed when the secret listing is not the array it should be', () => {
    const result = runWithStubbedNpm({ secretListJson: '{"unexpected":"shape"}' });
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
