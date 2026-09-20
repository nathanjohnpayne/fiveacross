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
import {
  CARDS,
  DISPLAY_FACE_STACK,
  REQUIRED_DISPLAY_FACE,
  assertDisplayFace,
  renderCardSet,
  resolvedDisplayFace,
} from './render-share-rasters.mjs';

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
