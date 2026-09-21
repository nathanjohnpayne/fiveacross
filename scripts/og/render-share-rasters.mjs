// Re-renders the wireframes' reference pictures of the final-standings share
// card, photo-hero composition:
//
//   plans/og-images/share-final-photo-gcb.png
//   plans/og-images/share-final-photo-vacay.png
//   plans/og-images/share-final-photo-fa.png
//
// WHY THIS EXISTS (#887). Until now these three PNGs had no generator: every
// refresh was a hand-driven screen capture, and #867's refresh caught an
// adjacent frame in shot — a scaled Vacay final-standings card composited over
// the upper-right corner of the GCB one, obscuring the wordmark line and half
// of FINAL STANDINGS. A hand capture also cannot be re-run, so the GCB card
// still read `Turntilla` on its 👑 row long after the artboard beside it was
// corrected to `Logan Murdock`. Both failures are the same failure: the asset
// had no reproducible source.
//
// It does now, and it was already in the tree. `plans/daily-cards-wireframes.html`
// draws each card as a live `.shc` artboard at HALF scale (300×375 CSS px
// representing the rendered 600×750), and the committed PNGs are 2× captures
// of exactly those elements — same page ground in the rounded corners, same
// Arial Narrow display face, same token-tinted placeholder scene. So this
// script opens that document in Playwright's chromium at
// `deviceScaleFactor: 2` and screenshots the artboard. The artboard is the
// source; the PNG is its render.
//
// This is NOT a capture of `src/components/ShareCard.tsx`. That component
// renders on the Player's own device from a real photo blob (ADR 0005) and has
// no offline harness, no placeholder scene and no sample Event — which is why
// the references were ever hand-made. The artboard is the design source both
// the component and these pictures answer to; `specs/w2-share-cards.md` and
// `specs/most-loved-photo.md` own the places the two deliberately differ (the
// crown row's dropped stat, for one).
//
// Brand-owned copy is not trusted to the artboard. The footer line is
// rewritten from `src/editions.ts` before the capture, exactly as
// `render-share-footer.mjs` draws it (`${appName} ${lexicon.shareMark}`,
// uppercased by the artboard's own CSS), so a share-mark change stays a
// one-table edit plus a re-run rather than an edit in two places.
//
// Usage:
//   node scripts/og/render-share-rasters.mjs --edition gcb
//   node scripts/og/render-share-rasters.mjs --all
//   node scripts/og/render-share-rasters.mjs --edition gcb --out /tmp/rasters
//   node scripts/og/render-share-rasters.mjs --edition gcb --check   # report only
//
// `--edition` is required rather than defaulting to all three, on the same
// reasoning `render-og-editions.mjs` and `render-share-footer.mjs` give: a
// re-render is never byte-identical to the last one, so running the full set
// for a one-Edition change commits binary diffs to cards nobody asked to
// change. `--out` writes to a scratch directory instead of the repo, which is
// what you want for a first look.
//
// `--all` IS ATOMIC. Every target is captured and fully validated into its own
// scratch file first, and only once the LAST one has passed does a single
// commit phase move them all into place (`commitStaged`, og-stage-commit.mjs,
// the same primitive `render-og-editions.mjs` publishes the unfurl set
// through). The per-Edition rename used to happen the moment that Edition
// validated, so a batch whose third card failed its overlay check left the
// first two updated and the third stale — one command, a mixed render set, and
// no way to tell from the tree which cards are from which run. On any failure
// now, every scratch file in the run is deleted and every committed picture is
// exactly the file it was before the command started; the error names the
// Edition that failed.
//
// The output is truecolor and NOT quantised, matching the committed captures
// (colour type 2) and `render-og-editions.mjs`'s posture: a palette pass
// perturbs pixels everywhere, which is exactly what makes "prove the only
// thing that moved is the thing you meant to move" impossible.
//
// Requirements: playwright + esbuild (dev deps), `npx playwright install
// chromium`, macOS, AND the **Arial Narrow** display face. The artboards'
// `.shc` rules ask for `'Bebas Neue','Arial Narrow',sans-serif`; Bebas Neue is
// not a macOS face and the committed pictures are captures with Arial Narrow,
// which macOS ships as a SUPPLEMENTAL font (`/System/Library/Fonts/
// Supplemental/Arial Narrow.ttf`) and a host can therefore be without. This
// script refuses to capture unless that face is the one the artboards resolve
// to — see `assertDisplayFace` below for why `document.fonts.ready` cannot be
// asked the question. Do not suppress the output: this fails closed on a bad
// frame, on a missing display face, and on a capture that is the wrong size or
// in the wrong PNG format, and `>/dev/null 2>&1` turns that into a silent
// no-op that reads downstream as "the change had no effect".
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDestinationLocks } from './og-commit-lock.mjs';
import { scratchPathFor, screenshotOptionsFor } from './og-scratch-path.mjs';
import { commitStaged, discardStaged } from './og-stage-commit.mjs';
import { readPngHeader, readPngPixels } from './png-pixels.mjs';
import { assertNoOverlay } from './share-card-overlay.mjs';
import { assertCapturedCardFormat } from './share-raster-format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/** The artboard each committed picture is a render of. Edition ids match the
 *  brand table (`src/edition-brands.ts`), so `editionBrand(id)` resolves. */
