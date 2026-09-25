import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EventArchive, EventDoc, PlayerDoc } from '../types';

// specs/player-blocking.md § Where hiding applies, standings layer (#689 part
// 2, decision 6). A blocked counterpart's Leaderboard row is hidden AFTER ranks
// are assigned, so the ranks keep a gap; their honours (the ⭐, a Day's First to
// BINGO, the champion) are withheld and never handed to the next Player; and
// the same holds on the archived standings and the farewell podium. The raw
// roster and the frozen record are untouched.

const H = vi.hoisted(() => ({
  players: [] as PlayerDoc[],
  event: null as EventDoc | null,
  blocks: { hidden: new Set<string>(), ready: true } as { hidden: ReadonlySet<string>; ready: boolean },
}));

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../hooks/useBlocks', () => ({ useHiddenUids: () => H.blocks }));
// The archived and farewell views pre-render their share card on mount; the
// rasteriser is not under test here (w2-share-cards.test.tsx pins it).
vi.mock('./ShareCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ShareCard')>()),
  renderLeaderboardShareCard: vi.fn(() => Promise.resolve(null)),
  renderFarewellShareCard: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../hooks/useData', () => ({
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: H.players, loading: false }),
  useEventDoc: () => ({ data: H.event, loading: false, serverResolved: true, hasPendingWrites: false }),
  useProofKindsByUid: () => ({ kindsByUid: {}, loading: false }),
  useProofFeed: () => ({ proofs: [], loading: false }),
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Leaderboard from './Leaderboard';
import ArchivedLeaderboard from './ArchivedLeaderboard';
import FarewellPodium from './FarewellPodium';
import { buildPodium } from '../data/finale';
import { withBlockExclusions, withRanksKeepingGaps } from '../data/moderation';

const player = (uid: string, bingoCount: number, firstBingoAt: number | null): PlayerDoc =>
  ({ uid, displayName: uid.toUpperCase(), photoURL: null, joinedAt: 0, bingoCount, squaresMarked: bingoCount * 5 + 5, firstBingoAt, reshufflesUsed: 0 });

// Ranked as sortPlayers would: ALPHA 1st, BLOCKED 2nd (and the earliest bingo,
// so the ⭐ holder), CHARLIE 3rd.
const alpha = player('alpha', 3, 5000);
const blocked = player('blocked', 2, 1000);
const charlie = player('charlie', 1, 8000);

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('.row')].map((r) => ({
    rank: r.querySelector('.rank')?.textContent,
    name: r.querySelector('.name')?.textContent,
    star: !!r.querySelector('.badge'),
  }));

beforeEach(() => {
  H.players = [alpha, blocked, charlie];
  H.event = null;
  H.blocks = { hidden: new Set(['blocked']), ready: true };
});

describe('Leaderboard (#689)', () => {
  it('hides the counterpart’s row, keeps the rank gap, and promotes nobody to the ⭐', () => {
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(rows(container)).toEqual([
      { rank: '1', name: 'ALPHA', star: false },
      { rank: '3', name: 'CHARLIE', star: false },
    ]);
  });

  it('renders every row, numbered 1..n, for a viewer who has hidden nobody', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(rows(container).map((r) => `${r.rank} ${r.name}${r.star ? ' ⭐' : ''}`)).toEqual(['1 ALPHA', '2 BLOCKED ⭐', '3 CHARLIE']);
  });
});

