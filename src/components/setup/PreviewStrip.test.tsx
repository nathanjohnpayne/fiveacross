import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PreviewStrip from './PreviewStrip';
import { createEventDraft } from '../../data/eventDraft';
import { FREE_TEXT } from '../../data/seed';
import type { DraftDayDef, DraftMainPrompt, EventDraft } from '../../types';

// Covers specs/event-setup-wizard.md § "Live preview strip" (#795):
//   - the collapsed strip's caption and Theme swatch (previewCaption /
//     previewTheme — see src/data/draftPreview.test.ts for the pure-logic
//     coverage of the caption's own tiers; this file covers wiring it up)
//   - Open › expanding a full 5×5 sample card, dealt via the real dealBoard
//     path, deterministic across re-opens
//   - the pool-shortfall state (never a thrown error)
//   - live updates: the strip is presentational and re-renders from `draft`
//     alone, with no internal copy of draft state to go stale
//   - the scoped Theme island: the strip/sheet wear the draft's Theme while
//     `document.documentElement` (this test suite runs with no ThemeProvider
//     at all) is never touched — see src/theme/ThemeIsland.test.tsx for the
//     full app-global-untouched regression under a real ThemeProvider.

function mainPrompts(n: number): DraftMainPrompt[] {
  return Array.from({ length: n }, (_, i) => ({ text: `main prompt ${i}`, spicy: false }));
}

function day(overrides: Partial<DraftDayDef>): DraftDayDef {
  return {
    index: 0,
    date: '2026-08-07',
    unlockAt: Date.parse('2026-08-07T06:00:00-07:00'),
    place: 'Point Reyes',
    placeEmoji: '🌊',
    theme: null,
    pool: 'main',
    tutorial: false,
    tonight: ['A', 'B'],
    ...overrides,
  };
}

function draftWith(overrides: Partial<EventDraft>): EventDraft {
  return { ...createEventDraft({ now: 0 }), ...overrides };
}

describe('PreviewStrip — collapsed', () => {
  it('renders the generic caption before there is anything to preview, and never touches document.documentElement', () => {
    delete document.documentElement.dataset.theme;
    render(<PreviewStrip draft={createEventDraft({ now: 0 })} />);
    expect(screen.getByText('Live preview · updates as you build')).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('upgrades the caption to a squares count once a pack exists', () => {
    const draft = draftWith({ prompts: { main: mainPrompts(32), easy: [], closing: [] } });
    render(<PreviewStrip draft={draft} />);
    expect(screen.getByText('32 squares · deals 24 per day')).toBeInTheDocument();
  });

  it("wears the draft's Theme on its swatch via a scoped island, not the document", () => {
    const draft = draftWith({ days: [day({ index: 0, theme: 'the-birds' })] });
    render(<PreviewStrip draft={draft} />);
    expect(screen.getByTestId('wizard-prevbar-swatch').dataset.theme).toBe('the-birds');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('re-renders the caption when the draft prop changes — no stale internal copy', () => {
    const first = draftWith({ prompts: { main: mainPrompts(10), easy: [], closing: [] } });
    const { rerender } = render(<PreviewStrip draft={first} />);
    expect(screen.getByText('10 squares · deals 24 per day')).toBeInTheDocument();

    const second = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    rerender(<PreviewStrip draft={second} />);
    expect(screen.getByText('24 squares · deals 24 per day')).toBeInTheDocument();
  });
});

describe('PreviewStrip — expanded (Open ›)', () => {
  it('deals a full sample card on Open, and the same card again on a re-open (fixed seed)', async () => {
    const user = userEvent.setup();
    const draft = draftWith({
      prompts: { main: mainPrompts(24), easy: [], closing: [] },
      days: [day({ index: 0, pool: 'main', theme: 'marquee' })],
    });
    render(<PreviewStrip draft={draft} />);

    await user.click(screen.getByRole('button', { name: /Open/ }));
    const dialog = screen.getByRole('dialog', { name: 'Live preview' });
    const cellsFirst = within(dialog)
      .getAllByText(/^main prompt \d+$/)
      .map((el) => el.textContent);
    expect(cellsFirst).toHaveLength(24);
    expect(within(dialog).getByText(FREE_TEXT)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open/ }));
    const dialogAgain = screen.getByRole('dialog', { name: 'Live preview' });
    const cellsSecond = within(dialogAgain)
      .getAllByText(/^main prompt \d+$/)
      .map((el) => el.textContent);
    expect(cellsSecond).toEqual(cellsFirst);
  });

  it('shows the shortfall message instead of throwing when the assigned pool is too thin', async () => {
    const user = userEvent.setup();
    const draft = draftWith({
      prompts: { main: mainPrompts(5), easy: [], closing: [] },
      days: [day({ index: 0, pool: 'main' })],
    });
    render(<PreviewStrip draft={draft} />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.getByRole('status')).toHaveTextContent(/at least 24 prompts/);
  });

  it('closes on Escape and restores focus to the Open trigger', async () => {
    const user = userEvent.setup();
    const draft = draftWith({ prompts: { main: mainPrompts(24), easy: [], closing: [] } });
    render(<PreviewStrip draft={draft} />);
    const openButton = screen.getByRole('button', { name: /Open/ });
    await user.click(openButton);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();
  });

  it('offers a Day tab per Day on a daily_cards draft, and switching Days re-deals from that Day’s own pool', async () => {
    const user = userEvent.setup();
    const draft = draftWith({
      cardFormat: 'daily_cards',
      prompts: { main: mainPrompts(24), easy: [], closing: Array.from({ length: 24 }, (_, i) => ({ text: `closing prompt ${i}` })) },
      days: [
        day({ index: 0, date: '2026-08-07', pool: 'main', theme: 'marquee', place: 'Point Reyes' }),
        day({ index: 1, date: '2026-08-09', pool: 'closing', theme: 'afterglow', place: 'The drive home' }),
      ],
    });
    render(<PreviewStrip draft={draft} />);
    await user.click(screen.getByRole('button', { name: /Open/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Friday' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Sunday' })).toBeInTheDocument();
    // Defaults to the last themed Day (Sunday), matching previewDayForTheme.
    expect(within(dialog).getByText(/The drive home/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Friday' }));
    expect(within(dialog).getByText(/Point Reyes/)).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByText(/^main prompt \d+$/)
        .map((el) => el.textContent),
    ).toHaveLength(24);
  });

  it('renders no Day meta line for a one_card draft (no Day to name)', async () => {
    const user = userEvent.setup();
    const draft = draftWith({
      cardFormat: 'one_card',
      days: [],
      prompts: { main: mainPrompts(24), easy: [], closing: [] },
    });
    render(<PreviewStrip draft={draft} />);
    await user.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.queryByText(/🌊|🌅|🌫️/)).not.toBeInTheDocument();
  });
});
