import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import CachedCardFallback from './CachedCardFallback';
import type { CardSnapshot } from '../data/cardCache';
import type { Cell } from '../types';

function cell(index: number, over: Partial<Cell> = {}): Cell {
  return {
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: index === 12 ? 'Free space' : `Prompt ${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: index === 12 ? 1 : null,
    ...over,
  };
}

function snapshot(over: Partial<CardSnapshot> = {}): CardSnapshot {
  const cells = Array.from({ length: 25 }, (_, i) =>
    // mark squares 0 and 6 in addition to the free centre
    cell(i, i === 0 || i === 6 ? { marked: true, markedAt: 1 } : {}),
  );
  return {
    v: 1,
    uid: 'u1',
    eventId: 'med-2026',
    dayIndex: 2,
    savedAt: 1,
    bingoCount: 4,
    cells,
    day: { number: 3, place: 'Split', placeEmoji: '🇭🇷', theme: 'get-sporty', label: 'Get Sporty' },
    ...over,
  };
}

describe('CachedCardFallback', () => {
  it('paints the saved grid: BINGO head, 25 cells, the marked ones, and the free centre', () => {
    const { container } = render(
      <CachedCardFallback snapshot={snapshot()} onRetry={() => {}} retrying={false} />,
    );
    expect(container.querySelectorAll('.grid .cell')).toHaveLength(25);
    // free centre + squares 0 and 6 carry the marked class
    expect(container.querySelectorAll('.cell.marked')).toHaveLength(3);
    expect(container.querySelector('.cell.free')).not.toBeNull();
    expect(screen.getByText('Prompt 6')).toBeInTheDocument();
    expect(container.querySelector('.bingo-head')?.textContent).toBe('BINGO');
  });

  it('themes the board and shows the Day header from the snapshot', () => {
    const { container } = render(
      <CachedCardFallback snapshot={snapshot()} onRetry={() => {}} retrying={false} />,
    );
    expect(container.querySelector('.board-area')?.getAttribute('data-theme')).toBe('get-sporty');
    expect(screen.getByText(/Day 3 · Get Sporty/)).toBeInTheDocument();
    expect(screen.getByText(/Split/)).toBeInTheDocument();
  });

  it('shows the marked count and bingo tally from the snapshot', () => {
    const { container } = render(
      <CachedCardFallback snapshot={snapshot()} onRetry={() => {}} retrying={false} />,
    );
    const count = container.querySelector('.count')!;
    // countMarked excludes the free centre: squares 0 and 6 -> 2 marked; 4 bingos.
    expect(within(count as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(count as HTMLElement).getByText('4')).toBeInTheDocument();
  });

  it('offers a Retry that fires onRetry, and disables while retrying', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <CachedCardFallback snapshot={snapshot()} onRetry={onRetry} retrying={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<CachedCardFallback snapshot={snapshot()} onRetry={onRetry} retrying={true} />);
    const btn = screen.getByRole('button', { name: 'Dealing…' });
    expect(btn).toBeDisabled();
  });

  it('marks an admin_confirmed pending square with the pending class (not confirmed-looking)', () => {
    const cells = Array.from({ length: 25 }, (_, i) =>
      cell(i, i === 3 ? { marked: true, markedAt: 1, status: 'pending' } : {}),
    );
    const { container } = render(
      <CachedCardFallback snapshot={snapshot({ cells })} onRetry={() => {}} retrying={false} />,
    );
    const pending = container.querySelectorAll('.cell.marked.pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].textContent).toContain('Prompt 3');
  });

  // #559, Codex P2, PR #845 round 6: the saved snapshot carries
  // `Cell.communityPrompt` verbatim (it's part of the shape
  // `saveCardSnapshot` persists), so the durable offline/flaky-Wi-Fi view
  // must not be the one place the "new from the group" ring disappears.
  it('carries the community affordance from the saved snapshot', () => {
    const cells = Array.from({ length: 25 }, (_, i) =>
      cell(i, i === 4 ? { communityPrompt: true, suggestedBy: 'u-suggester' } : {}),
    );
    const { container } = render(
      <CachedCardFallback snapshot={snapshot({ cells })} onRetry={() => {}} retrying={false} />,
    );
    const community = container.querySelectorAll('.cell.community');
    expect(community).toHaveLength(1);
    expect(community[0].textContent).toContain('Prompt 4');
  });

  it('never marks the free centre as a community Square even if the snapshot somehow carries the flag there', () => {
    const cells = Array.from({ length: 25 }, (_, i) =>
      cell(i, i === 12 ? { communityPrompt: true } : {}),
    );
    const { container } = render(
      <CachedCardFallback snapshot={snapshot({ cells })} onRetry={() => {}} retrying={false} />,
    );
    expect(container.querySelector('.cell.free.community')).toBeNull();
  });

  it('renders a legacy single board (no Day header) when day is null', () => {
    const { container } = render(
      <CachedCardFallback snapshot={snapshot({ day: null })} onRetry={() => {}} retrying={false} />,
    );
    expect(container.querySelector('.daybar')).toBeNull();
    expect(container.querySelector('.grid .cell')).not.toBeNull();
    expect(container.querySelector('.board-area')?.getAttribute('data-theme')).toBeNull();
  });
});
