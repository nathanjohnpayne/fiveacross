import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { FieldPath, doc, setDoc, writeBatch } from 'firebase/firestore';

// ------------------------------------------------------------------- #387 ---
// DEPLOYED-BUNDLE WIRE COMPAT for the Mark write. This fixture is a FROZEN,
// hand-written copy of the exact batch the CURRENTLY DEPLOYED client emits for
// one confirmed Mark (setMark, src/data/api.ts): the per-cell `mergeFields`
// board patch stamping `markSeed`, the player-stats fold merge, and the Tally
// marker create. It deliberately does NOT call setMark — the point is that
// this file only changes when someone consciously updates it to a NEW client
// wire shape.
//
// WHY. The 2026-07-17 production incident (#387): a rules deploy (the #383
// `seededMarkWriteOk` gate) landed while players still ran older bundles kept
// alive by sticky PWA shells. Those bundles' mark batches stopped satisfying
// the rules, every mark was PERMISSION_DENIED, and players watched their
// squares revert. The client's own suites could not catch it: they exercise
// the NEW client against the NEW rules, which is exactly the pair that always
// agrees (Codex P1 on PR #470).
//
// THE CONTRACT THIS SUITE ENFORCES: a rules change that would deny the wire
// shape ALREADY IN PLAYERS' HANDS during an explicitly open compatibility
// window fails here, in CI, before it can ship. The fixture itself remains
// frozen and fieldless; markerDeliveryCompatibility/current is the bounded,
// server-owned stale-shell story that admits it during the rollout. The
// `mark_rejected` analytics event (src/data/api.ts) is the production-side
// tripwire if a skew ships anyway.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const ALICE = 'alice';
// The control's subject: a board whose STORED doc has never carried a
// `markSeed` field — the shape every board had on 2026-07-17 (the field only
// lands on a doc once a post-#383 client marks it). The denial under test
// evaluates the POST-image, so a doc that already carries `markSeed` would
// carry it through a stale write's merge and vacuously pass the gate.
const BOB = 'bob';
const DAY = 0;
const HOUR = 3_600_000;
const BOARD_SEED = 42;
const MARK_INDEX = 7;

// The stored board: the #457 canonical cells MAP (25 decimal keys), seeded.
function storedCellsMap(): Record<string, unknown> {
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
      },
    ]),
  );
}

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-mark-wire-compat',
    firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EVENT), {
      name: 'Cruise',
      status: 'active',
      admins: [],
      days: [{ index: DAY, unlockAt: Date.now() - 2 * HOUR, pool: 'main', tutorial: false }],
    });
    await setDoc(doc(db, 'markerDeliveryCompatibility', 'current'), {
      schemaVersion: 1,
      projectId: 'demo-mark-wire-compat',
      acceptLegacyUntil: Date.now() + HOUR,
    });
    for (const uid of [ALICE, BOB]) {
      await setDoc(doc(db, 'events', EVENT, 'days', String(DAY), 'boards', uid), {
        uid,
        dayIndex: DAY,
        seed: BOARD_SEED,
        createdAt: Date.now() - HOUR,
        cells: storedCellsMap(),
      });
      // A returning player WITH a spent reshuffle: the fold's merge write must
      // carry the monotonic counter through untouched, not trip it.
      await setDoc(doc(db, 'events', EVENT, 'players', uid), {
        uid,
        displayName: uid === ALICE ? 'Alice' : 'Bob',
        joinedAt: Date.now() - HOUR,
        bingoCount: 0,
        squaresMarked: 0,
        firstBingoAt: null,
        blackout: false,
        reshufflesUsed: 1,
      });
    }
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

/**
 * The frozen wire batch. Byte-for-byte the shape setMark commits for one
 * confirmed honor Mark on a seeded day board (no echoes standing):
 *  1. board: `set(ref, { cells: { '<i>': cell }, markSeed }, { mergeFields:
 *     [FieldPath('cells','<i>'), 'markSeed'] })` — the #457/#458 per-cell
 *     mask via `cellsMergeSet` (src/data/cellsMerge.ts).
 *  2. player: the `foldDayStat` aggregate under `{ merge: true }`.
 *  3. tally marker: the attributed, day-stamped create.
 */
function deployedMarkBatch(
  env: RulesTestEnvironment,
  opts: { omitMarkSeed?: boolean; uid?: string } = {},
) {
  const uid = opts.uid ?? ALICE;
  const db = env.authenticatedContext(uid).firestore();
  const now = Date.now();
  const markedCell = {
    index: MARK_INDEX,
    itemId: `i${MARK_INDEX}`,
    text: `Prompt ${MARK_INDEX}`,
    free: false,
    marked: true,
    markedAt: now,
    status: 'confirmed',
  };
  const batch = writeBatch(db);
  batch.set(
    doc(db, 'events', EVENT, 'days', String(DAY), 'boards', uid),
    {
      cells: { [String(MARK_INDEX)]: markedCell },
      ...(opts.omitMarkSeed ? {} : { markSeed: BOARD_SEED }),
    },
    {
      mergeFields: [
        new FieldPath('cells', String(MARK_INDEX)),
        ...(opts.omitMarkSeed ? [] : ['markSeed']),
      ],
    },
  );
  batch.set(
    doc(db, 'events', EVENT, 'players', uid),
    {
      squaresMarked: 1,
      bingoCount: 0,
      blackout: false,
      firstBingoAt: null,
      dayStats: {
        [String(DAY)]: {
          dayIndex: DAY,
          squaresMarked: 1,
          bingoCount: 0,
          blackout: false,
          firstBingoAt: null,
        },
      },
    },
    { merge: true },
  );
  batch.set(doc(db, 'events', EVENT, 'tally', `i${MARK_INDEX}`, 'markers', uid), {
    uid,
    displayName: uid === ALICE ? 'Alice' : 'Bob',
    markedAt: now,
    itemText: `Prompt ${MARK_INDEX}`,
    dayIndex: DAY,
  });
  return batch;
}

describe('deployed-bundle Mark wire compat (#387)', () => {
  it('the frozen deployed wire shape is ACCEPTED while the compatibility window is open', async () => {
    await assertSucceeds(deployedMarkBatch(testEnv).commit());
  });

  it('control: without markSeed the same batch is DENIED — the #387 incident shape', async () => {
    // Documents that the seed stamp is load-bearing in the deployed contract
    // (and that this suite is actually exercising the gate, not vacuously
    // passing): dropping it reproduces exactly the denial stale pre-#383
    // bundles hit on 2026-07-17. Runs as BOB, whose stored board has never
    // carried `markSeed` — the incident's stored shape; once a new client has
    // marked a board (Alice's, above), the stored stamp merges through a
    // later seed-less write's post-image and the gate passes it by design.
    await assertFails(deployedMarkBatch(testEnv, { omitMarkSeed: true, uid: BOB }).commit());
  });
});
