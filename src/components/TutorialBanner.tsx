import { useState } from 'react';
import type { DayDef } from '../types';
import { editionBrand } from '../editions';

/**
 * The embark/farewell tutorial banners (daily-cards-spec §§ "Embark
 * (tutorial) view" / "Farewell view", specs/d15-tutorial-banners.md). Board
 * mounts this ONE component above the grid, gated on the viewed Day's
 * `tutorial` flag; it renders nothing for any of the eight main Days. Which
 * of the two banners shows is read off `day.pool` (`'embark'` |
 * `'farewell'`) rather than `day.index`, so the banner tracks the seeded
 * data (#207's `DAYS`) instead of assuming the tutorial Days sit at fixed
 * positions.
 *
 * Deliberately distinct from the first-open coach overlay (#214, not yet
 * landed): that overlay only decodes the badge notation (Tally count, 👀
 * Doubt badge, ＋ add-proof, free space); this banner carries the game's
 * narrative. They complement rather than repeat, per the spec's "First-open
 * coach overlay" section — this ticket does not touch that overlay.
 */

const EMBARK_BEATS: readonly string[] = [
  'Mark what happens. Tap a square when you see it, do it, or survive it.',
  "Five in a row is BINGO. The center is free. Blackout the card if you're ambitious.",
  'The feed is the proof. Attach a pic, doubt a friend, watch the Moments roll in.',
];

// Whole-string per Edition (#608), not a token: "all on the ship" has no
// occasion-neutral skeleton — "all on the event" is not English.
const embarkCaption = (): string => editionBrand().tutorialWarmupNote;

const FAREWELL_COPY = 'Last one. Mark your goodbyes—then go book next year.';

/**
 * The Welcome Aboard Day's three-beat "How this works" banner. Dismissible
 * via a dedicated dismiss button — collapses for the rest of the session
 * (session-scoped per the spec: "dismissal here does not need to persist
 * beyond the session the way the coach overlay's does"), since it is
 * replayable later from More → How to play (#208). Plain component state,
 * not localStorage — a full page reload starts a fresh session. The
 * dismissed flag lives in the parent `TutorialBanner` (not here) so it
 * survives this component unmounting/remounting as the Day switcher moves
 * away from and back to the Welcome Aboard Day within the same session.
 *
 * The content is static readable text, not folded into the dismiss
 * control's accessible name — a `role="button"` wrapping the beats/caption
 * would replace them with just the button's `aria-label` for assistive
 * tech, hiding the very copy the banner exists to convey.
 */
function EmbarkBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="tutorial-banner tutorial-banner-embark">
      <button
        type="button"
        className="tutorial-banner-dismiss"
        aria-label="Dismiss How this works banner"
        onClick={onDismiss}
      >
        ×
      </button>
      <p className="tutorial-banner-title">How this works</p>
      <ol className="tutorial-banner-beats">
        {EMBARK_BEATS.map((beat) => (
          <li key={beat}>{beat}</li>
        ))}
      </ol>
      <p className="tutorial-banner-caption">{embarkCaption()}</p>
    </div>
  );
}

/**
 * The So Long, Farewell Day's goodbye banner. NOT dismissible (spec: "the
 * ceremonial close of the cruise, not a tutorial to get out of the way") —
 * no dismiss affordance, no state. Sits below wherever the podium banner
 * mounts (#217's content — this ticket owns only the goodbye copy).
 */
function FarewellBanner() {
  return (
    <div className="tutorial-banner tutorial-banner-farewell" role="note">
      <p className="tutorial-banner-copy">{FAREWELL_COPY}</p>
    </div>
  );
}

/**
 * The Welcome Aboard walkthrough as reusable content (#270): More → "How to
 * play" replays THIS (the game's narrative) above its badge-legend replay
 * button — the spec's How-to-play row names the walkthrough banner, and the
 * coach overlay only decodes the notation. Same beats/caption constants as
 * the embark banner, no dismiss chrome.
 */
export function WalkthroughContent() {
  return (
    <div className="walkthrough-content">
      <p className="tutorial-banner-title">How this works</p>
      <ol className="tutorial-banner-beats">
        {EMBARK_BEATS.map((beat) => (
          <li key={beat}>{beat}</li>
        ))}
      </ol>
      <p className="tutorial-banner-caption">{embarkCaption()}</p>
    </div>
  );
}

export default function TutorialBanner({ day }: { day: DayDef }) {
  // Owned here (not in EmbarkBanner) so the dismissal survives the Day
  // switcher moving away from and back to the Welcome Aboard Day within
  // the same session — Board mounts this component at a stable JSX
  // position across Day switches, so its state persists even though
  // EmbarkBanner itself unmounts whenever the viewed Day isn't 'embark'.
  const [embarkDismissed, setEmbarkDismissed] = useState(false);
  if (!day.tutorial) return null;
  if (day.pool === 'embark') {
    if (embarkDismissed) return null;
    return <EmbarkBanner onDismiss={() => setEmbarkDismissed(true)} />;
  }
  if (day.pool === 'farewell') return <FarewellBanner />;
  return null;
}

/**
 * The tutorial-Day tag (daily-cards-spec § "Embark (tutorial) view": "Tutorial
 * days show a 'Warm-up' tag on the day chip and board header in place of
 * daily-honor competitiveness"; the farewell Day wears "Goodbye" per the
 * wireframes' Day-10 frame, #260). One shared bit of markup for both mount
 * points (DaySwitcher's chip, Board's daybar) so the two never drift. #212
 * owns the daily-honor pin the eight main Days show in this same slot —
 * this component only renders on the two tutorial Days, so it structurally
 * cannot collide with that pin (mutually exclusive on `tutorial`).
 */
export function tutorialTagLabel(pool: DayDef['pool']): string {
  return pool === 'farewell' ? 'Goodbye' : 'Warm-up';
}

export function TutorialTag({ pool, className }: { pool: DayDef['pool']; className?: string }) {
  const label = tutorialTagLabel(pool);
  return (
    <span className={`warm-up-tag${className ? ` ${className}` : ''}`} aria-label={`${label} day`}>
      {label}
    </span>
  );
}
