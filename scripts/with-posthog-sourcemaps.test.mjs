// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const wrapper = fileURLToPath(new URL('./with-posthog-sourcemaps.sh', import.meta.url));
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(fail = false) {
  const root = mkdtempSync(join(tmpdir(), 'posthog-key-')); roots.push(root);
  const log = join(root, 'received.json');
  writeFileSync(join(root, 'op'), `#!/bin/sh\n${fail ? 'exit 19' : "printf 'fixture-secret'"}\n`); chmodSync(join(root, 'op'), 0o755);
  const run = (args = ['space and $literal']) => spawnSync('bash', [wrapper, '--', process.execPath, '-e',
    "require('fs').writeFileSync(process.argv[1],JSON.stringify({key:process.env.POSTHOG_UPLOAD_API_KEY,args:process.argv.slice(2)}))", log, ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH, POSTHOG_UPLOAD_API_KEY: 'ambient-must-not-win', POSTHOG_UPLOAD_OP_REF: 'op://fixture/item/credential' } });
  return { log, run };
}
describe('1Password source-map build wrapper', () => {
  it('passes the selected key only in the child environment and preserves literal arguments', () => {
    const f = fixture(); const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('fixture-secret');
    expect(JSON.parse(readFileSync(f.log))).toEqual({ key: 'fixture-secret', args: ['space and $literal'] });
  });
  it('fails closed on op failure instead of using the ambient token', () => {
    const f = fixture(true); const result = f.run();
    expect(result.status).toBe(19);
    expect(() => readFileSync(f.log)).toThrow();
  });
});
