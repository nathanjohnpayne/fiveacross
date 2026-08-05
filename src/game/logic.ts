// Pure, framework-free game logic. No Firebase, no React — fully unit-testable.
import type { Cell, DayDef, EventDoc, PlayerDoc } from '../types';

export const GRID = 5;
export const CENTER = 12;

/**
 * Minimum active, non-free Prompt pool needed to deal a Board: 24 = the 25 cells
 * minus the free center (ADR 0003). Below this, `dealBoard` fails fast (ADR 0004
 * guard) rather than persisting a card with blank cells. Exported so the Board
 * render can surface the same threshold instead of duplicating the literal.
 */
export const MIN_POOL = 24;

/** The 12 winning lines (5 rows, 5 cols, 2 diagonals) as cell indices. */
export const LINES: number[][] = (() => {
  const L: number[][] = [];
  for (let r = 0; r < GRID; r++) L.push([0, 1, 2, 3, 4].map((k) => r * GRID + k));
  for (let c = 0; c < GRID; c++) L.push([0, 1, 2, 3, 4].map((k) => k * GRID + c));
  L.push([0, 6, 12, 18, 24]);
  L.push([4, 8, 12, 16, 20]);
  return L;
})();

/** mulberry32 — tiny deterministic PRNG so a board is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface DealItem {
  id: string;
  text: string;
  spicy: boolean;
  /**
   * Which item pool the Prompt belongs to (`main` | `embark` | `farewell`). Absent
   * on the pre-easy-mix / synthetic-test items → treated as `main`. Only `'embark'`
   * is load-bearing here: on a main-day deal, embark items form the EASY half of the
   * mix (specs/easy-mix.md), while everything else is the main half.
   */
  pool?: string;
}

function interleavePicks(spicyPicks: DealItem[], tamePicks: DealItem[]): DealItem[] {
  const total = spicyPicks.length + tamePicks.length;
  const slots: (DealItem | null)[] = Array(total).fill(null);

  // Place the smaller category first, spread evenly across the 24 non-free
  // positions, then fill the rest. This guarantees the composition pattern
  // cannot collapse into a random row-sized cluster for unlucky seeds while
  // keeping each category's own seeded shuffle order intact.
  const primary = spicyPicks.length <= tamePicks.length ? spicyPicks : tamePicks;
  const secondary = spicyPicks.length <= tamePicks.length ? tamePicks : spicyPicks;
  const primarySlots = new Set<number>();
  for (let i = 0; i < primary.length; i++) {
    primarySlots.add(Math.floor(((i + 0.5) * total) / primary.length));
  }
  let primaryIndex = 0;
  let secondaryIndex = 0;
  for (let i = 0; i < total; i++) {
    slots[i] = primarySlots.has(i) ? primary[primaryIndex++] : secondary[secondaryIndex++];
  }

  return slots as DealItem[];
}

/** What a stratified selection chose (`spicy`/`tame`) plus what it left behind
 *  (`leftoverSpicy`/`leftoverTame`) — the leftovers backfill the easy half of a mix. */
interface StratifiedSelection {
  spicy: DealItem[];
  tame: DealItem[];
  leftoverSpicy: DealItem[];
  leftoverTame: DealItem[];
}

/**
 * Select `count` picks from `pool`, stratified by the 🔞 `spicy` flag: shuffle the
 * spicy and tame subsets independently (both with the SAME seeded `rnd`, so the deal
 * stays deterministic per seed), take `round(count * spicyRatio)` spicy and the rest
 * tame, and backfill from whichever category has more when the other runs short.
 * Returns the chosen slices AND the untouched remainders. Consuming `rnd` here is
 * IDENTICAL to the pre-easy-mix `stratifiedPicks` when `count === 24` — the spicy
 * then tame shuffle, same target math — so the all-main deal is byte-for-byte
 * unchanged (the easy-mix no-regression proof).
 */
function selectStratified(
  pool: DealItem[],
  count: number,
  spicyRatio: number,
  rnd: () => number,
): StratifiedSelection {
  const spicyPool = shuffle(
    pool.filter((p) => p.spicy),
    rnd,
  );
  const tamePool = shuffle(
    pool.filter((p) => !p.spicy),
    rnd,
  );
  const targetSpicy = Math.round(count * spicyRatio);
  const targetTame = count - targetSpicy;
  let spicyTaken = Math.min(spicyPool.length, targetSpicy);
  let tameTaken = Math.min(tamePool.length, targetTame + (targetSpicy - spicyTaken));
  const remaining = count - spicyTaken - tameTaken;
  if (remaining > 0) {
    spicyTaken += Math.min(spicyPool.length - spicyTaken, remaining);
  }
  return {
    spicy: spicyPool.slice(0, spicyTaken),
    tame: tamePool.slice(0, tameTaken),
    leftoverSpicy: spicyPool.slice(spicyTaken),
    leftoverTame: tamePool.slice(tameTaken),
  };
}

/**
 * Stratified sample of 24 picks from `pool` (the all-main deal): `spicyRatio` of them
 * (rounded) spicy, the rest tame, laid out evenly across the 24 non-free positions so
 * spicy/tame interleave instead of clustering. Unchanged from before easy mix — the
 * `easyCount === 0` path routes here so a Day with no embark in its snapshot (Days
 * 1–3) deals exactly as it always has.
 */
function stratifiedPicks(pool: DealItem[], spicyRatio: number, rnd: () => number): DealItem[] {
  const sel = selectStratified(pool, 24, spicyRatio, rnd);
  return interleavePicks(sel.spicy, sel.tame);
}

/**
 * The easy-mix composition (specs/easy-mix.md): `easyCount` squares drawn from the
 * embark pool + `24 - easyCount` from the stratified main deal, interleaved across the
 * grid so the easy squares don't cluster. The MAIN half is selected FIRST so its
 * seeded draw is unaffected by the easy half's shuffle (and `easyCount === 0` never
 * reaches here — that is the untouched all-main path). Backfill is bidirectional and
 * mirrors the existing stratum-dry behavior: an embark shortfall (a hidden/thin
 * embark pool) is filled from leftover tame-then-spicy main; a main shortfall (a thin
 * main pool) is filled from the spare embark. Embark and main items are disjoint
 * pools, so the resulting 24 squares are always distinct.
 */
