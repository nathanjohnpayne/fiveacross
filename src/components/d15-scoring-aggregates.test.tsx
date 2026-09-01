import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DayDef, EventDoc, PlayerDoc } from '../types';

// specs/d15-scoring-aggregates.md, RTL/jsdom layer. Leaderboard is presentational
// over useLeaderboard's already-ranked roster; the cruise-wide restriction and
// per-Day honors math are unit-tested directly in
// src/game/d15-scoring-aggregates.test.ts. These two tests pin the SURFACES this
// ticket adds: (1) the per-Day First to BINGO honors strip renders each Day's
// pinned Player, and (2) the cruise-wide "1st BINGO" pin never lands on an
// embark/farewell-only first bingo (it tracks the earliest MAIN-GAME bingo, which
// need not be rank #1). Same single-hook-stub precedent as w2-leaderboard.test.tsx.

const days: DayDef[] = Array.from({ length: 10 }, (_, index) => ({
  index,
  date: '2026-07-16',
  place: index === 0 ? 'Embark' : index === 9 ? 'Farewell' : `Port ${index}`,
  placeEmoji: '🇭🇷',
  theme: 'neon-playground',
  tonight: [],
  pool: index === 0 ? 'easy' : index === 9 ? 'closing' : 'main',
  tutorial: index === 0 || index === 9,
  unlockAt: 0,
}));

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

// Pre-ranked as sortPlayers would: both hold 1 bingo, so more-squares wins — the
// embark-only Player ranks #1 by squares (12 > 6), yet the cruise pin must land on
// the main-game Player below them. `embarker` bingoed first in wall-clock terms
// (10 < 900) but ONLY on the embark card, so it is excluded from the headline.
const embarker = mkPlayer({
  uid: 'embarker',
  displayName: 'Embarker',
  bingoCount: 1,
  squaresMarked: 12,
  firstBingoAt: null, // root already excludes the embark-only bingo
  dayStats: { 0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 10 } },
});
const champ = mkPlayer({
  uid: 'champ',
  displayName: 'Champ',
  bingoCount: 1,
  squaresMarked: 6,
  firstBingoAt: 900,
  dayStats: { 2: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 900 } },
});

const event: EventDoc = {
  name: 'Med 2026',
  startsOn: '2026-07-16',
  endsOn: '2026-07-25',
  status: 'active',
  defaultTheme: 'neon-playground',
  claimMode: 'honor',
  admins: [],
  timezone: 'Europe/Rome',
  days,
  bannedUids: [],
  settings: { reportHideThreshold: 5 },
};

const H = vi.hoisted(() => ({
  players: [] as PlayerDoc[],
  event: null as EventDoc | null,
  dayMetas: new Map() as Map<number, { firstBingo: { uid: string; displayName: string; at: number } }>,
  dayMetasLoaded: true,
}));

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ EVENT_ID: 'test-event' }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — the strip's pinned-honor source.
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => H.dayMetas,
  useDayMetasStatus: () => ({ metas: H.dayMetas, loaded: H.dayMetasLoaded }),
  useLeaderboard: () => ({ players: H.players, loading: false }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  // #218: no Proofs fixtured in this scoring-aggregates suite — an empty map
  // keeps every row chip-less, which is exactly what these tests assert on.
  useProofKindsByUid: () => ({ kindsByUid: {}, loading: false }),
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Leaderboard from './Leaderboard';

beforeEach(() => {
  H.players = [];
  H.event = null;
  H.dayMetas = new Map();
  H.dayMetasLoaded = true;
});

describe('Leaderboard cruise-wide honors (#212)', () => {
  it("renders a per-Day honors strip pinning each Day's first-bingo Player", () => {
    H.players = [embarker, champ];
    H.event = event;
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );

    const strip = screen.getByLabelText('Daily First to BINGO');
    // Each Day's own honoree — tutorial Day 0 included (its exclusion is only from
    // the cruise-wide pin), plus main-game Day 2.
    expect(strip).toHaveTextContent('Embarker');
    expect(strip).toHaveTextContent('Champ');
    // #264: chips read theme-emoji + D<n> (wireframe), one per Day, with a "—"
    // placeholder for winnerless Days.
    expect(strip).toHaveTextContent('D1');
    expect(strip).toHaveTextContent('D3');
    expect(strip).toHaveTextContent('—');
  });

  it('never lands the cruise "1st BINGO" pin on an embark/farewell-only first bingo', () => {
    H.players = [embarker, champ];
    H.event = event;
    const { container } = render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    const list = container.querySelector('.list') as HTMLElement;

    // The pin is on the main-game Player (Champ), NOT the embark-only Player who
    // bingoed earlier in wall-clock terms and ranks above them.
    const champRow = within(list).getByText('Champ').closest('.row');
    const embarkerRow = within(list).getByText('Embarker').closest('.row');
    expect(champRow?.querySelector('.badge')).toHaveTextContent('First BINGO');
    expect(embarkerRow?.querySelector('.badge')).toBeNull();
  });

  it('describes First-to-BINGO eligibility by tutorial policy, not pool identity', () => {
    H.players = [embarker, champ];
    H.event = event;
    const { container } = render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );

    const footnote = container.querySelector('.lb-footnote');
    expect(footnote).toHaveTextContent('First to BINGO—tutorial Days excluded.');
    expect(footnote).not.toHaveTextContent(/main days only/i);
  });

  it('omits the eligibility exclusion when the Event has no tutorial Day', () => {
    H.players = [embarker, champ];
    H.event = {
      ...event,
      days: event.days?.map((day) => ({ ...day, tutorial: false })),
    };
    const { container } = render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );

    const footnote = container.querySelector('.lb-footnote');
    expect(footnote).toHaveTextContent('First to BINGO.');
    expect(footnote).not.toHaveTextContent(/tutorial Days excluded/i);
  });
});

