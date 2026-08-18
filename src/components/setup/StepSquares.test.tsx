import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DraftDayDef, EventDraft } from '../../types';
import { MIN_POOL } from '../../game/logic';
import { MAX_DAYS } from '../../data/draftValidation';
import { MAX_PROMPT_TEXT, createEventDraft } from '../../data/eventDraft';
import StepSquares from './StepSquares';

// Covers specs/event-setup-wizard.md § "Squares" (#791) — the UI half of the
// contract facts #785 catalogues: the per-ASSIGNED-pool minimum, spicy scoped
// to the main pool, a Day that is not a calendar date, `tutorial` independent
// of `pool`, and the ten-Day rules ceiling.

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function day(index: number, over: Partial<DraftDayDef> = {}): DraftDayDef {
  return {
    index,
    date: '2026-08-07',
    unlockAt: null,
    place: '',
    placeEmoji: '',
    theme: null,
    pool: 'main',
    tutorial: false,
    tonight: [],
    ...over,
  };
}

function mainPrompts(n: number, spicy = false) {
  return Array.from({ length: n }, (_unused, i) => ({ text: `main ${i}`, spicy }));
}

function curated(n: number, label: string) {
  return Array.from({ length: n }, (_unused, i) => ({ text: `${label} ${i}` }));
}

function draftWith(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...createEventDraft({ now: NOW, draftId: 'draft-1', timezone: 'America/Los_Angeles' }),
    occasion: 'weekend-away',
    edition: 'vacay',
    cardFormat: 'daily_cards',
    ...over,
  };
}

/** Renders the step behind the same `{ draft, updateDraft }` contract the
 *  shell hands it (`StepRenderProps`), holding the draft in state so a commit
 *  re-renders exactly as it does inside `SetupWizard`. Returns a getter for
 *  the current draft so a test can assert what was actually recorded. */
function renderStep(initial: EventDraft) {
  const seen = { draft: initial };
  function Harness() {
    const [draft, setDraft] = useState(initial);
    seen.draft = draft;
    return (
      <StepSquares
        draft={draft}
        updateDraft={(updater) => setDraft((previous) => updater(previous))}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, current: () => seen.draft };
}

function countText(pool: 'main' | 'easy' | 'closing') {
  return screen.getByTestId(`squares-count-${pool}`).textContent ?? '';
}

describe('the live per-pool minimum', () => {
  it('shows each assigned pool its own count against the minimum, with independent verdicts', () => {
    renderStep(
      draftWith({
        days: [day(0, { pool: 'easy' }), day(1), day(2, { pool: 'closing' })],
        prompts: { main: mainPrompts(32), easy: curated(28, 'easy'), closing: curated(26, 'closing') },
      }),
    );
    expect(countText('main')).toContain('32');
    expect(countText('main')).toContain('✓');
    expect(countText('easy')).toContain('28');
    expect(countText('easy')).toContain('✓');
    expect(countText('closing')).toContain('26');
    expect(countText('closing')).toContain('✓');
  });

  it('fails the closing pool BY NAME on a 62-total pack with 4 closing Prompts, never a passing total', () => {
    renderStep(
      draftWith({
        days: [day(0), day(1, { pool: 'closing' })],
        prompts: { main: mainPrompts(58), easy: [], closing: curated(4, 'closing') },
      }),
    );
    // The trap: 62 total clears any total-based check while the farewell card
    // cannot deal at all.
    expect(countText('main')).toContain('✓');
    expect(countText('closing')).toContain('4');
    expect(countText('closing')).toContain(`needs ${MIN_POOL}`);
    expect(countText('closing')).not.toContain('✓');
    // No verdict is ever attached to the 62 — the total is not rendered as a
    // number the organizer could read as a pass.
    expect(screen.queryByText(/62/)).toBeNull();
    // And the step says so in as many words, so the shortfall does not read
    // as "nearly there" against a pack that is large overall.
    expect(screen.getByText(/A total is not enough/)).toBeTruthy();
  });

  it('reports an unassigned pool as idle rather than passing', () => {
    // A one-card Event deals from main alone. Four closing Prompts are not
    // "failing" — nothing deals from them — but they are not a ✓ either.
    renderStep(
      draftWith({
        cardFormat: 'one_card',
        days: [],
        prompts: { main: mainPrompts(MIN_POOL), easy: [], closing: curated(4, 'closing') },
      }),
    );
    expect(countText('main')).toContain('✓');
    expect(countText('closing')).toContain('no Day deals from it');
    expect(countText('closing')).not.toContain('✓');
  });

  it('counts real entries, so a sparse pool cannot show a passing number', async () => {
    const holed = [...mainPrompts(MIN_POOL)];
    // eslint-disable-next-line @typescript-eslint/no-array-delete, @typescript-eslint/no-dynamic-delete
    delete holed[3];
    renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: holed, easy: [], closing: curated(MIN_POOL, 'closing') },
      }),
    );
    expect(holed).toHaveLength(MIN_POOL);
    expect(countText('main')).toContain(String(MIN_POOL - 1));
    // The gap is visible AND repairable — nothing else in the app can reach it.
    const gap = screen.getByText('Prompt 4 is missing');
    expect(gap).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove the gap at Prompt 4 in the main pool' }),
    );
    expect(screen.queryByText('Prompt 4 is missing')).toBeNull();
  });
});

