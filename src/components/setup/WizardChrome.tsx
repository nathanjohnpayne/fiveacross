import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EventDraft, SetupStep } from '../../types';
import type { StepDefinition } from './stepRegistry';
import { STEP_LABELS, isStepComplete, issuesForStep, stepIndex } from './wizardSteps';
import PreviewStrip from './PreviewStrip';

export interface WizardChromeProps {
  registry: readonly StepDefinition[];
  currentStep: SetupStep;
  draft: EventDraft;
  /** Injected so tests can pin it — see `firstUnlockIssues`'s own convention
   *  in draftValidation.ts. */
  now: number;
  /** Step-indicator tap (a completed step) or the header's back-chevron. */
  onStepSelect: (step: SetupStep) => void;
  /** Header's Cancel (Step 1) or Escape from any step. Whether that discards
   *  immediately or asks first is `SetupWizard`'s call, not this component's —
   *  it owns the draft and the store. */
  onRequestCancel: () => void;
  /** Continue, once this step's own gate is satisfied. */
  onAdvance: () => void;
  onSaveNow: () => void;
  /** Brief "Saved" confirmation text, shown by the parent after `onSaveNow`
   *  resolves. `null` renders nothing. */
  savedFlash?: string | null;
  children: ReactNode;
}

/**
 * The wizard's shared chrome (specs/event-setup-wizard.md § "Shell &
 * navigation", `#frame-setup-occasion` … `#frame-setup-launch`): the sticky
 * sheet header, the five-step indicator, and the per-step Continue row.
 *
 * Deliberately NOT `AdminSheet`: that component overlays a backdrop on top of
 * OTHER tab content and dismisses via backdrop-tap and a header swipe-down,
 * because it renders as a modal sheet inside the app shell. This wizard mounts
 * at its own top-level route (`/setup/*`) — a full page, not an overlay — so
 * there is no backdrop to tap and no content behind it to escape into. What
 * IS mirrored from `AdminSheet`'s dialog conventions: Escape closes it (here,
 * requests Cancel), and the surface's own title takes focus on mount and on
 * every step change so assistive tech hears where the organizer landed.
 */
export default function WizardChrome({
  registry,
  currentStep,
  draft,
  now,
  onStepSelect,
  onRequestCancel,
  onAdvance,
  onSaveNow,
  savedFlash,
  children,
}: WizardChromeProps) {
  const titleRef = useRef<HTMLDivElement | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  // Tracks the step `showIssues` was last cleared for. Compared DURING
  // RENDER (React's documented "adjusting state when a prop changes"
  // pattern), not in an effect: an effect-based reset fires AFTER the first
  // commit of the new step, so that first paint — and any screen reader
  // watching the `role="alert"` region — would show the NEW step's own
  // unmet-gate issues immediately, before the organizer ever pressed its
  // Continue button (Codex P2, PR #840, round 3). Resetting synchronously
  // here means the stale value never reaches the DOM at all.
  const [issuesShownForStep, setIssuesShownForStep] = useState(currentStep);
  if (currentStep !== issuesShownForStep) {
    setIssuesShownForStep(currentStep);
    setShowIssues(false);
  }

  useEffect(() => {
    titleRef.current?.focus();
  }, [currentStep]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Ignore an Escape a nested control already consumed (#849) — a
      // future date picker, menu, or other composite input that calls
      // `preventDefault()` on its own Escape handling (to stop the
      // browser's default behavior) without ALSO calling
      // `stopPropagation()`. `OccasionChangeConfirm` already suppresses
      // this listener correctly, via capture-phase `stopPropagation()`
      // (specs/event-setup-wizard.md § Step 1 · Occasion's "Escape while
      // the confirm is open"), so this check is additive, not a
      // replacement for that mechanism. Also ignore an IME composition
      // keystroke (`isComposing`) — Escape can cancel character
      // composition without being a request to leave the wizard.
      if (e.defaultPrevented || e.isComposing) return;
      onRequestCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onRequestCancel]);

  const currentIndex = stepIndex(currentStep);
  const previousStep = currentIndex > 0 ? registry[currentIndex - 1]?.id : undefined;
  const isLastStep = currentStep === 'launch';
  const issues = issuesForStep(currentStep, draft, now);
  const complete = issues.length === 0;
  // The strip appears from Step 2 on (specs/event-setup-wizard.md § "Live
  // preview strip"): Occasion has no draft content yet to preview, and
  // Launch has its own full review checklist in its place.
  const showPreview = currentStep !== 'occasion' && !isLastStep;

  const handleContinue = () => {
    if (complete) {
      onAdvance();
    } else {
      setShowIssues(true);
    }
  };

  return (
    <div className="wizard-shell" data-testid="wizard-shell">
      <div className="wizard-sheethead">
        {previousStep ? (
          <button type="button" className="wizard-back" onClick={() => onStepSelect(previousStep)}>
            ‹ {STEP_LABELS[previousStep]}
          </button>
        ) : (
          <button type="button" className="wizard-back wizard-cancel" onClick={onRequestCancel}>
            ✕ Cancel
          </button>
        )}
        <div className="wizard-title" ref={titleRef} tabIndex={-1}>
          New event
        </div>
        {isLastStep ? (
          <span className="wizard-save-spacer" aria-hidden="true" />
        ) : (
          <button type="button" className="wizard-save" onClick={onSaveNow}>
            Save draft (local)
          </button>
        )}
      </div>
      {savedFlash && (
        <div className="wizard-saved-flash" role="status">
          {savedFlash}
        </div>
      )}

      <div className="wizard-steps" role="list" aria-label="Setup steps">
        {registry.map((step, i) => {
          const isCurrent = step.id === currentStep;
          // "Done" (✓, clickable) requires BOTH the step's own gate being
          // satisfied AND the step being one the organizer has already
          // reached (`i < currentIndex`). `isStepComplete` alone is not
          // enough: a LATER step can independently satisfy its own gate —
          // nothing assigned to it yet, so it has no issues to report —
          // while an earlier one is still the reason the organizer hasn't
          // reached it. Rendering that later step as done (or as a live
          // button) would show a checkmark, or offer a forward jump, that
          // `SetupWizard`'s own landing rule immediately bounces back from
          // (Codex P2, PR #840).
          const done = i < currentIndex && isStepComplete(step.id, draft, now);
          const clickable = done; // no separate case today; kept distinct for readability
          const dot = done ? '✓' : i + 1;
          const pillClassName = `wizard-step-pill${isCurrent ? ' is-current' : ''}${done ? ' is-done' : ''}`;
          return (
            <div key={step.id} role="listitem" className="wizard-step-item">
              {/* A real <button> only when it does something — an inert pill
                  wearing `disabled` on an interactive role reads as broken to
                  a screen reader, not as "not yet". */}
              {clickable ? (
                <button type="button" className={pillClassName} onClick={() => onStepSelect(step.id)}>
                  <span className="wizard-step-dot" aria-hidden="true">
                    {dot}
                  </span>
                  {step.label}
                </button>
              ) : (
                <span className={pillClassName} aria-current={isCurrent ? 'step' : undefined}>
                  <span className="wizard-step-dot" aria-hidden="true">
                    {dot}
                  </span>
                  {step.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="wizard-body">{children}</div>

      {showPreview && <PreviewStrip draft={draft} />}

      {!isLastStep && (
        <div className="wizard-actions">
          {showIssues && issues.length > 0 && (
            <ul className="wizard-issues" role="alert">
              {issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`}>{issue.message}</li>
              ))}
            </ul>
          )}
          <div className="wizard-btnrow">
            <button type="button" className="btn primary wizard-continue" onClick={handleContinue}>
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
