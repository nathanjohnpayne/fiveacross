import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DayDef, EventDoc, ItemDoc, ProofDoc, PlayerDoc } from '../types';

// specs/w2-ban-console.md, component layer (RTL-jsdom). Two surfaces:
//   1. Admin console — the Ban / Unban control (#108): each queue row can ban its
//      content owner (banUser), a banned author's row shows Unban and STAYS
//      reachable (admin views are UNfiltered), and the Banned players section lists
//      the roster with an Unban for a Player who has no queued content left.
//   2. Leaderboard — the presentational ban filter hides a banned Player from the
//      VIEW, while the First-to-BINGO pin (read from the RAW roster) is NEVER
//      reassigned to a later Player. This is the leaderboard/first-bingo split's
//      view half; the hook half (useLeaderboard stays raw) is pinned in
//      src/hooks/w2-ban-console.test.tsx.

const H = vi.hoisted(() => ({
  user: { uid: 'admin-uid' } as { uid: string } | null,
  event: {} as unknown as EventDoc,
  claims: [] as unknown[],
  flagged: [] as ProofDoc[],
  items: [] as ItemDoc[],
  players: [] as PlayerDoc[],
  // The Leaderboard's day-meta PIN source (#264). Empty for every test but the
  // honours-strip ones below, which need a pinned Day to tell the pinned branch
  // of `pinnedOrDerivedDailyHonors` from its derived fallback.
  dayMetas: new Map() as Map<number, { firstBingo: { uid: string; displayName: string; at: number } }>,
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  // The rest of the admin writes are stubbed so the console renders; only ban/unban
  // is asserted here (the other controls are pinned in w2-admin-console.test.tsx).
  confirmClaim: vi.fn(),
  rejectClaim: vi.fn(),
  hideProof: vi.fn(),
  restoreProof: vi.fn(),
  clearProofReports: vi.fn(),
  hideItem: vi.fn(),
  restoreItem: vi.fn(),
  deleteItem: vi.fn(),
  clearItemReports: vi.fn(),
  setClaimMode: vi.fn(),
  setEventTheme: vi.fn(),
  deleteProof: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...a: unknown[]) => makeRef('doc', a),
    collection: (...a: unknown[]) => makeRef('collection', a),
    query: (...a: unknown[]) => ({ query: a }),
    where: (...a: unknown[]) => ({ where: a }),
    onSnapshot: vi.fn(() => () => {}),
  };
});

// Keep the REAL isReportHidden + isBanned (the predicates under test); override
// only the subscription hooks the console + leaderboard read.
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  return {
    ...actual,
    // `serverResolved` is Leaderboard's ROUTING gate (#1152): the live view — the
    // one this suite's ban filter is about — mounts only once the Event's status
    // has been answered by the server.
    useEventDoc: () => ({
      data: H.event,
      loading: false,
      hasServerData: true,
      serverResolved: true,
      hasPendingWrites: false,
    }),
    usePendingClaims: () => ({ claims: H.claims }),
    useReportedProofs: () => ({ flagged: H.flagged, loading: false }),
    useAllItems: () => ({ items: H.items, loading: false }),
    useDayMetasStatus: () => ({ metas: H.dayMetas, loaded: true }),
    useLeaderboard: () => ({ players: H.players, loading: false, hasServerData: true }),
  };
});
vi.mock('../data/admin', () => ({
  confirmClaim: (...a: unknown[]) => H.confirmClaim(...a),
  rejectClaim: (...a: unknown[]) => H.rejectClaim(...a),
  hideProof: (...a: unknown[]) => H.hideProof(...a),
  restoreProof: (...a: unknown[]) => H.restoreProof(...a),
  clearProofReports: (...a: unknown[]) => H.clearProofReports(...a),
  hideItem: (...a: unknown[]) => H.hideItem(...a),
  restoreItem: (...a: unknown[]) => H.restoreItem(...a),
  deleteItem: (...a: unknown[]) => H.deleteItem(...a),
  clearItemReports: (...a: unknown[]) => H.clearItemReports(...a),
  setClaimMode: (...a: unknown[]) => H.setClaimMode(...a),
  setEventTheme: (...a: unknown[]) => H.setEventTheme(...a),
  setDayTheme: vi.fn(),
  // #222 Proof & Claims panel no-op stubs (coverage: Admin.test.tsx).
  setPhotoProofSource: vi.fn(),
  setStripPhotoExif: vi.fn(),
  setVisionGate: vi.fn(),
  setReportHideThreshold: vi.fn(),
  banUser: (...a: unknown[]) => H.banUser(...a),
  unbanUser: (...a: unknown[]) => H.unbanUser(...a),
}));
vi.mock('../data/proofs', () => ({ deleteProof: (...a: unknown[]) => H.deleteProof(...a) }));
// Admin pickers read the EDITION-SCOPED list, not the registry (#555).
vi.mock('../theme/themes', () => {
  const THEMES = [{ id: 'neon-playground', emoji: '🎉', label: 'Neon' }];
  return { THEMES, themesForEdition: () => THEMES, themesForEditionIncluding: () => THEMES };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));
