import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SignIn from './SignIn';
import EventPostcard from './EventPostcard';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';
import { applyResolvedEventPreview, type EventPreview } from '../eventPreview';
import { setActiveAdultContent } from '../adultContent';

// Covers the sign-in gate's Event-preview postcard (#647, wireframes § "Join —
// the postcard, not the casino"): the card renders the RESOLVED pre-auth
// slice, disappears gracefully without one, skins per Edition, and never
// displaces the 18+ attestation when the posture requires it. Follows
// signin-edition-brand.test.tsx: only the auth boundary is mocked, the REAL
// SignIn renders, and every case installs its own resolved state.

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, signIn: vi.fn(), signInReady: true, attest: vi.fn() }),
}));

const PREVIEW: EventPreview = {
  eventName: 'Weekend in Bodega Bay',
  dateRange: 'Aug 7–9',
  hostedBy: 'Kim',
  days: [{ date: '2999-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' }],
};

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
  applyResolvedEventPreview(null);
  setActiveAdultContent(true);
});

describe('EventPostcard — the resolved slice, or nothing', () => {
  it('renders the Event name, the meta line and the serving hostname', () => {
    applyResolvedEventPreview(PREVIEW);
    const { container } = render(<EventPostcard />);
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
    expect(
      screen.getByText('Aug 7–9 · hosted by Kim · 🐦 Day 1: The Birds Have Entered the Chat'),
    ).toBeTruthy();
    // jsdom's own location — the card names the address the guest is standing
    // on (#607's entry-origin rule), not a stored canonical.
    expect(container.querySelector('.event-postcard-host')?.textContent).toBe(
      window.location.hostname,
    );
  });

  it('renders NOTHING without a resolved preview — the pre-#647 gate, unchanged', () => {
    const { container } = render(<EventPostcard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the achievable subset when optional fragments are absent', () => {
    applyResolvedEventPreview({ eventName: 'Weekend in Bodega Bay' });
    const { container } = render(<EventPostcard />);
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
    expect(container.querySelector('.event-postcard-meta')).toBeNull();
  });

  it('advances the Day line across local midnight while mounted', () => {
    // The gate can be LEFT OPEN overnight (Codex P2 round 1): the Day line is
    // date-computed, so the card re-renders itself at each local date
    // boundary rather than waiting for an unrelated render.
    vi.useFakeTimers();
    try {
      const tonight = new Date(2026, 7, 7, 23, 59, 0); // local Aug 7, 23:59
      vi.setSystemTime(tonight);
      applyResolvedEventPreview({
        eventName: 'Weekend in Bodega Bay',
        days: [
          { date: '2026-08-07', title: 'The Birds Have Entered the Chat' },
          { date: '2026-08-08', title: 'Side Quests' },
        ],
      });
      render(<EventPostcard />);
      expect(screen.getByText(/Day 1: The Birds Have Entered the Chat/)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2 * 60 * 1000); // past midnight + the arm slack
      });
      expect(screen.getByText(/Day 2: Side Quests/)).toBeTruthy();
      expect(screen.queryByText(/Day 1:/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wears the stamp on vacay and a plain panel elsewhere', () => {
    applyResolvedEventPreview(PREVIEW);
    setActiveEdition('vacay');
    const vacay = render(<EventPostcard />);
    expect(vacay.container.querySelector('.event-postcard-stamped')).not.toBeNull();
    cleanup();
    setActiveEdition('fiveacross');
    applyResolvedEventPreview(PREVIEW);
    const fa = render(<EventPostcard />);
    expect(fa.container.querySelector('.event-postcard')).not.toBeNull();
    expect(fa.container.querySelector('.event-postcard-stamped')).toBeNull();
  });
});

describe('SignIn — the Join frame around the card', () => {
  it('draws the vacay lockup: byline, voice chip instead of the plain tagline, invite note', () => {
    setActiveEdition('vacay');
    applyResolvedEventPreview(PREVIEW);
    setActiveAdultContent(false);
    render(<SignIn />);
    expect(screen.getByText('BY FIVE ACROSS')).toBeTruthy();
    expect(screen.getByText('Take the detour. For the story.')).toBeTruthy();
    expect(screen.queryByText('Sign in, get your card, mark it if you see it.')).toBeNull();
    expect(screen.getByText(/Prompts are invitations, not chores/)).toBeTruthy();
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
  });

  it('keeps the byline OUT of the h1 the brand tests and synthetic assert on', () => {
    setActiveEdition('vacay');
    render(<SignIn />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VACAY BINGO');
  });

  it('leaves the other registers chipless: plain tagline, no byline, no invite note', () => {
    setActiveEdition('fiveacross');
    applyResolvedEventPreview(PREVIEW);
    setActiveAdultContent(false);
    render(<SignIn />);
    expect(screen.getByText('Sign in, get your card, mark it if you see it.')).toBeTruthy();
    expect(screen.queryByText('BY FIVE ACROSS')).toBeNull();
    expect(screen.queryByText(/Prompts are invitations/)).toBeNull();
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
  });

  it('keeps the 18+ attestation, in position, when the posture requires it', () => {
    setActiveEdition('vacay');
    applyResolvedEventPreview(PREVIEW);
    setActiveAdultContent(true);
    const { container } = render(<SignIn />);
    // Card AND checkbox coexist, and the wireframe order holds: the
    // acknowledgement sits BETWEEN the card and the CTA (fx-join-gcb).
    const card = container.querySelector('.event-postcard');
    const ack = container.querySelector('.ack');
    const button = screen.getByRole('button');
    expect(card).not.toBeNull();
    expect(ack).not.toBeNull();
    expect(card!.compareDocumentPosition(ack!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ack!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and still gates the button (the #608 behavior, unregressed).
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toHaveProperty('disabled', false);
  });

  it('shows no acknowledgement on an ungated Event, with the card present', () => {
    setActiveEdition('vacay');
    applyResolvedEventPreview(PREVIEW);
    setActiveAdultContent(false);
    render(<SignIn />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button')).toHaveProperty('disabled', false);
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
  });
});
