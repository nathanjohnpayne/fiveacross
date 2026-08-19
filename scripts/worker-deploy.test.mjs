import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/worker-deploy.sh');

/**
 * Run the guard with a stub `npm` on PATH.
 *
 * The secret verification is shell, and every finding it has drawn was a shell
 * bug — an unanchored match, a swallowed failure, an unconditional message.
 * Stubbing the one command it shells out to is what makes those assertable
 * instead of reasoned about.
 */
function runWithStubbedNpm({
  secretListJson = null,
  secretListFails = false,
  routeBearing = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  const npmCallLog = join(dir, 'npm-calls.log');
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
    },
  });
  return {
    ...result,
    npmCalls: readFileSync(npmCallLog, 'utf8').trim().split('\n'),
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

describe('worker deploy guard — required-secret verification', () => {
  it('passes when the exact binding is present', () => {
    const result = runWithStubbedNpm({
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('FIREBASE_API_KEY is bound');
  });

  it('refuses a NEAR-MISS binding name rather than substring-matching it', () => {
    // `grep -q FIREBASE_API_KEY` accepted these and printed a green success
    // while the real binding was absent — a false pass that, once routes are
    // attached, means every uncached hostname fails closed.
    const result = runWithStubbedNpm({
      secretListJson:
        '[{"name":"OLD_FIREBASE_API_KEY","type":"secret_text"},{"name":"FIREBASE_API_KEY_BACKUP","type":"secret_text"}]',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is NOT bound');
  });

  it('fails when no bindings exist at all', () => {
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.status).toBe(1);
  });

  it('treats an uninspectable Worker as a FAILED verification, not a skipped one', () => {
    // Exiting 0 with a warning let automation record an unverified deploy as
    // verified, while the README presents this as artifact verification.
    const result = runWithStubbedNpm({ secretListFails: true });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('FAILED verification');
  });
});

describe('worker deploy guard — route-bearing deploys', () => {
  it('installs the locked Wrangler before pre-publish secret verification', () => {
    const result = runWithStubbedNpm({
      routeBearing: true,
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.status).toBe(0);
    expect(result.npmCalls.slice(0, 2)).toEqual([
      '--prefix worker ci',
      '--prefix worker exec -- wrangler secret list --format json',
    ]);
  });

  it('does not claim routes are unattached when none are configured', () => {
    // The shipped wrangler.toml keeps `routes` commented out.
    const result = runWithStubbedNpm({
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.stderr).toContain('no routes configured');
    expect(result.stderr).not.toContain('CHANGES LIVE TRAFFIC');
  });
});
