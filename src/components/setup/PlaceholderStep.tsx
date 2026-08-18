import type { SetupStep } from '../../types';
import { STEP_LABELS, STEP_TICKETS } from './wizardSteps';

/**
 * The step body every registry entry renders until its own ticket lands
 * (#789–#792, #794 — see `STEP_TICKETS`). #788 owns the shell, the
 * navigation, the draft persistence and this registry — never the step
 * content itself, so this component stays deliberately inert: no inputs, no
 * draft mutation. `updateDraft` reaches the step-render slot (see
 * `StepRenderProps` in `stepRegistry.tsx`) precisely so the ticket that
 * replaces this component has the wiring already in place.
 */
export default function PlaceholderStep({ step }: { step: SetupStep }) {
  const ticket = STEP_TICKETS[step];
  return (
    <div className="wizard-step-placeholder" data-testid={`wizard-step-placeholder-${step}`}>
      <p>
        {STEP_LABELS[step]} ships in{' '}
        <a
          href={`https://github.com/nathanjohnpayne/gaycruisebingo/issues/${ticket}`}
          target="_blank"
          rel="noreferrer"
        >
          #{ticket}
        </a>
        . This shell only registers the step and gates Continue on the shared
        validation predicates from <code>specs/event-setup-wizard.md</code>.
      </p>
    </div>
  );
}
