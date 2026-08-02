import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { EventDoc, PlayerDoc } from '../types';

// specs/w2-leaderboard.md, RTL layer (issue #35). Leaderboard is presentational
// over useLeaderboard's already-ranked `players` array — the tie-break order
// itself is unit-tested directly against comparePlayers/sortPlayers in
// src/game/w2-leaderboard.test.ts, so useLeaderboard is stubbed here with a
// pre-ranked fixture (mirroring the sec-xss-proofsheet.test.tsx / w2-tally.
// test.tsx precedent of stubbing a single read hook to isolate the
// presentational layer under test). These tests pin three things: (1) the
// "1st BINGO" pin lands on the Player with the earliest firstBingoAt EVEN
// WHEN that Player is not rank #1 (the pin tracks earliest-bingo, not rank —
// ADR 0001, a ceremonial/self-reported honour); (2) the "· BLACKOUT" suffix
// renders only for a Blackout Player; (3) the all/with-BINGO/Blackout filters
// narrow the visible rows WITHOUT reordering the remaining ones. The Share
// Card affordance issue #36 adds is covered separately in
// src/components/w2-share-cards.test.tsx — useEventDoc is stubbed here only
// so Leaderboard's render doesn't crash on the added hook call, and
// ../analytics is stubbed only because Leaderboard now imports `track` (its
// real module imports ../firebase, which initializes a real Firebase app —
// unnecessary and unsafe for a suite that never asserts on tracking).

const H = vi.hoisted(() => ({
  players: [] as PlayerDoc[],
  loading: false,
  event: null as EventDoc | null,
}));

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: H.players, loading: H.loading }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  // #218: no Proofs fixtured in this suite — an empty map keeps every row
  // chip-less, which is orthogonal to the pin/filter/tie-break assertions here.
  useLatestProofByUid: () => ({ latestByUid: {}, loading: false }),
  // Mirrors src/data/moderation.ts isBanned (#108). The event fixtures here carry no
  // bannedUids, so it filters nothing and these pin/filter assertions are unchanged;
  // the ban filter itself is pinned in src/components/w2-ban-console.test.tsx.
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Leaderboard from './Leaderboard';

function mkPlayer(over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>): PlayerDoc {
  return {
    photoURL: null,
    joinedAt: 0,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
    ...over,
  };
}

// Pre-ranked exactly as sortPlayers/comparePlayers would order them: bingos
// desc, then squares desc, then earliest firstBingoAt. 'early-bird' ranks #2
// (fewer bingos than 'top-dog') but holds the EARLIEST firstBingoAt on the
// whole roster (1000 < 5000 < 8000) — the fixture that proves the pin tracks
// earliest-bingo, not rank position.
const topDog = mkPlayer({
  uid: 'top-dog',
  displayName: 'Top Dog',
  bingoCount: 3,
  squaresMarked: 20,
  firstBingoAt: 5000,
  blackout: true,
});
const earlyBird = mkPlayer({
  uid: 'early-bird',
  displayName: 'Early Bird',
  bingoCount: 2,
  squaresMarked: 15,
  firstBingoAt: 1000,
});
const middle = mkPlayer({
  uid: 'middle',
  displayName: 'Middle',
  bingoCount: 1,
  squaresMarked: 10,
  firstBingoAt: 8000,
});
const noBingo = mkPlayer({
  uid: 'no-bingo',
  displayName: 'No Bingo Yet',
  bingoCount: 0,
  squaresMarked: 5,
  firstBingoAt: null,
});

function names(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.row .name')).map((el) => el.textContent ?? '');
}

beforeEach(() => {
  H.players = [topDog, earlyBird, middle, noBingo];
  H.loading = false;
});

