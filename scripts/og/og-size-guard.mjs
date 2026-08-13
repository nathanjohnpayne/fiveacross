// The hard-cap guard `render-og-editions.mjs` runs on every Edition render
// (#699), split out so it is testable without booting Playwright/Chromium.
//
// WhatsApp caps og:image at 600 KB. A render that exceeds that cap even after
// quantisation must NOT replace a committed copy — the caller is responsible
// for calling this before it touches `public/og-*.png` or the wireframes
// mirror, and for propagating the throw so the process exits nonzero.

/** Throws when `bytes` exceeds `hardCapBytes`. The caller must not have
 *  written `bytes` into a committed destination when this throws — the whole
 *  point is failing BEFORE the replace, not after it with a warning. */
export function assertWithinHardCap(id, bytes, hardCapBytes) {
  if (bytes > hardCapBytes) {
    throw new Error(
      [
        `render-og-editions.mjs: refusing to replace the committed ${id} render.`,
        `  - ${(bytes / 1024).toFixed(0)} KB exceeds the ${(hardCapBytes / 1024).toFixed(0)} KB ` +
          'WhatsApp og:image hard cap even after quantisation.',
      ].join('\n'),
    );
  }
}
