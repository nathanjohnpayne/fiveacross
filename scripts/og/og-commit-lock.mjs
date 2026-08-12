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
import { closeSync, existsSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 30_000;
// Real renders finish in low single-digit seconds; this is generous enough
// that no genuinely in-progress commit ever gets stolen from under it, but
// short enough that a lock abandoned by a killed process does not wedge
// every future run for the rest of the day.
const STALE_MS = 60_000;

const lockPathFor = (dest) => `${dest}.commit-lock`;

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
  const scratchPath = `${lockPath}.acquire-tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(scratchPath, 'wx');
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(scratchPath, lockPath);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  } finally {
    // The scratch path is a private per-attempt name nobody else ever
    // references (win or lose) — always clean it up. Best-effort: if this
    // fails, it is a stray temp file, not a correctness problem, since
    // `lockPathFor` never points at it.
    tryUnlink(scratchPath);
  }
}

/** If the lock currently sitting at `dest`'s lock path belongs to a dead
 *  process, or has simply sat there longer than any real commit takes,
 *  remove it so a later `tryAcquireOne` can succeed. A no-op (not an error)
 *  if the lock is still healthy, or has already been removed or stolen by
 *  someone else since the caller's last failed `tryAcquireOne` — either way
 *  the next poll's `tryAcquireOne` is the source of truth. */
function stealIfStale(dest) {
  const lockPath = lockPathFor(dest);
  let holderPid;
  let mtimeMs;
  try {
    holderPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return;
  }
  // Clamped at zero: a lock stolen for being dead-owned rather than old
  // (the common case in tests, and for a process killed moments after
  // acquiring) can otherwise print a tiny negative age from clock/mtime
  // rounding, which reads as a bug in the message itself.
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  const holderLooksAlive = Number.isInteger(holderPid) && pidAlive(holderPid);
  if (holderLooksAlive && ageMs < STALE_MS) return;
  try {
    unlinkSync(lockPath);
    console.warn(
      `og-commit-lock: stole an abandoned lock at ${lockPath} ` +
        `(holder pid ${Number.isInteger(holderPid) ? holderPid : 'unknown'}, ` +
        `${holderLooksAlive ? 'still running but' : 'no longer running,'} ` +
        `${(ageMs / 1000).toFixed(0)}s old).`,
    );
  } catch {
    // Someone else already stole or released it — fine, the next
    // tryAcquireOne is what actually decides who has it now.
  }
}

/** Block until this process holds the lock for `dest`, then return a
 *  release function. Throws instead of blocking forever if `timeoutMs`
 *  elapses while the holder is neither releasing nor going stale. */
function acquireOne(dest, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquireOne(dest)) {
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
      unlinkSync(lockPathFor(dest));
    } catch {
      // Already gone — releasing is best-effort cleanup, not a correctness
      // requirement: the lock's only job was to keep OTHER processes out
      // while we held it, and we are done needing that now.
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
