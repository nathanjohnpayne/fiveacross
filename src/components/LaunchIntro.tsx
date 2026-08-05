import { useState, type ReactNode } from 'react';
import { Shuffle } from 'lucide-react';
import { editionLexicon } from '../editions';

/**
 * The one-time launch announcement for Reshuffle (#378,
 * plans/daily-cards-wireframes.html #frame-launch-intro).
 *
 * A launch beat, NOT a tutorial: it fires once, on the first open after the
 * feature deploys, and is replayable nowhere. That is the deliberate difference
 * from `CoachOverlay`, which this borrows its whole shape from — the coach
 * overlay explains the card and therefore earns a More → "How to play" replay
 * entry, while this one announces a change to players who were already mid-cruise
 * when it shipped. Once seen, it has done its job; a permanent replay affordance
 * for "new today" would be stale by Day 4.
 *
 * The storage key is the ticket's (`gcb.seen.reshuffleIntro`) rather than this
 * repo's prevailing `gcb.<feature>.dismissedAt` shape. Kept as specified so the
 * spec, the test, and the deployed key cannot drift from each other; the
 * divergence is called out in the PR as an observation rather than silently
 * "corrected" here.
 */
const SEEN_KEY = 'gcb.seen.reshuffleIntro';

// try/catch — private-mode/storage-unavailable falls open (hasSeen → false;
// markSeen a no-op), the same posture as CoachOverlay's key. Falling open means
// a storage-less browser sees the announcement on every load, which is the
// tolerable direction: annoying beats invisible for a one-time launch beat.
function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {
    /* nothing to persist */
  }
}

type Beat = { key: string; chip: ReactNode; chipVariant: string; copy: ReactNode };

// A FUNCTION, not a module-scope constant (#608, Codex P2 on #615). The
// resolved Edition is installed by `bootstrapEventResolution` before React
// mounts but AFTER this module is imported, so a `const BEATS = [...]` built at
// import time captures the default `gcb` lexicon and says "the whole cruise"
// forever — on every hostname-resolved Vacay or Five Across host. Building the
// beats per render is the same discipline every other Edition call site here
// follows; the list is three items long, so there is nothing to memoise.
const beats = (): Beat[] => [
  {
    key: 'trade',
    chip: <Shuffle aria-hidden="true" className="launch-intro-icon" />,
    chipVariant: 'plus',
    copy: <>Dealt a dud? Tap the shuffle chip on your card to trade it for a fresh one before you start marking.</>,
  },
  {
    key: 'three',
    chip: '!',
    chipVariant: 'warn',
    copy: (
      <>
        <b>Three for the whole {editionLexicon().occasion}</b>—spend them wisely. A reshuffle never comes
        back.
      </>
    ),
  },
  {
    key: 'pristine',
    chip: '✓',
    chipVariant: 'free',
    copy: <>Only before you mark: the moment you tap a square, the card's yours for the day.</>,
  },
];

export type LaunchIntroProps = {
  /** Test seam: render regardless of the stored flag. Dismissing still writes it. */
  forceOpen?: boolean;
  onDismiss?: () => void;
};

export default function LaunchIntro({ forceOpen = false, onDismiss }: LaunchIntroProps) {
  // `hasSeen()` is read during render (not in an effect), so the write alone
  // would not re-render — this mirrors CoachOverlay's `dismissedThisMount`.
  const [seenThisMount, setSeenThisMount] = useState(false);

  if (seenThisMount) return null;
  if (!forceOpen && hasSeen()) return null;

  const handleDismiss = () => {
    markSeen();
    setSeenThisMount(true);
    onDismiss?.();
  };

  // Deliberately NOT `.coach-overlay` on the container, despite borrowing that
  // overlay's shape: `.coach-overlay` is CoachOverlay's IDENTITY, and the e2e
  // parity walk asserts that overlay is gone after its CTA. Wearing the class
  // here made this announcement answer to that selector and fail the assertion.
  // Neither `.coach-overlay` nor `.coach-overlay-backdrop` carries any CSS (the
  // look comes from `.sheet`/`.sheet-backdrop`), so dropping them costs nothing
  // visually. The `coach-overlay-legend/row/chip/copy` classes below DO carry the
  // legend's styling and are shared on purpose — they are a visual vocabulary,
  // not an identity.
  return (
    <div className="sheet-backdrop launch-intro-backdrop">
      <div
        className="sheet launch-intro"
        role="dialog"
        aria-modal="true"
        aria-label="New today: reshuffles"
      >
        <p className="sheet-title">🆕 New today: reshuffles</p>
        <ul className="coach-overlay-legend">
          {beats().map((beat) => (
            <li key={beat.key} className="coach-overlay-row">
              <span
                className={`coach-overlay-chip coach-overlay-chip-${beat.chipVariant}`}
                aria-hidden="true"
              >
                {beat.chip}
              </span>
              <span className="coach-overlay-text">
                <span className="coach-overlay-copy">{beat.copy}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="sheet-actions">
          <button
            type="button"
            className="btn primary block coach-overlay-cta"
            onClick={handleDismiss}
          >
            Nice—let's play
          </button>
        </div>
      </div>
    </div>
  );
}