export const CARDS = {
  gcb: { frame: 'fx-share-final-photo-gcb', file: 'share-final-photo-gcb.png' },
  vacay: { frame: 'fx-share-final-photo-vacay', file: 'share-final-photo-vacay.png' },
  fiveacross: { frame: 'fx-share-final-photo-fa', file: 'share-final-photo-fa.png' },
};
export const CARD_W = 600;
export const CARD_H = 750;
/** The artboards are drawn at half scale, so the capture runs at 2× to land on
 *  the committed 600×750. */
export const SCALE = 2;
// The overlay guard — the cap, the boundary, the quadrant and the Vacay
// exemption — lives in `share-card-overlay.mjs`, because
// `src/recon-share-og.test.ts` applies the same check to the files already in
// the tree and the two ends must not be able to disagree. They did: this
// module rejected a share strictly above 0.12 while the recon guard required
// one strictly below it, so a capture landing exactly on the cap was published
// by a run that reported success and immediately reddened `npm test` (#887
// round 6).

/** The display stack the artboards' `.shc` rules request, in the order CSS
 *  resolves it (`plans/daily-cards-wireframes.html`, `.shc .big` / `.who` /
 *  `.hname`). */
export const DISPLAY_FACE_STACK = ['Bebas Neue', 'Arial Narrow'];
/** The generic the stack ends in, and therefore what a host with neither face
 *  silently renders the card's display type in. */
export const DISPLAY_FACE_GENERIC = 'sans-serif';
/** The face the committed pictures were captured with, and so the only one a
 *  re-render may use if it is to be a re-render rather than a restyle. */
export const REQUIRED_DISPLAY_FACE = 'Arial Narrow';
/** The probe the face check measures with: the largest size the `.shc` rules
 *  use (`.big`), and a sample long enough that two different faces cannot
 *  plausibly measure the same. */
export const DISPLAY_FACE_PROBE = { size: 62, sample: 'FINAL STANDINGS · 0123456789 · WMWMiiil' };

/**
 * The face the artboards will actually draw their display type in, from one
 * probe per family in `DISPLAY_FACE_STACK`, or `null` if the stack falls all
 * the way through to the generic.
 *
 * Each probe is `{ family, checked, width, genericWidth }`: `checked` is
 * `document.fonts.check` for that family at the rules' own size, and the two
 * widths are the same sample measured with the family in front of the generic
 * and with the generic alone. BOTH have to agree before a family counts as
 * resolved, because each is unreliable in the opposite direction —
 * `document.fonts.check` answers about availability rather than about what the
 * cascade picked, and a width comparison alone would call a face missing if it
 * happened to be metrically identical to the host's sans-serif.
 */
export function resolvedDisplayFace(probes) {
  for (const probe of probes) {
    if (probe.checked && probe.width !== probe.genericWidth) return probe.family;
  }
  return null;
}