describe('spicy is main-pool only', () => {
  it('offers the toggle for a main add, defaulted off, and records it', async () => {
    const { current } = renderStep(draftWith({ days: [day(0, { pool: 'closing' })] }));
    const spicy = screen.getByRole('checkbox', { name: 'Spicy' });
    expect(spicy).not.toBeChecked();
    await userEvent.type(screen.getByLabelText('New Prompt text'), 'Karaoke duet');
    await userEvent.click(spicy);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(current().prompts.main).toEqual([{ text: 'Karaoke duet', spicy: true }]);
  });

  it('renders NO spicy control for easy or closing, and says why', async () => {
    renderStep(draftWith({ days: [day(0, { pool: 'closing' })] }));
    for (const pool of ['easy', 'closing']) {
      await userEvent.selectOptions(screen.getByLabelText('Pool'), pool);
      // Absent, not disabled: a control that renders and does nothing is the
      // "looks honoured, silently dropped" shape #785 warns about.
      expect(screen.queryByRole('checkbox', { name: 'Spicy' })).toBeNull();
      expect(screen.getByText('off · main only')).toBeTruthy();
    }
  });

  it('drops a flag tapped before the pool changed, rather than letting it ride along', async () => {
    const { current } = renderStep(draftWith({ days: [day(0, { pool: 'closing' })] }));
    await userEvent.type(screen.getByLabelText('New Prompt text'), 'Explicit inside joke');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Spicy' }));
    await userEvent.selectOptions(screen.getByLabelText('Pool'), 'closing');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(current().prompts.closing).toEqual([{ text: 'Explicit inside joke' }]);
    expect('spicy' in current().prompts.closing[0]!).toBe(false);
  });

  it('lets an existing main-pool flag be corrected, since the 18+ posture derives from it', async () => {
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: [{ text: 'Ambiguous', spicy: true }], easy: [], closing: [] },
      }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Spicy — Prompt 1 in the main pool' }),
    );
    expect(current().prompts.main).toEqual([{ text: 'Ambiguous', spicy: false }]);
  });
});

