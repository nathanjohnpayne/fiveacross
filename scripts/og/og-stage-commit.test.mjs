// @vitest-environment node
//
// Exercises the actual commit/discard primitives `render-og-editions.mjs`
// calls (#713 round 2 + round 3), against a real filesystem in a temp
// directory — not a reimplementation of the atomicity contract, so a
// regression to the production code fails this test rather than a parallel
// copy of it.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratchPathFor } from './og-scratch-path.mjs';
import { commitStaged, discardStaged } from './og-stage-commit.mjs';

/** True if any file in `target`'s directory still starts with
 *  `${basename(target)}.rollback-tmp` — i.e. a leaked backup for `target`,
 *  under round 6's per-invocation-token naming (`${p}.rollback-tmp.<token>`)
 *  where the exact suffix isn't known to the test. Replaces a literal
 *  `existsSync(`${target}.rollback-tmp`)` check, which the token made
 *  vacuously false regardless of whether a backup actually leaked. */
function hasLeakedBackup(target) {
  const dir_ = dirname(target);
  const prefix = `${basename(target)}.rollback-tmp`;
  return existsSync(dir_) && readdirSync(dir_).some((name) => name.startsWith(prefix));
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-stage-commit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a scratch file and a pre-existing committed destination (and
 *  mirror), mirroring the shape `render-og-editions.mjs` stages:
 *  `{ id, scratch, dest, mirror }` plus whatever bytes are already sitting
 *  at `dest`/`mirror` before this run. `mirrorDir` lets a test point the
 *  mirror somewhere other than `dir` itself — used to sabotage ONE entry's
 *  mirror directory without touching the others. */
function seedEdition(id, { existingDestBytes, existingMirrorBytes, mirrorDir = dir } = {}) {
  const scratch = join(dir, `og-${id}.png.render-tmp.${process.pid}-seed${id}.png`);
  const dest = join(dir, `og-${id}.png`);
  const mirror = join(mirrorDir, `${id}-mirror.png`);
  writeFileSync(scratch, `new-${id}-bytes`);
  if (existingDestBytes !== undefined) writeFileSync(dest, existingDestBytes);
  if (existingMirrorBytes !== undefined) {
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(mirror, existingMirrorBytes);
  }
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

describe('commitStaged rollback on a mid-commit failure (id 3762436072, #713 round 3)', () => {
  it('restores every already-committed destination and mirror to their pre-commit bytes when a later entry fails', () => {
    const gcb = seedEdition('gcb', { existingDestBytes: 'old-gcb-bytes', existingMirrorBytes: 'old-gcb-mirror-bytes' });
    const blockedMirrorDir = join(dir, 'blocked-mirror-dir');
    // Sabotage vacay's mirror directory: a FILE sits where commitStaged
    // needs to `mkdirSync` a directory, so its commit step throws partway
    // through the overall commit phase — the "mirror is unwritable" example
    // Codex named. gcb, staged before vacay, must already be durable by the
    // time this throws — that is exactly the partially-committed state the
    // finding is about.
    writeFileSync(blockedMirrorDir, 'not a directory');
    const vacay = seedEdition('vacay', { existingDestBytes: 'old-vacay-bytes', mirrorDir: blockedMirrorDir });
    const staged = [gcb, vacay];

    expect(() => commitStaged(staged)).toThrow();

    // gcb committed successfully before vacay's mkdir failed — without
    // rollback its destination/mirror would be left at the NEW bytes even
    // though the run as a whole failed. With rollback they must be
    // byte-identical to what was there before this call.
    expect(readFileSync(gcb.dest, 'utf8')).toBe('old-gcb-bytes');
    expect(readFileSync(gcb.mirror, 'utf8')).toBe('old-gcb-mirror-bytes');
    // No rollback backup files left behind on disk — checked by prefix
    // (round 6 mixes a per-call token into the suffix), not the old literal
    // `${target}.rollback-tmp` path, which is never a real file anymore and
    // so would pass this assertion vacuously regardless of an actual leak.
    expect(hasLeakedBackup(gcb.dest)).toBe(false);
    expect(hasLeakedBackup(gcb.mirror)).toBe(false);

    // vacay's mkdir failed before its destination/mirror were ever touched.
    expect(readFileSync(vacay.dest, 'utf8')).toBe('old-vacay-bytes');
    expect(existsSync(vacay.mirror)).toBe(false);
    // vacay's scratch file was never consumed — it is still on disk for the
    // caller's `discardStaged` sweep (render-og-editions.mjs calls it from
    // the same catch block on this failure).
    expect(existsSync(vacay.scratch)).toBe(true);
    discardStaged(staged);
    expect(existsSync(vacay.scratch)).toBe(false);
  });

  it('removes a newly-created destination and mirror that had no prior version, rather than leaving them behind', () => {
    // gcb has no pre-existing dest/mirror at all (a first-ever render of a
    // new Edition) — rollback must DELETE what it created, not merely
    // "restore" the (nonexistent) original.
    const gcb = seedEdition('gcb');
    const blockedMirrorDir = join(dir, 'blocked-mirror-dir');
    writeFileSync(blockedMirrorDir, 'not a directory');
    const vacay = seedEdition('vacay', { mirrorDir: blockedMirrorDir });

    expect(() => commitStaged([gcb, vacay])).toThrow();

    expect(existsSync(gcb.dest)).toBe(false);
    expect(existsSync(gcb.mirror)).toBe(false);
  });
});

describe('concurrent invocations of the same Edition do not clobber each other (id 3762436077, #713 round 3)', () => {
  it('keeps two invocations\' staged bytes independent even though both target the same dest', () => {
    const dest = join(dir, 'og-gcb.png');
    const mirror = join(dir, 'gcb-mirror.png');

    // Two separate "processes" — a manual preview overlapping an `--all`
    // run — call `scratchPathFor(dest)` independently for the SAME
    // Edition. Before #713 round 3 this produced the identical path for
    // both, so one invocation's rename-during-commit could delete the file
    // the other still expected to stat or commit.
    const scratchA = scratchPathFor(dest);
    const scratchB = scratchPathFor(dest);
    expect(scratchA).not.toBe(scratchB);

    writeFileSync(scratchA, 'invocation-a-bytes');
    writeFileSync(scratchB, 'invocation-b-bytes');

    // Invocation A commits first.
    commitStaged([{ id: 'gcb', scratch: scratchA, dest, mirror }]);
    expect(readFileSync(dest, 'utf8')).toBe('invocation-a-bytes');
    // Invocation B's staged bytes are untouched by A's commit. With a
    // deterministic scratch path this assertion is exactly what fails: A's
    // rename would have consumed the one shared file, and B's write (or
    // commit) would race it.
    expect(readFileSync(scratchB, 'utf8')).toBe('invocation-b-bytes');

    // Invocation B commits second — ordinary last-commit-wins, not a crash
    // from a missing or clobbered scratch file.
    commitStaged([{ id: 'gcb', scratch: scratchB, dest, mirror }]);
    expect(readFileSync(dest, 'utf8')).toBe('invocation-b-bytes');
  });
});

// Both calls above are made serially, from a single invocation's-eye view —
// they pin round 3's scratch-path uniqueness, not whether `commitStaged`
// itself tolerates a SECOND invocation publishing to the same destination
// WHILE the first is still mid-commit. Codex re-raised exactly that gap
// (id 3762521202, #713 round 6): a serial test can't expose an interleaved
// commit-phase race. See og-stage-commit-concurrency.test.mjs for the
// interleaved (deterministic, mocked) and real-worker-thread coverage of
// that case, and the "Concurrency contract" note on `commitStaged` in
// og-stage-commit.mjs for why the lock lives in the caller, not here.
