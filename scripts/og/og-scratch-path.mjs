// The scratch path a render writes to before the hard-cap guard (#699)
// decides whether it is safe to become the committed asset. Split out so it
// is directly testable without booting Playwright/Chromium — see #713,
// where the scratch path lost its `.png` extension and Playwright's
// `page.screenshot({ path })` refused to write it at all ("unsupported mime
// type"), so every render failed before it ever reached the hard-cap guard
// it was meant to protect. That regression shipped past the test suite
// because nothing pinned the scratch path's shape; this does.
//
// Playwright infers the screenshot's image type from `path`'s extension and
// throws for anything other than `.png`/`.jpeg`/`.jpg` UNLESS the caller also
// passes an explicit `type`. `render-og-editions.mjs` passes `type: 'png'`
// as belt-and-braces, but the scratch path is kept `.png`-suffixed too so
// the path is self-explanatory on disk and correct even if a future edit
// drops the explicit `type`.
export function scratchPathFor(dest) {
  return `${dest}.render-tmp.png`;
}

/** The exact options `render-og-editions.mjs` passes to `page.screenshot()`.
 *  Exported so a test can assert on the real call shape — both defences
 *  Codex's #713 fix named (the `.png`-suffixed path AND the explicit
 *  `type: 'png'`) — without needing a running browser to do it. */
export function screenshotOptionsFor(dest) {
  return { path: scratchPathFor(dest), type: 'png' };
}