describe('prompt CRUD', () => {
  it('edits a row inline and deletes another', async () => {
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: mainPrompts(2), easy: [], closing: [] },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 1 in the main pool' }));
    const input = screen.getByRole('textbox', { name: 'Edit Prompt 1 in the main pool' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Walk to a Chimney Rock viewpoint');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(current().prompts.main[0]).toEqual({
      text: 'Walk to a Chimney Rock viewpoint',
      spicy: false,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Delete Prompt 2 in the main pool' }));
    expect(current().prompts.main).toHaveLength(1);
  });

  it('closes an open editor when a delete slides a different Prompt into that row', async () => {
    // Rows are keyed by position (Prompt text is not unique — duplicates are
    // allowed), so deleting an earlier row moves a DIFFERENT Prompt under an
    // open editor. Leaving it open would let Save overwrite that Prompt with
    // the previous one's draft.
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: mainPrompts(3), easy: [], closing: [] },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 2 in the main pool' }));
    const input = screen.getByRole('textbox', { name: 'Edit Prompt 2 in the main pool' });
    await userEvent.clear(input);
    await userEvent.type(input, 'a draft that must not leak');

    await userEvent.click(screen.getByRole('button', { name: 'Delete Prompt 1 in the main pool' }));
    // Position 1 now holds 'main 2'. The editor is closed and nothing leaked.
    // Scoped to the inline editors — the add bar is a textbox too, and it is
    // always present.
    expect(screen.queryByRole('textbox', { name: /^Edit Prompt/ })).toBeNull();
    expect(current().prompts.main).toEqual([
      { text: 'main 1', spicy: false },
      { text: 'main 2', spicy: false },
    ]);
  });

  it('keeps Escape in the inline editor away from the wizard-wide Cancel listener', async () => {
    // `WizardChrome` holds a document-level Escape listener that requests
    // Cancel on the whole draft. Backing out of a text edit must not ask the
    // organizer whether to discard the entire Event (Codex P2, round 1).
    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape);
    try {
      renderStep(
        draftWith({
          days: [day(0, { pool: 'closing' })],
          prompts: { main: mainPrompts(1), easy: [], closing: [] },
        }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 1 in the main pool' }));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('textbox', { name: /^Edit Prompt/ })).toBeNull();
      expect(documentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentEscape);
    }
  });

  it('does not commit an Enter that is only confirming an IME composition', () => {
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: mainPrompts(1), easy: [], closing: [] },
      }),
    );
    const addInput = screen.getByLabelText('New Prompt text');
    fireEvent.change(addInput, { target: { value: 'はじめ' } });
    // The Enter that confirms the composition — not a submit.
    fireEvent.keyDown(addInput, { key: 'Enter', isComposing: true });
    expect(current().prompts.main).toHaveLength(1);
    expect(addInput).toHaveValue('はじめ');
    // The Enter that follows the composition IS a submit.
    fireEvent.keyDown(addInput, { key: 'Enter' });
    expect(current().prompts.main).toHaveLength(2);
    expect(current().prompts.main[1]).toEqual({ text: 'はじめ', spicy: false });
  });

  it('caps both inputs at the shared persisted bound rather than a literal', () => {
    renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: mainPrompts(1), easy: [], closing: [] },
      }),
    );
    expect(screen.getByLabelText('New Prompt text')).toHaveAttribute(
      'maxLength',
      String(MAX_PROMPT_TEXT),
    );
  });

  it('closes an open editor even when the Prompt sliding in reads identically', async () => {
    // Text is not an identity: duplicates are explicitly allowed, so a
    // text-based reset would miss a swap between two same-reading Prompts and
    // Save would rename the wrong one (Codex P2, round 2).
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: {
          main: [
            { text: 'same', spicy: false },
            { text: 'same', spicy: false },
            { text: 'same', spicy: false },
          ],
          easy: [],
          closing: [],
        },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 2 in the main pool' }));
    const input = screen.getByRole('textbox', { name: 'Edit Prompt 2 in the main pool' });
    await userEvent.clear(input);
    await userEvent.type(input, 'renamed');

    await userEvent.click(screen.getByRole('button', { name: 'Delete Prompt 1 in the main pool' }));
    expect(screen.queryByRole('textbox', { name: /^Edit Prompt/ })).toBeNull();
    expect(current().prompts.main).toEqual([
      { text: 'same', spicy: false },
      { text: 'same', spicy: false },
    ]);
  });

  it('keeps an open editor when an unrelated row changes', async () => {
    // The flip side: the transforms preserve the object of every entry they do
    // not touch, so a row nobody edited must not lose a half-typed draft.
    renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: mainPrompts(2), easy: [], closing: [] },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 1 in the main pool' }));
    const input = screen.getByRole('textbox', { name: 'Edit Prompt 1 in the main pool' });
    await userEvent.clear(input);
    await userEvent.type(input, 'still being typed');

    // Toggle spicy on the OTHER row — a different entry entirely.
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Spicy — Prompt 2 in the main pool' }),
    );
    expect(screen.getByRole('textbox', { name: 'Edit Prompt 1 in the main pool' })).toHaveValue(
      'still being typed',
    );
  });

  it('shows spicy as a static chip while its own row is being edited, so a rename is not lost', async () => {
    // Toggling spicy replaces the row's entry object, which the identity
    // check cannot tell apart from a different Prompt sliding in — so the
    // editor would close and discard a half-typed rename (Codex P2, round 3).
    // Reading the flag stays available; setting it waits for Save/Cancel.
    renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: { main: [{ text: 'Karaoke duet', spicy: true }], easy: [], closing: [] },
      }),
    );
    expect(screen.getByRole('checkbox', { name: 'Spicy — Prompt 1 in the main pool' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Edit Prompt 1 in the main pool' }));
    const input = screen.getByRole('textbox', { name: 'Edit Prompt 1 in the main pool' });
    await userEvent.clear(input);
    await userEvent.type(input, 'half typed rename');

    expect(screen.queryByRole('checkbox', { name: 'Spicy — Prompt 1 in the main pool' })).toBeNull();
    expect(screen.getByLabelText('Spicy — Prompt 1 in the main pool')).toHaveTextContent('on');
    // The draft survived, and the toggle comes back once the edit is done.
    expect(input).toHaveValue('half typed rename');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('checkbox', { name: 'Spicy — Prompt 1 in the main pool' })).toBeChecked();
  });

  it('flags repeated wording without blocking on it', async () => {
    const { current } = renderStep(
      draftWith({
        days: [day(0, { pool: 'closing' })],
        prompts: {
          main: [
            { text: 'Karaoke duet', spicy: false },
            { text: 'karaoke duet', spicy: false },
          ],
          easy: [],
          closing: [],
        },
      }),
    );
    expect(screen.getByText(/Repeated wording/)).toHaveTextContent('Karaoke duet');
    expect(screen.getByText(/Repeated wording/)).toHaveTextContent('Not a blocker');
    // Advisory only — the duplicate stays, and nothing was rewritten.
    expect(current().prompts.main).toHaveLength(2);
  });

  it('caps the add input at the persisted 80-character item contract', () => {
    renderStep(draftWith({ days: [day(0, { pool: 'closing' })] }));
    expect(screen.getByLabelText('New Prompt text')).toHaveAttribute('maxLength', '80');
  });
});

