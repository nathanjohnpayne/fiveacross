// Serializes `commitStaged` across concurrent renderer invocations
// (#713 round 4, id 3762521202).
//
// Round 2 made a single `--all` invocation's own commit-or-nothing behavior
// atomic. Round 3 gave the commit phase rollback and made scratch paths
// unique per invocation, closing the case where a manual preview and an
// `--all` run raced each other's SCRATCH files. Codex's round-4 finding is
// one layer further down: unique scratch names stop the two runs from
// clobbering each other's staged bytes, but `commitStaged` itself still has
// no cross-process exclusion. Two processes racing to publish the SAME
// destination can each be mid-way through their own rename-then-copy when
// the other's rename lands, so the destination that survives can come from
// one invocation while the mirror that survives comes from the other — a
// torn pair neither process ever intended to write. The two processes also
// compute the identical `${target}.rollback-tmp` backup path (see
// `og-stage-commit.mjs`), so one can overwrite or delete the other's
// recovery copy mid-rollback, corrupting the very mechanism round 3 added
// to make failures safe.
//
// Uniqueness at the scratch-file layer cannot fix a race that lives one
// layer up, in the commit phase itself — so this is not another targeted
// patch on the same spot. The fix is single-writer discipline over the
// destination SET: `render-og-editions.mjs` acquires a lock on every
// destination it is about to commit BEFORE `commitStaged` touches any of
// them, holds every one of those locks for the entire commit-or-rollback
// phase (not just the touch of one file), and only releases them once that
// phase has fully settled. That makes "a commit for this destination is
// in flight" a fact every process can see, not merely a same-process one,
// so `commitStaged`'s rename+copy pair — and its rollback backup files —
// are never interleaved with another process's.
//
// Locks are acquired in a FIXED order (destination path, sorted) rather
// than the caller's staging order, specifically so two processes targeting
// overlapping-but-different destination sets (e.g. `--edition vacay` racing
// `--all`) can never deadlock waiting on each other: with a global order,
// whichever of the two contains the lexicographically-first shared
// destination always wins that lock first, so there is no cycle to wait on.
//
// This is a plain `wx`-mode (exclusive-create) lock file, not a dependency.
// `O_EXCL` create is atomic on the filesystems this manual, local,
// macOS-only script already requires (see render-og-editions.mjs's platform
// guard). A lock whose owning pid is no longer alive, or that has sat far
// longer than any real render+commit takes, is treated as abandoned by a
// killed or crashed process and stolen rather than waited on forever — a
// hard-killed renderer must not brick every future commit to that
// destination.
//
// Round 8 (#713, id 3762932710): stealing an abandoned lock says nothing
// about what state `dest`/`mirror` were left in. If the dead holder was
// killed between `commitStaged`'s `renameSync` and its `copyFileSync` (see
// that function's header), `dest` already has the new bytes and `mirror`
// does not — a torn pair — and neither of `commitStaged`'s own cleanup
// paths (the success-path unlink, the catch-block rollback) ever ran to
// notice or fix it, because both run synchronously in the process that no
// longer exists. Codex asked this module to recover that state
// automatically before letting a new commit proceed. It does not: doing so
// SAFELY needs a durable, fsync-ordered completion marker this module has
// no infrastructure for — a leftover `*.rollback-tmp.*` backup is
// consistent with an interrupted commit, but is equally consistent with a
// commit that finished every entry correctly and was killed only during its
// own final backup cleanup, and blindly restoring from it in that case
// would silently UNDO a fully successful commit (see the header on
// `commitStaged` in og-stage-commit.mjs for the full rebuttal). What this
// module does instead is cheap and safe: `stealIfStale` checks whether a
// leftover backup exists for the destination it is about to steal, and if
// so, says so loudly — surfacing the evidence to the operator, who is
// about to overwrite both files with a fresh render anyway and can check
// `git status`/`git diff` first if that is not what they expected.
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 30_000;
// Real renders finish in low single-digit seconds; this is generous enough
// that no genuinely in-progress commit ever gets stolen from under it, but
// short enough that a lock abandoned by a killed process does not wedge
// every future run for the rest of the day.
const STALE_MS = 60_000;

const lockPathFor = (dest) => `${dest}.commit-lock`;
// A short-lived gate owned by a stale-lock taker. New acquirers check this
// before and after publishing their hard-link lock, so a stale takeover never
// races a healthy replacement at the same pathname.
const takeoverPathFor = (dest) => `${lockPathFor(dest)}.takeover`;

/** Block the calling thread for `ms` without yielding to any event loop —
 *  this module's callers (render-og-editions.mjs's top-level commit step)
 *  are synchronous, so an async sleep would require restructuring the
 *  commit call into a promise chain purely to poll a lock file. Node's main
 *  thread (unlike a browser's) allows `Atomics.wait`, so this is the
 *  ordinary way to get a real synchronous sleep there. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Best-effort delete — used to clean up a `tryAcquireOne` scratch file
 *  whether the attempt won or lost. A leftover scratch file is a nuisance,
 *  never a correctness problem, since nothing else ever looks it up by
 *  name. */