// Leaderboard's Share Card + avatar + analytics are irrelevant to the ban filter.
vi.mock('./ShareCard', () => ({
  renderLeaderboardShareCard: vi.fn(() => Promise.resolve(null)),
  shareCardBlob: vi.fn(() => Promise.resolve()),
  shareCardAppName: () => 'Gay Cruise Bingo',
}));
// Render nothing for the avatar so the Player's name appears exactly once (in the
// row's `.name` div), not also duplicated inside the avatar.
vi.mock('./Avatar', () => ({ default: () => null }));
vi.mock('../analytics', () => ({ track: vi.fn() }));

import Admin from './Admin';
import Leaderboard from './Leaderboard';

const proof = (id: string, uid: string, reportCount: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid,
    displayName: id,
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'x',
    createdAt: 1,
    reportCount,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

const item = (id: string, createdBy: string, reportCount: number, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy,
    createdAt: 1,
    isFreeSpace: false,
    status: 'active',
    reportCount,
    ...over,
  }) as ItemDoc;

const player = (uid: string, displayName: string, firstBingoAt: number | null): PlayerDoc => ({
  uid,
  displayName,
  photoURL: null,
  joinedAt: 1,
  bingoCount: firstBingoAt != null ? 1 : 0,
  squaresMarked: 5,
  firstBingoAt,
  blackout: false,
  reshufflesUsed: 0,
});

// The queue rows live in the Review queue (/more/admin/queue) and the banned
// roster in the Players detail (/more/admin/players) — specs/admin-console-ia.md.
const renderAdmin = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Admin />
    </MemoryRouter>,
  );

const queue = () => document.querySelector('.admin-section.queue') as HTMLElement;
const bannedSection = () =>
  (Array.from(document.querySelectorAll('.admin-section')).find((s) =>
    s.querySelector('h3')?.textContent?.startsWith('Banned players'),
  ) as HTMLElement) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'admin-uid' };
  H.event = {
    name: 'Test Cruise',
    admins: ['admin-uid'],
    settings: { reportHideThreshold: 4 },
    claimMode: 'honor',
    defaultTheme: 'neon-playground',
    bannedUids: [],
  } as unknown as EventDoc;
  H.claims = [];
  H.flagged = [];
  H.items = [];
  H.players = [];
  H.dayMetas = new Map();
});

