import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EventDraft, SetupStep } from '../../types';
import type { StepDefinition } from './stepRegistry';
import { STEP_LABELS, isStepComplete, issuesForStep, stepIndex } from './wizardSteps';

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

  useEffect(() => {
    titleRef.current?.focus();
  }, [currentStep]);

  // A step change clears any "here's what's missing" panel left over from the
  // step the organizer just came from — it would otherwise show stale issues
  // for a different step's fields.
  useEffect(() => {
    setShowIssues(false);
  }, [currentStep]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onRequestCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onRequestCancel]);

  const currentIndex = stepIndex(currentStep);
  const previousStep = currentIndex > 0 ? registry[currentIndex - 1]?.id : undefined;
  const isLastStep = currentStep === 'launch';
  const issues = issuesForStep(currentStep, draft, now);
  const complete = issues.length === 0;

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
          const stepComplete = isStepComplete(step.id, draft, now);
          const isCurrent = step.id === currentStep;
          // Clickable == a COMPLETE, non-current step: real back-navigation to
          // a step the shared gate already accepts. The current step is a
          // no-op (already there); an incomplete, not-yet-reached step is not
          // skippable via the indicator at all.
          const clickable = !isCurrent && stepComplete;
          const dot = stepComplete && !isCurrent ? '✓' : i + 1;
          const pillClassName = `wizard-step-pill${isCurrent ? ' is-current' : ''}${stepComplete ? ' is-done' : ''}`;
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
