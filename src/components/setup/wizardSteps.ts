/**
 * The wizard shell's step bookkeeping (specs/event-setup-wizard.md § "Shell &
 * navigation"). Pure — no React, no Firebase — so the step tickets (#789–#792,
 * #794) can import it without pulling in JSX, and so it is unit-testable
 * without rendering anything.
 *
 * WHY A CLASSIFIER OVER `validateEventDraft`, RATHER THAN FIVE HAND-WRITTEN
 * PER-STEP CHECKS: `validateEventDraft` (src/data/draftValidation.ts) is the
 * ONE shared launch gate every consumer — Step 5's checklist, this shell's
 * per-step Continue gate, and the launch provisioner (#793) — must agree with
 * by construction (specs/event-setup-wizard.md § Validation). Re-deriving a
 * parallel per-step check from the individual predicate functions would let
 * the shell's notion of "Step 2 is done" drift from what the launch gate
 * actually requires. Classifying the SAME issue list instead means a step can
 * only read as complete once the shared gate has nothing left to say about it.
 *
 * OWNERSHIP HERE IS ABOUT DATA, NOT LAYOUT. `plans/daily-cards-wireframes.html`
 * is exploratory and explicitly non-binding on control placement — the
 * wizard-shell dispatch note called out the Step 2 timezone/daily-email
 * placement specifically, and the frames' own banner says the built step
 * wins. `stepForIssue` below decides which STEP'S CONTINUE GATE a given
 * `DraftIssue` blocks, never which frame renders the control that fixes it. A
 * step ticket that moves a field to a different step in the real UI should
 * move that field's case in the switch below to match — a local, one-line
 * edit, never cross-file coordination.
 */

import type { EventDraft, SetupStep } from '../../types';
import { type DraftIssue, validateEventDraft, isDraftLaunchable } from '../../data/draftValidation';

/** The five steps, in the order the frames (`#frame-setup-*`) and `SetupStep`
 *  both use. */
export const SETUP_STEP_ORDER: readonly SetupStep[] = ['occasion', 'basics', 'squares', 'look', 'launch'];

/** Indicator-pill / back-chevron labels — the frames' own wording ("‹
 *  Occasion", "‹ Basics", …). */
export const STEP_LABELS: Record<SetupStep, string> = {
  occasion: 'Occasion',
  basics: 'Basics',
  squares: 'Squares',
  look: 'Look',
  launch: 'Launch',
};

/** The step ticket that owns each step's real content (epic #786). Surfaced
 *  on the placeholder body so a reader lands on the owning ticket, not just a
 *  bare TODO. The provisioner (#793) and preview strip (#795) are shared
 *  components, not steps of their own, so they are not listed here. */
export const STEP_TICKETS: Record<SetupStep, number> = {
  occasion: 789,
  basics: 790,
  squares: 791,
  look: 792,
  launch: 794,
};

/**
 * Which step's Continue gate a shared `DraftIssue` blocks.
 *
 * The `never`-typed default arm makes this exhaustive over `DraftIssueCode` at
 * COMPILE time: adding a code to `draftValidation.ts` without updating this
 * switch fails `npm run typecheck` rather than silently leaving the new issue
 * gating no step at all (mirroring App.tsx's own `Record<TabId, ReactElement>`
 * exhaustiveness pattern for the tab-to-page map).
 */
