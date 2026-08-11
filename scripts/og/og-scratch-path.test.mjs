// @vitest-environment node
//
// `npm test` runs jsdom-only (vite.config.ts: "npm test never needs ... a
// browser"), so this cannot boot a real Chromium page and call
// `page.screenshot()` — but it can, and does, assert on the EXACT call shape
// `render-og-editions.mjs` passes to it (`screenshotOptionsFor`), imported
// from production code rather than re-typed. That closes the #713 coverage
// hole one level up from a live browser call: a regression to either half of
// the fix — the scratch path losing its image extension, or the explicit
// `type: 'png'` being dropped — fails a test here, rather than only
// surfacing at render time the way #713 did.
import { describe, expect, it } from 'vitest';
import { scratchPathFor, screenshotOptionsFor } from './og-scratch-path.mjs';

describe('scratchPathFor (#713)', () => {
  it('ends in a Playwright-recognised image extension', () => {
    // The regression: the scratch path used to end in `.render-tmp`, which
    // Playwright's `page.screenshot({ path })` does not recognise, so it
    // threw before ever writing the scratch file. This pins the fix at the
    // level closest to the bug — the path shape itself.
    expect(scratchPathFor('/repo/public/og-gcb.png')).toMatch(/\.png$/);
  });

  it('stays adjacent to, and derived from, the destination path', () => {
    expect(scratchPathFor('/repo/public/og-gcb.png')).toBe('/repo/public/og-gcb.png.render-tmp.png');
  });

  it('is unique per edition file so concurrent stages cannot collide', () => {
    const a = scratchPathFor('/repo/public/og-gcb.png');
    const b = scratchPathFor('/repo/public/og-vacay.png');
    expect(a).not.toBe(b);
  });
});

describe('screenshotOptionsFor (#713)', () => {
  it('passes the scratch path through unchanged', () => {
    expect(screenshotOptionsFor('/repo/public/og-gcb.png').path).toBe(scratchPathFor('/repo/public/og-gcb.png'));
  });

  it('explicitly passes type: "png" — belt-and-braces alongside the extension', () => {
    // Playwright infers the screenshot format from the path's extension and
    // throws for anything it does not recognise, UNLESS `type` overrides it.
    // Pinning this means the render survives even a future edit that
    // reintroduces an extension-less or misnamed scratch path.
    expect(screenshotOptionsFor('/repo/public/og-gcb.png').type).toBe('png');
  });
});
