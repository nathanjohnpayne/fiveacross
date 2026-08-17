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

  it('appears when the slice arrives AFTER mount — the env-pinned live channel', () => {
    // The production defect: an env-pinned build's resolution installs no
    // preview, so on a first-ever visit the slice lands from the live
    // hostnames listener a beat after first paint. The store is reactive
    // (useSyncExternalStore), so the card must materialize on delivery — not
    // wait for an unrelated render.
    const { container } = render(<EventPostcard />);
    expect(container.firstChild).toBeNull();
    act(() => applyResolvedEventPreview(PREVIEW));
    expect(screen.getByText('Weekend in Bodega Bay')).toBeTruthy();
    // …and a proven removal takes it back down.
    act(() => applyResolvedEventPreview(null));
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

// #776. The stamp corner shipped three times as a bordered `::after` with
// `content: ''` — a frame with no content path — so production drew an EMPTY
// dashed box. These two cases are the invariant the wireframe's stamp-corner
// contract states: the Day's emoji IS the postage, and with no postage there
// is no element and no reserved corner. Together they make the empty box
// unreachable rather than merely unlikely.
describe('EventPostcard — the stamp is its postage, or it is nothing', () => {
  /** Every no-postage shape production can reach. Each must yield the SAME
   *  outcome: no stamp element at all. */
  const UNFRANKED: [string, EventPreview][] = [
    // Bodega's own Days 2 and 3: the seed carries `emoji` on Day 1 only, so a
    // Day with no emoji field is the common case, not a malformed document.
    [
      'a Day the seed gave no emoji',
      { eventName: 'Weekend in Bodega Bay', days: [{ date: '2999-08-08', title: 'Side Quests' }] },
    ],
    // Post-trip: `previewDayEmoji` resolves no Day at all, the state the LIVE
    // Bodega card sits in once the last Day has passed.
    [
      'a schedule whose last Day has passed',
      {
        eventName: 'Weekend in Bodega Bay',
        days: [{ date: '2000-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' }],
      },
    ],
    // Loading, or a hostname document seeded before the schedule landed.
    ['no schedule at all', { eventName: 'Weekend in Bodega Bay' }],
  ];

  it('franks the corner with the previewed Day’s emoji, and reserves the corner for it', () => {
    setActiveEdition('vacay');
    applyResolvedEventPreview(PREVIEW);
    const { container } = render(<EventPostcard />);
    const stamp = container.querySelector('.event-postcard-stamp');
    expect(stamp).not.toBeNull();
    // Non-whitespace, and the DAY's emoji specifically — the same
    // `days[].emoji` field the meta line renders, not a second seeded field.
    expect(stamp!.textContent).toBe('🐦');
    // …and only a card that actually drew a stamp holds the corner open.
    expect(container.querySelector('.event-postcard-franked')).not.toBeNull();
  });

  it.each(UNFRANKED)('draws NO stamp element and no reserved corner given %s', (_label, preview) => {
    setActiveEdition('vacay');
    applyResolvedEventPreview(preview);
    const { container } = render(<EventPostcard />);
    // The card itself still renders in its postcard treatment…
    expect(container.querySelector('.event-postcard-stamped')).not.toBeNull();
    // …with nothing in the corner and no padding reserving one. An empty
    // dashed rectangle has no way to exist.
    expect(container.querySelector('.event-postcard-stamp')).toBeNull();
    expect(container.querySelector('.event-postcard-franked')).toBeNull();
  });

  it('prints the Day’s emoji exactly once on the card — the corner, not both', () => {
    // The Day line has always led with the Day's emoji. A stamp that repeats
    // it prints the same glyph twice on one small card, so the corner takes
    // the postage and the line gives it up — still naming the Day in words.
    setActiveEdition('vacay');
    applyResolvedEventPreview(PREVIEW);
    const { container } = render(<EventPostcard />);
    expect(container.querySelector('.event-postcard-stamp')!.textContent).toBe('🐦');
    expect(container.querySelector('.event-postcard-meta')!.textContent).toBe(
      'Aug 7–9 · hosted by Kim · Day 1: The Birds Have Entered the Chat',
    );
    expect(container.textContent!.split('🐦').length - 1).toBe(1);
  });

  it('leaves the Day line leading with the emoji when no stamp takes it', () => {
    // An Edition with no postcard variant draws no stamp, so the line keeps
    // the glyph exactly as it did before the stamp existed — the emoji must
    // not vanish from the card just because the corner is absent.
    setActiveEdition('gcb');
    applyResolvedEventPreview(PREVIEW);
    const { container } = render(<EventPostcard />);
    expect(container.querySelector('.event-postcard-stamp')).toBeNull();
    expect(container.querySelector('.event-postcard-meta')!.textContent).toBe(
      'Aug 7–9 · hosted by Kim · 🐦 Day 1: The Birds Have Entered the Chat',
    );
  });

  it('never stamps a non-postcard Edition, even on a Day that has postage', () => {
    // The stamp is vacay's `signinCardVariant: 'postcard'` treatment; gcb and
    // fiveacross draw the same slice as a plain panel, and an emoji-bearing
    // Day must not sneak a stamp onto either.
    for (const edition of ['gcb', 'fiveacross']) {
      setActiveEdition(edition);
      applyResolvedEventPreview(PREVIEW);
      const { container } = render(<EventPostcard />);
      expect(container.querySelector('.event-postcard')).not.toBeNull();
      expect(container.querySelector('.event-postcard-stamp')).toBeNull();
      expect(container.querySelector('.event-postcard-franked')).toBeNull();
      cleanup();
    }
  });

  it('drops the stamp across local midnight when the next Day carries no emoji', () => {
    // The postage reads through the SAME Day selection as the Day line, so a
    // gate left open overnight moves from stamped Day 1 to unstamped Day 2 —
    // and lands on absence, not on an empty box.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 7, 23, 59, 0)); // local Aug 7, 23:59
      setActiveEdition('vacay');
      applyResolvedEventPreview({
        eventName: 'Weekend in Bodega Bay',
        days: [
          { date: '2026-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' },
          { date: '2026-08-08', title: 'Side Quests' },
        ],
      });
      const { container } = render(<EventPostcard />);
      expect(container.querySelector('.event-postcard-stamp')?.textContent).toBe('🐦');
      act(() => {
        vi.advanceTimersByTime(2 * 60 * 1000); // past midnight + the arm slack
      });
      expect(container.querySelector('.event-postcard-stamp')).toBeNull();
      expect(container.querySelector('.event-postcard-franked')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  // #688: GCB wears the endorsement too, but ONLY the endorsement — the
  // cruise register keeps its plain tagline, and gets neither vacay's voice
  // chip nor its invite note. The byline and the Join-frame voice are separate
  // brand-table fields, and this is the pairing that proves it.
  it('draws the gcb lockup: byline over the cruise wordmark, plain tagline, no chip', () => {
    setActiveEdition('gcb');
    applyResolvedEventPreview(PREVIEW);
    setActiveAdultContent(false);
    render(<SignIn />);
    expect(screen.getByText('BY FIVE ACROSS')).toBeTruthy();
    expect(screen.getByText('Sign in, get your card, mark it if you see it.')).toBeTruthy();
    expect(screen.queryByText('Take the detour. For the story.')).toBeNull();
    expect(screen.queryByText(/Prompts are invitations/)).toBeNull();
  });

  it.each([
    ['vacay', 'VACAY BINGO'],
    ['gcb', 'GAY CRUISE BINGO'],
  ])('keeps the %s byline OUT of the h1 the brand tests and synthetic assert on', (edition, wordmark) => {
    setActiveEdition(edition);
    render(<SignIn />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(wordmark);
  });

  it('leaves the platform Edition chipless: plain tagline, no byline, no invite note', () => {
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