function tryUnlink(p) {
  try {
    unlinkSync(p);
  } catch {
    // Already gone — fine.
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/** True if `og-stage-commit.mjs`'s `commitStaged` left an unfinished
 *  rollback backup for `dest` on disk — detection only, never read or acted
 *  on beyond that (see the round-8 note above for why acting on it would be
 *  unsound). Matches by prefix, not an exact name, because the backup's
 *  suffix carries a per-call token (`${dest}.rollback-tmp.<token>`, round 6)
 *  this module has no reason to know the shape of beyond that prefix. */
function hasLeftoverRollbackBackup(dest) {
  const dir = dirname(dest);
  const prefix = `${basename(dest)}.rollback-tmp.`;
  try {
    return readdirSync(dir).some((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
}

/** True if `pid` names a process this user can still signal. Only used to
 *  decide whether a lock left by another process is worth stealing before
 *  `STALE_MS` elapses — a false "alive" here just means `acquireOne` falls
 *  back to waiting out the age-based check instead, which is still
 *  correct, only slower. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try once to become the exclusive holder of `dest`'s lock. Returns
 *  whether it succeeded; never blocks.
 *
 *  Round 5 (#713, id 3762692296): this used to `openSync(lockPath, 'wx')`
 *  and write the pid into it as a SEPARATE step. That leaves a real window
 *  — between the create and the write — where `lockPath` exists on disk
 *  with no (or partial) content. A concurrent `stealIfStale` landing in
 *  that window reads an unparseable pid, treats the lock as if its owner
 *  were already dead, and unlinks it out from under the process that is
 *  still mid-acquire — so both processes can end up believing they hold
 *  the same lock. The fix is to never let `lockPath` become visible until
 *  its content is already complete: the pid is written in full to a
 *  per-attempt scratch path first, and `linkSync` — an atomic,
 *  EEXIST-on-collision, no-clobber publish, unlike `renameSync` which
 *  would silently steal an existing lock out from under its holder — is
 *  what makes that scratch path additionally visible as `lockPath`. Either
 *  the link succeeds and `lockPath` is immediately readable with the full
 *  pid line, or it fails and `lockPath` is untouched; there is no
 *  observable state in between for another process to misread. */
function tryAcquireOne(dest) {
  const lockPath = lockPathFor(dest);
  const takeoverPath = takeoverPathFor(dest);
  // A stealer owns the gate from BEFORE it judges staleness through removal.
  // Do not publish a replacement in that interval.
  if (existsSync(takeoverPath)) return null;
  const scratchPath = `${lockPath}.acquire-tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  let ownership = null;
  const fd = openSync(scratchPath, 'wx');
  try {
    // Keep the private hard link for the lock's whole lifetime. That witness
    // keeps its inode allocated, so a later owner can never reuse it and fool
    // this owner's release check. The lock records only its basename, allowing
    // a stale takeover to clean the dead owner's otherwise-unreachable link.
    writeSync(fd, `${process.pid}\n${basename(scratchPath)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(scratchPath, lockPath);
    // A takeover gate may have appeared after the first check while this
    // process was creating/linking its private scratch file. Keep the scratch
    // link until this check so we can prove the path is still ours before
    // withdrawing it; never return a healthy-looking lock through a gate.
    if (existsSync(takeoverPath)) {
      try {
        if (sameFile(statSync(lockPath), statSync(scratchPath))) tryUnlink(lockPath);
      } catch {
        // A stealer already removed it — the gate makes that equivalent.
      }
      return null;
    }
    try {
      ownership = { scratchPath };
      return ownership;
    } catch {
      // The path vanished before this acquirer could establish ownership.
      return null;
    }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return null;
  } finally {
    // A successful acquire intentionally retains its private hard-link
    // witness until release. Every other outcome cleans this attempt up.
    if (ownership === null) tryUnlink(scratchPath);
  }
}

/** If the lock currently sitting at `dest`'s lock path belongs to a dead
 *  process, or has simply sat there longer than any real commit takes,
 *  remove it so a later `tryAcquireOne` can succeed. A no-op (not an error)
 *  if the lock is still healthy, or has already been removed or stolen by
 *  someone else since the caller's last failed `tryAcquireOne` — either way
 *  the next poll's `tryAcquireOne` is the source of truth.
 *
 *  The `.takeover` gate is the ownership primitive here. It is exclusively
 *  created BEFORE the stale read and held through the unlink. `tryAcquireOne`
 *  checks it both before and after link publication, withdrawing any attempt
 *  that raced the gate, so no compliant waiter can publish a healthy lock at
 *  `lockPath` while this call removes the stale one. This is stronger than a
 *  stat/inode re-check: POSIX has no conditional-unlink syscall, and inode
 *  reuse means a pathname+inode comparison still cannot be an atomic CAS. */
function stealIfStale(dest) {
  const lockPath = lockPathFor(dest);
  const takeoverPath = takeoverPathFor(dest);
  let takeoverFd;
  try {
    takeoverFd = openSync(takeoverPath, 'wx');
  } catch {
    // Another stealer owns the gate. Its result will be visible next poll.
    return;
  }
  try {
    closeSync(takeoverFd);
  } catch {
    tryUnlink(takeoverPath);
    return;
  }
  let holderPid;
  let mtimeMs;
  let ownerWitness = null;
  try {
    const [pidLine, witnessLine] = readFileSync(lockPath, 'utf8').trim().split('\n');
    holderPid = Number.parseInt(pidLine, 10);
    const expectedWitnessPrefix = `${basename(lockPath)}.acquire-tmp.`;
    if (typeof witnessLine === 'string' && witnessLine.startsWith(expectedWitnessPrefix)) {
      ownerWitness = join(dirname(lockPath), witnessLine);
    }
    ({ mtimeMs } = statSync(lockPath));
  } catch {
    tryUnlink(takeoverPath);
    return;
  }
  // Clamped at zero: a lock stolen for being dead-owned rather than old
  // (the common case in tests, and for a process killed moments after
  // acquiring) can otherwise print a tiny negative age from clock/mtime
  // rounding, which reads as a bug in the message itself.
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  const holderLooksAlive = Number.isInteger(holderPid) && pidAlive(holderPid);
  if (holderLooksAlive && ageMs < STALE_MS) {
    tryUnlink(takeoverPath);
    return;
  }
  try {
    unlinkSync(lockPath);
    if (ownerWitness) tryUnlink(ownerWitness);
    const leftoverBackup = hasLeftoverRollbackBackup(dest);
    console.warn(
      `og-commit-lock: stole an abandoned lock at ${lockPath} ` +
        `(holder pid ${Number.isInteger(holderPid) ? holderPid : 'unknown'}, ` +
        `${holderLooksAlive ? 'still running but' : 'no longer running,'} ` +
        `${(ageMs / 1000).toFixed(0)}s old).` +
        (leftoverBackup
          ? ` A rollback backup for ${dest} is still on disk — the previous holder may have been ` +
            `killed mid-commit, which can leave ${dest} and its mirror out of sync. This run will ` +
            `overwrite both with a fresh, consistent render; check git status/git diff first if ` +
            `that is not what you expected.`
          : ''),
    );
  } catch {
    // Someone else already stole or released it — fine, the next
    // tryAcquireOne is what actually decides who has it now.
  } finally {
    tryUnlink(takeoverPath);
  }
}

/** Block until this process holds the lock for `dest`, then return a
 *  release function. Throws instead of blocking forever if `timeoutMs`
 *  elapses while the holder is neither releasing nor going stale. */
function acquireOne(dest, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let ownership;
  while ((ownership = tryAcquireOne(dest)) === null) {
    if (Date.now() > deadline) {
      throw new Error(
        `og-commit-lock: timed out after ${timeoutMs}ms waiting for the commit lock on ${dest} ` +
          `(${lockPathFor(dest)}). If a previous run crashed while holding it, delete that file.`,
      );
    }
    stealIfStale(dest);
    sleepSync(POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const lockPath = lockPathFor(dest);
      // An expired holder can finish after a stealer has handed the path to a
      // new renderer. The retained witness prevents inode reuse, so release
      // can prove this is still its own lock before unlinking by pathname.
      if (sameFile(statSync(lockPath), statSync(ownership.scratchPath))) unlinkSync(lockPath);
    } catch {
      // Already gone — releasing is best-effort cleanup, not a correctness
      // requirement: the lock's only job was to keep OTHER processes out
      // while we held it, and we are done needing that now.
    } finally {
      tryUnlink(ownership.scratchPath);
    }
  };
}

/** Acquire the commit lock for every distinct destination in `staged`
 *  (`staged[].dest`, i.e. the shape `commitStaged` consumes), in
 *  lexicographic order — see the header for why the order must be fixed
 *  and caller-independent. Returns a single release function that unlocks
 *  everything THIS call locked; the caller must call it exactly once,
 *  after `commitStaged` (success or failure) has fully settled — typically
 *  from a `finally`, so a destination is never left locked past the commit
 *  that needed it. If acquiring a later destination fails (including via
 *  timeout), every destination already locked by this same call is
 *  released before the error propagates, so a partial acquire never
 *  strands a lock. */
export function withDestinationLocks(staged, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dests = [...new Set(staged.map((s) => s.dest))].sort();
  const releases = [];
  try {
    for (const dest of dests) {
      releases.push(acquireOne(dest, timeoutMs));
    }
  } catch (err) {
    for (const release of releases) release();
    throw err;
  }
  return () => {
    for (const release of releases) release();
  };
}

/** Test-only escape hatch: true if `dest` is currently locked by anyone
 *  (including this process). Exported so a test can assert on lock STATE
 *  without depending on `commit-lock` file-naming internals from outside
 *  this module. */
export function isLocked(dest) {
  return existsSync(lockPathFor(dest));
}