describe('Leaderboard — the First to BINGO pin tracks earliest firstBingoAt, not rank', () => {
  it('pins "1st BINGO" on the earliest first-bingo Player even though a later-bingo Player outranks them', () => {
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });

    const earlyBirdRow = screen.getByText('Early Bird').closest('.row');
    const topDogRow = screen.getByText('Top Dog').closest('.row');

    expect(earlyBirdRow).toHaveClass('leader');
    expect(earlyBirdRow?.querySelector('.badge')).toHaveTextContent(/First BINGO/);
    // Top Dog outranks Early Bird (more bingos, rank #1) but got their bingo
    // LATER — they must not also carry the pin.
    expect(topDogRow).not.toHaveClass('leader');
    expect(topDogRow?.querySelector('.badge')).toBeNull();

    // The pin is a badge on a row, not a reorder: rank order stays bingos-desc.
    expect(names(container)).toEqual(['Top Dog', 'Early Bird', 'Middle', 'No Bingo Yet']);
  });

  it('shows the "· BLACKOUT" suffix only for a Blackout Player', () => {
    render(<Leaderboard />, { wrapper: MemoryRouter });

    expect(screen.getByText('Top Dog').closest('.row')).toHaveTextContent('BLACKOUT');
    expect(screen.getByText('Early Bird').closest('.row')).not.toHaveTextContent('BLACKOUT');
    expect(screen.getByText('Middle').closest('.row')).not.toHaveTextContent('BLACKOUT');
  });
});

describe('Leaderboard — filters narrow the visible subset without reordering', () => {
  it('defaults to "All": every Player shown in ranked order', () => {
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(names(container)).toEqual(['Top Dog', 'Early Bird', 'Middle', 'No Bingo Yet']);
  });

  it('"With BINGO" hides the no-bingo Player but keeps the rest in the same relative order', async () => {
    const user = userEvent.setup();
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: 'With BINGO' }));

    expect(names(container)).toEqual(['Top Dog', 'Early Bird', 'Middle']);
  });

  it('"Blackout" narrows to only the Blackout Player', async () => {
    const user = userEvent.setup();
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: 'Blackout' }));

    expect(names(container)).toEqual(['Top Dog']);
  });

  it('switching back to "All" restores the full, still-unreordered roster', async () => {
    const user = userEvent.setup();
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: 'Blackout' }));
    await user.click(screen.getByRole('button', { name: 'All' }));

    expect(names(container)).toEqual(['Top Dog', 'Early Bird', 'Middle', 'No Bingo Yet']);
  });

  it('marks the active filter with aria-pressed, exactly one at a time', async () => {
    const user = userEvent.setup();
    render(<Leaderboard />, { wrapper: MemoryRouter });

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'With BINGO' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'With BINGO' }));

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'With BINGO' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an empty-filter state (not the global empty state) when no Player matches the filter', async () => {
    H.players = [earlyBird]; // no Blackout Player in this roster
    const user = userEvent.setup();
    render(<Leaderboard />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: 'Blackout' }));

    expect(screen.getByText(/no one matches this filter/i)).toBeInTheDocument();
    // The filter control itself stays usable — unlike the global "No players
    // yet" state below, which never renders the filter row at all.
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });
});

describe('Leaderboard — global loading/empty-roster states are unaffected by the filter feature', () => {
  it('renders the loading state with no filter row', () => {
    H.loading = true;
    render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(screen.getByRole('status')).toHaveTextContent('Tallying the leaderboard…');
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });

  it('renders "No players yet" with no filter row when the roster itself is empty', () => {
    H.players = [];
    render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(screen.getByText(/no players yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });
});

describe('Leaderboard — the Share action sits below the ranked list (#174)', () => {
  it('renders "Share leaderboard" AFTER both the filter row and the list, not wedged above them', () => {
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });
    const share = screen.getByRole('button', { name: /share leaderboard/i });
    const filters = container.querySelector('.lb-filters');
    const list = container.querySelector('.list');
    expect(filters).not.toBeNull();
    expect(list).not.toBeNull();
    // #174: the button used to sit in the narrow band ABOVE the filter row
    // (wedged under the global theme carousel). It now follows both the filter
    // row and the list in DOM order.
    expect(filters!.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list!.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the Share action reachable in an empty-filter view (Codex): compact empty state, not the 70vh .center', async () => {
    H.players = [earlyBird]; // no Blackout Player, so the Blackout filter is empty
    const user = userEvent.setup();
    const { container } = render(<Leaderboard />, { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: 'Blackout' }));

    // The share card uses the FULL roster, so the CTA stays valid + present.
    expect(screen.getByRole('button', { name: /share leaderboard/i })).toBeInTheDocument();
    // The empty-filter message must NOT use the full-height `.center` (min-height
    // 70vh), which would shove the below-list CTA off-screen (#174).
    const empty = screen.getByText(/no one matches this filter/i);
    expect(empty).toHaveClass('lb-empty');
    expect(empty).not.toHaveClass('center');
    expect(container.querySelector('.list')).toBeNull();
  });
});
