// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectUploadEntries } from './check-vercel-upload-build.mjs';

const helper = fileURLToPath(new URL('./check-vercel-upload-build.mjs', import.meta.url));
const fixtures = [];
const rules = `/*
!/package.json
!/src
!/public
!/functions
/functions/*
!/functions/src
/functions/src/*
!/functions/src/publicHostnameFields.ts
`;

function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'upload-build-test-')); fixtures.push(root);
  const repo = join(root, 'repo'); const temporary = join(root, 'temporary'); const bin = join(root, 'bin');
  [repo, temporary, bin].forEach(path => mkdirSync(path));
  const put = (path, content) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); };
  put('.vercelignore', rules);
  put('package.json', '{"scripts":{"build":"unused fixture command"}}');
  put('src/entry.js', 'import "../functions/src/publicHostnameFields.ts";');
  put('public/icon.svg', '<svg/>');
  put('functions/src/publicHostnameFields.ts', 'export const fields = [];');
  put('functions/src/index.ts', 'server-only');
  put('future-root/input.js', 'not an admitted client input');
  put('.env.local', 'fixture-only; never a real credential');
  git(repo, ['init', '--quiet']);
  git(repo, ['add', '.']);
  const log = join(root, 'npm.jsonl');
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const files = (root, prefix = '') => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const relative = path.join(prefix, entry.name);
  return entry.isDirectory() ? files(path.join(root, entry.name), relative) : [relative];
});
fs.appendFileSync(process.env.UPLOAD_FIXTURE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), files: files(process.cwd()), githubActions: process.env.GITHUB_ACTIONS, githubSha: process.env.GITHUB_SHA, targetBuild: process.env.DEPLOY_TARGET_BUILD, targetEdition: process.env.DEPLOY_TARGET_STATIC_EDITION }) + '\\n');
if (process.argv[2] === 'ci' && process.env.UPLOAD_FAIL_INSTALL) { console.error('fixture install diagnostic'); process.exit(23); }
if (process.argv[2] === 'run' && (process.env.UPLOAD_FAIL_BUILD || !fs.existsSync('functions/src/publicHostnameFields.ts'))) { console.error('Could not resolve "../functions/src/publicHostnameFields.ts" from "src/entry.js"'); process.exit(29); }
if (process.argv[2] === 'ci') {
  fs.mkdirSync('node_modules'); fs.writeFileSync('node_modules/fresh-install', 'fixture install');
  if (fs.existsSync('src/executable.js') && !(fs.statSync('src/executable.js').mode & 0o111)) process.exit(31);
}
`, { mode: 0o755 });
  return {
    repo, temporary, bin, log, put,
    run: (env = {}) => spawnSync(process.execPath, [helper], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, TMPDIR: temporary, UPLOAD_FIXTURE_LOG: log, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'fixture-head', ...env },
    }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('tracked Vercel upload-set build', () => {
  it('builds a physical tracked allowlist with nested re-admission, without secrets or checkout state', () => {
    const f = fixture();
    f.put('src/untracked.js', 'this was never added to Git');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    expect(calls.map(call => call.args)).toEqual([['ci'], ['run', 'build']]);
    expect(calls[0].files).toEqual(['functions/src/publicHostnameFields.ts', 'package.json', 'public/icon.svg', 'src/entry.js']);
    expect(calls[0].cwd).not.toBe(f.repo);
    expect(calls[1].files).toContain('node_modules/fresh-install');
    expect(calls[0]).toMatchObject({ githubActions: 'true', githubSha: 'fixture-head' });
    expect(result.stdout).toContain('functions/src/publicHostnameFields.ts');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('establishes the generic compile-only build environment outside GitHub Actions', () => {
    const f = fixture();
    const result = f.run({ GITHUB_ACTIONS: undefined, DEPLOY_TARGET_BUILD: '1', DEPLOY_TARGET_STATIC_EDITION: 'fixture-edition' });
    expect(result.status, result.stderr).toBe(0);
    for (const call of f.calls()) {
      expect(call).toMatchObject({ githubActions: 'true', githubSha: 'fixture-head' });
      expect(call.targetBuild).toBeUndefined();
      expect(call.targetEdition).toBeUndefined();
    }
  });

  it('does not let .gitignore hide tracked inputs or copy untracked checkout artifacts', () => {
    const f = fixture();
    f.put('.gitignore', 'src/entry.js\n');
    f.put('node_modules/local-install', 'existing checkout dependency');
    f.put('src/executable.js', 'executable input');
    chmodSync(join(f.repo, 'src/executable.js'), 0o755);
    git(f.repo, ['add', 'src/executable.js']);
    expect(f.run().status).toBe(0);
    expect(f.calls()[0].files).toContain('src/entry.js');
    expect(f.calls()[0].files).not.toContain('node_modules/local-install');
  });

  it('names an unresolved future client import when its tracked sibling stays denied', () => {
    const f = fixture();
    f.put('.vercelignore', rules.replace('!/functions/src/publicHostnameFields.ts\n', ''));
    const result = f.run();
    expect(result.status).toBe(29);
    expect(result.stderr).toContain('Could not resolve "../functions/src/publicHostnameFields.ts"');
    expect(f.calls()[0].files).not.toContain('functions/src/publicHostnameFields.ts');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it.each(['', '# comments only\n'])('fails before install for an empty matcher %j', value => {
    const f = fixture(); f.put('.vercelignore', value);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must contain upload selection rules');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('fails before install when .vercelignore is missing', () => {
    const f = fixture(); rmSync(join(f.repo, '.vercelignore'));
    expect(f.run().status).toBe(1);
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it.each(['src/.env.local', 'functions/src/serviceAccountKey.json', 'public/private.pem'])('rejects future secret-shaped admission %s', path => {
    const f = fixture(); f.put(path, 'harmless synthetic secret-shaped input');
    git(f.repo, ['add', path]);
    f.put('.vercelignore', rules + `!/${path}\n`);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing secret-shaped upload input');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('refuses an indexed admitted symlink', () => {
    const f = fixture(); symlinkSync(join(f.repo, '.env.local'), join(f.repo, 'src/link'));
    git(f.repo, ['add', 'src/link']);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing admitted symlink');
  });

  it.each(['file', 'ancestor'])('refuses a working-tree symlink substituted for an indexed %s and cleans staging', kind => {
    const f = fixture();
    const path = join(f.repo, kind === 'file' ? 'src/entry.js' : 'src');
    rmSync(path, { recursive: true });
    symlinkSync(join(f.repo, kind === 'file' ? '.env.local' : 'public'), path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing non-regular upload input');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('refuses admitted gitlinks and traversal without following them', () => {
    expect(() => selectUploadEntries([{ mode: '160000', path: 'src/vendor' }], rules)).toThrow('gitlink');
    expect(() => selectUploadEntries([{ mode: '100644', path: '../outside' }], rules)).toThrow('Unsafe tracked path');
    expect(() => selectUploadEntries([{ mode: '100644', path: 'package.json' }], '/*\n')).toThrow('admits no tracked');
  });

  it('stops before build on an install failure and preserves status, diagnostics and cleanup', () => {
    const f = fixture(); const result = f.run({ UPLOAD_FAIL_INSTALL: '1' });
    expect(result.status).toBe(23);
    expect(result.stderr).toContain('fixture install diagnostic');
    expect(f.calls().map(call => call.args)).toEqual([['ci']]);
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('preserves build failure diagnostics and status and cleans staging', () => {
    const f = fixture(); const result = f.run({ UPLOAD_FAIL_BUILD: '1' });
    expect(result.status).toBe(29);
    expect(result.stderr).toContain('Could not resolve');
    expect(readdirSync(f.temporary)).toEqual([]);
  });

  it('runs in the existing required PR/push job after install and the ordinary build', () => {
    const workflow = readFileSync(new URL('../.github/workflows/app-ci.yml', import.meta.url), 'utf8');
    expect(workflow).toMatch(/on:\s+pull_request:\s+push:\s+branches: \[main\]/);
    expect(workflow.indexOf('run: node scripts/check-vercel-upload-build.mjs')).toBeGreaterThan(workflow.indexOf('run: npm ci'));
    expect(workflow).toMatch(/- name: Build\s+run: npm run build\s+(?:#[^\n]*\n\s*)*- name: Vercel upload-set build\s+run: node scripts\/check-vercel-upload-build.mjs/);
  });
});
