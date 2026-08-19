// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HELPER = new URL('./lib/deploy-main-guard.sh', import.meta.url).pathname;
const EXECUTABLE = new URL('./assert-deploy-source-ready.sh', import.meta.url).pathname;
const temporaryRoots = [];

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-main-guard-'));
  temporaryRoots.push(root);
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  git(root, ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  git(root, ['init', '--bare', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '--set-upstream', 'origin', 'main']);
  return repo;
}

function runGuard(repo, { force = false, allowDirty = false } = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; cd "$2"; guard_deploy_main_checkout "$3" "$4"',
      'bash',
      HELPER,
      repo,
      'scripts/test-deploy.sh',
      String(force),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_ALLOW_DIRTY: allowDirty ? '1' : '0' },
    },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared main deploy guard', () => {
  it('accepts a clean main checkout that exactly matches origin/main', () => {
    const result = runGuard(fixture());
    expect(result.status).toBe(0);
  });

  it('rejects a feature branch before any deploy can run', () => {
    const repo = fixture();
    git(repo, ['switch', '-c', 'feat/unreviewed']);

    const result = runGuard(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("current branch is 'feat/unreviewed'");
  });

  it('exposes the same guard through the executable pre-readiness boundary', () => {
    const repo = fixture();
    git(repo, ['switch', '-c', 'feat/unreviewed']);

    const result = spawnSync(EXECUTABLE, [], { cwd: repo, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("current branch is 'feat/unreviewed'");
  });

  it('keeps the canonical --force and dirty-tree break-glass semantics at the executable boundary', () => {
    const repo = fixture();
    git(repo, ['switch', '-c', 'feat/unreviewed']);

    const forced = spawnSync(EXECUTABLE, ['--force'], { cwd: repo, encoding: 'utf8' });
    expect(forced.status).toBe(0);
    expect(forced.stderr).toContain("--force: deploying from 'feat/unreviewed'");

    writeFileSync(join(repo, 'uncommitted.txt'), 'not reviewed\n');
    const dirtyBlocked = spawnSync(EXECUTABLE, ['--force'], { cwd: repo, encoding: 'utf8' });
    expect(dirtyBlocked.status).toBe(1);
    expect(dirtyBlocked.stderr).toContain('working tree is dirty');

    const dirtyAllowed = spawnSync(EXECUTABLE, ['--force'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_ALLOW_DIRTY: '1' },
    });
    expect(dirtyAllowed.status).toBe(0);
    expect(dirtyAllowed.stderr).toContain('DEPLOY_ALLOW_DIRTY=1');
  });

  it('rejects a local main commit that is not on origin/main', () => {
    const repo = fixture();
    writeFileSync(join(repo, 'README.md'), 'local-only\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'local only']);

    const result = runGuard(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local main does not exactly match origin/main');
  });

  it('requires DEPLOY_ALLOW_DIRTY=1 separately from --force', () => {
    const repo = fixture();
    writeFileSync(join(repo, 'uncommitted.txt'), 'not reviewed\n');

    const blocked = runGuard(repo, { force: true });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('working tree is dirty');

    const allowed = runGuard(repo, { force: true, allowDirty: true });
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain('DEPLOY_ALLOW_DIRTY=1');
  });
});
