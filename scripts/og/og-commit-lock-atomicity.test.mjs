// @vitest-environment node
//
// Pins the structural fix for id 3762692296 (#713 round 5): a lock file
// must never become visible under its `lockPathFor(dest)` name — i.e.
// `${dest}.commit-lock` — with incomplete content.
//
// `tryAcquireOne` (og-commit-lock.mjs, not exported) used to
// `openSync(lockPath, 'wx')` directly and write the pid into it as a
// SEPARATE step. That left a real window, between the create and the
// write, where `lockPath` existed on disk empty. A concurrent
// `stealIfStale` landing in that window reads an unparseable pid, treats
// the lock as belonging to a dead process, and unlinks it out from under
// the acquirer that is still mid-write — so two processes can both end up
// believing they hold the same destination's commit lock.
//
// The vulnerable window is a single syscall pair, so reproducing the
// actual OS-level race deterministically (or even reliably under
// contention) is not practical. This pins the MECHANISM Codex asked for
// instead ("use an ownership primitive that cannot expose a partially
// initialized lock"): spying on `node:fs` proves `lockPath` is never the
// target of a direct `openSync(..., 'wx')`, and that the file `linkSync`
// publishes it FROM already has its full pid content at the moment the
// link is made — so there is no observable state where `lockPath` exists
// but isn't yet fully written.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    linkSync: vi.fn((src, dest) => {
      // Captured synchronously, before the passthrough call, so this
      // records exactly what was on disk at `src` the instant `lockPath`
      // was about to become that content — not a snapshot taken later,
      // after other code has had a chance to mutate it.
      linkSourceContentAtCallTime.push(actual.readFileSync(src, 'utf8'));
      return actual.linkSync(src, dest);
    }),
    // Passthrough by default — the stale-takeover describe block below
    // overrides this per-test to land a swap between stealIfStale's two
    // statSync calls.
    statSync: vi.fn(actual.statSync),
  };
});

const { withDestinationLocks } = await import('./og-commit-lock.mjs');
const fs = await import('node:fs');
const actualFs = await vi.importActual('node:fs');

let dir;
let linkSourceContentAtCallTime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-commit-lock-atomicity-'));
  linkSourceContentAtCallTime = [];
  fs.openSync.mockClear();
  fs.linkSync.mockClear();
  fs.statSync.mockClear();
  fs.statSync.mockImplementation(actualFs.statSync);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lock acquisition never exposes a partially-written lock file (id 3762692296)', () => {
  it('never creates the lock path itself via a direct openSync — only a private scratch path', () => {
    const dest = join(dir, 'gcb.png');
    const lockPath = `${dest}.commit-lock`;

    const release = withDestinationLocks([{ dest }]);
    try {
      const openedPaths = fs.openSync.mock.calls.map(([path]) => path);
      expect(openedPaths.length).toBeGreaterThan(0);
      for (const path of openedPaths) {
        expect(path).not.toBe(lockPath);
      }
    } finally {
      release();
    }
  });

  it('publishes the lock only via linkSync, whose target is the lock path', () => {
    const dest = join(dir, 'gcb.png');
    const lockPath = `${dest}.commit-lock`;

    const release = withDestinationLocks([{ dest }]);
    try {
      expect(fs.linkSync).toHaveBeenCalledTimes(1);
      const [, publishedAs] = fs.linkSync.mock.calls[0];
      expect(publishedAs).toBe(lockPath);
    } finally {
      release();
    }
  });

  it('the source linkSync publishes from already contains the full pid line — never empty or partial', () => {
    const dest = join(dir, 'gcb.png');

    const release = withDestinationLocks([{ dest }]);
    try {
      expect(linkSourceContentAtCallTime).toHaveLength(1);
      // A regression to open-then-write-in-place would let this capture an
      // empty string (the file exists but nothing has been written to it
      // yet) or a truncated digit sequence. The fix guarantees the content
      // is already the complete "<pid>\n" line by the time anything makes
      // it visible under the lock path's name.
      expect(linkSourceContentAtCallTime[0]).toMatch(/^\d+\n$/);
    } finally {
      release();
    }
  });
});

describe('a stale-looking lock is not stolen if it is replaced between the staleness check and the delete (id 3762857439, #713 round 7)', () => {
  it("does not delete a healthy lock a waiter just published in that window, and never lets this call acquire it either", () => {
    const dest = join(dir, 'gcb.png');
    const lockPath = `${dest}.commit-lock`;

    // "A"'s lock: a guaranteed-dead pid, so stealIfStale's staleness check
    // decides to steal it on the very first poll, regardless of STALE_MS.
    const deadA = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    actualFs.writeFileSync(lockPath, `${deadA.pid}\n`);

    // stealIfStale calls statSync(lockPath) twice: once to read the
    // mtime/inode it bases its staleness decision on, and once more (the
    // fix under test) immediately before the unlink, to confirm the file is
    // still the one it decided about. Landing the swap between those two
    // calls reproduces exactly the race Codex described: another waiter's
    // `linkSync`-published, fully healthy lock ("B") replaces A's in that
    // window.
    let calls = 0;
    fs.statSync.mockImplementation((p, ...rest) => {
      const result = actualFs.statSync(p, ...rest);
      if (p === lockPath) {
        calls += 1;
        if (calls === 1) {
          actualFs.unlinkSync(lockPath);
          actualFs.writeFileSync(lockPath, `${process.pid}\n`);
        }
      }
      return result;
    });

    // B's lock is real, live, and fresh — a correct implementation must
    // leave it alone and therefore never acquire it either within this
    // short timeout.
    expect(() => withDestinationLocks([{ dest }], { timeoutMs: 300 })).toThrow(/timed out/);

    // The decisive assertion: B's lock is still exactly what B published —
    // not deleted by the steal that was reasoning about A's now-gone lock,
    // and not overwritten by this call's own (wrongly) successful acquire.
    expect(actualFs.readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
