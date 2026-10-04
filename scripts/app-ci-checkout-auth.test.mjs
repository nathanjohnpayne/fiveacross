import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'app-ci.yml'), 'utf8');
const step = workflow.match(/      - name: Verify checkout credentials removed\n        run: \|\n((?:          .*\n|\n)+)/)?.[1];
const probe = step?.replace(/^          /gm, '');
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'app-ci-auth-'));
  fixtures.push(root);
  const repo = join(root, 'repo');
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(repo);
  mkdirSync(runnerTemp);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', RUNNER_TEMP: runnerTemp };
  const init = spawnSync('git', ['init', '--quiet', repo], { env });
  expect(init.status).toBe(0);
  return { repo, runnerTemp, env };
}

function run({ repo, env }) {
  expect(probe, 'the executable CI probe must exist').toBeTruthy();
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', probe], { cwd: repo, env, encoding: 'utf8' });
}

describe('app-ci drops checkout authentication before PR code', () => {
  it('pins checkout, disables credential persistence and retains contents: read', () => {
    expect(workflow).toMatch(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1[^\n]*\n        with:\n          persist-credentials: false/);
    expect(workflow).toMatch(/permissions:\n  contents: read\n/);
    expect(workflow.indexOf('- name: Verify checkout credentials removed')).toBeGreaterThan(workflow.indexOf('actions/checkout@'));
    expect(workflow.indexOf('- name: Verify checkout credentials removed')).toBeLessThan(workflow.indexOf('run: npm ci'));
  });

  it('permits a checkout with no authentication state', () => {
    expect(run(fixture()).status).toBe(0);
  });

  it('rejects legacy extraheader credentials without printing their contents', () => {
    const f = fixture();
    const secret = 'fixture-auth-header';
    const config = spawnSync('git', ['config', '--local', 'http.https://github.com/.extraheader', secret], { cwd: f.repo, env: f.env });
    expect(config.status).toBe(0);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('rejects checkout v7 temporary credential storage even with clean .git/config', () => {
    const f = fixture();
    const secret = 'fixture-runner-temp-token';
    writeFileSync(join(f.runnerTemp, 'git-credentials-fixture.config'), `[http "https://github.com/"]\nextraheader = ${secret}\n`);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('temporary credentials config');
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('rejects an auth header reached through an included Git config', () => {
    const f = fixture();
    const included = join(f.repo, 'included.config');
    writeFileSync(included, '[http "https://github.com/"]\nextraheader = fixture-included-header\n');
    const config = spawnSync('git', ['config', '--local', 'include.path', included], { cwd: f.repo, env: f.env });
    expect(config.status).toBe(0);
    expect(run(f).status).toBe(1);
  });

  it('fails closed when the runner temporary directory cannot be inspected', () => {
    const f = fixture();
    rmSync(f.runnerTemp, { recursive: true });
    expect(run(f).status).toBe(1);
  });
});
