import { toBlob } from 'html-to-image';
import { completedLines } from '../game/logic';
import { editionBrand, editionLexicon } from '../editions';
import { segmentEmojiRuns } from '../format';
import { safeMediaUrl } from './safeMediaUrl';
import type { Cell } from '../types';

/**
 * On-device Share Card renderer (ADR 0005, issue #36). Given a BINGO/Blackout
 * win or a Leaderboard snapshot, builds a real (off-screen) DOM node styled
 * with the app's own CSS classes — so it automatically inherits whichever
 * [data-theme] palette is currently applied to <html> (theme/ThemeContext.tsx)
 * — then rasterizes it with html-to-image into a retina PNG blob ready for
 * `navigator.share({ files })`. Everything happens on the Player's own
 * device: no server render, no public URL (ADR 0005). `shareCardBlob` below
 * hands that blob to the native share sheet, or degrades through a fallback
 * chain when the platform can't take image files.
 *
 * The card DOM is built with plain `document.createElement` calls rather
 * than a React render pass: html-to-image needs one real, already-laid-out
 * element to walk and inline computed styles from, and building it directly
 * avoids standing up a second React root (and its act()/lifecycle baggage)
 * just to produce one throwaway node. This mirrors the rest of the app's
 * image work — `data/storage.ts`'s `downscaleImage` also reaches for raw
 * canvas/DOM APIs rather than React for a one-shot image transform.
 */

// "Retina" per the ticket's 2-3x pixelRatio ask — the resulting PNG is a
// static image dropped into a chat thread, so the extra crispness is worth
// the larger file when a Player pinches to zoom on someone else's card.
const PIXEL_RATIO = 3;
const CARD_WIDTH = 600;
const CARD_HEIGHT = 750;
/**
 * The app's name as it appears ON a share card — the footer, the Web Share
 * title, and the fallback when an Event has no name of its own.
 *
 * A FUNCTION, resolved through the Edition (Phase 4b P2 on #615). It was a
 * `const 'Gay Cruise Bingo'`, and #608's scope table assigned it to #607 — but
 * that left every Vacay and Five Across card carrying another product's name
 * beside the Edition-correct filename, mark, brag text and champion label this
 * ticket had just given it, which is a guest-visible branding leak rather than
 * a scoping nicety. #607 keeps the other half of its scope: which ORIGIN the
 * shared URL points at.
 *
 * Read at call time, never captured at module scope: the resolved Edition is
 * installed before React mounts but after this module is imported.
 */
export function shareCardAppName(): string {
  return editionBrand().appName;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) appendEmojiIsolatedText(node, text);
  return node;
}

/**
 * Append `text` with every emoji run isolated in its own inline-block span
 * (#603). html-to-image's SVG `<foreignObject>` raster pass can shape an
 * emoji differently from the live document (observed in desktop Chrome: the
 * champion role line and the footer wrapped in the raster and painted over
 * their neighbours — the shipped defect was the farewell card's honors rows
 * rendering "Day 4 🌊alletta"). An `.emoji-run` box (src/index.css) gets its
 * computed width inlined into the raster clone, so however the raster pass
 * shapes the glyph it stays inside a box of the live advance width and the
 * surrounding text keeps its layout. Applied to EVERY text the card renders —
 * labels, names, stat lines, the footer — because emoji can arrive in any of
 * them (Day-Theme emoji in labels, emoji in display names). The on-page
 * mirror of this treatment for captured surfaces is components/EmojiText.tsx.
 */
function appendEmojiIsolatedText(node: HTMLElement, text: string): void {
  for (const run of segmentEmojiRuns(text)) {
    if (run.emoji) {
      const atom = document.createElement('span');
      atom.className = 'emoji-run';
      atom.textContent = run.text;
      node.append(atom);
    } else {
      node.append(document.createTextNode(run.text));
    }
  }
}

/** Mounts `node` off-screen (real layout, so html-to-image can measure it — never `display:none`, which would size it to 0x0) and returns its teardown. */
function mountOffscreen(node: HTMLElement): () => void {
  const host = el('div', 'share-card-host');
  host.appendChild(node);
  document.body.appendChild(host);
  return () => host.remove();
}

/**
 * Post-mount shrink-to-fit for cell prompt text (Codex P2, PR #445 round 3).
 * The length-tiered classes (see buildBingoCardNode) are the deterministic
 * base, but character counts are glyph-blind — a permitted 80-char prompt of
 * unusually wide glyphs can still overflow the tile, and overflow: hidden
 * would clip it out of the raster. The card is mounted with REAL layout
 * before html-to-image walks it (mountOffscreen's whole point), so measure
 * the truth instead of guessing: any overflowing cell steps its font down
 * until the text fits, floored at 4px. No-ops in jsdom (scroll metrics are
 * 0 there) and on the Leaderboard card (no .share-card-cell nodes).
 */
