import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { contrastRatio, hexToRgb, mixSrgb, parseThemeBlocks } from '../theme/contrast';
import type { Cell, EventDoc, MostLovedPhotoAward, PlayerDoc, ProofDoc } from '../types';

// specs/w2-share-cards.md (issue #36): on-device Share Cards (BINGO +
// Leaderboard) rasterized with html-to-image and handed to the native share
// sheet, replacing the old text+URL-only navigator.share (ADR 0005 — no
// server render, no public URL). html-to-image's `toBlob` is the ONLY thing
// mocked at a module boundary (jsdom has no real canvas rasterizer); every
// other piece under test — ShareCard's DOM builders, shareCardBlob's
// fallback chain, and Celebration's/Leaderboard's own share handlers — runs
// for real, so the DOM node captured from `toBlob`'s call arguments below is
// always ShareCard's genuine output, never a stand-in.

const { toBlobMock } = vi.hoisted(() => ({ toBlobMock: vi.fn() }));
vi.mock('html-to-image', () => ({ toBlob: toBlobMock }));

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track }));

// Defensive stand-in kept for any transitive `../firebase` module-scope
// import in this suite's graph (mirrors the w2-feed-moments.test.tsx
// precedent) — nothing here calls Firestore.
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));

type AuthUser = { uid: string; displayName: string | null; photoURL: string | null } | null;

const H = vi.hoisted(() => ({
  // The auth user is a REGRESSION TRAP, not data Celebration should read:
  // its displayName is the STALE Google name a returning Player has since
  // customized away. Celebration takes the resolved name as a `playerName`
  // prop (Codex P2, PR #111 round 2 finding 1) and must never fall back to
  // this value — the stale-name test below asserts it never leaks onto a
  // card.
  user: null as AuthUser,
  event: null as EventDoc | null,
  // Leaderboard's hook.
  players: [] as PlayerDoc[],
  leaderboardLoading: false,
  // #561: FarewellPodium's award branch opens the Feed's proof hook.
  proofs: [] as unknown[],
  proofsLoading: false,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user, loading: false }) }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  // Celebration no longer calls useBoard OR useMyPlayer — it takes `cells`
  // (Codex P2, PR #111 finding 1) and `playerName` (round 2 finding 1) as
  // props instead, fed straight into every render below. Both stubs
  // permanently report NO data (never `H`-configurable) so that if a future
  // change reintroduces either listener inside Celebration, the empty-card
  // race / stale-auth-name race this fixed comes back immediately and
  // loudly in the regression tests below (the board renders zero cells; the
  // name resolves to H.user's stale Google fallback), instead of silently
  // passing because the mock happened to have real data queued.
  useBoard: () => ({ data: null, loading: true, hasServerData: false }),
  useMyPlayer: () => ({ data: null, loading: true, hasServerData: false }),
  useEventDoc: () => ({ data: H.event, loading: false }),
  useLeaderboard: () => ({ players: H.players, loading: H.leaderboardLoading }),
  // #561: the Most-Loved award's display join reads the Feed's own filtered
  // proofs; the hero tests below fixture them.
  useProofFeed: () => ({ proofs: H.proofs, loading: H.proofsLoading }),
  // #218: no Proofs fixtured in this suite — an empty map keeps every row
  // chip-less, which is orthogonal to the Share Card assertions here.
  useLatestProofByUid: () => ({ latestByUid: {}, loading: false }),
  // Mirrors src/data/moderation.ts isBanned (#108); the fixtures carry no bannedUids,
  // so it filters nothing and the share-card standings are unchanged. The ban filter
  // is pinned in src/components/w2-ban-console.test.tsx.
  isBanned: (uid: string | null | undefined, bannedUids: readonly string[] | undefined) =>
    !!uid && Array.isArray(bannedUids) && bannedUids.includes(uid),
}));

import Celebration from './Celebration';
import Leaderboard from './Leaderboard';
import { leaderboardShareCopy } from './Leaderboard';
import FarewellPodium, { FarewellPodiumView } from './FarewellPodium';
import {
  renderBingoShareCard,
  renderLeaderboardShareCard,
  renderFarewellShareCard,
  shareCardBlob,
  shareCardAppName,
  type FarewellShareCardData,
  type LeaderboardShareRow,
} from './ShareCard';
// Real module, never mocked here: the #607 entry-origin tests below install a
// resolved analytics-canonical host and prove the share `url` ignores it.
import { applyResolvedCanonicalHost } from '../canonicalHost';

// Same shape/rationale as w2-feed-moments.test.tsx's dealtWith: a dealt board
// with the free center (index 12) always on, plus whichever indices are
// explicitly marked.
function makeCells(marked: number[] = []): Cell[] {
  const on = new Set(marked);
  return Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `item-${index}`,
    text: index === 12 ? 'FREE' : `Prompt ${index}`,
    free: index === 12,
    marked: index === 12 || on.has(index),
    markedAt: index === 12 || on.has(index) ? 1 : null,
  }));
}

// Same shape as w2-leaderboard.test.tsx's mkPlayer.
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

function toBlobNode(): HTMLElement {
  return toBlobMock.mock.calls[0][0] as HTMLElement;
}

function latestToBlobNode(): HTMLElement {
  return toBlobMock.mock.calls[toBlobMock.mock.calls.length - 1][0] as HTMLElement;
}

beforeEach(() => {
  toBlobMock.mockReset();
  toBlobMock.mockResolvedValue(new Blob(['fake-png-bytes'], { type: 'image/png' }));
  track.mockReset();
  H.user = null;
  H.event = null;
  H.players = [];
  H.leaderboardLoading = false;
  H.proofs = [];
  H.proofsLoading = false;
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'share');
  Reflect.deleteProperty(window.navigator, 'canShare');
  Reflect.deleteProperty(window.navigator, 'clipboard');
  Reflect.deleteProperty(window.navigator, 'userActivation');
  // shareCardBlob's terminal fallback sheet (#712 round 3) mounts on
  // document.body OUTSIDE any React root, so RTL's cleanup cannot take it
  // down — a leaked sheet would answer the next test's role queries.
  document.querySelector('.share-fallback-backdrop')?.remove();
  // Same for the stand-in Share triggers the round-4 focus tests plant on the
  // body to play the part of the opener.
  document.querySelectorAll('[data-test-share-opener]').forEach((node) => node.remove());
  // Module state, not a mock — clear any #607 test's resolved canonical
  // host so it never leaks into an unrelated assertion.
  applyResolvedCanonicalHost(null);
});

// ---------------------------------------------------------------------------
// ShareCard — renderBingoShareCard
// ---------------------------------------------------------------------------

