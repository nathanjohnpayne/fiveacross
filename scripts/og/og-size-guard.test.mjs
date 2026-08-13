// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertWithinHardCap } from './og-size-guard.mjs';

describe('assertWithinHardCap (#699)', () => {
  it('passes through a render within the hard cap', () => {
    expect(() => assertWithinHardCap('gcb', 500 * 1024, 600 * 1024)).not.toThrow();
  });

  it('passes through a render exactly at the hard cap', () => {
    expect(() => assertWithinHardCap('gcb', 600 * 1024, 600 * 1024)).not.toThrow();
  });

  it('throws — without writing anything — when the final render is still over budget', () => {
    // The regression this guards: pngquant missing or failing must not let an
    // over-budget PNG through with only a console warning. The caller (see
    // render-og-editions.mjs) is required to check this BEFORE it touches the
    // committed destination or the wireframes mirror, so a throw here is the
    // only signal that matters — there is no partial-success return value to
    // silently ignore.
    expect(() => assertWithinHardCap('vacay', 612 * 1024, 600 * 1024)).toThrow(
      /refusing to replace the committed vacay render/,
    );
  });

  it('names the Edition and both sizes in the failure so it is actionable from CI logs', () => {
    expect(() => assertWithinHardCap('fiveacross', 700 * 1024, 600 * 1024)).toThrow(
      /700 KB exceeds the 600 KB WhatsApp og:image hard cap/,
    );
  });
});