/**
 * Throw unless the artboards resolve their display type to `expected`.
 *
 * The hole this closes: `document.fonts.ready` resolves happily on a host with
 * neither Bebas Neue nor Arial Narrow installed — it promises that pending
 * font LOADS have settled, not that the families a stylesheet asked for exist
 * — so Chromium falls through to the generic sans-serif, the capture is still
 * 600×750 truecolor with a dark upper-right quadrant, and every check below
 * passes while the committed picture is replaced with one in visibly different
 * typography. That is the exact failure mode this generator exists to end, in
 * a new costume: an asset nobody can reproduce, because reproducing it depends
 * on which fonts the last person to run it happened to have.
 *
 * The check is an equality, not a presence test, and it refuses in both
 * directions on purpose. A host MISSING Arial Narrow restyles the cards; so
 * does a host that has installed Bebas Neue, because the stack puts Bebas Neue
 * first and the committed pictures are not captures of it. One comparison
 * covers both, and the message says which host it is looking at.
 */
export function assertDisplayFace(probes, expected = REQUIRED_DISPLAY_FACE) {
  const resolved = resolvedDisplayFace(probes);
  if (resolved === expected) return resolved;
  // Every probe's raw numbers, so an unexpected refusal is diagnosable from
  // the error alone rather than by re-running the browser by hand.
  const evidence = probes
    .map(
      (p) =>
        `  - ${p.family}: document.fonts.check ${p.checked ? 'yes' : 'no'}, ` +
        `sample ${p.width}px vs ${DISPLAY_FACE_GENERIC} ${p.genericWidth}px` +
        `${p.width === p.genericWidth ? ' (fell back)' : ''}`,
    )
    .join('\n');
  const found =
    resolved === null
      ? `nothing in the stack resolves, so the artboards draw their display type in ${DISPLAY_FACE_GENERIC}`
      : `the stack resolves to ${resolved}`;
  throw new Error(
    [
      `render-share-rasters.mjs: refusing to capture — ${found}, but the committed pictures ` +
        `are captures with ${expected}.`,
      evidence,
      `  The .shc rules request '${DISPLAY_FACE_STACK.join("','")}',${DISPLAY_FACE_GENERIC}. ` +
        `macOS ships ${expected} as a supplemental face (/System/Library/Fonts/Supplemental/` +
        `${expected}.ttf); install it, or uninstall the face ahead of it, before re-rendering. ` +
        'document.fonts.ready resolves either way, so without this check the capture would pass ' +
        'its size, format and overlay checks and replace the committed picture with different type.',
    ].join('\n'),
  );
}

/**
 * Read a staged capture and decide whether it may replace a committed picture.
 *
 * Throws on anything wrong; returns the numbers the run reports on success.
 * Every call happens while the capture is still a scratch file — see the
 * staging contract on `renderCardSet`.
 */
export function inspectCapture(id, scratch, { read = readFileSync } = {}) {
  const bytes = read(scratch);
  const header = readPngHeader(bytes);
  // Size AND format. Size alone was not enough: `readPngPixels` decodes colour
  // type 6 as readily as 2 and Vacay skips it entirely, so a correctly sized
  // capture in the wrong PNG format would replace the committed file and only
  // red `src/recon-share-og.test.ts` afterwards. See share-raster-format.mjs.
  assertCapturedCardFormat(id, header, { width: CARD_W, height: CARD_H });
  // The decode is inside the thunk so the Vacay exemption governs it too: an
  // exempt card's pixels are never inflated, which is the property
  // share-raster-format.mjs relies on when it explains why the IHDR check
  // cannot be left to the decoder.
  const lightShare = assertNoOverlay(id, () => readPngPixels(bytes));
  return { width: header.width, height: header.height, colorType: header.colorType, bytes: bytes.length, lightShare };
}

