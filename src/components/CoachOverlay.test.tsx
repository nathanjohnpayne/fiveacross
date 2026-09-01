import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// CoachOverlay imports EVENT_ID from '../firebase' — mocked like every suite stubs it.
vi.mock('../firebase', () => ({ EVENT_ID: 'unused-default-event' }));
import CoachOverlay, {
  __resetCoachOverlayDismissalsForTests,
} from './CoachOverlay'; // specs/d15-coach-overlay.md (#214)

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  } as unknown as Storage;
}

describe('CoachOverlay', () => {
  let storage: Storage;

  beforeEach(() => {
    __resetCoachOverlayDismissalsForTests();
    storage = createStorageStub();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the four legend rows + CTA, and the Doubt row restates the never-a-gate invariant', () => {
    render(<CoachOverlay eventId="cruise-a" />);
    expect(screen.getByText('Tally count')).toBeInTheDocument();
    expect(screen.getByText(/Doubt badge/)).toBeInTheDocument();
    expect(screen.getByText(/Add proof/)).toBeInTheDocument();
    expect(screen.getByText('Free space')).toBeInTheDocument();
    expect(screen.getByText(/never unmarks/i)).toBeInTheDocument(); // never a gate
    expect(screen.getByRole('button', { name: 'Got it—deal me in.' })).toBeInTheDocument();
  });

  it('each legend row leads with its sample chip (the wireframes\' lgdchip treatment)', () => {
    render(<CoachOverlay eventId="cruise-a" />);
    // The four chips, in board notation: tally count, doubt badge, add-proof
    // plus, and the FREE center — decorative (aria-hidden) but present.
    const chips = document.querySelectorAll('.coach-overlay-chip');
    expect([...chips].map((c) => c.textContent)).toEqual(['4', '👀 2', '＋', 'FREE']);
    expect(chips[2].classList.contains('coach-overlay-chip-plus')).toBe(true);
    expect(chips[3].classList.contains('coach-overlay-chip-free')).toBe(true);
  });

  it('tapping the CTA dismisses the overlay and writes the per-Event localStorage key', () => {
    render(<CoachOverlay eventId="cruise-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it—deal me in.' }));
    expect(screen.queryByText('Tally count')).not.toBeInTheDocument();
    expect(storage.getItem('gcb.coachOverlay.cruise-a.dismissedAt')).not.toBeNull();
  });

  it('a second mount with that Event dismissed does not render, but a DIFFERENT Event id still does', () => {
    storage.setItem('gcb.coachOverlay.cruise-a.dismissedAt', String(Date.now()));
    const { unmount } = render(<CoachOverlay eventId="cruise-a" />);
    expect(screen.queryByText('Tally count')).not.toBeInTheDocument();
    unmount();
    render(<CoachOverlay eventId="cruise-b" />);
    expect(screen.getByText('Tally count')).toBeInTheDocument();
  });

  it('forceOpen (replay, More → How to play) renders despite the flag, and its dismissal still writes the timestamp', () => {
    const onDismiss = vi.fn();
    storage.setItem('gcb.coachOverlay.cruise-a.dismissedAt', '1');
    render(<CoachOverlay eventId="cruise-a" forceOpen onDismiss={onDismiss} />);
    expect(screen.getByText('Tally count')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it—deal me in.' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(storage.getItem('gcb.coachOverlay.cruise-a.dismissedAt')).not.toBe('1');
  });

  it('retains only Event A\'s dismissal across A→B→A when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('Storage unavailable');
      },
      setItem: () => {
        throw new DOMException('Storage unavailable');
      },
    });

    const a = render(<CoachOverlay eventId="cruise-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it—deal me in.' }));
    a.unmount();

    const b = render(<CoachOverlay eventId="cruise-b" />);
    expect(screen.getByText('Tally count')).toBeInTheDocument();
    b.unmount();

    render(<CoachOverlay eventId="cruise-a" />);
    expect(screen.queryByText('Tally count')).not.toBeInTheDocument();
  });
});
