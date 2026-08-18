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
    // Passthrough in every test in this file — spied only so a future test
    // can assert on statSync call shape without needing to add the mock
    // wiring separately.
    statSync: vi.fn(actual.statSync),
    writeSync: vi.fn(actual.writeSync),
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
  fs.writeSync.mockClear();
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
      expect(linkSourceContentAtCallTime[0]).toMatch(/^\d+\n.+\.acquire-tmp\.\d+-[0-9a-f]+\n$/);
    } finally {
      release();
    }
  });

  it('finishes a short ownership write before linkSync publishes the lock', () => {
    const dest = join(dir, 'gcb.png');
    fs.writeSync.mockImplementation((fd, bytes, offset, length, position) =>
      actualFs.writeSync(fd, bytes, offset, Math.min(length, 1), position),
    );

    const release = withDestinationLocks([{ dest }]);
    try {
      expect(fs.writeSync.mock.calls.length).toBeGreaterThan(1);
      expect(linkSourceContentAtCallTime[0]).toMatch(/^\d+\n.+\.acquire-tmp\.\d+-[0-9a-f]+\n$/);
    } finally {
      release();
    }
  });
});

describe('a live holder remains exclusive even when its lock is old (#713 Phase 4b)', () => {
  it('does not steal a live lock solely because its mtime exceeded the stale interval', () => {
    const dest = join(dir, 'gcb.png');
    const lockPath = `${dest}.commit-lock`;
    const releaseA = withDestinationLocks([{ dest }]);
    // The A holder is still alive but paused or slow. Age alone cannot revoke
    // its ownership: doing so would let A and a replacement interleave their
    // publication/rollback critical sections.
    const old = new Date(Date.now() - 120_000);
    actualFs.utimesSync(lockPath, old, old);

    try {
      expect(() => withDestinationLocks([{ dest }], { timeoutMs: 300 })).toThrow(/timed out/);
      expect(actualFs.existsSync(lockPath)).toBe(true);
    } finally {
      releaseA();
    }
  });

  it('does not steal a lock when a restricted environment reports EPERM for its live owner', () => {
    const dest = join(dir, 'gcb.png');
    const lockPath = `${dest}.commit-lock`;
    actualFs.writeFileSync(lockPath, `424242\n`);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('not permitted'), { code: 'EPERM' });
      throw err;
    });

    try {
      expect(() => withDestinationLocks([{ dest }], { timeoutMs: 300 })).toThrow(/timed out/);
      expect(actualFs.existsSync(lockPath)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });
});
