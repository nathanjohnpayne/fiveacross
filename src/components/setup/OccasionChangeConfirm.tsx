import { useEffect, useRef } from 'react';
import type { OccasionDef } from '../../types';

/**
 * Re-selection guard for `OccasionStep` (#789, specs/event-setup-wizard.md §
 * "Step 1 · Occasion"). `EventDraft` carries no hand-edited tracking for the
 * fields `applyOccasionDefaults` recommits (claim mode, default Theme,
 * settings, card format) — see the note on `OccasionStep` — so a re-pick
 * cannot selectively re-seed only the untouched ones. This dialog is the
 * acceptance criteria's other branch instead: warn before overwriting,
 * rather than a silent clobber.
 *
 * Mirrors `CancelConfirmDialog`'s shape (the safe choice is the primary
 * button, the overwriting one carries `.btn.danger`) and its focus
 * management: focus moves to the safe action on mount, Tab/Shift+Tab are
 * trapped between the two buttons, and focus returns to whatever opened the
 * dialog on unmount. Escape is deliberately NOT re-handled here, the same
 * choice `CancelConfirmDialog` makes and for the same reason: `WizardChrome`
 * already owns a single document-level Escape listener, wired to Cancel, not
 * to this step's own local state — duplicating a second Escape handler here
 * would race it on the same keypress rather than coordinate with it.
 */
export default function OccasionChangeConfirm({
  from,
  to,
  willClearSchedule,
  onKeepCurrent,
  onSwitch,
}: {
  from: OccasionDef;
  to: OccasionDef;
  /** Whether committing `to` will clear an authored schedule — true only
   *  when `to` is a one-card occasion and the draft currently holds Days
   *  (specs/event-setup-wizard.md § "The occasion matrix": "re-picking a
   *  one-card occasion clears `days[]`" is `applyOccasionDefaults`'s one
   *  documented destructive change). */
  willClearSchedule: boolean;
  onKeepCurrent: () => void;
  onSwitch: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const next = document.activeElement === switchRef.current ? keepRef.current : switchRef.current;
      next?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onKeepCurrent}>
      <div
        className="sheet wizard-occasion-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Switch to ${to.label}?`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">
          Switch to {to.emoji} {to.label}?
        </div>
        <p>
          This re-applies {to.label}&rsquo;s edition, claim mode, default Theme and Event settings over{' '}
          {from.label}&rsquo;s — anything you&rsquo;ve since changed on a later step may be reset.
          {willClearSchedule &&
            ` It also clears the schedule you've authored, since ${to.label} is a one-card occasion.`}
        </p>
        <div className="sheet-actions">
          <button type="button" ref={keepRef} className="btn primary" onClick={onKeepCurrent}>
            Keep {from.label}
          </button>
          <button type="button" ref={switchRef} className="btn danger" onClick={onSwitch}>
            Switch to {to.label}
          </button>
        </div>
      </div>
    </div>
  );
}
