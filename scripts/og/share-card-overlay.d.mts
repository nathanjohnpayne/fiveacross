// Types for the #887 overlay guard, so `src/**` tests can import it under the
// app's TypeScript program — the same arrangement `png-pixels.d.mts` and
// `og-edition-art.d.mts` make for the modules next door.
//
// `src/recon-share-og.test.ts` is the second caller by design: the cap, the
// boundary, the quadrant and the Vacay exemption are shared with the renderer
// rather than restated, because a committed-file guard and a capture guard
// that disagree about any of them let a run publish a file the suite then
// rejects.

import type { PngImage, PngRect } from './png-pixels.d.mts';

export const MAX_DARK_CARD_LIGHT_SHARE: number;
export const OVERLAY_EXEMPT_EDITIONS: readonly string[];

export function isScoredForOverlay(edition: string): boolean;
export function overlayQuadrantOf(image: PngImage): PngRect;
export function overlayLightShare(image: PngImage): number;
/** Inclusive: the cap itself counts as overlaid. */
export function isOverlaid(share: number): boolean;
export function assertNoOverlay(id: string, decode: () => PngImage): number | null;
