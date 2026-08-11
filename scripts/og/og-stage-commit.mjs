// The commit/discard primitives that make `--all` atomic (#713 round 2).
//
// `render-og-editions.mjs` renders every targeted edition to a scratch file
// and only calls `commitStaged` once EVERY targeted edition has individually
// cleared the hard-cap guard (#699). If any edition fails first, the caller
// calls `discardStaged` instead — on whatever subset of editions had already
// been staged — so a failed `--all` run leaves `public/` and the wireframes
// mirror exactly as they were before it started, with no partially-updated
// render set and no stray scratch files left behind.
//
// Round 3 (#713): that guarantee had a hole one level down. Every entry
// passed to `commitStaged` had individually cleared the hard cap, but the
// commit phase itself — the loop of renames and mirror copies — was not
// atomic. If a mirror directory went unwritable, or the disk filled,
// partway through, the editions committed before the failure were already
// durable and the current edition's `dest` could be replaced before its
// mirror copy ran, leaving `public/` and the mirror out of sync with each
// other. `commitStaged` now backs up every destination and mirror it is
// about to overwrite before touching it, and rolls every one of them back
// to its pre-commit bytes if any step in the phase throws — so a commit
// failure is exactly as harmless as a render failure: the tree comes back
// exactly as it was.
//
// Split out from the render script (which needs a real Chromium page to do
// anything) so the atomicity contract itself — commit-all-or-commit-nothing
// — is directly testable with plain filesystem operations, no browser
// required.
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const rollbackBackupPath = (p) => `${p}.rollback-tmp`;

/** Best-effort delete — used for both rollback cleanup and success cleanup,
 *  where a leftover backup file is a nuisance, not a correctness problem. */
function tryUnlink(p) {
  try {
    unlinkSync(p);
  } catch {
    // Already gone — fine.
  }
}

/** Restore every entry this call already backed up to its pre-commit state:
 *  a destination/mirror that existed before the commit gets its original
 *  bytes back; one that did NOT exist gets removed, so "rolled back" means
 *  the tree looks exactly as it did before `commitStaged` was called, not
 *  merely "no worse than the last successful entry". Best-effort: a restore
 *  failure here is reported to the console rather than thrown, because the
 *  caller is already unwinding from the original commit failure and a
 *  second thrown error would replace that diagnostic instead of adding to
 *  it. */
function rollback(backups) {
  for (const b of backups) {
    for (const [target, backup, existed] of [
      [b.dest, b.destBackup, b.destExisted],
      [b.mirror, b.mirrorBackup, b.mirrorExisted],
    ]) {
      try {
        if (existed) {
          renameSync(backup, target);
        } else {
          tryUnlink(target);
        }
      } catch (err) {
        console.error(`og-stage-commit: failed to roll back ${target}: ${err.message}`);
      }
    }
  }
}

/** Move every staged render into its committed destination and mirror.
 *  Callers must only invoke this once every entry in `staged` has already
 *  passed its own hard-cap check — this function does no validation of its
 *  own and assumes every entry is safe to commit.
 *
 *  Atomic across the whole `staged` list (#713 round 3): before touching
 *  any destination or mirror, this backs it up if it already exists. If any
 *  step for any entry throws — a rename, a `mkdir`, a mirror copy — every
 *  entry already backed up in this call is rolled back to its pre-commit
 *  bytes and the error is rethrown. A caller that also wants leftover
 *  scratch files cleaned up on that path should follow with
 *  `discardStaged(staged)`; every scratch file this function DID consume is
 *  already gone (renamed away), so `discardStaged` is safe to call
 *  unconditionally — it silently tolerates the ones that no longer exist. */
export function commitStaged(staged) {
  const backups = [];
  const written = [];
  try {
    for (const s of staged) {
      mkdirSync(dirname(s.mirror), { recursive: true });

      const destBackup = rollbackBackupPath(s.dest);
      const mirrorBackup = rollbackBackupPath(s.mirror);
      const destExisted = existsSync(s.dest);
      const mirrorExisted = existsSync(s.mirror);
      if (destExisted) copyFileSync(s.dest, destBackup);
      if (mirrorExisted) copyFileSync(s.mirror, mirrorBackup);
      // Recorded before the destructive steps below so a failure inside
      // THIS entry's own rename/copy is still covered by the rollback.
      backups.push({ dest: s.dest, mirror: s.mirror, destBackup, mirrorBackup, destExisted, mirrorExisted });

      renameSync(s.scratch, s.dest);
      copyFileSync(s.dest, s.mirror);
      written.push({ id: s.id, dest: s.dest, mirror: s.mirror });
    }
  } catch (err) {
    rollback(backups);
    throw err;
  }
  // Every entry committed cleanly — the backups are no longer needed.
  for (const b of backups) {
    if (b.destExisted) tryUnlink(b.destBackup);
    if (b.mirrorExisted) tryUnlink(b.mirrorBackup);
  }
  return written;
}

/** Delete the scratch file for every staged-but-not-yet-committed render.
 *  Called when a later edition in the same run fails its own guard: every
 *  entry passed here already cleared the hard cap individually but must not
 *  become durable, because the run as a whole did not succeed. Also the
 *  right cleanup call after a `commitStaged` failure — its rollback already
 *  restores every destination/mirror, so this just sweeps up whatever
 *  scratch files are still on disk. Silently tolerates a scratch file that
 *  is already gone (never written, or already consumed by a commit that
 *  then rolled back). */
export function discardStaged(staged) {
  for (const s of staged) {
    tryUnlink(s.scratch);
  }
}