function mixedPicks(
  mainPool: DealItem[],
  embarkPool: DealItem[],
  easyCount: number,
  spicyRatio: number,
  rnd: () => number,
): DealItem[] {
  const mainCount = 24 - easyCount;
  const sel = selectStratified(mainPool, mainCount, spicyRatio, rnd);
  const mainPicks = interleavePicks(sel.spicy, sel.tame); // up to mainCount
  const leftoverMain = [...sel.leftoverTame, ...sel.leftoverSpicy]; // tame first (ticket)

  const embarkShuffled = shuffle(embarkPool, rnd);
  const embarkUsed = Math.min(easyCount, embarkShuffled.length);
  const easyPicks = embarkShuffled.slice(0, embarkUsed);
  // Embark short of the easy count → backfill the easy half from leftover main.
  if (easyPicks.length < easyCount) {
    easyPicks.push(...leftoverMain.slice(0, easyCount - easyPicks.length));
  }
  // Main short of its count → backfill the main half from the spare embark items
  // (those past the `embarkUsed` the easy half already claimed, so no square repeats).
  if (mainPicks.length < mainCount) {
    const spareEmbark = embarkShuffled.slice(embarkUsed);
    mainPicks.push(...spareEmbark.slice(0, mainCount - mainPicks.length));
  }
  return interleavePicks(easyPicks, mainPicks);
}

/** Shuffle the whole pool and take the first 24 — no spicy/tame target. Used
 * for tutorial (embark/farewell) Day Snapshots, which are seeded all-tame, so
 * forcing a spicy ratio against them is meaningless (daily-cards-spec §
 * "Unlock mechanics": "tutorial pools are all tame so they deal unstratified").
 */
function unstratifiedPicks(pool: DealItem[], rnd: () => number): DealItem[] {
  return shuffle(pool, rnd).slice(0, 24);
}

/**
 * Options for a per-Day deal (daily-cards-spec § "Unlock mechanics").
 *   - `excludeIds`: Prompt ids already on this Player's earlier Day Cards, to be
 *     kept off the new card (no-repeat-across-the-cruise). Exclusion is best-effort:
 *     if honoring it would drop the usable pool below `MIN_POOL`, the pool is
 *     exhausted (~80 main items ÷ 24/day ≈ 3⅓ Days) and the exclusion RESETS —
 *     the full pool is used again, exactly the spec's reset boundary.
 *   - `stratify`: false for all-tame tutorial pools (no spicy/tame target); the
 *     default (true) keeps the 10-spicy/14-tame stratified composition.
 */
export interface DealOptions {
  excludeIds?: ReadonlySet<string>;
  stratify?: boolean;
  /**
   * Share of the 24 non-free squares dealt from the EASY (embark) pool instead of the
   * main pool (specs/easy-mix.md), clamped to 0..1. `round(24 * easyMixRatio)` squares
   * come from the embark items in `pool`; the rest are the normal stratified main
   * deal, with `spicyRatio` applied WITHIN that main remainder. Two gates keep it
   * inert where it must be: it is ignored on the unstratified tutorial path
   * (`stratify: false`), and it has no effect when `pool` carries no embark items — a
   * main-only snapshot (Days 1–3, stamped before easy mix) deals byte-for-byte as
   * today. Defaults to 0 here; the live default (0.5) is applied at the deal call
   * sites, read defensively like `spicyRatio`.
   */
  easyMixRatio?: number;
}

/**
 * Apply the no-repeat exclusion with the pool-exhaustion reset: drop every id in
 * `excludeIds`, but if that would leave fewer than `requiredCount` Prompts to deal
 * from, discard the exclusion and return the full pool (the cruise has cycled
 * through this pool's required share; repeats resume rather than starving the card).
 * Returns the original array reference when there is nothing to exclude.
 */
function applyExclusion(
  pool: DealItem[],
  excludeIds?: ReadonlySet<string>,
  requiredCount: number = MIN_POOL,
): DealItem[] {
  if (!excludeIds || excludeIds.size === 0) return pool;
  const remaining = pool.filter((p) => !excludeIds.has(p.id));
  return remaining.length >= requiredCount ? remaining : pool;
}

