import type { ReactNode } from 'react';
import type { EventDraft, SetupStep } from '../../types';
import PlaceholderStep from './PlaceholderStep';
import OccasionStep from './OccasionStep';
import { SETUP_STEP_ORDER, STEP_LABELS } from './wizardSteps';

/** Props every step's `render` receives. The step tickets (#789–#792, #794)
 *  plug their real bodies in behind this — the shell owns everything else. */
export interface StepRenderProps {
  draft: EventDraft;
  /** Commits a change to the in-progress draft. The shell persists it via
   *  `EventDraftStore.save` on every call — a step never needs to trigger its
   *  own save (specs/event-setup-wizard.md § "Shell & navigation" acceptance:
   *  "any field mutation… is persisted without an explicit save action"). */
  updateDraft: (updater: (draft: EventDraft) => EventDraft) => void;
}

export interface StepDefinition {
  id: SetupStep;
  /** Indicator-pill / back-chevron label (the frames' own wording). */
  label: string;
  /** The `.secthead`-equivalent heading the step owns once its ticket ships. */
  heading: string;
  render: (props: StepRenderProps) => ReactNode;
}

/** Everything about a step BESIDES its position — `heading` and `render`,
 *  keyed by id. Position itself comes from `SETUP_STEP_ORDER` alone (below),
 *  so the two can never list a different number of steps or disagree about
 *  their order (Codex, PR #840: two independently-maintained arrays can
 *  silently drift the moment either one is edited without the other). */
const STEP_CONTENT: Record<SetupStep, Pick<StepDefinition, 'heading' | 'render'>> = {
  occasion: { heading: "What's the occasion?", render: (props) => <OccasionStep {...props} /> },
  basics: { heading: 'Name & dates', render: () => <PlaceholderStep step="basics" /> },
  squares: { heading: 'Squares', render: () => <PlaceholderStep step="squares" /> },
  look: { heading: 'Look', render: () => <PlaceholderStep step="look" /> },
  launch: { heading: 'Ready when you are', render: () => <PlaceholderStep step="launch" /> },
};

/**
 * The step registry (specs/event-setup-wizard.md § "Shell & navigation").
 * DERIVED from `SETUP_STEP_ORDER` (`./wizardSteps.ts`) — the one place step
 * order is stated — rather than hand-listing five objects in array order, so
 * `SetupWizard`'s navigation (`handleAdvance`, `firstIncompleteStep`,
 * `stepIndex`) and this registry's rendering order are structurally the same
 * sequence, not two lists a future edit could quietly desync.
 *
 * Every `render` is `PlaceholderStep` today. A step ticket replaces its own
 * entry's `render` (and may sharpen `heading`) in `STEP_CONTENT` above —
 * never adds, removes, or reorders steps, which stays this ticket's shell
 * contract (reorders belong in `SETUP_STEP_ORDER` itself, and touch both the
 * classifier in `wizardSteps.ts` and every step ticket at once).
 */
export const STEP_REGISTRY: readonly StepDefinition[] = SETUP_STEP_ORDER.map((id) => ({
  id,
  label: STEP_LABELS[id],
  ...STEP_CONTENT[id],
}));

export function stepDefinition(id: SetupStep): StepDefinition {
  const found = STEP_REGISTRY.find((s) => s.id === id);
  if (!found) throw new Error(`No wizard step registered for "${id}"`);
  return found;
}