/**
 * Stage every target, validate every target, and only then publish them all.
 *
 * `render-share-footer.mjs` publishes through this too (#887 round 4): it
 * paints one band on an existing card rather than screenshotting an artboard,
 * but it writes the same three destinations and needs the same all-or-nothing
 * publication and the same proof of format, so it supplies its own `capture`
 * and lets everything else here stand.
 *
 * The seams (`preflight`, `capture`, `inspect`, `fileFor`, `beforeCommit`, and
 * the commit/discard/lock trio) are parameters so the staging contract itself
 * is testable with plain files and no browser — the arrangement og-stage-commit.mjs
 * and og-scratch-path.mjs already make for the unfurl renders, and the reason
 * render-share-rasters.test.mjs can pin "a batch whose second target fails
 * changes nothing" without launching Chromium.
 *
 * Order is the contract:
 *
 *  1. `preflight` runs ONCE, before the first capture. It is where the
 *     display-face check lives: a host that cannot draw the cards should cost
 *     a message, not three screenshots and a refusal.
 *  2. Each target is captured to its own scratch path and inspected there.
 *  3. Only after the LAST target has passed does the commit phase run. A
 *     failure anywhere above (or in the commit phase itself, which rolls its
 *     own renames back) falls into one `catch` that discards every scratch
 *     file in the run, so the committed set is either wholly updated or wholly
 *     untouched.
 *
 * The commit phase holds `withDestinationLocks` for its whole duration, as
 * `commitStaged`'s concurrency contract requires of every caller publishing to
 * a shared destination — `plans/og-images/` is shared with a second run of
 * this same command, and with the other renderer.
 *
 * `readsDestination` widens that window, and the footer refresher sets it
 * (#887 round 5). A screenshot of an artboard does not read the file it is
 * about to replace, so locking the commit alone is enough: whatever was there
 * is irrelevant to what gets written. A band repaint is a read-modify-write of
 * that very file, and locking only the commit leaves the classic lost update —
 * the footer process reads the card, a full render commits a newer one while
 * the paint is in flight, and the footer process then takes the lock and
 * publishes a repaint of the snapshot it read before any of that, silently
 * discarding the newer render. With `readsDestination: true` the locks are
 * taken over the whole run instead, before the first capture, so the bytes a
 * capture reads are the bytes its commit replaces. It is off by default
 * because holding three destination locks across three screenshots would block
 * a concurrent single-Edition run for no reason.
 */
export async function renderCardSet({
  ids,
  destDir,
  capture,
  preflight = async () => {},
  beforeCommit = async () => {},
  inspect = inspectCapture,
  fileFor = (id) => CARDS[id].file,
  stagePathFor = scratchPathFor,
  commit = commitStaged,
  discard = discardStaged,
  lock = withDestinationLocks,
  readsDestination = false,
}) {
  const targets = ids.map((id) => ({ id, dest: join(destDir, fileFor(id)) }));
  // Taken before `preflight`, not merely before the capture loop: a `capture`
  // that reads its destination must not observe bytes another run is about to
  // replace, and the cheapest way to promise that is for no part of the run to
  // happen outside the lock.
  const heldThroughout = readsDestination ? lock(targets) : null;
  const staged = [];
  try {
    await preflight();
    for (const { id, dest } of targets) {
      // Recorded BEFORE the capture runs, so a screenshot that fails halfway
      // through writing its file still has that file swept up below.
      const entry = { id, dest, scratch: stagePathFor(dest) };
      staged.push(entry);
      try {
        await capture(id, entry.scratch);
        entry.report = inspect(id, entry.scratch);
      } catch (error) {
        throw new Error(
          `render-share-rasters.mjs: ${id} failed, so nothing was written — every target in this ` +
            `run is staged together and discarded together. ${error.message}`,
          { cause: error },
        );
      }
    }
    // All browser work is complete before the commit phase, matching
    // render-og-editions.mjs: a Chromium shutdown that fails AFTER the commit
    // would report a run that actually published as a failed one.
    await beforeCommit();
    // Already holding every one of these locks when `readsDestination` is set.
    // Re-acquiring would deadlock against this process's own lock files, which
    // are exclusive rather than reentrant, so the run would simply time out.
    const release = heldThroughout ?? lock(staged);
    try {
      commit(staged);
    } finally {
      if (release !== heldThroughout) release();
    }
  } catch (error) {
    // Either a target failed its own checks — every earlier target in this run
    // passed but is still only a scratch file — or the commit phase failed
    // partway and has already rolled every destination it touched back. Either
    // way sweep the scratch files (this tolerates the ones a commit consumed)
    // and rethrow, so the process exits nonzero and `plans/og-images/` is
    // exactly as it was before the run started.
    discard(staged);
    throw error;
  } finally {
    if (heldThroughout) heldThroughout();
  }
  return staged;
}

