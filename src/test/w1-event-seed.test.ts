import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adminRoster,
  eventWritePayload,
  effectiveSeedSchedule,
  formatDriftReport,
  orphanedSnapshotDays,
  reseedGuard,
  reseedPlan,
  seedEntryTimestamp,
  seedItemDocId,
  seedItemMutations,
  stampedDayIndexes,
  verifySeedPool,
} from '../../scripts/seed.mjs';
import { EVENT_SEED, ITEMS, ALL_ITEMS } from '../../scripts/seed-data/med-2026.mjs';

type SeedItem = { text: string; spicy: boolean };
type LiveDoc = {
  id: string;
  text: string;
  createdBy: string;
  spicy: boolean;
  isFreeSpace: boolean;
  status: string;
  reportCount: number;
  pool: string;
};

// Build the live `events/{id}/items` shape a correct, in-sync seed run leaves
// behind: every canonical prompt as a seed-owned doc with the content-hash id.
// Seed docs carry `pool: 'main'` (the stamp in `seedItemMutations`).
function liveFromCanonical(pool: SeedItem[] = ITEMS as SeedItem[]): LiveDoc[] {
  return pool.map(({ text, spicy }) => ({
    id: seedItemDocId(text),
    text,
    createdBy: 'seed',
    spicy,
    isFreeSpace: false,
    status: 'active',
    reportCount: 0,
    pool: 'main',
  }));
}

// Vitest runs with cwd at the repo root; jsdom's import.meta.url is not a file: URL.
// The seed "source" is the script plus the per-Event payload module (#563) —
// the source-convention checks below must hold across both.
const seedSource =
  readFileSync(resolve(process.cwd(), 'scripts/seed.mjs'), 'utf8') +
  readFileSync(resolve(process.cwd(), 'scripts/seed-data/med-2026.mjs'), 'utf8');

describe('w1-event-seed: seeded settings (ADR 0004)', () => {
  it('seeds settings.reportHideThreshold at the load-bearing value 4', () => {
    expect(EVENT_SEED.settings.reportHideThreshold).toBe(4);
  });

  it('seeds no blackoutEnabled — ADR 0004 removed it as dead config', () => {
    expect(EVENT_SEED.settings).not.toHaveProperty('blackoutEnabled');
    // Exact shape: reportHideThreshold and spicyRatio (w1-seed-and-composition)
    // are the only settings keys the static seed payload carries.
    expect(Object.keys(EVENT_SEED.settings)).toEqual(['reportHideThreshold', 'spicyRatio']);
  });

  it('marks settings.blackoutEnabled for deletion in the merge write, so re-seeding an Event doc from the previous seed actually removes the stale field', () => {
    // A `{ merge: true }` write only touches leaf paths present in the payload, so a
    // pre-existing `settings.blackoutEnabled` from the old seed would otherwise survive a
    // reseed untouched. `eventWritePayload` takes the delete sentinel as a parameter
    // (rather than importing firebase-admin) so it stays import-safe without the dev-only
    // install — stand in a fake sentinel here and assert it passes through untouched.
    const deleteSentinel = Symbol('FieldValue.delete()');
    const payload = eventWritePayload(EVENT_SEED, [], deleteSentinel);
    expect(payload.settings).toEqual({
      reportHideThreshold: 4,
      spicyRatio: 0.4,
      blackoutEnabled: deleteSentinel,
    });
  });

  it('never seeds a literal value for blackoutEnabled — the seed source references it only as the delete target', () => {
    expect(seedSource).not.toMatch(/blackoutEnabled:\s*(true|false)/);
  });

  it('does NOT write bannedUids — a reseed must never clobber a live ban list (#113)', () => {
    // The event write is { merge: true } and the seed is safe to re-run, so writing
    // bannedUids here would reset a populated ban roster (#108) back to [] on every
    // reseed — silent data loss. It is deliberately absent from both the static seed
    // payload and the merge write; a fresh event reads [] via eventConverter's
    // missing-field default instead (asserted in src/data/w0-type-contract.test.ts).
    expect(EVENT_SEED).not.toHaveProperty('bannedUids');
    expect(eventWritePayload(EVENT_SEED, [])).not.toHaveProperty('bannedUids');
    expect(eventWritePayload(EVENT_SEED, ['nathan-seed-uid'])).not.toHaveProperty('bannedUids');
  });
});

