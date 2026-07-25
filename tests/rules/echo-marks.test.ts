import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, FieldPath, getDoc, setDoc, writeBatch } from 'firebase/firestore';

// specs/echo-marks.md — the rules side of Echo Marks (#446):
//   1. the day-board write gate accepts the MULTI-BOARD echo batch (the mark's
//      board + echoed sibling boards + the ONE player write + the Tally
//      marker), each board write carrying ITS OWN markSeed;
//   2. a stale or BORROWED markSeed on an echoed board is rejected — the
//      stale-write gate is per-board;
//   3. a stale `markVersion` is rejected once a current-client write has upgraded
//      the board, so a full-array sibling projection cannot erase another device's Mark;
//   4. `boardPristine()`'s echo exemption: an echo-only card is still
//      reshuffleable, a manually-marked one is not.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected
// assertFails denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const ALICE = 'alice';
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();

/** A 25-cell board in the #457 WIRE shape — a MAP keyed by decimal index. */
function cells(overrides: Record<number, Record<string, unknown>> = {}) {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      String(index),
      {
        index,
        itemId: index === 12 ? null : `i${index}`,
        text: index === 12 ? 'FREE' : `Prompt ${index}`,
        free: index === 12,
        marked: index === 12,
        markedAt: null,
        ...(overrides[index] ?? {}),
      },
    ]),
  );
}

/** A per-cell PATCH — only the given cells, the shape every Mark writes. */
function cellsPatchOf(overrides: Record<number, Record<string, unknown>>) {
  const full = cells(overrides);
  return Object.fromEntries(Object.keys(overrides).map((i) => [String(i), full[String(i)]]));
}

const board = (uid: string, dayIndex: number, seed: number, overrides: Record<number, Record<string, unknown>> = {}) => ({
  uid,
  dayIndex,
  seed,
  createdAt: NOW(),
  cells: cells(overrides),
});

const dayBoardPath = (dayIndex: number, uid: string) => `events/${EVENT}/days/${dayIndex}/boards/${uid}`;

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId so this suite's clearFirestore never races
    // another concurrently-running rules file's seed (the house convention).
    projectId: 'demo-gaycruisebingo-echo-marks',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Three unlocked Days; Alice holds a card on each with distinct seeds, and a
// player row with zeroed aggregates.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [],
      days: [
        { index: 0, unlockAt: PAST(), pool: 'main', tutorial: false },
        { index: 1, unlockAt: PAST(), pool: 'main', tutorial: false },
        { index: 2, unlockAt: PAST(), pool: 'main', tutorial: false },
      ],
    });
    await setDoc(doc(d, `events/${EVENT}/players/${ALICE}`), {
      uid: ALICE,
      displayName: 'Alice',
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      reshufflesUsed: 0,
    });
    await setDoc(doc(d, dayBoardPath(0, ALICE)), board(ALICE, 0, 100));
    await setDoc(doc(d, dayBoardPath(1, ALICE)), board(ALICE, 1, 111));
    await setDoc(doc(d, dayBoardPath(2, ALICE)), board(ALICE, 2, 222));
  });
});

