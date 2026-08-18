import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TomorrowsCardInvite from './TomorrowsCardInvite';
import type { DayDef } from '../types';

// #559: the "put it on tomorrow's card" entry point, mounted on both the
// Card (Board.tsx) and the Feed (ProofFeed.tsx). Pure over its props, so this
// suite exercises the ONE shared component rather than duplicating the
// visibility assertion per caller.

const day = (index: number, over: Partial<DayDef> = {}): DayDef =>
  ({
    index,
    unlockAt: 1000,
    pool: 'main',
    ...over,
  }) as DayDef;

describe('TomorrowsCardInvite (#559)', () => {
  it('renders the invitation when at least one Day is still targetable', () => {
    render(<TomorrowsCardInvite days={[day(2, { unlockAt: 5000 })]} now={0} onOpen={vi.fn()} />);
    expect(screen.getByText(/put it on tomorrow.s card/i)).toBeInTheDocument();
  });

  it('renders nothing on a schedule-less (legacy) Event', () => {
    const { container } = render(<TomorrowsCardInvite days={[]} now={0} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once every Day has closed — no later eligible Day remains', () => {
    const days = [day(0, { unlockAt: 100, snapshotItemIds: ['x'] }), day(1, { unlockAt: 50 })];
    const { container } = render(<TomorrowsCardInvite days={days} now={9999} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once every Day has already frozen its snapshot, even with time to spare', () => {
    const days = [day(0, { unlockAt: 9999, snapshotItemIds: [] })];
    const { container } = render(<TomorrowsCardInvite days={days} now={0} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onOpen when tapped — the hand-off to Suggest, not a forked submission form', () => {
    const onOpen = vi.fn();
    render(<TomorrowsCardInvite days={[day(2, { unlockAt: 5000 })]} now={0} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('never renders the retired "bingo moment" phrase (CONTEXT.md § Community Prompt)', () => {
    render(<TomorrowsCardInvite days={[day(2, { unlockAt: 5000 })]} now={0} onOpen={vi.fn()} />);
    expect(screen.queryByText(/bingo moment/i)).not.toBeInTheDocument();
  });
});