export function stepForIssue(issue: DraftIssue): SetupStep {
  switch (issue.code) {
    case 'event-missing-field':
      // Three of `eventCompletenessIssues`' required fields share this one
      // code; disambiguate by which field is missing.
      if (issue.field === 'occasion') return 'occasion';
      if (issue.field === 'defaultTheme') return 'look';
      return 'basics'; // name / startsOn / endsOn / timezone / slugCandidate
    case 'event-occasion-edition-mismatch':
      return 'occasion';
    case 'event-unsupported-timezone':
    case 'event-invalid-date-window':
    case 'event-invalid-slug':
      return 'basics';
    case 'pool-below-minimum':
    case 'main-prompt-spicy-not-boolean':
    case 'curated-prompt-is-spicy':
    case 'prompt-text-out-of-bounds':
    case 'too-many-days':
    case 'no-days':
    case 'one-card-has-days':
    case 'no-closing-day':
    case 'extra-closing-day':
      return 'squares';
    case 'first-unlock-missing':
    case 'first-unlock-sentinel':
    case 'first-unlock-past':
    case 'day-index-out-of-order':
    case 'day-missing-place':
    case 'day-missing-theme':
    case 'day-unregistered-theme':
    case 'day-off-edition-theme':
    case 'day-missing-unlock':
    case 'day-missing-date':
    case 'day-invalid-date':
    case 'day-unlock-date-mismatch':
    case 'day-blank-free-text':
    case 'day-outside-event-window':
    case 'day-tonight-not-two':
    case 'setting-out-of-range':
    // `EventDoc.defaultTheme` (Event-level, not per-Day) is authored in the
    // Look frame alongside per-Day Themes, so its two off-registry issues
    // join the per-Day Theme codes here rather than in `basics`.
    case 'event-unregistered-theme':
    case 'event-off-edition-theme':
      return 'look';
    default: {
      const exhaustive: never = issue.code;
      return exhaustive;
    }
  }
}

/** Every issue the shared launch gate reports for `step`, filtered from the
 *  SAME `validateEventDraft` list every other consumer reads — never a
 *  separately re-derived check. */
export function issuesForStep(step: SetupStep, draft: EventDraft, now: number): DraftIssue[] {
  return validateEventDraft(draft, now).filter((issue) => stepForIssue(issue) === step);
}

/**
 * Whether `step`'s Continue gate is satisfied.
 *
 * Launch is the terminal review, not a bucket in the classifier above — every
 * code `stepForIssue` recognizes already resolves to an earlier step, so a
 * bucket-based check here would read "complete" before `isDraftLaunchable`
 * agrees. Its own completeness IS the full launch gate.
 */
export function isStepComplete(step: SetupStep, draft: EventDraft, now: number): boolean {
  if (step === 'launch') return isDraftLaunchable(draft, now);
  return issuesForStep(step, draft, now).length === 0;
}

/** The zero-based position of `step` in `SETUP_STEP_ORDER`. */
export function stepIndex(step: SetupStep): number {
  return SETUP_STEP_ORDER.indexOf(step);
}

/**
 * The first step, in order, whose Continue gate is not yet satisfied — or
 * `'launch'` when every earlier step already clears its gate.
 *
 * This is the wizard's landing rule (specs/event-setup-wizard.md § "Shell &
 * navigation"): a deep link to a later step with earlier steps incomplete
 * lands here instead of rendering an inconsistent state.
 */
export function firstIncompleteStep(draft: EventDraft, now: number): SetupStep {
  for (const step of SETUP_STEP_ORDER) {
    if (step === 'launch') break;
    if (!isStepComplete(step, draft, now)) return step;
  }
  return 'launch';
}

/**
 * Whether a draft carries anything the organizer would lose by discarding it
 * — the Cancel-confirm gate ("an empty draft cancels without ceremony").
 *
 * Deliberately excludes fields `createEventDraft` seeds automatically (the
 * device timezone suggestion, the bare settings block, the default Honor
 * claim mode, the default `fiveacross` edition, `daily_cards` format) —
 * those are defaults, not content the organizer entered. `claimMode`,
 * `cardFormat` and `edition` stay excluded even after Step 1 runs
 * `applyOccasionDefaults`, because picking an occasion already flips
 * `occasion` from `null` — which this function DOES check — so those three
 * are redundant with it, never a signal on their own.
 */
export function draftHasContent(draft: EventDraft): boolean {
  return (
    draft.occasion !== null ||
    draft.name.trim() !== '' ||
    draft.startsOn !== '' ||
    draft.endsOn !== '' ||
    draft.slugCandidate.trim() !== '' ||
    draft.hostedBy.trim() !== '' ||
    draft.defaultTheme !== null ||
    draft.days.length > 0 ||
    draft.prompts.main.length > 0 ||
    draft.prompts.easy.length > 0 ||
    draft.prompts.closing.length > 0
  );
}
