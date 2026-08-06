// specs/motion-polish.md — the slot-machine animation pass.
//
// Three layers, matching the spec's "Test coverage" section:
//   1. The pure timing helpers (src/game/motion.ts): delay bounds/ordering,
//      payline order, and a deterministic confetti burst (injected random).
//   2. Celebration's DOM contract: hero word intact for AT + e2e text
//      locators, letters aria-hidden and indexed, confetti themed and gated
//      on prefers-reduced-motion.
//   3. index.css structural contract: the keyframes exist, the reduced-motion
//      kill switch exists and carries its two substitutes, and the deliberate
//      exclusions (locked grid) hold.
// Visual behavior itself is not assertable in jsdom (no layout/animation
// engine); these pin the structure the CSS keys off.
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';

// ---- Celebration's collaborator mocks (the w2-share-cards.test.tsx shapes:
// this suite renders Celebration only for its motion DOM, so the share-card
// renderer resolves inertly and the event doc is absent). ----
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track }));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../hooks/useData', () => ({
  useEventDoc: () => ({ data: null, loading: false }),
}));
vi.mock('./ShareCard', () => ({
  shareCardAppName: () => 'Gay Cruise Bingo',
  renderBingoShareCard: vi.fn(() => Promise.resolve(new Blob(['x'], { type: 'image/png' }))),
  shareCardBlob: vi.fn(() => Promise.resolve('shared')),
}));

import Celebration from './Celebration';
import {
  CONFETTI_COLORS,
  CONFETTI_COUNT_BINGO,
  CONFETTI_COUNT_BLACKOUT,
  confettiPieces,
  DEAL_COLUMN_STAGGER_MS,
  DEAL_ROW_STAGGER_MS,
  dealDelayMs,
  winOrder,
} from '../game/motion';
import type { Cell } from '../types';

// CWD-relative, the same way w4-bug-report-inbox.test.tsx reads it (Vitest
// rewrites import.meta.url to a non-file scheme under jsdom).
const indexCss = readFileSync('src/index.css', 'utf8');

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

/** Stub window.matchMedia to report the given reduced-motion preference —
 * jsdom ships no matchMedia, so absence is also a covered path (falls open
 * to "animate"). */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Pure timing helpers
// ---------------------------------------------------------------------------

describe('dealDelayMs — the reel cascade (specs/motion-polish.md)', () => {
  it('staggers by column first, row second — the reels settle left to right', () => {
    expect(dealDelayMs(0)).toBe(0);
    // One column right = one column step.
    expect(dealDelayMs(1)).toBe(DEAL_COLUMN_STAGGER_MS);
    // One row down = one row step.
    expect(dealDelayMs(5)).toBe(DEAL_ROW_STAGGER_MS);
    // Bottom-right lands last.
    const last = dealDelayMs(24);
    for (let i = 0; i < 24; i++) expect(dealDelayMs(i)).toBeLessThanOrEqual(last);
    expect(last).toBe(4 * DEAL_COLUMN_STAGGER_MS + 4 * DEAL_ROW_STAGGER_MS);
  });

  it('bounds the whole cascade under the spec ceiling and clamps bad input', () => {
    for (let i = 0; i < 25; i++) expect(dealDelayMs(i)).toBeLessThan(700);
    // Malformed indexes clamp into the grid rather than minting runaway delays.
    expect(dealDelayMs(-3)).toBe(0);
    expect(dealDelayMs(400)).toBe(dealDelayMs(24));
    expect(dealDelayMs(Number.NaN)).toBe(0);
  });
});

describe('winOrder — the payline sweep order', () => {
  it('maps each winning cell to its ascending position along its own line', () => {
    const order = winOrder([[10, 11, 12, 13, 14]]);
    expect(order.get(10)).toBe(0);
    expect(order.get(12)).toBe(2);
    expect(order.get(14)).toBe(4);
    expect(order.has(3)).toBe(false);
  });

  it('sweeps intersecting lines independently — shared cells take the earliest position', () => {
    // The middle row and middle column both stand; they share the free
    // center (12), which is position 2 on both lines.
    const order = winOrder([
      [10, 11, 12, 13, 14],
      [2, 7, 12, 17, 22],
    ]);
    expect(order.get(10)).toBe(0);
    expect(order.get(2)).toBe(0); // the second line starts its own sweep at 0
    expect(order.get(12)).toBe(2);
    expect(order.get(22)).toBe(4);
  });

  it('caps every position at 4 no matter how many lines stand (Codex P2 #421: blackout)', () => {
    // All 12 lines of a blacked-out card.
    const lines: number[][] = [];
    for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
    for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
    lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
    const order = winOrder(lines);
    expect(order.size).toBe(25);
    for (const position of order.values()) expect(position).toBeLessThanOrEqual(4);
  });

  it('is empty for no win', () => {
    expect(winOrder([]).size).toBe(0);
  });
});

