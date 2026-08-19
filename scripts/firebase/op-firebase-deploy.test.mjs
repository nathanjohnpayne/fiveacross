// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('op-firebase-deploy authenticated hostname verification', () => {
  it('runs only the Five Across hostname verifier under the explicit project credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'op-firebase-exec-test-'));
    temporaryDirectories.push(directory);
    const credentialPath = join(directory, 'credential.json');
    const verifyMarker = join(directory, 'verify.json');
    const firebaseMarker = join(directory, 'firebase-called');
    const fakeBin = join(directory, 'bin');
    await writeFile(
      credentialPath,
      JSON.stringify({
        type: 'service_account',
        client_email: 'source-credential@example.iam.gserviceaccount.com',
      }),
    );
    await mkdir(fakeBin);
    const fakeNode = join(fakeBin, 'node');
    await writeFile(
      fakeNode,
      [
        '#!/usr/bin/env bash',
        'python3 - "$1" "$VERIFY_MARKER" <<\'PY\'',
        'import json, os, pathlib, sys',
        'credential_path = pathlib.Path(os.environ["GOOGLE_APPLICATION_CREDENTIALS"])',
        'credential = json.loads(credential_path.read_text())',
        'pathlib.Path(sys.argv[2]).write_text(json.dumps({',
        '    "project": os.environ["GOOGLE_CLOUD_PROJECT"],',
        '    "path": str(credential_path),',
        '    "type": credential["type"],',
        '    "url": credential["service_account_impersonation_url"],',
        '    "quotaProject": credential["source_credentials"]["quota_project_id"],',
        '    "verifier": sys.argv[1],',
        '}))',
        'PY',
      ].join('\n'),
    );
    await chmod(fakeNode, 0o755);
    const fakeFirebase = join(fakeBin, 'firebase');
    await writeFile(fakeFirebase, '#!/usr/bin/env bash\nprintf called >"$FIREBASE_MARKER"\n');
    await chmod(fakeFirebase, 0o755);

    const result = spawnSync(
      resolve('scripts/firebase/op-firebase-deploy'),
      ['fiveacross', '--verify-fiveacross-hostnames'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
          VERIFY_MARKER: verifyMarker,
          FIREBASE_MARKER: firebaseMarker,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(await readFile(verifyMarker, 'utf8'));
    expect(observed.project).toBe('fiveacross');
    expect(observed.path).not.toBe(credentialPath);
    expect(observed).toMatchObject({
      type: 'impersonated_service_account',
      quotaProject: 'fiveacross',
    });
    expect(observed.url).toContain('firebase-deployer@fiveacross.iam.gserviceaccount.com:generateAccessToken');
    expect(observed.verifier).toBe(resolve('scripts/verify-deploy-hostnames.mjs'));
    await expect(readFile(firebaseMarker, 'utf8')).rejects.toThrow();
  });

  it('rejects arbitrary authenticated command execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'op-firebase-exec-rejection-'));
    temporaryDirectories.push(directory);
    const marker = join(directory, 'arbitrary-command-ran');
    const result = spawnSync(
      resolve('scripts/firebase/op-firebase-deploy'),
      ['fiveacross', '--exec', 'touch', marker],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --exec');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('requires the explicit project before selecting hostname verification', () => {
    const result = spawnSync(
      resolve('scripts/firebase/op-firebase-deploy'),
      ['--verify-fiveacross-hostnames'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires an explicit project ID before it');
  });

  it('rejects Firebase deploy options before hostname verification', () => {
    const result = spawnSync(
      resolve('scripts/firebase/op-firebase-deploy'),
      ['fiveacross', '--only', 'hosting', '--verify-fiveacross-hostnames'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot be combined with Firebase deploy options or commands');
  });

  it('rejects a command after the fixed hostname verifier mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'op-firebase-verifier-command-rejection-'));
    temporaryDirectories.push(directory);
    const marker = join(directory, 'trailing-command-ran');
    const result = spawnSync(
      resolve('scripts/firebase/op-firebase-deploy'),
      ['fiveacross', '--verify-fiveacross-hostnames', 'touch', marker],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot be combined with Firebase deploy options or commands');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});
