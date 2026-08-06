import { describe, it, expect } from 'vitest';
import { EVENT_SEED } from '../../scripts/seed-data/med-2026.mjs';
import { TABS } from '../components/tabs';

// Asserts specs/x-launch-checklist.md: the launch runbook is a manual,
// human-run document with no runtime surface of its own, but it quotes real
// app-contract facts by name — the seeded sail window (the embarkation date
// the whole runbook is scheduled against) and the exact tab Nav the
// device-matrix / one-handed-reachability sections walk through: every tab
// id, label, AND route path (the URLs the runbook prints), plus the
// admin-only gating. Pinning all of them here means a future change to any
// one silently breaks THIS test instead of leaving the runbook describing a
// stale date, a renamed tab, or a dead URL.

describe('x-launch-checklist: seeded sail window (embarkation 2026-07-15)', () => {
  it('seeds the sailing as 2026-07-15 through 2026-07-24 — the exact window the runbook is scheduled against', () => {
    expect(EVENT_SEED.sailStart).toBe('2026-07-15');
    expect(EVENT_SEED.sailEnd).toBe('2026-07-24');
  });
});

describe('x-launch-checklist: one-handed reachability tab Nav contract', () => {
  it('documents exactly the tabs the runbook walks through, in the order the reachability check taps them', () => {
    // Phase 1.5 (#203, specs/d15-tab-contract.md): Prompts and Admin left the
    // bar and mount inside More, so the set is Card · Feed · Ranks · More.
    expect(TABS.map((t) => t.id)).toEqual(['card', 'feed', 'ranks', 'more']);
    expect(TABS.map((t) => t.label)).toEqual(['Card', 'Feed', 'Ranks', 'More']);
  });

  it('pins the exact route paths the runbook quotes by URL, so a later route rename (e.g. /leaderboard → /ranks) breaks this test instead of stranding a dead URL in the doc', () => {
    expect(TABS.map((t) => t.path)).toEqual(['/', '/feed', '/leaderboard', '/more']);
  });

  it('exposes all four tabs universally — admin is now an in-menu concern inside More, not a tab-level gate', () => {
    expect(TABS.length).toBe(4);
  });
});