function fitCellText(card: HTMLElement): void {
  for (const cell of card.querySelectorAll<HTMLElement>('.share-card-cell')) {
    if (!cell.textContent) continue;
    let size = parseFloat(getComputedStyle(cell).fontSize);
    while (cell.scrollHeight > cell.clientHeight && size > 4) {
      // Clamped, not bare subtraction (CodeRabbit, PR #445): a fractional
      // computed size (4.25px) must step onto the 4px floor, never past it.
      size = Math.max(4, size - 0.5);
      cell.style.fontSize = `${size}px`;
    }
  }
}

async function rasterize(node: HTMLElement): Promise<Blob> {
  const unmount = mountOffscreen(node);
  try {
    fitCellText(node);
    const blob = await toBlob(node, { pixelRatio: PIXEL_RATIO });
    if (!blob) throw new Error('Share Card render produced no image data.');
    return blob;
  } finally {
    unmount();
  }
}

// ---------------------------------------------------------------------------
// BINGO / Blackout card
// ---------------------------------------------------------------------------

export interface BingoShareCardData {
  kind: 'bingo' | 'blackout';
  playerName: string;
  eventName: string;
  /** The Player's own 25-cell board (index order, free center included). */
  cells: Cell[];
  /**
   * Optional top line (day + port), composed by the caller — e.g. "Gay Cruise
   * Bingo · Day 4 · Valletta". Renders in place of the bare `eventName` when
   * present; absent, the card falls back to `eventName` (which itself falls
   * back to the app name). The renderer stays dumb — it never derives the day.
   */
  contextLine?: string;
  /**
   * Optional single stat/brag line, composed by the caller — e.g. "Bingo #2 ·
   * 16 squares · 💦 Splash T-Dance night" or "All 24 squares · <night>".
   * Absent → nothing renders.
   */
  statLine?: string;
}

/**
 * The cells of the NEWEST completed BINGO line — the one lit brighter than any
 * other marked square (issue #423, resolved: newest line only, not every
 * completed line). Derived purely from the board's own `markedAt` timestamps,
 * so no pre-mark board or extra caller data is needed: a line's "completion
 * time" is the latest `markedAt` among its five cells, and the newest line(s)
 * are those tied for the greatest such time — so a double-BINGO landed by a
 * single mark lights both, while an older line dims once a newer one lands.
 * `completedLines` already excludes `status: 'pending'` cells (game/logic.ts's
 * markedMask), so an unconfirmed square can never pull a line into the glow.
 */
function newestLineCells(cells: Cell[]): Set<number> {
  const completed = completedLines(cells);
  if (completed.length === 0) return new Set();
  const lineTime = (line: number[]): number =>
    Math.max(...line.map((i) => cells[i]?.markedAt ?? 0));
  const newest = Math.max(...completed.map(lineTime));
  const lit = new Set<number>();
  for (const line of completed) {
    if (lineTime(line) === newest) for (const i of line) lit.add(i);
  }
  return lit;
}

