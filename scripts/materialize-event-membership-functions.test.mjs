#!/usr/bin/env node

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const realScript = path.join(testDir, 'materialize-event-membership-functions.mjs');

const sourceWith = (count) => Array.from({ length: count }, (_, index) => `// <event-membership-functions>
export const primitive${index + 1} = ${index + 1};
// </event-membership-functions>`).join('\n\n');

test('materializes the canonical membership blocks and detects drift', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'fiveacross-membership-materializer-'));
  const fixtureScript = path.join(fixtureRoot, 'scripts/materialize-event-membership-functions.mjs');
  const fixtureSource = path.join(fixtureRoot, 'src/data/eventMembership.ts');
  const fixtureOutput = path.join(fixtureRoot, 'functions/src/eventMembership.generated.ts');

  function run(...args) {
    return spawnSync(process.execPath, [fixtureScript, ...args], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
  }

  try {
    await mkdir(path.dirname(fixtureScript), { recursive: true });
    await mkdir(path.dirname(fixtureSource), { recursive: true });
    await mkdir(path.dirname(fixtureOutput), { recursive: true });
    await copyFile(realScript, fixtureScript);
    await writeFile(fixtureSource, sourceWith(3), 'utf8');

    const materialized = run();
    assert.equal(materialized.status, 0, materialized.stderr);
    const output = await readFile(fixtureOutput, 'utf8');
    assert.match(output, /do_not_edit: true/);
    assert.match(output, /source_ref: src\/data\/eventMembership\.ts#event-membership-functions/);
    assert.match(output, /export const primitive1 = 1;/);
    assert.match(output, /export const primitive3 = 3;/);

    const current = run('--check');
    assert.equal(current.status, 0, current.stderr);

    await writeFile(fixtureOutput, `${output}// stale\n`, 'utf8');
    const stale = run('--check');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Generated membership mirror is stale/);

    await writeFile(fixtureSource, sourceWith(2), 'utf8');
    const missingMarker = run();
    assert.notEqual(missingMarker.status, 0);
    assert.match(missingMarker.stderr, /Expected exactly 3 event-membership-functions blocks/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
