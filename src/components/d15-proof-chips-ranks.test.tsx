import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { EventDoc, PlayerDoc, ProofDoc } from '../types';

// specs/d15-proof-chips-ranks.md, RTL/jsdom layer (#218). Hook filtering is
// unit-tested in src/hooks/d15-proof-chips-ranks.test.ts; single-hook-stub
// precedent mirrors w2-leaderboard.test.tsx.

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateMock };
});

const H = vi.hoisted(() => ({
  players: [] as PlayerDoc[],
  event: null as EventDoc | null,
  latestByUid: {} as Record<string, ProofDoc>,
}));

vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: H.players, loading: false }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useLatestProofByUid: () => ({ latestByUid: H.latestByUid, loading: false }),
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Leaderboard from './Leaderboard';

const mkPlayer = (over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>): PlayerDoc => ({
  photoURL: null, joinedAt: 0, bingoCount: 0, squaresMarked: 0, firstBingoAt: null, reshufflesUsed: 0, ...over,
});
const mkProof = (uid: string, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id: `${uid}-proof`, uid, displayName: uid, photoURL: null, type: 'photo', cellIndex: 0,
    itemText: 'Wore a sequin harness', storagePath: null, mediaURL: null, thumbURL: null,
    text: null, createdAt: 1_000, reportCount: 0, status: 'active', visionFlag: null, source: null, ...over,
  }) as ProofDoc;

const event: EventDoc = {
  name: 'Med 2026', sailStart: '2026-07-16', sailEnd: '2026-07-25', status: 'active',
  defaultTheme: 'neon-playground', claimMode: 'honor', admins: [], timezone: 'Europe/Rome',
  days: [], bannedUids: [], settings: { reportHideThreshold: 5 },
};

const renderLeaderboard = () => render(<MemoryRouter><Leaderboard /></MemoryRouter>);

describe('Leaderboard proof chips (#218)', () => {
  it('shows both 📷 and 🖼️ for a library-sourced photo Proof, and none for a Player with no Proof', () => {
    H.players = [mkPlayer({ uid: 'bob', displayName: 'Bob' }), mkPlayer({ uid: 'ana', displayName: 'Ana' })];
    H.event = event;
    H.latestByUid = { bob: mkProof('bob', { type: 'photo', source: 'library' }) };

    const { container } = renderLeaderboard();

    const chip = screen.getByRole('button', { name: /latest proof/i });
    expect(chip).toHaveTextContent('📷');
    expect(chip).toHaveTextContent('🖼️');
    const anaRow = screen.getByText('Ana').closest('.row') as HTMLElement;
    expect(anaRow.querySelector('.lb-proof-chips')).toBeNull();
    expect(container.querySelectorAll('.lb-proof-chips')).toHaveLength(1);
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
    H.latestByUid = { bob: mkProof('bob', { type: 'text' }) };

    const { container } = renderLeaderboard();

    const rows = Array.from(container.querySelectorAll('.list .row'));
    expect(rows[0]).toHaveTextContent('Ana');
    expect(rows[1]).toHaveTextContent('Bob');
    expect(rows[0].querySelector('.lb-proof-chips')).toBeNull();
    expect(rows[1].querySelector('.lb-proof-chips')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /latest proof/i }));
    expect(navigateMock).toHaveBeenCalledWith('/feed');
  });
});
