import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEventArchive,
  draftEventArchive,
  isEventArchived,
  isEventArchiving,
  MAX_ARCHIVED_DISPLAY_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVED_STANDING_ROWS,
} from './eventArchive';
import type { DayDef, DayMetaDoc, EventDoc, PlayerDoc } from '../types';

// The write path's seam (#134, Codex P2 on PR #1139). `archiveEvent` is the half
// of the protocol that runs AFTER gameplay is shut, so the properties that
// matter about it are which reads it takes and in what order — which is exactly
// what a fake Firestore surface can hold and an emulator cannot. Every reference
// carries `withConverter` because `src/data/paths.ts` attaches one to each.
const A = vi.hoisted(() => ({
  event: undefined as Record<string, unknown> | undefined,
  claims: [] as Record<string, unknown>[],
  players: [] as Record<string, unknown>[],
  /** Field maps handed to `tx.update` — empty means the freeze wrote nothing. */
  updates: [] as Record<string, unknown>[],
  /** Every server-read path, in order, so "after the close" is provable. */
  serverReads: [] as string[],
}));

vi.mock('../firebase', () => ({ db: {}, functions: {}, EVENT_ID: 'test-event' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  type Ref = { path: string; withConverter: () => Ref };
  const ref = (path: string): Ref => {
    const r: Ref = { path, withConverter: () => r };
    return r;
  };
  const eventDoc = (path: string) =>
    path === 'events/test-event' ? A.event : undefined;
  const snapOf = (path: string) => ({
    exists: () => eventDoc(path) !== undefined,
    data: () => eventDoc(path),
    id: path.split('/').pop() ?? '',
  });
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    collection: (_db: unknown, ...segments: string[]) => ref(segments.join('/')),
    getDocFromServer: async (r: Ref) => {
      A.serverReads.push(r.path);
      return snapOf(r.path);
    },
    getDocsFromServer: async (r: Ref) => {
      A.serverReads.push(r.path);
      const rows = r.path.endsWith('/claims')
        ? A.claims
        : r.path.endsWith('/players')
          ? A.players
          : [];
      return { docs: rows.map((row) => ({ exists: () => true, data: () => row })) };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: Ref) => snapOf(r.path),
        update: (_r: Ref, data: Record<string, unknown>) => {
          A.updates.push(data);
        },
      }),
  };
});

// Imported AFTER the mocks above, which vitest hoists.
import { archiveEvent } from './admin';

// specs/post-sailing-archive.md, unit layer (#134). `buildEventArchive` is the
// whole freeze: whatever it returns is what the archived Leaderboard renders
// forever, so these tests pin the two properties that make the record
// trustworthy — it COPIES the client-authoritative stats rather than
// recomputing them (ADR 0001), and it reuses the live surfaces' own selectors so
// the frozen answers match the last live ones.

