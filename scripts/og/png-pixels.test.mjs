// @vitest-environment node
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { lightPixelShare, readPngHeader, readPngPixels } from './png-pixels.mjs';

/** `length | type | data | crc32(type + data)`, the PNG chunk layout. */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * A real, CRC-correct 8-bit non-interlaced truecolor PNG of `rows`, each row
 * an array of `[r, g, b]` triples.
 *
 * Synthesised rather than read off disk so these stay reader tests: the
 * committed cards are 600x750 and would make every assertion here depend on
 * an asset that is the subject of a different guard.
 */
function truecolorPng(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none
  const raw = Buffer.concat(
    rows.map((row) => Buffer.from([0, ...row.flat()])), // filter byte 0 (None) per scanline
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const SAMPLE = truecolorPng([
  [WHITE, WHITE],
  [BLACK, BLACK],
]);

describe('png-pixels reads what its declaration says it takes (#887)', () => {
  // The regression: the declarations in `png-pixels.d.mts` take `Uint8Array`,
  // but the parsing uses Buffer-only accessors. A caller that honoured the
  // declared type got `subarray(...).equals is not a function` out of
  // `readPngHeader`, and `readPngPixels` reaches that on its first line — so
  // the whole module was Buffer-only in practice and Uint8Array-shaped on
  // paper. Every caller in the tree passes `readFileSync` output, which is a
  // Buffer, which is why nothing caught it.
  const plain = new Uint8Array(SAMPLE);

  it('does not quietly require a Buffer', () => {
    expect(Buffer.isBuffer(plain)).toBe(false);
    expect(plain).toBeInstanceOf(Uint8Array);
  });

  it('reads the header from a plain Uint8Array', () => {
    expect(readPngHeader(plain)).toEqual({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      interlace: 0,
    });
  });

  it('decodes pixels from a plain Uint8Array', () => {
    const image = readPngPixels(plain);
    expect({ width: image.width, height: image.height, channels: image.channels }).toEqual({
      width: 2,
      height: 2,
      channels: 3,
    });
    expect([...image.data]).toEqual([255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0]);
    expect(lightPixelShare(image, { x: 0, y: 0, width: 2, height: 1 })).toBe(1);
    expect(lightPixelShare(image, { x: 0, y: 1, width: 2, height: 1 })).toBe(0);
  });

  it('reads a Uint8Array that is a window into a larger ArrayBuffer', () => {
    // The adoption has to carry `byteOffset`/`byteLength` across, not just
    // wrap the backing store: a view that starts partway in would otherwise
    // be read from byte 0 of the wrong region and fail on the signature.
    const padded = new Uint8Array(SAMPLE.length + 9);
    padded.set(SAMPLE, 7);
    const window = padded.subarray(7, 7 + SAMPLE.length);
    expect(window.byteOffset).toBe(7);
    expect(readPngHeader(window).width).toBe(2);
    expect([...readPngPixels(window).data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it('still reads a Buffer, which is what every caller in the tree passes', () => {
    expect(readPngHeader(SAMPLE).colorType).toBe(2);
    expect(readPngPixels(SAMPLE).channels).toBe(3);
  });

  it('rejects a palette PNG by name rather than decoding it as nonsense', () => {
    const palette = Buffer.from(SAMPLE);
    palette[25] = 3; // IHDR colour type: palette, what pngquant emits
    expect(() => readPngPixels(new Uint8Array(palette))).toThrow(/unsupported colour type 3/);
  });
});

describe('readPngPixels refuses a PNG that is not structurally complete (#1264, #1266)', () => {
  // The chunk loop used to stop at end-of-buffer without complaint, so a file
  // cut off after its last IDAT chunk (no IEND) decoded as complete whenever
  // its compressed payload still inflated; nor did it check a single CRC. A
  // capture truncated that way passed `readPngPixels`, `inspectCapture` and
  // the committed-asset completeness test. Each fixture below is one
  // structural defect away from `SAMPLE`, which still decodes.
  const IEND_LENGTH = 12;
  const IDAT_AT = SAMPLE.indexOf('IDAT', 0, 'ascii') - 4;
  const IDAT_LENGTH = SAMPLE.readUInt32BE(IDAT_AT);

  it('still decodes the intact fixture', () => {
    expect(readPngPixels(SAMPLE).width).toBe(2);
  });

  it('refuses a file truncated after its IDAT chunk, with IEND missing', () => {
    const truncated = SAMPLE.subarray(0, SAMPLE.length - IEND_LENGTH);
    // Sanity on the fixture: the IDAT chunk is intact and still the last one.
    expect(IDAT_AT + 12 + IDAT_LENGTH).toBe(truncated.length);
    expect(() => readPngPixels(truncated)).toThrow(/no IEND chunk/);
  });

  it('refuses a file truncated inside the IEND chunk', () => {
    expect(() => readPngPixels(SAMPLE.subarray(0, SAMPLE.length - 4))).toThrow(/truncated/);
  });

  it('refuses a chunk whose declared length runs past the end of the file', () => {
    const overlong = Buffer.from(SAMPLE);
    overlong.writeUInt32BE(0x7fffffff, IDAT_AT);
    expect(() => readPngPixels(overlong)).toThrow(/IDAT chunk .*runs past the end of the file/);
  });

  it('refuses an IDAT chunk whose stored CRC is wrong', () => {
    const corrupt = Buffer.from(SAMPLE);
    corrupt[IDAT_AT + 8 + IDAT_LENGTH] ^= 0xff; // first byte of the IDAT CRC
    expect(() => readPngPixels(corrupt)).toThrow(/IDAT chunk .*CRC mismatch/);
  });

  it('refuses a payload byte flipped under an intact CRC', () => {
    const corrupt = Buffer.from(SAMPLE);
    corrupt[IDAT_AT + 8 + IDAT_LENGTH - 1] ^= 0x01; // last payload byte
    expect(() => readPngPixels(corrupt)).toThrow(/IDAT chunk .*CRC mismatch/);
  });

  it('refuses decompressed image data longer than the scanlines the header declares', () => {
    const extra = Buffer.concat([
      SAMPLE.subarray(0, 33),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 9]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => readPngPixels(extra)).toThrow(/image data is 15 bytes, expected 14/);
  });

  it('refuses decompressed image data shorter than the scanlines the header declares', () => {
    const short = Buffer.concat([
      SAMPLE.subarray(0, 33),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255, 255, 255]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => readPngPixels(short)).toThrow(/image data is 7 bytes, expected 14/);
  });
});
