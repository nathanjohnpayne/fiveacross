// The #887 overlay guard, in one place: the cap, the boundary, the region
// measured, and which Editions are measured at all.
//
// WHY THIS EXISTS. The defect this ticket is named for is a foreign card
// composited over a committed one — a scaled Vacay artboard caught in shot
// over the upper-right corner of the GCB card, obscuring the wordmark line and
// half of FINAL STANDINGS. Expressed as a number a machine can check, that is
// "how much of the upper-right quadrant is near-white": the overlay scored
// 27.4% of it, while the clean dark-ground artboards score a few percent of
// thin antialiased ink.
//
// The check has two ends. `render-share-rasters.mjs` runs it on a fresh
// capture, while the capture is still staged, so a bad frame costs a re-run
// rather than the committed picture. `src/recon-share-og.test.ts` runs it on
// the files in the tree, so a bad frame that arrived some other way is caught
// by `npm test`. Both ends used to carry their own copy of the cap, their own
// copy of the quadrant, their own copy of the Vacay exemption — and, the
// defect that made this module (round 6, id 4058741654), their own idea of the
// boundary. The renderer rejected a share strictly ABOVE 0.12 and the recon
// test required one strictly BELOW it, so a capture landing exactly on 0.12
// (13,500 near-white pixels of the quadrant's 112,500) was published by a run
// that reported success and then failed `npm test` immediately, with the good
// picture already replaced.
//
// Nothing here restates a number the other end also spells out. There is one
// cap, one predicate, one quadrant rule and one exemption list, and both ends
// import them.
import { lightPixelShare } from './png-pixels.mjs';

/**
 * Upper-right quadrant near-white share AT OR ABOVE which a dark-ground card
 * is carrying something that is not the card.
 *
 * Calibrated, not guessed: the overlaid Vacay card scored 27.4% of that
 * quadrant, while the clean `so-long-farewell` and `fiveacross-slate` cards
 * score ~4%.
 */
export const MAX_DARK_CARD_LIGHT_SHARE = 0.12;

/** Editions whose card is light end to end, and so cannot be scored against a
 *  near-white threshold at all. Vacay's is cream from corner to corner: it
 *  would read as 100% overlaid and mean nothing. */
export const OVERLAY_EXEMPT_EDITIONS = Object.freeze(['vacay']);

/** True when this Edition's card is dark enough for the near-white reading to
 *  say anything. */
export function isScoredForOverlay(edition) {
  return !OVERLAY_EXEMPT_EDITIONS.includes(edition);
}

/**
 * The region the reading is taken over: the upper-right quadrant, where the
 * #887 overlay landed. Derived from the image rather than hardcoded to
 * 300×375, so a card that is ever rendered at another size measures the same
 * quarter of itself.
 */
export function overlayQuadrantOf(image) {
  return {
    x: Math.floor(image.width / 2),
    y: 0,
    width: image.width - Math.floor(image.width / 2),
    height: Math.floor(image.height / 2),
  };
}

/** The near-white share of that quadrant. */
export function overlayLightShare(image) {
  return lightPixelShare(image, overlayQuadrantOf(image));
}

/**
 * THE boundary. Inclusive, because the committed-file guard is exclusive: a
 * file is acceptable only when its share is strictly below the cap, so a
 * capture is refusable as soon as it reaches it. A renderer that accepted the
 * cap exactly would publish a file `npm test` rejects.
 */
export function isOverlaid(share) {
  return share >= MAX_DARK_CARD_LIGHT_SHARE;
}

/**
 * Throw if `id`'s card carries an overlay; return the measured share, or
 * `null` for an Edition that is not scored.
 *
 * `decode` is a thunk so a caller that has not already decoded the image can
 * defer that to here — but the exemption governs only the SCORING, not
 * whether the decode itself runs. It used to govern both: an exempt Edition's
 * pixels were never inflated at all, which let a truncated or corrupt capture
 * for that Edition reach `commitStaged` with nothing ever proving its IDAT
 * data was even present (#887, finding 4075112564). `render-share-rasters.mjs`
 * now decodes every capture before calling this, exempt or not, and passes
 * the already-decoded image back through the thunk; this function still skips
 * the SHARE calculation for an exempt Edition, because Vacay's card is cream
 * end to end and a near-white reading of it would mean nothing.
 */
export function assertNoOverlay(id, decode) {
  if (!isScoredForOverlay(id)) return null;
  const share = overlayLightShare(decode());
  if (isOverlaid(share)) {
    throw new Error(
      `render-share-rasters.mjs: ${id}'s upper-right quadrant is ${(share * 100).toFixed(1)}% near-white ` +
        `(cap ${(MAX_DARK_CARD_LIGHT_SHARE * 100).toFixed(0)}%, and the cap itself is refused) — something is ` +
        'composited over the card (#887).',
    );
  }
  return share;
}
