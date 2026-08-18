import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { EventDraft } from '../../types';
import { createEventDraft, createLocalDraftStore } from '../../data/eventDraft';
import SetupWizard from './SetupWizard';
import { setupStepPath } from './route';

// Covers specs/event-setup-wizard.md § "Shell & navigation" — #788's route,
// five-step navigation, per-step Continue gating, deep-link/resume landing,
// and Cancel-with-confirm.
//
// jsdom here leaves `window.localStorage` unset (see
// src/hooks/useTextSize.test.ts, src/data/cardCache.test.ts), so stub a real
// in-memory Storage — the same one `SetupWizard`'s own
// `createLocalDraftStore()` call falls back to in a real browser.
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/setup/*" element={<SetupWizard />} />
        <Route path="/" element={<div data-testid="fallback-page">Card</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const store = createLocalDraftStore();

/** Seeds a draft directly through the store — bypassing any UI — the way a
 *  later step ticket's real form would have committed it. */
async function seedDraft(over: Partial<EventDraft> = {}): Promise<EventDraft> {
  const draft = { ...createEventDraft({ draftId: 'seeded-draft' }), ...over };
  return store.save(draft);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bare /setup', () => {
  it('creates a fresh draft and lands on Step 1 · Occasion', async () => {
    renderApp('/setup');
    await screen.findByTestId('wizard-step-placeholder-occasion');
    expect(screen.getByText('✕ Cancel')).toBeInTheDocument();
    expect(screen.getByText('New event')).toBeInTheDocument();
    // A brand-new draft is persisted immediately, so a reload before any
    // field is touched still finds it (not merely held in React state).
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.step).toBe('occasion');
  });
});

