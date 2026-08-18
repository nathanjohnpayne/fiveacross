import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import WizardChrome from './WizardChrome';
import { STEP_REGISTRY } from './stepRegistry';
import { createEventDraft } from '../../data/eventDraft';
import type { SetupStep } from '../../types';

// Covers specs/event-setup-wizard.md § "Live preview strip" (#795) mount
// gating: the strip appears "from Step 2 on" — Basics, Squares, Look — and
// NOT on Occasion (nothing in the draft to preview yet) or Launch (its own
// full review checklist takes its place). PreviewStrip's own behavior
// (caption, expanded sheet, theme island) is covered by PreviewStrip.test.tsx
// and src/data/draftPreview.test.ts; this file only pins WHERE WizardChrome
// mounts it.

function renderChrome(currentStep: SetupStep) {
  const draft = createEventDraft({ now: 0 });
  render(
    <WizardChrome
      registry={STEP_REGISTRY}
      currentStep={currentStep}
      draft={draft}
      now={0}
      onStepSelect={vi.fn()}
      onRequestCancel={vi.fn()}
      onAdvance={vi.fn()}
      onSaveNow={vi.fn()}
    >
      <div>step body</div>
    </WizardChrome>,
  );
}

describe('WizardChrome — live preview strip mount gating', () => {
  it('does NOT mount the strip on Occasion (Step 1) — nothing to preview yet', () => {
    renderChrome('occasion');
    expect(screen.queryByTestId('wizard-prevbar')).not.toBeInTheDocument();
  });

  it('mounts the strip on Basics (Step 2)', () => {
    renderChrome('basics');
    expect(screen.getByTestId('wizard-prevbar')).toBeInTheDocument();
  });

  it('mounts the strip on Squares (Step 3)', () => {
    renderChrome('squares');
    expect(screen.getByTestId('wizard-prevbar')).toBeInTheDocument();
  });

  it('mounts the strip on Look (Step 4)', () => {
    renderChrome('look');
    expect(screen.getByTestId('wizard-prevbar')).toBeInTheDocument();
  });

  it('does NOT mount the strip on Launch (Step 5) — its own review checklist takes its place', () => {
    renderChrome('launch');
    expect(screen.queryByTestId('wizard-prevbar')).not.toBeInTheDocument();
  });

  it('mounts the strip between the step body and the Continue row', () => {
    renderChrome('basics');
    const shell = screen.getByTestId('wizard-shell');
    const children = Array.from(shell.querySelectorAll(':scope > *'));
    const bodyIndex = children.findIndex((el) => el.className === 'wizard-body');
    const prevbarIndex = children.findIndex((el) => el.getAttribute('data-testid') === 'wizard-prevbar');
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    const actionsIndex = children.findIndex((el) => el.contains(continueButton));
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(prevbarIndex).toBeGreaterThan(bodyIndex);
    expect(actionsIndex).toBeGreaterThan(prevbarIndex);
  });
});
