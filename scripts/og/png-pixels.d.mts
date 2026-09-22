// Types for the dependency-free PNG reader, so `src/**` tests can import it
// under the app's TypeScript program — the same arrangement
// `og-edition-art.d.mts` makes for the art table next door.

export type PngHeader = {
  width: number;
  height: number;
  bitDepth: number;
  /** PNG colour type: 2 = truecolor, 6 = truecolor + alpha (the only two decoded). */
  colorType: number;
  interlace: number;
};

export type PngImage = {
  width: number;
  height: number;
  /** 3 for truecolor, 4 for truecolor + alpha. */
  channels: number;
  /** One byte per channel, row-major. */
  data: Uint8Array;
};

export type PngRect = { x: number; y: number; width: number; height: number };

/**
 * Both readers take the wide type on purpose, and the implementation honours
 * it: a plain `Uint8Array` is adopted as a `Buffer` over the same memory
 * before anything reads it, because the parsing uses Buffer-only accessors
 * (`.equals`, `.toString('ascii', start, end)`, `.readUInt32BE`) that a plain
 * view either lacks or, worse, answers with something plausible and wrong.
 */
export function readPngHeader(buffer: Uint8Array): PngHeader;
export function readPngPixels(buffer: Uint8Array): PngImage;
export function lightPixelShare(image: PngImage, rect: PngRect, floor?: number): number;

/** The PNG Paeth predictor, shared with the encoder in png-truecolor.mjs. */
export function paeth(a: number, b: number, c: number): number;
