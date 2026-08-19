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
// Per-Edition treatment is data, not branching (#647, extended #881): every
// Edition's Join gate now stamps this card, but not the same way. vacay's
// brand row sets `signinCardVariant: 'postcard'` — a DYNAMIC stamp, the
// previewed Day's own emoji. gcb and fiveacross instead set a fixed
// `signinStampGlyph` (🏳️‍🌈, 💒) — a static per-Edition mark unrelated to
// whichever Day is showing.
//
// The dynamic stamp's postage is the previewed Day's emoji, and it exists
// only when that emoji does (#776). It shipped three times as a bordered CSS
// `::after` with `content: ''` — a box whose content path did not exist, so
// the frame always drew and the postage never did. An empty dashed rectangle
// is now unreachable rather than merely unlikely: no emoji resolves (the
// COMMON case — Bodega seeds one on Day 1 only, and after the last Day no Day
// resolves at all) → no element, and the card drops the right padding it
// reserves for the corner so the copy reclaims the full width. The fixed
// stamp has no such gap — it doesn't depend on the Day, so it is always there
// once the brand sets it.
//
// The Day's OWN glyph appears exactly ONCE. The Day line has always led with
// it, so a dynamic stamp that repeats it would print the same glyph twice on
// one small card; when the corner takes it the line gives it up
// (`emojiPlacement: 'stamp'`) and keeps the Day named in words. A fixed brand
// mark is a DIFFERENT glyph, never a copy of the Day's, so it never triggers
// that trade — the line keeps leading with its own emoji exactly as it did
// before either kind of stamp existed.
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
  const brand = editionBrand();
  // ONE timestamp for both reads (Codex P3, round 2). Letting each helper take
  // its own `Date.now()` makes the single-Day selection atomic only in the
  // common case: a render that straddles local midnight could stamp the old
  // Day's emoji beside the new Day's line, or suppress the new Day's emoji on
  // the strength of the old Day's postage — and the card would hold that
  // mismatch until some later render. The seam is only as good as its callers.
  const now = Date.now();
  // The DYNAMIC stamp (vacay's postcard variant only) — see the file-top note
  // on the two postage kinds.
  const dayPostage = brand.signinCardVariant === 'postcard' ? previewDayEmoji(preview.days, now) : null;
  // A fixed brand mark wins when the Edition sets one; otherwise fall back to
  // the dynamic Day postage, which is null on an Edition with neither.
  const postage = brand.signinStampGlyph ?? dayPostage;
  // The postcard's tightened corner radius: on for vacay's variant even on a
  // render where no Day postage resolves (#776's gap was the STAMP silently
  // disappearing, not the corner), or whenever a fixed mark is configured —
  // which, unlike the dynamic kind, is always present once set.
  const stamped = brand.signinCardVariant === 'postcard' || brand.signinStampGlyph != null;
  // Only the DYNAMIC stamp repeats a glyph the Day line already shows, so
  // only it makes the line give up its own copy.
  const meta = previewMetaLine(preview, now, dayPostage ? 'stamp' : 'inline');
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
