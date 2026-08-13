// @vitest-environment node
//
// Closes the gap Codex re-raised on `commitStaged` itself (id 3762521202,
// #713 round 6): og-stage-commit.test.mjs's existing concurrency coverage
// calls `commitStaged` SERIALLY — invocation A fully finishes before
// invocation B starts — so it can prove scratch-path uniqueness (round 3)
// but cannot expose a race that only exists while two invocations are
// mid-commit AT THE SAME TIME. This file adds the pieces that do:
//
// 1. A deterministic, mocked reproduction of the exact interleave the old
//    shared `${target}.rollback-tmp` backup path allowed: invocation A
//    fully completes (including deleting its own backup) DURING the single
//    syscall window between invocation B's own backup and B's later
//    failure — pinning the round-6 fix (per-invocation-unique backup
//    names). Fails on the pre-round-6 code, passes on the fixed code (see
//    the "Verification" note in the PR body for the manual break/restore
//    that proved it).
// 2. A second, distinct deterministic reproduction proving round 6's
//    backup-uniqueness fix is NOT by itself sufficient — `commitStaged`
//    still needs external serialization even with unique backup names.
//    `commitStaged` records `destExisted`/`mirrorExisted` once, near the
//    top of its per-entry work; a rollback for an entry that recorded
//    `false` DELETES whatever is at the target rather than restoring it.
//    If a peer invocation legitimately creates and commits `dest` in the
//    gap between this entry's existed-check and its own later failure, an
//    unlocked rollback deletes that peer's real, successfully committed
//    file — round 6's unique backup NAMES do nothing to prevent this,
//    since no backup collision is involved. This is the concrete "why the
//    lock still has to live at the caller" case the header comment on
//    `commitStaged` promises a test for.
//
//    Both (1) and (2) use the same technique og-commit-lock-atomicity.test
//    -mjs already established for this exact class of bug: mock the one
//    call whose timing matters and drive the interleave deterministically,
//    rather than racing real OS threads against a window narrow enough
//    that, empirically (see the PR body), thousands of real concurrent
//    iterations never land it reliably. `vi.doMock` (not the file-hoisted
//    `vi.mock`) keeps the fs mock scoped to each test, not the whole file
//    — the third describe block below needs a REAL filesystem.
// 3. A real-worker-thread stress test — the model og-commit-lock.test.mjs
//    already established for this module pair — that exercises
//    `commitStaged` ITSELF (not a stand-in critical section) wrapped in
//    `withDestinationLocks`, exactly as `render-og-editions.mjs` wires the
//    two together, under genuine concurrent load with a mix of succeeding
//    and failing (rollback-triggering) commits racing from a brand new
//    destination. This is the "exercised through the locked path"
//    coverage Codex asked for: it proves the actual production
//    composition — not an abstract stand-in — survives real OS scheduling
//    without corruption. It is a soak test, not a red/green regression
//    pin: (1) and (2) are what actually fail on the unfixed code.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir;
let mirrorDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-stage-commit-concurrency-'));
  mirrorDir = mkdtempSync(join(tmpdir(), 'og-stage-commit-concurrency-mirror-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(mirrorDir, { recursive: true, force: true });
});

/** No `*.rollback-tmp*` file for `target` is still on disk — a leaked
 *  backup means some invocation's cleanup (success path or rollback) never
 *  ran, or ran against the wrong file. */
function hasLeakedBackup(target) {
  const d = dirname(target);
  const prefix = `${basename(target)}.rollback-tmp`;
  return existsSync(d) && readdirSync(d).some((name) => name.startsWith(prefix));
}