/** Deal a frozen 5x5 board: 24 sampled prompts + free center (index 12). */
export function dealBoard(
  pool: DealItem[],
  freeText: string,
  seed: number,
  spicyRatio: number = 0.4,
  opts: DealOptions = {},
): Cell[] {
  const rnd = mulberry32(seed);
  // A malformed events/{id}.settings.spicyRatio (join-side only checks
  // typeof === 'number', so NaN/Infinity/out-of-0..1 values can reach here)
  // must not corrupt the slice math below (Math.round(NaN) etc. would starve
  // both categories and let MIN_POOL pass while the board still gets blank
  // non-free cells, Codex #135). Clamp to a finite 0..1, falling back to the
  // default ratio when the value isn't usably numeric at all.
  const ratio = Number.isFinite(spicyRatio) ? Math.min(1, Math.max(0, spicyRatio)) : 0.4;

  let picks: DealItem[];
  if (opts.stratify === false) {
    // Tutorial pools (embark/farewell) — the whole-pool unstratified deal, unchanged.
    // Easy mix never applies here: these Days ARE the embark/farewell card, not a main
    // card blending embark in. Honor the exclusion + MIN_POOL guard exactly as before.
    const usablePool = applyExclusion(pool, opts.excludeIds);
    if (usablePool.length < MIN_POOL) {
      throw new Error(`dealBoard needs at least ${MIN_POOL} prompts, received ${usablePool.length}.`);
    }
    picks = unstratifiedPicks(usablePool, rnd);
  } else {
    // Main-day deal, now pool-aware (specs/easy-mix.md). Split the snapshot by pool:
    // embark items are the easy half; everything else is the main half. The no-repeat
    // exclusion applies to the MAIN half ONLY — easy (embark) repeats across days are
    // intentional (per-day tallies), so embark items are never excluded.
    const embarkItems = pool.filter((p) => p.pool === 'embark');
    const mainItems = pool.filter((p) => p.pool !== 'embark');
    const requestedEasy = Number.isFinite(opts.easyMixRatio)
      ? Math.min(1, Math.max(0, opts.easyMixRatio as number))
      : 0;
    // The mix is SNAPSHOT-DRIVEN: only a Day whose snapshot actually carries embark
    // items (a both-pools snapshot, Day 4 onward) mixes. A main-only snapshot (Days
    // 1–3, stamped before easy mix) has no embark items, so easyCount is 0 and the
    // deal falls through to today's all-main stratified draw — Days 1–3 stay
    // byte-for-byte untouched even with easyMixRatio set on the event.
    const easyCount = embarkItems.length > 0 ? Math.round(24 * requestedEasy) : 0;
    const mainCount = 24 - easyCount;
    const mainUsable = applyExclusion(mainItems, opts.excludeIds, mainCount);
    // A full board needs 24 non-free squares. At easyCount 0 the deal is main-only, so
    // the thin-pool guard is the main pool alone — preserving the pre-existing throw;
    // with a mix the two pools backfill each other, so the guard is their union.
    const drawable = easyCount > 0 ? mainUsable.length + embarkItems.length : mainUsable.length;
    if (drawable < MIN_POOL) {
      throw new Error(`dealBoard needs at least ${MIN_POOL} prompts, received ${drawable}.`);
    }
    picks =
      easyCount > 0
        ? mixedPicks(mainUsable, embarkItems, easyCount, ratio, rnd)
        : stratifiedPicks(mainUsable, ratio, rnd);
  }
  const cells: Cell[] = [];
  let p = 0;
  for (let i = 0; i < 25; i++) {
    if (i === CENTER) {
      cells.push({
        index: i,
        itemId: null,
        text: freeText,
        free: true,
        marked: true,
        markedAt: null,
      });
    } else {
      const item = picks[p++];
      cells.push({
        index: i,
        itemId: item ? item.id : null,
        text: item ? item.text : '',
        free: false,
        marked: false,
        markedAt: null,
      });
    }
  }
  return cells;
}

/** A cell counts as "on" if it's the free center, or marked and not pending. */
export function markedMask(cells: Cell[]): boolean[] {
  return cells.map((c) => c.free || (c.marked && c.status !== 'pending'));
}

export function completedLines(cells: Cell[]): number[][] {
  const m = markedMask(cells);
  return LINES.filter((line) => line.every((i) => m[i]));
}

export function hasBingo(cells: Cell[]): boolean {
  return completedLines(cells).length > 0;
}

/**
 * Cosmetic-celebration edge (#176). The animation must fire whenever the player
 * completes a NEW winning line, not only the first. Tracking a boolean "has any
 * bingo" flips false→true exactly once, so a 2nd/3rd line never re-triggered it.
 * Comparing the completed-line COUNT against the previous count fixes that:
 * `gained` is true iff a line was just added (a rising edge in the count), and
 * a line falling away (count decreasing) never fires. Returns `lines` so the
 * caller can store it as the next baseline.
 */
export function bingoLineEdge(
  cells: Cell[],
  prevLineCount: number,
): { lines: number; gained: boolean } {
  const lines = completedLines(cells).length;
  return { lines, gained: lines > prevLineCount };
}

/** Set of cell indices that are part of any completed line (for highlighting). */
export function winningCells(cells: Cell[]): Set<number> {
  const s = new Set<number>();
  for (const line of completedLines(cells)) for (const i of line) s.add(i);
  return s;
}

export function isBlackout(cells: Cell[]): boolean {
  return markedMask(cells).every(Boolean);
}

/** Squares the player actively marked (free center excluded). */
export function countMarked(cells: Cell[]): number {
  return cells.filter((c) => !c.free && c.marked && c.status !== 'pending').length;
}

/**
 * True when a Day Card is PRISTINE — zero PLAYER-marked Squares — the sole
 * eligibility window for a Reshuffle (#378, specs/reshuffle.md). The free centre
 * is always `marked` and never counts (CONTEXT.md § "Free Space").
 *
 * Deliberately NOT `countMarked(cells) === 0`, despite reading like its twin.
 * `countMarked` scores the LEADERBOARD, so it discounts a `status: 'pending'`
 * Square — an admin_confirmed-mode Mark awaiting an Admin's resolution doesn't
 * count toward your total until confirmed. Eligibility is a different question:
 * the Player HAS tapped that Square, the card has produced a Claim in the Admin
 * queue, and trading it away would strand that Claim against a card that no
 * longer holds the Prompt. So a pending Mark makes a card non-pristine here even
 * though it scores nothing there.
 *
 * That distinction is also what keeps this predicate honest against
 * `firestore.rules` `boardPristine()`, which exempts only artifact-free Echoes.
 * The two MUST agree, or the chip renders on a card whose reshuffle the server
 * then denies. Pinned by src/game/reshuffle.test.ts.
 *
 * An ECHO Mark does NOT cost pristine-ness (specs/echo-marks.md): an echoed
 * Square records something the Player did on ANOTHER card — this card still
 * produced nothing of its own (no Tally entry, no Claim, no Proof), so trading
 * it away unwinds nothing. `computeMark` strips `echo` from any manually
 * toggled Square, so a real Mark can never ride under the exemption.
 */
export function isPristine(cells: Cell[]): boolean {
  return cells.every(
    (c) => c.free || !c.marked || (c.echo === true && c.proofId == null && c.status !== 'pending'),
  );
}

// --- Echo Marks (specs/echo-marks.md, #446) ---------------------------------
//
// When a Player's Mark on Prompt P reaches CONFIRMED, the same Prompt
// auto-marks (`echo: true`) on every other board of theirs that carries P and
// isn't already marked. Echoes are real Marks for scoring — the Player did the
// thing; the cards just agree. These pure helpers own the derivation; the write
// paths (src/data/api.ts, src/data/admin.ts) compose them into the existing
// batch/transaction patterns.
//
// NOTE on `isPristine` above: an echoed Square is exempt from the Reshuffle
// pristine check — it records something the Player did on ANOTHER card, so this
// card has still produced nothing of its own. The firestore.rules
// `boardPristine()` carries the same `echo == true` exemption.

