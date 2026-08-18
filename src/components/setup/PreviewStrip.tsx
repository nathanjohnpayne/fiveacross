import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { DraftDayDef, EventDraft } from '../../types';
import ThemeIsland from '../../theme/ThemeIsland';
import SquareText from '../SquareText';
import {
  dealPreviewCard,
  draftFallbackTheme,
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
  // Whether `selectedIndex` is an organizer's own Day-tab pick, as opposed to
  // the auto-computed `defaultDay`. Only an EXPLICIT pick is allowed to
  // outlive a draft edit (Codex P2, PR #857): without this, the default
  // Day chosen before any Theme was assigned would stay pinned forever —
  // Look assigning a Theme to a LATER Day would move `defaultDay` (and the
  // collapsed strip's own swatch) but leave the expanded sheet showing the
  // old, no-longer-"current" Day, silently disagreeing with the strip that
  // opened it.
  const explicitPick = useRef(false);

  // Re-anchor to the (possibly new) default whenever the organizer has not
  // explicitly chosen a tab, OR their earlier explicit pick no longer names a
  // real Day (removed from the schedule) — never fight a still-valid
  // explicit pick, so switching Day tabs in the expanded sheet survives an
  // unrelated draft edit elsewhere.
  useEffect(() => {
    const stillValid = selectedIndex != null && days.some((d) => d.index === selectedIndex);
    if (explicitPick.current && stillValid) return;
    if (!stillValid) explicitPick.current = false;
    const nextIndex = defaultDay?.index ?? null;
    if (nextIndex !== selectedIndex) setSelectedIndex(nextIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.map((d) => d.index).join(','), defaultDay?.index]);

  const selectDay = (index: number) => {
    explicitPick.current = true;
    setSelectedIndex(index);
  };

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
          onSelectDay={selectDay}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * A Day tab's own label — `previewDayLabel` (the weekday), disambiguated
 * with the 1-based Day ordinal whenever another Day in `allDays` shares the
 * same weekday (Codex P2, PR #857): the spec explicitly permits, and
 * Bodega's schedule actually has, two Days on one calendar date (a
 * competitive main Day and a closing wrap-up), which would otherwise render
 * as two indistinguishable "Sunday" tabs — unusable to sight and, via
 * duplicate accessible names, to assistive tech.
 */
function dayTabLabel(day: DraftDayDef, allDays: readonly DraftDayDef[]): string {
  const label = previewDayLabel(day);
  const collides = allDays.some((d) => d.index !== day.index && previewDayLabel(d) === label);
  return collides ? `${label} — Day ${day.index + 1}` : label;
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
        // `WizardChrome` owns its OWN document-level Escape → Cancel
        // listener, registered (bubble phase) for the whole time the wizard
        // is mounted — well before this sheet ever opens. Without
        // coordinating, the SAME keypress would both close this preview AND
        // open the discard-draft confirm (Codex P2, PR #857). Listening on
        // the CAPTURE phase runs this handler before ANY bubble-phase
        // document listener (capture always finishes before bubble begins,
        // for every node in the path, including two listeners on the same
        // `document`), and `stopPropagation` here keeps the event from ever
        // reaching that later bubble-phase listener at all.
        e.stopPropagation();
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
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  // The SELECTED Day's own fallback — never `previewTheme`, which can
  // resolve to a DIFFERENT Day's Theme (the collapsed strip's cross-Day
  // "most representative" pick). An explicitly-selected but not-yet-themed
  // Day must fall back to the Event's own default, not borrow another Day's
  // look (Codex P2, PR #857 round 2).
  const theme = selectedDay?.theme ?? draftFallbackTheme(draft);
  const deal = dealPreviewCard(draft, selectedDay);
  const title = draft.name.trim() || 'Live preview';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="sheet wizard-preview-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <div className="sheet-title">{title}</div>
          <button
            type="button"
            ref={closeRef}
            className="sheet-dismiss"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {draft.cardFormat === 'daily_cards' && days.length > 1 && (
          <div className="seg wizard-preview-days" role="group" aria-label="Preview a different Day">
            {days.map((d) => (
              <button
                key={d.index}
                type="button"
                className={'seg-btn' + (selectedDay?.index === d.index ? ' on' : '')}
                aria-pressed={selectedDay?.index === d.index}
                onClick={() => onSelectDay(d.index)}
              >
                {dayTabLabel(d, days)}
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
