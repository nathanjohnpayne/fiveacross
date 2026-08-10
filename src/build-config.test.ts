import { describe, expect, it } from 'vitest';
import { assertDeployFirebaseApiKey } from './build-config';

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