describe('ArchivedLeaderboard (#689)', () => {
  const standingRow = (uid: string, bingoCount: number) =>
    ({ uid, displayName: uid.toUpperCase(), bingoCount, squaresMarked: 10, blackout: false, firstBingoAt: 1 });
  const archive: EventArchive = {
    eventName: 'Test Sailing',
    standings: [standingRow('alpha', 3), standingRow('blocked', 2), standingRow('charlie', 1)],
    playerCount: 3,
    firstBingo: { uid: 'blocked', displayName: 'BLOCKED', at: 1000 },
    firstBingoRow: { ...standingRow('blocked', 2), rank: 2 },
    dailyHonors: [
      { dayIndex: 0, uid: 'blocked', displayName: 'BLOCKED', firstBingoAt: 1000, dayLabel: 'D1' },
      { dayIndex: 1, uid: 'charlie', displayName: 'CHARLIE', firstBingoAt: 2000, dayLabel: 'D2' },
    ],
    freezeAt: null,
    archivedAt: 10_000,
  };

  it('hides the counterpart’s frozen row with a rank gap, vacates their headline and Day honour', () => {
    const { container } = render(
      <ArchivedLeaderboard event={{ archivedAt: 10_000, bannedUids: [] }} archive={archive} />,
    );
    const list = [...container.querySelectorAll('.list .row')].map((r) => [
      r.querySelector('.rank')?.textContent,
      r.querySelector('.name')?.textContent,
    ]);
    expect(list).toEqual([
      ['1', 'ALPHA'],
      ['3', 'CHARLIE'],
    ]);
    expect(container.textContent).not.toContain('BLOCKED');
    expect(container.textContent).toContain('CHARLIE');
    // The frozen record itself is never rewritten.
    expect(archive.standings).toHaveLength(3);
    expect(archive.firstBingo?.uid).toBe('blocked');
  });
});

describe('the farewell podium (#689)', () => {
  it('buildPodium withholds a hidden champion and cuts their standings row after the top-three slice', () => {
    const fourth = player('delta', 0, null);
    const podium = buildPodium([blocked, alpha, charlie, { ...fourth, squaresMarked: 1 }], undefined, undefined, true, null, [], null, new Set(['alpha']));
    // ALPHA is the real champion, so the honour is withheld, not handed to BLOCKED.
    expect(podium.champion).toBeNull();
    expect(podium.standings.map((r) => [r.rank, r.uid])).toEqual([
      [2, 'blocked'],
      [3, 'charlie'],
    ]);
  });

  it('with nothing hidden, buildPodium is unchanged', () => {
    const plain = buildPodium([alpha, blocked, charlie], undefined);
    const withEmpty = buildPodium([alpha, blocked, charlie], undefined, undefined, true, null, [], null, new Set());
    expect(withEmpty).toEqual(plain);
  });

  it('FarewellPodium never renders a hidden champion or First to BINGO, and promotes nobody', () => {
    H.blocks = { hidden: new Set(), ready: true };
    const shown = render(<FarewellPodium players={[alpha, blocked, charlie]} days={undefined} />);
    expect(screen.getByText('ALPHA')).toBeTruthy();
    expect(screen.getByText('BLOCKED')).toBeTruthy();
    shown.unmount();

    H.blocks = { hidden: new Set(['alpha', 'blocked']), ready: true };
    render(<FarewellPodium players={[alpha, blocked, charlie]} days={undefined} />);
    expect(screen.queryByText('ALPHA')).toBeNull();
    expect(screen.queryByText('BLOCKED')).toBeNull();
    expect(screen.queryByText('CHARLIE')).toBeNull();
  });
});

describe('the display helpers (src/data/moderation.ts)', () => {
  it('withBlockExclusions returns the ban roster itself when nothing is hidden, else the union', () => {
    const banned = ['x'];
    expect(withBlockExclusions(banned, new Set())).toBe(banned);
    expect(withBlockExclusions(banned, new Set(['x', 'y']))).toEqual(['x', 'y']);
    expect(withBlockExclusions(undefined, new Set(['y']))).toEqual(['y']);
  });

  it('withRanksKeepingGaps numbers first, then drops the hidden rows', () => {
    expect(withRanksKeepingGaps([{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }], new Set(['a']))).toEqual([
      { row: { uid: 'b' }, rank: 2 },
      { row: { uid: 'c' }, rank: 3 },
    ]);
  });
});
