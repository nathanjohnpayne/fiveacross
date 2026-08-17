import { useEffect, useReducer, useSyncExternalStore } from 'react';
import {
  activeEventPreview,
  previewDayEmoji,
  previewMetaLine,
  subscribeEventPreview,
} from '../eventPreview';
import { editionBrand } from '../editions';

// The sign-in gate's Event-preview card (#647, wireframes § "Join—the
// postcard, not the casino"): the Event's name, its "Aug 7–9 · hosted by Kim ·
// 🐦 Day 1: …" line, and the serving hostname, between the wordmark lockup and
// the CTA.
//
// Reads ONLY resolved pre-auth state. `events/{eventId}` requires `signedIn()`
// (the same constraint that put the wordmark in `editions.ts`), so everything
// here comes from the `preview` slice of the world-readable `hostnames/{host}`
// document. On a hostname-resolved build `bootstrapEventResolution` installs
// it before mount; on an ENV-PINNED build — the deployed Bodega shape, where
// resolution's env short-circuit reads no routing document at all — it arrives
// from the cached envelope at bootstrap or from `watchAdultContent`'s live
// snapshot a beat AFTER first paint, which is why this reads the store through
// `useSyncExternalStore` rather than a plain call: the card has to appear when
// the slice lands, not on the next unrelated render (the production defect
// behind this wiring). No preview — a document seeded before #647, an origin
// with no routing document, a not-found path that never mounts this gate at
// all — renders NOTHING, exactly the pre-#647 screen; the card must degrade to
// absence, never to a frame of blanks.
//
// The Day line is COMPUTED from the seeded schedule at render time
// (`previewMetaLine` → `previewDayLine`), never stored as a display string:
// the wireframe frame's own literal Day-1 copy predates the #637 title trim,
// which is exactly the staleness a baked line would ship.
//
// Per-Edition treatment is data, not branching: vacay's brand row sets
// `signinCardVariant: 'postcard'`, which draws the dashed stamp corner; gcb
// and fiveacross render the same card as a plain panel (their Join frames'
// `.banner`).
//
// The stamp's POSTAGE is the previewed Day's emoji, and the stamp exists only
// when that emoji does (#776). It shipped three times as a bordered CSS
// `::after` with `content: ''` — a box whose content path did not exist, so
// the frame always drew and the postage never did. An empty dashed rectangle
// is now unreachable rather than merely unlikely: no emoji resolves (the
// COMMON case — Bodega seeds one on Day 1 only, and after the last Day no Day
// resolves at all) → no element, and the card drops the right padding it
// reserves for the corner so the copy reclaims the full width.
//
// The glyph appears exactly ONCE. The Day line has always led with the Day's
// emoji, so a stamp that repeats it prints the same glyph twice on one small
// card; when the corner takes the postage the line gives it up
// (`emojiPlacement: 'stamp'`) and keeps the Day named in words. With no stamp
// — no postage, or an Edition with no postcard variant — the line leads with
// the emoji exactly as it did before the stamp existed.
export default function EventPostcard() {
  const preview = useSyncExternalStore(subscribeEventPreview, activeEventPreview, activeEventPreview);
  // "Live" has to survive the gate being LEFT OPEN (Codex P2 round 1): the Day
  // line is computed from the local date, so a phone sitting on this screen
  // across midnight would otherwise keep yesterday's Day until some unrelated
  // render. Re-render at each local date boundary while mounted. The +250ms
  // lands the tick safely past the boundary, and the timer re-arms itself so a
  // gate open across several days keeps advancing. Cheap enough not to gate on
  // `preview?.days` — hooks must run unconditionally anyway, and one timeout a
  // day is free.
  const [, dateTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      timer = setTimeout(
        () => {
          dateTick();
          arm();
        },
        Math.max(nextMidnight - now.getTime(), 1000) + 250,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  if (!preview) return null;
  const stamped = editionBrand().signinCardVariant === 'postcard';
  // ONE timestamp for both reads (Codex P3, round 2). Letting each helper take
  // its own `Date.now()` makes the single-Day selection atomic only in the
  // common case: a render that straddles local midnight could stamp the old
  // Day's emoji beside the new Day's line, or suppress the new Day's emoji on
  // the strength of the old Day's postage — and the card would hold that
  // mismatch until some later render. The seam is only as good as its callers.
  const now = Date.now();
  const postage = stamped ? previewDayEmoji(preview.days, now) : null;
  // The Day's emoji is drawn ONCE. When the corner takes it, the Day line
  // gives it up; with no stamp — no postage, or an Edition with no postcard
  // variant — the line keeps leading with it exactly as it always has.
  const meta = previewMetaLine(preview, now, postage ? 'stamp' : 'inline');
  const host = typeof window === 'undefined' ? null : window.location.hostname;
  return (
    <div
      className={`event-postcard${stamped ? ' event-postcard-stamped' : ''}${
        postage ? ' event-postcard-franked' : ''
      }`}
    >
      {/* Decorative: the Day line below still NAMES the Day in words ("Day 1:
          The Birds Have Entered the Chat"), so hiding the glyph costs a
          screen reader nothing — it is postage, not information. */}
      {postage && (
        <span className="event-postcard-stamp" aria-hidden="true">
          {postage}
        </span>
      )}
      <b className="event-postcard-name">{preview.eventName}</b>
      {meta && <span className="event-postcard-meta">{meta}</span>}
      {/* The ENTRY hostname, same identity rule as share links (#607): the
          card names the address the guest is actually standing on, which every
          serving host brands correctly, not the analytics-canonical one. */}
      {host && <span className="event-postcard-host">{host}</span>}
    </div>
  );
}
