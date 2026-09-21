// @vitest-environment node
//
// The PNG encoder and the RGBA-to-RGB conversion `render-share-footer.mjs`
// publishes through (#887 round 4). The conversion exists because a 2D canvas
// carries an alpha channel, so `toDataURL('image/png')` emits colour type 6
// however opaque the composited pixels are, and all three committed cards must
// be colour type 2 — `src/recon-share-og.test.ts` requires it of the files in
// the tree, and the first thing that would have noticed was a red suite with
// the good picture already overwritten.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPngHeader, readPngPixels } from './png-pixels.mjs';
import { encodePng, toTruecolorPng } from './png-truecolor.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMITTED = ['share-final-photo-gcb.png', 'share-final-photo-vacay.png', 'share-final-photo-fa.png'];
const committedBytes = (file) => readFileSync(join(repo, 'plans', 'og-images', file));

/** An RGBA image the size of a committed card, on a dark ground so the caller's
 *  overlay guard has nothing to complain about. `transparentAt` puts one pixel
 *  at a lower alpha, which is the case the conversion has to refuse. */
function rgbaCard({ width = 600, height = 750, transparentAt = null, alpha = 128 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 18 + (pixel % 7);
    data[pixel * 4 + 1] = 18;
    data[pixel * 4 + 2] = 24;
    data[pixel * 4 + 3] = 255;
  }
  if (transparentAt) data[(transparentAt.y * width + transparentAt.x) * 4 + 3] = alpha;
  return { width, height, channels: 4, data };
}

describe('encodePng (#887)', () => {
  it('re-encodes every committed card losslessly, as colour type 2, no larger than it was', () => {
    // The conversion decodes and re-encodes the WHOLE image, not just the
    // repainted band, so "the only pixels that moved are the ones in the band"
    // depends on this being exact — and the asset not ballooning depends on the
    // adaptive scanline filtering rather than the None filter throughout.
    for (const file of COMMITTED) {
      const original = committedBytes(file);
      const image = readPngPixels(original);
      const encoded = encodePng(image);
      const header = readPngHeader(encoded);
      expect(header, file).toMatchObject({ width: 600, height: 750, bitDepth: 8, colorType: 2, interlace: 0 });
      expect(Buffer.from(readPngPixels(encoded).data).equals(Buffer.from(image.data)), file).toBe(true);
      expect(encoded.length, `${file} grew`).toBeLessThanOrEqual(original.length);
    }
  });

  it('writes colour type 6 when handed four channels', () => {
    expect(readPngHeader(encodePng(rgbaCard({ width: 4, height: 3 }))).colorType).toBe(6);
  });

  it('refuses a channel count it cannot write, and a data length that disagrees', () => {
    expect(() => encodePng({ width: 2, height: 2, channels: 1, data: Buffer.alloc(4) })).toThrow(
      /cannot encode 1 channels/,
    );
    expect(() => encodePng({ width: 2, height: 2, channels: 3, data: Buffer.alloc(3) })).toThrow(
      /3 bytes for a 2×2×3 image/,
    );
  });
});

describe('toTruecolorPng (#887)', () => {
  it('converts an opaque RGBA image to colour type 2, pixel for pixel', () => {
    const rgba = rgbaCard({ width: 8, height: 5 });
    const converted = toTruecolorPng(encodePng(rgba), 'gcb');

    expect(readPngHeader(converted)).toMatchObject({ colorType: 2, bitDepth: 8, interlace: 0 });
    const out = readPngPixels(converted);
    expect(out.channels).toBe(3);
    for (let pixel = 0; pixel < rgba.width * rgba.height; pixel++) {
      expect([out.data[pixel * 3], out.data[pixel * 3 + 1], out.data[pixel * 3 + 2]]).toEqual([
        rgba.data[pixel * 4],
        rgba.data[pixel * 4 + 1],
        rgba.data[pixel * 4 + 2],
      ]);
    }
  });

  it('refuses to drop an alpha channel that carries something, and says which pixel', () => {
    // Dropping the plane is lossless exactly when the plane says nothing. One
    // pixel below 255 means it does, and flattening it would composite that
    // pixel against a background nobody chose.
    const rgba = rgbaCard({ width: 8, height: 5, transparentAt: { x: 3, y: 2 }, alpha: 200 });
    expect(() => toTruecolorPng(encodePng(rgba), 'vacay')).toThrow(/vacay: refusing to drop the alpha channel/);
    expect(() => toTruecolorPng(encodePng(rgba), 'vacay')).toThrow(/pixel \(3, 2\) has alpha 200, not 255/);
  });

  it('hands back an already-truecolor file untouched rather than re-encoding it', () => {
    const original = committedBytes('share-final-photo-gcb.png');
    expect(toTruecolorPng(original, 'gcb')).toBe(original);
  });

  it('refuses a colour type it cannot honestly convert', () => {
    const palette = Buffer.from(committedBytes('share-final-photo-gcb.png'));
    palette[25] = 3; // IHDR colour type: palette, what pngquant emits
    expect(() => toTruecolorPng(palette, 'fiveacross')).toThrow(
      /fiveacross: cannot convert colour type 3 to truecolor/,
    );
  });

  it('refuses a bit depth or interlace method outside the committed cards contract', () => {
    const sixteenBit = Buffer.from(committedBytes('share-final-photo-gcb.png'));
    sixteenBit[24] = 16;
    expect(() => toTruecolorPng(sixteenBit, 'gcb')).toThrow(/cannot convert a 16-bit PNG/);

    const interlaced = Buffer.from(committedBytes('share-final-photo-gcb.png'));
    interlaced[28] = 1;
    expect(() => toTruecolorPng(interlaced, 'gcb')).toThrow(/interlaced PNG/);
  });
});
