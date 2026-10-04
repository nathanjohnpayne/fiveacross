import { describe, it, expect } from 'vitest';
import { fitTextSize, shrinkToWholeWords } from './fitText';

// specs/d15-text-size.md: the auto-fit guard's measure-and-shrink primitive.
// The guard always wins over the S/M/L base — a long prompt at Large steps
// its font down until it fits; a short one is returned unshrunk at the base.

describe('fitTextSize', () => {
  it('returns the base size unshrunk for a short string that already fits', () => {
    const size = fitTextSize('Hi', { width: 60, height: 60 }, { baseSize: 14 });
    expect(size).toBe(14);
  });

  it('shrinks an oversized prompt below the base size, without going below the floor', () => {
    const longPrompt =
      'Got a stranger to take a photo of the entire group at the pool deck sail-away party';
    const size = fitTextSize(longPrompt, { width: 60, height: 60 }, { baseSize: 14 });
    expect(size).toBeLessThan(14);
    expect(size).toBeGreaterThanOrEqual(6); // default minSize floor
  });

  it('never shrinks past the configured minSize floor, even for a pathological prompt', () => {
    const veryLongPrompt = 'A'.repeat(500);
    const size = fitTextSize(veryLongPrompt, { width: 40, height: 40 }, { baseSize: 14, minSize: 8 });
    expect(size).toBe(8);
  });

  it('never exceeds baseSize — Large is a ceiling, never a guarantee', () => {
    const size = fitTextSize('short', { width: 200, height: 200 }, { baseSize: 16 });
    expect(size).toBeLessThanOrEqual(16);
  });

  it('is monotonic: a smaller box never yields a LARGER fitted size than a bigger box', () => {
    const prompt = 'Made a new friend at the welcome aboard mixer on the pool deck';
    const smallBoxSize = fitTextSize(prompt, { width: 50, height: 50 }, { baseSize: 14 });
    const bigBoxSize = fitTextSize(prompt, { width: 120, height: 120 }, { baseSize: 14 });
    expect(smallBoxSize).toBeLessThanOrEqual(bigBoxSize);
  });

  it('treats an unmeasured (zero-area) box as "not yet laid out" and returns the base size', () => {
    const size = fitTextSize('anything at all here', { width: 0, height: 0 }, { baseSize: 14 });
    expect(size).toBe(14);
  });

  it('treats empty/whitespace-only text as nothing to shrink for', () => {
    const size = fitTextSize('   ', { width: 40, height: 40 }, { baseSize: 14 });
    expect(size).toBe(14);
  });
});

// #1345: a Square must shrink to keep a long word whole rather than accept a
// mid-word break ("Grandparent / s"). The estimator treats a word that does
// not fit on one line as not fitting, and only falls back to the break when
// even the floor cannot hold the word.
describe('fitTextSize keeps words whole (#1345)', () => {
  const RATIO = 0.55; // matches the estimator's default charWidthRatio

  function wordFitsOnOneLine(word: string, width: number, size: number): boolean {
    return word.length <= Math.floor(width / (size * RATIO));
  }

  it('shrinks until the longest word fits on one line, even when the height would allow a mid-word break', () => {
    const width = 60;
    const size = fitTextSize('Grandparents on the dance floor', { width, height: 200 }, { baseSize: 14 });
    expect(size).toBeLessThan(14);
    expect(wordFitsOnOneLine('Grandparents', width, size)).toBe(true);
    // ...and it is the LARGEST such size, not an over-shrink.
    expect(wordFitsOnOneLine('Grandparents', width, size + 0.5)).toBe(false);
  });

  it('does not shrink a prompt whose longest word already fits whole at the base size', () => {
    const size = fitTextSize('Kissed a stranger', { width: 120, height: 120 }, { baseSize: 12 });
    expect(size).toBe(12);
  });

  it('falls back to the floor (accepting a break) only when even minSize cannot hold the word', () => {
    const size = fitTextSize('Supercalifragilistic', { width: 30, height: 200 }, { baseSize: 14, minSize: 8 });
    expect(size).toBe(8);
  });

  it('treats a wrapped whitespace-free CJK run as a legal break, not a word to keep whole', () => {
    // 12 ideographs: wider than one 60px line at 14px, but CSS breaks between
    // ideographs, so the tall box holds it at the base size unshrunk.
    const size = fitTextSize('在甲板上跳舞的祖父母们好', { width: 60, height: 200 }, { baseSize: 14 });
    expect(size).toBe(14);
  });

  it('treats a hyphen as a legal break: each hyphen-delimited segment only has to fit', () => {
    // "mother-in-law" (13 chars) is wider than one 60px line at 14px, but
    // "mother-" (7) fits, so the tall box holds it at the base size.
    const size = fitTextSize('mother-in-law', { width: 60, height: 200 }, { baseSize: 14 });
    expect(size).toBe(14);
  });

  it('with keepWordsWhole: false, fits on height alone (the upper bound SquareText verifies against real glyphs)', () => {
    const size = fitTextSize('Grandparents on the dance floor', { width: 60, height: 200 }, { baseSize: 14, keepWordsWhole: false });
    expect(size).toBe(14);
  });

  it('still keeps the Latin segment of a mixed-script token whole', () => {
    const width = 60;
    const size = fitTextSize('Grandparents漢', { width, height: 200 }, { baseSize: 14 });
    expect(size).toBeLessThan(14);
    expect(wordFitsOnOneLine('Grandparents', width, size)).toBe(true);
  });
});

describe('shrinkToWholeWords (#1345)', () => {
  it('returns the start size when nothing overflows', () => {
    expect(shrinkToWholeWords(12, () => false)).toBe(12);
  });

  it('steps down until the overflow check clears and returns that size', () => {
    expect(shrinkToWholeWords(12, (size) => size > 9)).toBe(9);
  });

  it('bottoms out at minSize when every size overflows', () => {
    expect(shrinkToWholeWords(12, () => true, { minSize: 7 })).toBe(7);
  });

  it('never goes below a start size that is already under minSize', () => {
    expect(shrinkToWholeWords(5, () => true, { minSize: 7 })).toBe(5);
  });
});
