import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { EventDoc, PlayerDoc } from '../types';
import type { ProofKindFlags } from '../hooks/useData';

// specs/d15-proof-chips-ranks.md, RTL/jsdom layer (#218, union semantics
// #604). Hook aggregation is unit-tested in
// src/hooks/d15-proof-chips-ranks.test.ts; single-hook-stub precedent
// mirrors w2-leaderboard.test.tsx.

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateMock };
});

const H = vi.hoisted(() => ({
  players: [] as PlayerDoc[],
  event: null as EventDoc | null,
  kindsByUid: {} as Record<string, ProofKindFlags>,
}));

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: H.players, loading: false }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useProofKindsByUid: () => ({ kindsByUid: H.kindsByUid, loading: false }),
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Leaderboard from './Leaderboard';

const mkPlayer = (over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>): PlayerDoc => ({
  photoURL: null, joinedAt: 0, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, reshufflesUsed: 0, ...over,
});
const mkFlags = (over: Partial<ProofKindFlags> = {}): ProofKindFlags => ({
  photo: false, library: false, audio: false, text: false, ...over,
});

const event: EventDoc = {
  name: 'Med 2026', startsOn: '2026-07-16', endsOn: '2026-07-25', status: 'active',
  defaultTheme: 'neon-playground', claimMode: 'honor', admins: [], timezone: 'Europe/Rome',
  days: [], bannedUids: [], settings: { reportHideThreshold: 5 },
};

const renderLeaderboard = () => render(<MemoryRouter><Leaderboard /></MemoryRouter>);

describe('Leaderboard proof chips — union of used kinds (#604)', () => {
  it('shows one chip per proof kind the Player has used, in stable 📷 🖼️ 🎙️ ✍️ order', () => {
    // Nathan mixed a live photo, a library photo, and written proof (the
    // exact case reported in #604) — every kind should render, none twice.
    H.players = [mkPlayer({ uid: 'nathan', displayName: 'Nathan' }), mkPlayer({ uid: 'ana', displayName: 'Ana' })];
    H.event = event;
    H.kindsByUid = { nathan: mkFlags({ photo: true, library: true, text: true }) };

    const { container } = renderLeaderboard();

    const chip = screen.getByRole('button', { name: /proof types/i });
    const spans = Array.from(chip.querySelectorAll('span')).map((s) => s.textContent);
    expect(spans).toEqual(['📷', '🖼️', '✍️']);
    const anaRow = screen.getByText('Ana').closest('.row') as HTMLElement;
    expect(anaRow.querySelector('.lb-proof-chips')).toBeNull();
    expect(container.querySelectorAll('.lb-proof-chips')).toHaveLength(1);
  });

  it('a Player who has only ever used one kind shows exactly that one chip', () => {
    H.players = [mkPlayer({ uid: 'bob', displayName: 'Bob' })];
    H.event = event;
    H.kindsByUid = { bob: mkFlags({ text: true }) };

    renderLeaderboard();

    const chip = screen.getByRole('button', { name: /proof types/i });
    expect(chip.querySelectorAll('span')).toHaveLength(1);
    expect(chip).toHaveTextContent('✍️');
  });

  it('a Player with no active Proof renders no chip at all', () => {
    H.players = [mkPlayer({ uid: 'ana', displayName: 'Ana' })];
    H.event = event;
    H.kindsByUid = {};

    const { container } = renderLeaderboard();

    expect(container.querySelectorAll('.lb-proof-chips')).toHaveLength(0);
  });

  it('tap-through navigates to the Feed, and chip presence never reorders the roster', async () => {
    const user = userEvent.setup();
    // Ana (rank #1 on bingoCount) has no Proof; Bob (rank #2) does — proving
    // the chip decorates without moving either row.
    H.players = [
      mkPlayer({ uid: 'ana', displayName: 'Ana', bingoCount: 2 }),
      mkPlayer({ uid: 'bob', displayName: 'Bob', bingoCount: 1 }),
    ];
    H.event = event;
    H.kindsByUid = { bob: mkFlags({ text: true }) };

    const { container } = renderLeaderboard();

    const rows = Array.from(container.querySelectorAll('.list .row'));
    expect(rows[0]).toHaveTextContent('Ana');
    expect(rows[1]).toHaveTextContent('Bob');
    expect(rows[0].querySelector('.lb-proof-chips')).toBeNull();
    expect(rows[1].querySelector('.lb-proof-chips')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /proof types/i }));
    expect(navigateMock).toHaveBeenCalledWith('/feed');
  });
});