/** Ask the page which display face the artboards actually resolve to. Split
 *  from `assertDisplayFace` so the decision is testable without a browser and
 *  this half stays a thin `page.evaluate`. */
async function probeDisplayFaces(page) {
  return page.evaluate(
    ({ families, generic, size, sample }) => {
      // Canvas measurement rather than a DOM span: `measureText` applies the
      // same font resolution the page uses, with no layout, no reflow of the
      // artboards, and nothing left behind in the document being captured.
      const context = document.createElement('canvas').getContext('2d');
      const widthOf = (font) => {
        context.font = font;
        return context.measureText(sample).width;
      };
      const genericWidth = widthOf(`${size}px ${generic}`);
      return families.map((family) => ({
        family,
        checked: document.fonts.check(`${size}px "${family}"`),
        width: widthOf(`${size}px "${family}", ${generic}`),
        genericWidth,
      }));
    },
    {
      families: DISPLAY_FACE_STACK,
      generic: DISPLAY_FACE_GENERIC,
      size: DISPLAY_FACE_PROBE.size,
      sample: DISPLAY_FACE_PROBE.sample,
    },
  );
}

/** Fix `frame` at the viewport origin and return the undo. */
async function pinToOrigin(frame) {
  const before = await frame.evaluate((node) => {
    const previous = {
      position: node.style.position,
      left: node.style.left,
      top: node.style.top,
      zIndex: node.style.zIndex,
    };
    node.style.position = 'fixed';
    node.style.left = '0px';
    node.style.top = '0px';
    node.style.zIndex = '2147483647';
    return previous;
  });
  return () =>
    frame.evaluate((node, previous) => {
      node.style.position = previous.position;
      node.style.left = previous.left;
      node.style.top = previous.top;
      node.style.zIndex = previous.zIndex;
    }, before);
}

/** Locate an Edition's artboard, and refuse anything but exactly one match. */
function artboardFor(page, id) {
  return page.locator(`#${CARDS[id].frame} .shc`);
}

/** Overwrite the artboard's footer with the brand table's line, and warn when
 *  the two disagreed. Runs in `--check` too, because "what would this write?"
 *  includes that warning. */