/**
 * The Player's ACHIEVED set: every Prompt id with a CONFIRMED (non-pending)
 * Mark on any of the given boards' cells. The free centre carries no itemId and
 * is excluded by construction; a `status: 'pending'` Mark (an admin_confirmed
 * Claim awaiting resolution) is NOT achieved — only confirmed Marks echo.
 * Echoed cells count too: an echo IS a confirmed Mark, and including it keeps
 * the derivation stable no matter which board the achievement is read from
 * (`applyEchoes` is idempotent, so re-deriving from an echo changes nothing).
 */
export function achievedItemIds(boards: ReadonlyArray<readonly Cell[]>): Set<string> {
  const achieved = new Set<string>();
  for (const cells of boards) {
    for (const c of cells) {
      if (!c.free && c.marked && c.status !== 'pending' && c.itemId) achieved.add(c.itemId);
    }
  }
  return achieved;
}

/** What `applyEchoes` did to one board: the next cells plus the per-board
 *  deltas the ONE aggregated player write folds (specs/echo-marks.md). */
export interface EchoResult {
  /** The next cells — the ORIGINAL array reference when nothing echoed, so an
   *  unchanged board is byte-identical (the no-repeats regression contract). */
  cells: Cell[];
  changed: boolean;
  /** The Prompt ids this pass newly echoed (marked → true) on this board. */
  echoedItemIds: string[];
  /** This board's resulting stat bucket (the `DayStat` shape sans firstBingoAt,
   *  which needs prior-server context the caller owns — see `foldEchoStats`). */
  bingoCount: number;
  squaresMarked: number;
  blackout: boolean;
  /** Rising edges this pass crossed — routed into the existing pending-Moment
   *  queue by the caller, never broadcast directly from the echo path. */
  bingoTransition: boolean;
  blackoutTransition: boolean;
}

/**
 * Auto-mark every unmarked carrier of an achieved Prompt on ONE board. Pure and
 * IDEMPOTENT: an already-marked Square (echo, manual, or `pending` — the Player
 * has tapped it and a Claim may be riding on it) and an explicit Echo opt-out are
 * never touched, and a board carrying no achieved Prompt returns the original
 * array reference unchanged.
 * Echoed cells are born `confirmed` (the underlying achievement was already
 * confirmed once — in admin_confirmed mode they need no second admin pass).
 */
export function applyEchoes(cells: Cell[], achieved: ReadonlySet<string>, now: number): EchoResult {
  const echoedItemIds: string[] = [];
  const next = cells.map((c) => {
    if (c.free || c.marked || c.echoOptOut === true || !c.itemId || !achieved.has(c.itemId)) return c;
    echoedItemIds.push(c.itemId);
    return { ...c, marked: true, markedAt: now, status: 'confirmed' as const, echo: true };
  });
  const changed = echoedItemIds.length > 0;
  const resultCells = changed ? next : cells;
  const prevLines = changed ? completedLines(cells).length : 0;
  const lines = changed ? completedLines(resultCells).length : prevLines;
  const blackout = changed ? isBlackout(resultCells) : false;
  return {
    cells: resultCells,
    changed,
    echoedItemIds,
    bingoCount: changed ? lines : completedLines(cells).length,
    squaresMarked: changed ? countMarked(resultCells) : countMarked(cells),
    blackout: changed ? blackout : isBlackout(cells),
    bingoTransition: changed && prevLines === 0 && lines > 0,
    blackoutTransition: changed && blackout && !isBlackout(cells),
  };
}

/** One echoed board's contribution to the aggregated player write. */
export interface EchoBucket {
  dayIndex: number;
  bingoCount: number;
  squaresMarked: number;
  blackout: boolean;
  /** Optional cells-derived completion time of the Day's earliest line —
   *  used by `foldEchoStats` as the `firstBingoAt` stamp for a previously
   *  unstamped bingo BEFORE falling back to `now`. The server-derived stats
   *  reconcile (#491, Codex P2 on #495) supplies it so a delayed drain or a
   *  reload heal stamps the time the line actually completed, not the
   *  reconnect/open time; in-transaction callers omit it (their `now` IS the
   *  completion time). */
  bingoAt?: number;
}

/**
 * The completion time of the EARLIEST completed line on a board, derived from
 * the committed cells: each line completes when its LAST cell was marked
 * (`max(markedAt)`, the free centre contributing nothing), and the board's
 * first bingo is the minimum of those over all completed lines. Returns
 * undefined when no line is complete or when any cell of every complete line
 * lacks a usable `markedAt` (legacy data) — callers fall back to their clock.
 */
export function firstLineCompletionAt(cells: Cell[]): number | undefined {
  const byIndex = new Map<number, Cell>();
  for (const c of cells) byIndex.set(c.index, c);
  let earliest: number | undefined;
  for (const line of completedLines(cells)) {
    let latest: number | undefined;
    let known = true;
    for (const index of line) {
      const cell = byIndex.get(index);
      if (!cell || cell.free) continue;
      if (typeof cell.markedAt !== 'number') {
        known = false;
        break;
      }
      if (latest === undefined || cell.markedAt > latest) latest = cell.markedAt;
    }
    if (!known || latest === undefined) continue;
    if (earliest === undefined || latest < earliest) earliest = latest;
  }
  return earliest;
}

/**
 * Fold one or more echoed boards' buckets — plus, optionally, an acted-day
 * `foldDayStat` result to compose with (the mark-time path) — into the ONE
 * aggregated `{ merge: true }` player write (specs/echo-marks.md § Scoring).
 *
 * Per-Day `firstBingoAt` follows the same discipline as `foldDayStat`: an
 * echoed Day that HOLDS a bingo keeps its earlier stamp when it has one, else
 * stamps `now` (the echo completed this Day's first line); a Day left with no
 * bingo clears to null. The cruise-wide root `firstBingoAt` is re-derived over
 * the merged view — and OMITTED exactly when the composed `base` omitted it
 * (the #75 unknown-state preserve), so an echo fold can never clobber a server
 * stamp the acted-day fold deliberately left alone. Root `blackout` is true
 * when ANY board touched by this write completes (ticket: "blackout if any
 * board completes"); root sums/exclusions reuse `sumDayStats` /
 * `eventFirstBingoAt` so the tutorial and ceremonial rules hold unchanged.
 */