describe('Continue gating', () => {
  it('does not advance past an incomplete step, and surfaces what is missing', async () => {
    const user = userEvent.setup();
    await seedDraft(); // occasion: null — Step 1 is unsatisfied by construction
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Still on Step 1 — the placeholder body for Basics never mounted.
    expect(screen.getByTestId('wizard-step-placeholder-occasion')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-step-placeholder-basics')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/occasion/i);
  });

  it('advances — and persists the new step without any explicit save — once the step is satisfied', async () => {
    const user = userEvent.setup();
    // occasion + edition agree, so Step 1's gate is clear; nothing else is
    // filled in, so Step 2 is not.
    await seedDraft({ occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByTestId('wizard-step-placeholder-basics');
    // No "Save draft (local)" tap happened — the step transition itself is
    // the field mutation, and it is durable on its own.
    const stored = await store.load('seeded-draft');
    expect(stored?.step).toBe('basics');
  });
});

describe('deep link / resume landing', () => {
  it('a link to a later step with earlier steps incomplete lands on the first incomplete step instead', async () => {
    await seedDraft(); // nothing answered at all
    renderApp(setupStepPath('seeded-draft', 'look'));

    await screen.findByTestId('wizard-step-placeholder-occasion');
    expect(screen.queryByTestId('wizard-step-placeholder-look')).not.toBeInTheDocument();
  });

  it('resumes exactly at the step a draft was saved on when that step is still the first incomplete one', async () => {
    await seedDraft({
      step: 'squares',
      occasion: 'weekend-away',
      edition: 'vacay',
      name: 'Weekend in Point Reyes',
      startsOn: '2026-08-07',
      endsOn: '2026-08-09',
      timezone: 'America/Los_Angeles',
      slugCandidate: 'point-reyes',
    });
    renderApp(setupStepPath('seeded-draft', 'squares'));

    await screen.findByTestId('wizard-step-placeholder-squares');
  });

  it('a miss (unknown draftId) starts a fresh draft rather than dead-ending', async () => {
    renderApp(setupStepPath('never-saved', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-occasion');
    const summaries = await store.list();
    expect(summaries.map((s) => s.draftId)).not.toContain('never-saved');
  });
});

describe('back navigation to a completed step', () => {
  it('tapping a done indicator returns to it with prior answers intact, and can come forward again', async () => {
    const user = userEvent.setup();
    await seedDraft({
      step: 'squares',
      occasion: 'weekend-away',
      edition: 'vacay',
      name: 'Weekend in Point Reyes',
      startsOn: '2026-08-07',
      endsOn: '2026-08-09',
      timezone: 'America/Los_Angeles',
      slugCandidate: 'point-reyes',
    });
    renderApp(setupStepPath('seeded-draft', 'squares'));
    await screen.findByTestId('wizard-step-placeholder-squares');

    // Occasion is done — jump back to it via its indicator pill.
    await user.click(screen.getByRole('button', { name: /Occasion/ }));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    // The header's back-affordance now reads Cancel again (Step 1), proving
    // the jump landed for real, not just a visual highlight.
    expect(screen.getByText('✕ Cancel')).toBeInTheDocument();

    // The name/dates entered before going back are untouched in storage.
    const stored = await store.load('seeded-draft');
    expect(stored?.name).toBe('Weekend in Point Reyes');
    expect(stored?.step).toBe('occasion');

    // And Basics — also done — is reachable going forward again.
    await user.click(screen.getByRole('button', { name: /Basics/ }));
    await screen.findByTestId('wizard-step-placeholder-basics');
  });

  it('the header back-chevron steps back exactly one step, labelled with the previous step', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    await user.click(screen.getByRole('button', { name: '‹ Occasion' }));
    await screen.findByTestId('wizard-step-placeholder-occasion');
  });
});

describe('Cancel', () => {
  it('discards an empty draft without ceremony', async () => {
    const user = userEvent.setup();
    await seedDraft(); // nothing entered
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    await user.click(screen.getByText('✕ Cancel'));

    // No confirm dialog — straight to discard-and-leave.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await screen.findByTestId('fallback-page');
    expect(await store.load('seeded-draft')).toBeNull();
  });

  it('confirms before discarding a non-empty draft, and "Keep editing" leaves it untouched', async () => {
    const user = userEvent.setup();
    await seedDraft({ occasion: 'custom' }); // one answered field is enough to count as content
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    await user.click(screen.getByText('✕ Cancel'));
    const dialog = await screen.findByRole('alertdialog', { name: /discard this draft/i });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-step-placeholder-occasion')).toBeInTheDocument();
    expect(await store.load('seeded-draft')).not.toBeNull();

    await user.click(screen.getByText('✕ Cancel'));
    const dialogAgain = await screen.findByRole('alertdialog');
    await user.click(within(dialogAgain).getByRole('button', { name: 'Discard' }));

    await screen.findByTestId('fallback-page');
    expect(await store.load('seeded-draft')).toBeNull();
  });

  it('Escape requests Cancel from any step, not only Step 1', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
  });
});

describe('Save draft (local)', () => {
  it('is a direct save trigger, not the only writer', async () => {
    const user = userEvent.setup();
    await seedDraft();
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-placeholder-occasion');

    await user.click(screen.getByRole('button', { name: 'Save draft (local)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('is hidden on the terminal Launch step', async () => {
    await seedDraft({
      step: 'launch',
      occasion: 'weekend-away',
      edition: 'vacay',
      name: 'Weekend in Point Reyes',
      startsOn: '2026-08-07',
      endsOn: '2026-08-09',
      timezone: 'America/Los_Angeles',
      slugCandidate: 'point-reyes',
      defaultTheme: 'the-birds',
      // Every earlier step's gate must ALSO clear, or the deep-link landing
      // rule redirects this request back to whichever one is not — Squares
      // and Look both need real content for a `daily_cards` draft.
      prompts: {
        main: Array.from({ length: 32 }, (_, i) => ({ text: `main ${i}`, spicy: false })),
        easy: Array.from({ length: 28 }, (_, i) => ({ text: `easy ${i}` })),
        closing: Array.from({ length: 26 }, (_, i) => ({ text: `closing ${i}` })),
      },
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: Date.parse('2026-08-07T13:00:00Z'),
          place: 'Point Reyes',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'easy',
          tutorial: false,
          tonight: ['🦀 Crab shack', '🔥 Fire pit'],
        },
        {
          index: 1,
          date: '2026-08-09',
          unlockAt: Date.parse('2026-08-09T13:00:00Z'),
          place: 'Point Reyes',
          placeEmoji: '🌅',
          theme: 'fog-froth-farewells',
          pool: 'closing',
          tutorial: true,
          tonight: ['👋 Goodbyes', '🚗 The long way back'],
        },
      ],
    });
    renderApp(setupStepPath('seeded-draft', 'launch'));
    await screen.findByTestId('wizard-step-placeholder-launch');
    expect(screen.queryByRole('button', { name: 'Save draft (local)' })).not.toBeInTheDocument();
  });
});