describe('w1-event-seed: claim mode (ADR 0001)', () => {
  it("seeds claimMode 'honor' (the default)", () => {
    expect(EVENT_SEED.claimMode).toBe('honor');
  });

  it('documents the mode set as honor | proof_required | admin_confirmed, never the pre-rename name', () => {
    expect(seedSource).toContain("'honor' | 'proof_required' | 'admin_confirmed'");
    expect(seedSource).not.toMatch(/verified/);
  });
});

describe('w1-event-seed: ADMIN_UID roster flow (#15)', () => {
  it('parses ADMIN_UID as a comma-separated roster, trimming entries and dropping empties', () => {
    expect(adminRoster()).toEqual([]);
    expect(adminRoster('')).toEqual([]);
    expect(adminRoster('nathan-seed-uid')).toEqual(['nathan-seed-uid']);
    expect(adminRoster(' nathan-seed-uid , coadmin-1,coadmin-2 ,')).toEqual([
      'nathan-seed-uid',
      'coadmin-1',
      'coadmin-2',
    ]);
  });

  it('writes the roster to events/{id}.admins when set (2–4 Admins incl. the seed uid)', () => {
    const roster = ['nathan-seed-uid', 'coadmin-1', 'coadmin-2'];
    expect(eventWritePayload(EVENT_SEED, roster).admins).toEqual(roster);
  });

  it('omits admins entirely when the roster is empty, so a merge re-run never wipes it', () => {
    expect(eventWritePayload(EVENT_SEED, [])).not.toHaveProperty('admins');
  });
});

describe('w1-event-seed: reseedGuard — a rerun can never double-seed or casually rewrite a live pool', () => {
  it('always allows seeding a FRESH event (zero seed-owned docs)', () => {
    expect(reseedGuard(0, undefined)).toEqual({ allowed: true });
    expect(reseedGuard(0, '1')).toEqual({ allowed: true });
  });

  it('hard-refuses a rerun against an already-seeded event without RESEED=1', () => {
    // Replace semantics can never APPEND (no duplicates), but a replace still
    // rewrites every seed-owned doc at current content-hash ids — which would
    // orphan a live Event's pre-stamped Day snapshots (the in-place-edited
    // Bodega pool). Refusal is the default; the reason names the opt-in.
    const verdict = reseedGuard(120, undefined);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('RESEED=1');
    expect(reseedGuard(1, '0').allowed).toBe(false);
    expect(reseedGuard(1, 'yes').allowed).toBe(false);
  });

  it('allows a deliberate replace with RESEED=1', () => {
    expect(reseedGuard(120, '1')).toEqual({ allowed: true });
  });

  it('fails rather than silently skipping a requested schedule rewrite when the matching pool replace is refused', () => {
    expect(reseedPlan(120, undefined, false)).toMatchObject({ action: 'metadata-only' });
    expect(reseedPlan(120, undefined, true)).toMatchObject({
      action: 'refuse',
      reason: expect.stringContaining('SEED_DAYS=1'),
    });
    expect(reseedPlan(120, '1', true)).toEqual({ action: 'replace' });
  });
});

describe('w1-event-seed: orphanedSnapshotDays — a replace may not strand a stamped Day snapshot (Codex P1, PR #644 round 2)', () => {
  const days = [
    { index: 0, snapshotItemIds: ['seed-a', 'seed-b'] },
    { index: 1 }, // unstamped — never orphanable
    { index: 2, snapshotItemIds: ['seed-c', 'player-x'] },
  ];

  it('flags Days whose snapshot references ids the replace deletes without rewriting', () => {
    // seed-a is deleted and NOT re-written (a text edit moved its hash);
    // seed-b/seed-c survive at the same id.
    expect(orphanedSnapshotDays(days, ['seed-a', 'seed-b', 'seed-c'], ['seed-b', 'seed-c', 'seed-new'])).toEqual([0]);
  });

  it('passes when every referenced deleted id is re-written at the same id (unchanged texts)', () => {
    expect(orphanedSnapshotDays(days, ['seed-a', 'seed-b', 'seed-c'], ['seed-a', 'seed-b', 'seed-c'])).toEqual([]);
  });

  it('ignores snapshot ids outside the delete set — player docs and already-gone ids are not this replace\'s doing', () => {
    // player-x is not seed-owned; its absence from the writes is irrelevant.
    expect(orphanedSnapshotDays(days, ['seed-c'], ['seed-c'])).toEqual([]);
  });

  it('handles a missing/malformed days array as nothing to orphan', () => {
    expect(orphanedSnapshotDays(undefined, ['a'], [])).toEqual([]);
    expect(orphanedSnapshotDays('bogus', ['a'], [])).toEqual([]);
  });
});