function buildBingoCardNode(data: BingoShareCardData): HTMLDivElement {
  const card = el('div', 'share-card share-card-bingo');
  card.style.width = `${CARD_WIDTH}px`;
  card.style.height = `${CARD_HEIGHT}px`;
  card.append(el('div', 'share-card-event', data.contextLine ?? data.eventName));
  card.append(el('div', 'share-card-title', data.kind === 'blackout' ? 'BLACKOUT' : 'BINGO!'));
  card.append(el('div', 'share-card-player', data.playerName));
  const grid = el('div', 'share-card-grid');
  // The winning-line glow marks only the NEWEST completed line (see
  // newestLineCells). Blackout lights the whole grid, so a single-line
  // emphasis would be noise there — skip it and let the wall of gradient be
  // the flex.
  const lineCells = data.kind === 'blackout' ? new Set<number>() : newestLineCells(data.cells);
  for (const c of data.cells) {
    // Turned-over squares carry their prompt text (issue #444, refining
    // #423's all-textless rule): the marked squares — free centre included —
    // are the brag, so their text renders again (small, readable on
    // pinch-to-zoom), while UNMARKED squares stay textless so the board
    // still reads as shape at iMessage-bubble size. Marked squares fill
    // with the theme gradient (`.marked`), the newest winning line adds a
    // glow (`.line`), the free centre stays accent (`.free`), and a
    // marked-but-unconfirmed square (admin_confirmed mode) reads faded/dashed
    // (`.pending`) rather than a solid win — game/logic.ts's markedMask
    // withholds credit from pending marks, so the card must not overstate
    // them either (Codex P2, PR #111 finding 2). `.pending` layers on top of
    // `.marked`, mirroring Board.tsx's own on-page cell className.
    const showText = c.free || c.marked;
    // Length-tiered type (Codex P2, PR #445): the pool's prompt ceiling is 80
    // chars (firestore.rules' text.size() <= 80), and at the base 9px a
    // ~58px tile fits only ~50 — wrapping alone just grows more lines than
    // the tile can show, and overflow: hidden would clip the receipt out of
    // the rasterized image where pinch-to-zoom can't recover it. Two smaller
    // steps keep the full ceiling renderable, sized against the tightest
    // tile (a `.line` cell's 3px border): >40 chars drops to 7px, >70 to
    // 6px. Thresholds are chars, not pixels — the card is a fixed frame, so
    // a deterministic class beats a measure-and-fit pass here.
    const fit = !showText ? '' : c.text.length > 70 ? ' xlong' : c.text.length > 40 ? ' long' : '';
    const cls =
      'share-card-cell' +
      (c.free ? ' free' : '') +
      (c.marked ? ' marked' : '') +
      (lineCells.has(c.index) ? ' line' : '') +
      (c.status === 'pending' ? ' pending' : '') +
      fit;
    grid.append(el('div', cls, showText ? c.text : undefined));
  }
  card.append(grid);
  if (data.statLine) card.append(el('div', 'share-card-stat', data.statLine));
  card.append(el('div', 'share-card-footer', `${shareCardAppName()} ${editionLexicon().shareMark}`));
  return card;
}

export async function renderBingoShareCard(data: BingoShareCardData): Promise<Blob> {
  // Validity gate (Codex P2, PR #111 finding 1): a BINGO/Blackout card must
  // depict the Player's REAL board — free center + 24 prompts, the exact
  // invariant `dealBoard` enforces in game/logic.ts — never a partial or
  // empty grid. Refuse outright rather than rasterize something misleading.
  // Celebration.tsx's caller already treats any throw here as `blob: null`
  // and falls through to shareCardBlob's text/URL leg, so this degrades to
  // a text share instead of ever producing (let alone sharing) a bad image.
  if (data.cells.length !== 25) {
    throw new Error(`renderBingoShareCard needs exactly 25 cells, received ${data.cells.length}.`);
  }
  return rasterize(buildBingoCardNode(data));
}

// ---------------------------------------------------------------------------
// Leaderboard card
// ---------------------------------------------------------------------------

export interface LeaderboardShareRow {
  uid: string;
  /** The Player's position in the FULL roster (ADR 0001 rank — bingos desc, squares desc, earliest first-bingo), not a renumbering of just the shared rows. */
  rank: number;
  displayName: string;
  bingoCount: number;
  squaresMarked: number;
  blackout: boolean;
  /** True for the roster's single earliest-first-bingo Player — a pin, not a rank (ADR 0001). */
  firstToBingo: boolean;
}

export interface LeaderboardShareCardData {
  eventName: string;
  /** Already the exact rows to render, in display order — shaping (top-N, pin inclusion) is the caller's job (Leaderboard.tsx), not this renderer's. */
  rows: LeaderboardShareRow[];
  /** Optional top line (day + port) — same contract as the BINGO card's `contextLine`. Absent → falls back to `eventName`. */
  contextLine?: string;
  /** Optional snapshot-dating stat line — e.g. "Through Day 5 of 10". Absent → nothing renders. */
  statLine?: string;
}

const PIN_LABEL = '★ First BINGO';

/** A compact rank-4+ row: rank, name, and the bingo/square stat pushed right. */
function buildLeaderboardRow(r: LeaderboardShareRow): HTMLDivElement {
  const row = el('div', 'share-card-row' + (r.firstToBingo ? ' pinned' : ''));
  row.append(el('span', 'share-card-rank', String(r.rank)));
  row.append(el('span', 'share-card-name', r.displayName));
  const subText =
    `${r.bingoCount} bingo${r.bingoCount === 1 ? '' : 's'} · ${r.squaresMarked} sq` +
    (r.blackout ? ' · BLACKOUT' : '');
  row.append(el('span', 'share-card-sub', subText));
  // The pin can still land on a compact row when its holder falls outside the
  // top three (buildShareStandings appends them), so it must render here too.
  if (r.firstToBingo) row.append(el('span', 'share-card-pin', PIN_LABEL));
  return row;
}

