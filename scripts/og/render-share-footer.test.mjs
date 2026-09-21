// @vitest-environment node
//
// The footer refresher's publication path (#887 round 4), driven through the
// same seams the raster generator's staging tests use: `footerCaptureFrom` is
// the production capture step with the browser replaced by a synthetic canvas
// result, and everything after it — staging, the format guard, the
// all-or-nothing commit — is the production `renderCardSet`.
//
// The finding: `canvas.toDataURL('image/png')` encodes the default
// alpha-enabled 2D canvas as colour type 6 however opaque its pixels are, and
// this tool wrote those bytes straight over a committed card while claiming in
// its own comment to be writing truecolor. All three committed cards are
// colour type 2 and `src/recon-share-og.test.ts` requires it, so the next
// footer refresh would have published an RGBA card and the suite would have
// found out afterwards, with the good picture gone.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPngHeader, readPngPixels } from './png-pixels.mjs';
import { encodePng } from './png-truecolor.mjs';
import { CARDS, footerCaptureFrom } from './render-share-footer.mjs';
import { renderCardSet } from './render-share-rasters.mjs';

const STALE = 'the card that is already committed';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-share-footer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedCommitted(id) {
  const dest = join(dir, CARDS[id].file);
  writeFileSync(dest, `${STALE}: ${id}`);
  return dest;
}

function leftovers() {
  const committed = new Set(Object.values(CARDS).map((c) => c.file));
  return readdirSync(dir).filter((name) => !committed.has(name));
}

/** What the canvas hands back: a full-size card, RGBA because the context has
 *  an alpha channel, on the dark ground the two non-Vacay cards carry. */
function canvasDataUrl({ transparentAt = null } = {}) {
  const width = 600;
  const height = 750;
  const data = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 17;
    data[pixel * 4 + 1] = 18;
    data[pixel * 4 + 2] = 23;
    data[pixel * 4 + 3] = 255;
  }
  if (transparentAt) data[(transparentAt.y * width + transparentAt.x) * 4 + 3] = 0;
  const png = encodePng({ width, height, channels: 4, data });
  // Sanity on the fixture itself: if this ever stopped being colour type 6 the
  // tests below would be proving nothing.
  expect(readPngHeader(png).colorType).toBe(6);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const publish = (ids, paint) =>
  renderCardSet({ ids, destDir: dir, fileFor: (id) => CARDS[id].file, capture: footerCaptureFrom(paint) });

describe('render-share-footer publication (#887): the committed card stays colour type 2', () => {
  it('converts an opaque RGBA canvas result and commits it as truecolor', () => {
    const dest = seedCommitted('gcb');
    return publish(['gcb'], async () => canvasDataUrl()).then((staged) => {
      const header = readPngHeader(readFileSync(dest));
      expect(header).toMatchObject({ width: 600, height: 750, bitDepth: 8, colorType: 2, interlace: 0 });
      // The pixels survived the conversion, which is the whole reason it is a
      // channel drop rather than a re-render.
      const pixels = readPngPixels(readFileSync(dest));
      expect([pixels.data[0], pixels.data[1], pixels.data[2]]).toEqual([17, 18, 23]);
      // And the guard that proves it is the raster generator's, reported back.
      expect(staged[0].report).toMatchObject({ colorType: 2, width: 600, height: 750 });
      expect(leftovers()).toEqual([]);
    });
  });

  it('refuses a canvas result with a transparent pixel and commits nothing', async () => {
    const dest = seedCommitted('gcb');
    await expect(publish(['gcb'], async () => canvasDataUrl({ transparentAt: { x: 12, y: 9 } }))).rejects.toThrow(
      /refusing to drop the alpha channel/,
    );
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(leftovers()).toEqual([]);
  });

  it('leaves every card alone when one Edition in an --all run fails', async () => {
    // Same all-or-nothing guarantee the raster generator got: a mixed set of
    // footers is exactly as bad as a mixed set of renders.
    const dests = { gcb: seedCommitted('gcb'), fiveacross: seedCommitted('fiveacross') };
    await expect(
      publish(['gcb', 'fiveacross'], async (id) =>
        canvasDataUrl(id === 'fiveacross' ? { transparentAt: { x: 1, y: 1 } } : {}),
      ),
    ).rejects.toThrow(/fiveacross failed/);

    expect(readFileSync(dests.gcb, 'utf8')).toBe(`${STALE}: gcb`);
    expect(readFileSync(dests.fiveacross, 'utf8')).toBe(`${STALE}: fiveacross`);
    expect(leftovers()).toEqual([]);
  });

  it('refuses anything that is not a PNG data URL rather than staging an empty file', async () => {
    // `toDataURL` answers `data:,` when the encode fails. Splitting that on a
    // comma yields undefined, which would stage nothing and make the PNG
    // reader blame the file instead of the encoder.
    const dest = seedCommitted('gcb');
    await expect(publish(['gcb'], async () => 'data:,')).rejects.toThrow(/did not return a PNG data URL for gcb/);
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(existsSync(join(dir, `${CARDS.gcb.file}.render-tmp`))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});
