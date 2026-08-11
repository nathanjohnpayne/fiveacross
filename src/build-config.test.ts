import { describe, expect, it } from 'vitest';
import { assertDeployFirebaseApiKey, resolveAppVersion } from './build-config';

describe('assertDeployFirebaseApiKey', () => {
  it.each(['gaycruisebingo', 'fiveacross'])('rejects an empty named deploy key for %s', (projectId) => {
    expect(() =>
      assertDeployFirebaseApiKey({ command: 'build', mode: 'production', targetBuild: true, apiKey: '  ', projectId }),
    ).toThrow('.env.' + projectId);
  });

  it('points an ordinary production build at .env.local', () => {
    expect(() =>
      assertDeployFirebaseApiKey({ command: 'build', mode: 'production', apiKey: '  ', projectId: 'fiveacross' }),
    ).toThrow('.env.local');
  });

  it('allows populated target config and generic CI compilation builds', () => {
    expect(() =>
      assertDeployFirebaseApiKey({
        command: 'build',
        mode: 'production',
        apiKey: 'client-safe-web-config',
        projectId: 'fiveacross',
      }),
    ).not.toThrow();
    expect(() =>
      assertDeployFirebaseApiKey({ command: 'build', mode: 'production', githubActions: 'true', projectId: 'fiveacross' }),
    ).not.toThrow();
  });

  it('rejects an empty named target build in GitHub Actions', () => {
    expect(() =>
      assertDeployFirebaseApiKey({
        command: 'build',
        mode: 'production',
        githubActions: 'true',
        targetBuild: true,
        projectId: 'fiveacross',
      }),
    ).toThrow('.env.fiveacross');
  });
});

describe('resolveAppVersion', () => {
  it('prefers GITHUB_SHA over every other source', () => {
    expect(
      resolveAppVersion({ GITHUB_SHA: 'a'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) }, () => {
        throw new Error('should not shell out');
      }),
    ).toBe('a'.repeat(40));
  });

  // #665: Vercel's Git-integration builds set VERCEL_GIT_COMMIT_SHA but never
  // GITHUB_SHA, and have no .git directory for `git rev-parse` to read — the
  // gap that baked 'unknown' into every mirror bundle.
  it('falls back to VERCEL_GIT_COMMIT_SHA when GITHUB_SHA is unset', () => {
    expect(
      resolveAppVersion({ VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40) }, () => {
        throw new Error('should not shell out');
      }),
    ).toBe('c'.repeat(40));
  });

  it('falls back to the resolved git HEAD when neither CI variable is set', () => {
    expect(resolveAppVersion({}, () => '  deadbeef  ')).toBe('deadbeef');
  });

  it('resolves to unknown when git itself throws (no .git directory)', () => {
    expect(
      resolveAppVersion({}, () => {
        throw new Error('not a git repository');
      }),
    ).toBe('unknown');
  });
});