/** A podium column (rank 1–3): the ★ pin above its holder, name, bingo count, and a rank-baked bar. */
function buildPodiumColumn(r: LeaderboardShareRow): HTMLDivElement {
  const col = el('div', `share-card-col rank-${r.rank}` + (r.firstToBingo ? ' pinned' : ''));
  if (r.firstToBingo) col.append(el('span', 'share-card-pin', PIN_LABEL));
  col.append(el('span', 'share-card-name', r.displayName));
  col.append(el('span', 'share-card-bc', `${r.bingoCount} bingo${r.bingoCount === 1 ? '' : 's'}`));
  col.append(el('div', 'share-card-bar', String(r.rank)));
  return col;
}

function buildLeaderboardCardNode(data: LeaderboardShareCardData): HTMLDivElement {
  const card = el('div', 'share-card share-card-leaderboard');
  card.style.width = `${CARD_WIDTH}px`;
  card.style.height = `${CARD_HEIGHT}px`;
  card.append(el('div', 'share-card-event', data.contextLine ?? data.eventName));
  card.append(el('div', 'share-card-title', 'LEADERBOARD'));

  // Renderer renders exactly the rows it is given (issue #36): the caller
  // shapes to the cap (five) and appends the pin if needed. The renderer only
  // decides layout — first three as a podium, the rest as compact rows.
  const podiumRows = data.rows.slice(0, 3);
  const restRows = data.rows.slice(3);

  if (podiumRows.length > 0) {
    const podium = el('div', 'share-card-podium');
    // Centre the leader visually (2nd · 1st · 3rd) when a full podium is
    // present; render in given order otherwise. Rank text is never
    // renumbered — the bar shows `row.rank`.
    const order =
      podiumRows.length === 3 ? [1, 0, 2] : podiumRows.length === 2 ? [0, 1] : [0];
    for (const idx of order) podium.append(buildPodiumColumn(podiumRows[idx]));
    card.append(podium);
  }

  if (restRows.length > 0) {
    const rows = el('div', 'share-card-rows');
    for (const r of restRows) rows.append(buildLeaderboardRow(r));
    card.append(rows);
  }

  if (data.statLine) card.append(el('div', 'share-card-stat', data.statLine));
  card.append(el('div', 'share-card-footer', `${shareCardAppName()} ${editionLexicon().shareMark}`));
  return card;
}

export async function renderLeaderboardShareCard(data: LeaderboardShareCardData): Promise<Blob> {
  return rasterize(buildLeaderboardCardNode(data));
}

// ---------------------------------------------------------------------------
// Final-standings (farewell podium) card — issue #449
// ---------------------------------------------------------------------------

export interface FarewellShareCardData {
  eventName: string;
  /** The frozen podium's champion — `null` renders no champion block. */
  champion: { displayName: string; bingoCount: number; squaresMarked: number } | null;
  /** The cruise-wide First to BINGO — `null` renders no block. */
  firstBingo: { displayName: string } | null;
  /** Daily honors, already labeled and ordered by the caller (FarewellPodium.tsx) — the renderer stays dumb, same contract as the Leaderboard card's rows. */
  honors: Array<{ dayLabel: string; displayName: string }>;
  /** Same contract as the other cards' `contextLine`. Absent → falls back to `eventName`. */
  contextLine?: string;
  /** e.g. "Final standings · 10 days". Absent → nothing renders. */
  statLine?: string;
  /**
   * The frozen Most-Loved Photo hero (#534/#561, wireframes
   * `fx-share-final-photo-*`): present → the card renders its PHOTO-HERO
   * composition (hero box + compressed standings rows; the daily honors yield
   * their space and stay on the photo-less fallback). Absent or `null` → the
   * photo-less composition above, byte-identical to the pre-#534 card — the
   * KEPT documented fallback for no award, `winners: []`, a hidden winner, or
   * any media failure. The caller shapes everything (FarewellPodium.tsx):
   * `photoUrl` is an already-fetched blob object URL (html-to-image needs
   * same-origin-readable pixels), `heartCount` is the FROZEN eligible count,
   * `creditLine` is fully composed (name · “prompt” · day label · tie suffix).
   */
  mostLoved?: { photoUrl: string; heartCount: number; creditLine: string } | null;
  /**
   * Standings rows 2-3 for the hero composition's compressed rows
   * (`buildPodium().runnersUp`). Ignored by the photo-less composition, which
   * keeps its honoree-blocks layout untouched.
   */
  runnersUp?: Array<{ displayName: string; bingoCount: number; squaresMarked: number }>;
}

/** A labeled honoree block: medal-tagged role line, then the name (and optional stat). */
function buildHonoree(
  role: string,
  name: string,
  stat?: string,
): HTMLDivElement {
  const block = el('div', 'share-card-honoree');
  block.append(el('span', 'share-card-honoree-role', role));
  block.append(el('span', 'share-card-honoree-name', name));
  if (stat) block.append(el('span', 'share-card-honoree-stat', stat));
  return block;
}

