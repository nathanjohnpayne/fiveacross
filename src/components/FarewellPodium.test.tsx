import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DayDef } from '../types';
import TutorialBanner from './TutorialBanner';
import { FarewellPodiumView } from './FarewellPodium';
import type { Podium } from '../data/finale';

// The share-affordance wrapper (issue #449) pulls useEventDoc/analytics/
// ShareCard (and, via leaderboardShareCopy, Leaderboard's hook imports) into
// this file's module graph. This suite only exercises the presentational
// FarewellPodiumView, so the module boundary gets inert stand-ins — the
// w2-share-cards.test.tsx precedent; the share behavior itself is pinned
// there, not here.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../hooks/useData', () => ({
  useEventDoc: () => ({ data: null, loading: false }),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useLatestProofByUid: () => ({ latestByUid: {}, loading: false }),
  isBanned: () => false,
}));

// Covers specs/d15-finale.md: the farewell podium banner renders the champion,
// the cruise-wide First to BINGO, and the ten daily-honor rows from a fixture
// payload, and mounts ABOVE the goodbye banner (its stacking order).

const FIXTURE: Podium = {
  champion: { uid: 'jess', displayName: 'Jess', bingoCount: 4, squaresMarked: 33 },
  firstBingo: { uid: 'marco', displayName: 'Marco', at: 1_700_000_000_000 },
  dailyHonors: Array.from({ length: 10 }, (_, i) => ({
    dayIndex: i,
    uid: `winner-${i}`,
    displayName: `Winner ${i}`,
    firstBingoAt: 1_700_000_000_000 + i,
  })),
};

describe('FarewellPodiumView', () => {
  it('renders the champion, cruise-wide First to BINGO, and all ten daily honors', () => {
    render(<FarewellPodiumView podium={FIXTURE} />);

    // Champion + stat line.
    expect(screen.getByText('Cruise champion')).toBeTruthy();
    expect(screen.getByText('Jess')).toBeTruthy();
    expect(screen.getByText('4 bingos · 33 squares')).toBeTruthy();

    // Cruise-wide First to BINGO.
    expect(screen.getByText('First to BINGO')).toBeTruthy();
    expect(screen.getByText('Marco')).toBeTruthy();

    // Ten daily-honor rows.
    const honors = screen.getByLabelText('Daily First to BINGO');
    expect(honors.querySelectorAll('.farewell-podium-honor')).toHaveLength(10);
    expect(screen.getByText('Winner 9')).toBeTruthy();
  });

  it('singularizes a one-bingo champion stat line', () => {
    render(
      <FarewellPodiumView
        podium={{ champion: { uid: 'x', displayName: 'Solo', bingoCount: 1, squaresMarked: 5 }, firstBingo: null, dailyHonors: [] }}
      />,
    );
    expect(screen.getByText('1 bingo · 5 squares')).toBeTruthy();
  });

  it('isolates the honor-day label emoji in an inline-block .emoji-run span (#603)', () => {
    const { container } = render(
      <FarewellPodiumView
        podium={FIXTURE}
        dayLabel={(i) => (i === 1 ? 'Day 2 · Split 🇭🇷' : `Day ${i + 1}`)}
      />,
    );
    const days = container.querySelectorAll('.farewell-podium-honor-day');
    // Emoji-bearing label: the flag is atomized so the bug-report screenshot
    // capture (html-to-image) cannot paint it over the port name; the visible
    // text is unchanged.
    const atoms = days[1].querySelectorAll('span.emoji-run');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].textContent).toBe('🇭🇷');
    expect(days[1].textContent).toBe('Day 2 · Split 🇭🇷');
    // Plain label: no wrapper spam.
    expect(days[0].querySelector('span.emoji-run')).toBeNull();
    expect(days[0].textContent).toBe('Day 1');
  });

  it('renders nothing for an entirely empty podium', () => {
    const { container } = render(
      <FarewellPodiumView podium={{ champion: null, firstBingo: null, dailyHonors: [] }} />,
    );
    expect(container.querySelector('.farewell-podium')).toBeNull();
  });

  it('renders above the goodbye banner mount point', () => {
    const farewellDay: DayDef = {
      index: 9,
      date: '2026-07-25',
      place: 'Venice',
      placeEmoji: '🇮🇹',
      theme: 'so-long-farewell',
      tonight: [],
      pool: 'closing',
      tutorial: true,
      unlockAt: 0,
    };
    // Board mounts the podium immediately before the goodbye banner; render the
    // same order and assert the podium precedes the goodbye copy in the DOM.
    const { container } = render(
      <div>
        <FarewellPodiumView podium={FIXTURE} />
        <TutorialBanner day={farewellDay} />
      </div>,
    );
    const podium = container.querySelector('.farewell-podium')!;
    const goodbye = container.querySelector('.tutorial-banner-farewell')!;
    expect(podium).toBeTruthy();
    expect(goodbye).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING (4) → goodbye comes after the podium.
    expect(podium.compareDocumentPosition(goodbye) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
