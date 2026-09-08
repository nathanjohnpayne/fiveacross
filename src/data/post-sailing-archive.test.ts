import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveSnapshotFingerprint,
  buildEventArchive,
  draftEventArchive,
  isEventArchived,
  isEventArchiving,
  MAX_ARCHIVED_DISPLAY_NAME,
  MAX_ARCHIVED_EVENT_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVED_EVENT_BYTES,
  MAX_ARCHIVED_STANDING_ROWS,
} from './eventArchive';
import { dayHonorChipLabel } from './finale';
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
  /** Fired once the server reads are done and before the transaction opens —
   *  the window a reopen-and-reshut actually lands in. */
  betweenReadsAndTx: null as (() => void) | null,
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
    runTransaction: async (_db: unknown, fn: (tx: unknown) => unknown) => {
      A.betweenReadsAndTx?.();
      return fn({
        get: async (r: Ref) => snapOf(r.path),
        update: (_r: Ref, data: Record<string, unknown>) => {
          A.updates.push(data);
        },
      });
    },
  };
});

// Imported AFTER the mocks above, which vitest hoists.
import { abandonArchive, archiveEvent, beginArchive } from './admin';

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

  // Codex P2, PR #1139. `EventDoc.name` is outside the write-once clause, so the
  // archived Share Card rebuilt its title from a field an Admin can still edit —
  // the same drift the honour chip labels were frozen to stop.
  it('freezes the Event name the archived card is titled with', () => {
    const archive = buildEventArchive({
      players: [mkPlayer({ uid: 'a', displayName: 'A' })],
      event: { name: '  Med 2026  ', days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    // Trimmed, like every other name the record carries.
    expect(archive.eventName).toBe('Med 2026');
  });

  it('bounds the frozen Event name, and stores null when there is none', () => {
    // `EventDoc.name` is admin-written and unvalidated at the rules boundary,
    // so it lands in the same 1 MiB budget as everything else in the record.
    const long = buildEventArchive({
      players: [],
      event: { name: 'N'.repeat(MAX_ARCHIVED_EVENT_NAME + 40), days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(long.eventName).toHaveLength(MAX_ARCHIVED_EVENT_NAME);

    // No name, or a blank one: `null` rather than a stand-in. The Share Card
    // already falls back to the app's own name for an unnamed Event, and
    // inventing one here would freeze a name nobody chose.
    for (const name of [undefined, '', '   ', 7 as unknown as string]) {
      expect(
        buildEventArchive({
          players: [],
          event: { name, days: DAYS, bannedUids: [] },
          archivedAt: 1,
        }).eventName,
      ).toBeNull();
    }
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
      // The chip LABEL is frozen alongside the honour (#1139): the Day's theme
      // emoji plus its ordinal, resolved once from the schedule the record was
      // taken against, so re-theming that Day later cannot re-label it.
      { dayIndex: 1, uid: 'pinned', displayName: 'Pinned', firstBingoAt: 1500, dayLabel: '🌈 D2' },
      { dayIndex: 2, uid: 'day2', displayName: 'Day Two', firstBingoAt: 7000, dayLabel: '🌈 D3' },
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

  // Codex P2, PR #1139 round 4. The archived honours strip used to look each
  // Day's theme emoji up in the LIVE `EventDoc.days`, which the freeze
  // deliberately leaves editable — so an Admin re-theming a Day after the
  // archive silently re-labelled a frozen honour. The label is resolved once,
  // here, and stored.
  it('freezes the Day chip label each honour renders under', () => {
    const days = [mkDay(0, { theme: 'get-sporty' }), mkDay(1, { theme: 'neon-playground' })];
    const archive = buildEventArchive({
      players: [
        mkPlayer({
          uid: 'd0',
          displayName: 'Day Nought',
          bingoCount: 1,
          squaresMarked: 3,
          firstBingoAt: 500,
          dayStats: { 0: { bingoCount: 1, squaresMarked: 3, firstBingoAt: 500 } },
        }),
        mkPlayer({
          uid: 'd1',
          displayName: 'Day One',
          bingoCount: 1,
          squaresMarked: 4,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 4, firstBingoAt: 900 } },
        }),
      ],
      event: { days, bannedUids: [] },
      archivedAt: 1,
    });
    // The live strip's own derivation (`dayHonorChipLabel`), reused rather than
    // restated, so the frozen label IS the label the last live strip rendered.
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(['🏋️ D1', '🌈 D2']);
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(
      archive.dailyHonors.map((h) => dayHonorChipLabel(h.dayIndex, days)),
    );
    // Re-theming the Day AFTERWARDS moves the live label and leaves the frozen
    // one exactly where it was: the record is what the archived strip renders.
    const rethemed = [mkDay(0, { theme: 'neon-playground' }), mkDay(1, { theme: 'get-sporty' })];
    expect(dayHonorChipLabel(0, rethemed)).toBe('🌈 D1');
    expect(archive.dailyHonors[0].dayLabel).toBe('🏋️ D1');
  });

  it('labels an honour on a Day the schedule does not carry by its ordinal alone', () => {
    // The derived fallback: with no schedule there is no theme to read, so the
    // chip is the Day's own ordinal — which is what the live strip shows for
    // the same Day, and which nothing can later re-theme.
    const archive = buildEventArchive({
      players: [
        mkPlayer({
          uid: 'orphan',
          displayName: 'Orphan',
          bingoCount: 1,
          squaresMarked: 1,
          firstBingoAt: 100,
          dayStats: { 4: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 100 } },
        }),
      ],
      event: { days: [], bannedUids: [] },
      archivedAt: 1,
    });
    expect(archive.dailyHonors.map((h) => h.dayLabel)).toEqual(['D5']);
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

  it('survives a null per-Day bucket rather than throwing out of the draft', () => {
    // Codex P2, PR #1139. `players/{uid}` validates NOTHING, so `dayStats` is a
    // Player-written map that can hold a `null` — and every honour selector
    // dereferences the bucket (`stat.firstBingoAt`). One such row threw out of
    // the builder before any coercion ran, and because `ArchiveEvent` builds
    // this draft during RENDER, the exception took Game settings and its Reopen
    // play control with it — on an Event that may already be shut.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'broken', displayName: 'Broken', bingoCount: 1, squaresMarked: 3 }),
          dayStats: { 1: null },
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
    // The unreadable bucket is dropped, so the Day's honour is decided by the
    // row that actually carries evidence for it — and the broken row's own ROOT
    // totals are still copied verbatim (ADR 0001).
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.dailyHonors.map((h) => h.uid)).toEqual(['real']);
    expect(draft.archive.standings.find((r) => r.uid === 'broken')).toMatchObject({
      bingoCount: 1,
      squaresMarked: 3,
    });
    expect(draft.refusal).toBeNull();
  });

  it('drops a NON-OBJECT bucket the same way — a string is not a Day of evidence', () => {
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'junk', displayName: 'Junk' }),
          dayStats: { 1: 'nonsense', 2: 7 },
        } as unknown as PlayerDoc,
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo).toBeNull();
    expect(draft.archive.dailyHonors).toEqual([]);
    expect(draft.archive.standings.map((r) => r.uid)).toEqual(['junk']);
  });

  it('coerces a bucket whose fields are MISSING or non-finite rather than ranking them', () => {
    // The bucket is a real object, so it is kept — and every field inside it
    // gets the same coercion the standings rows get. A non-finite instant is the
    // load-bearing half: `NaN` is not `null`, so an uncoerced bucket ENTERS the
    // per-Day comparison and every `<` against it is false, which pins the Day's
    // honour on the row carrying no evidence at all and stores its instant as 0.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'sparse', displayName: 'Sparse' }),
          dayStats: { 1: { firstBingoAt: Number.NaN }, 2: {} },
        } as unknown as PlayerDoc,
        mkPlayer({
          uid: 'real',
          displayName: 'Real',
          bingoCount: 1,
          firstBingoAt: 900,
          dayStats: { 1: { bingoCount: 1, squaresMarked: 5, firstBingoAt: 900 } },
        }),
      ],
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.firstBingo?.uid).toBe('real');
    expect(draft.archive.dailyHonors).toEqual([
      expect.objectContaining({ dayIndex: 1, uid: 'real', firstBingoAt: 900 }),
    ]);
    expect(draft.refusal).toBeNull();
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

  it('drops a daily honour whose Day index is not one', () => {
    // A derived honour reads its `dayIndex` off a `dayStats` KEY, and `dayStats`
    // is a Player-written map with no rules validation — so a junk key becomes
    // `Number('abc')`, a chip nothing could label. The live honours strip drops
    // it by matching against the schedule; the record has to drop it itself,
    // because the record is permanent and an Event with no schedule at all
    // renders the derived list straight through.
    const draft = draftEventArchive({
      players: [
        {
          ...mkPlayer({ uid: 'odd', displayName: 'Odd', bingoCount: 1, squaresMarked: 1 }),
          dayStats: {
            1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 500 },
            abc: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 600 },
          },
        } as unknown as PlayerDoc,
      ],
      // An Event with no schedule: `pinnedOrDerivedDailyHonors` returns the
      // derived list straight through rather than matching it against Days.
      event: { days: [], bannedUids: [] },
      archivedAt: 1,
    });
    expect(draft.archive.dailyHonors.map((h) => h.dayIndex)).toEqual([1]);
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

  // Codex P2, PR #1139 round 4. The ceiling above measures the RECORD, and the
  // record is never written to an empty document: `days` carries per-Day
  // snapshot id lists, `bannedUids` holds up to 1000 entries, `mostLovedPhoto`
  // up to 100 winners — all of them already there when the freeze commits. An
  // Event large on its own could pass the record's quarter-budget and still
  // push the document past Firestore's 1 MiB limit, inside the transaction,
  // with gameplay already shut.
  it('REFUSES a perfectly ordinary record the Event document has no room left for', () => {
    const players = [mkPlayer({ uid: 'p0', displayName: 'P0', squaresMarked: 3 })];
    const event = { days: DAYS, bannedUids: [] };
    // The Event is already carrying most of its budget in fields the builder
    // never reads — which is exactly why the check cannot be made on `event`.
    const heavy = {
      ...event,
      days: DAYS.map((d) => ({
        ...d,
        snapshotItemIds: Array.from({ length: 16_000 }, (_, i) => `item-${i}-padding`),
      })),
    };
    const alone = draftEventArchive({ players, event, archivedAt: 1 });
    expect(alone.refusal).toBeNull();
    expect(alone.bytes).toBeLessThan(MAX_ARCHIVE_BYTES);

    const onTheRealDocument = draftEventArchive({ players, event, archivedAt: 1, existing: heavy });
    // The record itself is unchanged and still well inside its own ceiling…
    expect(onTheRealDocument.bytes).toBe(alone.bytes);
    // …and the document it would land on is not.
    expect(onTheRealDocument.projectedBytes).toBeGreaterThan(MAX_ARCHIVED_EVENT_BYTES);
    expect(onTheRealDocument.refusal).toBe('too-large');
  });

  it('measures the document the update PRODUCES, not the one it replaces', () => {
    const players = [mkPlayer({ uid: 'p0', displayName: 'P0', squaresMarked: 3 })];
    // A prior `archive` on the stored document is REPLACED by this write, so
    // counting it would refuse a re-freeze the document has ample room for.
    const stale = { standings: Array.from({ length: 5_000 }, (_, i) => ({ uid: `u${i}` })) };
    const withStale = draftEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      existing: { name: 'Med 2026', days: DAYS, bannedUids: [], archive: stale },
    });
    const withoutStale = draftEventArchive({
      players,
      event: { days: DAYS, bannedUids: [] },
      archivedAt: 1,
      existing: { name: 'Med 2026', days: DAYS, bannedUids: [] },
    });
    expect(withStale.projectedBytes).toBe(withoutStale.projectedBytes);
    expect(withStale.refusal).toBeNull();
    // The retained fields DO count — the whole point of the projection.
    expect(withStale.projectedBytes).toBeGreaterThan(withStale.bytes);
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

// Codex P1, PR #1139 round 4. `archiving: true` says the Event is shut; it
// cannot say WHICH shut. `archiveEvent` reads the roster, the Day pins and the
// Claim queue against one closing state and commits against whatever the
// transaction finds — so play REOPENED and SHUT AGAIN inside that window
// (gameplay resumes, Marks land, a second archive begins) presents an identical
// flag, and the stale reads would commit as a permanent record. The generation
// token `beginArchive` mints per quiesce is what tells the two apart.
describe('the quiesce is identified, and the snapshot is bound to the one it read', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 'quiesce-1',
    claimMode: 'honor',
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
    A.betweenReadsAndTx = null;
  });

  it('mints a generation id when it shuts the Event, and reports it back', async () => {
    A.event = { status: 'active', days: [], bannedUids: [] };
    const opened = await beginArchive();
    expect(opened.result).toBe('closing');
    expect(A.updates).toHaveLength(1);
    expect(A.updates[0].archiving).toBe(true);
    expect(typeof A.updates[0].archiveToken).toBe('string');
    expect(A.updates[0].archiveToken as string).not.toBe('');
    // Reported to the caller, because the caller is what has to clean up after
    // a refused freeze — and a cleanup that cannot name the closing state it is
    // lifting can lift somebody else's (Codex P2, PR #1139).
    expect(opened.token).toBe(A.updates[0].archiveToken);
  });

  it('keeps the generation id when the Event is already closing', async () => {
    // The call is idempotent and takes no new snapshot, so re-minting here
    // would abort an in-flight freeze that is still perfectly valid.
    expect((await beginArchive()).result).toBe('closing');
    expect(A.updates[0].archiveToken).toBe('quiesce-1');
  });

  it('mints a fresh id for a closing state that carries none', async () => {
    // The shape a pre-token build leaves behind: unidentified, so it gets an
    // identity rather than being bound to by guesswork.
    A.event = closingEvent({ archiveToken: undefined });
    expect((await beginArchive()).result).toBe('closing');
    expect(typeof A.updates[0].archiveToken).toBe('string');
    expect(A.updates[0].archiveToken).not.toBe('');
  });

  it('mints a NEW id for the next quiesce after an abandon', async () => {
    // The whole point of the ABA case: the generation after a reopen must not
    // be mistakable for the one before it.
    A.event = closingEvent();
    expect(await abandonArchive()).toBe('reopened');
    A.event = { ...closingEvent(), archiving: false };
    expect((await beginArchive()).result).toBe('closing');
    expect(A.updates[1].archiveToken).not.toBe('quiesce-1');
  });

  it('freezes, and restates the generation it read, when the quiesce holds', async () => {
    expect(await archiveEvent({ now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    // Restated so the RULES can hold the same binding at the boundary.
    expect(A.updates[0].archiveToken).toBe('quiesce-1');
  });

  it('ABORTS, and writes nothing, when play was reopened and shut again mid-snapshot', async () => {
    // A: the quiesce the roster was read under. B: play reopened, gameplay
    // resumed, a second archive begun. A's transaction sees `archiving: true`
    // either way — only the generation distinguishes them.
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ archiveToken: 'quiesce-2' });
      A.players = [
        { uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 },
        { uid: 'newcomer', displayName: 'Newcomer', bingoCount: 3, squaresMarked: 20 },
      ];
    };
    expect(await archiveEvent({ now: 5 })).toBe('quiesce-changed');
    // Nothing frozen — the alternative is a permanent record that predates
    // play the Event had already accepted.
    expect(A.updates).toEqual([]);
  });

  it('refuses a closing state it cannot bind a snapshot to, before reading anything else', async () => {
    // No token at all: not a quiesce this build can distinguish from another,
    // and the rules refuse the flip from it besides — so it is refused here
    // rather than attempted and thrown on an Event already shut.
    A.event = closingEvent({ archiveToken: undefined });
    expect(await archiveEvent({ now: 5 })).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
    expect(A.serverReads).toEqual(['events/test-event']);
  });

  // Codex P2, PR #1139. `archiveEvent` compares the generation inside its own
  // transaction — but the console's cleanup runs AFTER it returns, and
  // everything the ABA case describes can happen in that gap too. An
  // unconditional reopen there clears a later Admin's quiesce out from under
  // their in-flight freeze, which is exactly what `quiesce-changed` refuses to
  // do one step earlier in the same handler.
  it('reopens only the quiesce it was asked to lift', async () => {
    expect(await abandonArchive('quiesce-1')).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });

  it('LEAVES a superseded quiesce alone, and writes nothing', async () => {
    // The Event was shut again by somebody else between the failed freeze and
    // this cleanup. Their closing state is theirs.
    A.event = closingEvent({ archiveToken: 'quiesce-2' });
    expect(await abandonArchive('quiesce-1')).toBe('quiesce-changed');
    expect(A.updates).toEqual([]);
  });

  it('cannot be laundered by an abandon that leaves the old token behind', async () => {
    // `abandonArchive` deliberately does not clear `archiveToken`, so the
    // matching path has to be proof against reopen-then-reshut: `beginArchive`
    // preserves a token only while the Event is STILL closing, and mints a
    // fresh one otherwise — so the stale caller's comparison fails.
    expect(await abandonArchive()).toBe('reopened');
    A.event = closingEvent({ archiving: false });
    const reshut = await beginArchive();
    A.event = closingEvent({ archiveToken: reshut.token as string });
    expect(await abandonArchive('quiesce-1')).toBe('quiesce-changed');
  });

  it('stays unconditional when no generation is named', async () => {
    // The console's own Reopen play button: a deliberate act on the Event in
    // front of the Admin, not a cleanup of a call that already failed.
    A.event = closingEvent({ archiveToken: 'quiesce-2' });
    expect(await abandonArchive()).toBe('reopened');
    expect(A.updates).toEqual([{ archiving: false }]);
  });

  it('still reports not-closing when the quiesce was simply lifted', async () => {
    // The two failures are distinct: nothing in force at all, versus a
    // different one in force. Only the second must leave the Event shut.
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ archiving: false });
    };
    expect(await archiveEvent({ now: 5 })).toBe('not-closing');
    expect(A.updates).toEqual([]);
  });
});

