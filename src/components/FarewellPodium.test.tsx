import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DayDef, EventDoc, MostLovedPhotoAward, ProofDoc } from '../types';
import TutorialBanner from './TutorialBanner';
import FarewellPodium, { FarewellPodiumView, type FarewellMostLoved } from './FarewellPodium';
import type { Podium } from '../data/finale';

// The share-affordance wrapper (issue #449) pulls useEventDoc/analytics/
// ShareCard (and, via leaderboardShareCopy, Leaderboard's hook imports) into
// this file's module graph. This suite only exercises the presentational
// FarewellPodiumView plus the #561 Most-Loved data shaping in the wrapper, so
// the module boundary gets inert stand-ins — the w2-share-cards.test.tsx
// precedent; the share behavior itself is pinned there, not here.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track }));
// #561: the wrapper opens the Feed's own proof hook ONLY when the persisted
// award exists — M.proofFeedCalls records every call so the no-award branch
// can prove the listener never opens.
const M = vi.hoisted(() => ({
  proofs: [] as unknown[],
  proofsLoading: false,
  proofFeedCalls: [] as Array<number | null>,
}));
vi.mock('../hooks/useData', () => ({
  useEventDoc: () => ({ data: null, loading: false }),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useLeaderboard: () => ({ players: [], loading: false }),
  useLatestProofByUid: () => ({ latestByUid: {}, loading: false }),
  useProofFeed: (max: number | null) => {
    M.proofFeedCalls.push(max);
    return { proofs: M.proofs, loading: M.proofsLoading };
  },
  isBanned: () => false,
}));

// Covers specs/d15-finale.md: the farewell podium banner renders the champion,
// the cruise-wide First to BINGO, and the ten daily-honor rows from a fixture
// payload, and mounts ABOVE the goodbye banner (its stacking order). #561 adds
// the Most-Loved Photo section (specs/most-loved-photo.md): the frozen award
// above the podium title, its highlights fallback, and the display-gate
// shaping in the data wrapper.

