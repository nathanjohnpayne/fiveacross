// Consumer runtime coverage for the canonical workflow propagated from Mergepath.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'daily-feedback-rollup.yml'), 'utf8');
const step = workflow.split('      - name: Run rollup\n')[1];
const runSource = step.split('        run: |\n')[1].replace(/^          /gm, '');
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function run(since, until, dryRun) {
  const root = mkdtempSync(join(tmpdir(), 'rollup-dispatch-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  // Records argv only; this fixture never calls GitHub or writes production data.
  writeFileSync(join(root, 'scripts', 'daily-feedback-rollup.sh'), '#!/bin/bash\nprintf "%s\\n" "$@" >args\n');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', runSource], {
    cwd: root,
    env: { ...process.env, GH_TOKEN: 'fixture-token', REPO: 'o/r', INPUT_SINCE: since, INPUT_UNTIL: until, INPUT_DRY_RUN: dryRun },
    encoding: 'utf8',
  });
  return { root, result };
}

describe('daily rollup dispatch treats inputs as data before shell parsing', () => {
  it('maps every dispatch input through env, with no input interpolation in run', () => {
    for (const [variable, input] of [['INPUT_SINCE', 'since'], ['INPUT_UNTIL', 'until'], ['INPUT_DRY_RUN', 'dry_run']]) {
      expect(step).toContain(`${variable}: \u0024{{ github.event.inputs.${input} }}`);
    }
    expect(runSource).not.toContain('${{');
  });

  it('preserves valid dates and dry_run as distinct argv values', () => {
    const { root, result } = run('2026-10-01', '2026-10-02', 'true');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'args'), 'utf8').trim().split('\n')).toEqual(['--since', '2026-10-01', '--until', '2026-10-02', '--dry-run']);
  });

  it('preserves the scheduled empty-input default', () => {
    const { root, result } = run('', '', '');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'args'), 'utf8').trim()).toBe('');
  });

  it.each([
    ['since command substitution', '$(touch pwned)', '', ''],
    ['until command substitution', '', '$(touch pwned)', 'false'],
    ['since quote escape', '2026-10-01"; touch pwned; "', '', ''],
    ['until backticks', '', '`touch pwned`', ''],
    ['since newline', '2026-10-01\ntouch pwned', '', ''],
    ['dry_run command substitution', '', '', '$(touch pwned)'],
    ['invalid boolean', '', '', 'yes'],
    ['invalid date shape', '2026-1-1', '', ''],
  ])('rejects %s before invoking the rollup', (_name, since, until, dryRun) => {
    const { root, result } = run(since, until, dryRun);
    expect(result.status).toBe(1);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(existsSync(join(root, 'args'))).toBe(false);
  });
});
