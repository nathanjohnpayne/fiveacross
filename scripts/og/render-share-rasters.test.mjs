// @vitest-environment node
//
// Drives the share-card generator's staging contract (#887 review round 3)
// against a real filesystem in a temp directory, through the seams
// `renderCardSet` takes — never a real browser, and never a reimplementation
// of the contract: the commit phase under test is the production
// `commitStaged`, and the happy path validates through the production
// `inspectCapture` against the bytes of the committed pictures themselves.
//
// Two findings are pinned here:
//
//   - `--all` used to rename each Edition into `plans/og-images/` the moment
//     that Edition validated, so a batch whose second card failed left the
//     first updated and the rest stale. A mixed render set from one command,
//     with nothing in the tree to say which cards came from which run.
//   - The display face was never checked. `document.fonts.ready` resolves on
//     a host with neither Bebas Neue nor Arial Narrow, Chromium falls through
//     to the generic sans-serif, and the capture passes every size, format and
//     overlay check while replacing the committed picture with different
//     typography.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readPngHeader, readPngPixels } from './png-pixels.mjs';
import { encodePng } from './png-truecolor.mjs';
import { FOOTER_OPTIONS } from './render-share-footer.mjs';
import {
  CARDS,
  DISPLAY_FACE_STACK,
  REQUIRED_DISPLAY_FACE,
  assertDisplayFace,
  inspectCapture,
  optionValue,
  renderCardSet,
  repeatedOptions,
  resolvedDisplayFace,
  unknownOptions,
} from './render-share-rasters.mjs';
import { MAX_DARK_CARD_LIGHT_SHARE, isOverlaid, overlayLightShare } from './share-card-overlay.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A real committed capture: 600×750, 8-bit non-interlaced truecolor, with a
 *  dark upper-right quadrant. Using the actual asset means the happy path runs
 *  the production validator rather than a stub that agrees with it. */
const conformingPng = (id) => readFileSync(join(repo, 'plans', 'og-images', CARDS[id].file));
const STALE = 'the picture that is already committed';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-share-rasters-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put a stand-in for the already-committed picture at an Edition's
 *  destination, so "unchanged" is something a test can assert rather than
 *  infer from an absence. */
function seedCommitted(id) {
  const dest = join(dir, CARDS[id].file);
  writeFileSync(dest, `${STALE}: ${id}`);
  return dest;
}

/** Every file in the run directory that is neither a committed destination nor
 *  something a passing run is allowed to leave behind: scratch captures
 *  (`*.render-tmp.*`), rollback copies (`*.rollback-tmp.*`) and lock files. */
function leftovers() {
  const committed = new Set(Object.values(CARDS).map((c) => c.file));
  return readdirSync(dir).filter((name) => !committed.has(name));
}

/** A capture seam that writes whatever bytes the test says each Edition
 *  produces, and records the order it was asked. */
function captureWriting(bytesById, calls = []) {
  return async (id, scratch) => {
    calls.push(id);
    writeFileSync(scratch, bytesById[id]);
  };
}

