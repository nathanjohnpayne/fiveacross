import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'board-fields-1.5.sh'), 'utf8');
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture({ checker = 'author', env = {}, rejectAt = 0, rejectOnly = false, wrapper = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'board-author-'));
  fixtures.push(root);
  const example = join(root, 'scripts', 'gh-projects', 'examples', 'gaycruisebingo');
  const bin = join(root, 'bin');
  mkdirSync(example, { recursive: true });
  mkdirSync(bin);
  if (wrapper) {
    const wrapperPath = join(root, 'scripts', 'gh-as-author.sh');
    writeFileSync(wrapperPath, '#!/bin/bash\nset -eu\ntest "$1" = --\nshift\nprintf "%s\\n" "$*" >>"$FIXTURE_ROOT/wrapper-calls"\nexec "$@"\n');
    chmodSync(wrapperPath, 0o755);
  }
  const driver = join(example, 'board-fields-1.5.sh');
  writeFileSync(driver, script);
  writeFileSync(join(example, 'slug-num-1.5.map'), 'd15-epic=1\nd15-tab-contract=2\n');
  writeFileSync(join(root, 'project.json'), JSON.stringify({ id: 'project', readme: '', shortDescription: 'daily cards' }));
  writeFileSync(join(root, 'fields.json'), JSON.stringify({ fields: [{ id: 'status', name: 'Status', options: [{ id: 'backlog', name: 'Backlog' }, { id: 'ready', name: 'Ready' }] }] }));
  writeFileSync(join(root, 'items.json'), JSON.stringify({ items: [1, 2].map(n => ({ id: `item-${n}`, content: { url: `https://github.com/nathanjohnpayne/fiveacross/issues/${n}` } })) }));
  const helper = join(root, 'scripts', 'identity-check.sh');
  if (checker !== 'missing') {
    writeFileSync(helper, `#!/bin/bash
set -eu
n=$(( $(cat "$FIXTURE_ROOT/checks" 2>/dev/null || echo 0) + 1 ))
printf '%s\\n' "$n" >"$FIXTURE_ROOT/checks"
test "$1" = --expect-token-identity
test "$2" = nathanjohnpayne
test "$GH_TOKEN" = fixture-token
test "$MOCK_LOGIN" = nathanjohnpayne
if [ "$REJECT_AT" -gt 0 ] && { [ "$n" -eq "$REJECT_AT" ] || { [ "$REJECT_ONLY" = 0 ] && [ "$n" -gt "$REJECT_AT" ]; }; }; then exit 1; fi
`);
    chmodSync(helper, checker === 'non-executable' ? 0o644 : 0o755);
  }
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
set -eu
test -z "\u0024{GITHUB_TOKEN:-}"
printf '%s\\n' "$1 $2" >>"$FIXTURE_ROOT/gh-calls"
case "$1 $2" in
  'project view') cat "$FIXTURE_ROOT/project.json" ;;
  'project field-list') cat "$FIXTURE_ROOT/fields.json" ;;
  'project item-list') cat "$FIXTURE_ROOT/items.json" ;;
  'project item-add'|'project item-edit') ;;
  *) exit 99 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { root, driver, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, GH_TOKEN: 'fixture-token', GITHUB_TOKEN: 'fixture-ambient', FIXTURE_ROOT: root, MOCK_LOGIN: checker === 'wrong' ? 'nathanpayne-codex' : 'nathanjohnpayne', REJECT_AT: String(rejectAt), REJECT_ONLY: rejectOnly ? '1' : '0', ...env } };
}

function run(f) {
  const result = spawnSync('bash', [f.driver], { cwd: f.root, env: f.env, encoding: 'utf8' });
  const calls = existsSync(join(f.root, 'gh-calls')) ? readFileSync(join(f.root, 'gh-calls'), 'utf8').trim().split('\n') : [];
  return { result, calls };
}

describe('Phase 1.5 board driver requires the fixed author identity', () => {
  it.each(['missing', 'non-executable', 'wrong'])('rejects %s checker before any gh call', checker => {
    const { result, calls } = run(fixture({ checker }));
    expect(result.status).toBe(2);
    expect(calls).toEqual([]);
    expect(result.stderr).not.toContain('fixture-token');
  });

  it('cannot bypass a missing helper using the legacy skip flag', () => {
    const { result, calls } = run(fixture({ checker: 'missing', env: { GHP_SKIP_TOKEN_IDENTITY_CHECK: '1' } }));
    expect(result.status).toBe(2);
    expect(calls).toEqual([]);
  });

  it('cannot replace author identity using the legacy expected-identity flag', () => {
    const { result, calls } = run(fixture({ checker: 'wrong', env: { GHP_EXPECTED_IDENTITY: 'nathanpayne-codex' } }));
    expect(result.status).toBe(2);
    expect(calls).toEqual([]);
  });

  it('accepts the author and rechecks before each mocked read and write', () => {
    const f = fixture();
    const { result, calls } = run(f);
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter(c => c === 'project item-add')).toHaveLength(2);
    expect(calls.filter(c => c === 'project item-edit')).toHaveLength(2);
    expect(Number(readFileSync(join(f.root, 'checks'), 'utf8'))).toBe(calls.length + 1);
    const wrapped = readFileSync(join(f.root, 'wrapper-calls'), 'utf8').trim().split('\n');
    expect(wrapped).toHaveLength(4);
    expect(wrapped.every(c => /^gh project item-(add|edit) /.test(c))).toBe(true);
  });

  it('rejects a missing author wrapper before any mutation', () => {
    const { result, calls } = run(fixture({ wrapper: false }));
    expect(result.status).toBe(2);
    expect(calls.filter(c => /project item-(add|edit)/.test(c))).toEqual([]);
  });

  it('blocks a later field mutation when identity verification stops succeeding', () => {
    const { result, calls } = run(fixture({ rejectAt: 7 }));
    expect(result.status).toBe(2);
    expect(calls.filter(c => c === 'project item-add')).toHaveLength(2);
    expect(calls.filter(c => c === 'project item-edit')).toHaveLength(0);
  });

  it('stops on a single rejected item-add check even though ordinary add failures are handled', () => {
    const f = fixture({ rejectAt: 2, rejectOnly: true });
    const { result, calls } = run(f);
    expect(result.status).toBe(2);
    expect(calls).toEqual([]);
    expect(Number(readFileSync(join(f.root, 'checks'), 'utf8'))).toBe(2);
  });
});
