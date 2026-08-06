import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DayDef } from '../types';
import DaySwitcher, { dayStates, defaultViewedIndex } from './DaySwitcher';

// specs/d15-day-switcher.md: the ten-chip Day strip (daily-cards-spec §
// "Day switcher"). Covers chip ORDER and STATE (past ✓ / today filled /
// locked 🔒) — the glyph PREFIXES the chip's single-line pill content
// (#293) — the today-index derivation used to default the viewed Day,
// and that a tap — including a tap on a locked chip — only reports the
// index via `onSelect`, never writes anything (the "open the preview"
// behavior belongs entirely to the caller, Board).

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDays(count = 10, startUnlock = 0): DayDef[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    date: `2026-07-${String(15 + index).padStart(2, '0')}`,
    place: `Port ${index}`,
    placeEmoji: '🇭🇷',
    theme: 'get-sporty',
    tonight: [],
    pool: index === 0 ? 'embark' : index === count - 1 ? 'farewell' : 'main',
    tutorial: index === 0 || index === count - 1,
    unlockAt: startUnlock + index * DAY_MS,
  }));
}

describe('dayStates / defaultViewedIndex', () => {
  it('classifies past/today/locked from unlockAt vs now', () => {
    const days = makeDays();
    // now sits partway through Day 3 (index 3 is the latest unlocked Day).
    const now = days[3].unlockAt + 1000;
    const states = dayStates(days, now);
    expect(states).toEqual([
      'past',
      'past',
      'past',
      'today',
      'locked',
      'locked',
      'locked',
      'locked',
      'locked',
      'locked',
    ]);
    expect(defaultViewedIndex(days, now)).toBe(3);
  });

  it('falls back to Day 0 when the Event has not opened yet', () => {
    const days = makeDays(10, Date.now() + DAY_MS);
    const now = Date.now();
    expect(dayStates(days, now).every((s) => s === 'locked')).toBe(true);
    expect(defaultViewedIndex(days, now)).toBe(0);
  });
});

describe('<DaySwitcher />', () => {
  it('renders ten chips in Day order with the correct past/today/locked state per chip', () => {
    const days = makeDays();
    const now = days[3].unlockAt + 1000;
    render(<DaySwitcher days={days} viewedIndex={3} onSelect={vi.fn()} now={now} />);
    const chips = screen.getAllByRole('tab');
    expect(chips).toHaveLength(10);
    expect(chips[0]).toHaveClass('day-chip-past');
    expect(chips[1]).toHaveClass('day-chip-past');
    expect(chips[2]).toHaveClass('day-chip-past');
    expect(chips[3]).toHaveClass('day-chip-today');
    expect(chips[3]).toHaveClass('selected');
    for (let i = 4; i < 10; i++) {
      expect(chips[i]).toHaveClass('day-chip-locked');
      expect(chips[i].textContent).toContain('🔒');
    }
    // Past chips carry the ✓ glyph; today carries none.
    expect(chips[0].textContent).toContain('✓');
    expect(chips[3].textContent).not.toContain('✓');
    expect(chips[3].textContent).not.toContain('🔒');
    // #293: the state glyph PREFIXES the pill content — "✓ Wed 🇭🇷" /
    // "🔒 Fri 🇭🇷" — rather than trailing it.
    expect(chips[0].textContent?.startsWith('✓')).toBe(true);
    expect(chips[9].textContent?.startsWith('🔒')).toBe(true);
  });

  it('uses a per-Day port emoji instead of stacking the Theme emoji, with the Theme as fallback', () => {
    const days = makeDays(2);
    days[1]!.portEmoji = '';
    render(<DaySwitcher days={days} viewedIndex={0} onSelect={vi.fn()} now={0} />);
    const chips = screen.getAllByRole('tab');

    expect(chips[0]!.querySelector('.day-chip-port')?.textContent).toBe('🇭🇷');
    expect(chips[0]!.querySelector('.day-chip-theme')).toBeNull();
    expect(chips[1]!.querySelector('.day-chip-port')?.textContent).toBe('');
    expect(chips[1]!.querySelector('.day-chip-theme')?.textContent).toBe('🏋️');
  });

  it('tapping a locked chip only reports its index — it never marks or deals anything', () => {
    const days = makeDays();
    const now = days[3].unlockAt + 1000;
    const onSelect = vi.fn();
    render(<DaySwitcher days={days} viewedIndex={3} onSelect={onSelect} now={now} />);
    const chips = screen.getAllByRole('tab');
    fireEvent.click(chips[7]); // a locked chip
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it('tapping a past chip reports its index too', () => {
    const days = makeDays();
    const now = days[3].unlockAt + 1000;
    const onSelect = vi.fn();
    render(<DaySwitcher days={days} viewedIndex={3} onSelect={onSelect} now={now} />);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  // specs/d15-tutorial-banners.md: the "Warm-up" tag renders on exactly the
  // two tutorial Day chips (index 0 and the last index — `makeDays` seeds
  // `tutorial` there) and never on the eight main Days.
  it('renders "Warm-up" on the embark chip, "Goodbye" on the farewell chip, nothing on the eight main Days', () => {
    const days = makeDays();
    const now = days[3].unlockAt + 1000;
    render(<DaySwitcher days={days} viewedIndex={3} onSelect={vi.fn()} now={now} />);
    const chips = screen.getAllByRole('tab');
    expect(screen.getAllByText('Warm-up').length).toBe(1);
    expect(screen.getAllByText('Goodbye').length).toBe(1);
    expect(chips[0].textContent).toContain('Warm-up');
    expect(chips[days.length - 1].textContent).toContain('Goodbye');
    for (let i = 1; i < days.length - 1; i++) {
      expect(chips[i].textContent).not.toContain('Warm-up');
      expect(chips[i].textContent).not.toContain('Goodbye');
    }
  });

  // The chip's own aria-label overrides its descendant text for assistive
  // tech, so the "Warm-up" tag's visible label is otherwise unannounced —
  // fold the tutorial state into the chip's accessible name too.
  it('includes the tag in the accessible name of tutorial Day chips, and omits it on main Days', () => {
    const days = makeDays();
    const now = days[3].unlockAt + 1000;
    render(<DaySwitcher days={days} viewedIndex={3} onSelect={vi.fn()} now={now} />);
    const chips = screen.getAllByRole('tab');
    expect(chips[0]).toHaveAccessibleName(/warm-up/i);
    expect(chips[days.length - 1]).toHaveAccessibleName(/goodbye/i);
    for (let i = 1; i < days.length - 1; i++) {
      expect(chips[i]).not.toHaveAccessibleName(/warm-up/i);
      expect(chips[i]).not.toHaveAccessibleName(/goodbye/i);
    }
  });
});
