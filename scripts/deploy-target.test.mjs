// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deployInvocation, deployRequest } from './deploy-target.mjs';

describe('deploy target selection', () => {
  it('requires an explicit deploy target', () => {
    expect(() => deployRequest([])).toThrow('A deploy target is required');
  });

  it('turns the generic hosting entry point into an explicit target deployment', () => {
    expect(deployRequest(['--hosting', 'fiveacross'])).toEqual({
      target: 'fiveacross',
      deployArgs: ['--only', 'hosting'],
    });
  });

  it('keeps Five Across project, build, synthetic, and cache choices together', () => {
    const invocation = deployInvocation('fiveacross', ['--only', 'firestore:rules'], { NODE_ENV: 'production' });

    expect(invocation.args).toEqual([
      '--skip-cf-purge',
      '--',
      'fiveacross',
      '--only',
      'firestore:rules',
    ]);
    expect(invocation.environment).toMatchObject({
      NODE_ENV: 'production',
      BUILD_CMD: 'npm run build:fiveacross',
      SYNTHETIC_URL: 'https://bodega-bay.fiveacross.app/',
    });
  });

  it('keeps Gay Cruise Bingo project, build, and synthetic choices explicit', () => {
    const invocation = deployInvocation('gaycruisebingo', ['--only', 'hosting'], {});

    expect(invocation.args).toEqual(['--', 'gaycruisebingo', '--only', 'hosting']);
    expect(invocation.environment).toMatchObject({
      BUILD_CMD: 'npm run build:gaycruisebingo',
      SYNTHETIC_URL: 'https://gaycruisebingo.com/',
    });
  });
});
