// @vitest-environment node
//
// Exercises the actual commit/discard primitives `render-og-editions.mjs`
// calls (#713 round 2), against a real filesystem in a temp directory — not
// a reimplementation of the atomicity contract, so a regression to the
// production code fails this test rather than a parallel copy of it.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitStaged, discardStaged } from './og-stage-commit.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-stage-commit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a scratch file and a pre-existing committed destination, mirroring
 *  the shape `render-og-editions.mjs` stages: `{ id, scratch, dest, mirror }`
 *  plus whatever bytes are already sitting at `dest` before this run. */
function seedEdition(id, { existingDestBytes } = {}) {
  const scratch = join(dir, `og-${id}.png.render-tmp.png`);
  const dest = join(dir, `og-${id}.png`);
  const mirror = join(dir, `${id}-mirror.png`);
  writeFileSync(scratch, `new-${id}-bytes`);
  if (existingDestBytes !== undefined) writeFileSync(dest, existingDestBytes);
  return { id, scratch, dest, mirror };
}

describe('commitStaged (#699 / #713)', () => {
  it('renames every scratch file onto its destination and writes the mirror', () => {
    const staged = [seedEdition('gcb'), seedEdition('vacay')];
    const written = commitStaged(staged);

    expect(written).toEqual([
      { id: 'gcb', dest: staged[0].dest, mirror: staged[0].mirror },
      { id: 'vacay', dest: staged[1].dest, mirror: staged[1].mirror },
    ]);
    expect(existsSync(staged[0].scratch)).toBe(false);
    expect(readFileSync(staged[0].dest, 'utf8')).toBe('new-gcb-bytes');
    expect(readFileSync(staged[0].mirror, 'utf8')).toBe('new-gcb-bytes');
    expect(readFileSync(staged[1].dest, 'utf8')).toBe('new-vacay-bytes');
  });
});

describe('discardStaged (#713 — the partial-`--all`-failure case)', () => {
  it('deletes every staged scratch file without touching any destination', () => {
    // Two editions already passed their own hard-cap check and are staged
    // (scratch written, `dest` NOT yet touched) when a later edition in the
    // same `--all` run fails. `render-og-editions.mjs`'s catch block calls
    // discardStaged on exactly this array before rethrowing.
    const gcb = seedEdition('gcb', { existingDestBytes: 'old-gcb-bytes' });
    const vacay = seedEdition('vacay', { existingDestBytes: 'old-vacay-bytes' });
    const staged = [gcb, vacay];

    discardStaged(staged);

    // Scratch files are gone...
    expect(existsSync(gcb.scratch)).toBe(false);
    expect(existsSync(vacay.scratch)).toBe(false);
    // ...but the previously-committed destinations are UNCHANGED — this is
    // the #713 guarantee: a failed `--all` run must not leave a partially
    // updated render set, so the earlier editions' passing renders must not
    // become durable just because they happened to be checked first.
    expect(readFileSync(gcb.dest, 'utf8')).toBe('old-gcb-bytes');
    expect(readFileSync(vacay.dest, 'utf8')).toBe('old-vacay-bytes');
  });

  it('tolerates a scratch file that was never written', () => {
    const staged = [{ id: 'gcb', scratch: join(dir, 'missing.png'), dest: join(dir, 'og-gcb.png'), mirror: join(dir, 'm.png') }];
    expect(() => discardStaged(staged)).not.toThrow();
  });

  it('is a no-op on an empty staged list', () => {
    expect(() => discardStaged([])).not.toThrow();
    expect(commitStaged([])).toEqual([]);
  });
});