export function foldEchoStats(params: {
  priorDayStats: DayStats | undefined;
  echoes: ReadonlyArray<EchoBucket>;
  now: number;
  isTutorialDay?: (dayIndex: number) => boolean;
  isCeremonialDay?: (dayIndex: number) => boolean;
  /** The Player's PRIOR root `blackout`, preserved through the fold (Codex P2
   *  on #447): every echo path only ADDS Marks, so a blackout standing on an
   *  UNTOUCHED board must survive a write that folds only the touched boards —
   *  without this, a non-winning echo on Day B would strip a Day-A blackout
   *  from the roster filter. The root flag is a latch here; the paths that can
   *  legitimately remove a blackout (unmark, reject) run the base fold alone. */
  priorBlackout?: boolean;
  /** The acted-day `foldDayStat` result to compose with (mark-time). */
  base?: {
    dayStats: Record<number, StatWrite>;
    bingoCount: number;
    squaresMarked: number;
    blackout: boolean;
    firstBingoAt?: number | null;
  };
}): {
  dayStats: Record<number, StatWrite>;
  bingoCount: number;
  squaresMarked: number;
  blackout: boolean;
  firstBingoAt?: number | null;
} {
  const { priorDayStats, echoes, now, base } = params;
  const isTutorialDay = params.isTutorialDay ?? (() => false);
  const prior = priorDayStats ?? {};

  // The merged view every root derives from: prior buckets, overlaid by the
  // base (acted-day) bucket, overlaid by the echoed buckets. An omitted
  // per-day firstBingoAt resolves to the Day's prior stamp (the preserve case).
  const merged: DayStats = { ...prior };
  const outDayStats: Record<number, StatWrite> = {};
  for (const [key, bucket] of Object.entries(base?.dayStats ?? {})) {
    const dayIndex = Number(key);
    merged[dayIndex] = {
      bingoCount: bucket.bingoCount,
      squaresMarked: bucket.squaresMarked,
      firstBingoAt:
        'firstBingoAt' in bucket ? (bucket.firstBingoAt ?? null) : (prior[dayIndex]?.firstBingoAt ?? null),
    };
    outDayStats[dayIndex] = bucket;
  }
  for (const echo of echoes) {
    const firstBingoAt =
      // A previously unstamped bingo takes the bucket's cells-derived
      // completion time when supplied (#495 Codex P2: a delayed drain or a
      // reload heal must stamp when the line COMPLETED, not when the stats
      // reconcile ran), falling back to `now` for in-transaction callers.
      echo.bingoCount > 0 ? (prior[echo.dayIndex]?.firstBingoAt ?? echo.bingoAt ?? now) : null;
    merged[echo.dayIndex] = {
      bingoCount: echo.bingoCount,
      squaresMarked: echo.squaresMarked,
      firstBingoAt,
    };
    outDayStats[echo.dayIndex] = {
      bingoCount: echo.bingoCount,
      squaresMarked: echo.squaresMarked,
      firstBingoAt,
    };
  }

  const { bingoCount, squaresMarked } = sumDayStats(merged, params.isCeremonialDay);
  const blackout =
    (params.priorBlackout ?? false) || (base?.blackout ?? false) || echoes.some((e) => e.blackout);
  const out: {
    dayStats: Record<number, StatWrite>;
    bingoCount: number;
    squaresMarked: number;
    blackout: boolean;
    firstBingoAt?: number | null;
  } = { dayStats: outDayStats, bingoCount, squaresMarked, blackout };
  // Root firstBingoAt: omitted iff the composed base omitted it (the acted
  // day's prior stamp is UNKNOWN — writing a min over unknown state could
  // clobber the server's earlier value). With no base (deal/reconcile paths)
  // the prior view came from a real read, so the root always writes.
  if (!base || 'firstBingoAt' in base) {
    out.firstBingoAt = eventFirstBingoAt(merged, isTutorialDay);
  }
  return out;
}

export type Rankable = Pick<PlayerDoc, 'bingoCount' | 'squaresMarked' | 'firstBingoAt'>;

/** Leaderboard order: bingos desc, then squares desc, then earliest first-bingo; two no-bingo Players tie at exactly 0. */
export function comparePlayers(a: Rankable, b: Rankable): number {
  if (b.bingoCount !== a.bingoCount) return b.bingoCount - a.bingoCount;
  if (b.squaresMarked !== a.squaresMarked) return b.squaresMarked - a.squaresMarked;
  // Both no-bingo: an explicit stable 0. Without this guard the `?? Infinity`
  // fallback below computes Infinity - Infinity = NaN, and a NaN comparator
  // result gives Array.prototype.sort unspecified order for the pair (#93).
  if (a.firstBingoAt == null && b.firstBingoAt == null) return 0;
  const af = a.firstBingoAt ?? Number.POSITIVE_INFINITY;
  const bf = b.firstBingoAt ?? Number.POSITIVE_INFINITY;
  return af - bf;
}

export function sortPlayers<T extends Rankable>(players: T[]): T[] {
  return players.slice().sort(comparePlayers);
}

/**
 * The four states a Day Card can be in for a given Player, derived purely from
 * the DayDef schedule, the current clock, and whether the Player already has a
 * Board for that Day (daily-cards-spec § "Unlock mechanics"). This is the single
 * gate both the deal write path (`dealDayCard`) and the client (`useDayCard`)
 * read, so "when do we deal / what do we render" has one source of truth.
 *
 *   - `locked` — `now < unlockAt`: the Day is not open. Render the locked
 *     preview; never deal.
 *   - `waking` — unlocked, but `snapshotItemIds` is still ABSENT (null/undefined
 *     — scheduler lag). This mirrors the scheduler's own `isDueForSnapshot`
 *     (`snapshotItemIds == null`) EXACTLY, so a Day the scheduler stamped with an
 *     empty pool is never classed `waking` forever. Show the "waking up" wait
 *     state; NEVER deal from a live pool.
 *   - `ready` — unlocked and the Day Snapshot is stamped (present — possibly an
 *     empty `[]` for a Day with no eligible Prompts), no Board yet: deal. An empty
 *     stamped pool falls through to the deal path's thin-pool failure rather than
 *     waiting on a scheduler write that will never come.
 *   - `dealt` — the Player already has a Board for this Day: a no-op (re-opening
 *     an already-dealt Day never re-deals).
 */
