// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deployDotenvFiles } from './e2e-functions-env.mjs';
import { mergedDeployEnv, missingDeployParams, requiredDeployParams } from './validate-functions-env.mjs';

const ENTRYPOINT = new URL('../functions/src/index.ts', import.meta.url).pathname;
// This repo's real Functions source — a live fixture, not a hand-copied
// list, so this file cannot drift from params.ts the way
// functions/.env.gaycruisebingo drifted on 2026-08-13.
const REQUIRED = requiredDeployParams(ENTRYPOINT);
const PROJECT_ID = 'demo-validate-functions-env';

describe('requiredDeployParams', () => {
  it('includes the two params that hard-failed the 2026-08-13 production deploy', () => {
    expect(REQUIRED).toContain('EMAIL_REPLY_TO');
    expect(REQUIRED).toContain('EMAIL_UNSUBSCRIBE_URL');
  });

  it('excludes RESEND_API_KEY, a defineSecret rather than a dotenv param', () => {
    expect(REQUIRED).not.toContain('RESEND_API_KEY');
  });
});

describe('deployDotenvFiles', () => {
  it('checks the common file and the per-project override, never .env.local', () => {
    expect(deployDotenvFiles(PROJECT_ID)).toEqual(['.env', `.env.${PROJECT_ID}`]);
  });
});

describe('mergedDeployEnv / missingDeployParams', () => {
  let dir;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  const write = (file, body) => writeFileSync(join(dir, file), body);
  const missingFor = () => missingDeployParams(REQUIRED, mergedDeployEnv(dir, PROJECT_ID));

  // The drifted case: the 2026-08-13 incident, reproduced.
  it('names every required param missing from a drifted env file', () => {
    dir = mkdtempSync(join(tmpdir(), 'validate-functions-env-'));
    write(`.env.${PROJECT_ID}`, 'EMAIL_FROM=Gay Cruise Bingo <x@example.invalid>\n');

    const missing = missingFor();

    expect(missing).toContain('EMAIL_REPLY_TO');
    expect(missing).toContain('EMAIL_UNSUBSCRIBE_URL');
    expect(missing).not.toContain('EMAIL_FROM');
  });

  // The complete case — including an explicit empty value, since
  // resolveParams partitions on key PRESENCE, not on a truthy value.
  it('reports nothing missing once every declared param is assigned', () => {
    dir = mkdtempSync(join(tmpdir(), 'validate-functions-env-'));
    write(`.env.${PROJECT_ID}`, REQUIRED.map((name) => `${name}=`).join('\n') + '\n');

    expect(missingFor()).toEqual([]);
  });

  // The extra-keys case: a stale key params.ts no longer declares must not
  // be flagged — this guard only checks for missing REQUIRED keys.
  it('does not flag a surplus key the source no longer declares', () => {
    dir = mkdtempSync(join(tmpdir(), 'validate-functions-env-'));
    const lines = [...REQUIRED.map((name) => `${name}=x`), 'STALE_REMOVED_PARAM=leftover'];
    write(`.env.${PROJECT_ID}`, lines.join('\n') + '\n');

    expect(missingFor()).toEqual([]);
  });

  it('reports every required param missing when no env file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'validate-functions-env-'));

    expect(missingFor()).toEqual(REQUIRED);
  });

  // functions/.env.local is an emulator-only overlay firebase deploy never
  // reads (see deployDotenvFiles) — a value only there must still be
  // reported missing for the deploy path.
  it('does not credit a value that only exists in functions/.env.local', () => {
    dir = mkdtempSync(join(tmpdir(), 'validate-functions-env-'));
    write('.env.local', REQUIRED.map((name) => `${name}=x`).join('\n') + '\n');

    expect(missingFor()).toEqual(REQUIRED);
  });
});
