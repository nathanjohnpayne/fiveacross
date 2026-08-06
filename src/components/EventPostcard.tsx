import { useEffect, useReducer } from 'react';
import { activeEventPreview, previewMetaLine } from '../eventPreview';
import { editionBrand } from '../editions';

// The sign-in gate's Event-preview card (#647, wireframes § "Join—the
// postcard, not the casino"): the Event's name, its "Aug 7–9 · hosted by Kim ·
// 🐦 Day 1: …" line, and the serving hostname, between the wordmark lockup and
// the CTA.
//
// Reads ONLY resolved pre-auth state. `events/{eventId}` requires `signedIn()`
// (the same constraint that put the wordmark in `editions.ts`), so everything
// here comes from the `preview` slice of the world-readable `hostnames/{host}`
// document, installed by `bootstrapEventResolution` before mount. No preview —
// a single-Event build, a document seeded before #647, a not-found path that
// never mounts this gate at all — renders NOTHING, exactly the pre-#647
// screen; the card must degrade to absence, never to a frame of blanks.
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
export default function EventPostcard() {
  const preview = activeEventPreview();
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
  const meta = previewMetaLine(preview);
  const host = typeof window === 'undefined' ? null : window.location.hostname;
  return (
    <div className={`event-postcard${stamped ? ' event-postcard-stamped' : ''}`}>
      <b className="event-postcard-name">{preview.eventName}</b>
      {meta && <span className="event-postcard-meta">{meta}</span>}
      {/* The ENTRY hostname, same identity rule as share links (#607): the
          card names the address the guest is actually standing on, which every
          serving host brands correctly, not the analytics-canonical one. */}
      {host && <span className="event-postcard-host">{host}</span>}
    </div>
  );
}