export type DayDealState = 'locked' | 'waking' | 'ready' | 'dealt';

export function dayDealState(params: {
  unlockAt: number;
  snapshotItemIds?: string[];
  now: number;
  hasBoard: boolean;
}): DayDealState {
  if (params.hasBoard) return 'dealt';
  if (params.now < params.unlockAt) return 'locked';
  if (params.snapshotItemIds == null) return 'waking';
  return 'ready';
}

/**
 * A Day is due for the Admin console's manual "unlock now" fallback
 * (daily-cards-spec § "Unlock mechanics": "a manual admin 'unlock now' button
 * covers function failure") iff it has unlocked but the scheduler hasn't
 * stamped its Snapshot yet — the SCHEDULE-level twin of `dayDealState`'s
 * `waking` branch (same two conditions, `unlockAt <= now` and
 * `snapshotItemIds == null`), but without `dayDealState`'s per-PLAYER
 * `hasBoard` check: the Admin console has no single Player's board in view,
 * it's asking "does this Day need a forced snapshot at all." Mirrors the
 * scheduler's own `isDueForSnapshot` in `functions/src/unlockDay.ts` exactly,
 * so the button's visibility can never diverge from what the `unlockDayNow`
 * callable it drives would actually act on.
 */
export function dayDueForManualUnlock(day: { unlockAt: number; snapshotItemIds?: string[] }, now: number): boolean {
  return day.unlockAt <= now && day.snapshotItemIds == null;
}

// A Tally Card's Feed POSITION moves to the top at most once per this window,
// even as its COUNT keeps updating live (#216, daily-cards-spec § "Tally
// Cards"). Ten minutes: long enough that a hot square during a party hour can't
// churn the stream and bury photo proofs, short enough that genuine fresh
// activity still surfaces.
export const BUMP_DEBOUNCE_MS = 10 * 60 * 1000;

/**
 * The debounced Feed-position time for a Tally Card (#216). Pure and clock-free —
 * it compares the group's newest Mark against the position the card is ALREADY
 * displayed at, never `Date.now()`, so the interleave stays deterministic and
 * unit-testable. The displayed COUNT is derived separately and is unaffected by
 * this — only the sort key is debounced.
 *
 *  - No prior displayed bump (the card is appearing for the first time) → adopt
 *    `latestMarkedAt`: a brand-new card takes its natural place immediately.
 *  - `latestMarkedAt <= prevDisplayed` → hold `prevDisplayed`: no activity newer
 *    than what's shown (also monotonic-guards a backwards/again-same Mark clock).
 *  - A newer Mark WITHIN `windowMs` of the displayed bump → hold `prevDisplayed`:
 *    the count updates live but the card does NOT jump (the debounce).
 *  - A newer Mark `windowMs` or more after the displayed bump → adopt it: the
 *    card bumps toward the top.
 *
 * The result is monotonic non-decreasing across calls, so a card never slides
 * DOWN the Feed on a fresh Mark.
 */
export function nextDisplayBumpTime(
  prevDisplayed: number | undefined,
  latestMarkedAt: number,
  windowMs: number = BUMP_DEBOUNCE_MS,
): number {
  if (prevDisplayed === undefined) return latestMarkedAt;
  if (latestMarkedAt <= prevDisplayed) return prevDisplayed;
  if (latestMarkedAt - prevDisplayed < windowMs) return prevDisplayed;
  return latestMarkedAt;
}

// --- Cruise-wide scoring aggregation (daily-cards-spec § "Scoring and social
// surfaces", #212) -----------------------------------------------------------
//
// With ten Day Cards, a Player's `PlayerDoc.bingoCount`/`squaresMarked`/
// `firstBingoAt` root fields are no longer one Board's totals — they are
// cruise-wide aggregates over `PlayerDoc.dayStats`, one bucket per Day Card.
// These pure helpers own that derivation so the write path (`foldDayStat` in
// data/api.ts) and the read surfaces (Leaderboard) share ONE source of truth.
// The tie-break ORDER (`comparePlayers`) is unchanged — only its inputs are.

/** One Day Card's contribution to a Player's cruise totals. */
export type DayStat = { bingoCount: number; squaresMarked: number; firstBingoAt: number | null };
export type DayStats = Record<number, DayStat>;

/** The set of tutorial (embark/farewell) Day indexes from an Event's schedule.
 *  The cruise-wide First to BINGO honor excludes these Days (spec § "Resolved
 *  decisions" #2) — every other aggregate still counts them. */
export function tutorialDayIndexSet(days: readonly DayDef[] | undefined): Set<number> {
  const s = new Set<number>();
  for (const d of days ?? []) if (d.tutorial) s.add(d.index);
  return s;
}

/** The CEREMONIAL Day indexes — the farewell pool only (#265, spec § "Scoring"):
 *  "the farewell card is ceremonial—it unlocks at the freeze, so its marks never
 *  move the standings." Distinct from `tutorialDayIndexSet` because the embark
 *  card COUNTS (pre-freeze real play, just easy); only farewell is standings-
 *  inert. Its daily honor still stands — the exclusion applies to the summed
 *  root totals, never the per-Day bucket. */
export function ceremonialDayIndexSet(days: readonly DayDef[] | undefined): Set<number> {
  const s = new Set<number>();
  for (const d of days ?? []) if (d.pool === 'farewell') s.add(d.index);
  return s;
}

/**
 * Whether the standings are FROZEN (#265; Codex P2 on #278): the scheduler's
 * `frozenAt` stamp when present, OR — the stale-cache belt — the farewell
 * Day's scheduled `unlockAt` having passed. The freeze moment IS the farewell
 * unlock (daily-cards-spec § "Scoring": the two-beat finish), and the schedule
 * is cached with the event doc, so a client whose persistent cache predates
 * the scheduler's stamp (or is offline at sea) still fails CLOSED at 08:00 on
 * Day 10 by its own clock. Legacy events (no schedule) never freeze.
 */