describe("commitStaged: a concurrent commit that finishes mid-rollback must not corrupt the other invocation's recovery (id 3762521202, #713 round 6)", () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it("restores the pre-commit bytes even when another invocation fully commits (and cleans up its own backup) in the middle of this invocation's failure", async () => {
    const dest = join(dir, 'og-gcb.png');
    const mirror = join(mirrorDir, 'gcb-mirror.png');
    writeFileSync(dest, 'original-dest-bytes');
    writeFileSync(mirror, 'original-mirror-bytes');

    const scratchB = join(dir, 'og-gcb.png.render-tmp.b.png');
    writeFileSync(scratchB, 'b-bytes');
    const scratchA = join(dir, 'og-gcb.png.render-tmp.a.png');
    writeFileSync(scratchA, 'a-bytes');

    const realCopyFileSync = (await vi.importActual('node:fs')).copyFileSync;
    let triggered = false;
    let commitStagedRef;

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        copyFileSync: vi.fn((src, dst) => {
          // Invocation B's own mirror-copy step — the one line in the whole
          // commit that Codex's example ("mirror goes unwritable mid-copy")
          // targets. The FIRST time it is reached, race invocation A in:
          // A runs to full, successful completion — backing up, renaming,
          // copying, and (on success) deleting ITS OWN backup — entirely
          // INSIDE this call, before B's own copy is allowed to fail. Under
          // the pre-round-6 shared backup path, A's cleanup deletes the
          // SAME file B's later rollback still needs.
          if (!triggered && src === dest && dst === mirror) {
            triggered = true;
            commitStagedRef([{ id: 'a', scratch: scratchA, dest, mirror }]);
            throw new Error('simulated disk-full mid-copy for invocation B');
          }
          return realCopyFileSync(src, dst);
        }),
      };
    });
    ({ commitStaged: commitStagedRef } = await import('./og-stage-commit.mjs'));

    expect(() => commitStagedRef([{ id: 'b', scratch: scratchB, dest, mirror }])).toThrow(
      /simulated disk-full/,
    );

    // Invocation A's commit is real and unrelated to B's failure — it
    // lands regardless. Invocation B's own commit failed and must have
    // rolled ITS OWN destination/mirror back to what was there before B
    // started, regardless of what A did in between. Under the pre-fix
    // shared backup-path bug, A's cleanup deletes B's backup out from under
    // it, so B's rollback silently fails (caught and logged, not rethrown —
    // see `rollback()`) and `dest`/`mirror` are left at A's committed bytes
    // instead of B's pre-commit bytes. This assertion is exactly what
    // catches that: it fails on the pre-round-6 code and passes once the
    // backup path is per-invocation-unique.
    expect(readFileSync(dest, 'utf8')).toBe('original-dest-bytes');
    expect(readFileSync(mirror, 'utf8')).toBe('original-mirror-bytes');
  });
});

describe('commitStaged called directly (not through withDestinationLocks): an unlocked rollback for a never-existed destination CAN delete a peer\'s legitimately committed file (id 3762521202, #713 round 6)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it("deletes invocation A's committed file when B's own destExisted/mirrorExisted check ran before A ever created it — proving the caller's lock is still required even with unique backup names, and that this is real, not hypothetical", async () => {
    const dest = join(dir, 'og-vacay.png');
    const mirror = join(mirrorDir, 'vacay-mirror.png');
    // Neither dest nor mirror exists yet — this is the first-ever render of
    // a brand new Edition, which is exactly when `destExisted`/
    // `mirrorExisted` are captured as `false`.

    const scratchB = join(dir, 'og-vacay.png.render-tmp.b.png');
    writeFileSync(scratchB, 'b-bytes');
    const scratchA = join(dir, 'og-vacay.png.render-tmp.a.png');
    writeFileSync(scratchA, 'a-bytes');

    const realCopyFileSync = (await vi.importActual('node:fs')).copyFileSync;
    let triggered = false;
    let commitStagedRef;

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        copyFileSync: vi.fn((src, dst) => {
          // By the time B reaches its own mirror-copy call, B has ALREADY
          // recorded destExisted=false (there was nothing there when B
          // started) and ALREADY renamed its scratch onto `dest` — so
          // `dest` exists now, but B's rollback plan is fixed: "restore =
          // delete, since it recorded nothing was there before me". Race
          // invocation A in here, entirely between B's rename and B's own
          // failure: A sees `dest` already present (B's in-flight bytes),
          // backs it up under A's own unique name, and commits ITS OWN
          // scratch on top — a completely legitimate, independent commit
          // that has nothing to do with B's failure.
          if (!triggered && src === dest && dst === mirror) {
            triggered = true;
            commitStagedRef([{ id: 'a', scratch: scratchA, dest, mirror }]);
            throw new Error('simulated disk-full mid-copy for invocation B');
          }
          return realCopyFileSync(src, dst);
        }),
      };
    });
    ({ commitStaged: commitStagedRef } = await import('./og-stage-commit.mjs'));

    expect(() => commitStagedRef([{ id: 'b', scratch: scratchB, dest, mirror }])).toThrow(
      /simulated disk-full/,
    );

    // B's rollback restores based on WHAT B ITSELF OBSERVED before it ever
    // touched anything: nothing was there, so — absent any lock — B's
    // rollback DELETES `dest`/`mirror`, destroying A's real, independently
    // successful commit. This is exactly what a caller that calls
    // `commitStaged` directly (bypassing `withDestinationLocks`, exactly
    // what the existing og-stage-commit.test.mjs concurrency tests do, and
    // exactly what a new caller unaware of the concurrency contract would
    // do too) gets — proving the hazard the "Concurrency contract" note on
    // `commitStaged` warns about is real, not hypothetical, the same way
    // og-commit-lock.test.mjs's "WITHOUT the lock, workers CAN be inside
    // the shared critical section" case proves ITS race is real before
    // proving the lock closes it. The fix is not inside `commitStaged` —
    // it is that a caller publishing to a shared destination must hold the
    // lock for the whole commit-or-rollback phase. See the third describe
    // block below for the SAME shape of race, run for real, wrapped in
    // that lock, where A's file survives instead.
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(mirror)).toBe(false);
  });
});