async function applyFooter(frame, id, footer) {
  const replaced = await frame.evaluate((node, line) => {
    const foot = node.querySelector('.foot');
    if (!foot) throw new Error('artboard has no .foot line');
    const before = foot.textContent;
    foot.textContent = line;
    return before;
  }, footer);
  if (replaced.trim() !== footer) {
    console.warn(`${id.padEnd(11)} artboard footer "${replaced.trim()}" replaced with brand-table "${footer}"`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (f) => {
    const i = args.indexOf(f);
    return i === -1 ? null : args[i + 1];
  };
  const only = argOf('--edition');
  const all = args.includes('--all');
  const checkOnly = args.includes('--check');
  const outDir = argOf('--out');

  if (!only && !all) {
    console.error(
      'render-share-rasters.mjs: pass --edition <id> (or --all). See the header for why there is no default.',
    );
    process.exit(1);
  }
  // A value-less `--out` would otherwise fall back to the committed directory,
  // which is the one place someone reaching for `--out` is trying not to write.
  if (args.includes('--out') && !outDir) {
    console.error('render-share-rasters.mjs: --out needs a directory.');
    process.exit(1);
  }
  if (process.platform !== 'darwin' && !args.includes('--allow-foreign-platform')) {
    console.error('render-share-rasters.mjs: refusing to render off macOS (Apple Color Emoji / Helvetica Neue / Arial Narrow).');
    process.exit(1);
  }

  const ids = only ? [only] : Object.keys(CARDS);
  for (const id of ids) {
    if (!CARDS[id]) {
      console.error(`Unknown edition "${id}". Known: ${Object.keys(CARDS).join(', ')}`);
      process.exit(1);
    }
  }

  // The brand table comes from the shared bundling loader in
  // `load-editions.mjs`. This script introduced that loader inline; it moved to
  // its own module once the two renderers next door adopted it, because the
  // transpile-and-stub loader they had each copied rotted the moment
  // `src/editions.ts` grew a real import — one defect in three places.
  //
  // Loaded here rather than at module scope (it shells out to esbuild) so
  // importing this file for its staging logic costs nothing.
  const { loadEditions } = await import('./load-editions.mjs');
  const { editionBrand } = loadEditions();
  const footerFor = (id) => {
    const brand = editionBrand(id);
    return `${brand.appName} ${brand.lexicon.shareMark}`;
  };

  const destDir = outDir ?? join(repo, 'plans', 'og-images');
  if (outDir) mkdirSync(outDir, { recursive: true });
  const wireframes = pathToFileURL(join(repo, 'plans', 'daily-cards-wireframes.html')).href;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  let browserClosed = false;
  const closeBrowser = async () => {
    if (browserClosed) return;
    browserClosed = true;
    await browser.close();
  };
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1200 },
      deviceScaleFactor: SCALE,
    });
    await page.goto(wireframes, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const preflight = async () => {
      const face = assertDisplayFace(await probeDisplayFaces(page));
      console.log(`${'display face'.padEnd(11)} ${face}`);
    };

    if (checkOnly) {
      await preflight();
      for (const id of ids) {
        const footer = footerFor(id);
        const frame = artboardFor(page, id);
        if ((await frame.count()) !== 1) {
          throw new Error(`render-share-rasters.mjs: #${CARDS[id].frame} .shc did not match exactly one artboard.`);
        }
        await applyFooter(frame, id, footer);
        console.log(`${id.padEnd(11)} would write ${join(destDir, CARDS[id].file)} — footer "${footer}"`);
      }
      console.log('\n--check: nothing written.');
      return;
    }

    const staged = await renderCardSet({
      ids,
      destDir,
      preflight,
      beforeCommit: closeBrowser,
      capture: async (id, scratch) => {
        const footer = footerFor(id);
        const frame = artboardFor(page, id);
        if ((await frame.count()) !== 1) {
          throw new Error(`#${CARDS[id].frame} .shc did not match exactly one artboard.`);
        }
        // Brand-table copy wins over whatever the artboard has typed into it.
        await applyFooter(frame, id, footer);

        // Pin the artboard to the viewport origin for the capture, and un-pin
        // it straight afterwards.
        //
        // Pinning, because in the document flow the artboard lands on a
        // fractional y and Playwright rounds the clip outwards from there — a
        // 600×752 capture of a 600×750 card, off by one device row at each
        // end. A fixed origin makes the box integral, and it also brings the
        // artboard on screen however far down the document it sits. Nothing
        // about the card's own rendering changes: it carries explicit width,
        // height and `box-sizing: border-box`, and the ground behind its
        // rounded corners is the same page background either way.
        //
        // Un-pinning, because `--all` reuses one page: leaving the previous
        // card stacked at the same origin would put it behind the next one,
        // and the antialiased pixels along the rounded corner arc would
        // composite over Vacay's cream card instead of over the page. That is
        // a one-pixel version of exactly the defect this script exists to stop
        // shipping.
        const restore = await pinToOrigin(frame);
        try {
          await frame.screenshot(screenshotOptionsFor(scratch));
        } finally {
          await restore();
        }
      },
    });

    for (const { id, dest, report } of staged) {
      const light = report.lightShare === null ? 'n/a (cream ground)' : `${(report.lightShare * 100).toFixed(1)}%`;
      console.log(
        `${id.padEnd(11)} wrote ${dest} — ${report.width}×${report.height}, colour type ${report.colorType}, ` +
          `${(report.bytes / 1024).toFixed(0)} KB, upper-right near-white ${light}, footer "${footerFor(id)}"`,
      );
    }
  } finally {
    try {
      await closeBrowser();
    } catch {
      // Preserve whatever brought us here; a browser that was already failing
      // to close cannot make a successful publish look like a failed run,
      // because the success path closes it before the commit phase.
    }
  }
}

// Importable for its staging logic, runnable as the generator. Nothing above
// this line touches the filesystem, the brand table or a browser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