function mkPlayer(
  over: Partial<PlayerDoc> & Pick<PlayerDoc, 'uid' | 'displayName'>,
): PlayerDoc {
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

function mkDay(index: number, over: Partial<DayDef> = {}): DayDef {
  return {
    index,
    date: `2026-07-${String(15 + index).padStart(2, '0')}`,
    place: 'Somewhere',
    placeEmoji: '🏖️',
    theme: 'neon-playground',
    tonight: [],
    pool: 'main',
    tutorial: false,
    unlockAt: 1000 * (index + 1),
    ...over,
  } as DayDef;
}

const DAYS = [mkDay(0, { tutorial: true }), mkDay(1), mkDay(2)];

describe('isEventArchived', () => {
  it('is true only for the literal archived status', () => {
    expect(isEventArchived({ status: 'archived' } as EventDoc)).toBe(true);
    expect(isEventArchived({ status: 'active' } as EventDoc)).toBe(false);
    // Absent means OPEN — every Event document written before #134 has no key.
    expect(isEventArchived({} as EventDoc)).toBe(false);
    expect(isEventArchived(null)).toBe(false);
    expect(isEventArchived(undefined)).toBe(false);
  });
});

describe('isEventArchiving', () => {
  it('is true only for the literal closing flag', () => {
    expect(isEventArchiving({ archiving: true } as EventDoc)).toBe(true);
    expect(isEventArchiving({ archiving: false } as EventDoc)).toBe(false);
    // Absent means OPEN, exactly as an absent `status` does.
    expect(isEventArchiving({} as EventDoc)).toBe(false);
    expect(isEventArchiving(null)).toBe(false);
    expect(isEventArchiving(undefined)).toBe(false);
  });

  it('is independent of `isEventArchived` in both directions', () => {
    // The two states are separate on purpose. A CLOSING Event has no record to
    // render, so the Leaderboard stays live — correctly, because the archive
    // does not exist yet — while the archive write CLEARS the flag as it lands.
    // A surface that treated either as implying the other would render an empty
    // archive during the quiesce, or a live Leaderboard after the freeze.
    const closing = { status: 'active', archiving: true } as EventDoc;
    expect(isEventArchived(closing)).toBe(false);
    expect(isEventArchiving(closing)).toBe(true);

    const archived = { status: 'archived', archiving: false } as EventDoc;
    expect(isEventArchived(archived)).toBe(true);
    expect(isEventArchiving(archived)).toBe(false);
  });
});

describe('buildEventArchive — the standings are COPIED, not recomputed', () => {
  it('takes each row straight off the Player-written stats, even when the per-Day buckets disagree', () => {
    // A row whose root totals do not equal the sum of its own `dayStats` is the
    // exact state ADR 0001 refuses to "fix": the Player wrote both, and the
    // archive records what the Leaderboard showed rather than adjudicating.
    const drifted = mkPlayer({
      uid: 'drifted',
      displayName: 'Drifted',
      bingoCount: 3,
      squaresMarked: 20,
      firstBingoAt: 5000,
      blackout: true,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 5000 } },
    });
    const archive = buildEventArchive({
      players: [drifted],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 42,
    });
    expect(archive.standings).toEqual([
      {
        uid: 'drifted',
        displayName: 'Drifted',
        bingoCount: 3,
        squaresMarked: 20,
        blackout: true,
        firstBingoAt: 5000,
      },
    ]);
    expect(archive.archivedAt).toBe(42);
    expect(archive.playerCount).toBe(1);
  });

  it('ranks the rows itself, so an unsorted roster still freezes in Leaderboard order', () => {
    const top = mkPlayer({ uid: 'top', displayName: 'Top', bingoCount: 3, squaresMarked: 20 });
    const mid = mkPlayer({ uid: 'mid', displayName: 'Mid', bingoCount: 1, squaresMarked: 18 });
    const low = mkPlayer({ uid: 'low', displayName: 'Low', bingoCount: 1, squaresMarked: 9 });
    const archive = buildEventArchive({
      players: [low, top, mid],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['top', 'mid', 'low']);
  });

  it('bounds the retained rows while playerCount records the true roster size', () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: 10 - i }),
    );
    const archive = buildEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      maxRows: 2,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['p0', 'p1']);
    expect(archive.playerCount).toBe(5);
    // The shipped cap is far above any real roster, so nothing is dropped in
    // practice — the bound exists to keep the Event document writable.
    expect(MAX_ARCHIVED_STANDING_ROWS).toBeGreaterThan(100);
  });
});