/** One compressed standings row for the photo-hero composition (wireframes `fx-share-final-photo-*`: rank cell, name, optional role chip, optional right-aligned stat). */
function buildMostLovedRow(opts: {
  champ?: boolean;
  rank: string;
  name: string;
  role?: string;
  stat?: string;
}): HTMLDivElement {
  const row = el('div', 'share-card-ml-row' + (opts.champ ? ' champ' : ''));
  row.append(el('span', 'share-card-ml-rank', opts.rank));
  row.append(el('span', 'share-card-ml-name', opts.name));
  if (opts.role) row.append(el('span', 'share-card-ml-role', opts.role));
  if (opts.stat) row.append(el('span', 'share-card-ml-stat', opts.stat));
  return row;
}

function buildFarewellCardNode(data: FarewellShareCardData): HTMLDivElement {
  // Sanitize the hero URL at the sink, the safeMediaUrl-last rule (PR #95's
  // CodeQL barrier; blob: is allow-listed). A value the guard rejects renders
  // the photo-less composition rather than an empty hero frame.
  const heroSrc = data.mostLoved ? safeMediaUrl(data.mostLoved.photoUrl) : undefined;
  const mostLoved = data.mostLoved && heroSrc ? { ...data.mostLoved, src: heroSrc } : null;

  const card = el('div', 'share-card share-card-farewell');
  card.style.width = `${CARD_WIDTH}px`;
  card.style.height = `${CARD_HEIGHT}px`;
  card.append(el('div', 'share-card-event', data.contextLine ?? data.eventName));
  card.append(el('div', 'share-card-title', 'FINAL STANDINGS'));

  if (mostLoved) {
    // Photo-hero composition (#534/#561): the frozen Most-Loved Photo leads,
    // letterboxed into the hero box with the award badge and the FROZEN heart
    // count on the photo itself; the standings compress to ranked rows below.
    // Daily honors are omitted — the one block that yields its space to the
    // photo; they remain on the photo-less fallback.
    const hero = el('div', 'share-card-ml-hero');
    const img = document.createElement('img');
    img.className = 'share-card-ml-img';
    img.alt = '';
    img.src = mostLoved.src;
    hero.append(img);
    hero.append(el('span', 'share-card-ml-badge', '📷 Most-loved photo'));
    hero.append(el('span', 'share-card-ml-hearts', `❤ ${mostLoved.heartCount}`));
    card.append(hero);
    card.append(el('div', 'share-card-ml-by', mostLoved.creditLine));

    const rows = el('div', 'share-card-ml-rows');
    if (data.champion) {
      rows.append(
        buildMostLovedRow({
          champ: true,
          rank: '1',
          name: data.champion.displayName,
          role: `🏆 ${editionBrand().championRole}`,
          stat: `${data.champion.bingoCount} bingo${data.champion.bingoCount === 1 ? '' : 's'}`,
        }),
      );
    }
    (data.runnersUp ?? []).forEach((r, i) => {
      rows.append(
        buildMostLovedRow({
          rank: String(i + 2),
          name: r.displayName,
          stat: `${r.bingoCount} bingo${r.bingoCount === 1 ? '' : 's'} · ${r.squaresMarked} sq`,
        }),
      );
    });
    if (data.firstBingo) {
      // Name only — the wireframe's timestamp stat is a recorded deviation
      // (specs/most-loved-photo.md § Deviations): the card system renders no
      // timezone-formatted times.
      rows.append(
        buildMostLovedRow({ rank: '👑', name: data.firstBingo.displayName, role: 'First to BINGO' }),
      );
    }
    if (rows.childElementCount > 0) card.append(rows);
  } else {
    if (data.champion) {
      card.append(
        buildHonoree(
          `🏆 ${editionBrand().championRole}`,
          data.champion.displayName,
          `${data.champion.bingoCount} bingo${data.champion.bingoCount === 1 ? '' : 's'} · ${data.champion.squaresMarked} squares`,
        ),
      );
    }
    if (data.firstBingo) {
      card.append(buildHonoree('👑 First to BINGO', data.firstBingo.displayName));
    }

    if (data.honors.length > 0) {
      card.append(el('div', 'share-card-honors-title', 'Daily honors'));
      const honors = el('div', 'share-card-honors');
      for (const h of data.honors) {
        const row = el('div', 'share-card-honor-row');
        row.append(el('span', 'share-card-honor-day', h.dayLabel));
        row.append(el('span', 'share-card-honor-name', h.displayName));
        honors.append(row);
      }
      card.append(honors);
    }
  }

  if (data.statLine) card.append(el('div', 'share-card-stat', data.statLine));
  card.append(el('div', 'share-card-footer', `${shareCardAppName()} ${editionLexicon().shareMark}`));
  return card;
}