describe('ShareCard — renderBingoShareCard', () => {
  it('produces a non-empty blob and rasterizes at retina (3x) pixelRatio', async () => {
    const blob = await renderBingoShareCard({
      kind: 'bingo',
      playerName: 'Deck Daddy',
      eventName: 'Allure of the Seas',
      cells: makeCells(),
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(toBlobMock.mock.calls[0][1]).toMatchObject({ pixelRatio: 3 });
  });

  it('the DOM node handed to html-to-image carries the player, event, title, and all 25 cells', async () => {
    await renderBingoShareCard({
      kind: 'bingo',
      playerName: 'Deck Daddy',
      eventName: 'Allure of the Seas',
      cells: makeCells(),
    });

    const node = toBlobNode();
    expect(node.textContent).toContain('Deck Daddy');
    expect(node.textContent).toContain('Allure of the Seas');
    expect(node.textContent).toContain('BINGO!');
    expect(node.querySelectorAll('.share-card-cell')).toHaveLength(25);
    expect(node.querySelector('.share-card-cell.free')).not.toBeNull();
  });

  it('shows BLACKOUT (not BINGO!) for a blackout win, and marks a marked non-free cell distinctly', async () => {
    await renderBingoShareCard({
      kind: 'blackout',
      playerName: 'Sam',
      eventName: 'E',
      cells: makeCells([0]),
    });

    const node = toBlobNode();
    expect(node.textContent).toContain('BLACKOUT');
    expect(node.textContent).not.toContain('BINGO!');
    // Index 12 (free) is always marked, plus the explicit index 0 above.
    expect(node.querySelectorAll('.share-card-cell.marked')).toHaveLength(2);
  });

  it('mounts the card off-screen for the render and tears the host down afterward', async () => {
    let hostSeenDuringRender: Element | null = null;
    toBlobMock.mockImplementationOnce(async () => {
      hostSeenDuringRender = document.querySelector('.share-card-host');
      return new Blob(['x'], { type: 'image/png' });
    });

    await renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells: makeCells() });

    expect(hostSeenDuringRender).not.toBeNull();
    expect(document.querySelector('.share-card-host')).toBeNull();
  });

  it('rejects (and still tears the host down) when html-to-image cannot produce image data', async () => {
    toBlobMock.mockResolvedValueOnce(null);

    await expect(
      renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells: makeCells() }),
    ).rejects.toThrow();
    expect(document.querySelector('.share-card-host')).toBeNull();
  });

  // Codex P2, PR #111 finding 1 — validity gate: refuse anything but a real
  // 25-cell board (free center + 24 prompts, dealBoard's own invariant)
  // rather than ever rasterizing a partial/empty grid.
  it('refuses to render — and never touches html-to-image — when cells is not exactly 25 entries', async () => {
    await expect(
      renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells: [] }),
    ).rejects.toThrow(/25 cells/);

    expect(toBlobMock).not.toHaveBeenCalled();
    expect(document.querySelector('.share-card-host')).toBeNull();
  });

  it('refuses a partial (24-cell) board the same way as an empty one', async () => {
    await expect(
      renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells: makeCells().slice(0, 24) }),
    ).rejects.toThrow(/25 cells/);

    expect(toBlobMock).not.toHaveBeenCalled();
  });

  // Codex P2, PR #111 finding 2 — a marked-but-unconfirmed square
  // (admin_confirmed claim mode) must not render as an indistinguishable
  // solid win square: game/logic.ts's markedMask already excludes
  // status: 'pending' from counting as "on" (hasBingo/isBlackout/
  // countMarked), so the card must not visually overstate it either.
  it('renders a pending mark distinctly from a confirmed mark', async () => {
    const cells = makeCells([0, 1]).map((c) => {
      if (c.index === 0) return { ...c, status: 'confirmed' as const };
      if (c.index === 1) return { ...c, status: 'pending' as const };
      return c;
    });

    await renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells });

    const node = toBlobNode();
    const confirmedCell = node.querySelectorAll('.share-card-cell')[0];
    const pendingCell = node.querySelectorAll('.share-card-cell')[1];
    expect(confirmedCell).toHaveClass('share-card-cell', 'marked');
    expect(confirmedCell).not.toHaveClass('pending');
    expect(pendingCell).toHaveClass('share-card-cell', 'marked', 'pending');
  });

  // issue #444 (narrowing #423's all-textless rule): the turned-over squares
  // are the brag, so their prompt text renders again — free centre included —
  // while unmarked squares stay textless shape. A long unbroken token still
  // lands in full; `.share-card-cell`'s reinstated word-break/hyphens pair
  // (see the CSS fixed-frame describe below) wraps it on the tile.
  it('renders prompt text on turned-over squares only — unmarked squares stay textless', async () => {
    const longToken = `${'w'.repeat(60)}.example/very-long-unbroken-url-ish-prompt`;
    const cells = makeCells([0]);
    cells[0] = { ...cells[0], text: longToken };
    await renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells });

    const cellNodes = Array.from(toBlobNode().querySelectorAll('.share-card-cell'));
    expect(cellNodes).toHaveLength(25);
    expect(cellNodes[0].textContent).toBe(longToken); // marked → its prompt, in full
    expect(cellNodes[12].textContent).toBe('FREE'); // free centre → its own text
    for (const [i, cell] of cellNodes.entries()) {
      if (i === 0 || i === 12) continue;
      expect(cell.textContent).toBe(''); // unmarked → textless shape
    }
  });

  // Codex P2, PR #445 — the fixed tile must FIT the pool's 80-char prompt
  // ceiling (firestore.rules), not clip it out of the rasterized image:
  // turned-over cells carry deterministic length-tiered fit classes (>40
  // chars → .long, >70 → .xlong) that step the font down in CSS. jsdom
  // cannot measure rendered overflow, so the mechanism is pinned instead:
  // the class thresholds here, the font sizes in the CSS describe below.
  it('applies length-tiered fit classes to turned-over cells only', async () => {
    const cells = makeCells([0, 1, 2]);
    cells[0] = { ...cells[0], text: 'Poppers spill' }; // 13 chars → base size
    cells[1] = { ...cells[1], text: 'Feathers, mesh, or sequins before noon KAPOW' }; // 44 chars → .long
    cells[2] = { ...cells[2], text: 'x'.repeat(80) }; // the rules ceiling → .xlong
    cells[3] = { ...cells[3], text: 'y'.repeat(80) }; // UNMARKED long text → no fit class
    await renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells });

    const cellNodes = toBlobNode().querySelectorAll('.share-card-cell');
    expect(cellNodes[0]).not.toHaveClass('long');
    expect(cellNodes[0]).not.toHaveClass('xlong');
    expect(cellNodes[1]).toHaveClass('long');
    expect(cellNodes[1]).not.toHaveClass('xlong');
    expect(cellNodes[2]).toHaveClass('xlong');
    expect(cellNodes[2]).not.toHaveClass('long');
    expect(cellNodes[3]).not.toHaveClass('long');
    expect(cellNodes[3]).not.toHaveClass('xlong');
  });

  // issue #423 (resolved decision: newest line only) — only the most-recently
  // completed line is lit brighter (`.line`), derived from the cells' own
  // `markedAt`. Fixture: row 0 completed earlier (markedAt 100), row 1
  // completed later (its last mark at 300), so ONLY row 1 carries `.line`.
  it('lights only the newest completed line (by markedAt), not every completed line', async () => {
    const cells = Array.from({ length: 25 }, (_, index) => ({
      index,
      itemId: index === 12 ? null : `item-${index}`,
      text: index === 12 ? 'FREE' : `Prompt ${index}`,
      free: index === 12,
      marked: false,
      markedAt: null as number | null,
    }));
    for (const i of [0, 1, 2, 3, 4]) {
      cells[i].marked = true;
      cells[i].markedAt = 100; // row 0 — the older line
    }
    for (const i of [5, 6, 7, 8, 9]) {
      cells[i].marked = true;
      cells[i].markedAt = 200; // row 1 — the newer line
    }
    cells[9].markedAt = 300; // the mark that completed row 1 (the win)
    cells[12].marked = true;
    cells[12].markedAt = 1; // free centre

    await renderBingoShareCard({ kind: 'bingo', playerName: 'A', eventName: 'E', cells });

    const cellNodes = toBlobNode().querySelectorAll('.share-card-cell');
    expect(toBlobNode().querySelectorAll('.share-card-cell.line')).toHaveLength(5);
    for (const i of [5, 6, 7, 8, 9]) expect(cellNodes[i]).toHaveClass('line');
    for (const i of [0, 1, 2, 3, 4]) expect(cellNodes[i]).not.toHaveClass('line');
    // The free centre keeps its accent class regardless of the line glow.
    expect(cellNodes[12]).toHaveClass('free');
  });

  // issue #423 — a blackout lights every square; the single-line glow would be
  // noise on a full grid, so `.line` is skipped and the wall of gradient is the
  // flex. All 25 cells (24 + free) carry `.marked`, none carry `.line`.
  it('lights all 24 squares (plus free) for a blackout and applies no line glow', async () => {
    const allButFree = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12);
    await renderBingoShareCard({
      kind: 'blackout',
      playerName: 'A',
      eventName: 'E',
      cells: makeCells(allButFree),
    });

    const node = toBlobNode();
    // All 24 playable squares plus the free centre (25 cells) carry `.marked`;
    // the centre additionally keeps its `.free` accent styling (CodeRabbit).
    expect(node.querySelectorAll('.share-card-cell.marked')).toHaveLength(25);
    expect(node.querySelectorAll('.share-card-cell.line')).toHaveLength(0);
    const freeCell = node.querySelectorAll('.share-card-cell')[12];
    expect(freeCell).toHaveClass('share-card-cell', 'marked', 'free');
  });

  // issue #423 — the caller-composed context + stat lines render when given
  // (the context line takes the top slot in place of the bare event name), and
  // the stat line is simply absent when omitted.
  it('renders contextLine and statLine when provided, and neither when absent', async () => {
    await renderBingoShareCard({
      kind: 'bingo',
      playerName: 'A',
      eventName: 'Gay Cruise Bingo',
      cells: makeCells([0]),
      contextLine: 'Gay Cruise Bingo · Day 4 · Valletta',
      statLine: 'Bingo #2 · 16 squares · 💦 Splash T-Dance night',
    });
    let node = toBlobNode();
    expect(node.querySelector('.share-card-event')?.textContent).toBe(
      'Gay Cruise Bingo · Day 4 · Valletta',
    );
    expect(node.querySelector('.share-card-stat')?.textContent).toBe(
      'Bingo #2 · 16 squares · 💦 Splash T-Dance night',
    );

    toBlobMock.mockClear();
    await renderBingoShareCard({
      kind: 'bingo',
      playerName: 'A',
      eventName: 'Just The Event',
      cells: makeCells([0]),
    });
    node = toBlobNode();
    expect(node.querySelector('.share-card-event')?.textContent).toBe('Just The Event');
    expect(node.querySelector('.share-card-stat')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ShareCard CSS — .share-card-title uses the theme ink token, not a
// hardcoded hex (Codex P2, PR #111 finding 4). jsdom never loads
// src/index.css into the document (no external stylesheet fetch), so — same
// technique as src/theme/w1-themes.test.tsx — this reads the actual rule
// straight out of the CSS source rather than asserting on a jsdom
// `getComputedStyle` that would never reflect it.
// ---------------------------------------------------------------------------

// `join(dirname(fileURLToPath(import.meta.url)), ...)` rather than
// `new URL('../index.css', import.meta.url)` — src/theme/w1-themes.test.tsx's
// own precedent/warning: Vite statically rewrites that literal two-argument
// form into a dev-server asset URL, which isn't a file:// URL under Vitest.
const indexCssPath = join(dirname(fileURLToPath(import.meta.url)), '../index.css');
const indexCss = readFileSync(indexCssPath, 'utf8');

describe('ShareCard CSS — .share-card-title contrast', () => {
  it('fills the title with var(--ink), not a hardcoded hex', () => {
    // Hardcoded #fff was invisible against summer-white's light --bg — the
    // same failure issue #71 already fixed for the (since-removed, #39/ADR
    // 0005) OG renderer's own `.title` rule by following the theme ink
    // instead.
    const rule = indexCss.match(/\.share-card-title\s*\{([^}]*)\}/);
    expect(rule, '.share-card-title rule not found in src/index.css').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--ink\)/);
    expect(rule![1]).not.toMatch(/color:\s*#fff/);
  });
});

describe('ShareCard CSS — fixed-frame safety', () => {
  it('bounds long winner and leaderboard names inside the fixed card', () => {
    // Winner + podium names may wrap to two lines; compact-row names clamp
    // to ONE line (issue #444) — with up to eight compact rows in the fixed
    // frame, a wrapping name would blow the height budget, so it clips and
    // every row keeps a uniform height.
    const clampFor: Record<string, string> = {
      '.share-card-player': '2',
      '.share-card-col .share-card-name': '2',
      '.share-card-row .share-card-name': '1',
    };
    for (const [selector, clamp] of Object.entries(clampFor)) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = indexCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      expect(rule, `${selector} rule not found in src/index.css`).not.toBeNull();
      expect(rule![1]).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule![1]).toMatch(new RegExp(`-webkit-line-clamp:\\s*${clamp}`));
    }
  });

  // issue #444: prompt text is back on turned-over squares, so the on-page
  // `.cell`'s wrapping pair is load-bearing on the card again (the Codex P3,
  // PR #111 round 3 finding 2 parity, reinstated), and the gradient fill
  // takes the per-theme --on-gradient token — never a hardcoded hex
  // (issue #72, specs/theme-on-color-contrast.md).
  it('wraps cell prompt text hyphenate-first and fills it with the on-gradient token', () => {
    const cellRule = indexCss.match(/\.share-card-cell\s*\{([^}]*)\}/);
    expect(cellRule, '.share-card-cell rule not found in src/index.css').not.toBeNull();
    // overflow-wrap, NOT word-break: break-word (issue #449): Chrome treats
    // the latter as break-anywhere and skips hyphenation, printing raw
    // mid-word breaks on real cards.
    expect(cellRule![1]).toMatch(/overflow-wrap:\s*break-word/);
    expect(cellRule![1]).not.toMatch(/word-break\s*:/);
    expect(cellRule![1]).toMatch(/hyphens:\s*auto/);
    expect(cellRule![1]).toMatch(/overflow:\s*hidden/);

    const markedRule = indexCss.match(/\.share-card-cell\.marked\s*\{([^}]*)\}/);
    expect(markedRule, '.share-card-cell.marked rule not found in src/index.css').not.toBeNull();
    expect(markedRule![1]).toMatch(/color:\s*var\(--on-gradient\)/);
    expect(markedRule![1]).not.toMatch(/color:\s*#fff/);

    const freeRule = indexCss.match(/\.share-card-cell\.free\s*\{([^}]*)\}/);
    expect(freeRule, '.share-card-cell.free rule not found in src/index.css').not.toBeNull();
    expect(freeRule![1]).toMatch(/color:\s*var\(--ink\)/);
  });

  it('keeps the bingo frame budget: title size, grid metrics, and no dead name reserve', () => {
    const playerRule = indexCss.match(/\.share-card-player\s*\{([^}]*)\}/);
    expect(playerRule, '.share-card-player rule not found in src/index.css').not.toBeNull();
    // No two-line min-height reserve (issue #449): it left a dead band under
    // a ONE-line name; the frame's slack pools above the footer instead.
    expect(playerRule![1]).not.toMatch(/min-height\s*:/);

    const titleRule = indexCss.match(/\.share-card-bingo \.share-card-title\s*\{([^}]*)\}/);
    expect(titleRule, '.share-card-bingo .share-card-title rule not found in src/index.css').not.toBeNull();
    expect(titleRule![1]).toMatch(/font-size:\s*100px/);

    const gridRule = indexCss.match(/\.share-card-grid\s*\{([^}]*)\}/);
    expect(gridRule, '.share-card-grid rule not found in src/index.css').not.toBeNull();
    expect(gridRule![1]).toMatch(/width:\s*330px/);
    expect(gridRule![1]).toMatch(/gap:\s*10px/);
    expect(gridRule![1]).toMatch(/margin:\s*18px 0 8px/);
  });

  it('keeps the winning-line glow a per-tile halo, never a merged bar', () => {
    // Issue #449: five ADJACENT 18px glows on a column/row win merged into
    // one solid hot bar down the grid — the blur is pinned at 8px.
    const lineRule = indexCss.match(/\.share-card-cell\.line\s*\{([^}]*)\}/);
    expect(lineRule, '.share-card-cell.line rule not found in src/index.css').not.toBeNull();
    expect(lineRule![1]).toMatch(/box-shadow:\s*0 0 8px var\(--primary\)/);
  });

  it('clamps farewell honoree names and ellipsizes honor-row names inside the fixed frame', () => {
    const nameRule = indexCss.match(/\.share-card-honoree-name\s*\{([^}]*)\}/);
    expect(nameRule, '.share-card-honoree-name rule not found in src/index.css').not.toBeNull();
    expect(nameRule![1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(nameRule![1]).toMatch(/-webkit-line-clamp:\s*1/);

    const honorNameRule = indexCss.match(/\.share-card-honor-name\s*\{([^}]*)\}/);
    expect(honorNameRule, '.share-card-honor-name rule not found in src/index.css').not.toBeNull();
    expect(honorNameRule![1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(honorNameRule![1]).toMatch(/min-width:\s*0/);
  });

  it('keeps pending share-card cells visibly dashed even when also marked', () => {
    const rule = indexCss.match(/\.share-card-cell\.pending\s*\{([^}]*)\}/);
    expect(rule, '.share-card-cell.pending rule not found in src/index.css').not.toBeNull();
    expect(rule![1]).toMatch(/border-style:\s*dashed/);
    expect(rule![1]).toMatch(/border-color:\s*var\(--ink\)/);
    // Codex P2, PR #445: the fade lives in the FILL (gradient endpoints
    // mixed toward --bg), never a tile-level opacity that would composite
    // the now-present prompt text toward the card background; the text
    // stays opaque on --ink.
    expect(rule![1]).not.toMatch(/opacity\s*:/);
    expect(rule![1]).toMatch(/color:\s*var\(--ink\)/);
    expect(rule![1]).toMatch(/color-mix\(in srgb, var\(--primary\) \d+%, var\(--bg\)\)/);
  });

  // Codex P2, PR #445 round 2: get-sporty's near-white --secondary at a 45%
  // mix over its near-black --bg left --ink at ~4.29:1 — under WCAG AA's
  // 4.5:1. Rather than pin a magic weight, compute the REAL contrast of
  // --ink over both pending-wash endpoints (the same color-mix srgb math,
  // via src/theme/contrast.ts) for every theme at whatever weight the CSS
  // declares, so any future token or weight change re-proves itself.
  it('keeps pending-wash text at WCAG AA contrast in every theme', () => {
    const weightMatch = indexCss.match(
      /\.share-card-cell\.pending\s*\{[^}]*color-mix\(in srgb, var\(--primary\) (\d+)%, var\(--bg\)\)/,
    );
    expect(weightMatch, 'pending-wash color-mix weight not found').not.toBeNull();
    const weight = Number(weightMatch![1]) / 100;

    const themesCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../theme/themes.css'), 'utf8');
    const themes = parseThemeBlocks(themesCss);
    expect(Object.keys(themes).length).toBeGreaterThan(0);
    for (const [themeId, vars] of Object.entries(themes)) {
      const ink = hexToRgb(vars['ink']);
      const bg = hexToRgb(vars['bg']);
      for (const endpoint of ['primary', 'secondary'] as const) {
        const wash = mixSrgb(hexToRgb(vars[endpoint]), bg, weight);
        const ratio = contrastRatio(ink, wash);
        expect(
          ratio,
          `${themeId}: --ink over ${endpoint} pending wash is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the honored name legible on a squeezed pinned row', () => {
    // Codex P2, PR #445 round 3: the nowrap stat + nowrap ★ pin on an
    // appended First-BINGO row must never shrink the name to nothing — the
    // name keeps a 96px floor and the stat truncates with an ellipsis
    // instead.
    const nameRule = indexCss.match(/\.share-card-row \.share-card-name\s*\{([^}]*)\}/);
    expect(nameRule, '.share-card-row .share-card-name rule not found').not.toBeNull();
    expect(nameRule![1]).toMatch(/min-width:\s*96px/);

    const subRule = indexCss.match(/\.share-card-sub\s*\{([^}]*)\}/);
    expect(subRule, '.share-card-sub rule not found').not.toBeNull();
    expect(subRule![1]).toMatch(/min-width:\s*0/);
    expect(subRule![1]).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('steps the cell font down for the length-tiered fit classes', () => {
    // Codex P2, PR #445: the class thresholds live in ShareCard.tsx; the
    // sizes here are what make an 80-char prompt (the firestore.rules
    // ceiling) fit the tile instead of clipping out of the raster.
    const longRule = indexCss.match(/\.share-card-cell\.long\s*\{([^}]*)\}/);
    expect(longRule, '.share-card-cell.long rule not found in src/index.css').not.toBeNull();
    expect(longRule![1]).toMatch(/font-size:\s*7px/);

    const xlongRule = indexCss.match(/\.share-card-cell\.xlong\s*\{([^}]*)\}/);
    expect(xlongRule, '.share-card-cell.xlong rule not found in src/index.css').not.toBeNull();
    expect(xlongRule![1]).toMatch(/font-size:\s*6px/);
  });

  it('uses ink, not dim, for share-card copy over the composited tint wash', () => {
    for (const selector of ['.share-card-event', '.share-card-stat', '.share-card-footer']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = indexCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      expect(rule, `${selector} rule not found in src/index.css`).not.toBeNull();
      expect(rule![1]).toMatch(/color:\s*var\(--ink\)/);
      expect(rule![1]).not.toMatch(/color:\s*var\(--dim\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// ShareCard — renderLeaderboardShareCard
// ---------------------------------------------------------------------------

describe('ShareCard — renderLeaderboardShareCard', () => {
  // Five rows in rank order (issue #423): the renderer lays the first three out
  // as a podium and the rest as compact rows. Jess (rank 2) holds the pin; Big
  // Denver Chris (rank 5) carries a blackout, so the row's stat suffix is
  // exercised.
  const rows: LeaderboardShareRow[] = [
    { uid: 'r1', rank: 1, displayName: 'Marco', bingoCount: 6, squaresMarked: 90, blackout: false, firstToBingo: false },
    { uid: 'r2', rank: 2, displayName: 'Jess', bingoCount: 7, squaresMarked: 88, blackout: false, firstToBingo: true },
    { uid: 'r3', rank: 3, displayName: 'Dan', bingoCount: 6, squaresMarked: 80, blackout: false, firstToBingo: false },
    { uid: 'r4', rank: 4, displayName: 'Theo', bingoCount: 5, squaresMarked: 80, blackout: false, firstToBingo: false },
    { uid: 'r5', rank: 5, displayName: 'Big Denver Chris', bingoCount: 4, squaresMarked: 62, blackout: true, firstToBingo: false },
  ];

  it('splits the given rows into a top-3 podium and compact rows for the rest, with context + stat lines', async () => {
    const blob = await renderLeaderboardShareCard({
      eventName: 'Allure of the Seas',
      rows,
      contextLine: 'Gay Cruise Bingo · Day 5 · Palermo',
      statLine: 'Through Day 5 of 10',
    });

    expect(blob.size).toBeGreaterThan(0);
    const node = toBlobNode();
    expect(node.textContent).toContain('LEADERBOARD');
    expect(node.querySelectorAll('.share-card-col')).toHaveLength(3); // podium: ranks 1–3
    expect(node.querySelectorAll('.share-card-row')).toHaveLength(2); // rows: ranks 4–5
    expect(node.querySelector('.share-card-event')?.textContent).toBe('Gay Cruise Bingo · Day 5 · Palermo');
    expect(node.querySelector('.share-card-stat')?.textContent).toBe('Through Day 5 of 10');
  });

  it('preserves each row.rank as its label — podium bars 1–3, rows 4–5 — never renumbering', async () => {
    await renderLeaderboardShareCard({ eventName: 'E', rows });

    const node = toBlobNode();
    // Podium is laid out 2nd·1st·3rd, so sort before comparing the set.
    const bars = Array.from(node.querySelectorAll('.share-card-bar')).map((b) => b.textContent);
    expect(bars.slice().sort()).toEqual(['1', '2', '3']);
    const rowRanks = Array.from(node.querySelectorAll('.share-card-row .share-card-rank')).map(
      (r) => r.textContent,
    );
    expect(rowRanks).toEqual(['4', '5']);
  });

  it('pins the ★ badge on exactly the podium column flagged firstToBingo', async () => {
    await renderLeaderboardShareCard({ eventName: 'E', rows });

    const node = toBlobNode();
    const pinnedCols = node.querySelectorAll('.share-card-col.pinned');
    expect(pinnedCols).toHaveLength(1);
    expect(pinnedCols[0].textContent).toContain('Jess');
    expect(pinnedCols[0].textContent).toContain('First BINGO');
    // No compact row is pinned here — the pin holder is a top-three Player.
    expect(node.querySelectorAll('.share-card-row.pinned')).toHaveLength(0);
  });

  it('renders the blackout suffix and squares stat on a compact row', async () => {
    await renderLeaderboardShareCard({ eventName: 'E', rows });

    const chrisRow = Array.from(toBlobNode().querySelectorAll('.share-card-row')).find((r) =>
      r.textContent?.includes('Big Denver Chris'),
    );
    expect(chrisRow?.textContent).toContain('BLACKOUT');
    expect(chrisRow?.textContent).toContain('62 sq');
  });

  it('pins a compact row when the firstToBingo holder falls outside the podium', async () => {
    const pinOutside = rows.map((r, i) => ({ ...r, firstToBingo: i === 4 }));
    await renderLeaderboardShareCard({ eventName: 'E', rows: pinOutside });

    const node = toBlobNode();
    const pinnedRows = node.querySelectorAll('.share-card-row.pinned');
    expect(pinnedRows).toHaveLength(1);
    expect(pinnedRows[0].textContent).toContain('Big Denver Chris');
    expect(pinnedRows[0].textContent).toContain('First BINGO');
    expect(node.querySelectorAll('.share-card-col.pinned')).toHaveLength(0);
  });

  it('falls back to the event name (no contextLine) and omits the stat line', async () => {
    await renderLeaderboardShareCard({ eventName: 'Just The Event', rows });

    const node = toBlobNode();
    expect(node.querySelector('.share-card-event')?.textContent).toBe('Just The Event');
    expect(node.querySelector('.share-card-stat')).toBeNull();
  });

  it('renders zero podium columns and zero rows without crashing for an empty row list', async () => {
    const blob = await renderLeaderboardShareCard({ eventName: 'E', rows: [] });

    expect(blob.size).toBeGreaterThan(0);
    const node = toBlobNode();
    expect(node.querySelectorAll('.share-card-col')).toHaveLength(0);
    expect(node.querySelectorAll('.share-card-row')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ShareCard — renderFarewellShareCard (issue #449)
// ---------------------------------------------------------------------------

describe('ShareCard — renderFarewellShareCard', () => {
  const data = {
    eventName: 'Allure of the Seas',
    champion: { displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124 },
    firstBingo: { displayName: 'Turntilla' },
    honors: [
      { dayLabel: 'Day 1 · Trieste 🇮🇹', displayName: 'Andrew Levad' },
      { dayLabel: 'Day 2 · Split 🇭🇷', displayName: 'Logan Murdock' },
      { dayLabel: 'Day 3 · Sea Day 🌊', displayName: 'Ido Marcus' },
    ],
  };

  it('lays out honoree blocks, honor rows, and the context/stat lines', async () => {
    const blob = await renderFarewellShareCard({
      ...data,
      contextLine: 'Gay Cruise Bingo · Day 10 · Barcelona',
      statLine: 'Final standings · 10 days',
    });

    expect(blob.size).toBeGreaterThan(0);
    const node = toBlobNode();
    expect(node.textContent).toContain('FINAL STANDINGS');
    const honorees = node.querySelectorAll('.share-card-honoree');
    expect(honorees).toHaveLength(2); // champion + first-to-bingo
    expect(honorees[0].textContent).toContain('Cruise champion');
    expect(honorees[0].textContent).toContain('Zacaria Arab');
    expect(honorees[0].textContent).toContain('16 bingos · 124 squares');
    expect(honorees[1].textContent).toContain('First to BINGO');
    expect(honorees[1].textContent).toContain('Turntilla');
    const rows = node.querySelectorAll('.share-card-honor-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Day 1 · Trieste');
    expect(rows[0].textContent).toContain('Andrew Levad');
    expect(node.querySelector('.share-card-event')?.textContent).toBe(
      'Gay Cruise Bingo · Day 10 · Barcelona',
    );
    expect(node.querySelector('.share-card-stat')?.textContent).toBe('Final standings · 10 days');
  });

  it('isolates every emoji run in its own inline-block .emoji-run span (#603)', async () => {
    await renderFarewellShareCard({
      ...data,
      contextLine: 'Gay Cruise Bingo · Day 10 · Barcelona',
    });
    const node = toBlobNode();

    // Honor-day label: the port emoji is atomized (html-to-image's raster
    // pass mis-shapes an emoji inside a shared text run — the "Day 4
    // 🌊alletta" defect), while the visible text stays byte-identical.
    const day = node.querySelectorAll('.share-card-honor-day')[1];
    const atoms = day.querySelectorAll('span.emoji-run');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].textContent).toBe('🇭🇷');
    expect(day.textContent).toBe('Day 2 · Split 🇭🇷');

    // The champion role line (🏆 …) and the footer's Edition share mark run
    // through the same seam — every card text does, via el().
    expect(node.querySelector('.share-card-honoree-role span.emoji-run')?.textContent).toBe('🏆');
    expect(node.querySelector('.share-card-footer span.emoji-run')).not.toBeNull();

    // A no-emoji text renders as a bare text node — no wrapper spam.
    expect(node.querySelector('.share-card-event span.emoji-run')).toBeNull();
    expect(node.querySelector('.share-card-event')?.textContent).toBe(
      'Gay Cruise Bingo · Day 10 · Barcelona',
    );
  });

  it('renders a singular bingo stat without the plural s', async () => {
    await renderFarewellShareCard({
      ...data,
      champion: { displayName: 'Solo', bingoCount: 1, squaresMarked: 9 },
    });
    expect(toBlobNode().querySelector('.share-card-honoree-stat')?.textContent).toBe(
      '1 bingo · 9 squares',
    );
  });

  it('omits missing podium parts: no champion block, no first block, no honors section', async () => {
    await renderFarewellShareCard({
      eventName: 'Just The Event',
      champion: null,
      firstBingo: null,
      honors: [],
    });

    const node = toBlobNode();
    expect(node.querySelectorAll('.share-card-honoree')).toHaveLength(0);
    expect(node.querySelectorAll('.share-card-honor-row')).toHaveLength(0);
    expect(node.querySelector('.share-card-honors-title')).toBeNull();
    expect(node.querySelector('.share-card-event')?.textContent).toBe('Just The Event'); // eventName fallback
    expect(node.querySelector('.share-card-stat')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ShareCard — renderFarewellShareCard photo-hero composition (#534/#561)
// ---------------------------------------------------------------------------

describe('ShareCard — renderFarewellShareCard photo-hero composition (#534/#561)', () => {
  const heroData: FarewellShareCardData = {
    eventName: 'Allure of the Seas',
    contextLine: 'Gay Cruise Bingo · Day 10 · Barcelona',
    statLine: 'Final standings · 10 days',
    champion: { displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124 },
    firstBingo: { displayName: 'Turntilla' },
    honors: [{ dayLabel: 'Day 1 · Trieste 🇮🇹', displayName: 'Andrew Levad' }],
    runnersUp: [
      { displayName: 'Logan Murdock', bingoCount: 14, squaresMarked: 117 },
      { displayName: 'Nathan Payne', bingoCount: 13, squaresMarked: 110 },
    ],
    mostLoved: {
      photoUrl: 'blob:mock-hero',
      heartCount: 31,
      creditLine: 'Ido Marcus · “Mirror-hall selfie” · Day 7 · Rome 🇮🇹 · shared with Jess',
    },
  };

  function stubImageDecode(impl: () => Promise<void>): void {
    // jsdom's HTMLImageElement has no decode() — define one so the renderer's
    // feature-guarded await path runs; afterEach removes it.
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      value: impl,
      configurable: true,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  });

  it('renders the hero box (badge + FROZEN heart chip + letterboxed img), credit line, and compressed rows — daily honors omitted', async () => {
    stubImageDecode(() => Promise.resolve());
    await renderFarewellShareCard(heroData);

    const node = toBlobNode();
    expect(node.querySelector('.share-card-event')?.textContent).toBe(
      'Gay Cruise Bingo · Day 10 · Barcelona',
    );
    expect(node.textContent).toContain('FINAL STANDINGS');

    // Hero box: the sanitized blob object URL, the award badge, the frozen count.
    const hero = node.querySelector('.share-card-ml-hero')!;
    expect(hero).toBeTruthy();
    expect(hero.querySelector<HTMLImageElement>('.share-card-ml-img')?.src).toBe('blob:mock-hero');
    expect(hero.querySelector('.share-card-ml-badge')?.textContent).toBe('📷 Most-loved photo');
    expect(hero.querySelector('.share-card-ml-hearts')?.textContent).toBe('❤ 31');

    // Credit line, tie suffix included.
    expect(node.querySelector('.share-card-ml-by')?.textContent).toBe(
      'Ido Marcus · “Mirror-hall selfie” · Day 7 · Rome 🇮🇹 · shared with Jess',
    );

    // Compressed standings: champion row (Bebas name treatment class + role
    // chip + bingos-only stat), ranks 2-3 plain rows, then 👑 First to BINGO
    // with NO stat (the recorded timestamp deviation).
    const rows = node.querySelectorAll('.share-card-ml-row');
    expect(rows).toHaveLength(4);
    expect(rows[0].className).toContain('champ');
    expect(rows[0].querySelector('.share-card-ml-rank')?.textContent).toBe('1');
    expect(rows[0].querySelector('.share-card-ml-name')?.textContent).toBe('Zacaria Arab');
    expect(rows[0].querySelector('.share-card-ml-role')?.textContent).toBe('🏆 Cruise champion');
    expect(rows[0].querySelector('.share-card-ml-stat')?.textContent).toBe('16 bingos');
    expect(rows[1].querySelector('.share-card-ml-rank')?.textContent).toBe('2');
    expect(rows[1].querySelector('.share-card-ml-stat')?.textContent).toBe('14 bingos · 117 sq');
    expect(rows[2].querySelector('.share-card-ml-rank')?.textContent).toBe('3');
    expect(rows[2].querySelector('.share-card-ml-stat')?.textContent).toBe('13 bingos · 110 sq');
    expect(rows[3].querySelector('.share-card-ml-rank')?.textContent).toBe('👑');
    expect(rows[3].querySelector('.share-card-ml-name')?.textContent).toBe('Turntilla');
    expect(rows[3].querySelector('.share-card-ml-role')?.textContent).toBe('First to BINGO');
    expect(rows[3].querySelector('.share-card-ml-stat')).toBeNull();

    // The one block that yields its space to the photo: NO daily honors, and
    // none of the photo-less honoree blocks either.
    expect(node.querySelector('.share-card-honors-title')).toBeNull();
    expect(node.querySelectorAll('.share-card-honor-row')).toHaveLength(0);
    expect(node.querySelectorAll('.share-card-honoree')).toHaveLength(0);

    // Stat line + Edition footer as today.
    expect(node.querySelector('.share-card-stat')?.textContent).toBe('Final standings · 10 days');
    expect(node.querySelector('.share-card-footer')?.textContent).toContain(shareCardAppName());
  });

  it('isolates emoji runs on the hero surfaces — credit line flag, badge camera (#603)', async () => {
    stubImageDecode(() => Promise.resolve());
    await renderFarewellShareCard(heroData);
    const node = toBlobNode();
    const by = node.querySelector('.share-card-ml-by')!;
    const atoms = by.querySelectorAll('span.emoji-run');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].textContent).toBe('🇮🇹');
    expect(node.querySelector('.share-card-ml-badge span.emoji-run')?.textContent).toBe('📷');
  });

  it('mostLoved absent and mostLoved: null render the SAME photo-less node — byte-identical to the pre-#534 card', async () => {
    // The pre-#534 call shape: no mostLoved key, no runnersUp key at all.
    const legacy: FarewellShareCardData = {
      eventName: heroData.eventName,
      contextLine: heroData.contextLine,
      statLine: heroData.statLine,
      champion: heroData.champion,
      firstBingo: heroData.firstBingo,
      honors: heroData.honors,
    };
    await renderFarewellShareCard(legacy);
    await renderFarewellShareCard({ ...legacy, mostLoved: null, runnersUp: heroData.runnersUp });
    expect(toBlobMock).toHaveBeenCalledTimes(2);
    const absent = toBlobMock.mock.calls[0][0] as HTMLElement;
    const nulled = toBlobMock.mock.calls[1][0] as HTMLElement;
    // The photo-less composition ignores runnersUp entirely; both renders are
    // the exact honoree-blocks card, markup-identical.
    expect(nulled.outerHTML).toBe(absent.outerHTML);
    expect(absent.querySelector('.share-card-ml-hero')).toBeNull();
    expect(absent.querySelectorAll('.share-card-honoree')).toHaveLength(2);
    expect(absent.querySelectorAll('.share-card-honor-row')).toHaveLength(1);
  });

  it('a decode failure falls back to the photo-less composition — never a broken hero', async () => {
    stubImageDecode(() => Promise.reject(new Error('EncodingError')));
    const blob = await renderFarewellShareCard(heroData);
    expect(blob.size).toBeGreaterThan(0);
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    const node = toBlobNode();
    expect(node.querySelector('.share-card-ml-hero')).toBeNull();
    // The full photo-less card, daily honors included.
    expect(node.querySelectorAll('.share-card-honoree')).toHaveLength(2);
    expect(node.querySelectorAll('.share-card-honor-row')).toHaveLength(1);
  });

  it('a stalled decode() falls back to the photo-less composition after the bound — never hangs the share action (#661)', async () => {
    vi.useFakeTimers();
    try {
      // A decode() that never settles — the exact stall #661 describes.
      stubImageDecode(() => new Promise<void>(() => {}));
      const pending = renderFarewellShareCard(heroData);
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(7999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const blob = await pending;
      expect(blob.size).toBeGreaterThan(0);
      expect(toBlobMock).toHaveBeenCalledTimes(1);
      const node = toBlobNode();
      expect(node.querySelector('.share-card-ml-hero')).toBeNull();
      expect(node.querySelectorAll('.share-card-honoree')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a photoUrl the safeMediaUrl sink guard rejects renders photo-less (PR #95 barrier holds)', async () => {
    stubImageDecode(() => Promise.resolve());
    await renderFarewellShareCard({
      ...heroData,
      mostLoved: { ...heroData.mostLoved!, photoUrl: 'javascript:alert(1)' },
    });
    const node = toBlobNode();
    expect(node.querySelector('.share-card-ml-hero')).toBeNull();
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelectorAll('.share-card-honoree')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ShareCard — shareCardBlob (native share sheet + fallback chain)
// ---------------------------------------------------------------------------

describe('shareCardBlob — native share sheet + fallback chain', () => {
  const blob = new Blob(['fake-image-bytes'], { type: 'image/png' });

  function stubNavigator(overrides: {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
    clipboard?: { writeText: (text: string) => Promise<void> };
  }) {
    if (overrides.canShare) {
      Object.defineProperty(window.navigator, 'canShare', { value: overrides.canShare, configurable: true });
    }
    if (overrides.share) {
      Object.defineProperty(window.navigator, 'share', { value: overrides.share, configurable: true });
    }
    if (overrides.clipboard) {
      Object.defineProperty(window.navigator, 'clipboard', { value: overrides.clipboard, configurable: true });
    }
  }

  it('shares the image via navigator.share({ files }) when canShare reports true', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);
    stubNavigator({ canShare: canShareMock, share: shareMock });

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('files');
    expect(canShareMock).toHaveBeenCalledWith({ files: [expect.any(File)] });
    expect(shareMock).toHaveBeenCalledTimes(1);
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg).toMatchObject({ title: 'T', text: 'body' });
    expect(shareArg.files).toHaveLength(1);
    expect(shareArg.files[0]).toBeInstanceOf(File);
    expect(shareArg.files[0].name).toBe('card.png');
  });

  it('stops at "cancelled" when the native file share throws — no further fallback', async () => {
    const shareMock = vi.fn().mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    const clipboardMock = vi.fn();
    stubNavigator({ canShare: () => true, share: shareMock, clipboard: { writeText: clipboardMock } });

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('cancelled');
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  it('falls back to a text/URL share when file sharing is unsupported', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share: shareMock }); // no canShare at all

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('text');
    expect(shareMock).toHaveBeenCalledWith({ title: 'T', text: 'body', url: 'https://x.test' });
  });

  // Codex P2, PR #111 finding 3: the text/URL leg (reached when file
  // sharing is unsupported) used to catch EVERY rejection — including a
  // genuine AbortError cancellation — and unconditionally fall through to
  // the clipboard/download legs, silently clobbering the clipboard right
  // after the Player dismissed the share sheet. It now stops on a
  // cancellation, same as the file leg above.
  it('stops the chain (no clipboard write) when the text/URL share is cancelled (AbortError)', async () => {
    const shareMock = vi.fn().mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    const clipboardMock = vi.fn();
    stubNavigator({ share: shareMock, clipboard: { writeText: clipboardMock } }); // no canShare -> text leg

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('cancelled');
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  // Codex P2, PR #111 round 2 finding 2 — the NotAllowedError decision,
  // pinned: STOP the chain, same as AbortError. NotAllowedError is
  // ambiguous (user dismissal on some platforms; an expired user-activation
  // window on others), but the eager pre-render removed the main
  // activation-expiry cause, so it is treated as a dismissal — a rare
  // do-nothing tap beats a clipboard write right after the Player declined.
  it('stops the chain (no clipboard write) when the text/URL share rejects NotAllowedError', async () => {
    const shareMock = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    const clipboardMock = vi.fn();
    stubNavigator({ share: shareMock, clipboard: { writeText: clipboardMock } }); // no canShare -> text leg

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('cancelled');
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  it('falls through to the clipboard when the text/URL share fails for a reason other than cancellation', async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error('some genuine failure'));
    const clipboardMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share: shareMock, clipboard: { writeText: clipboardMock } });

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('clipboard');
    expect(clipboardMock).toHaveBeenCalledWith('https://x.test');
  });

  it('falls back to the clipboard when there is no Web Share API at all', async () => {
    const clipboardMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ clipboard: { writeText: clipboardMock } });

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('clipboard');
    expect(clipboardMock).toHaveBeenCalledWith('https://x.test');
  });

  it('falls back to a direct download as the last resort', async () => {
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    // No `url` — proves the download leg does not depend on the clipboard leg
    // having been skippable only because a URL happened to be present.
    const outcome = await shareCardBlob({ blob, filename: 'card.png', title: 'T', text: 'body' });

    expect(outcome).toBe('download');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('returns "none" when there is no image, no Share API, and no Clipboard API', async () => {
    const outcome = await shareCardBlob({ blob: null, filename: 'card.png', title: 'T', text: 'body' });
    expect(outcome).toBe('none');
  });

  // Codex P1, PR #712 round 2. Both `navigator.share` legs need transient
  // user activation. When a slow tap-time render has already burned it, the
  // file leg's any-rejection-is-a-dismissal rule turned the tap into a
  // fallback-less 'cancelled' — no sheet, no clipboard, no download, i.e. a
  // delayed no-op. `navigator.userActivation` makes that case a FACT rather
  // than an ambiguous rejection, so the chain skips both share legs.
  function stubUserActivation(isActive: boolean) {
    Object.defineProperty(window.navigator, 'userActivation', {
      value: { isActive, hasBeenActive: true },
      configurable: true,
    });
  }

  it('skips both share legs and reaches the clipboard when transient activation is already gone', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const clipboardMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ canShare: () => true, share: shareMock, clipboard: { writeText: clipboardMock } });
    stubUserActivation(false);

    try {
      const outcome = await shareCardBlob({
        blob,
        filename: 'card.png',
        title: 'T',
        text: 'body',
        url: 'https://x.test',
      });

      expect(outcome).toBe('clipboard');
      expect(shareMock).not.toHaveBeenCalled();
      expect(clipboardMock).toHaveBeenCalledWith('https://x.test');
    } finally {
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  // Codex P1, PR #712 round 6 — the round-5 code called `downloadBlob` here
  // and returned 'download' because `.click()` had not thrown. It reports
  // nothing at all: WebKit ignores a synthetic download click once the
  // transient activation is spent, WITHOUT throwing, so that outcome was a
  // success invented out of the absence of an exception — the same tap-did-
  // nothing bug the previous four rounds each pushed one level down. The leg
  // now withholds the click it cannot verify and routes the image to the
  // sheet, where a PRESS is a fresh gesture the browser will honour.
  it('withholds the unverifiable click when activation is gone, and routes the image to the sheet instead of claiming a download', async () => {
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const shareMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ canShare: () => true, share: shareMock });
    stubUserActivation(false);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      const outcome = await shareCardBlob({ blob, filename: 'card.png', title: 'T', text: 'body' });

      // NOT 'download' — nothing was delivered, and nothing pretends it was.
      expect(outcome).toBe('prompt');
      expect(shareMock).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();

      // What the Player gets instead: the card on screen (press-and-hold works
      // with no API at all) plus a Save button.
      expect(fallbackSheet().querySelector('img.share-fallback-preview')).not.toBeNull();

      // And the press DOES download — the fresh gesture is the whole point of
      // routing here rather than clicking blind.
      stubUserActivation(true);
      const save = sheetButton('Save image');
      fireEvent.click(save);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(save.textContent).toBe('Saved');
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  // Codex P1, PR #712 round 6 — the STALE-FACT half of the same finding.
  // Round 2 read `navigator.userActivation` once at the top of the chain, but
  // `navigator.share` CONSUMES the activation: a share that ran, burned it and
  // then failed for a non-cancellation reason left every later leg reading a
  // value that was true when taken and false by the time it was used. The
  // blind download leg then clicked into a spent activation and reported
  // 'download'. Each gate now re-reads immediately before it runs.
  it('re-reads the activation before the blind download leg — a share that consumed it cannot license a claimed download', async () => {
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    // A live activation that the share call spends, exactly as the platform
    // does — the reason a value read before the call cannot be trusted after.
    const activation = { isActive: true, hasBeenActive: true };
    Object.defineProperty(window.navigator, 'userActivation', {
      value: activation,
      configurable: true,
    });
    const shareMock = vi.fn().mockImplementation(() => {
      activation.isActive = false;
      return Promise.reject(new Error('some genuine failure'));
    });
    stubNavigator({ share: shareMock }); // no canShare -> text leg; no clipboard
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      const outcome = await shareCardBlob({ blob, filename: 'card.png', title: 'T', text: 'body' });

      // The share leg ran (activation was alive for it) and genuinely failed,
      // so the chain kept going — but it kept going into a spent activation.
      expect(shareMock).toHaveBeenCalledTimes(1);
      expect(clickSpy).not.toHaveBeenCalled();
      expect(outcome).toBe('prompt');
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  it('still downloads on the last resort when the activation is alive — the evidence rule costs the normal path nothing', async () => {
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    stubUserActivation(true);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      const outcome = await shareCardBlob({ blob, filename: 'card.png', title: 'T', text: 'body' });

      expect(outcome).toBe('download');
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  it('still takes the file leg when activation is alive — the guard costs the normal path nothing', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const clipboardMock = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ canShare: () => true, share: shareMock, clipboard: { writeText: clipboardMock } });
    stubUserActivation(true);

    try {
      const outcome = await shareCardBlob({
        blob,
        filename: 'card.png',
        title: 'T',
        text: 'body',
        url: 'https://x.test',
      });

      expect(outcome).toBe('files');
      expect(shareMock).toHaveBeenCalledTimes(1);
      expect(clipboardMock).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  // Codex P1, PR #712 round 3 — THE acceptance property: a tap never ends in
  // a silent no-op. Round 2 skipped the share legs for the clipboard, but
  // Safari and Firefox gate `clipboard.writeText` on transient activation
  // too, so in the case that started all of this — a stalled cold render
  // handing over `blob: null` with the activation already spent — every
  // remaining leg declined in silence and the chain returned 'none'. The
  // terminal leg needs no activation at all: it puts the link on screen with
  // a button whose PRESS mints the activation the silent write lacked.
  function fallbackSheet(): HTMLElement {
    const sheet = document.querySelector<HTMLElement>('.share-fallback-backdrop');
    if (!sheet) throw new Error('no share fallback sheet mounted');
    return sheet;
  }

  function sheetButton(label: string): HTMLButtonElement {
    const match = [...fallbackSheet().querySelectorAll('button')].find(
      (b) => b.textContent === label,
    );
    if (!match) throw new Error(`no "${label}" button in the share fallback sheet`);
    return match;
  }

  it('shows a visible, activation-free affordance instead of a silent no-op when activation is gone, the clipboard is gated, and there is no image', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    // The gated write: rejected exactly as Safari/Firefox reject a clipboard
    // write with no transient activation — the same expiry that skipped the
    // share legs, which is why round 2's clipboard fallback was no fallback.
    const clipboardMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
      .mockResolvedValue(undefined);
    stubNavigator({ canShare: () => true, share: shareMock, clipboard: { writeText: clipboardMock } });
    stubUserActivation(false);

    const outcome = await shareCardBlob({
      blob: null, // the stalled cold render's payload
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('prompt');
    expect(shareMock).not.toHaveBeenCalled();
    // Visible, labelled, and carrying the link even before anything is pressed.
    const sheet = fallbackSheet();
    expect(sheet.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Finish sharing',
    );
    expect(sheet.querySelector<HTMLInputElement>('.share-fallback-url')?.value).toBe(
      'https://x.test',
    );

    // And actionable: the press is a fresh gesture, so the write that failed
    // silently a moment ago now lands.
    const copy = sheetButton('Copy link');
    fireEvent.click(copy);
    await waitFor(() => expect(clipboardMock).toHaveBeenCalledTimes(2));
    expect(clipboardMock).toHaveBeenLastCalledWith('https://x.test');
    await waitFor(() => expect(copy.textContent).toBe('Link copied'));
  });

  // Codex P2, PR #712 round 6 — this sheet is the LAST line of defence, and
  // its two actions are the same two APIs that already declined on the way
  // here, so a press can genuinely fail again. Round 5 caught both failures
  // and changed nothing the Player could see in the no-URL case: a press that
  // visibly does nothing, which is the original bug one level down.
  it('says so when the fallback sheet cannot save the image, and names what is still possible', async () => {
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    stubUserActivation(false); // no share, no clipboard, no blind download
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download blocked');
    });

    try {
      // NO url — the case the finding calls out, where there is no link to
      // fall back on when the save fails.
      expect(await shareCardBlob({ blob, filename: 'card.png', title: 'T', text: 'body' })).toBe(
        'prompt',
      );
      const status = fallbackSheet().querySelector('.share-fallback-status');
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.textContent).toBe(''); // silent until there is something to say

      stubUserActivation(true); // a press is a fresh gesture
      const save = sheetButton('Save image');
      fireEvent.click(save);

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(status?.textContent).toContain('Your browser blocked the download.');
      // Actionable, not just an apology: the card is on screen, and saving it
      // by hand needs no API at all.
      expect(status?.textContent).toContain('Press and hold the card above');
      expect(fallbackSheet().querySelector('img.share-fallback-preview')).not.toBeNull();
      // And it never claimed the save it did not make, so the button still
      // reads as pressable and the sheet stays up.
      expect(save.textContent).toBe('Save image');
      expect(document.querySelector('.share-fallback-backdrop')).not.toBeNull();
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(window.navigator, 'userActivation');
    }
  });

  it('says so when the fallback sheet cannot copy the link either, and leaves the button pressable', async () => {
    // openFallbackFrom's clipboard rejects every write, so the press repeats
    // the exact failure that routed the Player here.
    const opener = await openFallbackFrom('Share');
    const copy = sheetButton('Copy link');
    fireEvent.click(copy);

    await waitFor(() =>
      expect(fallbackSheet().querySelector('.share-fallback-status')?.textContent).toContain(
        'Your browser blocked the copy.',
      ),
    );
    // Pointed at the field that needs no API, and still pressable.
    expect(fallbackSheet().querySelector('.share-fallback-status')?.textContent).toContain(
      'Select the link above',
    );
    expect(copy.textContent).toBe('Copy link');
    opener.remove();
  });

  // Codex P1, PR #712 round 6, the same rule applied to the terminal leg:
  // `'prompt'` is a claim that something is on screen for the Player to press,
  // so it is read back from the DOM rather than assumed from an append that
  // returned. A mount that did not take reports 'none' honestly — and leaves
  // no key handler behind swallowing Tab for a sheet that never appeared.
  it('reports "none", not "prompt", when the sheet cannot actually be put on screen', async () => {
    stubUserActivation(false);
    const append = vi
      .spyOn(document.body, 'appendChild')
      .mockImplementation((node) => node as never);

    try {
      const outcome = await shareCardBlob({
        blob: null,
        filename: 'card.png',
        title: 'T',
        text: 'body',
        url: 'https://x.test',
      });

      expect(outcome).toBe('none');
    } finally {
      append.mockRestore();
    }

    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    // `fireEvent` returns false exactly when a listener called preventDefault.
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
  });

  it('the fallback sheet keeps the link on screen with no Clipboard API at all, and Close dismisses it', async () => {
    stubUserActivation(false); // no share, no clipboard, no blob — nothing gated left

    const outcome = await shareCardBlob({
      blob: null,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('prompt');
    // No Copy button to offer, but the URL is still there to select by hand.
    expect(fallbackSheet().querySelector<HTMLInputElement>('.share-fallback-url')?.value).toBe(
      'https://x.test',
    );
    fireEvent.click(sheetButton('Close'));
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
  });

  // Codex P2, PR #712 round 5 — the no-Clipboard case above is exactly the one
  // where the link field is the Player's ONLY route to the URL, and the sheet
  // is `aria-modal`, so whatever the Tab trap cannot reach does not exist for
  // a keyboard-only Player. A `<p>` is not a tab stop: the trap cycled through
  // Close alone and the note told them to copy a link they could not select.
  it('hands a keyboard-only Player the link when there is no Copy button to press', async () => {
    const opener = plantOpener('Share');
    stubUserActivation(false); // no share, no clipboard, no blob

    expect(
      await shareCardBlob({
        blob: null,
        filename: 'card.png',
        title: 'T',
        text: 'body',
        url: 'https://x.test',
      }),
    ).toBe('prompt');

    const field = fallbackSheet().querySelector<HTMLInputElement>('.share-fallback-url');
    if (!field) throw new Error('no link field in the share fallback sheet');
    // Read-only, not disabled: a disabled control is unfocusable AND filtered
    // out of the trap, which would put the link back out of reach.
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
    expect(field.getAttribute('aria-label')).toBe('Share link');

    // It is the landing spot, with the URL already selected — Cmd+C is the
    // whole manual copy, no hunting required.
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('https://x.test'.length);

    // And it is a genuine stop in the trap's cycle, reachable from Close in
    // both directions rather than skipped over.
    const close = sheetButton('Close');
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // Codex P2, PR #712 round 4 — the sheet declares `aria-modal="true"`, which
  // is a promise that nothing outside it is reachable and that focus comes
  // back where it started. These pin both halves of that contract.
  function plantOpener(label: string): HTMLButtonElement {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = label;
    opener.setAttribute('data-test-share-opener', '');
    document.body.appendChild(opener);
    opener.focus();
    return opener;
  }

  /** Mounts the terminal sheet from a focused stand-in Share trigger, with a
   *  Clipboard API that is PRESENT but activation-gated — so the chain still
   *  falls all the way through, and the sheet offers Copy as well as Close
   *  (two stops for the trap to cycle between). */
  async function openFallbackFrom(label: string): Promise<HTMLButtonElement> {
    const opener = plantOpener(label);
    stubNavigator({
      clipboard: {
        writeText: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      },
    });
    stubUserActivation(false);
    const outcome = await shareCardBlob({
      blob: null,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });
    expect(outcome).toBe('prompt');
    return opener;
  }

  it('contains Tab and Shift+Tab inside the fallback sheet — a keyboard Player cannot walk into the app it covers', async () => {
    const opener = await openFallbackFrom('Share');
    const copy = sheetButton('Copy link');
    const close = sheetButton('Close');
    // The link field is the first stop in DOM order; the primary action is
    // still the landing spot.
    const field = fallbackSheet().querySelector<HTMLInputElement>('.share-fallback-url');
    if (!field) throw new Error('no link field in the share fallback sheet');
    expect(document.activeElement).toBe(copy);

    // Forward from the LAST stop wraps to the first rather than leaving.
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(field);

    // Backward from the FIRST stop wraps to the last, same rule.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    // And focus that has somehow landed OUTSIDE (here: back on the covered
    // trigger) is pulled back in, not wrapped from a stop that isn't ours.
    opener.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(field);
  });

  it('restores focus to the Share trigger on every close path', async () => {
    // Close button.
    let opener = await openFallbackFrom('Share A');
    fireEvent.click(sheetButton('Close'));
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();

    // Escape.
    opener = await openFallbackFrom('Share B');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();

    // Backdrop click.
    opener = await openFallbackFrom('Share C');
    fireEvent.click(fallbackSheet());
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('supersedes an earlier sheet through the same close path — no orphaned key handler pointing at the old opener', async () => {
    const first = await openFallbackFrom('Share first');
    const second = await openFallbackFrom('Share second');

    // One sheet, not two stacked.
    expect(document.querySelectorAll('.share-fallback-backdrop')).toHaveLength(1);

    // Closing the live sheet returns focus to ITS opener, not the stale one.
    fireEvent.click(sheetButton('Close'));
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(first);

    // And the superseded sheet took its key handler with it. A handler left
    // bound to a detached sheet keeps answering every keystroke in the app
    // afterwards — its trap sees focus "outside" its own dead node, swallows
    // the Tab and aims focus at a button nobody can see. With no sheet on
    // screen, Tab must reach the app uncancelled: `fireEvent` returns false
    // exactly when a listener called `preventDefault`.
    first.focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('leaves focus alone when something else has taken it before the sheet closes', async () => {
    const opener = await openFallbackFrom('Share');
    const elsewhere = plantOpener('Somewhere else');
    elsewhere.focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(opener);
  });

  it('does not put a fallback sheet in front of a Player who simply dismissed the share sheet', async () => {
    const shareMock = vi.fn().mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    stubNavigator({ canShare: () => true, share: shareMock });
    stubUserActivation(true);

    const outcome = await shareCardBlob({
      blob,
      filename: 'card.png',
      title: 'T',
      text: 'body',
      url: 'https://x.test',
    });

    expect(outcome).toBe('cancelled');
    expect(document.querySelector('.share-fallback-backdrop')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Celebration — image share + fallback
// ---------------------------------------------------------------------------

describe('Celebration — image share + fallback', () => {
  // Board.tsx's own `cells` and resolved `playerName` at the moment it
  // opens the modal (Codex P2, PR #111 finding 1 + round 2 finding 1) —
  // passed straight in as props below, exactly like Board.tsx now does,
  // rather than resolved through Celebration-local listeners.
  const cells = makeCells([0, 1, 2]);

  // The Share button under the round-3 ready gate (Codex P2, PR #111 round
  // 3 finding 1): it stays disabled until the mount-time pre-render
  // SETTLES, so every tap below first waits for it to enable — mirroring
  // exactly what a real Player can do. A settled-null render (failure /
  // validity-gate refusal) also enables it: "settled", not "blob exists".
  async function readyShareButton(): Promise<HTMLElement> {
    const btn = screen.getByRole('button', { name: 'Share' });
    await waitFor(() => expect(btn).toBeEnabled());
    return btn;
  }

  beforeEach(() => {
    // The STALE auth fallback a returning Player has customized away — a
    // poisoned value the card must never show (round 2 finding 1).
    H.user = { uid: 'u1', displayName: 'Google Name', photoURL: null };
    H.event = { name: 'Allure of the Seas' } as EventDoc;
  });

  it('renders the real BINGO card and shares it via navigator.share({ files }) when canShare reports true', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files).toHaveLength(1);

    // The node handed to html-to-image is ShareCard's REAL output (this
    // suite never mocks ./ShareCard), carrying the `playerName`/`cells`
    // props Board.tsx hands down plus the mocked event hook's name.
    const node = toBlobNode();
    expect(node.textContent).toContain('Deck Daddy');
    expect(node.textContent).toContain('Allure of the Seas');
    expect(node.querySelectorAll('.share-card-cell')).toHaveLength(25);

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'celebration' }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  // Codex P2, PR #111 finding 1 (regression): Celebration used to open its
  // OWN useBoard(uid) listener, which — per the permanently-empty stub in
  // the ../hooks/useData mock above — never resolves any data. Had that code
  // path survived this fix, `board?.cells ?? []` would be `[]` here and the
  // card would share a ZERO-cell grid on the earliest tap the UI allows (the
  // round-3 ready gate waits only for the mount pre-render to settle — never
  // for any board load; the useBoard stub here never loads anything). It
  // shares the FULL grid because `cells` comes from the prop, available
  // synchronously from the very first render — no listener left to race.
  it('renders the full 25-cell grid on an immediate Share tap, even though useBoard reports no data', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobNode().querySelectorAll('.share-card-cell')).toHaveLength(25);
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
  });

  // Codex P2, PR #111 round 2 finding 1 (regression — the identity twin of
  // the cells race above): Celebration used to run its own useMyPlayer(uid)
  // listener + resolveDisplayName(player, user?.displayName), which starts
  // `data: null` on mount — an immediate Share tap resolved the STALE auth
  // name ('Google Name' here) for a returning Player whose saved custom
  // name is 'Deck Daddy'. The ../hooks/useData mock above stubs useMyPlayer
  // permanently empty and H.user carries the poisoned auth fallback, so if
  // that listener path ever comes back, this card renders 'Google Name'
  // and both assertions below fail. With the name threaded down as Board's
  // resolved prop, the saved name is on the card synchronously from the
  // very first render.
  it('renders the SAVED name from the playerName prop on an immediate tap — never the auth fallback — with useMyPlayer stubbed empty', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const node = toBlobNode();
    expect(node.querySelector('.share-card-player')?.textContent).toBe('Deck Daddy');
    expect(node.textContent).not.toContain('Google Name');
  });

  // Codex P2, PR #111 round 2 finding 1: the reachable identity-unknown
  // window (an offline reload whose cache holds the board but not the
  // player row — Board passes playerName={null} there) disables the Share
  // affordance instead of ever stamping the stale auth fallback onto a
  // card, mirroring how Board's doMark withholds the name from Tally
  // markers and the Moment broadcasts HOLD in that same window.
  it('disables Share (and pre-renders nothing) while the identity is not yet known', () => {
    const shareMock = vi.fn();
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });

    render(<Celebration kind="bingo" cells={cells} playerName={null} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(toBlobMock).not.toHaveBeenCalled();
    expect(shareMock).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  // Codex P2, PR #111 round 2 finding 2: rasterization starts at MOUNT (the
  // card data is fixed by then), so the tap's await picks up an
  // already-settled promise and navigator.share runs within the browser's
  // transient user-activation window — a tap-time render could outlive it
  // and reject NotAllowedError, making the tap do nothing.
  it('pre-renders the card at mount and the tap reuses it — exactly one rasterization', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    // Eager: the render was already underway BEFORE any tap.
    expect(toBlobMock).toHaveBeenCalledTimes(1);

    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(1); // reused the mount-time render — no second rasterize
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
  });

  // Codex P2, PR #111 round 3 finding 1 — the slow-rasterize shape under
  // the ready gate: on a slow phone the mount render can still be UNSETTLED
  // when the Player goes to tap; round 2 had the tap await it, which burned
  // the activation window all the same. Now the Share button stays DISABLED
  // until the cached promise settles — a premature tap does nothing at all
  // (no share, no analytics) — and the settle enables the button, so the
  // tap that lands can only ever await an already-settled promise and
  // navigator.share runs within ITS OWN activation window.
  it('keeps Share disabled while the mount render is unsettled, then enables on settle — a tap only ever shares a ready blob', async () => {
    let resolveRaster!: (b: Blob | null) => void;
    toBlobMock.mockReset();
    toBlobMock.mockImplementation(
      () => new Promise<Blob | null>((res) => (resolveRaster = res)),
    );
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    expect(toBlobMock).toHaveBeenCalledTimes(1); // pre-render started at mount

    const btn = screen.getByRole('button', { name: 'Share' });
    expect(btn).toBeDisabled(); // unsettled render → the tap cannot land yet
    await user.click(btn); // a premature tap is inert
    expect(shareMock).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();

    resolveRaster(new Blob(['late-png'], { type: 'image/png' }));
    await waitFor(() => expect(btn).toBeEnabled()); // the settle opens the gate

    await user.click(btn);
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(1); // the tap reused the settled mount render
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
    expect(track).toHaveBeenCalledTimes(1); // only the REAL tap counted
  });

  // Codex P2, PR #111 finding 1: the renderer's validity gate is the
  // backstop for any other way an incomplete board could reach Celebration
  // — it refuses at the mount-time pre-render too, so not even the eager
  // path can rasterize an empty grid.
  it('falls back to a text/URL share — never attempts an image share — when handed an invalid (non-25-cell) board', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    // canShare would greenlight a FILE share if a blob existed — proves the
    // fallback below happens because no blob was ever produced, not because
    // canShare said no.
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={[]} playerName="Deck Daddy" onClose={vi.fn()} />);
    // The gate-refused pre-render still SETTLES (to null), so the ready
    // gate enables Share and the text/URL fallback stays reachable.
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).not.toHaveBeenCalled(); // no rasterization ever attempted
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files).toBeUndefined(); // text/URL leg, not the files leg
    expect(shareArg.url).toBe(window.location.origin);

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'celebration' }));
  });

  it('falls back to a text/URL share when file sharing is unsupported, and still fires share_click', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true }); // no canShare
    const user = userEvent.setup();

    render(<Celebration kind="blackout" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files).toBeUndefined();
    expect(shareArg.url).toBe(window.location.origin);
    expect(shareArg.text).toMatch(/BLACKOUT/i);

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'celebration' }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  // #607 (amended multi-domain policy #599): the shared link carries the
  // ENTRY-POINT origin even when an analytics-canonical host is resolved for
  // this Event. Every serving host stays live and branded, so a link
  // rewritten to the canonical host would unfurl and land recipients under
  // another Edition's brand. Before #607 this url came from canonicalOrigin()
  // and this exact setup shared https://bodega-bay.vacaybingo.com.
  it('shares the entry-point origin, never the resolved analytics-canonical host (#607)', async () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.url).toBe(window.location.origin);
    expect(shareArg.url).not.toBe('https://bodega-bay.vacaybingo.com');
  });

  it('fires share_click exactly once, and still falls back to a text/URL share, when the on-device render itself fails', async () => {
    // The mount-time pre-render consumes this rejection (the cached promise
    // resolves null); the tap then degrades to the text/URL leg.
    toBlobMock.mockRejectedValueOnce(new Error('rasterize failed'));
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    // A FAILED render still settles the cached promise (to null), so the
    // ready gate enables Share — a broken rasterizer must never dead-end
    // the affordance; the text/URL fallback stays reachable.
    await user.click(await readyShareButton());

    await waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith('share_click', { surface: 'celebration' });
    expect(shareMock).toHaveBeenCalledWith(expect.objectContaining({ url: window.location.origin }));
  });

  it('falls back to the app name on the card when the Event has not loaded yet', async () => {
    H.event = null;
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: vi.fn().mockResolvedValue(undefined), configurable: true });
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={vi.fn()} />);
    await user.click(await readyShareButton());

    await waitFor(() => expect(toBlobMock).toHaveBeenCalledTimes(1));
    // Assert on the `.share-card-event` node specifically, not just
    // `textContent` at large — the card's footer always renders
    // `${shareCardAppName()} 🚢` regardless of `eventName`, so a whole-node
    // substring check would pass even if the eventName fallback were broken.
    expect(toBlobNode().querySelector('.share-card-event')?.textContent).toBe(shareCardAppName());
  });

  it('"Keep playing" closes without sharing — the eager pre-render never leaves the device', async () => {
    const shareMock = vi.fn();
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<Celebration kind="bingo" cells={cells} playerName="Deck Daddy" onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Keep playing' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // The card IS pre-rendered at mount (round 2 finding 2 — deliberate),
    // but closing without tapping Share must neither share nor count a
    // share_click: the blob stays on-device and unobserved (ADR 0005).
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(shareMock).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Leaderboard — share affordance
// ---------------------------------------------------------------------------

describe('Leaderboard — share affordance', () => {
  const topDog = mkPlayer({
    uid: 'top-dog',
    displayName: 'Top Dog',
    bingoCount: 5,
    squaresMarked: 20,
    firstBingoAt: 9000,
  });
  const earlyBird = mkPlayer({
    uid: 'early-bird',
    displayName: 'Early Bird',
    bingoCount: 4,
    squaresMarked: 18,
    firstBingoAt: 1000,
  });

  beforeEach(() => {
    H.players = [topDog, earlyBird];
    H.event = { name: 'Allure of the Seas' } as EventDoc;
  });

  it('renders a "Share leaderboard" button', () => {
    render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(screen.getByRole('button', { name: 'Share leaderboard' })).toBeInTheDocument();
  });

  it('clicking Share renders the real Leaderboard card and fires share_click', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const node = toBlobNode();
    expect(node.textContent).toContain('Allure of the Seas');
    expect(node.textContent).toContain('Top Dog');
    expect(node.textContent).toContain('Early Bird');
    // Two Players → both land in the podium (issue #423). Early Bird has the
    // earliest firstBingoAt (1000 < 9000) — the same Player the on-screen "1st
    // BINGO" badge pins — so the pinned podium column is Early Bird's.
    const pinned = node.querySelectorAll('.share-card-col.pinned');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].textContent).toContain('Early Bird');

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'leaderboard' }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  // Codex P2, PR #111 round 2 finding 2 — the Leaderboard's warm-on-intent
  // pre-render (deliberately NOT mount-eager: this component re-renders on
  // every roster snapshot, so rasterizing per snapshot would burn CPU for a
  // card that is rarely shared). Hover/focus/press on the Share button
  // starts the render; the tap's await then reuses the warmed promise —
  // exactly one rasterization — so navigator.share runs within the
  // activation window instead of waiting out a tap-time render.
  it('warms the card render on hover so the tap reuses it — exactly one rasterization', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    expect(toBlobMock).not.toHaveBeenCalled(); // no mount-eager render here (deliberate)

    await user.hover(screen.getByRole('button', { name: 'Share leaderboard' }));
    expect(toBlobMock).toHaveBeenCalledTimes(1); // warm-up started on intent

    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(1); // the tap reused the warmed render
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
  });

  it('invalidates a warmed bare app-name card once the schedule copy loads', async () => {
    H.event = null;
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    const { rerender } = render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.hover(screen.getByRole('button', { name: 'Share leaderboard' }));
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(toBlobNode().querySelector('.share-card-event')?.textContent).toBe(shareCardAppName());

    H.event = {
      name: shareCardAppName(),
      days: [
        {
          index: 0,
          date: '2026-07-15',
          place: 'Palermo',
          placeEmoji: '🇮🇹',
          theme: 'glamiators',
          tonight: [],
          pool: 'main',
          tutorial: false,
          unlockAt: Date.now() - 1000,
        },
      ],
    } as unknown as EventDoc;
    rerender(<Leaderboard />);

    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(2);
    expect(latestToBlobNode().querySelector('.share-card-event')?.textContent).toBe(
      `${shareCardAppName()} · Day 1 · Palermo`,
    );
  });

  it('keys leaderboard Share Card copy on the derived event schedule lines', () => {
    const first = leaderboardShareCopy({
      name: shareCardAppName(),
      days: [
        {
          index: 0,
          date: '2026-07-15',
          place: 'Palermo',
          placeEmoji: '🇮🇹',
          theme: 'glamiators',
          tonight: [],
          pool: 'main',
          tutorial: false,
          unlockAt: 1000,
        },
      ],
    }, 2000);
    const changed = leaderboardShareCopy({
      name: shareCardAppName(),
      days: [
        {
          index: 0,
          date: '2026-07-15',
          place: 'Valletta',
          placeEmoji: '🇲🇹',
          theme: 'glamiators',
          tonight: [],
          pool: 'main',
          tutorial: false,
          unlockAt: 1000,
        },
      ],
    }, 2000);

    expect(first.contextLine).toBe(`${shareCardAppName()} · Day 1 · Palermo`);
    expect(changed.contextLine).toBe(`${shareCardAppName()} · Day 1 · Valletta`);
    expect(changed.cacheKey).not.toBe(first.cacheKey);
  });

  it('includes the First to BINGO Player on the card even when their rank falls outside the top 10', async () => {
    // 12 Players, already in rank order (bingos desc): topDog, 10 "Mid"
    // Players tied at 4 bingos, then Late Bloomer — who has the fewest
    // bingos (rank #12, outside the card's top-10 slice, MAX_SHARE_ROWS =
    // 10, issue #444) but the EARLIEST firstBingoAt of anyone, so they
    // still hold the pin.
    const mids = Array.from({ length: 10 }, (_, i) =>
      mkPlayer({ uid: `mid-${i}`, displayName: `Mid ${i}`, bingoCount: 4, squaresMarked: 10, firstBingoAt: 5000 + i }),
    );
    const lateBloomer = mkPlayer({
      uid: 'late-bloomer',
      displayName: 'Late Bloomer',
      bingoCount: 1,
      squaresMarked: 2,
      firstBingoAt: 100,
    });
    H.players = [topDog, ...mids, lateBloomer];
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const node = toBlobNode();
    // Top 10 by rank + Late Bloomer appended (rank 12, outside the top 10) →
    // the renderer lays the first three as a podium and the remaining eight
    // (ranks 4–10 and the appended pin) as compact rows — the card's
    // worst-case row count.
    expect(node.querySelectorAll('.share-card-col')).toHaveLength(3);
    expect(node.querySelectorAll('.share-card-row')).toHaveLength(8);
    const pinned = node.querySelectorAll('.share-card-row.pinned');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].textContent).toContain('Late Bloomer');
  });

  it('shares the FULL standings even while a filter narrows the on-screen list', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('button', { name: 'Blackout' })); // neither fixture Player has one
    expect(screen.getByText(/no one matches this filter/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    // Both Players appear on the shared card even though the ON-SCREEN
    // filter is currently showing neither — two Players → the podium (issue
    // #423).
    expect(toBlobNode().querySelectorAll('.share-card-col')).toHaveLength(2);
  });

  it('falls back to a text/URL share when file sharing is unsupported, and still fires share_click', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true }); // no canShare
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalled());
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files).toBeUndefined();
    expect(shareArg.url).toBe(window.location.origin);

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'leaderboard' }));
  });

  // #607: entry-point origin, never the analytics-canonical host — same
  // rationale as the Celebration test of the same name. No `canShare`, so
  // the chain takes the text/URL leg: the files leg deliberately omits
  // `url`, and this test is about which origin the shared LINK carries.
  it('shares the entry-point origin, never the resolved analytics-canonical host (#607)', async () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<Leaderboard />, { wrapper: MemoryRouter });
    await user.click(screen.getByRole('button', { name: 'Share leaderboard' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.url).toBe(window.location.origin);
    expect(shareArg.url).not.toBe('https://bodega-bay.vacaybingo.com');
  });
});

// ---------------------------------------------------------------------------
// FarewellPodium — share affordance (issue #449)
// ---------------------------------------------------------------------------

describe('FarewellPodium — share affordance', () => {
  // A minimal frozen roster: the wrapper runs the REAL buildPodium
  // (data/finale.ts) over it — champion = top aggregates, First to BINGO =
  // earliest firstBingoAt — so the card is proven against the same payload
  // the on-page banner renders, not a hand-shaped stand-in.
  const champ = mkPlayer({
    uid: 'champ',
    displayName: 'Zacaria Arab',
    bingoCount: 16,
    squaresMarked: 124,
    firstBingoAt: 9000,
  });
  const early = mkPlayer({
    uid: 'early',
    displayName: 'Turntilla',
    bingoCount: 5,
    squaresMarked: 60,
    firstBingoAt: 1000,
  });

  // The event reaches the card as BOARD'S OWN PROP, never a second
  // useEventDoc listener (Codex P2, PR #450 — the #111 props-not-listeners
  // lineage). H.event stays null in this describe as the regression trap:
  // if a future change reintroduces the hook inside FarewellPodium, the
  // card renders the bare app name and the event-name assertions below
  // fail loudly.
  const eventProp = { name: 'Allure of the Seas' } as EventDoc;

  it('renders the Share button at the bottom of the podium and shares the real card', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    const podium = screen.getByRole('region', { name: 'Cruise podium' });
    const btn = screen.getByRole('button', { name: 'Share final standings' });
    // Bottom of the podium section: the button is the section's LAST element child.
    expect(podium.lastElementChild).toContainElement(btn);

    await user.click(btn);

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
    const node = toBlobNode();
    expect(node.textContent).toContain('FINAL STANDINGS');
    // From the PROP, with the useEventDoc mock pinned null — the trap above.
    expect(node.querySelector('.share-card-event')?.textContent).toBe('Allure of the Seas');
    expect(node.textContent).toContain('Zacaria Arab'); // champion by aggregates
    expect(node.textContent).toContain('16 bingos · 124 squares');
    expect(node.textContent).toContain('Turntilla'); // earliest firstBingoAt holds the crown

    await waitFor(() => expect(track).toHaveBeenCalledWith('share_click', { surface: 'farewell' }));
    expect(track).toHaveBeenCalledTimes(1);
  });

  // #607: entry-point origin, never the analytics-canonical host — same
  // rationale as the Celebration test of the same name. No `canShare`, so
  // the chain takes the text/URL leg: the files leg deliberately omits
  // `url`, and this test is about which origin the shared LINK carries.
  it('shares the entry-point origin, never the resolved analytics-canonical host (#607)', async () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.url).toBe(window.location.origin);
    expect(shareArg.url).not.toBe('https://bodega-bay.vacaybingo.com');
  });

  // #712 round 3 replaced warm-on-intent-only with ONE eager render as soon
  // as sharing is ready (the Celebration treatment — the payload is frozen).
  // The tap no longer waits on the render at all, so the render has to be
  // under way BEFORE the tap or the common cold mobile tap would lose the
  // image; hover and tap then both reuse it — still exactly one rasterization.
  it('renders the card eagerly once sharing is ready; hover and the tap both reuse it — exactly one rasterization', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await waitFor(() => expect(toBlobMock).toHaveBeenCalledTimes(1)); // eager, not tap-time

    await user.hover(screen.getByRole('button', { name: 'Share final standings' }));
    expect(toBlobMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(1); // the tap reused the eager render
    // And the eager render is what lets the no-wait tap still carry the image.
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1);
  });

  // Codex P2, PR #450: buildPodium withholds derived daily honors while the
  // day-meta listeners are still answering — sharing then would bake a
  // permanently incomplete honors list into the image. The podium renders;
  // only the share affordance waits for dayMetasLoaded.
  it('withholds the Share button until the day-meta honors settle', () => {
    render(
      <FarewellPodium players={[champ, early]} days={undefined} event={eventProp} dayMetasLoaded={false} />,
    );
    expect(screen.getByRole('region', { name: 'Cruise podium' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share final standings' })).toBeNull();
  });

  it('renders no share button on the wrapper-less presentational view', () => {
    render(
      <FarewellPodiumView
        podium={{
          champion: { uid: 'c', displayName: 'C', bingoCount: 2, squaresMarked: 20 },
          firstBingo: null,
          dailyHonors: [],
          runnersUp: [],
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Share final standings' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FarewellPodium — photo-hero share (#534/#561)
// ---------------------------------------------------------------------------

describe('FarewellPodium — photo-hero share (#534/#561)', () => {
  const champ = mkPlayer({
    uid: 'champ',
    displayName: 'Zacaria Arab',
    bingoCount: 16,
    squaresMarked: 124,
    firstBingoAt: 9000,
  });
  const early = mkPlayer({
    uid: 'early',
    displayName: 'Turntilla',
    bingoCount: 5,
    squaresMarked: 60,
    firstBingoAt: 1000,
  });

  const AWARD: MostLovedPhotoAward = {
    winners: [
      { proofId: 'w1', uid: 'ana', displayName: 'Ana', promptText: 'Sunset over the bay', dayIndex: 1, proofCreatedAt: 1000 },
      { proofId: 'w2', uid: 'bea', displayName: 'Bea', promptText: 'Fog bank rolling in', dayIndex: 2, proofCreatedAt: 2000 },
    ],
    heartCount: 9,
    frozenAt: 9_000,
    computedAt: 9_050,
  };

  function liveProof(id: string, uid: string, createdAt: number): ProofDoc {
    return {
      id,
      uid,
      displayName: `Poster ${id}`,
      photoURL: null,
      type: 'photo',
      cellIndex: 3,
      itemText: `Prompt ${id}`,
      mediaURL: `https://firebasestorage.googleapis.com/v0/b/x/o/proofs%2F${id}?alt=media`,
      createdAt,
      reportCount: 0,
      status: 'active',
      dayIndex: 1,
    };
  }

  const eventProp = { name: 'Allure of the Seas', mostLovedPhoto: AWARD } as EventDoc;

  const fetchMock = vi.fn();
  const createObjectURL = vi.fn();
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    H.proofs = [liveProof('w1', 'ana', 1000), liveProof('w2', 'bea', 2000)];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    createObjectURL.mockReset();
    createObjectURL.mockReturnValue('blob:hero-1');
    revokeObjectURL.mockReset();
    // jsdom ships neither object-URL API; define both so the hero pipeline
    // (fetch → blob → object URL → revoke after rasterization) runs for real.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      value: () => Promise.resolve(),
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  });

  it('shares the photo-hero card: fetched blob object URL as the hero, revoked after rasterization; slug and title do not fork', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    // One media fetch, of the WINNER's own mediaURL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('proofs%2Fw1');

    const node = latestToBlobNode();
    const img = node.querySelector<HTMLImageElement>('.share-card-ml-img')!;
    expect(img.src).toBe('blob:hero-1');
    expect(node.querySelector('.share-card-ml-hearts')?.textContent).toBe('❤ 9');
    // Hero = earliest-posted winner; the credit names the recorded co-winner.
    expect(node.querySelector('.share-card-ml-by')?.textContent).toBe(
      'Ana · “Sunset over the bay” · Day 2 · shared with Bea',
    );
    // The object URL has no reader once the PNG settles.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hero-1');

    // One surface: the slug and share title DO NOT fork on the hero composition.
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files[0].name).toBe('gay-cruise-bingo-final-standings.png');
    expect(shareArg.title).toBe('Gay Cruise Bingo—Final standings');
  });

  it('warm on hover + tap share ONE media fetch and ONE rasterization', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.hover(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(toBlobMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed media fetch falls back to the photo-less composition — the documented fallback, never a broken hero', async () => {
    fetchMock.mockResolvedValue({ ok: false, blob: async () => new Blob() });
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    const node = latestToBlobNode();
    expect(node.querySelector('.share-card-ml-hero')).toBeNull();
    expect(node.querySelectorAll('.share-card-honoree').length).toBeGreaterThan(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('a throwing createObjectURL falls back to the photo-less composition, not a dropped card (#660)', async () => {
    // Minting the object URL is the one media step that sat OUTSIDE the render
    // try/catch, so a throw escaped to the warmed promise's `.catch(() => null)`
    // and resolved the whole card to null — no rasterization, no PNG for the
    // share sheet. That is strictly worse than the failed-fetch case directly
    // above, which has always degraded correctly. Both now land on the same
    // photo-less card.
    createObjectURL.mockImplementation(() => {
      throw new Error('object URL unavailable');
    });
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    // The card still rasterized (the pre-fix bug skipped this entirely).
    const node = latestToBlobNode();
    expect(node.querySelector('.share-card-ml-hero')).toBeNull();
    expect(node.querySelectorAll('.share-card-honoree').length).toBeGreaterThan(0);
    // A real PNG reached the share sheet rather than the text/URL-only leg.
    expect(shareMock.mock.calls[0][0].files?.length).toBe(1);
    // Nothing to revoke when the URL was never minted.
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('with the first winner hidden, the hero is the earliest STILL-VISIBLE winner and the credit still names the recorded co-winner', async () => {
    H.proofs = [liveProof('w2', 'bea', 2000)];
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    expect(String(fetchMock.mock.calls[0][0])).toContain('proofs%2Fw2');
    expect(latestToBlobNode().querySelector('.share-card-ml-by')?.textContent).toBe(
      'Bea · “Fog bank rolling in” · Day 3 · shared with Ana',
    );
  });

  it('the explicit no-award record shares the photo-less card without waiting on proofs', async () => {
    H.proofs = [];
    H.proofsLoading = true; // winners: [] waits for nothing
    const noAward: MostLovedPhotoAward = {
      winners: [],
      heartCount: 0,
      frozenAt: 9000,
      computedAt: 9050,
    };
    const noAwardEvent = { name: 'Allure of the Seas', mostLovedPhoto: noAward } as EventDoc;
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={noAwardEvent} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(latestToBlobNode().querySelector('.share-card-ml-hero')).toBeNull();
  });

  it('a tie bigger than the persisted 100-winner prefix reports the true count, not the truncated array (#659)', async () => {
    // The persisted `winners` prefix still only has the same two co-winners
    // the fixture always ships, but `winnerCount` records a 101-way tie that
    // overflowed the bounded prefix — the exact shape a real truncated
    // record has (src/domainTypes.d.ts `winners`/`winnerCount`).
    const truncatedAward: MostLovedPhotoAward = { ...AWARD, winnerCount: 101 };
    const truncatedEvent = { name: 'Allure of the Seas', mostLovedPhoto: truncatedAward } as EventDoc;
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    const user = userEvent.setup();

    render(<FarewellPodium players={[champ, early]} days={undefined} event={truncatedEvent} />);
    await user.click(screen.getByRole('button', { name: 'Share final standings' }));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));

    // 101 true co-winners minus the hero = 100 others, not the 1 the
    // truncated two-entry `winners` array would otherwise imply.
    expect(latestToBlobNode().querySelector('.share-card-ml-by')?.textContent).toBe(
      'Ana · “Sunset over the bay” · Day 2 · shared with 100 others',
    );
  });

  // Codex P1, PR #712 — three rounds on one bug, and this is the property
  // that finally closes it. Round 1 bounded the decode (the hang stopped, the
  // no-op didn't). Round 2 bounded the TAP at four seconds and routed a spent
  // activation to the clipboard — but a four-second wait can still outlive
  // the activation, and the clipboard is activation-gated on Safari/Firefox,
  // so the tap dead-ended all the same. Round 3 removes the wait itself: the
  // tap takes the render only if it has ALREADY settled, so navigator.share
  // is invoked in the same turn as the gesture — no timers involved at all.
  it('a tap on a stalled hero render shares in the same turn as the gesture — no wait to outlive the activation (#712)', async () => {
    // A fetch that never settles: the warmed card promise cannot resolve.
    fetchMock.mockReturnValue(new Promise(() => {}));
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share final standings' }));

    // No await, no timer advance: the share call has ALREADY happened by the
    // time the click handler returns, which is the whole guarantee.
    expect(shareMock).toHaveBeenCalledTimes(1);
    // No image (the render never produced one) — but a real share sheet
    // carrying the title/text/URL, which is the documented degrade.
    const shareArg = shareMock.mock.calls[0][0];
    expect(shareArg.files).toBeUndefined();
    expect(shareArg.title).toBe('Gay Cruise Bingo—Final standings');
    expect(shareArg.url).toBeTruthy();
    // The image was never rasterized, so nothing stale reached the sheet.
    expect(toBlobMock).not.toHaveBeenCalled();
  });

  // The end-to-end acceptance property (Codex P1, PR #712 round 3): even in
  // the worst combination — stalled cold render, activation ALREADY spent
  // before the handler runs, and a Safari/Firefox-style gated clipboard —
  // the tap leaves the Player with something visible to act on.
  it('a stalled cold render with the activation already spent still leaves the Player something to act on (#712)', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const clipboardMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(window.navigator, 'share', { value: shareMock, configurable: true });
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: clipboardMock },
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'userActivation', {
      value: { isActive: false, hasBeenActive: true },
      configurable: true,
    });

    render(<FarewellPodium players={[champ, early]} days={undefined} event={eventProp} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share final standings' }));

    await waitFor(() =>
      expect(document.querySelector('.share-fallback-backdrop')).not.toBeNull(),
    );
    // Nothing activation-gated ran, and nothing was silently swallowed: the
    // link is on screen, with the shared origin the share sheet would carry.
    expect(shareMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('.share-fallback-url')?.value).toBe(
      window.location.origin,
    );
  });
});