// Codex P2, PR #1139 round 4. The quiesce shuts GAMEPLAY, not administration —
// deliberately, so an Admin can still moderate and still reopen. That leaves the
// Event's own configuration movable between `archiveEvent`'s pre-read (which the
// drain gate is evaluated against, and which decides which Day honour pins are
// fetched) and its transaction (which the record is built against), so a freeze
// that checked neither would combine reads taken for one configuration with a
// record built for another.
describe('archiveEvent — the snapshot configuration is held across the reads', () => {
  const closingEvent = (over: Record<string, unknown> = {}) => ({
    status: 'active',
    archiving: true,
    archiveToken: 'quiesce-1',
    claimMode: 'honor',
    days: [mkDay(0), mkDay(1)],
    bannedUids: [],
    ...over,
  });

  beforeEach(() => {
    A.event = closingEvent();
    A.claims = [];
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.updates = [];
    A.serverReads = [];
    A.betweenReadsAndTx = null;
  });

  it('freezes when the configuration held (the control)', async () => {
    expect(await archiveEvent({ now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
  });

  it('freezes the Event name off the TRANSACTIONAL read', async () => {
    // Deliberately not in the fingerprint: `name` decides nothing about which
    // rows were read, so a rename mid-snapshot must not cost an archive. Taking
    // it from the transaction's own read is what keeps the record
    // self-consistent anyway — it is the document the write lands on.
    A.event = closingEvent({ name: 'Med 2026' });
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ name: 'Med 2026 — renamed' });
    };
    expect(await archiveEvent({ now: 5 })).toBe('archived');
    expect((A.updates[0].archive as { eventName: string | null }).eventName).toBe(
      'Med 2026 — renamed',
    );
  });

  it('ABORTS when Claim Mode flips mid-snapshot, and writes nothing', async () => {
    // The drain gate is scoped to `claimsQueueOpen`, so a queue read on an
    // `honor` Event passes VACUOUSLY. Flipping to `admin_confirmed` afterwards
    // makes every one of those pending Claims blocking — and unresolvable,
    // because the freeze denies both writes their resolution consists of.
    A.claims = [{ status: 'pending' }];
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ claimMode: 'admin_confirmed' });
    };
    expect(await archiveEvent({ now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when the schedule is edited mid-snapshot, and writes nothing', async () => {
    // `days` decides which Day honour pins were fetched at all, which Days are
    // Tutorial, where a missing Standings Freeze is derived from, and the label
    // each frozen honour chip carries.
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ days: [mkDay(0, { theme: 'get-sporty' }), mkDay(1)] });
    };
    expect(await archiveEvent({ now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when a Day is added or removed mid-snapshot', async () => {
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ days: [mkDay(0), mkDay(1), mkDay(2)] });
    };
    expect(await archiveEvent({ now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('ABORTS when the Standings Freeze moves mid-snapshot', async () => {
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ standingsFreezeAt: 9_999 });
    };
    expect(await archiveEvent({ now: 5 })).toBe('config-changed');
    expect(A.updates).toEqual([]);
  });

  it('does NOT abort on a ban landing mid-snapshot — moderation stays open', async () => {
    // The one administrative action the spec deliberately keeps available
    // across the quiesce. A ban is applied to the rows the record keeps rather
    // than deciding which rows were read, so it changes what the record
    // CONTAINS in exactly the way it should; aborting would make the freeze
    // race a takedown.
    A.betweenReadsAndTx = () => {
      A.event = closingEvent({ bannedUids: ['alice'] });
    };
    expect(await archiveEvent({ now: 5 })).toBe('archived');
    expect(A.updates).toHaveLength(1);
    expect((A.updates[0].archive as { standings: unknown[] }).standings).toEqual([]);
  });

  it('does not mistake a re-serialized document for a changed one', async () => {
    // The fingerprint sorts object keys, because `JSON.stringify` follows
    // insertion order and the SDK promises nothing about reproducing it across
    // two decodes — a comparison that could report a spurious change would
    // abort archives at random.
    const a = { claimMode: 'honor', days: [{ index: 0, theme: 'x', unlockAt: 1 }] };
    const b = { days: [{ unlockAt: 1, theme: 'x', index: 0 }], claimMode: 'honor' };
    expect(archiveSnapshotFingerprint(a as never)).toBe(archiveSnapshotFingerprint(b as never));
    // …and a real edit still moves it.
    expect(archiveSnapshotFingerprint({ ...a, claimMode: 'admin_confirmed' } as never)).not.toBe(
      archiveSnapshotFingerprint(a as never),
    );
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
    // The quiesce's own generation id: `archiving` alone cannot say WHICH shut
    // the record was read against (#1139).
    archiveToken: 'quiesce-1',
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
    A.betweenReadsAndTx = null;
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

  it('counts a pending Claim on an Event whose stored Claim Mode is the LEGACY spelling', async () => {
    // Codex P2, PR #1139. This pre-read is deliberately converter-free, but
    // `claimsQueueOpen` compares against the CURRENT contract — and an Event
    // seeded or written before the rename persists `'verified'` for what is now
    // `'admin_confirmed'`. The console gates on the CONVERTED document, so the
    // two halves of one gate read the same queue and disagreed: the console
    // refused to arm while this take passed vacuously and would have frozen the
    // Event over exactly the Claims the gate exists to drain.
    A.event = closingEvent({ claimMode: 'verified' });
    A.claims = [{ status: 'pending' }];
    expect(await archiveEvent({ now: 5 })).toBe('claims-pending');
    expect(A.updates).toEqual([]);
  });

  it('still freezes a legacy-spelled Event whose queue is genuinely drained', async () => {
    // The control: the coercion decides which Events HAVE a queue, never that a
    // legacy spelling blocks archival on its own.
    A.event = closingEvent({ claimMode: 'verified' });
    A.claims = [{ status: 'confirmed' }];
    expect(await archiveEvent({ now: 5 })).toBe('archived');
  });

  it('refuses when the stored Event has no room left for an ordinary record', async () => {
    // Codex P2, PR #1139 round 4. The record is not written to an empty
    // document: the check that matters is on the one the update PRODUCES. The
    // roster here is a single ordinary row — it is the Event's own fields that
    // have no room left — and the refusal still has to come before the write,
    // because gameplay is already shut by the time this runs.
    A.players = [{ uid: 'alice', displayName: 'Alice', bingoCount: 1, squaresMarked: 9 }];
    A.event = closingEvent({
      days: [
        {
          index: 0,
          theme: 'neon-playground',
          snapshotItemIds: Array.from({ length: 60_000 }, (_, i) => `item-${i}-padding`),
        },
      ],
    });
    expect(await archiveEvent({ now: 5 })).toBe('too-large');
    expect(A.updates).toEqual([]);
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