/** How long `img.decode()` may take before the render falls back to the
 *  photo-less composition (#661) — mirrors `HERO_PHOTO_FETCH_TIMEOUT_MS` in
 *  FarewellPodium.tsx: the fetch that produces the hero's object URL is
 *  already bounded, but a stalled decode of an already-fetched image would
 *  otherwise hang this await forever, wedging both the warmed promise and a
 *  tapped share action behind an unresolvable render. */
const HERO_IMAGE_DECODE_TIMEOUT_MS = 8000;

/**
 * The farewell podium as a Share Card (issue #449) — same pipeline, third card
 * kind. #534/#561: with `data.mostLoved` set the node is the photo-hero
 * composition, and the hero image is DECODED before rasterization —
 * html-to-image walks the DOM synchronously, so an undecoded image would
 * raster as an empty box. `decode()` is feature-guarded (jsdom has none), and
 * a decode failure OR a decode that stalls past the bound (#661) falls back
 * to the photo-less composition rather than ever sharing a broken hero — or
 * hanging the share action indefinitely.
 */
export async function renderFarewellShareCard(data: FarewellShareCardData): Promise<Blob> {
  const node = buildFarewellCardNode(data);
  const img = node.querySelector<HTMLImageElement>('.share-card-ml-img');
  if (img && typeof img.decode === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('hero image decode timed out')),
        HERO_IMAGE_DECODE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([img.decode(), timeout]);
    } catch {
      return rasterize(buildFarewellCardNode({ ...data, mostLoved: null }));
    } finally {
      clearTimeout(timer);
    }
  }
  return rasterize(node);
}

// e2e-only seam (#603): tests/e2e/emoji-raster.spec.ts builds the REAL
// farewell card in a real Chrome, rasterizes it through the real pipeline,
// and measures the raster's text geometry against the live DOM — the defect
// (emoji mis-shaped in html-to-image's SVG pass, wrapping/overpainting
// neighbours) only manifests in a real browser render, so no jsdom test can
// pin it. Gated on MODE === 'e2e' exactly like src/firebase.ts's emulator
// branch: the production build (MODE 'production') dead-code-eliminates it.
if (import.meta.env.MODE === 'e2e') {
  (window as unknown as Record<string, unknown>).__shareCardE2E = {
    buildFarewellCardNode,
    // The real rasterization seam (offscreen mount + fitCellText + toBlob at
    // PIXEL_RATIO), exposed separately so the spec can neutralize the card's
    // themed background on the built node first — the ink measurement needs
    // transparent ground, and background/border-color changes don't move
    // text geometry.
    rasterize,
  };
}

// ---------------------------------------------------------------------------
// Native share sheet + fallback chain — shared by Celebration.tsx and
// Leaderboard.tsx so the degrade path lives exactly once.
// ---------------------------------------------------------------------------

export type ShareOutcome =
  | 'files'
  | 'text'
  | 'clipboard'
  | 'download'
  | 'cancelled'
  | 'prompt'
  | 'none';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Marks the fallback sheet's own node, so a second dead-ended tap replaces
 *  the first rather than stacking a second sheet on top of it. */
const SHARE_FALLBACK_CLASS = 'share-fallback-backdrop';

/**
 * The chain's TERMINAL, activation-free affordance (Codex P1, PR #712 round
 * 3) — the leg that makes "the tap did nothing" unreachable.
 *
 * Every other leg in this chain depends on the very thing that can be gone by
 * the time a slow render finishes: `navigator.share` requires transient user
 * activation, and so does `clipboard.writeText` on Safari and Firefox. So
 * when a tap arrives with the activation already spent, the API legs can ALL
 * decline in silence, and with no blob there is not even a download left —
 * the chain used to return `'none'` and the Player saw nothing happen at all.
 *
 * This leg deliberately calls no gated API. It renders a small sheet carrying
 * the link (selectable, so it is useful even with no Clipboard API at all)
 * plus the buttons the Player can press: pressing one is a FRESH gesture that
 * mints FRESH activation, which is exactly what the silent write was missing.
 * The Player is told what happened and handed the next step, instead of being
 * left to wonder whether the button works.
 *
 * Built as plain DOM on `document.body` rather than as React state in each of
 * the three callers, for the reason this whole function exists: the degrade
 * path lives exactly once (and `downloadBlob` above already reaches for the
 * DOM the same way). It owns its own teardown — the Close button, a backdrop
 * click, or Escape — and only one can ever be mounted.
 *
 * Returns whether a sheet was actually mounted: with neither a link nor an
 * image there is genuinely nothing to offer, and the caller keeps `'none'`.
 */