describe('the multi-board echo batch (spec § Mark-time)', () => {
  it('accepts the full mark-time batch: acted board + two echoed boards + player + marker, each board with ITS OWN markSeed', async () => {
    const d = db(ALICE);
    const batch = writeBatch(d);
    // The acted Mark on Day 0 (manual, confirmed).
    batch.set(
      doc(d, dayBoardPath(0, ALICE)),
      { cells: cellsPatchOf({ 3: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 100 },
      { merge: true },
    );
    // The echoes on Days 1 and 2, each stamped with THAT board's seed.
    batch.set(
      doc(d, dayBoardPath(1, ALICE)),
      { cells: cellsPatchOf({ 5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true } }), markSeed: 111 },
      { merge: true },
    );
    batch.set(
      doc(d, dayBoardPath(2, ALICE)),
      { cells: cellsPatchOf({ 8: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true } }), markSeed: 222 },
      { merge: true },
    );
    // The ONE aggregated player write.
    batch.set(
      doc(d, `events/${EVENT}/players/${ALICE}`),
      {
        dayStats: {
          0: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          1: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
          2: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        },
        bingoCount: 0,
        squaresMarked: 3,
        firstBingoAt: null,
        blackout: false,
      },
      { merge: true },
    );
    // The acted Mark's Tally marker (the single per-(Prompt, Player) slot).
    batch.set(doc(d, `events/${EVENT}/tally/i3/markers/${ALICE}`), {
      uid: ALICE,
      displayName: 'Alice',
      markedAt: NOW(),
      itemText: 'Prompt 3',
      dayIndex: 0,
    });
    await assertSucceeds(batch.commit());
  });

  it('REJECTS an echoed board write that borrows the SOURCE board\'s seed as its markSeed', async () => {
    const d = db(ALICE);
    const batch = writeBatch(d);
    batch.set(
      doc(d, dayBoardPath(0, ALICE)),
      { cells: cells({ 3: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 100 },
      { merge: true },
    );
    batch.set(
      doc(d, dayBoardPath(1, ALICE)),
      // markSeed 100 is Day 0's seed — Day 1's board is seeded 111, so this is
      // the stale/borrowed-seed write the per-board gate exists to reject.
      { cells: cells({ 5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true } }), markSeed: 100 },
      { merge: true },
    );
    await assertFails(batch.commit());
  });

  it('a cells-UNCHANGED metadata merge on a legacy-ARRAY straggler is allowed; a cells-changing patch on it stays denied (4b round-9 on #458)', async () => {
    // The canonical-25 gate binds writes that create a board or CHANGE its
    // cells. A not-yet-migrated straggler (array cells — the migration-gap
    // class the mop-up converges) must stay metadata-writable, while any
    // cells write on it is still denied (a patch would replace the whole
    // array field with a 1-key map — the 24-cell wipe the gate exists for).
    const legacy = { ...board(ALICE, 3, 333), cells: Object.values(cells()) };
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `events/${EVENT}`), {
        name: 'Cruise',
        status: 'active',
        admins: [],
        days: [
          { index: 0, unlockAt: PAST(), pool: 'main', tutorial: false },
          { index: 1, unlockAt: PAST(), pool: 'main', tutorial: false },
          { index: 2, unlockAt: PAST(), pool: 'main', tutorial: false },
          { index: 3, unlockAt: PAST(), pool: 'main', tutorial: false },
        ],
      });
      await setDoc(doc(ctx.firestore(), dayBoardPath(3, ALICE)), legacy);
    });
    const d = db(ALICE);
    await assertSucceeds(setDoc(doc(d, dayBoardPath(3, ALICE)), { lastOpenedAt: NOW() }, { merge: true }));
    await assertFails(
      setDoc(
        doc(d, dayBoardPath(3, ALICE)),
        { cells: cellsPatchOf({ 5: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 333 },
        { mergeFields: [new FieldPath('cells', '5'), 'markSeed'] },
      ),
    );
  });

  it('a CREATE without canonical cells is still denied — the metadata exemption never covers creates (4b round-9 on #458)', async () => {
    const d = db('bob');
    await assertFails(setDoc(doc(d, dayBoardPath(1, 'bob')), { uid: 'bob', dayIndex: 1, seed: 7, createdAt: NOW() }));
    await assertFails(
      setDoc(doc(d, dayBoardPath(1, 'bob')), {
        uid: 'bob',
        dayIndex: 1,
        seed: 7,
        createdAt: NOW(),
        cells: cellsPatchOf({ 5: { marked: false } }), // partial map — not canonical
      }),
    );
  });

  it('a mergeFields cell write passes the rules AND replaces the cell WHOLESALE — omission-removed fields (echo) do not survive (4b round-8 on #458)', async () => {
    // The client writes patches as set(..., { mergeFields: [FieldPath('cells', i), ...] })
    // precisely because { merge: true } deep-merges nested maps: a transform
    // that strips `echo` by destructuring (attachProof / deleteProof / manual
    // unmark) would otherwise leave the stored `echo: true` standing. Seed an
    // echoed cell, rewrite it without the flag, and prove BOTH halves: the
    // rules accept the mergeFields post-image, and the flag is gone on read.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), dayBoardPath(0, ALICE)),
        board(ALICE, 0, 100, { 5: { marked: true, markedAt: 1, status: 'confirmed', echo: true } }),
      );
    });
    const d = db(ALICE);
    const proofed = cellsPatchOf({ 5: { marked: true, markedAt: NOW(), status: 'confirmed', proofId: 'p1' } });
    await assertSucceeds(
      setDoc(
        doc(d, dayBoardPath(0, ALICE)),
        { cells: proofed, markSeed: 100 },
        { mergeFields: [new FieldPath('cells', '5'), 'markSeed'] },
      ),
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), dayBoardPath(0, ALICE)));
      const stored = (snap.data() as { cells: Record<string, Record<string, unknown>> }).cells;
      expect(stored['5'].proofId).toBe('p1');
      expect('echo' in stored['5']).toBe(false); // replaced wholesale, not deep-merged
      expect(stored['3'].marked).toBe(false); // sibling cells untouched by the mask
    });
  });

  it('a STALE-markSeed Mark batch is rejected WHOLE — board patch, player projection, and Tally marker all roll back (4b round-6 on #458)', async () => {
    // The stale-seed recovery story under per-cell patches IS batch atomicity:
    // setMark computes its player/tally side effects from the cached board and
    // commits them in the SAME writeBatch as the board patch, so a reshuffle
    // that invalidates the queued Mark (seededMarkGuard denies markSeed 99 on
    // a board seeded 100) must take the derived writes down with it — no
    // partial projection may land for a Mark that never applied. (Moments and
    // meta pins are commit-ack gated in setMark for the same reason.)
    const d = db(ALICE);
    const batch = writeBatch(d);
    batch.set(
      doc(d, dayBoardPath(0, ALICE)),
      { cells: cellsPatchOf({ 3: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 99 },
      { merge: true },
    );
    batch.set(
      doc(d, `events/${EVENT}/players/${ALICE}`),
      { dayStats: { 0: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null } }, squaresMarked: 1 },
      { merge: true },
    );
    batch.set(doc(d, `events/${EVENT}/tally/i3/markers/${ALICE}`), {
      uid: ALICE,
      displayName: 'Alice',
      markedAt: NOW(),
      itemText: 'Prompt 3',
      dayIndex: 0,
    });
    await assertFails(batch.commit());
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const raw = ctx.firestore();
      const boardSnap = await getDoc(doc(raw, dayBoardPath(0, ALICE)));
      expect((boardSnap.data() as { cells: Record<string, { marked: boolean }> }).cells['3'].marked).toBe(false);
      const playerSnap = await getDoc(doc(raw, `events/${EVENT}/players/${ALICE}`));
      expect((playerSnap.data() as { squaresMarked: number }).squaresMarked).toBe(0);
      const markerSnap = await getDoc(doc(raw, `events/${EVENT}/tally/i3/markers/${ALICE}`));
      expect(markerSnap.exists()).toBe(false);
    });
  });

  it('REJECTS an echoed board write with no markSeed at all on a seeded board', async () => {
    await assertFails(
      setDoc(
        doc(db(ALICE), dayBoardPath(1, ALICE)),
        { cells: cells({ 5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true } }) },
        { merge: true },
      ),
    );
  });

  it('#457: two devices marking DIFFERENT cells of one board both land — per-cell patches merge', async () => {
    // The structural replacement for the retired markVersion counter: each
    // write carries only its own cell, so neither can clobber the other no
    // matter the order or staleness of the writers.
    const d = db(ALICE);
    await assertSucceeds(
      setDoc(
        doc(d, dayBoardPath(1, ALICE)),
        { cells: cellsPatchOf({ 5: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 111 },
        { merge: true },
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(d, dayBoardPath(1, ALICE)),
        { cells: cellsPatchOf({ 8: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 111 },
        { merge: true },
      ),
    );
    // Both Marks stand on the stored doc — nothing was overwritten.
    const stored = await getDoc(doc(db(ALICE), dayBoardPath(1, ALICE)));
    const storedCells = stored.data()!.cells as Record<string, { marked: boolean }>;
    expect(storedCells['5'].marked).toBe(true);
    expect(storedCells['8'].marked).toBe(true);
  });

  it('#457: REJECTS a one-cell patch onto a STILL-ARRAY board — the migration-gap 24-cell wipe', async () => {
    // A merge patch landing on a board whose stored cells are the legacy
    // ARRAY replaces the whole field with a one-key map. The canonical-25
    // requirement denies it (Phase 4b P1 on #458) instead of blessing the
    // loss of the other 24 cells.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), dayBoardPath(1, ALICE)), {
        ...board(ALICE, 1, 111),
        cells: Object.values(cells()), // legacy array-shaped stored doc
      });
    });
    await assertFails(
      setDoc(
        doc(db(ALICE), dayBoardPath(1, ALICE)),
        { cells: cellsPatchOf({ 5: { marked: true, markedAt: NOW(), status: 'confirmed' } }), markSeed: 111 },
        { merge: true },
      ),
    );
  });

  it('#457: REJECTS a legacy ARRAY cells write — the resulting field must be the map', async () => {
    await assertFails(
      setDoc(
        doc(db(ALICE), dayBoardPath(1, ALICE)),
        { cells: Object.values(cells({ 5: { marked: true, markedAt: NOW(), status: 'confirmed' } })), markSeed: 111 },
        { merge: true },
      ),
    );
  });
});

