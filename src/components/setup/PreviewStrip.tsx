import { useEffect, useRef, useState } from 'react';
import type { DraftDayDef, EventDraft } from '../../types';
import ThemeIsland from '../../theme/ThemeIsland';
import SquareText from '../SquareText';
import {
  dealPreviewCard,
  previewCaption,
  previewDayForTheme,
  previewDayLabel,
  previewDays,
  previewTheme,
} from '../../data/draftPreview';

/** Elements the expanded sheet's Tab-trap cycles between — the same
 *  selector `AdminSheet.tsx` uses for its own general N-control trap. */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The live preview strip (#795, specs/event-setup-wizard.md § "Live preview
 * strip"): the Event under construction, rendered in ITS OWN Theme, docked
 * at the foot of Steps 2–4's body. Mounted by `WizardChrome` (never by an
 * individual step's own `render`) so it sits between the step body and the
 * Continue row exactly where the wireframes' `.prevbar` sits, and so every
 * step that shows it shares one instance rather than five separate copies.
 *
 * Presentational only — it reads `draft` and never calls `updateDraft`
 * (specs/event-setup-wizard.md acceptance: "the strip is presentational; it
 * never mutates the draft").
 */
export default function PreviewStrip({ draft }: { draft: EventDraft }) {
  const [open, setOpen] = useState(false);
  const days = previewDays(draft);
  const defaultDay = previewDayForTheme(draft) ?? days[0] ?? null;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(defaultDay?.index ?? null);

  // Re-anchor the selection when the schedule itself changes shape (a Day
  // removed, or the first Day ever added) — but never fight the organizer's
  // own pick while it still names a real Day, so switching the Day tab in
  // the expanded sheet survives an unrelated draft edit elsewhere.
  useEffect(() => {
    if (selectedIndex != null && days.some((d) => d.index === selectedIndex)) return;
    setSelectedIndex(defaultDay?.index ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.map((d) => d.index).join(','), defaultDay?.index]);

  const selectedDay =
    draft.cardFormat === 'daily_cards' ? (days.find((d) => d.index === selectedIndex) ?? null) : null;

  return (
    <>
      <div className="wizard-prevbar" data-testid="wizard-prevbar">
        <ThemeIsland
          theme={previewTheme(draft)}
          className="wizard-prevbar-swatch"
          aria-hidden="true"
          data-testid="wizard-prevbar-swatch"
        />
        <span className="wizard-prevbar-caption">{previewCaption(draft)}</span>
        <button
          type="button"
          className="pill wizard-prevbar-open"
          onClick={() => setOpen(true)}
        >
          Open ›
        </button>
      </div>
      {open && (
        <PreviewSheet
          draft={draft}
          days={days}
          selectedDay={selectedDay}
          onSelectDay={setSelectedIndex}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PreviewSheet({
  draft,
  days,
  selectedDay,
  onSelectDay,
  onClose,
}: {
  draft: EventDraft;
  days: readonly DraftDayDef[];
  selectedDay: DraftDayDef | null;
  onSelectDay: (index: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const theme = selectedDay?.theme ?? previewTheme(draft);
  const deal = dealPreviewCard(draft, selectedDay);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="sheet wizard-preview-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Live preview"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <div className="sheet-title">Live preview</div>
          <button
            type="button"
            ref={closeRef}
            className="sheet-dismiss"
            onClick={onClose}
            aria-label="Close preview"
          >
            ✕
          </button>
        </div>
        {draft.cardFormat === 'daily_cards' && days.length > 1 && (
          <div className="seg wizard-preview-days" role="group" aria-label="Preview a different Day">
            {days.map((d) => (
              <button
                key={d.index}
                type="button"
                className={'seg-btn' + (selectedDay?.index === d.index ? ' on' : '')}
                onClick={() => onSelectDay(d.index)}
              >
                {previewDayLabel(d)}
              </button>
            ))}
          </div>
        )}
        <ThemeIsland theme={theme} className="board-area wizard-preview-board">
          {selectedDay && (
            <div className="wizard-preview-daymeta">
              {selectedDay.placeEmoji} {selectedDay.place || 'Untitled Day'}
            </div>
          )}
          {'shortfall' in deal ? (
            <p className="wizard-preview-shortfall" role="status">
              {deal.shortfall}
            </p>
          ) : (
            <>
              <div className="bingo-head" aria-hidden="true">
                {['B', 'I', 'N', 'G', 'O'].map((l) => (
                  <span key={l}>{l}</span>
                ))}
              </div>
              <div className="grid">
                {deal.cells.map((c) => (
                  <div key={c.index} className={'cell' + (c.free ? ' free marked' : '')}>
                    {c.free ? (
                      <>
                        <span className="free-label" aria-hidden="true">
                          FREE
                        </span>
                        <span className="free-prompt">{c.text}</span>
                      </>
                    ) : (
                      <SquareText text={c.text} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </ThemeIsland>
      </div>
    </div>
  );
}