describe('Leaderboard honors strip prefers the PINNED day-meta honor (#264)', () => {
  it('renders the pinned name over the roster-derived one, and the derived name where no pin exists', () => {
    H.players = [embarker, champ];
    H.event = event;
    // Day 2 (index 2) is pinned to a DIFFERENT player than the derived honoree
    // (a pre-resolution race the write-once pin settled first) — the pin wins.
    H.dayMetas = new Map([[2, { firstBingo: { uid: 'p9', displayName: 'Pinned Pat', at: 1 } }]]);
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    const strip = screen.getByLabelText('Daily First to BINGO');
    expect(strip).toHaveTextContent('Pinned Pat'); // the pin, not 'Champ'
    expect(strip).toHaveTextContent('Embarker'); // derived fallback where unpinned
    H.dayMetas = new Map();
  });

  it('does not use derived honors while day-meta pins are still loading', () => {
    H.players = [embarker, champ];
    H.event = event;
    H.dayMetasLoaded = false;
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    const strip = screen.getByLabelText('Daily First to BINGO');
    expect(strip).not.toHaveTextContent('Embarker');
    expect(strip).not.toHaveTextContent('Champ');
    expect(strip).toHaveTextContent('—');
  });

  it('the PIN wins when present — derived dayStats stamps cannot tiebreak it (Codex round 4 on #280)', () => {
    H.players = [embarker, champ];
    H.event = event;
    // Champ's derived Day-2 bucket carries an earlier stamp (900), but derived
    // stamps can be seeded from the cruise-wide root (another day's time
    // entirely) — the write-once, rules-timestamped pin is the source of
    // truth. The unknown-identity residual is covered by the module-state
    // held-pin queue, not by distrusting pins.
    H.dayMetas = new Map([[2, { firstBingo: { uid: 'late', displayName: 'Pinned Pete', at: 5000 } }]]);
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    const strip = screen.getByLabelText('Daily First to BINGO');
    expect(strip).toHaveTextContent('Pinned Pete');
    expect(strip).not.toHaveTextContent('Champ');
    H.dayMetas = new Map();
  });

  it("a banned Player's pin renders as '—' — hidden, never promoted (Codex P2 on #280)", () => {
    H.players = [embarker, champ];
    H.event = { ...event, bannedUids: ['banned-b'] } as typeof event;
    // The pin belongs to a banned Player and the visible derived honoree's stamp is
    // EARLIER than that pin. The chip still hides the name without handing the
    // honor to Champ — a ban never rewrites the canonical holder.
    H.dayMetas = new Map([[2, { firstBingo: { uid: 'banned-b', displayName: 'Banned Bart', at: 5000 } }]]);
    render(
      <MemoryRouter>
        <Leaderboard />
      </MemoryRouter>,
    );
    const strip = screen.getByLabelText('Daily First to BINGO');
    expect(strip).not.toHaveTextContent('Banned Bart');
    // EmojiText (#603) splits the chip label across an .emoji-run span and a
    // text node, so match on the span's aggregate textContent, not one node.
    const d3chip = within(strip)
      .getByText((_, node) => node?.classList.contains('lb-honor-day') === true && node.textContent === '🌈 D3')
      .closest('.lb-honor');
    expect(d3chip?.textContent).toContain('—');
    H.dayMetas = new Map();
  });
});
