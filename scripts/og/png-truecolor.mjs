// Writes 8-bit non-interlaced PNGs, and converts an RGBA one to the truecolor
// (colour type 2) form the committed share cards are required to be in.
//
// WHY THIS EXISTS (#887, review round 4). `render-share-footer.mjs` repaints
// one 32-row band on a committed card inside a Chromium canvas and writes what
// `canvas.toDataURL('image/png')` hands back. A 2D canvas has an alpha channel
// unless you ask for one without, so that encoder emits colour type 6 — RGBA —
// even when every pixel it composited is opaque. Removing the `pngquant` pass
// in an earlier round fixed colour type 3 and left this untouched, and the
// file's own comment claimed the output was truecolor while it was not. The
// next footer refresh would therefore have replaced a committed card with an
// RGBA file, and `src/recon-share-og.test.ts`'s `colorType === 2` assertion
// would have found out afterwards, with the good picture already gone.
//
// The fix is a conversion with a proof rather than a canvas flag.
// `getContext('2d', { alpha: false })` does usually make Chromium encode
// colour type 2, but "usually" is the whole problem: it is an encoder
// heuristic, not a promise in any specification, so a browser upgrade can take
// it away silently and the failure mode is again a committed asset in the
// wrong format. `toTruecolorPng` instead reads what the encoder actually
// produced, converts RGBA down to RGB when that is what it is, and refuses
// anything it cannot honestly convert — and the caller still validates the
// bytes it is about to publish (`assertCapturedCardFormat`), so nothing here
// is trusted on its own account.
//
// Dropping the alpha plane is only lossless if the plane says nothing, so it
// is checked rather than assumed: a single pixel with alpha below 255 means
// the picture depends on a channel colour type 2 cannot carry, so the
// conversion refuses by coordinate instead of flattening it against a
// background nobody chose.
import { deflateSync } from 'node:zlib';
import { paeth, readPngHeader, readPngPixels } from './png-pixels.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload. */
function chunk(type, payload) {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.write(type, 4, 'ascii');
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length);
  return out;
}

/**
 * Filter every scanline, picking the filter type per row by the minimum
 * sum-of-absolute-differences heuristic the PNG specification recommends.
 *
 * Filtering is not decoration here. A band repaint is supposed to change 32
 * rows of pixels, not the weight of the asset, and the None filter throughout
 * would multiply these photo-hero cards several times over. Adaptive filtering
 * re-encodes the three committed cards at 167/188/172 KB against Chromium's
 * own 175/193/214 KB, pixel-for-pixel identical (png-truecolor.test.mjs
 * measures exactly that).
 */
function filterScanlines(data, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const buffer = candidates[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels] : 0;
        const up = prior ? prior[x] : 0;
        const upLeft = prior && x >= channels ? prior[x - channels] : 0;
        let value;
        if (f === 0) value = row[x];
        else if (f === 1) value = row[x] - left;
        else if (f === 2) value = row[x] - up;
        else if (f === 3) value = row[x] - ((left + up) >> 1);
        else value = row[x] - paeth(left, up, upLeft);
        value &= 0xff;
        buffer[x] = value;
        // Signed-byte magnitude, which is what the heuristic scores.
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    candidates[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

/**
 * Encode `{ width, height, channels, data }` — the shape `readPngPixels`
 * returns — as an 8-bit non-interlaced PNG. `channels` 3 writes colour type 2
 * (truecolor) and 4 writes colour type 6 (truecolor + alpha); nothing else is
 * supported, which is the same narrow subset the reader next door decodes.
 */
export function encodePng({ width, height, channels, data }) {
  if (channels !== 3 && channels !== 4) {
    throw new Error(`png-truecolor: cannot encode ${channels} channels (expected 3 or 4)`);
  }
  if (data.length !== width * height * channels) {
    throw new Error(
      `png-truecolor: ${data.length} bytes for a ${width}×${height}×${channels} image (expected ${width * height * channels})`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none
  const idat = deflateSync(filterScanlines(Buffer.from(data.buffer, data.byteOffset, data.byteLength), width, height, channels), {
    level: 9,
  });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Return `bytes` as an 8-bit non-interlaced colour-type-2 PNG.
 *
 * A file that is already truecolor comes back untouched — re-encoding it would
 * churn bytes for nothing. An RGBA file is converted, but only after every
 * alpha byte has been proved to be 255: the conversion drops a channel, which
 * is lossless exactly when that channel carries no information, and a
 * partially transparent pixel means it carries some. `label` is the Edition or
 * filename the caller is working on, so a refusal names it.
 */
export function toTruecolorPng(bytes, label) {
  const header = readPngHeader(bytes);
  const where = label ? `${label}: ` : '';
  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(
      `png-truecolor: ${where}cannot convert a ${header.bitDepth}-bit${header.interlace !== 0 ? ' interlaced' : ''} PNG ` +
        'to truecolor — the committed cards are 8-bit and non-interlaced.',
    );
  }
  if (header.colorType === 2) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (header.colorType !== 6) {
    throw new Error(
      `png-truecolor: ${where}cannot convert colour type ${header.colorType} to truecolor (only 6, RGBA, is convertible).`,
    );
  }

  const { width, height, data } = readPngPixels(bytes);
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * 4;
    const alpha = data[from + 3];
    if (alpha !== 255) {
      // Reported by coordinate rather than as a count: the useful question
      // after this refusal is which part of the card went transparent, and a
      // composite that lost its ground usually starts at one identifiable edge.
      throw new Error(
        `png-truecolor: ${where}refusing to drop the alpha channel — pixel (${pixel % width}, ${Math.floor(pixel / width)}) ` +
          `has alpha ${alpha}, not 255. Colour type 2 cannot carry it, so the conversion would silently ` +
          'composite this pixel against a background nobody chose.',
      );
    }
    const to = pixel * 3;
    rgb[to] = data[from];
    rgb[to + 1] = data[from + 1];
    rgb[to + 2] = data[from + 2];
  }
  return encodePng({ width, height, channels: 3, data: rgb });
}