describe("boardPristine()'s echo exemption (spec § Reshuffle pristine-ness)", () => {
  const reshuffle = async (dayIndex: number, existingSeed: number) => {
    const d = db(ALICE);
    const batch = writeBatch(d);
    batch.set(doc(d, dayBoardPath(dayIndex, ALICE)), { ...board(ALICE, dayIndex, existingSeed + 1), markVersion: 1 });
    batch.set(doc(d, `events/${EVENT}/players/${ALICE}`), { reshufflesUsed: 1 }, { merge: true });
    // The per-spend marker the #463 gate requires alongside the counter +1.
    batch.set(doc(d, `events/${EVENT}/reshuffles/${ALICE}-1`), {
      uid: ALICE,
      n: 1,
      dayIndex,
      createdAt: NOW(),
    });
    return batch.commit();
  };

  it('an ECHO-ONLY card is still pristine — the reshuffle is allowed', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), dayBoardPath(1, ALICE)),
        board(ALICE, 1, 111, { 5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true } }),
      );
    });
    await assertSucceeds(reshuffle(1, 111));
  });

  it('a MANUALLY-marked card is not pristine — the reshuffle is denied', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), dayBoardPath(1, ALICE)),
        board(ALICE, 1, 111, { 5: { marked: true, markedAt: NOW(), status: 'confirmed' } }),
      );
    });
    await assertFails(reshuffle(1, 111));
  });

  it('one manual Mark among echoes still blocks — the exemption is per-cell, not per-card', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), dayBoardPath(1, ALICE)),
        board(ALICE, 1, 111, {
          5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true },
          7: { marked: true, markedAt: NOW(), status: 'confirmed' },
        }),
      );
    });
    await assertFails(reshuffle(1, 111));
  });

  it('a proof-backed Echo is not pristine — the proof cannot be stranded by a reshuffle', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), dayBoardPath(1, ALICE)),
        board(ALICE, 1, 111, {
          5: { marked: true, markedAt: NOW(), status: 'confirmed', echo: true, proofId: 'proof-1' },
        }),
      );
    });
    await assertFails(reshuffle(1, 111));
  });
});