const FIXTURE: Podium = {
  champion: { uid: 'jess', displayName: 'Jess', bingoCount: 4, squaresMarked: 33 },
  firstBingo: { uid: 'marco', displayName: 'Marco', at: 1_700_000_000_000 },
  dailyHonors: Array.from({ length: 10 }, (_, i) => ({
    dayIndex: i,
    uid: `winner-${i}`,
    displayName: `Winner ${i}`,
    firstBingoAt: 1_700_000_000_000 + i,
  })),
  runnersUp: [],
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
        podium={{ champion: { uid: 'x', displayName: 'Solo', bingoCount: 1, squaresMarked: 5 }, firstBingo: null, dailyHonors: [], runnersUp: [] }}
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
      <FarewellPodiumView podium={{ champion: null, firstBingo: null, dailyHonors: [], runnersUp: [] }} />,
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

// ---------------------------------------------------------------------------
// #561 — the Most-Loved Photo section (specs/most-loved-photo.md)
// ---------------------------------------------------------------------------

const AWARD_SECTION: FarewellMostLoved = {
  kind: 'award',
  heartCount: 7,
  photos: [
    {
      proofId: 'p1',
      src: 'https://firebasestorage.googleapis.com/v0/b/x/o/proofs%2Fp1?alt=media',
      displayName: 'Priya',
      promptText: 'Original suspense-movie still',
      dayIndex: 0,
    },
    {
      proofId: 'p2',
      src: 'https://firebasestorage.googleapis.com/v0/b/x/o/proofs%2Fp2?alt=media',
      displayName: 'Jess 🌊',
      promptText: 'Fog bank rolling in',
      dayIndex: null,
    },
  ],
};

describe('FarewellPodiumView — Most-Loved Photo section (#561)', () => {
  it('renders every tied photo above the podium title, with ONE frozen heart chip each and a credit line', () => {
    const { container } = render(<FarewellPodiumView podium={FIXTURE} mostLoved={AWARD_SECTION} />);

    const block = container.querySelector('.farewell-most-loved')!;
    expect(block).toBeTruthy();
    // Section title carries the Edition occasion (gcb default → "cruise").
    expect(block.querySelector('.farewell-most-loved-title')?.textContent).toBe(
      'Most-loved photo of the cruise',
    );
    // ALL co-winners render (in-app shows every tied photo), in award order.
    const photos = block.querySelectorAll<HTMLImageElement>('.farewell-most-loved-photo');
    expect(photos).toHaveLength(2);
    expect(photos[0].src).toContain('proofs%2Fp1');
    expect(photos[1].src).toContain('proofs%2Fp2');
    // The chip shows the FROZEN eligible count on every winner.
    const chips = block.querySelectorAll('.farewell-most-loved-hearts');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('❤ 7');
    expect(chips[1].textContent).toBe('❤ 7');
    // Credit: name · “prompt” · Day N (Day omitted when unknown); emoji in a
    // display name is atomized for the screenshot capture (#603).
    const credits = block.querySelectorAll('.farewell-most-loved-credit');
    expect(credits[0].textContent).toBe('Priya · “Original suspense-movie still” · Day 1');
    expect(credits[1].textContent).toBe('Jess 🌊 · “Fog bank rolling in”');
    expect(credits[1].querySelector('span.emoji-run')?.textContent).toBe('🌊');
    // The frozen footnote, Edition-voiced.
    expect(block.querySelector('.farewell-most-loved-note')?.textContent).toBe(
      'Frozen at cruise end',
    );
    // ABOVE the podium title (the fx-podium-* stacking order).
    const title = container.querySelector('.farewell-podium-title')!;
    expect(block.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('frames the award as appreciation, never rank: no stats, no rank language, only the frozen chip number', () => {
    const { container } = render(<FarewellPodiumView podium={FIXTURE} mostLoved={AWARD_SECTION} />);
    const text = container.querySelector('.farewell-most-loved')!.textContent ?? '';
    expect(text).not.toMatch(/bingo|square|champion|rank|winner|streak|first to/i);
    // The only digits in the block are the frozen heart count and the Day chip
    // (chip · "Day 1" credit · second winner's chip, in DOM order).
    expect(text.match(/\d+/g)).toEqual(['7', '1', '7']);
  });

  it('renders the highlights fallback with NO award framing: no chips, no note, plain credits', () => {
    const highlights: FarewellMostLoved = {
      kind: 'highlights',
      photos: [
        { proofId: 'p9', src: 'https://x.test/nine.jpg', displayName: 'Ana', promptText: 'Beach bonfire', dayIndex: 2 },
      ],
    };
    const { container } = render(<FarewellPodiumView podium={FIXTURE} mostLoved={highlights} />);
    const block = container.querySelector('.farewell-most-loved')!;
    expect(block.querySelector('.farewell-most-loved-title')?.textContent).toBe('Photo highlights');
    expect(block.querySelectorAll('.farewell-most-loved-hearts')).toHaveLength(0);
    expect(block.querySelector('.farewell-most-loved-note')).toBeNull();
    // Highlights credit is name · “prompt” only — no Day chip, no numbers.
    expect(block.querySelector('.farewell-most-loved-credit')?.textContent).toBe(
      'Ana · “Beach bonfire”',
    );
  });

  it('renders no section for a null payload or an empty photo list', () => {
    const { container: c1 } = render(<FarewellPodiumView podium={FIXTURE} mostLoved={null} />);
    expect(c1.querySelector('.farewell-most-loved')).toBeNull();
    const { container: c2 } = render(
      <FarewellPodiumView podium={FIXTURE} mostLoved={{ kind: 'highlights', photos: [] }} />,
    );
    expect(c2.querySelector('.farewell-most-loved')).toBeNull();
  });

  it('an award section keeps an otherwise-empty podium alive (no null short-circuit)', () => {
    const { container } = render(
      <FarewellPodiumView
        podium={{ champion: null, firstBingo: null, dailyHonors: [], runnersUp: [] }}
        mostLoved={AWARD_SECTION}
      />,
    );
    expect(container.querySelector('.farewell-most-loved')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #561 — wrapper shaping: the display gate over live proofs + analytics
// ---------------------------------------------------------------------------

function proofDoc(over: Partial<ProofDoc> & Pick<ProofDoc, 'id' | 'uid' | 'createdAt'>): ProofDoc {
  return {
    displayName: `Poster ${over.id}`,
    photoURL: null,
    type: 'photo',
    cellIndex: 3,
    itemText: `Prompt ${over.id}`,
    mediaURL: `https://firebasestorage.googleapis.com/v0/b/x/o/proofs%2F${over.id}?alt=media`,
    reportCount: 0,
    status: 'active',
    dayIndex: 1,
    ...over,
  };
}

const AWARD: MostLovedPhotoAward = {
  winners: [
    {
      proofId: 'w1',
      uid: 'ana',
      displayName: 'Ana',
      promptText: 'Sunset over the bay',
      dayIndex: 1,
      proofCreatedAt: 1000,
    },
    {
      proofId: 'w2',
      uid: 'bea',
      displayName: 'Bea',
      promptText: 'Fog bank rolling in',
      dayIndex: 2,
      proofCreatedAt: 2000,
    },
  ],
  heartCount: 5,
  frozenAt: 9_000,
  computedAt: 9_050,
};

function awardedEvent(award: MostLovedPhotoAward): EventDoc {
  return { name: 'Bodega Bay 2026', mostLovedPhoto: award } as EventDoc;
}

describe('FarewellPodium wrapper — Most-Loved display gate + analytics (#561)', () => {
  // This project's jsdom variant ships NO localStorage (src/test/setup.ts
  // already guards for that) — install a minimal in-memory stand-in so the
  // once-per-device analytics guard is exercised for real; the component's own
  // try/catch covers the storage-less case in production private modes.
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
    };
  }

  beforeEach(() => {
    track.mockReset();
    M.proofs = [];
    M.proofsLoading = false;
    M.proofFeedCalls = [];
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'localStorage');
  });

  it('joins the persisted winners to the live Feed proofs and renders the award (tie → ALL photos, frozen count)', () => {
    M.proofs = [proofDoc({ id: 'w1', uid: 'ana', createdAt: 1000 }), proofDoc({ id: 'w2', uid: 'bea', createdAt: 2000 })];
    const { container } = render(
      <FarewellPodium players={[]} days={undefined} event={awardedEvent(AWARD)} />,
    );
    // The Feed's OWN hook, explicitly uncapped: a winning photo may predate an arbitrary
    // recent-items ceiling, but it must remain available for the frozen award's
    // moderation-aware join.
    expect(M.proofFeedCalls).toContain(null);
    const photos = container.querySelectorAll<HTMLImageElement>('.farewell-most-loved-photo');
    expect(photos).toHaveLength(2);
    expect(photos[0].src).toContain('proofs%2Fw1'); // award order — earliest-posted first
    expect(container.querySelector('.farewell-most-loved-hearts')?.textContent).toBe('❤ 5');
    // Winner display data comes from the FROZEN award record, not the mutable
    // live doc (whose fixture display name is "Poster w1").
    expect(container.querySelector('.farewell-most-loved-credit')?.textContent).toContain(
      'Ana · “Sunset over the bay” · Day 2',
    );
  });

  it('drops a hidden-after-freeze winner from display and falls back to photo highlights when none survive', () => {
    // Neither winner survives the Feed filter (w1 gone, w2 recreated later) —
    // the award record is untouched; DISPLAY falls back to highlights: the
    // newest three visible photos, no award framing.
    M.proofs = [
      proofDoc({ id: 'w2', uid: 'bea', createdAt: 3000 }), // incarnation mismatch
      proofDoc({ id: 'h1', uid: 'cy', createdAt: 2500 }),
      proofDoc({ id: 'h2', uid: 'di', createdAt: 2400 }),
      proofDoc({ id: 'h3', uid: 'ed', createdAt: 2300 }),
      proofDoc({ id: 'h4', uid: 'fi', createdAt: 2200 }),
    ];
    const { container } = render(
      <FarewellPodium players={[]} days={undefined} event={awardedEvent(AWARD)} />,
    );
    expect(container.querySelector('.farewell-most-loved-title')?.textContent).toBe(
      'Photo highlights',
    );
    // Up to 3, and the mismatched-incarnation w2 still qualifies as a PHOTO
    // highlight (it is a visible photo; it just is not the frozen winner).
    expect(container.querySelectorAll('.farewell-most-loved-photo')).toHaveLength(3);
    expect(container.querySelectorAll('.farewell-most-loved-hearts')).toHaveLength(0);
  });

  it('a surviving co-winner still renders the award when the other was hidden', () => {
    M.proofs = [proofDoc({ id: 'w2', uid: 'bea', createdAt: 2000 })];
    const { container } = render(
      <FarewellPodium players={[]} days={undefined} event={awardedEvent(AWARD)} />,
    );
    const photos = container.querySelectorAll<HTMLImageElement>('.farewell-most-loved-photo');
    expect(photos).toHaveLength(1);
    expect(photos[0].src).toContain('proofs%2Fw2');
    expect(container.querySelector('.farewell-most-loved-title')?.textContent).toBe(
      'Most-loved photo of the cruise',
    );
  });

  it('the explicit no-award record (winners: []) renders the highlights fallback', () => {
    M.proofs = [proofDoc({ id: 'h1', uid: 'cy', createdAt: 2500 })];
    const { container } = render(
      <FarewellPodium
        players={[]}
        days={undefined}
        event={awardedEvent({ winners: [], heartCount: 0, frozenAt: 9000, computedAt: 9050 })}
      />,
    );
    expect(container.querySelector('.farewell-most-loved-title')?.textContent).toBe(
      'Photo highlights',
    );
  });

  it('renders NO section while the proofs are still loading — the award must never flash as the fallback', () => {
    // A real champion keeps the podium itself rendering, so the withheld share
    // button below is the GATE at work, not an empty-podium null.
    const champ = {
      uid: 'champ',
      displayName: 'Maya',
      photoURL: null,
      joinedAt: 0,
      bingoCount: 2,
      squaresMarked: 12,
      firstBingoAt: 100,
      reshufflesUsed: 0,
    };
    M.proofs = [];
    M.proofsLoading = true;
    const { container } = render(
      <FarewellPodium players={[champ]} days={undefined} event={awardedEvent(AWARD)} />,
    );
    expect(container.querySelector('.farewell-podium')).toBeTruthy();
    expect(container.querySelector('.farewell-most-loved')).toBeNull();
    // The don't-bake-an-incomplete-card gate: with winners recorded and proofs
    // still loading, the share affordance waits too.
    expect(screen.queryByRole('button', { name: 'Share final standings' })).toBeNull();
  });

  it('without a persisted award nothing mounts: no section, no proof listener, no analytics', () => {
    const { container } = render(
      <FarewellPodium
        players={[]}
        days={undefined}
        event={{ name: 'Bodega Bay 2026' } as EventDoc}
      />,
    );
    expect(container.querySelector('.farewell-most-loved')).toBeNull();
    expect(M.proofFeedCalls).toHaveLength(0);
    expect(track).not.toHaveBeenCalledWith('most_loved_photo_frozen', expect.anything());
  });

  it('fires most_loved_photo_frozen ONCE per device on first observation — ids and counts only', () => {
    M.proofs = [proofDoc({ id: 'w1', uid: 'ana', createdAt: 1000 })];
    const first = render(<FarewellPodium players={[]} days={undefined} event={awardedEvent(AWARD)} />);
    expect(track).toHaveBeenCalledWith('most_loved_photo_frozen', {
      winnersCount: 2,
      heartCount: 5,
      tie: true,
      award: true,
      proofId: 'w1',
      dayIndex: 1,
    });
    expect(track.mock.calls.filter(([name]) => name === 'most_loved_photo_frozen')).toHaveLength(1);
    first.unmount();
    // A later session (fresh mount, same device) is guarded by localStorage.
    render(<FarewellPodium players={[]} days={undefined} event={awardedEvent(AWARD)} />);
    expect(track.mock.calls.filter(([name]) => name === 'most_loved_photo_frozen')).toHaveLength(1);
  });

  it('the no-award record still fires the beat — award: false is signal', () => {
    render(
      <FarewellPodium
        players={[]}
        days={undefined}
        event={awardedEvent({ winners: [], heartCount: 0, frozenAt: 9000, computedAt: 9050 })}
      />,
    );
    expect(track).toHaveBeenCalledWith('most_loved_photo_frozen', {
      winnersCount: 0,
      heartCount: 0,
      tie: false,
      award: false,
      proofId: null,
      dayIndex: null,
    });
  });
});