describe('buildEventArchive — the hall of fame', () => {
  const early = mkPlayer({
    uid: 'early',
    displayName: 'Early',
    bingoCount: 1,
    squaresMarked: 5,
    firstBingoAt: 2000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 2000 } },
  });
  const tutorialOnly = mkPlayer({
    uid: 'tutorial-only',
    displayName: 'Tutorial Only',
    bingoCount: 1,
    squaresMarked: 4,
    firstBingoAt: 500,
    dayStats: { 0: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 500 } },
  });

  it('never credits a Tutorial Day bingo with the headline honour', () => {
    const archive = buildEventArchive({
      players: [tutorialOnly, early],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // `tutorialOnly` bingoed earlier in wall-clock terms (500 < 2000) and on a
    // Tutorial Day, so the honour is Early's.
    expect(archive.firstBingo).toEqual({ uid: 'early', displayName: 'Early', at: 2000 });
  });

  it('applies the resolved Standings Freeze as the cutoff', () => {
    const late = mkPlayer({
      uid: 'late',
      displayName: 'Late',
      bingoCount: 1,
      squaresMarked: 3,
      firstBingoAt: 9000,
      dayStats: { 2: { bingoCount: 1, squaresMarked: 3, firstBingoAt: 9000 } },
    });
    const frozen = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [], frozenAt: 8000 },
      archivedAt: 1,
    });
    expect(frozen.freezeAt).toBe(8000);
    expect(frozen.firstBingo).toBeNull();
    // Without a freeze there is no cutoff, which is every Event that never had
    // one — the pre-ADR-0011 behaviour, unchanged.
    const open = buildEventArchive({
      players: [late],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(open.freezeAt).toBeNull();
    expect(open.firstBingo?.uid).toBe('late');
  });

  it('prefers a pinned day-meta honour and falls back to the derived one', () => {
    const dayMetas = new Map<number, DayMetaDoc>([
      [1, { firstBingo: { uid: 'pinned', displayName: 'Pinned', at: 1500 } }],
    ]);
    const archive = buildEventArchive({
      players: [
        early,
        mkPlayer({
          uid: 'pinned',
          displayName: 'Pinned',
          bingoCount: 1,
          squaresMarked: 9,
          firstBingoAt: 1500,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 9, firstBingoAt: 1500 } },
        }),
        mkPlayer({
          uid: 'day2',
          displayName: 'Day Two',
          bingoCount: 1,
          squaresMarked: 2,
          firstBingoAt: 7000,
          dayStats: { 2: { bingoCount: 1, squaresMarked: 2, firstBingoAt: 7000 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      dayMetas,
      archivedAt: 1,
    });
    expect(archive.dailyHonors).toEqual([
      { dayIndex: 1, uid: 'pinned', displayName: 'Pinned', firstBingoAt: 1500 },
      { dayIndex: 2, uid: 'day2', displayName: 'Day Two', firstBingoAt: 7000 },
    ]);
  });

  // Codex P2, PR #1139. The two bounds are independent — `standings` is cut by
  // RANK, the honour is decided by who bingoed EARLIEST — so the holder can fall
  // outside the retained prefix, and the Share Card's pinned eleventh row would
  // then have nothing to build from.
  it('keeps the headline holder’s own row and true rank outside the bounded prefix', () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      mkPlayer({
        uid: `p${i}`,
        displayName: `P${i}`,
        bingoCount: 5 - i,
        squaresMarked: 50 - i,
        // The LAST-ranked Player bingoed first.
        firstBingoAt: 5000 - i,
        dayStats: { 1: { bingoCount: 5 - i, squaresMarked: 50 - i, firstBingoAt: 5000 - i } },
      }),
    );
    const archive = buildEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      maxRows: 2,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['p0', 'p1']);
    expect(archive.firstBingo?.uid).toBe('p4');
    // Rank 5 of 5, not a position inside the two rows that were retained.
    expect(archive.firstBingoRow).toEqual({
      uid: 'p4',
      displayName: 'P4',
      bingoCount: 1,
      squaresMarked: 46,
      blackout: false,
      firstBingoAt: 4996,
      rank: 5,
    });
  });

  it('carries no headline row when there is no headline honour', () => {
    // `firstBingo` and `firstBingoRow` are selected together and neither
    // survives the other — a record naming a holder it cannot print is the
    // half-built map the rules arm refuses.
    const archive = buildEventArchive({
      players: [mkPlayer({ uid: 'nobody', displayName: 'Nobody' })],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.firstBingo).toBeNull();
    expect(archive.firstBingoRow).toBeNull();
  });
});

describe('buildEventArchive — a ban hides, it never reassigns', () => {
  const banned = mkPlayer({
    uid: 'banned',
    displayName: 'Banned',
    bingoCount: 2,
    squaresMarked: 20,
    firstBingoAt: 1000,
    dayStats: { 1: { bingoCount: 2, squaresMarked: 20, firstBingoAt: 1000 } },
  });
  const later = mkPlayer({
    uid: 'later',
    displayName: 'Later',
    bingoCount: 1,
    squaresMarked: 6,
    firstBingoAt: 3000,
    dayStats: { 1: { bingoCount: 1, squaresMarked: 6, firstBingoAt: 3000 } },
  });

  it('drops a banned Player from the standings and from every honour', () => {
    const archive = buildEventArchive({
      players: [banned, later],
      event: { days: DAYS, bannedUids: ['banned'] },
      dayMetas: new Map<number, DayMetaDoc>([
        [1, { firstBingo: { uid: 'banned', displayName: 'Banned', at: 1000 } }],
      ]),
      archivedAt: 1,
    });
    expect(archive.standings.map((r) => r.uid)).toEqual(['later']);
    expect(archive.playerCount).toBe(1);
    // The headline is selected over the RAW roster and then hidden — so the
    // honour goes to NOBODY rather than being handed to the next Player, who
    // was never first (specs/w2-ban-console.md § Leaderboard, made permanent).
    expect(archive.firstBingo).toBeNull();
    // The kept headline row goes with it: a hidden Player must not be printable
    // from the Share Card's pinned row either.
    expect(archive.firstBingoRow).toBeNull();
    // The pinned Day-1 honour is the banned Player's, so that Day gets no chip
    // rather than the derived runner-up.
    expect(archive.dailyHonors).toEqual([]);
  });
});