describe('pack seeding', () => {
  it('states plainly that no pack is bound rather than offering a seed with nothing behind it', () => {
    // Every `OccasionDef.starterPackId` is null today (#786 Decision 2).
    renderStep(draftWith({ days: [day(0, { pool: 'closing' })] }));
    expect(screen.getByTestId('squares-pack-empty')).toHaveTextContent('No starter pack yet');
    expect(screen.queryByRole('button', { name: 'Seed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });
});

describe('Days & pools', () => {
  it('records tutorial: false on an easy-pool Day — the pool did not decide it', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0, { pool: 'easy', tutorial: true }), day(1, { pool: 'closing' })] }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Day 1 counts toward First to BINGO'),
      'counts',
    );
    expect(current().days[0]).toMatchObject({ pool: 'easy', tutorial: false });
  });

  it('leaves tutorial alone when the pool changes', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0, { pool: 'main', tutorial: true }), day(1, { pool: 'closing' })] }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Day 1 pool'), 'easy');
    expect(current().days[0]).toMatchObject({ pool: 'easy', tutorial: true });
  });

  it('keeps two Days that share one date as two Days', async () => {
    // Bodega's Sunday: a competitive main Day at 06:00 and a closing wrap-up
    // at 11:00. Collapsing the date would delete the competitive card.
    const { current } = renderStep(
      draftWith({
        days: [
          day(0, { date: '2026-08-08' }),
          day(1, { date: '2026-08-09' }),
          day(2, { date: '2026-08-09' }),
        ],
      }),
    );
    expect(screen.getAllByTestId(/^squares-day-/)).toHaveLength(3);
    await userEvent.selectOptions(screen.getByLabelText('Day 3 pool'), 'closing');
    expect(current().days).toHaveLength(3);
    expect(current().days[1]).toMatchObject({ date: '2026-08-09', pool: 'main' });
    expect(current().days[2]).toMatchObject({ date: '2026-08-09', pool: 'closing' });
  });

  it('names the consequence when the final Day carries no closing pool', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0, { pool: 'easy' }), day(1, { pool: 'closing' })] }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Day 2 pool'), 'main');

    const row = screen.getByTestId('squares-day-1');
    expect(within(row).getByLabelText('Day 2 problems')).toHaveTextContent(
      /the finale never runs/i,
    );
    // The full consequence — what "the finale never runs" actually costs — is
    // stated in the step, not left to the organizer to infer.
    expect(screen.getByText(/no standings freeze, no podium, no/i)).toBeTruthy();
    expect(current().days[1]!.pool).toBe('main');
  });

  it('anchors an out-of-place closing Day to its own row', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0), day(1), day(2, { pool: 'closing' })] }),
    );
    // Move the finale onto the middle Day: the final Day now has no closing
    // pool AND the middle one would silently become the finale.
    await userEvent.selectOptions(screen.getByLabelText('Day 2 pool'), 'closing');
    await userEvent.selectOptions(screen.getByLabelText('Day 3 pool'), 'main');
    expect(current().days.map((d) => d.pool)).toEqual(['main', 'closing', 'main']);
    expect(within(screen.getByTestId('squares-day-1')).getByLabelText('Day 2 problems')).toHaveTextContent(
      /FIRST closing Day/,
    );
    expect(within(screen.getByTestId('squares-day-2')).getByLabelText('Day 3 problems')).toHaveTextContent(
      /assign it the closing pool/,
    );
  });

  it('adds a Day without moving the closing pool off the Day that holds it', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0), day(1, { pool: 'closing', tutorial: true })] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add a Day' }));
    expect(current().days).toHaveLength(3);
    expect(current().days[1]).toMatchObject({ pool: 'closing', tutorial: true });
    expect(current().days[2]).toMatchObject({ index: 2, pool: 'main', tutorial: false });
  });

  it('renders a sparse Day slot as a removable gap row', async () => {
    // `map` SKIPS holes rather than passing undefined, so the gap branch was
    // unreachable and a sparse schedule showed no gap at all — the gate
    // reported it while the only surface that could repair it stayed silent
    // (Codex P2, round 2).
    const holed = [day(0), , day(1, { pool: 'closing' })] as unknown as DraftDayDef[];
    const { current } = renderStep(draftWith({ days: holed }));
    expect(screen.getByText('Day 2 is missing')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove the gap at Day 2' }));
    expect(screen.queryByText('Day 2 is missing')).toBeNull();
    expect(current().days.map((d) => d.index)).toEqual([0, 1]);
  });

  it('removes a Day and renumbers the rest', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0), day(1), day(2, { pool: 'closing' })] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Day 2' }));
    expect(current().days.map((d) => d.index)).toEqual([0, 1]);
    expect(current().days[1]!.pool).toBe('closing');
  });

  it('blocks an eleventh Day and explains the rules ceiling rather than just refusing', async () => {
    const { current } = renderStep(
      draftWith({
        days: Array.from({ length: MAX_DAYS }, (_unused, i) =>
          day(i, i === MAX_DAYS - 1 ? { pool: 'closing' } : {}),
        ),
      }),
    );
    const add = screen.getByRole('button', { name: 'Add a Day' });
    expect(add).toBeDisabled();
    await userEvent.click(add);
    expect(current().days).toHaveLength(MAX_DAYS);
    // The refusal carries its reason: the Firestore schedule lock, not taste.
    const reason = screen.getByRole('status');
    expect(reason).toHaveTextContent(`${MAX_DAYS}-Day maximum`);
    expect(reason).toHaveTextContent('daysThemeLockOk');
    expect(reason).toHaveTextContent(`0–${MAX_DAYS - 1}`);
  });
});

