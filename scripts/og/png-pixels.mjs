// A dependency-free PNG reader for the repo's committed rasters.
//
// It exists because the guards that matter for these assets are PIXEL facts —
// "the card's upper-right corner is its own dark ground, not a foreign card
// composited over it" (#887) — and the only decoders already in the tree are
// `compare-og.mjs`'s and `render-share-footer.mjs`'s, both of which reach for a
// headless Chromium canvas. That is the right tool inside a renderer that has
// a browser open anyway, and the wrong one for a unit test: `npm test` cannot
// launch a browser, so a browser-only decoder means the invariant is checked
// by nothing that runs on every commit, which is precisely how #887 shipped.
//
// Scope is deliberately the narrow subset the repo actually commits: 8-bit
// truecolor (color type 2) and truecolor+alpha (6), non-interlaced. Anything
// else throws by name rather than decoding to plausible nonsense — a palette
// PNG (what `pngquant` would produce) would otherwise read as garbage
// channels and quietly pass a colour assertion.
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Adopt `bytes` as a `Buffer` over the same memory, copying nothing.
 *
 * Both readers below are written against Buffer's accessors — `.equals`,
 * `.toString('ascii', start, end)`, `.readUInt32BE` — and a plain
 * `Uint8Array` has none of them. Two of the three throw, and the third is
 * worse: `Uint8Array.prototype.toString()` ignores its arguments and returns
 * the whole array as a comma-joined list of numbers, so the IHDR check would
 * fail for a reason that has nothing to do with the file. Every caller in the
 * tree hands over `readFileSync` output, which is already a Buffer, but the
 * declared parameter type is the wider `Uint8Array` and a caller that honours
 * the declaration must not fail at runtime for honouring it. `Buffer.from` on
 * the view's own `ArrayBuffer` is a window onto the same bytes, so the widened
 * input costs one object and no copy.
 */
function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** IHDR only — width/height/bit depth/colour type, without decoding any pixels. */
export function readPngHeader(bytes) {
  const buffer = asBuffer(bytes);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG: IHDR is not the first chunk');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode to `{ width, height, channels, data }`, where `data` is one byte per
 * channel in row-major order — the same shape `CanvasRenderingContext2D`'s
 * `getImageData().data` has, minus the forced alpha channel on an opaque PNG.
 */
export function readPngPixels(bytes) {
  const buffer = asBuffer(bytes);
  const header = readPngHeader(buffer);
  if (header.bitDepth !== 8) throw new Error(`PNG: unsupported bit depth ${header.bitDepth} (expected 8)`);
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`PNG: unsupported colour type ${header.colorType} (expected 2 or 6)`);
  }
  if (header.interlace !== 0) throw new Error('PNG: interlaced images are not supported');

  const parts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (parts.length === 0) throw new Error('PNG: no IDAT chunks');

  const { width, height } = header;
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts));
  if (raw.length < height * (stride + 1)) throw new Error('PNG: truncated image data');

  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = y * stride;
    const prior = out - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[out + x - channels] : 0;
      const up = y > 0 ? data[prior + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[prior + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`PNG: unknown scanline filter ${filter}`);
      data[out + x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * Share of pixels inside `rect` whose every colour channel is at or above
 * `floor` — a "how much of this region is near-white" reading.
 *
 * Near-white is the discriminator #887 needs: the `so-long-farewell` ground is
 * near-black and its brightest ink is thin antialiased type, so a clean card
 * scores a fraction of a percent, while the cream Vacay card that was
 * composited over it scores most of the region.
 */
export function lightPixelShare(image, rect, floor = 216) {
  const { x, y, width, height } = rect;
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    throw new Error('rect falls outside the image');
  }
  let light = 0;
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const i = (row * image.width + col) * image.channels;
      if (image.data[i] >= floor && image.data[i + 1] >= floor && image.data[i + 2] >= floor) light++;
    }
  }
  return light / (width * height);
}