describe('renderCardSet staging (#887): --all publishes every card or none', () => {
  it('commits every target once all of them validate', async () => {
    const dests = { gcb: seedCommitted('gcb'), fiveacross: seedCommitted('fiveacross') };
    const staged = await renderCardSet({
      ids: ['gcb', 'fiveacross'],
      destDir: dir,
      capture: captureWriting({ gcb: conformingPng('gcb'), fiveacross: conformingPng('fiveacross') }),
    });

    expect(staged.map((s) => s.id)).toEqual(['gcb', 'fiveacross']);
    expect(readFileSync(dests.gcb).equals(conformingPng('gcb'))).toBe(true);
    expect(readFileSync(dests.fiveacross).equals(conformingPng('fiveacross'))).toBe(true);
    // The production validator ran, rather than being skipped on the way past.
    expect(staged[0].report).toMatchObject({ width: 600, height: 750, colorType: 2 });
    expect(staged[0].report.lightShare).toBeLessThan(0.12);
    expect(leftovers()).toEqual([]);
  });

  it('leaves an earlier card untouched when a later one fails its checks', async () => {
    // The finding: gcb validated and was renamed into place immediately, so a
    // vacay capture that then failed exited the command with gcb updated and
    // vacay stale — from one `--all` run.
    const dests = { gcb: seedCommitted('gcb'), vacay: seedCommitted('vacay') };
    const calls = [];

    await expect(
      renderCardSet({
        ids: ['gcb', 'vacay'],
        destDir: dir,
        capture: captureWriting(
          { gcb: conformingPng('gcb'), vacay: Buffer.from('not a png at all') },
          calls,
        ),
      }),
    ).rejects.toThrow(/vacay failed, so nothing was written/);

    expect(calls).toEqual(['gcb', 'vacay']);
    expect(readFileSync(dests.gcb, 'utf8')).toBe(`${STALE}: gcb`);
    expect(readFileSync(dests.vacay, 'utf8')).toBe(`${STALE}: vacay`);
    expect(leftovers()).toEqual([]);
  });

  it('names the Edition that failed, and carries the underlying refusal', async () => {
    seedCommitted('gcb');
    seedCommitted('vacay');
    let message = '';
    try {
      await renderCardSet({
        ids: ['gcb', 'vacay'],
        destDir: dir,
        capture: captureWriting({ gcb: conformingPng('gcb'), vacay: conformingPng('vacay') }),
        // A refusal the fixture can aim at one Edition, standing in for any of
        // the real ones (wrong size, wrong colour type, cream quadrant).
        inspect: (id) => {
          if (id === 'vacay') throw new Error('refusing to replace the committed vacay picture — synthetic');
          return { width: 600, height: 750, colorType: 2, bytes: 1, lightShare: 0 };
        },
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('vacay failed');
    expect(message).toContain('refusing to replace the committed vacay picture');
    expect(message).toContain('staged together and discarded together');
  });

  it('discards the scratch file when the very first capture fails', async () => {
    const dest = seedCommitted('gcb');
    await expect(
      renderCardSet({
        ids: ['gcb'],
        destDir: dir,
        capture: async (id, scratch) => {
          // A screenshot that dies partway through still leaves a file.
          writeFileSync(scratch, 'half a capture');
          throw new Error('chromium went away');
        },
      }),
    ).rejects.toThrow(/gcb failed/);
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(leftovers()).toEqual([]);
  });

  it('sweeps the scratch files and keeps the tree when the commit phase fails', async () => {
    // Staging all-or-nothing is only half the guarantee: a failure in the
    // publish loop has to reach the same cleanup, or a run that got as far as
    // the commit leaves scratch files behind and reports nothing about them.
    // The rollback of the renames themselves belongs to `commitStaged` and is
    // driven directly in og-stage-commit.test.mjs.
    const dests = { gcb: seedCommitted('gcb'), fiveacross: seedCommitted('fiveacross') };
    const discarded = [];
    await expect(
      renderCardSet({
        ids: ['gcb', 'fiveacross'],
        destDir: dir,
        capture: captureWriting({ gcb: conformingPng('gcb'), fiveacross: conformingPng('fiveacross') }),
        commit: () => {
          throw new Error('no space left on device');
        },
        discard: (staged) => {
          discarded.push(...staged.map((entry) => entry.id));
          for (const entry of staged) if (existsSync(entry.scratch)) rmSync(entry.scratch);
        },
      }),
    ).rejects.toThrow(/no space left on device/);

    expect(discarded).toEqual(['gcb', 'fiveacross']);
    expect(readFileSync(dests.gcb, 'utf8')).toBe(`${STALE}: gcb`);
    expect(readFileSync(dests.fiveacross, 'utf8')).toBe(`${STALE}: fiveacross`);
    expect(leftovers()).toEqual([]);
  });
});

describe('renderCardSet preflight (#887): a host that cannot draw the cards captures nothing', () => {
  it('aborts before the first capture when the display face is missing', async () => {
    const dest = seedCommitted('gcb');
    const calls = [];
    await expect(
      renderCardSet({
        ids: ['gcb', 'vacay', 'fiveacross'],
        destDir: dir,
        preflight: async () => {
          // Exactly what the real preflight raises on a host whose `.shc`
          // rules fall through to the generic.
          assertDisplayFace(
            DISPLAY_FACE_STACK.map((family) => ({ family, checked: false, width: 900, genericWidth: 900 })),
          );
        },
        capture: captureWriting({ gcb: conformingPng('gcb') }, calls),
      }),
    ).rejects.toThrow(/refusing to capture/);

    expect(calls).toEqual([]);
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(leftovers()).toEqual([]);
  });
});

describe('assertDisplayFace (#887)', () => {
  const probe = (family, overrides = {}) => ({
    family,
    checked: false,
    width: 900,
    genericWidth: 900,
    ...overrides,
  });
  /** What a correctly equipped macOS host reports: Bebas Neue absent, Arial
   *  Narrow present and measurably narrower than the generic. */
  const macOsHost = () => [
    probe('Bebas Neue'),
    probe('Arial Narrow', { checked: true, width: 742 }),
  ];

  it('accepts the host the committed pictures were captured on', () => {
    expect(assertDisplayFace(macOsHost())).toBe(REQUIRED_DISPLAY_FACE);
    expect(resolvedDisplayFace(macOsHost())).toBe(REQUIRED_DISPLAY_FACE);
  });

  it('refuses a host where neither display face resolves, and names the one to install', () => {
    // The finding: `document.fonts.ready` resolves here too, so without this
    // check the run captures generic sans-serif type over the committed cards.
    expect(() => assertDisplayFace([probe('Bebas Neue'), probe('Arial Narrow')])).toThrow(
      /nothing in the stack resolves/,
    );
    expect(() => assertDisplayFace([probe('Bebas Neue'), probe('Arial Narrow')])).toThrow(/Arial Narrow/);
    expect(resolvedDisplayFace([probe('Bebas Neue'), probe('Arial Narrow')])).toBeNull();
  });

  it('refuses a face that document.fonts.check claims but the cascade did not use', () => {
    // `check` answers about availability, not about what was drawn. A family
    // it reports present that measures exactly as the generic did not render.
    const probes = [probe('Bebas Neue'), probe('Arial Narrow', { checked: true, width: 900 })];
    expect(() => assertDisplayFace(probes)).toThrow(/nothing in the stack resolves/);
    expect(() => assertDisplayFace(probes)).toThrow(/fell back/);
  });

  it('refuses a host that resolves the stack to a different face', () => {
    // Bebas Neue sits ahead of Arial Narrow in the `.shc` stack, so installing
    // it restyles every card just as surely as removing Arial Narrow does.
    const probes = [
      probe('Bebas Neue', { checked: true, width: 688 }),
      probe('Arial Narrow', { checked: true, width: 742 }),
    ];
    expect(resolvedDisplayFace(probes)).toBe('Bebas Neue');
    expect(() => assertDisplayFace(probes)).toThrow(/the stack resolves to Bebas Neue/);
  });

  it('reports each face it probed, so an unexpected refusal is diagnosable', () => {
    let message = '';
    try {
      assertDisplayFace([probe('Bebas Neue'), probe('Arial Narrow')]);
    } catch (error) {
      message = error.message;
    }
    for (const family of DISPLAY_FACE_STACK) expect(message).toContain(`${family}: document.fonts.check`);
    expect(message).toContain('document.fonts.ready resolves either way');
  });
});

describe('the overlay boundary (#887): the cap itself is refused, not accepted', () => {
  const W = 600;
  const H = 750;
  /** The quadrant the reading is taken over, in pixels. */
  const QUADRANT = (W / 2) * (H / 2);

  /**
   * A 600x750 truecolor card on a near-black ground with exactly `lightPixels`
   * near-white pixels inside the measured quadrant — the #887 overlay, dialled
   * to a chosen share.
   */
  function cardWithLightPixels(lightPixels) {
    const data = Buffer.alloc(W * H * 3);
    for (let i = 0; i < data.length; i += 3) {
      data[i] = 17;
      data[i + 1] = 18;
      data[i + 2] = 23;
    }
    let painted = 0;
    for (let y = 0; y < H / 2 && painted < lightPixels; y++) {
      for (let x = W / 2; x < W && painted < lightPixels; x++) {
        const at = (y * W + x) * 3;
        // `lightPixelShare`'s floor is 216 on every channel.
        data[at] = 255;
        data[at + 1] = 255;
        data[at + 2] = 255;
        painted++;
      }
    }
    return encodePng({ width: W, height: H, channels: 3, data });
  }

  it('measures the fixture at exactly the cap, so the boundary case is the one being tested', () => {
    // If this drifts, the two tests below stop straddling the boundary and
    // quietly start proving nothing.
    const atCap = readPngPixels(cardWithLightPixels(QUADRANT * MAX_DARK_CARD_LIGHT_SHARE));
    expect(QUADRANT).toBe(112500);
    expect(overlayLightShare(atCap)).toBe(MAX_DARK_CARD_LIGHT_SHARE);
    expect(isOverlaid(MAX_DARK_CARD_LIGHT_SHARE)).toBe(true);
  });

  it('refuses a capture sitting exactly on the cap, and commits nothing', async () => {
    // The finding: this used to be published by a run that reported success,
    // because the renderer refused only a share strictly ABOVE the cap while
    // src/recon-share-og.test.ts requires one strictly BELOW it. The next
    // `npm test` then failed on a file the renderer had just written.
    const dest = seedCommitted('gcb');
    await expect(
      renderCardSet({
        ids: ['gcb'],
        destDir: dir,
        capture: captureWriting({ gcb: cardWithLightPixels(13_500) }),
      }),
    ).rejects.toThrow(/upper-right quadrant is 12\.0% near-white/);
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(leftovers()).toEqual([]);
  });

  it('accepts a capture one pixel under the cap', async () => {
    const dest = seedCommitted('gcb');
    const staged = await renderCardSet({
      ids: ['gcb'],
      destDir: dir,
      capture: captureWriting({ gcb: cardWithLightPixels(13_499) }),
    });
    expect(staged[0].report.lightShare).toBeLessThan(MAX_DARK_CARD_LIGHT_SHARE);
    expect(readPngHeader(readFileSync(dest)).colorType).toBe(2);
    expect(leftovers()).toEqual([]);
  });
});

describe('option parsing (#887): an option token is never a value', () => {
  it('reads a real value', () => {
    expect(optionValue(['--edition', 'gcb', '--out', '/tmp/rasters'], '--out')).toBe('/tmp/rasters');
    expect(optionValue(['--edition', 'gcb'], '--edition')).toBe('gcb');
  });

  it('returns null for a flag that is absent, last, or followed by another option', () => {
    // The finding: `args[i + 1]` answered `--all` for `--out --all`, so the
    // value-less guard never fired and the run created a directory literally
    // named `--all` and wrote the cards into it. `--out --check` created that
    // directory while reporting that nothing had been written.
    expect(optionValue(['--all'], '--out')).toBeNull();
    expect(optionValue(['--edition', 'gcb', '--out'], '--out')).toBeNull();
    expect(optionValue(['--edition', 'gcb', '--out', '--all'], '--out')).toBeNull();
    expect(optionValue(['--edition', 'gcb', '--out', '--check'], '--out')).toBeNull();
    // Same defect, same fix, on the other flag that takes a value.
    expect(optionValue(['--edition', '--all'], '--edition')).toBeNull();
    expect(optionValue(['--edition'], '--edition')).toBeNull();
  });

  it.each([
    ['--out', '--all'],
    ['--out', '--check'],
  ])('refuses %s %s before touching the filesystem', (flag, followedBy) => {
    // Spawned in an empty directory, because the defect was a directory being
    // created: an assertion on the parser alone cannot see that.
    const cwd = mkdtempSync(join(tmpdir(), 'render-share-rasters-cli-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-rasters.mjs', import.meta.url)),
          '--edition',
          'gcb',
          '--allow-foreign-platform',
          flag,
          followedBy,
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toContain('render-share-rasters.mjs: --out needs a directory.');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('unknown options (#887): a typo never publishes', () => {
  it('names the token nobody recognised, and passes a well-formed line', () => {
    // The finding: `--edition gcb --chek` left `only` populated and
    // `checkOnly` false, so the run rendered and replaced the committed
    // picture. The flag that exists to write nothing is the one a typo
    // silently removes.
    expect(unknownOptions(['--edition', 'gcb', '--chek'])).toEqual(['--chek']);
    expect(unknownOptions(['--edition', 'gcb', '--out', '/tmp/x', '--check'])).toEqual([]);
    expect(unknownOptions(['--all', '--allow-foreign-platform'])).toEqual([]);
    // A stray positional is unrecognised too: this tool takes none.
    expect(unknownOptions(['--all', 'gcb'])).toEqual(['gcb']);
    // A valued flag's value is consumed, so a path is never itself reported.
    expect(unknownOptions(['--out', '--all'])).toEqual([]);
    // The footer tool takes no --out, so for it that flag IS unknown.
    expect(unknownOptions(['--edition', 'gcb', '--out', '/tmp/x'], FOOTER_OPTIONS)).toEqual(['--out', '/tmp/x']);
  });

  it.each([
    ['render-share-rasters.mjs'],
    ['render-share-footer.mjs'],
  ])('%s exits 1 on a mistyped flag without launching a browser or writing', (script) => {
    // Deliberately paired with an Edition id that does not exist. If the
    // unknown-option check ever regressed, the unknown-edition check still
    // stops the run before Chromium, so a regression fails this test rather
    // than repainting a committed card from the test suite.
    const cwd = mkdtempSync(join(tmpdir(), 'og-unknown-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL(`./${script}`, import.meta.url)),
          '--edition',
          'not-an-edition',
          '--allow-foreign-platform',
          '--chek',
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toContain(`${script}: unrecognised option --chek.`);
      // Not the Edition check, and not a render: the typo is what stopped it.
      expect(result.stderr).not.toContain('Unknown edition');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('repeatedOptions (#887, finding 4074926161): a repeat is never "first wins"', () => {
  it('names a valued option that appears twice', () => {
    // The finding: `optionValue`'s `indexOf` reads only the FIRST
    // `--edition`, so `--edition vacay --edition gcb` silently republished
    // Vacay rather than the operator's actual, last-stated target.
    expect(repeatedOptions(['--edition', 'vacay', '--edition', 'gcb'])).toEqual(['--edition']);
    expect(repeatedOptions(['--edition', 'gcb', '--out', '/tmp/a', '--out', '/tmp/b'])).toEqual(['--out']);
    expect(repeatedOptions(['--edition', 'gcb', '--edition', '--out', '/tmp/a', '--out'])).toEqual([
      '--edition',
      '--out',
    ]);
  });

  it('is silent for a single occurrence, and ignores flags entirely', () => {
    expect(repeatedOptions(['--edition', 'gcb'])).toEqual([]);
    expect(repeatedOptions(['--edition', 'gcb', '--out', '/tmp/a'])).toEqual([]);
    // `--all`/`--check` are boolean `args.includes()` reads in `main`, not
    // `optionValue` reads, so a repeat of one is harmless and out of scope
    // for this guard.
    expect(repeatedOptions(['--all', '--all', '--check', '--check'])).toEqual([]);
  });

  it('scopes to the options object passed in, like unknownOptions does', () => {
    expect(repeatedOptions(['--edition', 'gcb', '--edition', 'vacay'], FOOTER_OPTIONS)).toEqual(['--edition']);
  });
});

describe('assertNoRepeatedOptions (#887, finding 4074926161): a repeat refuses, and never renders', () => {
  it('refuses --edition vacay --edition gcb as a repeat, not a silent "first wins"', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'og-repeated-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-rasters.mjs', import.meta.url)),
          '--edition',
          'vacay',
          '--edition',
          'gcb',
          '--allow-foreign-platform',
          // Belt-and-suspenders against the committed pictures: this refusal
          // must fire before `main` ever computes a destination, but if that
          // guard ever regressed, `--out` keeps a real render confined to
          // this disposable tmpdir instead of `plans/og-images/`.
          '--out',
          cwd,
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toContain('render-share-rasters.mjs: --edition was passed more than once.');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses --edition gcb --edition as a repeat or a missing value, but never renders', () => {
    // The finding's second half: a trailing bare `--edition` used to bypass
    // the missing-value guard, because `unknownOptions` had already accepted
    // both occurrences of a known flag. Either refusal reason is acceptable
    // here — "repeated" or "needs an Edition id" — what matters is that
    // nothing is written and nothing rendered.
    const cwd = mkdtempSync(join(tmpdir(), 'og-repeated-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-rasters.mjs', import.meta.url)),
          '--edition',
          'gcb',
          '--edition',
          '--allow-foreign-platform',
          // See the belt-and-suspenders note above: confines a regressed
          // guard's render to this tmpdir instead of `plans/og-images/`.
          '--out',
          cwd,
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toMatch(/passed more than once|needs an Edition id/);
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('still lets a single --edition through the repeat guard', () => {
    // Paired with a nonexistent Edition id so the run fails fast at the
    // Edition-validity check further down `main` — past both the
    // unknown-option and repeated-option guards — without launching
    // Chromium. If the repeat guard ever false-positived on a single
    // occurrence, this test would fail here instead of at the Edition check.
    const cwd = mkdtempSync(join(tmpdir(), 'og-repeated-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-rasters.mjs', import.meta.url)),
          '--edition',
          'not-an-edition',
          '--allow-foreign-platform',
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).not.toContain('passed more than once');
      expect(result.stderr).toContain('Unknown edition "not-an-edition"');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('render-share-footer.mjs repeat guard (#887, finding 4075112554): the footer CLI shares FOOTER_OPTIONS with the raster CLI and must refuse its own repeats', () => {
  // Both Edition ids below are deliberately fake. The raster CLI's own
  // repeat-guard tests above pass a real `--out` as a belt-and-suspenders
  // fallback, so a regressed guard's render lands in a disposable tmpdir
  // instead of `plans/og-images/`; this CLI takes no `--out` at all (see its
  // header: "there is no --out … a band repaint of a card somewhere else is
  // not a thing anyone wants"), so an unknown Edition id has to be the safety
  // net instead — if `assertNoRepeatedOptions` were ever missing from `main`
  // again, `optionValue` would resolve to one of these bogus ids and the
  // "Unknown edition" check several lines later would still stop the run
  // before `loadEditions`, Playwright or the committed pictures are touched.
  it('refuses a repeated --edition, not a silent "first wins"', () => {
    // The finding's first half, reproduced on the footer CLI: only the raster
    // CLI had ever been made to call `assertNoRepeatedOptions`, so this CLI's
    // own `--edition vacay --edition gcb` used to reach `optionValue` (which
    // reads only the first occurrence) and repaint Vacay's footer.
    const cwd = mkdtempSync(join(tmpdir(), 'og-footer-repeated-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-footer.mjs', import.meta.url)),
          '--edition',
          'not-an-edition',
          '--edition',
          'also-not-an-edition',
          '--allow-foreign-platform',
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toContain('render-share-footer.mjs: --edition was passed more than once.');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses a trailing bare --edition as a repeat or a missing value, but never renders', () => {
    // The finding's second half: a trailing bare `--edition` used to bypass
    // the missing-value guard on this CLI too, because `unknownOptions`
    // accepts every occurrence of a known flag. Either refusal reason is
    // acceptable — what matters is that nothing is written and nothing
    // rendered.
    const cwd = mkdtempSync(join(tmpdir(), 'og-footer-repeated-option-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./render-share-footer.mjs', import.meta.url)),
          '--edition',
          'not-an-edition',
          '--edition',
          '--allow-foreign-platform',
        ],
        { cwd, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.stderr).toMatch(/passed more than once|needs an Edition id/);
      expect(result.stdout).toBe('');
      expect(result.status).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('--all combined with --edition (#1264): both share-card CLIs refuse the pair instead of rendering one Edition', () => {
  // Both selectors used to pass validation and `main` preferred `--edition`,
  // so `--all --edition gcb` published GCB alone although the operator asked
  // for the full set. The Edition id below is deliberately fake, and the
  // raster CLI also gets a disposable `--out` plus `--check`, so a regressed
  // guard is still stopped by the `Unknown edition` check before anything is
  // loaded, rendered or written — which is why the assertions name the
  // selector refusal rather than accepting any exit 1.
  const cases = [
    ['render-share-rasters.mjs', (cwd) => ['--out', join(cwd, 'out'), '--check']],
    ['render-share-footer.mjs', () => ['--check']],
  ];
  for (const [script, extra] of cases) {
    for (const order of [
      ['--all', '--edition', 'not-an-edition'],
      ['--edition', 'not-an-edition', '--all'],
    ]) {
      it(`${script} refuses ${order.join(' ')}`, () => {
        const cwd = mkdtempSync(join(tmpdir(), 'og-all-with-edition-'));
        try {
          const result = spawnSync(
            process.execPath,
            [
              fileURLToPath(new URL(`./${script}`, import.meta.url)),
              ...order,
              '--allow-foreign-platform',
              ...extra(cwd),
            ],
            { cwd, encoding: 'utf8', timeout: 60_000 },
          );
          expect(result.stderr).toContain(`${script}: --all and --edition are mutually exclusive.`);
          expect(result.stderr).not.toContain('Unknown edition');
          expect(result.stdout).toBe('');
          expect(result.status).toBe(1);
          expect(readdirSync(cwd)).toEqual([]);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });
    }
  }
});

describe('inspectCapture (#887, finding 4075112564): every capture is decoded before the overlay exemption applies', () => {
  it('refuses a truncated Vacay capture rather than exempting it straight to commit', async () => {
    // The finding: `assertCapturedCardFormat` proves only the fixed 33-byte
    // IHDR record, and `assertNoOverlay` used to return for an exempt
    // Edition without ever calling the decoder — so a capture that kept a
    // valid signature and IHDR but was truncated right after it (no IDAT, no
    // IEND) read as a conforming 600×750 truecolor card and would have
    // reached `commitStaged`. Truncating the real committed Vacay PNG to
    // exactly the IHDR record reproduces that: `inspectCapture` must now
    // decode it and refuse, because there is nothing past the header to
    // decode.
    const dest = seedCommitted('vacay');
    const truncated = conformingPng('vacay').subarray(0, 33);
    // Sanity on the fixture: still a conforming IHDR by itself, so this is
    // testing the decode gap and not a format-guard rejection.
    expect(readPngHeader(truncated)).toMatchObject({ width: 600, height: 750, bitDepth: 8, colorType: 2 });

    await expect(
      renderCardSet({
        ids: ['vacay'],
        destDir: dir,
        capture: captureWriting({ vacay: truncated }),
      }),
    ).rejects.toThrow(/vacay failed/);

    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: vacay`);
    expect(leftovers()).toEqual([]);
  });
});

describe('inspectCapture (#1264, #1266): a capture must be a complete PNG through IEND, with every CRC intact', () => {
  // The decode above proved the IDAT stream inflates, and nothing more: the
  // chunk loop stopped quietly at end-of-file, so the real committed GCB card
  // with its 12-byte IEND chunk cut off still inspected as a clean 600×750
  // capture, and so did one with a corrupted CRC.
  const IEND_LENGTH = 12;

  it.each(Object.keys(CARDS))('accepts the intact committed %s card', (id) => {
    expect(inspectCapture(id, 'unused', { read: () => conformingPng(id) })).toMatchObject({ width: 600, height: 750 });
  });

  it.each(Object.keys(CARDS))('refuses the committed %s card truncated after its last IDAT chunk', (id) => {
    const whole = conformingPng(id);
    expect(whole.toString('ascii', whole.length - 8, whole.length - 4)).toBe('IEND');
    const truncated = whole.subarray(0, whole.length - IEND_LENGTH);
    // The same bytes the committed-asset test (`src/recon-share-og.test.ts`)
    // decodes, through the same reader it calls.
    expect(() => readPngPixels(truncated)).toThrow(/no IEND chunk/);
    expect(() => inspectCapture(id, 'unused', { read: () => truncated })).toThrow(/no IEND chunk/);
  });

  it('refuses the committed GCB card with a corrupted chunk CRC', () => {
    const corrupt = Buffer.from(conformingPng('gcb'));
    // The last byte before IEND is the final IDAT chunk's CRC.
    corrupt[corrupt.length - IEND_LENGTH - 1] ^= 0xff;
    expect(() => inspectCapture('gcb', 'unused', { read: () => corrupt })).toThrow(/IDAT chunk .*CRC mismatch/);
  });

  it('keeps the truncated capture out of the committed tree', async () => {
    const dest = seedCommitted('gcb');
    const whole = conformingPng('gcb');
    await expect(
      renderCardSet({
        ids: ['gcb'],
        destDir: dir,
        capture: captureWriting({ gcb: whole.subarray(0, whole.length - IEND_LENGTH) }),
      }),
    ).rejects.toThrow(/gcb failed/);
    expect(readFileSync(dest, 'utf8')).toBe(`${STALE}: gcb`);
    expect(leftovers()).toEqual([]);
  });
});
