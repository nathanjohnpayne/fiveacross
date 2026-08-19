// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readinessScript = resolve(repoRoot, 'scripts', 'apply-auth-handoff-deploy-readiness.sh');
const reconciliationScript = resolve(repoRoot, 'scripts', 'set-auth-handoff-invoker.sh');
const expectedServiceAccount = 'firebase-deployer@fiveacross.iam.gserviceaccount.com';
const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeFixture({
  credential,
  opCredential,
  failService = '',
  describeValue = 'false',
  activationFails = false,
}) {
  const root = await mkdtemp(join(tmpdir(), 'auth-handoff-readiness-'));
  fixtures.push(root);
  const log = join(root, 'gcloud.log');
  const blockFile = join(root, 'update-started');
  const opBlockFile = join(root, 'materialization-started');
  const credentialPath = join(root, 'credential.json');
  const opCredentialPath = join(root, 'op-credential.json');
  await writeFile(credentialPath, JSON.stringify(credential));
  await writeFile(opCredentialPath, JSON.stringify(opCredential ?? credential));
  await writeFile(
    join(root, 'gcloud'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GCLOUD_LOG"
case " $* " in
  *" auth activate-service-account "*)
    if [[ "\${ACTIVATION_FAILS:-false}" == "true" ]]; then exit 8; fi
    exit 0
    ;;
  *" run services describe "*) printf '%s\\n' "$DESCRIBE_VALUE"; exit 0 ;;
  *" run services update "*)
    if [[ -n "\${BLOCK_FILE:-}" && " $* " == *" mintauthhandoff "* ]]; then
      touch "$BLOCK_FILE"
      while true; do sleep 1; done
    fi
    if [[ -n "\${FAIL_SERVICE:-}" && " $* " == *" $FAIL_SERVICE "* ]]; then exit 9; fi
    exit 0
    ;;
  *" run services list "*) exit 0 ;;
esac
exit 1
`,
  );
  await writeFile(
    join(root, 'op'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${OP_MATERIALIZE:-false}" == "true" ]] || exit 1
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--out-file" ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]]
cp "$OP_CREDENTIAL_PATH" "$out"
if [[ -n "\${OP_BLOCK_FILE:-}" ]]; then
  touch "$OP_BLOCK_FILE"
  while true; do sleep 1; done
fi
`,
  );
  await chmod(join(root, 'gcloud'), 0o755);
  await chmod(join(root, 'op'), 0o755);
  return {
    root,
    log,
    blockFile,
    opBlockFile,
    credentialPath,
    opCredentialPath,
    failService,
    describeValue,
    activationFails,
  };
}