describe('Admin ban control (specs/w2-ban-console.md)', () => {
  it('offers Ban author on a queue Proof row and calls banUser with the Proof owner uid', () => {
    H.flagged = [proof('p1', 'author-uid', 2)];
    renderAdmin('/more/admin/queue');

    const q = within(queue());
    fireEvent.click(q.getByRole('button', { name: 'Ban author' }));
    expect(H.banUser).toHaveBeenCalledWith('author-uid');
    expect(H.unbanUser).not.toHaveBeenCalled();
  });

  it('shows Unban author on a banned author’s row and KEEPS it reachable (admin views unfiltered)', () => {
    // The author is banned, yet their reported Proof still renders in the queue —
    // only PUBLIC reads filter; the console must reach banned content to unban it.
    H.event = { ...H.event, bannedUids: ['author-uid'] } as EventDoc;
    H.flagged = [proof('p1', 'author-uid', 2, { displayName: 'Banned Betty' })];
    renderAdmin('/more/admin/queue');

    const q = within(queue());
    expect(q.getByText('Banned Betty')).toBeInTheDocument(); // still reachable
    fireEvent.click(q.getByRole('button', { name: 'Unban author' }));
    expect(H.unbanUser).toHaveBeenCalledWith('author-uid');
    expect(H.banUser).not.toHaveBeenCalled();
  });

  it('offers Ban author on a queue Prompt row and calls banUser with createdBy', () => {
    H.items = [item('i1', 'prompt-author', 3)];
    renderAdmin('/more/admin/queue');

    const q = within(queue());
    fireEvent.click(q.getByRole('button', { name: 'Ban author' }));
    expect(H.banUser).toHaveBeenCalledWith('prompt-author');
  });

  it('lists banned uids in the Banned players section and Unban calls unbanUser — even with no queued content', () => {
    // A banned Player whose prompts/proofs are all deleted has no queue row, yet
    // must still be un-bannable: the roster section is the reachable surface.
    H.event = { ...H.event, bannedUids: ['ghost-uid'] } as EventDoc;
    renderAdmin('/more/admin/players');

    const section = within(bannedSection());
    expect(section.getByText('ghost-uid')).toBeInTheDocument();
    fireEvent.click(section.getByRole('button', { name: 'Unban' }));
    expect(H.unbanUser).toHaveBeenCalledWith('ghost-uid');
  });

  it('shows an empty Banned players section when no one is banned', () => {
    renderAdmin('/more/admin/players');
    expect(within(bannedSection()).getByText(/no one is banned/i)).toBeInTheDocument();
  });

  it('renders NO Ban control for a seeded Prompt (createdBy sentinel) but DOES for a real-player Prompt (Codex P1)', () => {
    // Seeded default Prompts carry createdBy 'seed' (scripts/seed.mjs), NOT a player
    // uid. Banning 'seed' would hide the ENTIRE default pool at once, so the Ban
    // control must not render for a sentinel author — only for real players.
    H.items = [
      item('i-seed', 'seed', 3, { text: 'Seeded default prompt' }),
      item('i-real', 'real-player-uid', 3, { text: 'Player prompt' }),
    ];
    renderAdmin('/more/admin/queue');

    // Scope to the queue (the prompt text also appears in the bottom Prompts list).
    const q = within(queue());
    const seededRow = q.getByText('Seeded default prompt').closest('.row') as HTMLElement;
    const realRow = q.getByText('Player prompt').closest('.row') as HTMLElement;
    expect(within(seededRow).queryByRole('button', { name: /ban/i })).toBeNull();
    expect(within(realRow).getByRole('button', { name: 'Ban author' })).toBeInTheDocument();
  });

  it('renders NO Ban control for a row authored by a fellow ADMIN but DOES for a normal player (Codex P2 round 2)', () => {
    // #113 rules reject a bannedUids that overlaps admins, so Ban on an admin-authored
    // row could only ever fail with a permission error — suppress it, the same way as
    // a system author, so the admin never sees a doomed action.
    H.event = { ...H.event, admins: ['admin-uid', 'co-admin-uid'] } as EventDoc;
    H.items = [
      item('i-admin', 'co-admin-uid', 3, { text: 'Co-admin prompt' }),
      item('i-player', 'real-player-uid', 3, { text: 'Player prompt' }),
    ];
    renderAdmin('/more/admin/queue');

    const q = within(queue());
    const adminRow = q.getByText('Co-admin prompt').closest('.row') as HTMLElement;
    const playerRow = q.getByText('Player prompt').closest('.row') as HTMLElement;
    expect(within(adminRow).queryByRole('button', { name: /ban/i })).toBeNull();
    expect(within(playerRow).getByRole('button', { name: 'Ban author' })).toBeInTheDocument();
  });
});