function showShareFallbackSheet(opts: { url?: string; blob: Blob | null; filename: string }): boolean {
  const { url, blob, filename } = opts;
  if (!url && !blob) return false;
  if (typeof document === 'undefined' || !document.body) return false;

  document.querySelector(`.${SHARE_FALLBACK_CLASS}`)?.remove();

  const backdrop = el('div', `sheet-backdrop ${SHARE_FALLBACK_CLASS}`);
  const sheet = el('div', 'sheet share-fallback');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Finish sharing');
  sheet.appendChild(el('div', 'sheet-title', 'Finish sharing'));
  sheet.appendChild(
    el(
      'p',
      'share-fallback-note',
      url
        ? 'Your browser wouldn’t open the share sheet. Here’s the link — copy it and paste it anywhere.'
        : 'Your browser wouldn’t open the share sheet. Save the card and send it yourself.',
    ),
  );
  if (url) sheet.appendChild(el('p', 'share-fallback-url', url));

  const actions = el('div', 'sheet-actions');
  const close = (): void => {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
  };
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  const button = (className: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    actions.appendChild(b);
    return b;
  };

  if (url && navigator.clipboard?.writeText) {
    const copy = button('btn primary', 'Copy link', () => {
      // A press is a fresh user activation, so this write is allowed where the
      // chain's own silent one was not. A rejection even here leaves the link
      // on screen to select by hand — still not a dead end.
      void navigator.clipboard.writeText(url).then(
        () => {
          copy.textContent = 'Link copied';
        },
        () => {
          copy.textContent = 'Copy it above';
        },
      );
    });
  }
  if (blob) {
    button('btn', 'Save image', () => {
      try {
        downloadBlob(blob, filename);
      } catch {
        /* the link (and the sheet) are still on screen */
      }
    });
  }
  const dismiss = button('btn', 'Close', close);

  sheet.appendChild(actions);
  backdrop.appendChild(sheet);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.appendChild(backdrop);
  // Focus lands on the primary action when there is one, so a keyboard Player
  // is inside the sheet rather than back where the dead-ended tap left them.
  (actions.querySelector<HTMLButtonElement>('.btn.primary') ?? dismiss).focus();
  return true;
}

/**
 * Whether a caught Web Share API rejection reflects the Player's OWN choice
 * to dismiss the OS share sheet, rather than the API genuinely failing
 * (Codex P2, PR #111 finding 3). `AbortError` is the spec-mandated name for
 * a user-cancelled `navigator.share()` — unambiguous, always a stop.
 * `NotAllowedError` is AMBIGUOUS (round 2 finding 2): some platforms report
 * a user dismissal / declined permission that way, but it is ALSO what
 * `navigator.share` rejects when the transient user-activation window
 * expired before the call ran — e.g. a tap that awaited a slow tap-time
 * rasterization. The decision, revisited with the round-2 eager pre-render
 * in place: KEEP treating it as a cancellation and stop the chain. The
 * pre-render (Celebration rasterizes at mount; Leaderboard warms on
 * hover/focus/press) removed the main non-dismissal cause — a full
 * rasterization inside the activation window — so a NotAllowedError here is
 * now predominantly a real dismissal, and the residual (a rare do-nothing
 * tap on a slow device whose warmed render was cold or stale) is a better
 * failure mode than clobbering the clipboard right after a Player declined
 * to share. Duck-typed on `.name` rather than `instanceof Error` because a
 * real rejection here is a `DOMException`, which is not guaranteed to be
 * `instanceof Error` in every environment.
 */
function isUserCancelledShare(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false;
  const { name } = err as { name: unknown };
  return name === 'AbortError' || name === 'NotAllowedError';
}

/**
 * Whether the document still holds the transient user activation that BOTH
 * `navigator.share` legs require (Codex P1, PR #712 round 2).
 *
 * The classifier above deliberately reads a `NotAllowedError` as a dismissal
 * and stops the chain, which is right when the sheet actually opened — but it
 * is exactly wrong when the activation window expired before `share()` ran:
 * the Player saw no sheet, declined nothing, and the tap becomes a silent
 * no-op with no clipboard or download fallback. `navigator.userActivation`
 * turns that ambiguity into a fact BEFORE the call: with `isActive === false`
 * the share is guaranteed to reject, so the chain skips straight to the
 * clipboard/download legs (neither needs activation) and the Player still
 * ends up with something they can act on — the ADR 0005 promise.
 *
 * Must be read ONCE, before any share is attempted: `navigator.share`
 * CONSUMES the activation, so a post-hoc check cannot tell an expiry apart
 * from a share that ran normally. Absent on browsers without the User
 * Activation API, where `true` (assume alive, let the attempt decide) keeps
 * the pre-existing behavior exactly.
 */
