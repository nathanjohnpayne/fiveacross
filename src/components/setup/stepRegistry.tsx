import type { ReactNode } from 'react';
import type { EventDraft, SetupStep } from '../../types';
import PlaceholderStep from './PlaceholderStep';
import { STEP_LABELS } from './wizardSteps';

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

/**
 * The step registry (specs/event-setup-wizard.md § "Shell & navigation").
 * Order here IS step order — `SetupWizard` and `WizardChrome` both iterate
 * this array rather than re-stating `SETUP_STEP_ORDER`, so the two can never
 * disagree about how many steps there are or what order they run in.
 *
 * Every `render` is `PlaceholderStep` today. A step ticket replaces its own
 * entry's `render` (and may sharpen `heading`) — never adds, removes, or
 * reorders entries, which stays this ticket's shell contract.
 */
export const STEP_REGISTRY: readonly StepDefinition[] = [
  {
    id: 'occasion',
    label: STEP_LABELS.occasion,
    heading: "What's the occasion?",
    render: () => <PlaceholderStep step="occasion" />,
  },
  {
    id: 'basics',
    label: STEP_LABELS.basics,
    heading: 'Name & dates',
    render: () => <PlaceholderStep step="basics" />,
  },
  {
    id: 'squares',
    label: STEP_LABELS.squares,
    heading: 'Squares',
    render: () => <PlaceholderStep step="squares" />,
  },
  {
    id: 'look',
    label: STEP_LABELS.look,
    heading: 'Look',
    render: () => <PlaceholderStep step="look" />,
  },
  {
    id: 'launch',
    label: STEP_LABELS.launch,
    heading: 'Ready when you are',
    render: () => <PlaceholderStep step="launch" />,
  },
];

export function stepDefinition(id: SetupStep): StepDefinition {
  const found = STEP_REGISTRY.find((s) => s.id === id);
  if (!found) throw new Error(`No wizard step registered for "${id}"`);
  return found;
}
