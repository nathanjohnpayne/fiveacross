import { useState } from 'react';
import { EVENT_ID } from '../firebase';

/**
 * First-open coach overlay (specs/d15-coach-overlay.md, #214): a once-per-
 * Event scrim decoding the Board's badge notation — Tally count, 👀 Doubt
 * badge, ＋ add-proof, free space. Narrower than the Welcome Aboard banner
 * (#213), which carries the game's rules; this only decodes notation.
 * `Board` mounts it unconditionally whenever it has cells — per-Event (not
 * per-Day) gating alone shows it over the Player's first dealt card.
 */

const dismissKey = (eventId: string): string => `gcb.coachOverlay.${eventId}.dismissedAt`;
const dismissedEventsThisSession = new Set<string>();

// try/catch — private-mode/storage-unavailable falls open on the first visit,
// but a successful dismissal still lasts for this session. The Event-keyed
// memory fallback survives Board's A→B→A keyed remount without letting A's
// dismissal suppress B's own first-open coach.
function isDismissed(eventId: string): boolean {
  if (dismissedEventsThisSession.has(eventId)) return true;
  try {
    const dismissed = localStorage.getItem(dismissKey(eventId)) !== null;
    if (dismissed) dismissedEventsThisSession.add(eventId);
    return dismissed;
  } catch {
    return false;
  }
}
function markDismissed(eventId: string): void {
  dismissedEventsThisSession.add(eventId);
  try {
    localStorage.setItem(dismissKey(eventId), String(Date.now()));
  } catch {
    /* the session fallback above remains authoritative for this tab */
  }
}

/** Test-only. */
export function __resetCoachOverlayDismissalsForTests(): void {
  dismissedEventsThisSession.clear();
}

/**
 * Whether this Event's coach overlay has already been dismissed — exported so a
 * LATER overlay can queue behind it rather than stack on top of it (#378's
 * LaunchIntro is the first such case). Both render the same `sheet-backdrop`
 * scrim, so a Player who joins mid-cruise — a first dealt card AND an unseen
 * launch announcement at once — would otherwise get two overlapping scrims and
 * two CTAs. The key stays owned here rather than being read from the outside.
 */
export function isCoachOverlayDismissed(eventId: string = EVENT_ID): boolean {
  return isDismissed(eventId);
}

// Each row leads with a SAMPLE chip drawn in the badge's own board styling
// (the wireframes' `lgdchip` treatment) — the legend teaches the notation by
// showing it, not just naming it.
const LEGEND: readonly { chip: string; chipVariant: 'badge' | 'plus' | 'free'; label: string; copy: string }[] = [
  { chip: '4', chipVariant: 'badge', label: 'Tally count', copy: 'The number on a marked square is how many players got it too—tap it to see who.' },
  { chip: '👀 2', chipVariant: 'badge', label: 'Doubt badge', copy: "Means someone wants proof. Attach a photo to clear it—a Doubt never unmarks your square, it's never a gate." },
  { chip: '＋', chipVariant: 'plus', label: 'Add proof', copy: 'Tap the plus on any marked square to attach a pic and back it up.' },
  { chip: 'FREE', chipVariant: 'free', label: 'Free space', copy: 'The center square is free—already marked for everyone.' },
];

export type CoachOverlayProps = {
  /** Defaults to the real Event id; overridable so tests avoid the real key. */
  eventId?: string;
  /** Replay mode (More → How to play, #208): always renders regardless of
   *  the stored dismissal (replaying isn't "already seen it" bookkeeping);
   *  dismissing a replay still writes the stored timestamp. */
  forceOpen?: boolean;
  onDismiss?: () => void;
};

export default function CoachOverlay({ eventId = EVENT_ID, forceOpen = false, onDismiss }: CoachOverlayProps) {
  const [dismissedThisMount, setDismissedThisMount] = useState(false);

  if (dismissedThisMount) return null;
  if (!forceOpen && isDismissed(eventId)) return null;

  const handleDismiss = () => {
    markDismissed(eventId);
    setDismissedThisMount(true);
    onDismiss?.();
  };

  return (
    <div className="sheet-backdrop coach-overlay-backdrop">
      <div className="sheet coach-overlay" role="dialog" aria-modal="true" aria-label="How to read your card">
        <p className="sheet-title">How to read your card</p>
        <ul className="coach-overlay-legend">
          {LEGEND.map((row) => (
            <li key={row.label} className="coach-overlay-row">
              <span className={`coach-overlay-chip coach-overlay-chip-${row.chipVariant}`} aria-hidden="true">
                {row.chip}
              </span>
              <span className="coach-overlay-text">
                <span className="coach-overlay-label">{row.label}</span>
                <span className="coach-overlay-copy">{row.copy}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="sheet-actions">
          <button type="button" className="btn primary block coach-overlay-cta" onClick={handleDismiss}>
            Got it—deal me in.
          </button>
        </div>
      </div>
    </div>
  );
}