describe('w1-event-seed: reseed snapshot and timestamp interlocks (Codex P1, PR #644 round 4)', () => {
  it('identifies every existing frozen Day before a script-level days[] overwrite', () => {
    expect(
      stampedDayIndexes([
        { index: 0, snapshotItemIds: ['a'] },
        { index: 1 },
        { index: 2, snapshotItemIds: [] },
      ]),
    ).toEqual([0, 2]);
    expect(stampedDayIndexes(undefined)).toEqual([]);
  });

  it('preserves a matching seed prompt timestamp when it is already safe and backdates replacement ids', () => {
    const existing = [
      { id: seedItemDocId('Survives'), createdBy: 'seed', createdAt: 100 },
      { id: 'renamed-away', createdBy: 'seed', createdAt: 120 },
    ];
    expect(seedEntryTimestamp(existing, [{ unlockAt: 200 }], 1_000)).toBe(100);
    const { writes } = seedItemMutations(
      existing,
      1_000,
      [
        { text: 'Survives', spicy: false },
        { text: 'New text', spicy: false },
      ],
      100,
    );
    expect(writes.map((write) => write.data.createdAt)).toEqual([100, 100]);
  });

  it('clamps a matching prompt written after a due Day cutoff to the safe seed time', () => {
    const existing = [{ id: seedItemDocId('Survives'), createdBy: 'seed', createdAt: 900 }];
    const { writes } = seedItemMutations(existing, 1_000, [{ text: 'Survives', spicy: false }], 200);
    expect(writes).toEqual([
      expect.objectContaining({ id: seedItemDocId('Survives'), data: expect.objectContaining({ createdAt: 200 }) }),
    ]);
  });

  it('uses an already-due unlock for a brand-new delayed seed so the scheduler does not stamp an empty pool', () => {
    expect(seedEntryTimestamp([], [{ unlockAt: 0 }, { unlockAt: 200 }, { unlockAt: 2_000 }], 1_000)).toBe(
      200,
    );
  });

  it('timestamps a fresh seed from the schedule it is about to install', () => {
    const futureExistingSchedule = [{ unlockAt: 2_000 }];
    const effective = effectiveSeedSchedule(
      futureExistingSchedule,
      [{ unlockAt: 200 }],
      true,
    );
    expect(seedEntryTimestamp([], effective, 1_000)).toBe(200);
  });
});

describe('w1-event-seed: prompt pool density (ADR 0003)', () => {
  it('seeds at least 24 prompts so dealBoard always has a full sample', () => {
    expect(ITEMS.length).toBeGreaterThanOrEqual(24);
  });

  // w1-seed-and-composition (#129, refreshed #187) supersedes ADR 0003's original
  // ~30-50 "dense" band with a canonical 80-entry pool (24 spicy / 56 tame) — a
  // deliberate, ticket-accepted decision, not a regression of the density
  // intent (still comfortably above the 24-prompt deal floor).
  it('seeds the canonical 80-entry pool (w1-seed-and-composition)', () => {
    expect(ITEMS.length).toBe(80);
  });

  it('seeds unique, non-empty prompt { text, spicy } entries — content-hash doc ids (hashed on text) collapse duplicates', () => {
    expect(new Set(ITEMS.map((it: { text: string; spicy: boolean }) => it.text)).size).toBe(
      ITEMS.length,
    );
    for (const it of ITEMS as { text: string; spicy: boolean }[]) {
      expect(typeof it.text).toBe('string');
      expect(it.text.trim().length).toBeGreaterThan(0);
      expect(typeof it.spicy).toBe('boolean');
    }
  });
});

