import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/worker-deploy.sh');

describe('worker deploy guard', () => {
  it.each(['--route', '--config', '--cwd', '--domain', '--'])('refuses forwarded Wrangler argument %s', (argument) => {
    const result = spawnSync('bash', [script, '--force', argument], { encoding: 'utf8' });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('does not accept Wrangler arguments');
  });
});