export function standingsFrozen(
  event: Pick<EventDoc, 'frozenAt' | 'days'> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!event) return false;
  if (event.frozenAt != null) return true;
  for (const d of event.days ?? []) {
    if (d.pool === 'farewell' && now >= d.unlockAt) return true;
  }
  return false;
}

/** Sum `bingoCount` + `squaresMarked` across EVERY Day Card, tutorial Days
 *  included — the embark card is real pre-freeze play (spec § "Implementation
 *  notes": cruise-wide totals). `excludeDay` (#265) drops a Day's bucket from
 *  the SUM — the ceremonial farewell Day, whose marks never move the standings —
 *  while the bucket itself stays recorded (its daily honor still renders). */
export function sumDayStats(
  dayStats: DayStats | undefined,
  excludeDay?: (dayIndex: number) => boolean,
): {
  bingoCount: number;
  squaresMarked: number;
} {
  let bingoCount = 0;
  let squaresMarked = 0;
  for (const [key, stat] of Object.entries(dayStats ?? {})) {
    if (excludeDay?.(Number(key))) continue;
    bingoCount += stat.bingoCount;
    squaresMarked += stat.squaresMarked;
  }
  return { bingoCount, squaresMarked };
}

/** The #496 ROW-INTERNAL root-lag signal, shared by `runReconcileEchoes`'s
 *  heal predicate and Board's re-arm of its once-per-board reconcile guard
 *  (#506) so the two can never drift apart. A Player row whose per-Day buckets
 *  out-sum its root `bingoCount`/`squaresMarked` is self-inconsistent — the
 *  roots ARE `sumDayStats` over the row's own non-ceremonial buckets
 *  (`aggregatePlayerStats`) — so the lag is readable off a stale cache just as
 *  truthfully as off the server. One-directional PER FIELD (Codex P1 on #503):
 *  the heal rewrites BOTH roots from one merged view, so the bucket sum must
 *  DOMINATE every root and strictly exceed at least one; a row partial in one
 *  dimension and lagging in the other must never "heal" a root DOWNWARD.
 *
 *  #505 adds the THIRD root dimension the same fold rewrites: `firstBingoAt`,
 *  `comparePlayers`' third Leaderboard tie-break. Dominance for a timestamp
 *  runs the other way — EARLIER is more — so the bucket-derived earliest
 *  (`eventFirstBingoAt` over the row's own buckets, tutorial-excluded to
 *  mirror the fold's root derivation and ceremonial-excluded for the same
 *  #265 conservatism the sums carry) must be no LATER than the root's stamp.
 *  A root stamp that PREDATES every bucket's evidence is a legacy/hybrid row
 *  whose earlier honor the fold would overwrite with a later value — never a
 *  heal trigger; conversely a root stamp that is MISSING or LATER than the
 *  bucket evidence understates the row in the tie-break and now counts as
 *  lag on its own, even when both numeric roots already agree.
 *
 *  Callers gate on their own freeze state — post-freeze the reconcile never
 *  writes roots, so a root lag could not converge and re-checking is churn. */
export function playerRowRootLag(
  row:
    | Pick<Partial<PlayerDoc>, 'dayStats' | 'squaresMarked' | 'bingoCount' | 'firstBingoAt'>
    | null
    | undefined,
  isCeremonialDay?: (dayIndex: number) => boolean,
  isTutorialDay?: (dayIndex: number) => boolean,
): boolean {
  if (!row) return false;
  const bucketSum = sumDayStats(row.dayStats, isCeremonialDay);
  const rootSquares = row.squaresMarked ?? 0;
  const rootBingos = row.bingoCount ?? 0;
  const bucketFirst = eventFirstBingoAt(
    row.dayStats,
    (i: number) => (isTutorialDay?.(i) ?? false) || (isCeremonialDay?.(i) ?? false),
  );
  const rootFirst = row.firstBingoAt ?? null;
  const countsDominate =
    bucketSum.squaresMarked >= rootSquares && bucketSum.bingoCount >= rootBingos;
  // Timestamp dominance: the bucket evidence must be at least as EARLY as the
  // root. A stamp-less bucket view can never dominate a stamped root — that
  // root is legacy evidence the buckets cannot justify, and the fold would
  // regress it (#505).
  const firstDominates =
    bucketFirst == null ? rootFirst == null : rootFirst == null || bucketFirst <= rootFirst;
  const strictlyExceeds =
    bucketSum.squaresMarked > rootSquares ||
    bucketSum.bingoCount > rootBingos ||
    (bucketFirst != null && (rootFirst == null || bucketFirst < rootFirst));
  return countsDominate && firstDominates && strictlyExceeds;
}

/** The cruise-wide First to BINGO time: the earliest `firstBingoAt` across the
 *  MAIN-GAME Days only — tutorial Days are excluded even when their bingo is
 *  numerically earlier (the embark card is trivially easy and live before anyone
 *  boards, so it must never decide the headline honor). Returns `null` when no
 *  main-game Day carries a first bingo. */
export function eventFirstBingoAt(
  dayStats: DayStats | undefined,
  isTutorialDay: (dayIndex: number) => boolean,
): number | null {
  let earliest: number | null = null;
  for (const [key, stat] of Object.entries(dayStats ?? {})) {
    if (isTutorialDay(Number(key))) continue;
    if (stat.firstBingoAt == null) continue;
    if (earliest == null || stat.firstBingoAt < earliest) earliest = stat.firstBingoAt;
  }
  return earliest;
}

/** Derive a Player's cruise-wide root totals from their per-Day `dayStats`:
 *  bingos/squares summed over all Days, First to BINGO restricted to main-game
 *  Days. This is exactly the `PlayerDoc` root shape the Leaderboard ranks on. */
export function aggregatePlayerStats(
  dayStats: DayStats | undefined,
  isTutorialDay: (dayIndex: number) => boolean,
  isCeremonialDay?: (dayIndex: number) => boolean,
): DayStat {
  return {
    ...sumDayStats(dayStats, isCeremonialDay),
    firstBingoAt: eventFirstBingoAt(dayStats, isTutorialDay),
  };
}