describe('Leaderboard — presentational ban filter + first-bingo split (specs/w2-ban-console.md)', () => {
  it('hides a banned Player from the view and NEVER promotes a later Player to 1st BINGO', () => {
    // THE regression the leaderboard/first-bingo split protects: 'first-banned' was
    // first to BINGO (earliest firstBingoAt). Banning them must hide their ROW but
    // must NOT hand the 1st BINGO pin to the later Player — the pin is read from the
    // RAW roster (a ban never rewrites who was first). This assertion FAILS if the
    // component computed firstBingoUid from the ban-filtered roster instead.
    H.players = [player('first-banned', 'First Banned', 100), player('later-ok', 'Later OK', 200)];
    H.event = { ...H.event, bannedUids: ['first-banned'] } as EventDoc;
    render(<Leaderboard />, { wrapper: MemoryRouter });

    expect(screen.queryByText('First Banned')).toBeNull(); // row hidden from the view
    expect(screen.getByText('Later OK')).toBeInTheDocument(); // the other Player shows
    // The badge does NOT reappear on a later Player: its holder is banned, so no
    // visible row wins it.
    expect(screen.queryByText(/First BINGO/)).toBeNull();
  });

  // THE OTHER HALF OF THE SAME BAN, and the half the test above never looked at.
  // An HONOUR vacates (the assertion above); a POSITION closes the gap. The rank
  // badge is a row's place among the rows being SHOWN — `specs/w2-leaderboard.md`
  // § Design decisions states it for the presentational filters and it reads the
  // same way for a ban, because both are reasons a row is not on screen. Leaving
  // a hole at #1 would advertise that a row was removed, which is the opposite of
  // what hiding is for (`ArchivedLeaderboard` says so in as many words, and the
  // frozen record's own `ArchivedFirstBingoRow.rank` is defined over the
  // ban-filtered standings).
  it('RENUMBERS the visible rows from 1 when a ban hides the row above them', () => {
    H.players = [player('first-banned', 'First Banned', 100), player('later-ok', 'Later OK', 200)];
    H.event = { ...H.event, bannedUids: ['first-banned'] } as EventDoc;
    render(<Leaderboard />, { wrapper: MemoryRouter });

    const rows = Array.from(document.querySelectorAll('.list .row'));
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.rank')?.textContent).toBe('1');
    expect(within(rows[0] as HTMLElement).getByText('Later OK')).toBeInTheDocument();
  });

  it('baseline: without the ban, the first-to-BINGO Player shows WITH the 1st BINGO badge', () => {
    // Proves the ban filter is what removed the badge above, not a broken fixture.
    H.players = [player('first-banned', 'First Banned', 100), player('later-ok', 'Later OK', 200)];
    H.event = { ...H.event, bannedUids: [] } as EventDoc;
    render(<Leaderboard />, { wrapper: MemoryRouter });

    const row = screen.getByText('First Banned').closest('.row') as HTMLElement;
    expect(within(row).getByText(/First BINGO/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The DAILY honours strip (#1217)
// ---------------------------------------------------------------------------

/**
 * The Event-wide ⭐ above is one honour; each Day's own First to BINGO is
 * another, and the same clause covers both — "hidden, never reassigned"
 * (`specs/w2-ban-console.md` § Leaderboard). The PINNED branch was already
 * right, because a day-meta pin carries its own name and instant and is checked
 * against `bannedUids` explicitly (#1146). The DERIVED fallback was not: this
 * component handed `pinnedOrDerivedDailyHonors` the ban-FILTERED `roster`, which
 * is indistinguishable from a roster the banned Player was never on, so
 * `perDayHonors` picked the earliest bingo among whoever was left and that Day's
 * chip named a Player who never held it. The strip reads the RAW roster now,
 * exactly as the ⭐ pin already did and for the reason the rule's own mechanism
 * clause gives: hiding belongs on the OUTPUT, never on the roster going in
 * (`specs/w2-leaderboard.md` § Design decisions).
 */
describe('Leaderboard honours strip — a banned DERIVED honoree vacates the Day (#1217)', () => {
  const days: DayDef[] = [0, 1, 2].map(
    (index) =>
      ({
        index,
        date: `2026-07-1${index}`,
        place: `Port ${index}`,
        placeEmoji: '🏖️',
        theme: 'neon-playground',
        tonight: [],
        pool: 'main',
        tutorial: false,
        unlockAt: 0,
      }) as DayDef,
  );

  const dayPlayer = (
    uid: string,
    displayName: string,
    dayStats: PlayerDoc['dayStats'],
  ): PlayerDoc => ({
    uid,
    displayName,
    photoURL: null,
    joinedAt: 1,
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: null,
    blackout: false,
    reshufflesUsed: 0,
    dayStats,
  });

  // `earliest` is Day 1's true First to BINGO; `later` bingoed on the same Day
  // afterwards, and on Day 2 alone.
  const earliest = dayPlayer('earliest', 'Earliest Eddy', {
    1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 100 },
  });
  const later = dayPlayer('later', 'Later Lena', {
    1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 },
    2: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 950 },
  });

  const chipNames = (): Array<string | null | undefined> =>
    Array.from(
      within(screen.getByLabelText('Daily First to BINGO')).getAllByRole('listitem'),
    ).map((li) => li.querySelector('.lb-honor-name')?.textContent);

  it("leaves the Day's chip UNHELD when its derived holder is banned, and promotes nobody", () => {
    H.players = [earliest, later];
    H.event = { ...H.event, days, bannedUids: ['earliest'] } as EventDoc;
    render(<Leaderboard />, { wrapper: MemoryRouter });

    // Day 1 shows the placeholder rather than `Later Lena`, who bingoed on that
    // Day but not first. Day 2, which the ban does not touch, is unchanged.
    expect(chipNames()).toEqual(['—', '—', 'Later Lena']);
    expect(screen.queryByText('Earliest Eddy')).toBeNull();
  });

  it('baseline: with nobody banned, that same Day names its earliest bingo', () => {
    // Proves the ban is what emptied the chip above, not a broken fixture.
    H.players = [earliest, later];
    H.event = { ...H.event, days, bannedUids: [] } as EventDoc;
    render(<Leaderboard />, { wrapper: MemoryRouter });

    expect(chipNames()).toEqual(['—', 'Earliest Eddy', 'Later Lena']);
  });

  it('keeps an UNBANNED holder’s PINNED honour on a Day a banned Player also bingoed on', () => {
    // Withholding must not spread. The pin names `later`, who is not banned, so
    // Day 1 keeps its chip even though the banned Player bingoed on it earlier.
    H.players = [earliest, later];
    H.event = { ...H.event, days, bannedUids: ['earliest'] } as EventDoc;
    H.dayMetas = new Map([[1, { firstBingo: { uid: 'later', displayName: 'Later Lena', at: 900 } }]]);
    render(<Leaderboard />, { wrapper: MemoryRouter });

    expect(chipNames()).toEqual(['—', 'Later Lena', 'Later Lena']);
  });
});