// #129 reopened: the app renders the pool from Firestore, not the JS bundle, so a
// merged-and-deployed pool change still leaves players on the OLD pool until the
// seed is re-run against the live project — exactly what happened after #135
// (87-prompt pool shipped, but events/{id}/items still held the pre-#135 32).
// `verifySeedPool` is the drift check that turns that silent gap into a loud
// failure (`node scripts/seed.mjs --verify`, post-deploy). These pin its verdicts.
describe('w1-event-seed: verifySeedPool drift check (#129 reopened)', () => {
  it('reports ok for a live pool that matches the canonical ITEMS exactly', () => {
    const report = verifySeedPool(liveFromCanonical(), ITEMS);
    expect(report.ok).toBe(true);
    expect(report.expected).toBe(80);
    expect(report.seedOwned).toBe(80);
    expect(report.missing).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.mismatched).toEqual([]);
  });

  // Per-Event seed data (#563): there is no global pool a default could safely
  // point at — a caller that omits the argument must fail loudly rather than
  // silently report OK against the wrong Event's canon (the same failure class
  // Codex P2 on PR #229 flagged when the default was the main-only ITEMS).
  it('requires the target pool — omitting it throws instead of comparing against nothing', () => {
    // @ts-expect-error — deliberately omitting the required pool argument to
    // pin the runtime guard.
    expect(() => verifySeedPool(liveFromCanonical())).toThrow(/requires the target event pool/);
  });

  it('flags a live pool missing every curated doc when checked against the full ALL_ITEMS', () => {
    const report = verifySeedPool(liveFromCanonical(), ALL_ITEMS);
    expect(report.ok).toBe(false);
    expect(report.expected).toBe(ALL_ITEMS.length);
    expect(report.missing.length).toBe(ALL_ITEMS.length - ITEMS.length);
  });

  it('ignores player-submitted prompts — they are not canonical and never count as drift', () => {
    const live: LiveDoc[] = [
      ...liveFromCanonical(),
      {
        id: 'player-abc',
        text: 'A player prompt',
        createdBy: 'player-1',
        spicy: true,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        pool: 'main',
      },
    ];
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(true);
    expect(report.playerOwned).toBe(1);
    expect(report.stale).toEqual([]);
  });

  it('flags a canonical prompt that was never seeded as missing', () => {
    const live = liveFromCanonical().filter((d) => d.text !== 'Fivesome');
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.missing.map((m: { text: string }) => m.text)).toEqual(['Fivesome']);
    expect(report.stale).toEqual([]);
  });

  it('flags a seed-owned prompt the canonical pool no longer contains as stale', () => {
    const live: LiveDoc[] = [
      ...liveFromCanonical(),
      {
        id: seedItemDocId('A retired prompt'),
        text: 'A retired prompt',
        createdBy: 'seed',
        spicy: false,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        pool: 'main',
      },
    ];
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.stale.map((s: { text: string }) => s.text)).toEqual(['A retired prompt']);
    expect(report.missing).toEqual([]);
  });

  it('flags a spicy-flag drift (same prompt text, flag flipped without a reseed) as mismatched', () => {
    const live = liveFromCanonical().map((d) =>
      d.text === 'Threesome' ? { ...d, spicy: false } : d,
    );
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toMatchObject({
      text: 'Threesome',
      expectedSpicy: true,
      actualSpicy: false,
    });
  });

  it('flags a stored-text drift (canonical id but a tampered text field) as mismatched (Codex P2, PR #139)', () => {
    // A malformed doc carrying the canonical content-hash id but a different
    // stored `text` must not slip through just because the id matches.
    const live = liveFromCanonical().map((d) =>
      d.text === 'Threesome' ? { ...d, text: 'Tampered text' } : d,
    );
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toMatchObject({ text: 'Threesome', actualText: 'Tampered text' });
  });

  it('compares spicy strictly — a non-boolean or missing flag is drift, not silently coerced (Codex P2, PR #139)', () => {
    // firestore.rules require `spicy is bool`; a value that only *coerces* to the
    // canonical answer (a truthy string on a spicy prompt, or a missing/undefined
    // flag on a tame prompt) is itself drift the check must surface.
    const truthyString = liveFromCanonical().map((d) =>
      d.text === 'Threesome' ? { ...d, spicy: 'true' as unknown as boolean } : d,
    );
    expect(verifySeedPool(truthyString, ITEMS).ok).toBe(false);
    expect(verifySeedPool(truthyString, ITEMS).mismatched.map((m: { text: string }) => m.text)).toEqual([
      'Threesome',
    ]);

    const missingFlag = liveFromCanonical().map((d) =>
      d.text === 'Eat carbs' ? { ...d, spicy: undefined as unknown as boolean } : d,
    );
    expect(verifySeedPool(missingFlag, ITEMS).ok).toBe(false);
    expect(verifySeedPool(missingFlag, ITEMS).mismatched.map((m: { text: string }) => m.text)).toEqual([
      'Eat carbs',
    ]);
  });

  it.each([
    ['isFreeSpace', { isFreeSpace: true }],
    ['status', { status: 'hidden' }],
    ['reportCount', { reportCount: 4 }],
  ])('flags %s drift that removes a canonical prompt from the player-facing pool', (_field, change) => {
    const live = liveFromCanonical().map((d) =>
      d.text === 'Threesome' ? { ...d, ...change } : d,
    );
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toMatchObject({ text: 'Threesome' });
  });

  it.each([
    ['a missing pool (never stamped)', { pool: undefined as unknown as string }],
    ['a drifted pool (seeded into a non-main pool)', { pool: 'embark' }],
  ])('flags %s on a canonical seed doc as mismatched', (_case, change) => {
    // The seed stamps `pool: 'main'`; a live seed doc missing `pool` or sitting
    // in another pool is drift the verify path must surface (Codex follow-up).
    const live = liveFromCanonical().map((d) =>
      d.text === 'Threesome' ? { ...d, ...change } : d,
    );
    const report = verifySeedPool(live, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toMatchObject({
      text: 'Threesome',
      expectedPool: 'main',
      actualPool: change.pool,
    });
  });

  it('accepts reports below the visibility threshold and rejects counts at the boundary', () => {
    const withReportCount = (reportCount: number) =>
      liveFromCanonical().map((d) =>
        d.text === 'Threesome' ? { ...d, reportCount } : d,
      );
    expect(verifySeedPool(withReportCount(1), ITEMS).ok).toBe(true);
    expect(verifySeedPool(withReportCount(3), ITEMS).ok).toBe(true);
    expect(verifySeedPool(withReportCount(4), ITEMS).ok).toBe(false);
  });

  it('prints a roster-safe reconcile command for the same event and project', () => {
    const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = 'staging-bingo';
    try {
      const report = verifySeedPool([], ALL_ITEMS);
      expect(formatDriftReport(report, 'future-cruise')).toContain(
        'ADMIN_UID= RESEED=1 VITE_EVENT_ID=future-cruise GOOGLE_CLOUD_PROJECT=staging-bingo node scripts/seed.mjs',
      );
    } finally {
      if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    }
  });

  // The exact production condition: the live pool is still an OLD seed set — one
  // prompt that survived into the current pool, plus retired/renamed ones — and
  // none of the other ~79 new entries. verifySeedPool must catch it as both
  // missing (new entries absent) AND stale (retired entries lingering).
  it('reproduces the #129 incident: an un-reseeded OLD pool drifts on both axes', () => {
    const oldLive: LiveDoc[] = [
      // 'Threesome' survived unchanged; the rest were retired/renamed out of the pool.
      'Threesome',
      'Make out with Patti LuPone',
      'Sex with four gays, each from a different continent',
      '3 loads in one day',
    ].map((text) => ({
      id: seedItemDocId(text),
      text,
      createdBy: 'seed',
      spicy: true,
      isFreeSpace: false,
      status: 'active',
      reportCount: 0,
      pool: 'main',
    }));
    const report = verifySeedPool(oldLive, ITEMS);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(79); // every new-pool entry except 'Threesome'
    expect(report.stale.map((s: { text: string }) => s.text).sort()).toEqual(
      [
        '3 loads in one day',
        'Make out with Patti LuPone',
        'Sex with four gays, each from a different continent',
      ].sort(),
    );
  });
});