/**
 * A Player's EFFECTIVE cruise First to BINGO for the Leaderboard pin: the
 * tutorial-excluded earliest over `dayStats` when the Player has any per-Day
 * breakdown, else the legacy root `firstBingoAt` (a pre-Phase-1.5 or
 * single-Board roster carries no `dayStats`, so its root value stands). This is
 * what makes the "1st BINGO" pin cruise-wide-restricted without regressing a
 * roster that predates Day Cards.
 */
export function effectiveCruiseFirstBingoAt(
  player: Pick<PlayerDoc, 'firstBingoAt' | 'dayStats'>,
  isTutorialDay: (dayIndex: number) => boolean,
): number | null {
  if (player.dayStats && Object.keys(player.dayStats).length > 0) {
    return eventFirstBingoAt(player.dayStats, isTutorialDay);
  }
  return player.firstBingoAt;
}

/** The uid of the cruise-wide First to BINGO holder across a roster — the
 *  earliest effective (tutorial-excluded) first bingo. `undefined` when nobody
 *  holds a qualifying main-game bingo. */
export function cruiseFirstBingoUid(
  players: readonly PlayerDoc[],
  isTutorialDay: (dayIndex: number) => boolean,
): string | undefined {
  let best: { uid: string; at: number } | undefined;
  for (const p of players) {
    const at = effectiveCruiseFirstBingoAt(p, isTutorialDay);
    if (at == null) continue;
    if (!best || at < best.at) best = { uid: p.uid, at };
  }
  return best?.uid;
}

/** A Player-write bucket: the day/root stats, with `firstBingoAt` OPTIONAL so a
 *  `{ merge: true }` write can OMIT it (the #75 unknown-state preserve). */
export type StatWrite = { bingoCount: number; squaresMarked: number; firstBingoAt?: number | null };

/**
 * Fold `computeMark`'s per-Board result (which IS one Day Card's stat bucket)
 * into a Player's `dayStats`, then re-derive the cruise-wide root totals — the
 * write-path composition the Mark path (`setMark`) commits. Returns a
 * `{ merge: true }`-friendly partial: `dayStats` carries ONLY the marked Day's
 * bucket (a nested merge preserves every other Day's entry on the server), plus
 * the summed root `bingoCount`/`squaresMarked` and the cruise-wide `firstBingoAt`.
 *
 * `firstBingoAt` is OMITTED — from BOTH the Day bucket and the root — exactly
 * when `computeMark` omitted it AND this Day has no prior stamp: the unknown-
 * local-state case (#75, a cache-miss Mark while a bingo already stood), so the
 * merge preserves whatever earlier stamp the server holds rather than writing a
 * value derived from unknown state. Every other case writes a concrete stamp.
 */
export function foldDayStat(params: {
  priorDayStats: DayStats | undefined;
  dayIndex: number;
  bucket: StatWrite;
  blackout: boolean;
  isTutorialDay?: (dayIndex: number) => boolean;
  // #265: ceremonial (farewell) Days are excluded from the summed root totals —
  // their bucket still writes (daily honors), but never moves the standings.
  isCeremonialDay?: (dayIndex: number) => boolean;
}): {
  dayStats: Record<number, StatWrite>;
  bingoCount: number;
  squaresMarked: number;
  blackout: boolean;
  firstBingoAt?: number | null;
} {
  const { priorDayStats, dayIndex, bucket, blackout } = params;
  const isTutorialDay = params.isTutorialDay ?? (() => false);
  const prior = priorDayStats ?? {};
  const priorBucket = prior[dayIndex];
  const omitFirst = !('firstBingoAt' in bucket);
  // Preserve only when the fold gave no value AND this Day holds no prior stamp
  // — otherwise there is a concrete value to write (the fold's, or the Day's own
  // earlier stamp on an unknown-while-standing further mark).
  const preserve = omitFirst && priorBucket?.firstBingoAt == null;
  const dayFirst = omitFirst ? (priorBucket?.firstBingoAt ?? null) : (bucket.firstBingoAt ?? null);

  const dayBucket: StatWrite = { bingoCount: bucket.bingoCount, squaresMarked: bucket.squaresMarked };
  if (!preserve) dayBucket.firstBingoAt = dayFirst;

  // The merged view for the SUM + earliest math (this Day resolved to dayFirst).
  const merged: DayStats = {
    ...prior,
    [dayIndex]: { bingoCount: bucket.bingoCount, squaresMarked: bucket.squaresMarked, firstBingoAt: dayFirst },
  };
  const { bingoCount, squaresMarked } = sumDayStats(merged, params.isCeremonialDay);

  const out: {
    dayStats: Record<number, StatWrite>;
    bingoCount: number;
    squaresMarked: number;
    blackout: boolean;
    firstBingoAt?: number | null;
  } = { dayStats: { [dayIndex]: dayBucket }, bingoCount, squaresMarked, blackout };
  if (!preserve) out.firstBingoAt = eventFirstBingoAt(merged, isTutorialDay);
  return out;
}

/** One Day's pinned First to BINGO honor, derived from the roster's `dayStats`. */
export interface DayHonor {
  dayIndex: number;
  uid: string;
  displayName: string;
  firstBingoAt: number;
}

/**
 * The per-Day First to BINGO honors strip: for each Day any Player has bingoed
 * on, the Player with the earliest `firstBingoAt` on that Day. Every Day gets
 * its own daily honor — tutorial Days included (their exclusion is ONLY from the
 * cruise-wide headline, not their own per-Day pin). Sorted by Day index.
 */
export function perDayHonors(players: readonly PlayerDoc[]): DayHonor[] {
  const best = new Map<number, DayHonor>();
  for (const p of players) {
    for (const [key, stat] of Object.entries(p.dayStats ?? {})) {
      if (stat.firstBingoAt == null) continue;
      const dayIndex = Number(key);
      const cur = best.get(dayIndex);
      if (!cur || stat.firstBingoAt < cur.firstBingoAt) {
        best.set(dayIndex, {
          dayIndex,
          uid: p.uid,
          displayName: p.displayName,
          firstBingoAt: stat.firstBingoAt,
        });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.dayIndex - b.dayIndex);
}
