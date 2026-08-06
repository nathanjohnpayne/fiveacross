import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DayDef } from '../types';
import TutorialBanner, { TutorialTag } from './TutorialBanner';

// Covers specs/d15-tutorial-banners.md: the embark "How this works" banner,
// the farewell goodbye banner, and the "Warm-up" tag (daily-cards-spec §§
// "Embark (tutorial) view" / "Farewell view").

function day(overrides: Partial<DayDef> & Pick<DayDef, 'index' | 'pool' | 'tutorial'>): DayDef {
  return {
    date: '2026-07-15',
    place: 'Trieste',
    placeEmoji: '🇮🇹',
    theme: 'welcome-aboard',
    tonight: [],
    unlockAt: 0,
    ...overrides,
  };
}

const EMBARK_DAY = day({ index: 0, pool: 'easy', tutorial: true, theme: 'welcome-aboard' });
const FAREWELL_DAY = day({
  index: 9,
  pool: 'closing',
  tutorial: true,
  theme: 'so-long-farewell',
  place: 'Barcelona',
  placeEmoji: '🇪🇸',
});
const MAIN_DAY = day({ index: 2, pool: 'main', tutorial: false, theme: 'get-sporty', place: 'Split' });

describe('TutorialBanner — embark banner', () => {
  it('renders all three beats + the warm-up caption on the Welcome Aboard Day', () => {
    render(<TutorialBanner day={EMBARK_DAY} />);
    expect(
      screen.getByText('Mark what happens. Tap a square when you see it, do it, or survive it.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Five in a row is BINGO. The center is free. Blackout the card if you're ambitious.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The feed is the proof. Attach a pic, doubt a friend, watch the Moments roll in.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This one's a warm-up—easy squares, all on the ship. The real chaos starts tomorrow at 8.",
      ),
    ).toBeInTheDocument();
  });

  it('dismisses on tap of the dismiss button', () => {
    render(<TutorialBanner day={EMBARK_DAY} />);
    const dismissButton = screen.getByRole('button', { name: /dismiss how this works banner/i });
    fireEvent.click(dismissButton);
    expect(screen.queryByText(/mark what happens/i)).not.toBeInTheDocument();
  });

  it('keeps the beats and caption as plain readable text, not folded into the dismiss button name', () => {
    render(<TutorialBanner day={EMBARK_DAY} />);
    const dismissButton = screen.getByRole('button', { name: /dismiss how this works banner/i });
    expect(dismissButton).toHaveAccessibleName(/dismiss how this works banner/i);
    expect(dismissButton).not.toHaveAccessibleName(/mark what happens/i);
    // The title/beats/caption remain in the document as static text, not
    // absorbed into the button's accessible name.
    expect(screen.getByText('How this works')).toBeInTheDocument();
  });

  it('stays dismissed across a Day-switcher round trip within the same session', () => {
    const { rerender } = render(<TutorialBanner day={EMBARK_DAY} />);
    const dismissButton = screen.getByRole('button', { name: /dismiss how this works banner/i });
    fireEvent.click(dismissButton);
    expect(screen.queryByText(/mark what happens/i)).not.toBeInTheDocument();

    // Viewing another Day, then coming back to the Welcome Aboard Day —
    // TutorialBanner stays mounted at the same position (as it does under
    // Board), so its dismissal state must survive EmbarkBanner unmounting.
    rerender(<TutorialBanner day={MAIN_DAY} />);
    rerender(<TutorialBanner day={EMBARK_DAY} />);
    expect(screen.queryByText(/mark what happens/i)).not.toBeInTheDocument();
  });

  it('does not render on any non-tutorial Day', () => {
    render(<TutorialBanner day={MAIN_DAY} />);
    expect(screen.queryByText(/mark what happens/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /how this works/i })).not.toBeInTheDocument();
  });
});

describe('TutorialBanner — farewell banner', () => {
  it('renders the goodbye copy on the So Long, Farewell Day, with no dismiss affordance', () => {
    render(<TutorialBanner day={FAREWELL_DAY} />);
    expect(
      screen.getByText('Last one. Mark your goodbyes—then go book next year.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not render on any non-tutorial Day', () => {
    render(<TutorialBanner day={MAIN_DAY} />);
    expect(screen.queryByText(/mark your goodbyes/i)).not.toBeInTheDocument();
  });
});

describe('TutorialTag', () => {
  it('renders "Warm-up" for the easy pool', () => {
    render(<TutorialTag pool="easy" />);
    expect(screen.getByText('Warm-up')).toBeInTheDocument();
  });

  it('renders "Goodbye" for the closing pool (#260 — the wireframes Day-10 tag)', () => {
    render(<TutorialTag pool="closing" />);
    expect(screen.getByText('Goodbye')).toBeInTheDocument();
  });
});
