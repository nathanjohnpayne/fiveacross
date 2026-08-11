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
// Split out from the render script (which needs a real Chromium page to do
// anything) so the atomicity contract itself — commit-all-or-commit-nothing
// — is directly testable with plain filesystem operations, no browser
// required.
import { copyFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Move every staged render into its committed destination and mirror.
 *  Callers must only invoke this once every entry in `staged` has already
 *  passed its own hard-cap check — this function does no validation of its
 *  own and assumes every entry is safe to commit. */
export function commitStaged(staged) {
  const written = [];
  for (const s of staged) {
    renameSync(s.scratch, s.dest);
    mkdirSync(dirname(s.mirror), { recursive: true });
    copyFileSync(s.dest, s.mirror);
    written.push({ id: s.id, dest: s.dest, mirror: s.mirror });
  }
  return written;
}

/** Delete the scratch file for every staged-but-not-yet-committed render.
 *  Called when a later edition in the same run fails its own guard: every
 *  entry passed here already cleared the hard cap individually but must not
 *  become durable, because the run as a whole did not succeed. Silently
 *  tolerates a scratch file that is already gone. */
export function discardStaged(staged) {
  for (const s of staged) {
    try {
      unlinkSync(s.scratch);
    } catch {
      // Already gone or never written — nothing left to clean up.
    }
  }
}