function shareActivationAlive(): boolean {
  const activation = navigator.userActivation as UserActivation | undefined;
  return activation ? activation.isActive : true;
}

/**
 * Hands a rendered Share Card to the OS share sheet when the platform can
 * take image files (`navigator.canShare({ files })`); otherwise degrades —
 * in order — through a text/URL share, the clipboard, then a direct
 * download, so the Player always ends up with something they can act on
 * (ADR 0005, issue #36). `blob` may be `null` when the on-device render
 * itself failed (including `renderBingoShareCard`'s validity gate); the
 * chain simply skips the file-share and download legs. Never throws — every
 * branch is self-contained, so a caller can await this without its own
 * try/catch.
 *
 * A `'cancelled'` outcome is terminal on BOTH the file leg and the text/URL
 * leg — the chain stops rather than surprising a Player who just declined
 * to share with a clipboard write or file download right after. The file
 * leg treats ANY rejection there as a cancellation (see its own comment
 * below); the text/URL leg distinguishes cancellation from a genuine
 * failure via `isUserCancelledShare` (Codex P2, PR #111 finding 3) — a
 * non-cancellation rejection there still falls through to the clipboard and
 * download legs.
 *
 * BOTH share legs are skipped outright when `navigator.userActivation` says
 * the transient activation is already gone (Codex P1, PR #712 round 2): there
 * is no dismissal to respect when no sheet can open, so the chain degrades to
 * the clipboard/download legs rather than returning a fallback-less
 * `'cancelled'`.
 *
 * And because the clipboard leg is ALSO activation-gated on Safari and
 * Firefox (Codex P1, PR #712 round 3), a spent activation with no blob to
 * download would still have dead-ended at `'none'`. The chain therefore ends
 * in an affordance that needs no activation at all —
 * `showShareFallbackSheet`, outcome `'prompt'` — so a tap always leaves the
 * Player with a sheet, a copied link, a download, or something visible to
 * press. Either way, callers (`Celebration.tsx`, `Leaderboard.tsx`)
 * fire `share_click` unconditionally from their own `finally`, once per tap,
 * regardless of this function's return value — a cancelled share still
 * counts as a tap; the return value is what distinguishes outcomes for a
 * caller that cares, not whether the analytics event fires.
 */
export async function shareCardBlob(opts: {
  blob: Blob | null;
  filename: string;
  title: string;
  text: string;
  url?: string;
}): Promise<ShareOutcome> {
  const { blob, filename, title, text, url } = opts;

  // Read the activation state ONCE, before either share leg runs (see
  // `shareActivationAlive`). When it is definitively gone, both legs would
  // reject `NotAllowedError` and the file leg's any-rejection-is-a-dismissal
  // rule would return 'cancelled' with no fallback — a delayed no-op.
  // Skipping them lands the Player on the clipboard/download legs instead,
  // which need no activation.
  const activationAlive = shareActivationAlive();

  if (blob && activationAlive) {
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title, text });
        return 'files';
      } catch {
        // The Player dismissed the native sheet (or it failed outright) —
        // respect that choice rather than surprising them with a second
        // fallback share/prompt right after they cancelled the first.
        return 'cancelled';
      }
    }
  }

  if (navigator.share && activationAlive) {
    try {
      await navigator.share({ title, text, url });
      return 'text';
    } catch (err) {
      // A cancellation here stops the chain silently (Codex P2, PR #111
      // finding 3) — same Player-respecting rule as the file leg above.
      // Only a genuine failure (the API existed but something actually went
      // wrong) falls through to the clipboard/download legs.
      if (isUserCancelledShare(err)) return 'cancelled';
    }
  }

  if (navigator.clipboard?.writeText && url) {
    try {
      await navigator.clipboard.writeText(url);
      return 'clipboard';
    } catch {
      /* fall through to the download leg */
    }
  }

  if (blob) {
    try {
      downloadBlob(blob, filename);
      return 'download';
    } catch {
      /* fall through to the visible fallback */
    }
  }

  // Terminal leg (Codex P1, PR #712 round 3): every leg above needs either an
  // image or a live user activation, and the case that started this — a
  // stalled cold render handing over `blob: null` with the activation already
  // spent — has neither, so all of them decline silently. Rather than return
  // a `'none'` the Player experiences as a broken button, put the link in
  // front of them with a press that will mint the activation the silent
  // clipboard write lacked. Only a call with NOTHING to offer still reports
  // `'none'`.
  if (showShareFallbackSheet({ url, blob, filename })) return 'prompt';

  return 'none';
}
