// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertCapturedCardFormat } from './share-raster-format.mjs';

const SIZE = { width: 600, height: 750 };
/** The IHDR all three committed cards carry, as a synthetic header. */
const committed = (overrides = {}) => ({
  width: 600,
  height: 750,
  bitDepth: 8,
  colorType: 2,
  interlace: 0,
  ...overrides,
});

describe('assertCapturedCardFormat (#887)', () => {
  it('passes a capture that matches the committed cards', () => {
    expect(() => assertCapturedCardFormat('gcb', committed(), SIZE)).not.toThrow();
  });

  it('refuses a correctly sized capture with an alpha channel', () => {
    // The gap this closes: the renderer used to check dimensions only, and
    // `readPngPixels` decodes colour type 6 as readily as 2 — so an RGBA
    // capture at 600x750 replaced the committed picture and only reddened
    // `src/recon-share-og.test.ts`, which requires colour type 2, on the next
    // `npm test`, with the good file already overwritten.
    expect(() => assertCapturedCardFormat('gcb', committed({ colorType: 6 }), SIZE)).toThrow(
      /colour type 6 \(expected 2, truecolor\)/,
    );
  });

  it('refuses an interlaced capture', () => {
    expect(() => assertCapturedCardFormat('fiveacross', committed({ interlace: 1 }), SIZE)).toThrow(
      /interlace method 1 \(expected 0, none\)/,
    );
  });

  it('refuses a 16-bit capture', () => {
    expect(() => assertCapturedCardFormat('vacay', committed({ bitDepth: 16 }), SIZE)).toThrow(
      /bit depth 16 \(expected 8\)/,
    );
  });

  it('names the Edition and every fault at once, so one re-run clears them all', () => {
    let message = '';
    try {
      assertCapturedCardFormat('vacay', committed({ bitDepth: 16, colorType: 6, interlace: 1 }), SIZE);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('refusing to replace the committed vacay picture');
    expect(message).toContain('bit depth 16');
    expect(message).toContain('colour type 6');
    expect(message).toContain('interlace method 1');
  });

  it('still refuses a wrong-sized capture, and says why the size is what it is', () => {
    // The artboards are drawn at half scale, so the usual cause is a capture
    // that ran at deviceScaleFactor 1.
    expect(() => assertCapturedCardFormat('gcb', committed({ width: 300, height: 375 }), SIZE)).toThrow(
      /captured 300×375, expected 600×750/,
    );
  });

  it('is called by the renderer before it replaces the committed picture', () => {
    // The guard only helps if it runs while the capture is still staged: a
    // check after `renameSync` is a report on a file that has already been
    // overwritten.
    const code = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'render-share-rasters.mjs'),
      'utf8',
    );
    const guard = code.indexOf('assertCapturedCardFormat(id, header');
    const replace = code.indexOf('renameSync(scratch, dest)');
    expect(guard).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(guard);
  });
});