// Codex P2, PR #1139. `players/{uid}` is self-written under the honour system
// and its rules arm validates NOTHING — not `uid`, not `displayName`, not the
// two counts — so every row below is a shape a Player can actually produce.
// Before this, each of them made the archive write throw or the Event document
// overflow AFTER the closing write had already shut the Event: every attempt
// closed play and then failed, permanently.
describe('draftEventArchive — the inputs are validated before the Event is shut', () => {
  it('skips a row with no usable uid, and counts it', () => {
    const draft = draftEventArchive({
      players: [
        mkPlayer({ uid: 'real', displayName: 'Real', squaresMarked: 5 }),
        // A Player who deleted `uid` from their own row. Firestore refuses to
        // serialize `undefined`, and the row is unmatchable besides — there is
        // nothing to default an identity to.
        { ...mkPlayer({ uid: 'x', displayName: 'Ghost' }), uid: undefined } as unknown as PlayerDoc,
        { ...mkPlayer({ uid: 'x', displayName: 'Blank' }), uid: '   ' } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings.map((r) => r.uid)).toEqual(['real']);
    expect(draft.archive.playerCount).toBe(1);
    expect(draft.skippedRows).toBe(2);
    expect(draft.refusal).toBeNull();
  });

  it('never lets an unidentifiable row take the headline honour', () => {
    // Dropped BEFORE the selection, not after: a winner with no uid would be
    // written as `{uid: undefined}` and refuse to serialize.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'x', displayName: 'Ghost', bingoCount: 1, firstBingoAt: 10 }),
          uid: undefined,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 10 } },
        } as unknown as PlayerDoc,
        mkPlayer({
          uid: 'real',
          displayName: 'Real',
          bingoCount: 1,
          squaresMarked: 5,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.firstBingoRow?.uid).toBe('real');
  });

  it('coerces a missing name and missing counts to safe defaults', () => {
    const draft = draftEventArchive({
      players: [
        { uid: 'sparse', joinedAt: 0, reshufflesUsed: 0, photoURL: null } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings).toEqual([
      {
        uid: 'sparse',
        // The estate's existing stand-in for a nameless Player, not `undefined`.
        displayName: 'Anonymous',
        bingoCount: 0,
        squaresMarked: 0,
        blackout: false,
        firstBingoAt: null,
      },
    ]);
    // The row is KEPT: an identifiable Player belongs in the standings even when
    // every other field of their row is missing.
    expect(draft.skippedRows).toBe(0);
  });

  it('bounds a name at the cap the rest of the estate already enforces', () => {
    const draft = draftEventArchive({
      players: [mkPlayer({ uid: 'shouty', displayName: 'A'.repeat(50_000), squaresMarked: 1 })],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.standings[0].displayName).toHaveLength(MAX_ARCHIVED_DISPLAY_NAME);
    // 100 is what `firestore.rules` already caps every OTHER Player-authored
    // display name at, and the profile editor's own limit is 40 — so no name a
    // Player can enter through the app is ever shortened by this.
    expect(MAX_ARCHIVED_DISPLAY_NAME).toBe(100);
    // The row that would have cost fifty kilobytes now costs a hundred bytes,
    // which is the point: the clamp is what keeps the record writable.
    expect(draft.refusal).toBeNull();
  });

  it('REFUSES a record that still would not fit, rather than letting the write throw', () => {
    const draft = draftEventArchive({
      players: Array.from({ length: 40 }, (_, i) =>
        mkPlayer({ uid: `p${i}`, displayName: `P${i}`, squaresMarked: 40 - i }),
      ),
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      // The shipped ceiling is unreachable once the clamps above apply, so the
      // backstop is exercised by tightening it rather than by fabricating a
      // record no clamp would produce.
      maxBytes: 200,
    });
    expect(draft.bytes).toBeGreaterThan(200);
    expect(draft.refusal).toBe('too-large');
    // The margin the shipped ceiling leaves: a quarter of the Event document's
    // 1 MiB budget, three quarters left for the fields it shares.
    expect(MAX_ARCHIVE_BYTES).toBeLessThan(1024 * 1024);
  });

  it('leaves a real Event nowhere near the ceiling', () => {
    // The bound is a backstop, not a limit any Event is expected to approach: a
    // FULL 200-row record with maximum-length names is still a fraction of it.
    const draft = draftEventArchive({
      players: Array.from({ length: MAX_ARCHIVED_STANDING_ROWS }, (_, i) =>
        mkPlayer({
          uid: `player-uid-${i}`,
          displayName: 'N'.repeat(MAX_ARCHIVED_DISPLAY_NAME),
          bingoCount: 20,
          squaresMarked: 250 - i,
          firstBingoAt: 1_700_000_000_000,
        }),
      ),
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.refusal).toBeNull();
    expect(draft.bytes).toBeLessThan(MAX_ARCHIVE_BYTES / 2);
  });
});

// Codex P2, PR #1139. The console's drain gate reads a passive listener, which
// reports only what has already been DELIVERED — so a Claim committing between
// the last render and the closing write clears the gate and is then stranded
// permanently: the freeze never reads the Claim collection, and both writes a
// resolution consists of are denied from the moment gameplay shuts. The remedy
// is the same one the roster gets — a server read taken AFTER the close, when
// the collection can no longer change.
describe('archiveEvent — the drain gate is re-taken from the server after the close', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    claimMode: 'admin_confirmed',
    days: [],
    bannedUids: [],
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.updates = [];
    A.serverReads = [];
  });

  it('freezes when the queue is genuinely empty (the control)', async () => {
    A.claims = [{ status: 'confirmed' }, { status: 'rejected' }];
    expect(await archiveEvent({ now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    expect(A.updates[0].status).toBe('archived');
  });

  it('refuses, and writes nothing, when a Claim is pending after the close', async () => {
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent({ now: 5 })).toBe('claims-pending');
    expect(A.updates).toEqual([]);
  });

  it('takes that read AFTER the Event is confirmed shut, and before the roster', async () => {
    // The order is the guarantee: a queue read before the quiesce is confirmed
    // proves nothing, because the collection could still move afterwards.
    await archiveEvent({ now: 5 });
    expect(A.serverReads[0]).toBe('events/test-event');
    expect(A.serverReads[1]).toBe('events/test-event/claims');
    expect(A.serverReads).toContain('events/test-event/players');
  });

  it('never reaches the queue when the Event was not shut at all', async () => {
    // `not-closing` comes first: an Event that was never quiesced has a Claim
    // queue that is still moving, so reading it would answer nothing.
    A.event = closingEvent({ archiving: false });
    expect(await archiveEvent({ now: 5 })).toBe('not-closing');
    expect(A.serverReads).toEqual(['events/test-event']);
  });

  it('ignores a pending Claim outside admin-confirmed mode, which has no drain path', async () => {
    // #269's mode gate, unchanged: outside `admin_confirmed` the Review queue
    // offers no Confirm/Reject, so refusing here would be a dead end rather than
    // a gate. The same `claimsAwaitingAdmin` the console applies decides it.
    A.event = closingEvent({ claimMode: 'honor' });
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent({ now: 5 })).toBe('archived');
  });

  it('refuses a record the server re-read makes too large, and writes nothing', async () => {
    // The console checked the record it previewed from its live subscriptions;
    // this is the one built from the roster read after the close, and a Player
    // row is not validated by any rule on the way in.
    const dayStats: Record<number, Record<string, number>> = {};
    for (let i = 0; i < 6_000; i++) {
      dayStats[i] = { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1_000 + i };
    }
    A.players = [{ uid: 'whale', displayName: 'Whale', bingoCount: 1, squaresMarked: 1, dayStats }];
    expect(await archiveEvent({ now: 5 })).toBe('too-large');
    expect(A.updates).toEqual([]);
  });
});
