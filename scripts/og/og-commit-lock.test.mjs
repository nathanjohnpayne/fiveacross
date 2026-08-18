// @vitest-environment node
//
// Exercises `withDestinationLocks` — the primitive `render-og-editions.mjs`
// wraps around `commitStaged` to close id 3762521202 (#713 round 4): two
// invocations of the renderer publishing the same destination at the same
// time can interleave `commitStaged`'s rename+copy pair (and its shared
// `*.rollback-tmp` backup names) unless something outside `commitStaged`
// itself serializes them.
//
// The deterministic tests below prove the acquire/release/timeout/steal
// contract directly against the filesystem. The "mutual exclusion under
// real concurrency" describe block goes further: it runs the actual race
// Codex described, with real OS threads, and proves both directions —
// that two racers CAN overlap a shared critical section with no lock (so
// the race this fix closes is real, not hypothetical), and CANNOT once
// `withDestinationLocks` wraps that section (so the fix actually closes
// it). That second pair is the one to break-and-restore for verification:
// flip `useLock` off in production wiring (or delete the lock call in
// render-og-editions.mjs) and the "holds mutual exclusion" case fails.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocked, withDestinationLocks } from './og-commit-lock.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-commit-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('withDestinationLocks — acquire, release, and dedup', () => {
  it('locks every distinct destination in the staged list and releases them all together', () => {
    const destA = join(dir, 'a.png');
    const destB = join(dir, 'b.png');
    // destA appears twice — the way `--all` staging a same-id preview would
    // never happen, but dedup must not double-acquire (which would just
    // deadlock this process against itself waiting on its own lock file).
    const release = withDestinationLocks([{ dest: destA }, { dest: destB }, { dest: destA }]);
    expect(isLocked(destA)).toBe(true);
    expect(isLocked(destB)).toBe(true);
    release();
    expect(isLocked(destA)).toBe(false);
    expect(isLocked(destB)).toBe(false);
  });

  it('also serializes a shared mirror even when the primary destinations differ', () => {
    const destA = join(dir, 'a.png');
    const destB = join(dir, 'b.png');
    const mirror = join(dir, 'shared-mirror.png');
    const release = withDestinationLocks([{ dest: destA, mirror }]);
    try {
      expect(() => withDestinationLocks([{ dest: destB, mirror }], { timeoutMs: 150 })).toThrow(/timed out/);
      expect(isLocked(mirror)).toBe(true);
    } finally {
      release();
    }
  });

  it('release is idempotent — calling it twice does not throw or affect anyone else\'s lock', () => {
    const dest = join(dir, 'gcb.png');
    const release = withDestinationLocks([{ dest }]);
    release();
    expect(() => release()).not.toThrow();
    expect(isLocked(dest)).toBe(false);
  });
});

describe('withDestinationLocks — blocks a concurrent commit on the same destination (id 3762521202)', () => {
  it('a second acquire on an already-locked destination times out instead of proceeding', () => {
    const dest = join(dir, 'gcb.png');
    const release = withDestinationLocks([{ dest }]);
    expect(() => withDestinationLocks([{ dest }], { timeoutMs: 150 })).toThrow(/timed out/);
    // The failed second attempt must not have disturbed the first holder's
    // lock — the first process's eventual commit is still protected.
    expect(isLocked(dest)).toBe(true);
    release();
  });

  it('becomes acquirable again immediately after release', () => {
    const dest = join(dir, 'gcb.png');
    const release = withDestinationLocks([{ dest }]);
    release();
    const release2 = withDestinationLocks([{ dest }], { timeoutMs: 500 });
    expect(isLocked(dest)).toBe(true);
    release2();
  });

  it('releases every lock already acquired in a call if a later destination in the same call times out', () => {
    const destA = join(dir, 'a.png');
    const destB = join(dir, 'b.png');
    const releaseA = withDestinationLocks([{ dest: destA }]);
    expect(() =>
      withDestinationLocks([{ dest: destA }, { dest: destB }], { timeoutMs: 150 }),
    ).toThrow();
    // destB was never actually contended by anyone else — a partial-acquire
    // failure must not strand it locked.
    expect(isLocked(destB)).toBe(false);
    releaseA();
  });
});

