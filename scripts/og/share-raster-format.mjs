// The PNG-format guard `render-share-rasters.mjs` runs on a fresh capture
// before it is allowed to replace a committed reference picture, split out so
// it is testable without booting Playwright/Chromium — the same arrangement
// `og-size-guard.mjs` makes for the unfurl renders' hard cap.
//
// All three committed pictures in `plans/og-images/` are 600x750, 8-bit,
// non-interlaced truecolor (PNG colour type 2), and
// `src/recon-share-og.test.ts` requires exactly that of the files in the tree.
// Checking the capture's dimensions alone does not keep them that way: the
// repo's PNG reader decodes colour type 6 as readily as 2, the Vacay card
// skips the pixel check that would touch the decoder at all, and a 16-bit or
// interlaced capture at the right size would therefore sail past the renderer,
// replace the committed file, and only surface as a red suite afterwards —
// with the good picture already gone. The cheap fix is to read the rest of
// IHDR here and refuse by name, while the capture is still staged.

/**
 * Throws unless `header` describes the committed cards' PNG contract:
 * `expected.width` x `expected.height`, 8-bit, non-interlaced truecolor.
 *
 * The caller must run this while the capture is still staged beside its
 * destination — the whole point is refusing BEFORE the replace, so a
 * nonconforming capture costs a re-run rather than the committed picture.
 */
export function assertCapturedCardFormat(id, header, expected) {
  const { width, height, bitDepth, colorType, interlace } = header;
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `render-share-rasters.mjs: ${id} captured ${width}×${height}, expected ${expected.width}×${expected.height}. ` +
        'The artboard is drawn at half scale, so the capture must run at 2×.',
    );
  }
  // Reported together rather than one at a time: a capture that lost the
  // format usually lost more than one field of it, and a guard that names only
  // the first sends you round the loop again for the second.
  const faults = [];
  if (bitDepth !== 8) faults.push(`bit depth ${bitDepth} (expected 8)`);
  if (colorType !== 2) faults.push(`colour type ${colorType} (expected 2, truecolor)`);
  if (interlace !== 0) faults.push(`interlace method ${interlace} (expected 0, none)`);
  if (faults.length > 0) {
    throw new Error(
      `render-share-rasters.mjs: refusing to replace the committed ${id} picture — ${faults.join('; ')}. ` +
        'All three committed cards are 8-bit non-interlaced truecolor and src/recon-share-og.test.ts requires it.',
    );
  }
}
