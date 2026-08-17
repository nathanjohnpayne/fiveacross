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
      wrapperArgs: [],
      deployArgs: ['--only', 'hosting'],
    });
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

    // fiveacross also auto-skips the (gaycruisebingo-only) Cloud Run invoker
    // reconciliation (#768) — that project's deploy credential is not
    // provisioned with IAM access to a gaycruisebingo Cloud Run service, so
    // running it unconditionally there would fail on a permissions error
    // rather than a no-op. See scripts/build-target.mjs's fiveacross entry.
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
      BUILD_CMD: 'npm run build:fiveacross',
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
