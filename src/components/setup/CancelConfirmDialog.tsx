/**
 * Discard-draft confirmation (specs/event-setup-wizard.md § "Shell &
 * navigation" acceptance: "a non-empty draft… a confirm intervenes before
 * discard"). Mirrors `ReshuffleSheet`'s irreversible-action shape: the safe
 * choice ("Keep editing") is the primary button, the destructive one carries
 * `.btn.danger`.
 */
export default function CancelConfirmDialog({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
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
          <button type="button" className="btn primary" onClick={onKeepEditing}>
            Keep editing
          </button>
          <button type="button" className="btn danger" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
