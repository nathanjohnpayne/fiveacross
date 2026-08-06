import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// specs/reshuffle.md — the confirm sheet (#378, wireframes #frame-reshuffle).
// The copy is asserted VERBATIM: it is the sheet's whole job to make a
// non-refundable, irreversible spend legible before it happens, so a silent
// reword is a regression, not a tweak.

const H = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../data/api', () => ({
  RESHUFFLE_ALLOWANCE: 3,
  reshuffleBoard: vi.fn(),
}));

import ReshuffleSheet from './ReshuffleSheet';

const KEEP = 'Keep my card';
const GO = /Reshuffle it/;

beforeEach(() => {
  vi.clearAllMocks();
});

function setup(over: Partial<Parameters<typeof ReshuffleSheet>[0]> = {}) {
  const onClose = vi.fn();
  const onReshuffled = vi.fn();
  const reshuffle = vi.fn(async () => (over.used ?? 1) + 1);
  render(
    <ReshuffleSheet
      uid="u1"
      dayIndex={1}
      used={1}
      expectedSeed={111}
      onClose={onClose}
      onReshuffled={onReshuffled}
      reshuffle={reshuffle as never}
      {...over}
    />,
  );
  return { onClose, onReshuffled, reshuffle };
}

describe('ReshuffleSheet — the wireframe copy', () => {
  it('renders the title, sub-line, warning, and counter line verbatim', () => {
    setup({ dayIndex: 1, used: 1 });
    expect(screen.getByText('Reshuffle this card?')).toBeInTheDocument();
    expect(screen.getByText('A fresh 24 squares for Day 2—same day, new luck.')).toBeInTheDocument();
    expect(screen.getByText(/This can't be undone\./)).toBeInTheDocument();
    expect(
      screen.getByText(/You'll never see this card again—and reshuffles don't come back\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /2 of 3 reshuffles left · available only before you've marked a square/,
      ),
    ).toBeInTheDocument();
  });

  it('names the VIEWED Day in the sub-line', () => {
    setup({ dayIndex: 4 });
    expect(screen.getByText('A fresh 24 squares for Day 5—same day, new luck.')).toBeInTheDocument();
  });

  it('counts down the remaining allowance', () => {
    setup({ used: 2 });
    expect(screen.getByText(/1 of 3 reshuffles left/)).toBeInTheDocument();
  });

  it('offers Keep my card as the primary and Reshuffle it as the danger action', () => {
    setup();
    expect(screen.getByRole('button', { name: KEEP }).className).toContain('primary');
    expect(screen.getByRole('button', { name: GO }).className).toContain('danger');
  });
});

describe('ReshuffleSheet — cancel changes nothing', () => {
  it('Keep my card closes without writing or tracking', () => {
    const { onClose, reshuffle, onReshuffled } = setup();
    fireEvent.click(screen.getByRole('button', { name: KEEP }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reshuffle).not.toHaveBeenCalled();
    expect(onReshuffled).not.toHaveBeenCalled();
    expect(H.track).not.toHaveBeenCalled();
  });

  it('a backdrop click closes without writing', () => {
    const { onClose, reshuffle } = setup();
    fireEvent.click(document.querySelector('.sheet-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reshuffle).not.toHaveBeenCalled();
  });

  it('a click inside the sheet does NOT close it', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText('Reshuffle this card?'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ReshuffleSheet — confirming', () => {
  it('writes for the viewed Day, tracks the resulting spend, and closes', async () => {
    const { onClose, onReshuffled, reshuffle } = setup({ dayIndex: 1, used: 1 });
    fireEvent.click(screen.getByRole('button', { name: GO }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(reshuffle).toHaveBeenCalledWith({ uid: 'u1', dayIndex: 1, expectedSeed: 111 });
    expect(H.track).toHaveBeenCalledWith('reshuffle_card', { dayIndex: 1, reshufflesUsed: 2 });
    expect(onReshuffled).toHaveBeenCalledWith(2);
  });

  it('surfaces a failure and does NOT close or track', async () => {
    const onClose = vi.fn();
    render(
      <ReshuffleSheet
        uid="u1"
        dayIndex={1}
        used={1}
        expectedSeed={111}
        onClose={onClose}
        reshuffle={(() => Promise.reject(new Error('denied'))) as never}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: GO }));
    expect(await screen.findByText(/Couldn't reshuffle/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(H.track).not.toHaveBeenCalled();
  });

  it('does not double-write on a double tap', async () => {
    let resolve: (v: number) => void = () => {};
    const reshuffle = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    render(
      <ReshuffleSheet uid="u1" dayIndex={1} used={1} expectedSeed={111} onClose={vi.fn()} reshuffle={reshuffle as never} />,
    );
    const go = screen.getByRole('button', { name: /Reshuffle/ });
    fireEvent.click(go);
    fireEvent.click(go);
    resolve(2);
    await waitFor(() => expect(reshuffle).toHaveBeenCalledTimes(1));
  });
});
