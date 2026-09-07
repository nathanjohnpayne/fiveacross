import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { EventArchive, EventDoc, PlayerDoc } from '../types';

// specs/post-sailing-archive.md, RTL layer (#134). Two surfaces:
//
//   1. The archived Leaderboard renders the FROZEN record and nothing else. The
//      fixtures deliberately make the live roster DISAGREE with the archive, so
//      "reads from the snapshot" is proved rather than assumed — a component
//      that quietly kept deriving from `useLeaderboard` would show the live
//      numbers and fail here. The live hooks are `vi.fn()`s so the archived
//      render can assert it never CALLED them, not merely that it ignored what
//      they returned: "it subscribes to nothing" is a claim about listeners.
//   2. The Admin archive control is two taps, reports what happened, and
//      retires itself once the Event is frozen.
//
// The read hooks are stubbed (the `w2-leaderboard.test.tsx` precedent for
// isolating a presentational surface), and `../analytics` / `../firebase` are
// stubbed because both surfaces import them for Event-scoped share tracking.
// `../data/moderation` is deliberately NOT stubbed: `isBanned` is the ban
// contract under test here, and a stubbed predicate would prove nothing.

const H = vi.hoisted(() => {
  const state = {
    players: [] as PlayerDoc[],
    loading: false,
    event: null as EventDoc | null,
    archiveEvent: vi.fn(async (_params: { players: readonly PlayerDoc[] }) => 'archived' as const),
    useLeaderboard: vi.fn(() => ({ players: state.players, loading: state.loading })),
    useDayMetasStatus: vi.fn(() => ({ metas: new Map(), loaded: true })),
    useProofKindsByUid: vi.fn(() => ({ kindsByUid: {}, loading: false })),
  };
  return state;
});

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));
vi.mock('../hooks/useData', () => ({
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: H.useDayMetasStatus,
  useLeaderboard: H.useLeaderboard,
  useEventDoc: () => ({ data: H.event, loading: false }),
  useProofKindsByUid: H.useProofKindsByUid,
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));
vi.mock('../data/admin', () => ({ archiveEvent: H.archiveEvent }));

import Leaderboard from './Leaderboard';
import ArchiveEvent from './admin/ArchiveEvent';

function mkPlayer(
  over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>,
): PlayerDoc {
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

// The LIVE roster says Late Riser is on top with 9 bingos. The FROZEN record
// says Early Bird won with 3. Every assertion below reads the frozen numbers.
const liveRoster: PlayerDoc[] = [
  mkPlayer({
    uid: 'late-riser',
    displayName: 'Late Riser',
    bingoCount: 9,
    squaresMarked: 24,
    firstBingoAt: 90_000,
  }),
  mkPlayer({
    uid: 'early-bird',
    displayName: 'Early Bird',
    bingoCount: 3,
    squaresMarked: 18,
    firstBingoAt: 1_000,
  }),
];

const FROZEN: EventArchive = {
  standings: [
    {
      uid: 'early-bird',
      displayName: 'Early Bird',
      bingoCount: 3,
      squaresMarked: 18,
      blackout: true,
      firstBingoAt: 1_000,
    },
    {
      uid: 'steady',
      displayName: 'Steady Eddie',
      bingoCount: 1,
      squaresMarked: 12,
      blackout: false,
      firstBingoAt: 4_000,
    },
  ],
  playerCount: 2,
  firstBingo: { uid: 'early-bird', displayName: 'Early Bird', at: 1_000 },
  dailyHonors: [
    { dayIndex: 0, uid: 'early-bird', displayName: 'Early Bird', firstBingoAt: 1_000 },
    { dayIndex: 1, uid: 'steady', displayName: 'Steady Eddie', firstBingoAt: 4_000 },
  ],
  freezeAt: null,
  archivedAt: Date.UTC(2026, 6, 24, 12),
};

function archivedEvent(over: Partial<EventDoc> = {}): EventDoc {
  return {
    name: 'Med 2026',
    status: 'archived',
    archivedAt: FROZEN.archivedAt,
    archive: FROZEN,
    days: [],
    bannedUids: [],
    ...over,
  } as unknown as EventDoc;
}

const renderLeaderboard = () =>
  render(
    <MemoryRouter>
      <Leaderboard />
    </MemoryRouter>,
  );

beforeEach(() => {
  H.players = liveRoster;
  H.loading = false;
  H.event = archivedEvent();
  H.archiveEvent.mockClear();
  H.useLeaderboard.mockClear();
  H.useDayMetasStatus.mockClear();
  H.useProofKindsByUid.mockClear();
});

describe('the archived Leaderboard renders the frozen record', () => {
  it('shows the frozen standings, not the live roster', () => {
    const { container } = renderLeaderboard();
    // Early Bird is rank 1 in the record even though the live roster ranks
    // Late Riser first — and Late Riser, who is on the live roster but not in
    // the record, does not appear at all.
    const names = [...container.querySelectorAll('.list .row .name')].map((n) => n.textContent);
    expect(names).toEqual(['Early Bird', 'Steady Eddie']);
    expect(screen.queryByText('Late Riser')).not.toBeInTheDocument();
    expect(screen.getByText(/3 bingos · 18 squares · BLACKOUT/)).toBeInTheDocument();
  });

  it('announces the archive and pins the hall of fame', () => {
    const { container } = renderLeaderboard();
    const banner = container.querySelector('.lb-archived-banner');
    expect(banner).toHaveTextContent('Final standings');
    expect(banner).toHaveTextContent(/is archived/i);
    const hall = screen.getByLabelText('Hall of fame');
    expect(hall).toHaveTextContent(/First to BINGO/);
    expect(hall).toHaveTextContent(/Early Bird · /);
    // The frozen daily honours render as their own chips.
    expect(hall).toHaveTextContent('D1');
    expect(hall).toHaveTextContent('D2');
    // The badge on the standings row names the same holder.
    expect(container.querySelector('.list .row.leader .name')).toHaveTextContent('Early Bird');
  });

  it('offers no live controls — the archive is read-only', () => {
    renderLeaderboard();
    // The presentational filters belong to a live Leaderboard; a frozen record
    // has one shape.
    expect(screen.queryByRole('group', { name: 'Filter leaderboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'With BINGO' })).not.toBeInTheDocument();
    // The Share Card survives: a frozen leaderboard is the most shareable thing
    // the Event ever produced (#36, ADR 0005 — on-device, no crawler page).
    expect(screen.getByRole('button', { name: 'Share final standings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share leaderboard' })).not.toBeInTheDocument();
  });

  it('says so when the record retained only a prefix of a large roster', () => {
    H.event = archivedEvent({
      archive: { ...FROZEN, playerCount: 240 },
    } as Partial<EventDoc>);
    renderLeaderboard();
    expect(screen.getByText(/Showing the top 2 of 240 players/)).toBeInTheDocument();
  });

  it('falls back to the live Leaderboard when an archived Event carries no record', () => {
    // Not a state this app can produce — `archiveEvent` writes status, stamp and
    // record in one update — so a hand-edited document keeps rendering the live
    // view, which the rules have already made read-only on `status` alone.
    H.event = archivedEvent({ archive: undefined });
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filter leaderboard' })).toBeInTheDocument();
  });

  it('renders the live Leaderboard while the Event is still active', () => {
    H.event = archivedEvent({ status: 'active' });
    renderLeaderboard();
    expect(screen.getByText('Late Riser')).toBeInTheDocument();
    expect(screen.queryByText('Steady Eddie')).not.toBeInTheDocument();
  });
});

describe('the archived Leaderboard opens no live subscription', () => {
  // specs/post-sailing-archive.md: "It subscribes to NOTHING." Asserting on the
  // rendered output cannot prove that — a component can ignore a hook's value
  // and still have opened its listener. These assert the hooks were never
  // CALLED, which is the only place the listener could come from.
  it('never calls useLeaderboard, useDayMetasStatus or useProofKindsByUid', () => {
    renderLeaderboard();
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });

  it('opens all three for a live Event, so the assertion above is not vacuous', () => {
    H.event = archivedEvent({ status: 'active' });
    renderLeaderboard();
    expect(H.useLeaderboard).toHaveBeenCalled();
    expect(H.useDayMetasStatus).toHaveBeenCalled();
    expect(H.useProofKindsByUid).toHaveBeenCalled();
  });

  it('tears the live subscriptions down when the Event flips to archived', () => {
    H.event = archivedEvent({ status: 'active' });
    const { rerender } = renderLeaderboard();
    expect(H.useLeaderboard).toHaveBeenCalled();
    H.useLeaderboard.mockClear();
    H.useDayMetasStatus.mockClear();
    H.useProofKindsByUid.mockClear();
    H.event = archivedEvent();
    rerender(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    // The live child unmounts, taking its listeners with it — no further call.
    expect(H.useLeaderboard).not.toHaveBeenCalled();
    expect(H.useDayMetasStatus).not.toHaveBeenCalled();
    expect(H.useProofKindsByUid).not.toHaveBeenCalled();
  });
});

describe('a ban still hides a Player after the freeze', () => {
  // specs/w2-ban-console.md § Leaderboard, made permanent: every public
  // Leaderboard view hides a banned Player, and moderation deliberately stays
  // available after the freeze (`bannedUids` is outside the write-once clause).
  it('drops the banned row from the standings without promoting anyone', () => {
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    const { container } = renderLeaderboard();
    const rows = [...container.querySelectorAll('.list .row')];
    const names = rows.map((r) => r.querySelector('.name')?.textContent);
    expect(names).toEqual(['Steady Eddie']);
    // The list closes the gap exactly as the LIVE Leaderboard does when it
    // hides a banned row (`visible.map((p, i) => rank i + 1)`) — leaving a hole
    // at #1 would advertise that a row was removed, which is the opposite of
    // what hiding is for. What must NOT move is the HONOUR: the runner-up is
    // renumbered, never promoted into the star.
    expect(rows[0]?.querySelector('.rank')?.textContent).toBe('1');
    expect(rows[0]?.classList.contains('leader')).toBe(false);
    expect(screen.queryByText('⭐ First BINGO')).not.toBeInTheDocument();
    // And the stored record is untouched underneath: an unban restores the row
    // with its own numbers intact.
    expect(FROZEN.standings.map((r) => r.uid)).toEqual(['early-bird', 'steady']);
  });

  it('vacates the headline honour and the banned Player’s daily chip', () => {
    H.event = archivedEvent({ bannedUids: ['early-bird'] });
    renderLeaderboard();
    const hall = screen.getByLabelText('Hall of fame');
    // Vacated, never reassigned — Steady Eddie does not inherit the star.
    expect(hall).toHaveTextContent('No one got there.');
    expect(hall).not.toHaveTextContent('Early Bird');
    expect(hall).toHaveTextContent('D2');
    expect(hall).not.toHaveTextContent('D1');
  });

  it('keeps the whole record when nobody is banned', () => {
    H.event = archivedEvent({ bannedUids: ['someone-else'] });
    const { container } = renderLeaderboard();
    const names = [...container.querySelectorAll('.list .row .name')].map((n) => n.textContent);
    expect(names).toEqual(['Early Bird', 'Steady Eddie']);
    expect(screen.getByLabelText('Hall of fame')).toHaveTextContent('Early Bird');
  });
});

describe('the Admin archive control', () => {
  it('needs a second, explicit confirmation before it freezes anything', async () => {
    const user = userEvent.setup();
    H.event = archivedEvent({ status: 'active', archivedAt: undefined, archive: undefined });
    render(<ArchiveEvent event={H.event} />);

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm archive' })).toBeInTheDocument();
    // The confirm states what is about to be frozen, from the same builder the
    // write uses, so the preview cannot drift from the record.
    expect(screen.getByText(/Freezing 2 players/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Archive the Event now' }));
    expect(H.archiveEvent).toHaveBeenCalledTimes(1);
    expect(H.archiveEvent.mock.calls[0][0]).toMatchObject({ players: liveRoster });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Archived. The final standings are frozen.',
    );
  });

  it('backs out cleanly when the Admin cancels', async () => {
    const user = userEvent.setup();
    H.event = archivedEvent({ status: 'active', archivedAt: undefined, archive: undefined });
    render(<ArchiveEvent event={H.event} />);

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(H.archiveEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Confirm archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeInTheDocument();
  });

  it('retires the control once the Event is archived and reports the frozen record', () => {
    render(<ArchiveEvent event={archivedEvent()} />);
    expect(screen.queryByRole('button', { name: 'Archive…' })).not.toBeInTheDocument();
    expect(screen.getByText(/^Archived /)).toBeInTheDocument();
    expect(screen.getByText(/2 players · first to BINGO Early Bird/)).toBeInTheDocument();
  });
});