describe('commitStaged exercised through the locked path under real concurrency (id 3762521202, #713 round 6)', () => {
  // Real OS threads (worker_threads), not cooperative async interleaving —
  // Node's single-threaded event loop can never race against itself. Each
  // worker repeatedly stages and commits ITS OWN scratch bytes to the SAME
  // shared destination/mirror pair, racing from a not-yet-existing
  // destination (the exact condition the second mocked test above pins) —
  // a fraction of iterations are sabotaged (a blocked mirror directory) so
  // `commitStaged` throws and rolls back, forcing real contention over
  // both the backup mechanism and the existed-flag rollback path — all
  // wrapped in `withDestinationLocks` exactly the way
  // `render-og-editions.mjs` wires the two together.
  const commitLockUrl = new URL('./og-commit-lock.mjs', import.meta.url).href;
  const stageCommitUrl = new URL('./og-stage-commit.mjs', import.meta.url).href;

  function runConcurrentCommits({ workers = 6, iterations = 20 }) {
    const dest = join(dir, 'og-race.png');
    const mirror = join(mirrorDir, 'race-mirror.png');
    // Deliberately NOT pre-seeded — see the module header.

    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { commitLockUrl, stageCommitUrl, dest, mirror, dir, workerId, iterations } = workerData;

      async function run() {
        const { commitStaged } = await import(stageCommitUrl);
        const { withDestinationLocks } = await import(commitLockUrl);
        const fs = require('node:fs');
        const path = require('node:path');

        for (let i = 0; i < iterations; i++) {
          const scratch = path.join(dir, \`race-scratch.\${workerId}-\${i}.png\`);
          fs.writeFileSync(scratch, \`w\${workerId}-i\${i}-bytes\`);
          // Every third iteration is sabotaged: point THIS attempt's mirror
          // at a path that can never be written (a file sits where
          // commitStaged needs a directory), forcing a real rollback to
          // race the other workers' successful commits on the SAME dest.
          const sabotage = i % 3 === 0;
          const thisMirror = sabotage ? path.join(dir, \`blocked-\${workerId}-\${i}\`, 'm.png') : mirror;
          if (sabotage) {
            fs.writeFileSync(path.join(dir, \`blocked-\${workerId}-\${i}\`), 'not a directory');
          }

          const release = withDestinationLocks([{ dest }]);
          try {
            commitStaged([{ id: \`w\${workerId}\`, scratch, dest, mirror: thisMirror }]);
          } catch {
            // Expected for sabotaged iterations — commitStaged already
            // rolled its own dest/mirror back before rethrowing.
          } finally {
            release();
          }
        }
        parentPort.postMessage('done');
      }
      run();
    `;

    const promises = [];
    for (let workerId = 0; workerId < workers; workerId++) {
      const workerData = { commitLockUrl, stageCommitUrl, dest, mirror, dir, iterations, workerId };
      promises.push(
        new Promise((resolve, reject) => {
          const w = new Worker(workerCode, { eval: true, workerData });
          w.once('message', resolve);
          w.once('error', reject);
        }),
      );
    }
    return Promise.all(promises).then(() => ({ dest, mirror }));
  }

  it(
    'real concurrent commits (mixed success and rollback, racing from a not-yet-existing destination) never leave a peer\'s committed file deleted, dest/mirror torn, or a backup leaked',
    async () => {
      const { dest, mirror } = await runConcurrentCommits({});

      // Some worker must have ended up as the last committer — `dest` must
      // still exist and hold real committed bytes. An unlocked
      // `destExisted`-was-false rollback deleting a peer's already-real
      // file (see the second describe block above) shows up here as a
      // MISSING file, not merely a mismatched one.
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(mirror)).toBe(true);
      // Whichever iteration committed last, dest and mirror must agree —
      // `commitStaged`'s own per-call invariant, but only actually
      // guaranteed end-to-end when nothing else can be mid-commit for the
      // same destination at the same time, which is exactly what the lock
      // this test wraps every call in is supposed to guarantee.
      expect(readFileSync(dest, 'utf8')).toBe(readFileSync(mirror, 'utf8'));
      expect(hasLeakedBackup(dest)).toBe(false);
      expect(hasLeakedBackup(mirror)).toBe(false);
    },
    20_000,
  );
});