describe('withDestinationLocks — abandoned-lock recovery', () => {
  it('steals a lock file left by a process that is no longer running', () => {
    const dest = join(dir, 'gcb.png');
    // A real, guaranteed-dead pid: a child that has already exited (not a
    // made-up large integer, which risks colliding with something actually
    // alive on a shared CI box).
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(`${dest}.commit-lock`, `${dead.pid}\n`);

    const release = withDestinationLocks([{ dest }], { timeoutMs: 3000 });
    expect(isLocked(dest)).toBe(true); // now held by THIS process
    release();
  });

  it('reclaims a takeover gate left by a crashed stealer instead of wedging later renders', () => {
    const dest = join(dir, 'gcb.png');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const takeover = `${dest}.commit-lock.takeover`;
    writeFileSync(takeover, `${dead.pid}\n`);

    const release = withDestinationLocks([{ dest }], { timeoutMs: 3000 });
    try {
      expect(isLocked(dest)).toBe(true);
      expect(existsSync(takeover)).toBe(false);
    } finally {
      release();
    }
  });

  it('reclaims a recovery gate when the recovery process itself was killed mid-handoff', () => {
    const dest = join(dir, 'gcb.png');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const takeover = `${dest}.commit-lock.takeover`;
    const recovering = `${takeover}.recovering`;
    // This is the exact durable state left when a process dies after claiming
    // recovery but before publishing the replacement lock. A fixed hard link
    // here used to make every later acquire time out forever.
    writeFileSync(takeover, `${dead.pid}\n`);
    writeFileSync(recovering, `${dead.pid}\n`);

    const release = withDestinationLocks([{ dest }], { timeoutMs: 3000 });
    try {
      expect(isLocked(dest)).toBe(true);
      expect(existsSync(takeover)).toBe(false);
      expect(existsSync(recovering)).toBe(false);
    } finally {
      release();
    }
  });

  it('warns about a leftover rollback backup when stealing a lock left by a killed commit (#713 round 8, id 3762932710)', () => {
    const dest = join(dir, 'gcb.png');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(`${dest}.commit-lock`, `${dead.pid}\n`);
    // og-stage-commit.mjs's commitStaged writes this before its rename+copy
    // and only removes it via one of its own two cleanup paths (success
    // unlink or catch-block rollback) — both of which run inside the same
    // process. Still being on disk once that process is confirmed dead is
    // exactly the durable trace of a commit killed before it reached
    // either one.
    writeFileSync(`${dest}.rollback-tmp.99999-deadbeef`, 'stale-backup-bytes');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const release = withDestinationLocks([{ dest }], { timeoutMs: 3000 });
      release();
      const messages = warnSpy.mock.calls.map((args) => args.join(' '));
      expect(messages.some((m) => m.includes('rollback backup') && m.includes(dest))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not mention a rollback backup when stealing a lock with no leftover backup', () => {
    const dest = join(dir, 'gcb.png');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(`${dest}.commit-lock`, `${dead.pid}\n`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const release = withDestinationLocks([{ dest }], { timeoutMs: 3000 });
      release();
      const messages = warnSpy.mock.calls.map((args) => args.join(' '));
      expect(messages.some((m) => m.includes('rollback backup'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// #824 (Codex P2 on PR #824): the takeover-gate tests above only exercise a
// STEALER's own recovery paths (a dead lock holder, a dead prior stealer, a
// dead recovery process) — none of them puts a competing ORDINARY acquirer
// in flight while a takeover gate is actively held by a live process, so
// none of them would fail if `tryAcquireOne`'s before-takeover check
// (og-commit-lock.mjs) were deleted entirely. This closes that gap directly.
describe('withDestinationLocks — a live takeover gate excludes ordinary waiters', () => {
  it('blocks an ordinary acquirer for as long as another process holds a live takeover gate, and never publishes a lock in that window', () => {
    const dest = join(dir, 'gcb.png');
    const takeover = `${dest}.commit-lock.takeover`;
    // A live takeover holder stands in for another process actively mid-steal
    // — past its own staleness read, not yet through the unlink+republish.
    // This process's own pid keeps the holder "alive" for pidAlive's
    // `process.kill(pid, 0)` probe without needing to spawn a real process.
    writeFileSync(takeover, `${process.pid}\n`);
    // Every attempt `acquireOne`'s poll loop makes below is a real
    // publication attempt overlapping the active takeover, so a passing
    // assertion here proves no compliant waiter's lock is ever published
    // while the gate stands — not merely that a timeout error is eventually
    // thrown for some unrelated reason.
    expect(() => withDestinationLocks([{ dest }], { timeoutMs: 300 })).toThrow(/timed out/);
    expect(isLocked(dest)).toBe(false);
  });
});

describe('mutual exclusion under real concurrency (id 3762521202)', () => {
  // Both cases below use the same harness: N worker THREADS (real OS
  // scheduling — not cooperative async interleaving on one thread, which
  // Node's single-threaded event loop can never actually race against
  // itself) each loop, entering a shared "critical section" — bumping a
  // SharedArrayBuffer counter, holding it briefly, then dropping it — and
  // the main thread tracks the highest concurrent occupancy any worker
  // observed. `useLock: true` wraps that section in
  // `withDestinationLocks`/release, exactly as render-og-editions.mjs wraps
  // `commitStaged`; `useLock: false` does not, standing in for `commitStaged`
  // running unguarded the way it did before this fix.
  const modUrl = new URL('./og-commit-lock.mjs', import.meta.url).href;

  function runRace({ useLock, workers = 4, iterations = 10, holdMs = 3 }) {
    const counter = new SharedArrayBuffer(4);
    const maxSeen = new SharedArrayBuffer(4);
    const dest = join(dir, 'race.png');
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { modUrl, dest, iterations, holdMs, useLock, counterBuf, maxBuf } = workerData;
      const counter = new Int32Array(counterBuf);
      const maxSeen = new Int32Array(maxBuf);

      function sleepSync(ms) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      }

      function bumpMax(value) {
        let prev = Atomics.load(maxSeen, 0);
        while (value > prev) {
          const observed = Atomics.compareExchange(maxSeen, 0, prev, value);
          if (observed === prev) break;
          prev = observed;
        }
      }

      async function run() {
        const mod = useLock ? await import(modUrl) : null;
        for (let i = 0; i < iterations; i++) {
          const release = useLock ? mod.withDestinationLocks([{ dest }]) : null;
          const occupancy = Atomics.add(counter, 0, 1) + 1;
          bumpMax(occupancy);
          sleepSync(holdMs);
          Atomics.sub(counter, 0, 1);
          if (release) release();
        }
        parentPort.postMessage('done');
      }
      run();
    `;

    const workerData = { modUrl, dest, iterations, holdMs, useLock, counterBuf: counter, maxBuf: maxSeen };
    const promises = [];
    for (let i = 0; i < workers; i++) {
      promises.push(
        new Promise((resolve, reject) => {
          const w = new Worker(workerCode, { eval: true, workerData });
          w.once('message', () => resolve());
          w.once('error', reject);
        }),
      );
    }
    return Promise.all(promises).then(() => new Int32Array(maxSeen)[0]);
  }

  it(
    'WITHOUT the lock, workers CAN be inside the shared critical section at the same time — proving the race is real',
    async () => {
      const maxConcurrent = await runRace({ useLock: false });
      expect(maxConcurrent).toBeGreaterThan(1);
    },
    15_000,
  );

  it(
    'WITH the lock, no two workers are ever inside the critical section at the same time',
    async () => {
      const maxConcurrent = await runRace({ useLock: true });
      expect(maxConcurrent).toBe(1);
    },
    15_000,
  );
});

// Guards against a rename of this file's own path breaking the worker's
// dynamic `import(modUrl)` above in a way a passing test suite wouldn't
// otherwise catch (a typo there would make BOTH race tests below reject
// instead of resolve, not merely fail one assertion) — cheap enough to
// assert explicitly.
it('the worker harness resolves og-commit-lock.mjs from this file\'s own directory', () => {
  expect(fileURLToPath(new URL('./og-commit-lock.mjs', import.meta.url))).toMatch(/og-commit-lock\.mjs$/);
});
