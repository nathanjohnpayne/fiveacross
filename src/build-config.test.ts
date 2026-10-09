import { describe, expect, it } from 'vitest';
import { assertDeployFirebaseApiKey, assertPreviewFirebaseIsolation, resolveAppVersion } from './build-config';

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

describe('preview Firebase isolation (#1420)', () => {
  it('refuses preview builds until an isolated configuration is reviewed', () => {
    expect(() => assertPreviewFirebaseIsolation('build', 'preview', '1')).toThrow('isolated test Firebase');
  });

  it.each(['production', 'development', undefined])('preserves %s builds', (environment) => {
    expect(() => assertPreviewFirebaseIsolation('build', environment, undefined)).not.toThrow();
  });

  it.each([undefined, '', 'staging', 'Preview'])('refuses partial or unknown Vercel metadata %s', (environment) => {
    expect(() => assertPreviewFirebaseIsolation('build', environment, '1')).toThrow('missing or unknown VERCEL_ENV');
  });

  it.each(['production', 'development'])('preserves platform %s builds', (environment) => {
    expect(() => assertPreviewFirebaseIsolation('build', environment, '1')).not.toThrow();
  });

  it('leaves local dev serving outside the publication boundary', () => {
    expect(() => assertPreviewFirebaseIsolation('serve', 'preview', '1')).not.toThrow();
  });
});

describe('private source-map configuration', () => {
  const base = { command: 'build', mode: 'production', targetBuild: true, version: 'a'.repeat(40), apiKey: 'fixture-key' };
  it('pins the private project, host and exact release for named and mirror production builds', async () => {
    const { posthogSourceMapOptions } = await import('./build-config');
    expect(posthogSourceMapOptions(base)).toMatchObject({ projectId: '503790', host: 'https://us.posthog.com', sourcemaps: { releaseVersion: base.version, deleteAfterUpload: true, releaseMode: 'symbol-set' } });
    expect(posthogSourceMapOptions({ ...base, targetBuild: false, vercelEnv: 'production' })).not.toBeNull();
  });
  it('requires a key and exact commit for every deploy-shaped production build', async () => {
    const { posthogSourceMapOptions } = await import('./build-config');
    expect(() => posthogSourceMapOptions({ ...base, apiKey: '' })).toThrow(/1Password/);
    expect(() => posthogSourceMapOptions({ ...base, version: 'unknown' })).toThrow(/exact/);
  });
  it('keeps generic CI, emulator builds and development credential-free', async () => {
    const { posthogSourceMapOptions } = await import('./build-config');
    expect(posthogSourceMapOptions({ ...base, targetBuild: false, apiKey: '' })).toBeNull();
    expect(posthogSourceMapOptions({ ...base, mode: 'e2e', apiKey: '' })).toBeNull();
    expect(posthogSourceMapOptions({ ...base, command: 'serve', apiKey: '' })).toBeNull();
  });
  it('emits no maps for Firebase validation, while Vercel Production still requires upload', async () => {
    const { posthogSourceMapOptions } = await import('./build-config');
    expect(posthogSourceMapOptions({ ...base, firebaseDryRun: 'true', apiKey: '' })).toBeNull();
    expect(() => posthogSourceMapOptions({ ...base, firebaseDryRun: 'true', vercelEnv: 'production', apiKey: '' })).toThrow(/1Password/);
  });
});
