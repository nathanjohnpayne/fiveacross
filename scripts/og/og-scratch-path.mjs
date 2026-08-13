// The scratch path a render writes to before the hard-cap guard (#699)
// decides whether it is safe to become the committed asset. Split out so it
// is directly testable without booting Playwright/Chromium — see #713,
// where the scratch path lost its `.png` extension and Playwright's
// `page.screenshot({ path })` refused to write it at all ("unsupported mime
// type"), so every render failed before it ever reached the hard-cap guard
// it was meant to protect. That regression shipped past the test suite
// because nothing pinned the scratch path's shape; this does.
//
// Round 3 (#713): the path used to be a pure function of `dest` alone, so
// two render invocations targeting the same Edition in the same checkout —
// a manual preview overlapping an `--all` run, say — computed the SAME
// scratch path. Either screenshot could overwrite the other's staged bytes,
// and the first process's rename (in `commitStaged`) removes the file out
// from under the second process while it still expects to stat or commit
// it. `scratchPathFor` now mixes in this process's pid and a random suffix
// so concurrent invocations never collide, even when they target the same
// `dest`. `Date.now()`/`Math.random()`(-backed `crypto.randomBytes`) are
// fine here — the workflow-script restriction on nondeterministic output
// does not apply to this local, manual renderer.
//
// Playwright infers the screenshot's image type from `path`'s extension and
// throws for anything other than `.png`/`.jpeg`/`.jpg` UNLESS the caller also
// passes an explicit `type`. `render-og-editions.mjs` passes `type: 'png'`
// as belt-and-braces, but the scratch path is kept `.png`-suffixed too so
// the path is self-explanatory on disk and correct even if a future edit
// drops the explicit `type`.
import { randomBytes } from 'node:crypto';

export function scratchPathFor(dest) {
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return `${dest}.render-tmp.${token}.png`;
}

/** The exact options `render-og-editions.mjs` passes to `page.screenshot()`.
 *  Exported so a test can assert on the real call shape — both defences
 *  Codex's #713 fix named (the `.png`-suffixed path AND the explicit
 *  `type: 'png'`) — without needing a running browser to do it.
 *
 *  Takes the already-computed scratch path, NOT `dest`. `scratchPathFor` is
 *  no longer a pure function of `dest` (it mints a fresh random token every
 *  call), so a caller that computed `scratch` via `scratchPathFor(dest)` and
 *  then separately called `screenshotOptionsFor(dest)` would get two
 *  DIFFERENT paths — the screenshot would land somewhere the caller never
 *  recorded, and the later `statSync(scratch)` / commit would miss it
 *  entirely. Taking `scratch` itself makes that divergence impossible to
 *  reintroduce: there is only one call to `scratchPathFor` per render, and
 *  this function just carries its result through. */
export function screenshotOptionsFor(scratch) {
  return { path: scratch, type: 'png' };
}
