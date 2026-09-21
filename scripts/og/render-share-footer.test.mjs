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
import { isLocked, withDestinationLocks } from './og-commit-lock.mjs';
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

const publish = (ids, paint, overrides = {}) =>
  renderCardSet({
    ids,
    destDir: dir,
    fileFor: (id) => CARDS[id].file,
    capture: footerCaptureFrom(paint, { destDir: dir }),
    // The property under test in the lock cases below, and harmless in the
    // others: this is the production setting, because a band repaint reads the
    // card it replaces.
    readsDestination: true,
    ...overrides,
  });

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

describe('render-share-footer concurrency (#887): the repaint reads what it replaces', () => {
  /** Stand-in for `render-share-rasters.mjs` committing a freshly rendered
   *  card. It runs at the moment the footer run acquires its locks, which is
   *  the last instant a concurrent publisher can still win the race. */
  const newerRaster = () => Buffer.from('a full render committed by the other tool');

  it('sees the raster that landed before it took the lock, not one read earlier', async () => {
    const dest = seedCommitted('gcb');
    const seen = [];
    await publish(
      ['gcb'],
      async (id, b64) => {
        seen.push(Buffer.from(b64, 'base64').toString('utf8'));
        return canvasDataUrl();
      },
      {
        lock: (targets) => {
          // The concurrent full render commits here: after this footer run
          // decided to run, and before it is allowed to read anything.
          for (const t of targets) writeFileSync(t.dest, newerRaster());
          return () => {};
        },
      },
    );

    expect(seen).toEqual([newerRaster().toString('utf8')]);
    expect(readPngHeader(readFileSync(dest)).colorType).toBe(2);
  });

  it('would repaint the stale snapshot if the lock only covered the commit — the race is real', async () => {
    // The finding, reproduced against the same code with the one flag off.
    // With `readsDestination: false` the locks are taken at the commit phase,
    // so the capture has already read the card the other tool is about to
    // replace, and the repaint published over it is of the older picture.
    seedCommitted('gcb');
    const seen = [];
    await publish(
      ['gcb'],
      async (id, b64) => {
        seen.push(Buffer.from(b64, 'base64').toString('utf8'));
        return canvasDataUrl();
      },
      {
        readsDestination: false,
        lock: (targets) => {
          for (const t of targets) writeFileSync(t.dest, newerRaster());
          return () => {};
        },
      },
    );

    expect(seen).toEqual([`${STALE}: gcb`]);
  });

  it('is refused rather than proceeding while another process holds the destination', async () => {
    const dest = seedCommitted('gcb');
    const held = withDestinationLocks([{ dest }]);
    const painted = [];
    try {
      await expect(
        publish(['gcb'], async (id, b64) => {
          painted.push(id);
          return canvasDataUrl();
        }, { lock: (targets) => withDestinationLocks(targets, { timeoutMs: 200 }) }),
      ).rejects.toThrow(/timed out/);

      // Nothing was read, painted, staged or published, and the holder still
      // owns the lock — a refused footer run must not disturb the run it lost
      // to.
      expect(painted).toEqual([]);
      expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
      expect(isLocked(dest)).toBe(true);
    } finally {
      held();
    }
    expect(leftovers()).toEqual([]);
  });
});
