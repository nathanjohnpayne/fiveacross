import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #559, Codex P2, PR #845 round 10 — the "new from the group" ring
// (`.cell.community`) must compose with every OTHER Square state, never
// silently replace or be replaced by one. jsdom applies no stylesheets, so a
// rendered assertion can't see index.css — pinned at the CSS source level
// instead, same approach as d15-square-scale.test.ts's font-size pin and
// og-theme-parity's palette pin.
//
// The specific failure this guards: `.cell.marked` and `.cell.community`
// share equal (0,2,0) specificity, so whichever is declared LATER in the
// file wins `box-shadow` OUTRIGHT for an element carrying both classes —
// there is no cascade "merging" across two separate rules for the same
// property. Composition only happens where a THIRD, combined selector
// explicitly layers both shadows as comma-separated values. The stamp
// animation (`cell-stamp`) has the same problem one layer deeper: a keyframe
// declaration replaces the box-shadow for its own duration regardless of
// selector specificity or source order, so it needs its own composed value
// via a custom property rather than a second static rule.

const css = readFileSync('src/index.css', 'utf8');

/** Every declaration block in index.css, keyed by its (normalized) selector. */
function blocksBySelector(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
    out.set(selector, (out.get(selector) ?? '') + m[2]);
  }
  return out;
}

describe('the community ring composes with every Square state (#559, Codex P2, PR #845 round 10)', () => {
  const bySelector = blocksBySelector();

  it('a marked Community Prompt keeps BOTH the marked glow and the community ring, via a combined selector', () => {
    const block = bySelector.get('.cell.marked.community');
    expect(block, '.cell.marked.community rule is missing').toBeDefined();
    expect(block).toMatch(/box-shadow:\s*[^;]*inset[^;]*var\(--accent\)/);
    expect(block).toMatch(/box-shadow:\s*[^;]*0 0 14px var\(--shadow\)/s);
  });

  it('a winning Community Prompt keeps BOTH the win ring and the community ring under reduced motion (pre-existing, round 6 — regression guard)', () => {
    const block = bySelector.get('.cell.win.community');
    expect(block, '.cell.win.community rule is missing').toBeDefined();
    expect(block).toMatch(/box-shadow:\s*[^;]*inset[^;]*var\(--accent\)/);
    expect(block).toMatch(/box-shadow:\s*[^;]*0 0 0 2px var\(--accent\)/s);
  });

  it('the stamp animation keeps the community ring visible through a custom property override, not a second static rule', () => {
    const base = bySelector.get('.cell.just-marked');
    expect(base, '.cell.just-marked rule is missing').toBeDefined();
    expect(base).toMatch(/--cell-stamp-shadow:\s*0 0 26px var\(--shadow\)/);

    const communityOverride = bySelector.get('.cell.community.just-marked');
    expect(communityOverride, '.cell.community.just-marked override rule is missing').toBeDefined();
    expect(communityOverride).toMatch(/--cell-stamp-shadow:\s*[^;]*inset[^;]*var\(--accent\)/s);
    expect(communityOverride).toMatch(/--cell-stamp-shadow:\s*[^;]*0 0 26px var\(--shadow\)/s);

    // The keyframe itself reads the custom property rather than a literal
    // value, so it renders whichever of the two rules above actually applied
    // to the animating element.
    const keyframeMatch = css.match(/@keyframes cell-stamp\s*\{([\s\S]*?)\n\}/);
    expect(keyframeMatch, '@keyframes cell-stamp is missing').not.toBeNull();
    expect(keyframeMatch![1]).toMatch(/box-shadow:\s*var\(--cell-stamp-shadow\)/);
  });
});
