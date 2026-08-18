import { StrictMode } from 'react';
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

/** A store that ACCEPTS every write without error but never actually keeps
 *  it — the external symptom `EventDraftStore.save`'s own best-effort
 *  contract produces when the real `localStorage.setItem` throws internally
 *  on a key that never existed before (quota, restricted-storage) and the
 *  module swallows it: the call resolves normally, but nothing is there to
 *  read back. */
class WriteBlackHoleStorage implements Storage {
  get length() {
    return 0;
  }
  clear() {}
  getItem() {
    return null;
  }
  key() {
    return null;
  }
  removeItem() {}
  setItem() {}
}

/** Reads always return a fixed snapshot taken at construction; writes are
 *  accepted but silently discarded. Models the OTHER shape of a swallowed
 *  `setItem` failure: an ALREADY-SAVED draft whose next write fails,
 *  leaving the OLD blob readable — present, but stale, rather than gone. */
class FrozenStorage implements Storage {
  private snapshot = new Map<string, string>();
  constructor(source: Storage) {
    for (let i = 0; i < source.length; i++) {
      const key = source.key(i)!;
      this.snapshot.set(key, source.getItem(key)!);
    }
  }
  get length() {
    return this.snapshot.size;
  }
  clear() {}
  getItem(k: string) {
    return this.snapshot.has(k) ? this.snapshot.get(k)! : null;
  }
  key(i: number) {
    return [...this.snapshot.keys()][i] ?? null;
  }
  removeItem() {}
  setItem() {}
}

