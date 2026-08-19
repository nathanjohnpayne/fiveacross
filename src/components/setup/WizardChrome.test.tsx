import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WizardChrome from './WizardChrome';
import { STEP_REGISTRY } from './stepRegistry';
import { createEventDraft } from '../../data/eventDraft';
import type { EventDraft, SetupStep } from '../../types';

// The real STEP_REGISTRY above now includes the Basics step (#790), which
// pulls in `../../data/hostnames` for its live address check — and that
// module's top-level `import '../firebase'` calls `getAuth(app)` at MODULE
// LOAD TIME, throwing `auth/invalid-api-key` in this env-var-free test run.
// Stubbed to its one export the step actually calls, same treatment as
// App.test.tsx and SetupWizard.test.tsx (specs/event-setup-wizard.md §
// "Step 2 · Basics"). Resolves 'available' so a draft this suite seeds with
// an already-answered Basics step reads as complete immediately, matching
// StepBasics's optimistic-trust behavior for an already-committed candidate.
vi.mock('../../data/hostnames', () => ({
  checkSlugAvailability: vi.fn(() => Promise.resolve('available')),
  // `StepBasics` calls this one, not `checkSlugAvailability` (CodeRabbit
  // Major, PR #911). Omitting it left `undefined` to be invoked inside the
  // debounced callback — harmless today only because no test here advances
  // past the 400ms debounce and unmount clears the timer first, which is a
  // timing accident rather than a contract. Mocking what the component
  // actually calls removes the dependence on that accident.
  checkEventAddressAvailability: vi.fn((slug: string, alternateApex: string | null) =>
    Promise.resolve(
      [`${slug}.fiveacross.app`, ...(alternateApex === null ? [] : [`${slug}.${alternateApex}`])].map(
        (hostname) => ({ hostname, status: 'available' as const }),
      ),
    ),
  ),
}));

// Covers specs/event-setup-wizard.md § "Live preview strip" (#795) mount
// gating: the strip appears "from Step 2 on" — Basics, Squares, Look — and
// NOT on Occasion (nothing in the draft to preview yet) or Launch (its own
// full review checklist takes its place). PreviewStrip's own behavior
// (caption, expanded sheet, theme island) is covered by PreviewStrip.test.tsx
// and src/data/draftPreview.test.ts; this file only pins WHERE WizardChrome
// mounts it — plus the Escape-ownership handoff between the two, below.

function renderChrome(
  currentStep: SetupStep,
  {
    onRequestCancel = vi.fn(),
    draft,
    children = <div>step body</div>,
  }: { onRequestCancel?: () => void; draft?: EventDraft; children?: ReactNode } = {},
) {
  render(
    <WizardChrome
      registry={STEP_REGISTRY}
      currentStep={currentStep}
      draft={draft ?? createEventDraft({ now: 0 })}
      now={0}
      onStepSelect={vi.fn()}
      onRequestCancel={onRequestCancel}
      onAdvance={vi.fn()}
      onSaveNow={vi.fn()}
    >
      {children}
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

describe('WizardChrome + PreviewStrip — Escape ownership (Codex P2, PR #857)', () => {
  it('Escape closes an open preview sheet WITHOUT also requesting draft cancellation', async () => {
    const user = userEvent.setup();
    const onRequestCancel = vi.fn();
    const draft = {
      ...createEventDraft({ now: 0 }),
      prompts: {
        main: Array.from({ length: 24 }, (_, i) => ({ text: `main prompt ${i}`, spicy: false })),
        easy: [],
        closing: [],
      },
    };
    renderChrome('basics', { onRequestCancel, draft });

    await user.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRequestCancel).not.toHaveBeenCalled();
  });

  it('Escape still requests cancellation via the chrome listener when no preview is open', async () => {
    const user = userEvent.setup();
    const onRequestCancel = vi.fn();
    renderChrome('basics', { onRequestCancel });
    await user.keyboard('{Escape}');
    expect(onRequestCancel).toHaveBeenCalledTimes(1);
  });
});

describe('WizardChrome — Escape ignores an event a nested control already consumed (#849)', () => {
  it('does not request cancellation when a nested control called preventDefault() on its own Escape handling', () => {
    const onRequestCancel = vi.fn();
    // Models a future composite control (a date picker, a menu) that
    // handles Escape itself — closing its own popover — via
    // `preventDefault()` alone, without also calling `stopPropagation()`.
    // `OccasionChangeConfirm`'s existing capture-phase `stopPropagation()`
    // is a DIFFERENT, already-covered mechanism (the describe block above);
    // this one is the additional, defaultPrevented-based safety net #849
    // asks for.
    renderChrome('basics', {
      onRequestCancel,
      children: (
        <input
          aria-label="nested control"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.preventDefault();
          }}
        />
      ),
    });
    const input = screen.getByLabelText('nested control');
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(onRequestCancel).not.toHaveBeenCalled();
  });

  it('still requests cancellation for an Escape a nested control did NOT prevent', () => {
    const onRequestCancel = vi.fn();
    renderChrome('basics', {
      onRequestCancel,
      children: <input aria-label="inert control" />,
    });
    const input = screen.getByLabelText('inert control');
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(onRequestCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape delivered mid IME composition', () => {
    const onRequestCancel = vi.fn();
    renderChrome('basics', { onRequestCancel });
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    } as KeyboardEventInit);
    document.dispatchEvent(event);
    expect(onRequestCancel).not.toHaveBeenCalled();
  });
});