function runReadiness(fixture, overrides = {}) {
  return spawnSync(readinessScript, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.root}:${process.env.PATH}`,
      TMPDIR: fixture.root,
      GCLOUD_BIN: join(fixture.root, 'gcloud'),
      GCLOUD_LOG: fixture.log,
      BLOCK_FILE: '',
      OP_BLOCK_FILE: '',
      FAIL_SERVICE: fixture.failService,
      DESCRIBE_VALUE: fixture.describeValue,
      ACTIVATION_FAILS: String(fixture.activationFails),
      OP_CREDENTIAL_PATH: fixture.opCredentialPath,
      ...overrides,
    },
  });
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('Five Across auth-handoff deploy readiness', () => {
  it('uses the exact Five Across deploy service-account key and forces both updates', async () => {
    const fixture = await makeFixture({
      credential: { type: 'service_account', client_email: expectedServiceAccount },
      describeValue: 'true',
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: fixture.credentialPath,
      AUTH_HANDOFF_PROJECT: 'fiveacross',
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('run services update mintauthhandoff');
    expect(calls).toContain('run services update exchangeauthhandoff');
    expect(calls).not.toContain('--impersonate-service-account');
  });

  it('preserves ordinary reconciliation no-op behavior when both annotations are already true', async () => {
    const fixture = await makeFixture({
      credential: { type: 'service_account', client_email: expectedServiceAccount },
      describeValue: 'true',
    });

    const result = spawnSync(reconciliationScript, [], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.root}:${process.env.PATH}`,
        GCLOUD_BIN: join(fixture.root, 'gcloud'),
        GCLOUD_LOG: fixture.log,
        DESCRIBE_VALUE: fixture.describeValue,
        FAIL_SERVICE: '',
        BLOCK_FILE: '',
        GOOGLE_APPLICATION_CREDENTIALS: fixture.credentialPath,
        AUTH_HANDOFF_PROJECT: 'fiveacross',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain('run services update');
  });

  it('fails closed instead of falling back to ambient gcloud when the exact deploy-SA key cannot activate', async () => {
    const fixture = await makeFixture({
      credential: { type: 'service_account', client_email: expectedServiceAccount },
      activationFails: true,
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: fixture.credentialPath,
      AUTH_HANDOFF_PROJECT: 'fiveacross',
    });

    expect(result.status).not.toBe(0);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('auth activate-service-account');
    expect(calls).not.toContain('run services describe');
    expect(calls).not.toContain('run services update');
  });

  it('repins an ambient credential by impersonating the exact Five Across deploy service account', async () => {
    const fixture = await makeFixture({
      credential: { type: 'authorized_user', client_id: 'ambient' },
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: fixture.credentialPath,
      AUTH_HANDOFF_PROJECT: 'fiveacross',
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls.match(new RegExp(`--impersonate-service-account=${expectedServiceAccount}`, 'g'))).toHaveLength(4);
    expect(calls).toContain('run services update mintauthhandoff');
    expect(calls).toContain('run services update exchangeauthhandoff');
  });

  it('attempts both updates and removes a materialized key after one half fails', async () => {
    const fixture = await makeFixture({
      credential: { type: 'authorized_user', client_id: 'ambient' },
      opCredential: { type: 'service_account', client_email: expectedServiceAccount },
      failService: 'mintauthhandoff',
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: '',
      AUTH_HANDOFF_PROJECT: 'fiveacross',
      OP_MATERIALIZE: 'true',
    });

    expect(result.status).toBe(9);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('run services update mintauthhandoff');
    expect(calls).toContain('run services update exchangeauthhandoff');
    expect(await readdir(fixture.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^firebase-sa-/)]));
  });

  it('removes a materialized key after both updates succeed', async () => {
    const fixture = await makeFixture({
      credential: { type: 'authorized_user', client_id: 'ambient' },
      opCredential: { type: 'service_account', client_email: expectedServiceAccount },
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: '',
      AUTH_HANDOFF_PROJECT: 'fiveacross',
      OP_MATERIALIZE: 'true',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(fixture.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^firebase-sa-/)]));
  });

  it('removes a materialized key when the readiness process is terminated', async () => {
    const fixture = await makeFixture({
      credential: { type: 'authorized_user', client_id: 'ambient' },
      opCredential: { type: 'service_account', client_email: expectedServiceAccount },
    });
    const child = spawn(readinessScript, [], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PATH: `${fixture.root}:${process.env.PATH}`,
        TMPDIR: fixture.root,
        GCLOUD_BIN: join(fixture.root, 'gcloud'),
        GCLOUD_LOG: fixture.log,
        BLOCK_FILE: fixture.blockFile,
        OP_BLOCK_FILE: '',
        FAIL_SERVICE: '',
        DESCRIBE_VALUE: fixture.describeValue,
        OP_CREDENTIAL_PATH: fixture.opCredentialPath,
        OP_MATERIALIZE: 'true',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        AUTH_HANDOFF_PROJECT: 'fiveacross',
      },
    });

    await waitForFile(fixture.blockFile);
    process.kill(-child.pid, 'SIGTERM');
    const result = await new Promise((resolveClose) => {
      child.once('close', (status, signal) => resolveClose({ status, signal }));
    });

    expect(result.status === 143 || result.signal === 'SIGTERM').toBe(true);
    expect(await readdir(fixture.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^firebase-sa-/)]));
  });

  it('removes a temporary key when materialization itself is terminated', async () => {
    const fixture = await makeFixture({
      credential: { type: 'authorized_user', client_id: 'ambient' },
      opCredential: { type: 'service_account', client_email: expectedServiceAccount },
    });
    const child = spawn(readinessScript, [], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PATH: `${fixture.root}:${process.env.PATH}`,
        TMPDIR: fixture.root,
        GCLOUD_BIN: join(fixture.root, 'gcloud'),
        GCLOUD_LOG: fixture.log,
        BLOCK_FILE: '',
        OP_BLOCK_FILE: fixture.opBlockFile,
        FAIL_SERVICE: '',
        DESCRIBE_VALUE: fixture.describeValue,
        OP_CREDENTIAL_PATH: fixture.opCredentialPath,
        OP_MATERIALIZE: 'true',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        AUTH_HANDOFF_PROJECT: 'fiveacross',
      },
    });

    await waitForFile(fixture.opBlockFile);
    process.kill(-child.pid, 'SIGTERM');
    const result = await new Promise((resolveClose) => {
      child.once('close', (status, signal) => resolveClose({ status, signal }));
    });

    expect(result.status === 143 || result.signal === 'SIGTERM').toBe(true);
    expect(await readdir(fixture.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^firebase-sa-/)]));
  });

  it('rejects an attempt to redirect readiness to another project before gcloud runs', async () => {
    const fixture = await makeFixture({
      credential: { type: 'service_account', client_email: expectedServiceAccount },
    });

    const result = runReadiness(fixture, {
      GOOGLE_APPLICATION_CREDENTIALS: fixture.credentialPath,
      AUTH_HANDOFF_PROJECT: 'gaycruisebingo',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires AUTH_HANDOFF_PROJECT=fiveacross');
    await expect(readFile(fixture.log, 'utf8')).rejects.toThrow();
  });
});