describe('card format', () => {
  it('warns before clearing an authored schedule, and keeps it if the organizer declines', async () => {
    const { current } = renderStep(
      draftWith({ days: [day(0), day(1, { pool: 'closing' })] }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'One card' }));
    expect(current().days).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('2 Days');
    await userEvent.click(screen.getByRole('button', { name: 'Keep daily cards' }));
    expect(current()).toMatchObject({ cardFormat: 'daily_cards' });
    expect(current().days).toHaveLength(2);
  });

  it('clears the schedule once confirmed, because a one-card Event IS an empty days[]', async () => {
    const { current } = renderStep(draftWith({ days: [day(0), day(1, { pool: 'closing' })] }));
    await userEvent.click(screen.getByRole('button', { name: 'One card' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Days' }));
    expect(current().cardFormat).toBe('one_card');
    expect(current().days).toEqual([]);
    // The Days & pools section goes with it — a one-card Event has no schedule.
    expect(screen.queryByLabelText('Days')).toBeNull();
  });

  it("switches back by proposing the occasion's schedule shape, with no unlock instants borrowed", async () => {
    const { current } = renderStep(draftWith({ cardFormat: 'one_card', days: [] }));
    await userEvent.click(screen.getByRole('button', { name: 'Daily cards' }));
    // Weekend away: 4 Days, easy opener that counts, closing finale.
    expect(current().days.map((d) => d.pool)).toEqual(['easy', 'main', 'main', 'closing']);
    expect(current().days.every((d) => d.unlockAt === null)).toBe(true);
    expect(screen.getByRole('button', { name: /Daily cards · 4 Days/ })).toBeTruthy();
  });
});