function renderApp(initialPath: string, { strict = false }: { strict?: boolean } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/setup/*" element={<SetupWizard />} />
        <Route path="/" element={<div data-testid="fallback-page">Card</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const store = createLocalDraftStore();

/** A calendar date `daysAhead` from the real clock — `SetupWizard` reads
 *  `Date.now()` directly (it is not given an injectable clock like
 *  `draftValidation.ts`'s pure functions are), so a fixture that needs
 *  `firstUnlockIssues` to pass must stay in the future relative to whenever
 *  the suite actually runs, not a fixed literal date. */
function futureIsoDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

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
    await screen.findByTestId('wizard-step-occasion');
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
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Still on Step 1 — the placeholder body for Basics never mounted.
    expect(screen.getByTestId('wizard-step-occasion')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-step-placeholder-basics')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/occasion/i);
  });

  it('advances — and persists the new step without any explicit save — once the step is satisfied', async () => {
    const user = userEvent.setup();
    // occasion + edition agree, so Step 1's gate is clear; nothing else is
    // filled in, so Step 2 is not.
    await seedDraft({ occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

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

    await screen.findByTestId('wizard-step-occasion');
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

    // Squares is a real step body now (#791) rather than a placeholder; these
    // assertions only ever meant "the wizard landed on Squares".
    await screen.findByTestId('setup-step-squares');
  });

  it('a miss (unknown draftId) starts a fresh draft rather than dead-ending', async () => {
    renderApp(setupStepPath('never-saved', 'basics'));
    await screen.findByTestId('wizard-step-occasion');
    const summaries = await store.list();
    expect(summaries.map((s) => s.draftId)).not.toContain('never-saved');
  });

  it('persists the corrected landing step, not just the URL (Codex P2, PR #840, round 2)', async () => {
    // Saved standing on Launch, but nothing is actually answered — the shape
    // a Launch-step draft takes once its first unlock elapses out from under
    // it while the wizard sits open.
    await seedDraft({ step: 'launch' });
    renderApp(setupStepPath('seeded-draft', 'launch'));

    await screen.findByTestId('wizard-step-occasion');
    await waitFor(async () => {
      const stored = await store.load('seeded-draft');
      expect(stored?.step).toBe('occasion');
    });
  });

  it('corrects the IN-MEMORY step too, not only storage (Codex P2, PR #840, round 3)', async () => {
    // Occasion is answered (so the landing correction lands on Basics, not
    // Occasion) but the draft was saved standing on the now-unreachable
    // Launch step.
    const user = userEvent.setup();
    await seedDraft({ step: 'launch', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'launch'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    // If the correction only wrote storage and left the in-memory draft
    // still carrying `step: 'launch'`, this explicit save reads FROM that
    // stale in-memory value and overwrites the correction right back.
    await user.click(screen.getByRole('button', { name: 'Save draft (local)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));

    const stored = await store.load('seeded-draft');
    expect(stored?.step).toBe('basics');
  });

  it('syncs draft.step to a history-driven navigation, not only a goToStep click (Codex P2, PR #840, round 4)', async () => {
    // Saved mid-Squares, but the organizer used the browser's Back button (or
    // pasted a same-draft link) straight to Basics — a legitimate, already-
    // reached step reached WITHOUT going through `goToStep`'s own persist.
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
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    await waitFor(async () => {
      const stored = await store.load('seeded-draft');
      expect(stored?.step).toBe('basics');
    });
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
    // Squares is a real step body now (#791) rather than a placeholder; these
    // assertions only ever meant "the wizard landed on Squares".
    await screen.findByTestId('setup-step-squares');

    // Occasion is done — jump back to it via its indicator pill.
    await user.click(screen.getByRole('button', { name: /Occasion/ }));
    await screen.findByTestId('wizard-step-occasion');

    // The header's back-affordance now reads Cancel again (Step 1), proving
    // the jump landed for real, not just a visual highlight.
    expect(screen.getByText('✕ Cancel')).toBeInTheDocument();

    // The name/dates entered before going back are untouched in storage.
    const stored = await store.load('seeded-draft');
    expect(stored?.name).toBe('Weekend in Point Reyes');
    expect(stored?.step).toBe('occasion');

    // Basics' own indicator is NOT clickable from here — it's ahead of the
    // current step, and clicking it would offer a jump `SetupWizard`'s own
    // landing rule immediately bounces back from (Codex P2, PR #840, round
    // 2). It's a plain <span>, not a <button>, once occasion is current
    // again.
    expect(screen.queryByRole('button', { name: /Basics/ })).not.toBeInTheDocument();
    expect(screen.getByText('Basics')).toBeInTheDocument();

    // Continue is how forward motion actually happens.
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('wizard-step-placeholder-basics');
  });

  it('the header back-chevron steps back exactly one step, labelled with the previous step', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    await user.click(screen.getByRole('button', { name: '‹ Occasion' }));
    await screen.findByTestId('wizard-step-occasion');
  });
});

describe('step indicator inertness (Codex P2, PR #840, round 2)', () => {
  it('does not offer a later step as clickable just because IT independently has no issues yet', async () => {
    // Occasion + Basics done; Squares is the first incomplete step (a
    // daily-cards draft with no Days and no Prompts — `no-days` and
    // `pool-below-minimum`). Look, however, has NOTHING to complain about
    // YET: no Days means `dayCompletenessIssues`/`firstUnlockIssues` have
    // nothing to walk, and a valid `defaultTheme` clears the rest — so
    // Look's OWN gate reads satisfied even though the organizer is nowhere
    // near it.
    await seedDraft({
      step: 'squares',
      occasion: 'weekend-away',
      edition: 'vacay',
      name: 'Weekend in Point Reyes',
      startsOn: '2026-08-07',
      endsOn: '2026-08-09',
      timezone: 'America/Los_Angeles',
      slugCandidate: 'point-reyes',
      defaultTheme: 'the-birds',
    });
    renderApp(setupStepPath('seeded-draft', 'squares'));
    // Squares is a real step body now (#791) rather than a placeholder; these
    // assertions only ever meant "the wizard landed on Squares".
    await screen.findByTestId('setup-step-squares');

    expect(screen.queryByRole('button', { name: /Look/ })).not.toBeInTheDocument();
    expect(screen.getByText('Look')).toBeInTheDocument();
  });
});

describe('Cancel', () => {
  it('discards an empty draft without ceremony', async () => {
    const user = userEvent.setup();
    await seedDraft(); // nothing entered
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

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
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByText('✕ Cancel'));
    const dialog = await screen.findByRole('alertdialog', { name: /discard this draft/i });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-step-occasion')).toBeInTheDocument();
    expect(await store.load('seeded-draft')).not.toBeNull();

    await user.click(screen.getByText('✕ Cancel'));
    const dialogAgain = await screen.findByRole('alertdialog');
    await user.click(within(dialogAgain).getByRole('button', { name: 'Discard' }));

    await screen.findByTestId('fallback-page');
    expect(await store.load('seeded-draft')).toBeNull();
  });

  it('does not navigate away when discard does not actually take (Codex P2, PR #840, round 2)', async () => {
    const workingStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', workingStorage);
    await seedDraft(); // empty — the no-ceremony path
    // Freeze AFTER seeding: the load on mount still succeeds (reads the
    // snapshot), but the subsequent `discard`'s `removeItem` is a no-op, so
    // the draft never actually leaves storage.
    vi.stubGlobal('localStorage', new FrozenStorage(workingStorage));
    const user = userEvent.setup();
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByText('✕ Cancel'));

    await screen.findByRole('alert');
    expect(screen.getByText(/couldn't discard/i)).toBeInTheDocument();
    // Stayed put — never claimed success by leaving for the fallback page.
    expect(screen.queryByTestId('fallback-page')).not.toBeInTheDocument();
    expect(await store.load('seeded-draft')).not.toBeNull();
  });

  it('Escape requests Cancel from any step, not only Step 1', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByTestId('wizard-step-placeholder-basics');

    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
  });

  it('Escape while OccasionStep\'s re-selection confirm is open closes ONLY that dialog, never stacking the unrelated discard confirm on top of it (Codex P1, PR #855 Phase 4b round 1)', async () => {
    // WizardChrome owns its own document-level Escape -> Cancel listener,
    // registered for the whole time the wizard is mounted. Without
    // OccasionChangeConfirm's own capture-phase Escape handling, the SAME
    // keypress that should just close the occasion-switch confirm would ALSO
    // reach WizardChrome's listener and open the (unrelated) discard-draft
    // confirm on top of it -- two stacked aria-modal dialogs at once.
    const user = userEvent.setup();
    await seedDraft({ occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByRole('button', { name: /^Wedding/ }));
    await screen.findByRole('alertdialog', { name: /switch to.*wedding/i });

    await user.keyboard('{Escape}');

    // Closed -- and not replaced by a SECOND dialog.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // The draft is untouched (Escape behaved like "Keep Weekend away").
    const stored = await store.load('seeded-draft');
    expect(stored?.occasion).toBe('weekend-away');
  });
});

describe('Save draft (local)', () => {
  it('is a direct save trigger, not the only writer', async () => {
    const user = userEvent.setup();
    await seedDraft();
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByRole('button', { name: 'Save draft (local)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('is hidden on the terminal Launch step', async () => {
    await seedDraft({
      step: 'launch',
      occasion: 'weekend-away',
      edition: 'vacay',
      name: 'Weekend in Point Reyes',
      startsOn: futureIsoDate(60),
      endsOn: futureIsoDate(62),
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
          date: futureIsoDate(60),
          unlockAt: Date.parse(`${futureIsoDate(60)}T13:00:00Z`),
          place: 'Point Reyes',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'easy',
          tutorial: false,
          tonight: ['🦀 Crab shack', '🔥 Fire pit'],
        },
        {
          index: 1,
          date: futureIsoDate(62),
          unlockAt: Date.parse(`${futureIsoDate(62)}T13:00:00Z`),
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

describe('storage failure (Codex P1, PR #840)', () => {
  it('creating a fresh draft surfaces a retry instead of navigating to a draft that will never load', async () => {
    vi.stubGlobal('localStorage', new WriteBlackHoleStorage());
    renderApp('/setup');

    await screen.findByRole('alert');
    expect(screen.getByText(/couldn't start a new event/i)).toBeInTheDocument();
    // Never redirected into the missing-draft/"/setup" loop the unverified
    // save used to produce — the fallback Card page never mounted, and
    // there's no stray draft to have created it from either way.
    expect(screen.queryByTestId('fallback-page')).not.toBeInTheDocument();
  });

  it('"Save draft (local)" reports failure rather than claiming Saved when the write does not round-trip', async () => {
    // Seed successfully against a real working store...
    const workingStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', workingStorage);
    await seedDraft();
    // ...then freeze it: reads keep returning the draft as it was at that
    // moment, but every subsequent write is silently discarded — quota
    // exhausted mid-edit, say. The load on mount still succeeds (the
    // snapshot has the draft), so this exercises the explicit-save path
    // specifically, not the initial-load path the previous test covers.
    vi.stubGlobal('localStorage', new FrozenStorage(workingStorage));
    const user = userEvent.setup();
    renderApp(setupStepPath('seeded-draft', 'occasion'));

    await screen.findByTestId('wizard-step-occasion');
    await user.click(screen.getByRole('button', { name: 'Save draft (local)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/couldn't save/i));
  });
});

describe('React.StrictMode (Codex P2, PR #840)', () => {
  it('creates exactly one draft on the dev mount → cleanup → mount replay', async () => {
    renderApp('/setup', { strict: true });
    await waitFor(async () => {
      const summaries = await store.list();
      expect(summaries).toHaveLength(1);
    });
  });
});

describe('CancelConfirmDialog focus (Codex P2, PR #840)', () => {
  it('focuses "Keep editing" on open, traps Tab between the two buttons, and restores focus on close', async () => {
    const user = userEvent.setup();
    await seedDraft({ occasion: 'custom' });
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    const cancelButton = await screen.findByText('✕ Cancel');
    cancelButton.focus();

    await user.click(cancelButton);
    const dialog = await screen.findByRole('alertdialog');
    const keepEditing = within(dialog).getByRole('button', { name: 'Keep editing' });
    const discard = within(dialog).getByRole('button', { name: 'Discard' });
    await waitFor(() => expect(keepEditing).toHaveFocus());

    await user.tab();
    expect(discard).toHaveFocus();
    await user.tab();
    expect(keepEditing).toHaveFocus();

    await user.click(keepEditing);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(cancelButton).toHaveFocus();
  });
});
