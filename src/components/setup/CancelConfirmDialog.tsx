import { useEffect, useRef } from 'react';

/**
 * Discard-draft confirmation (specs/event-setup-wizard.md § "Shell &
 * navigation" acceptance: "a non-empty draft… a confirm intervenes before
 * discard"). Mirrors `ReshuffleSheet`'s irreversible-action shape: the safe
 * choice ("Keep editing") is the primary button, the destructive one carries
 * `.btn.danger`.
 *
 * Focus moves to the safe action on mount, Tab/Shift+Tab are trapped between
 * the two buttons, and focus returns to whatever opened the dialog on
 * unmount — `aria-modal="true"` alone does not enforce any of that (Codex
 * P2, PR #840); this is the two-button special case of the same trap
 * `AdminSheet.tsx` runs generally. Escape is deliberately NOT re-handled
 * here: `WizardChrome` already owns a document-level Escape → Cancel
 * listener, and `SetupWizard`'s `requestCancel` treats a second call while
 * this dialog is already open as "close it" — one Escape listener, not two
 * racing on the same keypress.
 */
export default function CancelConfirmDialog({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const discardRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepEditingRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Only two stops, so the trap is just "wrap between them" rather than
      // AdminSheet's general first/last-focusable walk.
      e.preventDefault();
      const next = document.activeElement === discardRef.current ? keepEditingRef.current : discardRef.current;
      next?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onKeepEditing}>
      <div
        className="sheet wizard-cancel-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Discard this draft?"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">Discard this draft?</div>
        <p>This event hasn't launched — closing without discarding keeps it saved on this device to resume later.</p>
        <div className="sheet-actions">
          <button type="button" ref={keepEditingRef} className="btn primary" onClick={onKeepEditing}>
            Keep editing
          </button>
          <button type="button" ref={discardRef} className="btn danger" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
