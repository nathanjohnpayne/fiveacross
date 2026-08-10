import { describe, expect, it } from 'vitest';
import { assertDeployFirebaseApiKey } from './build-config';

describe('assertDeployFirebaseApiKey', () => {
  it.each(['gaycruisebingo', 'fiveacross'])('rejects an empty deploy key for %s', (projectId) => {
    expect(() =>
      assertDeployFirebaseApiKey({ command: 'build', mode: 'production', apiKey: '  ', projectId }),
    ).toThrow('.env.' + projectId);
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