describe('confettiPieces — deterministic, bounded, theme-tokened', () => {
  it('produces the requested count with bounded geometry (injected random)', () => {
    let n = 0;
    const random = () => {
      // A deterministic pseudo-sequence walking [0, 1).
      n = (n + 0.137) % 1;
      return n;
    };
    const pieces = confettiPieces(CONFETTI_COUNT_BINGO, random);
    expect(pieces).toHaveLength(CONFETTI_COUNT_BINGO);
    for (const p of pieces) {
      expect(p.leftPct).toBeGreaterThanOrEqual(0);
      expect(p.leftPct).toBeLessThanOrEqual(100);
      expect(p.delayMs).toBeGreaterThanOrEqual(0);
      expect(p.delayMs).toBeLessThanOrEqual(500);
      expect(p.durationMs).toBeGreaterThanOrEqual(2200);
      expect(p.durationMs).toBeLessThanOrEqual(3800);
      expect(Math.abs(p.driftPx)).toBeLessThanOrEqual(140);
      expect(Math.abs(p.spinDeg)).toBeLessThanOrEqual(900);
      expect(p.sizePx).toBeGreaterThanOrEqual(6);
      expect(p.sizePx).toBeLessThanOrEqual(11);
    }
  });

  it('colors only ever come from theme tokens — never literals', () => {
    const pieces = confettiPieces(CONFETTI_COUNT_BLACKOUT);
    const tokens = new Set<string>(CONFETTI_COLORS);
    for (const p of pieces) {
      expect(tokens.has(p.color)).toBe(true);
      expect(p.color).toMatch(/^var\(--/);
    }
    // The cycle uses the whole palette.
    expect(new Set(pieces.map((p) => p.color)).size).toBe(CONFETTI_COLORS.length);
  });

  it('blackout rains harder than bingo', () => {
    expect(CONFETTI_COUNT_BLACKOUT).toBeGreaterThan(CONFETTI_COUNT_BINGO);
  });
});

// ---------------------------------------------------------------------------
// 2. Celebration's motion DOM
// ---------------------------------------------------------------------------

describe('Celebration — jackpot DOM contract (specs/motion-polish.md)', () => {
  it('keeps the intact hero word for AT and e2e text locators while animating letters', () => {
    render(
      <Celebration kind="bingo" cells={makeCells([0, 1])} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    const big = document.querySelector('.big');
    expect(big).not.toBeNull();
    // The e2e `.big { hasText: 'BINGO!' }` locators key on text content.
    expect(big!.textContent).toContain('BINGO!');
    // Screen readers hear the word once (visually-hidden), never the letters.
    const hidden = big!.querySelector('.visually-hidden');
    expect(hidden).not.toBeNull();
    expect(hidden!.textContent).toBe('BINGO!');
    const letterWrap = big!.querySelector('[aria-hidden="true"]');
    expect(letterWrap).not.toBeNull();
    const letters = letterWrap!.querySelectorAll('.big-letter');
    expect(letters).toHaveLength('BINGO!'.length);
    // Each letter carries its slam-stagger index for the CSS delay.
    expect((letters[0] as HTMLElement).style.getPropertyValue('--letter-i')).toBe('0');
    expect((letters[5] as HTMLElement).style.getPropertyValue('--letter-i')).toBe('5');
  });

  it('spells the blackout hero the same way', () => {
    render(
      <Celebration kind="blackout" cells={makeCells()} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    const big = document.querySelector('.big');
    expect(big!.textContent).toContain('BLACKOUT');
    expect(big!.querySelectorAll('.big-letter')).toHaveLength('BLACKOUT'.length);
  });

  it('rains theme-tokened confetti by default (no matchMedia at all falls open)', () => {
    render(
      <Celebration kind="bingo" cells={makeCells()} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    const confetti = document.querySelector('.confetti');
    expect(confetti).not.toBeNull();
    expect(confetti!.getAttribute('aria-hidden')).toBe('true');
    const pieces = confetti!.querySelectorAll('i');
    expect(pieces).toHaveLength(CONFETTI_COUNT_BINGO);
    expect((pieces[0] as HTMLElement).style.getPropertyValue('--confetti-c')).toMatch(/^var\(--/);
  });

  it('rains harder for a blackout', () => {
    render(
      <Celebration kind="blackout" cells={makeCells()} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    expect(document.querySelectorAll('.confetti i')).toHaveLength(CONFETTI_COUNT_BLACKOUT);
  });

  it('skips the confetti layer entirely under prefers-reduced-motion', () => {
    stubReducedMotion(true);
    render(
      <Celebration kind="bingo" cells={makeCells()} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    expect(document.querySelector('.confetti')).toBeNull();
    // The rest of the celebration still renders.
    expect(document.querySelector('.big')!.textContent).toContain('BINGO!');
  });

  it('renders confetti when the preference is explicitly no-preference', () => {
    stubReducedMotion(false);
    render(
      <Celebration kind="bingo" cells={makeCells()} playerName="Deck Daddy" onClose={vi.fn()} />,
    );
    expect(document.querySelector('.confetti')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. index.css structural contract
// ---------------------------------------------------------------------------

describe('index.css — motion section structure (specs/motion-polish.md)', () => {
  it('defines the motion vocabulary keyframes', () => {
    for (const name of [
      'deal-drop',
      'cell-stamp',
      'check-pop',
      'win-glow',
      'letter-slam',
      'confetti-fall',
      'sheet-up',
      'backdrop-in',
      'toast-in',
      'row-in',
      'page-in',
      'stat-pop',
      'tab-hop',
    ]) {
      expect(indexCss).toMatch(new RegExp(`@keyframes ${name}\\b`));
    }
  });

  it('defines the two shared easings on :root', () => {
    expect(indexCss).toMatch(/--ease-pop:\s*cubic-bezier/);
    expect(indexCss).toMatch(/--ease-glide:\s*cubic-bezier/);
  });

  it('keeps the page transition transform-free (fixed-overlay anchoring)', () => {
    // Codex P2 #421 round 3: a transform on .route-view makes it the
    // containing block for position:fixed overlays that mount WITH the page
    // (coach overlay, admin sheet), mis-anchoring them for the entrance.
    const pageIn = indexCss.match(/@keyframes page-in\s*\{[\s\S]*?\n\}/);
    expect(pageIn).not.toBeNull();
    expect(pageIn![0]).not.toMatch(/transform/);
  });

  it('gates the header cascade on the same once-per-board contract as the grid', () => {
    // Codex P3 #421 round 3: Board keys/gates .bingo-head like the grid; the
    // -dealt reset must exist and sit after the header cascade rules it ties.
    const headerResetAt = indexCss.search(/\.bingo-head-dealt\s+span\s*\{[^}]*animation:\s*none/);
    const headerCascadeAt = indexCss.search(/\.bingo-head\s+span\s*\{[^}]*deal-drop/);
    expect(headerResetAt).toBeGreaterThan(-1);
    expect(headerCascadeAt).toBeGreaterThan(-1);
    expect(headerResetAt).toBeGreaterThan(headerCascadeAt);
  });

  it('excludes the locked preview grid from the deal cascade, at bare-cell specificity', () => {
    // `:where()` is load-bearing (not just style): without it this rule
    // weighs (0,3,0) and permanently out-cascades the `.cell.win` payline
    // and `.cell.just-marked` stamp animations.
    expect(indexCss).toMatch(/:where\(\.grid:not\(\.locked-grid\)\)\s*>\s*\.cell/);
  });

  it('mounts an already-dealt card landed — .grid-dealt zeroes the entrance at bare-cell weight', () => {
    // Codex P2 #421 (rounds 1-2): the router remounts Board per tab switch,
    // so the session gate needs a CSS off-switch — and that off-switch must
    // lose to EVERY stateful animation. `:where()` is load-bearing: it pins
    // the reset at (0,1,0), under `.cell.win` / `.cell.just-marked` / the
    // free pulses (all (0,2,0)+) wherever they sit in the file, while source
    // order alone lets it beat the equally-weighted deal rule above it. A
    // bare `.grid-dealt > .cell` silenced a standing win's shimmer after a
    // tab round-trip because it out-ordered the early `.cell.win` rule.
    const dealtAt = indexCss.search(/:where\(\.grid-dealt\)\s*>\s*\.cell\s*\{[^}]*animation:\s*none/);
    const dealRuleAt = indexCss.search(/:where\(\.grid:not\(\.locked-grid\)\)\s*>\s*\.cell/);
    expect(dealtAt).toBeGreaterThan(-1);
    expect(dealRuleAt).toBeGreaterThan(-1);
    // Same specificity as the deal rule — source order is what beats it.
    expect(dealtAt).toBeGreaterThan(dealRuleAt);
  });

  it('never animates the off-screen share-card DOM', () => {
    // Every animation/transition declaration in the share-card section would
    // rasterize mid-frame; pin that none of the share-card selectors carry
    // one. Comments are stripped first — prose ABOUT `.share-card` (the
    // motion section's own exclusion note) must not read as a rule.
    const uncommented = indexCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const shareCardRules = uncommented.match(/\.share-card[^{}]*\{[^}]*\}/g) ?? [];
    expect(shareCardRules.length).toBeGreaterThan(0);
    for (const rule of shareCardRules) {
      expect(rule).not.toMatch(/animation|transition/);
    }
  });

  it('carries the universal reduced-motion kill switch with its substitutes', () => {
    const killSwitchAt = indexCss.indexOf('reduced motion: the kill switch');
    expect(killSwitchAt).toBeGreaterThan(-1);
    const killSwitch = indexCss.slice(killSwitchAt);
    expect(killSwitch).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // The universal clamp — durations to a frame, delays zeroed, no infinite loops.
    expect(killSwitch).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(killSwitch).toMatch(/animation-delay:\s*0ms\s*!important/);
    expect(killSwitch).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(killSwitch).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    // The two stillness substitutes: a static win ring, no confetti.
    expect(killSwitch).toMatch(/\.cell\.win\s*\{[^}]*box-shadow/);
    expect(killSwitch).toMatch(/\.confetti\s*\{[^}]*display:\s*none/);
  });
});
