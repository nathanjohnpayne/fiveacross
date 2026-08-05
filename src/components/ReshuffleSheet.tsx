import { useState } from 'react';
import { Shuffle } from 'lucide-react';
import { RESHUFFLE_ALLOWANCE, reshuffleBoard } from '../data/api';
import { track } from '../analytics';

export type ReshuffleSheetProps = {
  uid: string;
  /** The Day being traded away — its 1-based label is the sub-line's "Day N". */
  dayIndex: number;
  /** Reshuffles already spent, cruise-wide (PlayerDoc.reshufflesUsed). */
  used: number;
  /** The `seed` of the card on screen. Pinned through to the write so a retry
   *  under contention refuses rather than spending a second allowance. */
  expectedSeed: number;
  onClose: () => void;
  /** Fired after the batch commits, with the resulting spend. */
  onReshuffled?: (nextUsed: number) => void;
  /** Injected by tests; defaults to the real write path. */
  reshuffle?: typeof reshuffleBoard;
};

/**
 * The Reshuffle confirm sheet (#378, plans/daily-cards-wireframes.html
 * #frame-reshuffle).
 *
 * A pristine card has produced nothing, so there is no cascade to warn about —
 * which is exactly why this dialog exists anyway. What it protects is not the
 * board but the ALLOWANCE: three per cruise, non-refundable, and the card is gone
 * for good. So the copy leads with permanence rather than consequence, and "Keep
 * my card" is the primary while "Reshuffle it" carries the danger styling — the
 * safe choice is the prominent one, because the risky choice here is irreversible
 * and the player is one tap from spending a third of their cruise budget.
 *
 * Copy is verbatim from the wireframe; it is asserted word-for-word by
 * src/components/reshuffle-sheet.test.tsx and the e2e parity walk.
 */
export default function ReshuffleSheet({
  uid,
  dayIndex,
  used,
  expectedSeed,
  onClose,
  onReshuffled,
  reshuffle = reshuffleBoard,
}: ReshuffleSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, RESHUFFLE_ALLOWANCE - used);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The write re-reads and re-checks eligibility server-side (and the rules
      // re-check it again): between opening this sheet and tapping confirm, a
      // Mark could have landed from another tab. The render-time eligibility
      // close in Board handles the case where THIS tab can see that; this is the
      // case where it cannot.
      const nextUsed = await reshuffle({ uid, dayIndex, expectedSeed });
      track('reshuffle_card', { dayIndex, reshufflesUsed: nextUsed });
      onReshuffled?.(nextUsed);
      onClose();
    } catch {
      // Deliberately generic: every failure mode here (no longer pristine, no
      // allowance left, a rules denial, a dropped connection mid-commit) is
      // recoverable by looking at the card, and the live listener re-renders the
      // truth underneath this sheet either way. Naming the specific cause would
      // mostly surface a race the player cannot act on.
      setError("Couldn't reshuffle. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    // The backdrop is guarded by `busy` like both buttons (CodeRabbit, PR #383):
    // an unguarded dismiss would let a stray tap tear the sheet down mid-commit,
    // so the Player never learns whether the reshuffle they just spent actually
    // landed — the one moment in this flow where that matters most.
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="sheet reshuffle-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Reshuffle this card?"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">Reshuffle this card?</div>
        <p className="reshuffle-sub">A fresh 24 squares for Day {dayIndex + 1}—same day, new luck.</p>
        <div className="warnbox">
          <b>This can't be undone.</b> You'll never see this card again—and reshuffles don't come
          back.
        </div>
        <p className="reshuffle-note">
          {left} of {RESHUFFLE_ALLOWANCE} reshuffles left · available only before you've
          marked a square
        </p>
        {error && <p className="reshuffle-error">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn primary" onClick={onClose} disabled={busy}>
            Keep my card
          </button>
          <button type="button" className="btn danger" onClick={confirm} disabled={busy}>
            <Shuffle aria-hidden="true" className="reshuffle-btn-icon" />
            {busy ? 'Reshuffling…' : 'Reshuffle it'}
          </button>
        </div>
      </div>
    </div>
  );
}
