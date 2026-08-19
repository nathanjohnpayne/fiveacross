import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { EventDraft } from '../../types';
import { createEventDraft, createLocalDraftStore, type EventDraftStore } from '../../data/eventDraft';
import SetupWizard, { verifiedSave } from './SetupWizard';
import { setupStepPath } from './route';

// The Basics step (#790) pulls in `../../data/hostnames` for its live
// address check, and that module's top-level `import '../firebase'` calls
// `getAuth(app)` at MODULE LOAD TIME — throwing `auth/invalid-api-key` in
// this env-var-free test run. This file is deliberately "no Firebase" (see
// specs/event-setup-wizard.md § Test coverage), so the seam is stubbed to
// its one export the step actually calls, exactly like every OTHER
// step-owned dependency this shell-level suite never exercises directly.
// Resolves 'available': StepBasics's background re-check of an
// already-committed candidate (this suite seeds `slugCandidate` directly)
// downgrades it on anything else, and this suite runs in REAL time (no
// faked debounce), so a less generous stub would risk a flaky downgrade
// mid-test.
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

    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now
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
      slugVerifiedForEdition: 'vacay',
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
    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now

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
      slugVerifiedForEdition: 'vacay',
    });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now

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
      slugVerifiedForEdition: 'vacay',
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
    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now
  });

  it('the header back-chevron steps back exactly one step, labelled with the previous step', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now

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
      slugVerifiedForEdition: 'vacay',
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

  it('does not navigate away when storage becomes fully restricted — removeItem AND the verification read both fail (#848)', async () => {
    // The gap #848 describes, distinct from the FrozenStorage case above:
    // there, `removeItem` silently no-ops but `getItem` still honestly
    // reports the undeleted draft, so the OLD load()-only verification
    // already caught it. Here `removeItem` THROWS — and so does `getItem` —
    // so a load()-only verification would swallow BOTH into `null` and
    // misread that as "confirmed gone", even though the draft never left
    // storage and would reappear the moment access returns.
    class RestrictedStorage implements Storage {
      get length(): number {
        throw new Error('restricted');
      }
      clear() {
        throw new Error('restricted');
      }
      getItem(): string | null {
        throw new Error('restricted');
      }
      key(): string | null {
        throw new Error('restricted');
      }
      removeItem() {
        throw new Error('restricted');
      }
      setItem() {
        throw new Error('restricted');
      }
    }
    const workingStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', workingStorage);
    await seedDraft(); // empty — the no-ceremony path
    const user = userEvent.setup();
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

    // Storage becomes fully restricted only NOW — after the mount's own
    // load already succeeded — so both discard()'s removeItem AND
    // verifiedDiscard's readback throw.
    vi.stubGlobal('localStorage', new RestrictedStorage());

    await user.click(screen.getByText('✕ Cancel'));

    await screen.findByRole('alert');
    expect(screen.getByText(/couldn't discard/i)).toBeInTheDocument();
    // The OLD code read the restricted store's throw-swallowed `null` as
    // confirmation and navigated away anyway — this is what it got wrong.
    expect(screen.queryByTestId('fallback-page')).not.toBeInTheDocument();
    // The ORIGINAL storage still holds the draft — restricted access never
    // actually removed it.
    expect(workingStorage.getItem('gcb:event-draft:seeded-draft')).not.toBeNull();
  });

  it('does not navigate away when removal silently no-ops and only the verification read fails (#901)', async () => {
    class NoOpThenUnreadableStorage implements Storage {
      private removalAttempted = false;
      constructor(private readonly source: Storage) {}
      get length(): number {
        return this.source.length;
      }
      clear() {}
      getItem(key: string): string | null {
        if (this.removalAttempted) throw new Error('read access revoked after removal attempt');
        return this.source.getItem(key);
      }
      key(index: number): string | null {
        return this.source.key(index);
      }
      removeItem() {
        this.removalAttempted = true;
      }
      setItem() {}
    }

    const workingStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', workingStorage);
    await seedDraft();
    vi.stubGlobal('localStorage', new NoOpThenUnreadableStorage(workingStorage));
    const user = userEvent.setup();
    renderApp(setupStepPath('seeded-draft', 'occasion'));
    await screen.findByTestId('wizard-step-occasion');

    await user.click(screen.getByText('✕ Cancel'));

    await screen.findByRole('alert');
    expect(screen.getByText(/couldn't discard/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fallback-page')).not.toBeInTheDocument();
    expect(workingStorage.getItem('gcb:event-draft:seeded-draft')).not.toBeNull();
  });

  it('Escape requests Cancel from any step, not only Step 1', async () => {
    const user = userEvent.setup();
    await seedDraft({ step: 'basics', occasion: 'weekend-away', edition: 'vacay' });
    renderApp(setupStepPath('seeded-draft', 'basics'));
    await screen.findByLabelText('Event name'); // StepBasics (#790) has real content now

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
      slugVerifiedForEdition: 'vacay',
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

  it('"Save draft (local)" reports failure on a silent write EVEN WHEN updatedAt happens to match the stale blob (#847)', async () => {
    // A fixed clock throughout: `save()` stamps `updatedAt` from `Date.now()`,
    // so pinning it means the STALE (pre-freeze) blob and any LATER save
    // both stamp the exact SAME `updatedAt` — the collision an
    // updatedAt-only comparison cannot tell apart from a genuine write, and
    // the premise this test is pinning against regressing.
    const FIXED_NOW = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    try {
      const workingStorage = new MemoryStorage();
      vi.stubGlobal('localStorage', workingStorage);
      await seedDraft(); // stamps updatedAt = FIXED_NOW
      // Freeze AFTER seeding, same shape as the test above: reads keep
      // returning the pre-freeze snapshot, writes silently no-op.
      vi.stubGlobal('localStorage', new FrozenStorage(workingStorage));
      const user = userEvent.setup();
      renderApp(setupStepPath('seeded-draft', 'occasion'));
      await screen.findByTestId('wizard-step-occasion');

      // An in-memory edit that never actually persists — picking an
      // occasion updates REACT STATE immediately regardless of whether the
      // storage write underneath it took effect. `applyOccasionDefaults`
      // changes `occasion`/`edition`/`cardFormat`/`claimMode`/`defaultTheme`/
      // `settings` all at once, so the persisted (stale) blob and the
      // in-memory draft now disagree on plenty of fields — everything an
      // updatedAt-only check would miss.
      await user.click(screen.getByRole('button', { name: /^Weekend away/ }));

      await user.click(screen.getByRole('button', { name: 'Save draft (local)' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/couldn't save/i));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('verifiedSave (Codex P2, PR #894 round 1)', () => {
  // A hand-built store, not `createLocalDraftStore` — the scenario below
  // needs `save()` to return an object that still carries an EXPLICIT
  // `spicy: undefined` key while `load()` returns one where the key is
  // absent, which the real store's round trip normalizes away on the very
  // first load, before an explicit save could ever observe the divergence.
  function storeReturning(saved: EventDraft, readBack: EventDraft | null): EventDraftStore {
    return {
      list: vi.fn(),
      unreadable: vi.fn(),
      discard: vi.fn(),
      save: async () => saved,
      load: async () => readBack,
    };
  }

  it("does not mistake a curated Prompt's spicy: undefined for a failed write, when the readback correctly omits the key entirely", async () => {
    const draft = createEventDraft({ now: 0 });
    const saved: EventDraft = {
      ...draft,
      updatedAt: 500,
      prompts: {
        ...draft.prompts,
        // The documented curated-Prompt shape: `spicy` present, `undefined`
        // (eventDraft.ts's `isCuratedPrompt` doc comment) — this is what a
        // freshly-constructed in-memory draft can legitimately carry.
        easy: [{ text: 'Karaoke on the pool deck', spicy: undefined }],
      },
    };
    const readBack: EventDraft = {
      ...draft,
      updatedAt: 500,
      // `JSON.stringify` drops an explicitly-undefined property entirely —
      // this is what a GENUINELY successful write reads back as.
      prompts: { ...draft.prompts, easy: [{ text: 'Karaoke on the pool deck' } as (typeof draft.prompts.easy)[number]] },
    };

    const result = await verifiedSave(storeReturning(saved, readBack), draft);
    expect(result).not.toBeNull();
  });

  it('still reports failure for a GENUINE content mismatch, not just a coincidentally-matching timestamp (#847)', async () => {
    const draft = createEventDraft({ now: 0 });
    const saved: EventDraft = { ...draft, updatedAt: 500, name: 'A Wedding in Point Reyes' };
    // The readback disagrees on `name` — a stale blob — even though its
    // `updatedAt` happens to match what `save()` just stamped.
    const readBack: EventDraft = { ...draft, updatedAt: 500, name: 'a stale, unrelated name' };

    expect(await verifiedSave(storeReturning(saved, readBack), draft)).toBeNull();
  });

  it('reports failure when the readback is null', async () => {
    const draft = createEventDraft({ now: 0 });
    const saved: EventDraft = { ...draft, updatedAt: 500 };
    expect(await verifiedSave(storeReturning(saved, null), draft)).toBeNull();
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
