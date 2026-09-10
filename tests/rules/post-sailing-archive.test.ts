import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { clearStorageDeep } from '../support/storage-emulator';
// The WRITER's half of the representable-number contract this arm enforces
// (#1151, Codex P1 on PR #1162). Imported rather than restated so the two cannot
// drift: `src/data/eventArchive.ts` clamps every number it copies to this value,
// and the cases below prove it is exactly the largest one `finiteArchiveNumber`
// accepts. (`src/data/eventLimits.ts` is already imported this way by
// `tests/rules/membership-mark-batch-budget.test.ts`.)
import { MAX_ARCHIVE_NUMBER } from '../../src/data/eventArchive';

// specs/post-sailing-archive.md, rules layer (#1149, epic #134). Three claims,
// proved in pairs so none can pass vacuously:
//
//   1. Every GAMEPLAY write that succeeds while the Event is live is DENIED on
//      BOTH halves of the freeze — the reversible CLOSING state and the
//      permanent ARCHIVED one — Firestore documents and the Storage proof media
//      alike. `specs/path-addressing-and-root.md` § D8 is explicit that hiding
//      the controls client-side would not satisfy this, so each case here is a
//      direct SDK write, not a UI path.
//   2. Admin MODERATION and administration keep working on an archived Event
//      (#808: "an archive that locks out its own Admin is a support incident"),
//      and READS are untouched — the archived read posture is #808's question,
//      not this ticket's.
//   3. The lifecycle transition itself is admin-only, ordered (`archived` only
//      from a quiesced Event), bound to the generation that quiesce minted, and
//      WRITE-ONCE once taken.
//
// WHAT IS NOT HERE, deliberately: the durable `EventArchive` record and its
// whole-record validation (#1151). The lifecycle work freezes the Event; it does
// not yet snapshot the standings, so the flip arm carries `status`, `archivedAt`
// and the cleared quiesce and nothing else.
//
// The LAST describe below is #1153's media-revocation tombstone, which is not a
// freeze arm at all: it is what makes the reordered takedown durable, and it
// belongs here because the property that matters most about it is that it can
// never become a new way for the takedown to fail on a frozen Event.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected
// assertFails denials, not test failures.

const firestoreRules = readFileSync(
  fileURLToPath(new URL('../../firestore.rules', import.meta.url)),
  'utf8',
);
const storageRules = readFileSync(
  fileURLToPath(new URL('../../storage.rules', import.meta.url)),
  'utf8',
);

const EVENT = 'archive-event';
const LEGACY_EVENT = 'archive-legacy-event';
const ALICE = 'alice';
const BOB = 'bob';
const ADMIN = 'admin-uid';
const ITEM = 'prompt-1';
const PROOF = 'proof-1';
/** A SECOND seeded Proof document, so the Storage cases have two distinct media
 *  objects a live Proof still points at — the shape the freeze protects, as
 *  opposed to the ORPHANED blob the delete arm's carve-out releases (#1157). */
const PROOF_MEDIA = 'proof-media';
/** A Proof owned by the ADMIN, so one identity is BOTH the media's owner and an
 *  entry in the Event's `admins` roster — the overlapping-role case the round-4
 *  delete tests missed, where a per-branch `proofDocMissing` still let the admin
 *  branch empty a live Proof's path (#1153, Codex round 5 P2). */
const ADMIN_PROOF = 'proof-admin';
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;

/** The freeze stamp every archive write in this file carries. Fixed rather than
 *  `Date.now()` so the write-once assertions can restate it exactly. */
const ARCHIVED_AT = 1_700_000_000_000;

/** The frozen record every archive write in this file carries (#1151): one
 *  well-formed `EventArchive`, so the complete-record clause has a control to be
 *  measured against and the write-once lock has something to protect. Its own
 *  `archivedAt` IS `ARCHIVED_AT` — the rules require the record's stamp to equal
 *  the document's, and the writer produces both from one value in one update. */
const FROZEN_RECORD = {
  // The Event's own name, frozen with the standings it titles (#1139) —
  // `EventDoc.name` is outside the write-once clause, so a card that rebuilt its
  // title from the live field drifted the moment an Admin renamed the Event.
  eventName: 'Archive fixture',
  standings: [
    {
      uid: ALICE,
      displayName: 'Alice',
      bingoCount: 2,
      squaresMarked: 14,
      blackout: false,
      firstBingoAt: 1000,
    },
  ],
  playerCount: 1,
  firstBingo: { uid: ALICE, displayName: 'Alice', at: 1000 },
  firstBingoRow: {
    uid: ALICE,
    displayName: 'Alice',
    bingoCount: 2,
    squaresMarked: 14,
    blackout: false,
    firstBingoAt: 1000,
    rank: 1,
  },
  dailyHonors: [
    { dayIndex: 0, uid: ALICE, displayName: 'Alice', firstBingoAt: 1000, dayLabel: '🌈 D1' },
  ],
  freezeAt: null,
  archivedAt: ARCHIVED_AT,
};

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const unauthDb = () => testEnv.unauthenticatedContext().firestore();
const storageOf = (uid: string) => testEnv.authenticatedContext(uid).storage();

const eventPath = (eventId = EVENT) => `events/${eventId}`;
// `uploadProofMedia` writes `proofs/{eventId}/{uid}/{proofId}.{ext}`, so the
// object's basename IS the Proof id — which is how the delete arm tells media a
// Proof document still points at from an orphaned blob (#1157).
const photoPath = `proofs/${EVENT}/${ALICE}/${PROOF}.jpg`;
const mediaProofPath = `proofs/${EVENT}/${ALICE}/${PROOF_MEDIA}.jpg`;
const TINY = new Uint8Array(64);
const IMAGE = { contentType: 'image/jpeg' };

/** A canonical 25-key cells map (#457) — the shape the Board write rule requires. */
function cells(marked: number[] = []): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      String(index),
      {
        index,
        itemId: index === 12 ? null : `${ITEM}-${index}`,
        text: index === 12 ? 'FREE' : `Prompt ${index}`,
        free: index === 12,
        marked: index === 12 || marked.includes(index),
        markedAt: marked.includes(index) ? NOW() : null,
      },
    ]),
  );
}

beforeAll(async () => {
  // The Storage `firestore.get()` cross-service read resolves against the
  // emulator's OWN project (GCLOUD_PROJECT), not the client-supplied projectId,
  // so the archived Event document has to live there for the Storage half of
  // this suite to see it — the same binding `w0-storage-rules.test.ts` documents.
  // Safe despite the shared namespace because the rules layer runs its files
  // serially (`fileParallelism: false`, vitest.rules.config.ts).
  const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  const [stHost, stPort] = (
    process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199'
  ).split(':');
  testEnv = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? 'gaycruisebingo',
    firestore: { host: fsHost, port: Number(fsPort), rules: firestoreRules },
    storage: { host: stHost, port: Number(stPort), rules: storageRules },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// A live Event mid-play: two unlocked Days, Alice joined with a Board, one
// active Prompt, one active Proof, and a standing Tally marker — so every
// gameplay write below has the precondition its own rule demands and the ONLY
// variable between the "live" and "closed" halves is the freeze.
/** The seeded Proof's own `createdAt` — the incarnation stamp a Heart write has
 *  to echo back exactly, so the live control in that case is a real success. */
let proofCreatedAt = 0;

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Deep, because `testEnv.clearStorage()` lists only the bucket root and every
  // object here lives under a prefix — see tests/support/storage-emulator.ts.
  await clearStorageDeep(testEnv);
  proofCreatedAt = NOW();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, eventPath()), {
      name: 'Archive fixture',
      status: 'active',
      admins: [ADMIN],
      bannedUids: [],
      claimMode: 'honor',
      settings: { reportHideThreshold: 3 },
      timezone: 'Europe/Rome',
      days: [
        { index: 0, unlockAt: PAST(), theme: 'neon-playground', pool: 'main', tutorial: false },
        { index: 1, unlockAt: PAST(), theme: 'get-sporty', pool: 'main', tutorial: false },
      ],
    });
    // A legacy Event document that carries NO `status` key at all — the shape
    // every Event written before this ticket has.
    await setDoc(doc(fs, eventPath(LEGACY_EVENT)), {
      name: 'Legacy fixture',
      admins: [ADMIN],
      bannedUids: [],
      settings: { reportHideThreshold: 3 },
      days: [{ index: 0, unlockAt: PAST(), theme: 'neon-playground', pool: 'main' }],
    });
    await setDoc(doc(fs, `${eventPath()}/players/${ALICE}`), {
      uid: ALICE,
      displayName: 'Alice',
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      reshufflesUsed: 0,
    });
    await setDoc(doc(fs, `${eventPath()}/days/0/boards/${ALICE}`), {
      uid: ALICE,
      dayIndex: 0,
      seed: 7,
      createdAt: NOW(),
      cells: cells(),
    });
    await setDoc(doc(fs, `${eventPath()}/items/${ITEM}`), {
      text: 'Something happens',
      createdBy: 'seed',
      pool: 'main',
      status: 'active',
      reportCount: 0,
      spicy: false,
    });
    const seededProof = (cellIndex: number) => ({
      uid: ALICE,
      displayName: 'Alice',
      photoURL: null,
      type: 'text',
      cellIndex,
      itemText: 'Something happens',
      storagePath: null,
      mediaURL: null,
      thumbURL: null,
      text: 'it happened',
      createdAt: proofCreatedAt,
      reportCount: 0,
      status: 'active',
      visionFlag: null,
      source: null,
      dayIndex: 0,
    });
    await setDoc(doc(fs, `${eventPath()}/proofs/${PROOF}`), seededProof(3));
    await setDoc(doc(fs, `${eventPath()}/proofs/${PROOF_MEDIA}`), seededProof(4));
    // Alice's standing Mark on the shared Prompt — the precondition a Doubt
    // against her needs, and the marker whose own writes freeze below.
    await setDoc(doc(fs, `${eventPath()}/tally/${ITEM}/markers/${ALICE}`), {
      eventId: EVENT,
      uid: ALICE,
      displayName: 'Alice',
      markedAt: NOW(),
      itemText: 'Something happens',
      dayIndex: 0,
    });
  });
});

/** The generation `beginArchive` mints per quiesce (#1139): `archiving: true`
 *  says the Event is shut, never WHICH shut, and the flip is bound to the one
 *  the caller took. A MONOTONIC positive integer since Phase 4b P1 on PR #1157
 *  run 4 — see "REFUSES a generation that was already in force" below. */
const QUIESCE = 1;

/** Shut the Event out-of-band into the archive's QUIESCING phase — gameplay
 *  denied, nothing permanent — so the paired gameplay cases can prove the
 *  closing half of the freeze denies exactly what the archived half does. */
async function quiesce(token: number = QUIESCE): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: true, archiveToken: token });
  });
}

/** Freeze the Event out-of-band, so each gameplay case can prove the SAME write
 *  succeeding before and failing after with nothing else changed. */
async function freeze(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), eventPath()), {
      status: 'archived',
      archivedAt: ARCHIVED_AT,
      archiving: false,
      archivedUnder: QUIESCE,
      // The frozen record lands with the stamp (#1151), so the archived-state
      // cases exercise the same document the flip actually produces — and the
      // write-once lock has a record to protect.
      archive: FROZEN_RECORD,
    });
  });
}

/** The archive flip as the rules accept it: the three transition keys, the
 *  flip-only binding, the frozen record, and nothing else. */
const flip = (uid: string, overrides: Record<string, unknown> = {}) =>
  updateDoc(doc(db(uid), eventPath()), {
    status: 'archived',
    archivedAt: ARCHIVED_AT,
    archiving: false,
    // The flip-only binding (Phase 4b P1, PR #1157 run 3): must be written by
    // the flip and equal the stored generation. `quiesce()` stores QUIESCE.
    archivedUnder: QUIESCE,
    // The durable record (#1151). `completeArchiveRecord` requires it whole, so
    // every flip in this file carries it and the cases below vary it.
    archive: FROZEN_RECORD,
    ...overrides,
  });

describe('post-sailing-archive — the archive toggle is admin-only and write-once', () => {
  it('ALLOWS an admin to flip status and stamp archivedAt from a quiesced Event', async () => {
    await quiesce();
    await assertSucceeds(flip(ADMIN));
  });

  it('DENIES a Player archiving the Event', async () => {
    await quiesce();
    await assertFails(flip(ALICE));
  });

  it('DENIES an unauthenticated archive', async () => {
    await quiesce();
    await assertFails(
      updateDoc(doc(unauthDb(), eventPath()), { status: 'archived', archivedAt: NOW() }),
    );
  });

  it('DENIES a status value outside the contract, even from an admin', async () => {
    // A typo'd status reads as OPEN through `eventOpenForPlay`'s 'active'
    // default, so an organiser could believe an Event was frozen while it still
    // took Marks. Rejecting it is the loud failure instead of the silent one.
    for (const bad of ['Archived', 'closed', 'finished', 1, true, null]) {
      await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { status: bad }));
    }
  });

  it('DENIES archiving without a numeric, bounded archivedAt stamp', async () => {
    await quiesce();
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { status: 'archived', archiving: false }),
    );
    for (const bad of ['now', 0, -1, Number.POSITIVE_INFINITY]) {
      await assertFails(flip(ADMIN, { archivedAt: bad }));
    }
  });

  it('DENIES a stray archivedAt on a live Event through the general admin arm', async () => {
    // Codex P2, PR #1157. The general arm type-checked the stamp but not the
    // state it belongs to, so an admin write of `archivedAt` alone left an
    // ACTIVE Event carrying a false archive audit stamp. The field exists only
    // on an archived document; the quiesced flip arm is where it is introduced.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedAt: NOW() }));
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { status: 'active', archivedAt: NOW() }),
    );
    // The same admin still edits everything else on the live Event.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
  });

  it('LOCKS status, archivedAt and the frozen record once archived', async () => {
    await freeze();
    // Un-archiving is not a client operation at all.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { status: 'active' }));
    // Nor is re-stamping the freeze.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedAt: NOW() }));
    // …nor rewriting the record with a later roster (#1151). This is what "the
    // final Leaderboard and hall of fame persist unchanged" means at the
    // boundary: a second archive pass cannot overwrite what the first froze.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        archive: { ...FROZEN_RECORD, standings: [], playerCount: 0 },
      }),
    );
    // Not even a single field of it, and not by removing it either.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        archive: { ...FROZEN_RECORD, eventName: 'Renamed after the fact' },
      }),
    );
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archive: deleteField() }));
    // Nor the binding the flip wrote.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedUnder: QUIESCE + 1 }));
    // A partial update that does not mention them carries them through
    // unchanged, so the lock never freezes the rest of the document.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
    // …and echoing the same values back explicitly is still fine.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        archive: FROZEN_RECORD,
      }),
    );
  });

  it('DENIES a stray record on a LIVE Event through the general admin arm', async () => {
    // `archive` joins the protected set for the same reason `archivedAt` did
    // (Codex P2, PR #1157): the field exists only on an archived document, and
    // the quiesced flip arm is the one place it is introduced. An admin write
    // that dropped a record onto a live Event would leave the archived surfaces
    // with something to render on an Event still taking Marks.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archive: FROZEN_RECORD }));
    // Nor on a CLOSING one, where the flip has not committed yet.
    await quiesce();
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archive: FROZEN_RECORD }));
    // The same admin still edits everything else in both states.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
  });

  it('DENIES an admin writing the finale-completion marker, in every state', async () => {
    // #1151, Codex P1 on PR #1162. `finaleCompletedAt` is the composite marker
    // the scheduler stamps once the freeze stamp AND the podium Moment have both
    // landed, and it is what the console's pre-flip acknowledgement is decided
    // on. An admin who could write it could clear the one warning standing
    // between a podium that has not posted yet and an irreversible archive that
    // forgoes it — so it is server-written only. The Admin SDK bypasses these
    // rules; no client arm may name it.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: NOW() }));
    // …nor while the Event is closing, where the flip is one tap away.
    await quiesce();
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: NOW() }));
    // The flip itself may not smuggle it either — the arm's `hasOnly` guard
    // names five keys and this is not one of them.
    await assertFails(flip(ADMIN, { finaleCompletedAt: NOW() }));
    // …and it is still refused once archived, where nothing about the finale
    // can be true any more.
    await freeze();
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: NOW() }));
    // The same admin still edits everything else in every one of those states.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
  });

  it('leaves the SERVER’s own marker alone on an ordinary admin write', async () => {
    // Restating an unchanged value is not a change, so a whole-document admin
    // write still passes on an Event the scheduler has already marked — the
    // field is unwritable, not a tripwire on every write beside it.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), {
        frozenAt: 1_700_000_000_000,
        finaleCompletedAt: 1_700_000_060_000,
      });
    });
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: 1_700_000_060_000 }),
    );
    // Moving it by one millisecond, or clearing it, is refused.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: 1_700_000_060_001 }),
    );
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { finaleCompletedAt: deleteField() }));
  });
});

// #1151. The flip is irreversible and the record is what the rules then lock, so
// a flip that lands `{status: 'archived', archivedAt}` with no record — or a
// half-built one — is permanent and useless at the same time: the freeze denies
// every gameplay write while the archived surfaces fall back to the LIVE view
// the record exists to replace. `completeArchiveRecord` is what makes "an
// archived Event always carries a whole record" an enforced invariant rather
// than a property of one client's writer.
describe('post-sailing-archive — the archive write must carry the whole record', () => {
  const archiveWith = (record: unknown) => flip(ADMIN, { archive: record });

  beforeEach(async () => {
    await quiesce();
  });

  it('DENIES the flip with no record at all, or an empty one', async () => {
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        archiving: false,
        archivedUnder: QUIESCE,
      }),
    );
    await assertFails(archiveWith({}));
  });

  it('DENIES a record missing any top-level key', async () => {
    for (const key of [
      'eventName',
      'standings',
      'playerCount',
      'firstBingo',
      // The headline holder's kept row is part of the whole record: a card that
      // names a First to BINGO it cannot print a row for is the half-built map
      // this arm exists to refuse.
      'firstBingoRow',
      'dailyHonors',
      'freezeAt',
      'archivedAt',
    ] as const) {
      const partial: Record<string, unknown> = { ...FROZEN_RECORD };
      delete partial[key];
      await assertFails(archiveWith(partial));
    }
  });

  it('DENIES a record whose keys carry the wrong types', async () => {
    for (const wrong of [
      { eventName: 7 },
      { standings: 'none' },
      { playerCount: '1' },
      { firstBingo: 'Alice' },
      { firstBingoRow: 'Alice' },
      { dailyHonors: {} },
      { freezeAt: 'never' },
      { archivedAt: 'then' },
    ]) {
      await assertFails(archiveWith({ ...FROZEN_RECORD, ...wrong }));
    }
  });

  // Codex P2, PR #1139 round 4. `firstBingo` and `firstBingoRow` were typed
  // INDEPENDENTLY, which accepted the two shapes the pairing exists to refuse:
  // one present beside the other null (the half-built record the archived Share
  // Card reads a hole from), and two maps naming DIFFERENT holders (one name in
  // the hall of fame's headline, another on the pinned eleventh row of the same
  // card). They are selected together, so they are validated together.
  it('DENIES a First-BINGO honour and a kept row that do not agree', async () => {
    // An honour with no row to print for it…
    await assertFails(archiveWith({ ...FROZEN_RECORD, firstBingoRow: null }));
    // …and a row belonging to an honour the record does not name.
    await assertFails(archiveWith({ ...FROZEN_RECORD, firstBingo: null }));
    // Two maps, two different Players: the headline and the pinned row would
    // disagree on the same card.
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, uid: BOB },
      }),
    );
    await assertFails(
      archiveWith({ ...FROZEN_RECORD, firstBingo: { ...FROZEN_RECORD.firstBingo, uid: BOB } }),
    );
    // A holder with no usable id on either half is refused for the same reason
    // the pairing exists: there is nothing to match the two against.
    await assertFails(
      archiveWith({ ...FROZEN_RECORD, firstBingo: { ...FROZEN_RECORD.firstBingo, uid: 7 } }),
    );
  });

  // Codex P2 on PR #1162. Matching uids prove the two halves agree about WHO;
  // they say nothing about whether either half can be RENDERED. Two uid-only
  // maps satisfied the pairing, so a direct admin write could flip an Event
  // whose headline honour had no name and no instant and whose kept row had
  // none of the standings fields and no rank — irreversibly, into the record
  // the archived Leaderboard and Share Card read from.
  it('DENIES a uid-only First-BINGO pair, which names a holder nothing can render', async () => {
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        firstBingo: { uid: ALICE },
        firstBingoRow: { uid: ALICE },
      }),
    );
  });

  it('DENIES a half-built honour or kept row, field by field', async () => {
    // Each scalar `ArchivedFirstBingo` declares, dropped one at a time. An
    // absent key errors the expression and denies, exactly as a missing
    // top-level key does.
    for (const key of ['uid', 'displayName', 'at'] as const) {
      const honor: Record<string, unknown> = { ...FROZEN_RECORD.firstBingo };
      delete honor[key];
      await assertFails(archiveWith({ ...FROZEN_RECORD, firstBingo: honor }));
    }
    // …and each scalar `ArchivedFirstBingoRow` declares, `rank` included: it is
    // the whole reason the row is carried outside the bounded prefix, so a row
    // without it cannot print the pinned eleventh line it exists for.
    for (const key of [
      'uid',
      'displayName',
      'bingoCount',
      'squaresMarked',
      'blackout',
      'firstBingoAt',
      'rank',
    ] as const) {
      const row: Record<string, unknown> = { ...FROZEN_RECORD.firstBingoRow };
      delete row[key];
      await assertFails(archiveWith({ ...FROZEN_RECORD, firstBingoRow: row }));
    }
  });

  it('DENIES an honour or kept row whose fields carry the wrong types', async () => {
    for (const wrong of [{ displayName: 7 }, { at: 'first thing' }]) {
      await assertFails(
        archiveWith({ ...FROZEN_RECORD, firstBingo: { ...FROZEN_RECORD.firstBingo, ...wrong } }),
      );
    }
    for (const wrong of [
      { displayName: 7 },
      { bingoCount: '2' },
      { squaresMarked: '14' },
      { blackout: 'no' },
      { firstBingoAt: 'first thing' },
      { rank: '1' },
    ]) {
      await assertFails(
        archiveWith({
          ...FROZEN_RECORD,
          firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, ...wrong },
        }),
      );
    }
  });

  // CodeRabbit, PR #1162. `is number` admits `NaN` and both infinities — they
  // are Firestore doubles like any other — so the irreversible flip could
  // persist them, and the archived Leaderboard and Share Card the record exists
  // to feed would render exactly that, forever. Rules have no `isFinite()`, so
  // the estate's own magnitude idiom stands in for it.
  it('DENIES a non-finite number anywhere in the First-BINGO pair', async () => {
    // Firestore's wire format carries these as doubles, so they reach the rules
    // as numbers — which is the whole point of the finding.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await assertFails(
        archiveWith({
          ...FROZEN_RECORD,
          firstBingo: { ...FROZEN_RECORD.firstBingo, at: bad },
        }),
      );
      for (const field of ['bingoCount', 'squaresMarked', 'firstBingoAt'] as const) {
        await assertFails(
          archiveWith({
            ...FROZEN_RECORD,
            firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, [field]: bad },
          }),
        );
      }
    }
  });

  it('DENIES a rank that names no place in the standings', async () => {
    // The one field the writer COMPUTES rather than copies (`holderAt + 1` over
    // a non-negative index), so it can be held to more than finiteness: a
    // positive integer. A fractional rank is stored as a double and fails
    // `is int`; 0 and a negative one name a place that does not exist.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assertFails(
        archiveWith({
          ...FROZEN_RECORD,
          firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, rank: bad },
        }),
      );
    }
  });

  it('ALLOWS the counts and instants the WRITER can actually produce', async () => {
    // The bound is TWO-SIDED rather than the `> 0` the Event's own instants
    // carry, because this arm may only require what the writer guarantees — it
    // is reached after the Event is already shut. `players/{uid}` validates no
    // field (ADR 0001), and `archiveCount`/`archiveInstant` COPY a Player's own
    // odd-but-readable numbers through, so 0 and negatives are legitimate
    // records and a non-negative bound would refuse one permanently.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        firstBingo: { ...FROZEN_RECORD.firstBingo, at: 0 },
        firstBingoRow: {
          ...FROZEN_RECORD.firstBingoRow,
          bingoCount: 0,
          squaresMarked: -3,
          firstBingoAt: -5,
        },
      }),
    );
  });

  // Codex P2 on PR #1162. The First-BINGO pair stopped admitting `NaN` and the
  // infinities while the record's OWN two numbers still did, and the flip is
  // irreversible and locks `archive` — so `playerCount: NaN` would have been
  // permanent, and the archived-state summary renders it verbatim.
  it('DENIES a non-finite or non-integer playerCount', async () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      // More than finiteness, because `playerCount` is a count the WRITER
      // computes (`ranked.length`) rather than one it copies off a Player row:
      // a fractional or negative roster size names no roster at all.
      1.5,
      -1,
    ]) {
      await assertFails(archiveWith({ ...FROZEN_RECORD, playerCount: bad }));
    }
    // The empty roster is a real record and stays writable — the bound is
    // non-negative, not positive.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: [],
        playerCount: 0,
        firstBingo: null,
        firstBingoRow: null,
        dailyHonors: [],
      }),
    );
  });

  // Codex P2 on PR #1162. `standings` and `playerCount` were typed one at a time
  // and said nothing about each other, so an authorized admin flipping DIRECTLY
  // rather than through `draftEventArchive` could freeze a count that contradicts
  // the list it describes, or a list past the bound the Event document's 1 MiB
  // budget depends on — permanently, since the flip is irreversible and locks
  // `archive`, and silently, since every archived surface reads the count as the
  // roster size and the list as its rank-ordered prefix.
  const standingsRow = (i: number) => ({
    uid: `player-uid-${i}`,
    displayName: `P${i}`,
    bingoCount: 1,
    squaresMarked: 250 - i,
    blackout: false,
    firstBingoAt: 1000 + i,
  });

  it('DENIES standings that do not match playerCount', async () => {
    // The count undercounting its own list: `playerCount: 0` beside a row.
    await assertFails(archiveWith({ ...FROZEN_RECORD, playerCount: 0 }));
    // …and overcounting it, while still under the bound, where the count is
    // supposed to BE the list's length.
    await assertFails(archiveWith({ ...FROZEN_RECORD, playerCount: 2 }));
    // …and a list past the bounded prefix, in either pairing.
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 201 }, (_, i) => standingsRow(i)),
        playerCount: 201,
      }),
    );
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 201 }, (_, i) => standingsRow(i)),
        playerCount: 500,
      }),
    );
  });

  it('ALLOWS a short roster whose count IS its list', async () => {
    // Under the bound the two are equal, which is what `draftEventArchive`
    // produces for every real Event (both live ones have two-figure rosters).
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 5 }, (_, i) => standingsRow(i)),
        playerCount: 5,
      }),
    );
  });

  it('ALLOWS the bounded prefix of a roster past the bound', async () => {
    // The pairing's whole reason for existing: 200 retained rows beside the
    // complete cardinality of 250, exactly `ranked.slice(0, 200)` beside
    // `ranked.length`.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 200 }, (_, i) => standingsRow(i)),
        playerCount: 250,
      }),
    );
  });

  // Codex P2 on PR #1162, round 9. `rank > 0` says the holder's place is a real
  // ordinal and says nothing about whether the roster is that long, so the two
  // clauses beside each other still admitted a record that claims in one breath
  // that nobody played and that somebody came first — permanently, because the
  // flip is irreversible and locks `archive`, and visibly, because the archived
  // Share Card prints that place out of a roster it also reports as empty.
  it('DENIES a First-BINGO rank that overruns the roster the record declares', async () => {
    // The shape the finding names: `playerCount: 0` beside `standings: []`,
    // which `standingsSizeMatches` is perfectly happy with — the two agree the
    // roster is empty — and an otherwise valid pair whose row ranks first.
    await assertFails(archiveWith({ ...FROZEN_RECORD, standings: [], playerCount: 0 }));
    // …and any rank past the count, on a roster that does exist. The fixture
    // carries one Player, so second place names nobody.
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, rank: 2 },
      }),
    );
  });

  it('ALLOWS a holder ranked LAST', async () => {
    // `rank == playerCount` is the boundary case rather than an exception: the
    // Player who got there first can be last in the standings, and the fixture's
    // own `rank: 1` beside `playerCount: 1` is that same equality.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 3 }, (_, i) => standingsRow(i)),
        playerCount: 3,
        firstBingo: { uid: 'player-uid-2', displayName: 'P2', at: 1002 },
        firstBingoRow: { ...standingsRow(2), rank: 3 },
      }),
    );
  });

  it('ALLOWS a holder ranked past the retained prefix', async () => {
    // The bound is `playerCount`, not `standings.size()`: the holder's row is
    // carried OUTSIDE the bounded prefix precisely so a place past it can still
    // be printed, so asking the prefix would refuse the very record the pairing
    // exists for.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 200 }, (_, i) => standingsRow(i)),
        playerCount: 250,
        firstBingo: { uid: 'player-uid-249', displayName: 'P249', at: 1249 },
        firstBingoRow: { ...standingsRow(249), rank: 250 },
      }),
    );
  });

  // Codex P2 on PR #1162, round 9. `dailyHonors is list` accepted a list of ANY
  // length, so a direct admin flip could freeze thousands of entries into a field
  // whose contract is at most one honour per Day on an Event that supports at
  // most ten — permanently, because the flip locks `archive`, and unrepairably,
  // because no client can amend it. Rules cannot walk a list, so what is IN it
  // stays the stated residual; its SIZE is one expression, the same one
  // `standingsSizeMatches` already spends.
  const honor = (i: number) => ({
    dayIndex: i,
    uid: `player-uid-${i}`,
    displayName: `P${i}`,
    firstBingoAt: 1000 + i,
    dayLabel: `🌈 D${i + 1}`,
  });

  it('DENIES more archived honours than an Event has Days', async () => {
    // Eleven, which is `MAX_DAYS + 1` — the eleventh Day sits outside the
    // schedule lock `daysThemeLockOk` unrolls, so it is unsupported rather than
    // merely undesirable.
    await assertFails(
      archiveWith({
        ...FROZEN_RECORD,
        dailyHonors: Array.from({ length: 11 }, (_, i) => honor(i)),
      }),
    );
  });

  it('ALLOWS an honour for every Day the Event can have', async () => {
    // Ten is the boundary case rather than an exception: a full schedule with a
    // pinned holder on every Day is exactly what `draftEventArchive` produces.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        dailyHonors: Array.from({ length: 10 }, (_, i) => honor(i)),
      }),
    );
  });

  it('DENIES a non-finite or out-of-range freezeAt', async () => {
    // The Standings Freeze the whole record cut on, held to the same bound as
    // the pair's own instants. It is the one number here that needs no Player to
    // misbehave: it resolves from `frozenAt`, which the Admin SDK writes and no
    // arm constrains.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      MAX_ARCHIVE_NUMBER + 1,
      -(MAX_ARCHIVE_NUMBER + 1),
    ]) {
      await assertFails(archiveWith({ ...FROZEN_RECORD, freezeAt: bad }));
    }
    // A real freeze instant still goes through, and so does the `null` that
    // means the Event never had one.
    await assertSucceeds(archiveWith({ ...FROZEN_RECORD, freezeAt: 1_700_000_000_000 }));
  });

  // #1151, Codex P1 on PR #1162. The writer and this arm must share ONE
  // representable-number contract, or a value the writer happily copies is
  // refused HERE — on the flip, after `beginArchive` has already shut the Event,
  // as a rejected write that goes past every typed refusal and the console's
  // automatic reopen alike. `src/data/eventArchive.ts` clamps to
  // `MAX_ARCHIVE_NUMBER`; this proves that value is exactly the largest one this
  // helper accepts, from both sides of the boundary.
  it('ALLOWS the WRITER’s own clamp, and denies the value it clamped from', async () => {
    const clamped = {
      ...FROZEN_RECORD,
      firstBingo: { ...FROZEN_RECORD.firstBingo, at: MAX_ARCHIVE_NUMBER },
      firstBingoRow: {
        ...FROZEN_RECORD.firstBingoRow,
        bingoCount: MAX_ARCHIVE_NUMBER,
        // The negative side too: `archiveCount` copies a Player's own negative
        // count through, so the clamp is two-sided and so is this bound.
        squaresMarked: -MAX_ARCHIVE_NUMBER,
        firstBingoAt: MAX_ARCHIVE_NUMBER,
      },
      freezeAt: MAX_ARCHIVE_NUMBER,
    };
    // ONE past the clamp is refused in either direction, which is what makes the
    // constant the boundary rather than merely a value inside it. Asserted
    // BEFORE the accepted control, because that control archives the Event.
    await assertFails(
      archiveWith({
        ...clamped,
        firstBingo: { ...FROZEN_RECORD.firstBingo, at: MAX_ARCHIVE_NUMBER + 1 },
      }),
    );
    await assertFails(
      archiveWith({
        ...clamped,
        firstBingoRow: { ...clamped.firstBingoRow, squaresMarked: -(MAX_ARCHIVE_NUMBER + 1) },
      }),
    );
    // …and the clamped record itself goes through, so a `bingoCount: 5e12` on a
    // self-written Player row freezes instead of stranding a shut Event.
    await assertSucceeds(archiveWith(clamped));
  });

  it('ALLOWS a kept row whose holder never bingoed on a scored Day', async () => {
    // `firstBingoAt` is the one nullable scalar on the row (`archiveInstant`
    // yields `number | null`), so the check is type-or-null there and a bare
    // type check everywhere else. Present so the denials above cannot be
    // mistaken for "any null is refused".
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        firstBingoRow: { ...FROZEN_RECORD.firstBingoRow, firstBingoAt: null },
      }),
    );
  });

  it('ALLOWS the pair when both halves name the same holder', async () => {
    // The matching control, so the denials above are not vacuous.
    await assertSucceeds(archiveWith(FROZEN_RECORD));
  });

  it('DENIES a record whose stamp disagrees with the document stamp', async () => {
    // Two answers to one question is exactly what the archived surfaces would
    // then show; both are written from one value in one update.
    await assertFails(archiveWith({ ...FROZEN_RECORD, archivedAt: ARCHIVED_AT + 1 }));
    // …and the disagreement is symmetric: moving the DOCUMENT stamp instead is
    // refused by the same clause.
    await assertFails(flip(ADMIN, { archivedAt: ARCHIVED_AT + 1 }));
  });

  it('ALLOWS the complete record, including the legitimately null trio', async () => {
    // `firstBingo`/`firstBingoRow: null` means nobody got there, `eventName:
    // null` means the Event had no name, and `freezeAt: null` means it had no
    // Standings Freeze — all real records, so the check is
    // presence-then-type-or-null rather than a bare `is map`/`is number`.
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        eventName: null,
        firstBingo: null,
        firstBingoRow: null,
        freezeAt: null,
        dailyHonors: [],
      }),
    );
  });

  // #1142 item 1. The general Event arm sits at Firestore's 1000-expression cap,
  // and this ticket adds clauses to the FLIP arm behind it — so the write those
  // clauses exist to validate has to be proved still evaluable. A full record is
  // the largest one the builder can produce (`MAX_ARCHIVED_STANDING_ROWS` rows at
  // `MAX_ARCHIVED_DISPLAY_NAME` characters), and the rules cannot iterate a list,
  // so its SIZE costs nothing here — which is exactly the claim this pins.
  it('ALLOWS a FULL-sized record through, so the cap is not what the flip meets', async () => {
    const row = (i: number) => ({
      uid: `player-uid-${i}`,
      displayName: 'N'.repeat(100),
      bingoCount: 20,
      squaresMarked: 250 - i,
      blackout: false,
      firstBingoAt: 1_700_000_000_000 + i,
    });
    await assertSucceeds(
      archiveWith({
        ...FROZEN_RECORD,
        standings: Array.from({ length: 200 }, (_, i) => row(i)),
        playerCount: 200,
        firstBingo: { uid: 'player-uid-0', displayName: 'N'.repeat(100), at: 1_700_000_000_000 },
        firstBingoRow: { ...row(0), rank: 1 },
        dailyHonors: Array.from({ length: 10 }, (_, i) => ({
          dayIndex: i,
          uid: `player-uid-${i}`,
          displayName: 'N'.repeat(100),
          firstBingoAt: 1_700_000_000_000 + i,
          dayLabel: `🌈 D${i + 1}`,
        })),
      }),
    );
  });

  it('DENIES a flip that smuggles anything else in beside the record', async () => {
    // The `hasOnly` guard names five keys now, and the fifth is the record — but
    // it is still five, not "the record plus whatever". A write that also moved
    // configuration falls through to the general arm, where a not-yet-archived
    // document is refused.
    await assertFails(flip(ADMIN, { claimMode: 'proof_required' }));
    await assertFails(flip(ADMIN, { bannedUids: [BOB] }));
  });
});

// Codex P1, PR #1139. The archive flip reads ONE document and writes ONE
// document, so it serializes against nothing in `players`, `boards`, `claims` or
// `tally`. The quiesce is what closes that hole: gameplay is shut by a first
// admin write, and only from THAT state may the Event be frozen — which is a
// property the rules must hold, because a client-side ordering convention is
// exactly what a direct SDK write ignores.
describe('post-sailing-archive — the quiesce shuts gameplay before the freeze', () => {
  it('ALLOWS an admin to shut the Event, and to reopen it while the archive is uncommitted', async () => {
    // REVERSIBLE on purpose: the first write shuts gameplay for everyone, so a
    // freeze that failed halfway (or an Admin who changed their mind) must not
    // leave a live Event permanently unplayable.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
  });

  // Codex P1, PR #1157 round 6. `abandonArchive` leaves the generation in place
  // when it reopens, so a write that merely set `archiving: true` again re-shut
  // the Event under the OLD one — and a stale `archiveEvent(A)` whose record
  // predates the reopen then passed `boundToStoredQuiesce`. Every shut now has
  // to install a generation ABOVE the stored one, and nothing but the shut arm
  // can shut.
  it('REQUIRES a strictly greater generation on every shut', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true }));
    // Neither a non-positive value nor a fraction nor a string is a generation
    // the rules can order against, so none of them may shut the Event — and the
    // string is the shape a build older than the counter would have written.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 0 }));
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1.5 }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-1' }),
    );
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    // Reopened, generation still 1 on the document: re-shutting under it is
    // exactly the replay the arm exists to refuse.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }));
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 2 }),
    );
  });

  // Phase 4b P1, PR #1157 run 4. THE REPLAY A MERE INEQUALITY MISSED. An opaque
  // generation compared only against the value the document STILL CARRIES
  // proves nothing about freshness: the rules can see one step back and no
  // further. Shut under A, reopen, shut under B, reopen — and a delayed SDK
  // shut carrying A was accepted again, because A is merely different from B.
  // That put a dead generation back in force, after which an outstanding
  // `archiveEvent(A)`, or a direct flip naming `archivedUnder: A`, archived a
  // closing state neither was ever taken against. A counter that must INCREASE
  // cannot come back: the stored value is the high-water mark, so every
  // generation at or below it is dead for the life of the Event.
  it('REFUSES a generation that was already in force two quiesces ago', async () => {
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 2 }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    // The delayed shut, carrying the generation from two quiesces ago. Under
    // `!=` this PASSED: the document carries 2, and 1 is simply not 2.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }));
    // Only a generation above the high-water mark shuts the Event…
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 3 }),
    );
    // …and the flip is bound to THAT one, so the freeze an old caller is still
    // holding cannot land on it.
    await assertFails(flip(ADMIN, { archivedUnder: 1 }));
    await assertSucceeds(flip(ADMIN, { archivedUnder: 3 }));
  });

  // Codex P2, PR #1157 round 7. With the shut minting a fresh generation, the
  // remaining way to replay an abandoned token was to WRITE it back: the
  // general arm protected `status`, `archiving` and `archivedAt` but not the
  // token, so a whole-document writer could restore B beside the current
  // quiesce. The token is immutable while the Event is closing — and on a live
  // Event, where it is inert but the next shut must differ from it — with one
  // narrow exception: a closing state carrying no usable token may be given one.
  it('KEEPS the generation immutable while closing, and lets an unidentified quiesce be repaired', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiveToken: 9 }));
    await quiesce();
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiveToken: 9 }));
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 9 }));
    // The repair: shut out of band with no generation at all.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), { archiveToken: deleteField() });
    });
    await assertFails(updateDoc(doc(db(ALICE), eventPath()), { archiveToken: 2 }));
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { archiveToken: 2, bannedUids: [BOB] }),
    );
    // `beginArchive`'s own shape for that state: the flag restated, the
    // generation minted.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 2 }),
    );
    // …and settled again from then on.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiveToken: 3 }));
  });

  it('treats a NON-COUNTER generation as none at all — shut, binding and repair agree', async () => {
    // Codex P2, PR #1157 round 8, restated for the counter (Phase 4b P1, run
    // 4). ONE usability predicate serves the shut, the binding and the repair,
    // so a value one arm reads as usable can never be a value another replaces:
    // that disagreement left Close play failing until an Admin reopened by
    // hand. A legacy STRING is the shape an Event shut by a build older than
    // the counter carries, and it is unusable in exactly the same way.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-1' }),
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), {
        archiving: true,
        archiveToken: 'quiesce-1',
      });
    });
    // The flip is not bound to a value the counter cannot order…
    await assertFails(flip(ADMIN, { archivedUnder: 'quiesce-1' }));
    // …and the repair reads it as absent, so the client's replacement lands.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }),
    );
  });

  it('REFUSES a repair that would hand a superseded number back', async () => {
    // Phase 4b P1, PR #1157 run 4. An unusable generation still pins the floor
    // when it is a NUMBER: a repair that reset the counter to 1 beneath a
    // stored 5.5 would put every generation up to 5 back in play, which is the
    // replay the counter exists to end.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: true, archiveToken: 5.5 });
    });
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 1 }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 6 }),
    );
  });

  it('DENIES a shut that smuggles configuration with it, and a create born shut', async () => {
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        archiving: true,
        archiveToken: 1,
        bannedUids: [BOB],
      }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), `events/${LEGACY_EVENT}-born-shut`), {
        name: 'Born shut',
        admins: [ADMIN],
        archiving: true,
        archiveToken: 1,
      }),
    );
  });

  it('DENIES a Player shutting the Event, or reopening one', async () => {
    await assertFails(updateDoc(doc(db(ALICE), eventPath()), { archiving: true }));
    await assertFails(updateDoc(doc(unauthDb(), eventPath()), { archiving: true }));
    await quiesce();
    await assertFails(updateDoc(doc(db(ALICE), eventPath()), { archiving: false }));
  });

  it('DENIES a non-boolean closing flag, even from an admin', async () => {
    // A truthy string would read as CLOSED through one reader and open through
    // another; the flag decides whether every gameplay write is denied, so it
    // gets the same shape check `forceAdult` carries.
    for (const bad of ['true', 1, 'yes', null]) {
      await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: bad }));
    }
  });

  it('keeps Admin moderation and reads open while the Event is closing', async () => {
    // The closing state stops GAMEPLAY, not administration — otherwise an Admin
    // could not drain a report, and could not reopen the Event either.
    await quiesce();
    await assertSucceeds(getDoc(doc(db(BOB), eventPath())));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `${eventPath()}/proofs/${PROOF}`), { status: 'hidden' }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { bannedUids: [BOB] }));
  });

  // Codex P2, PR #1139. Moderation stays open across the quiesce on purpose —
  // but the two documents the frozen record will be BUILT from are the
  // exception. `archiveEvent` re-reads the roster and every Day's honour pin
  // from the server after the close and then commits in a transaction that
  // reads ONLY the Event document (#1151), so a delete landing in that window
  // is neither ordered against the freeze nor caught by it: the write-once
  // record would keep a row moderation had already removed. They hold still
  // until the freeze lands, and the arms are here now because they are the
  // quiesce's own contract, not the snapshot's.
  it('DENIES deleting a Player row or a Day honour while the Event is closing', async () => {
    const honorPath = `${eventPath()}/days/0/meta/0`;
    const seed = async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const fs = ctx.firestore();
        await setDoc(doc(fs, `${eventPath()}/players/${ALICE}`), {
          uid: ALICE,
          displayName: 'Alice',
          bingoCount: 0,
          squaresMarked: 0,
          firstBingoAt: null,
          reshufflesUsed: 0,
        });
        await setDoc(doc(fs, honorPath), {
          firstBingo: { uid: ALICE, displayName: 'Alice', at: 1000 },
        });
      });
    };

    // Open for play: both are ordinary admin moderation, exactly as before.
    await seed();
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), honorPath)));

    // Shut: these are the documents the record will be read against.
    await seed();
    await quiesce();
    await assertFails(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
    await assertFails(deleteDoc(doc(db(ADMIN), honorPath)));

    // The way through is the one the console offers beside the button: reopen
    // play, moderate, archive again.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: false });
    });
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), honorPath)));
  });

  it('DENIES archiving an Event that was never shut, and ALLOWS it from the closing state', async () => {
    // Straight off a live Event: refused. There is no window in which the
    // roster had stopped moving, so nothing about the freeze can be trusted.
    await assertFails(flip(ADMIN));
    await quiesce();
    await assertSucceeds(flip(ADMIN));
  });

  it('DENIES an archive write that smuggles a configuration change with it', async () => {
    // The flip rides its own arm, which skips the schedule and freeze-boundary
    // validation the ordinary admin arm performs. `affectedKeys().hasOnly` is
    // what keeps that a short-circuit rather than a hole: anything beyond the
    // transition keys is not an archive write and falls through to the arm that
    // does check those fields — where a not-yet-archived document is refused.
    await quiesce();
    await assertFails(flip(ADMIN, { standingsFreezeAt: PAST() }));
  });

  // Codex P1, PR #1139 round 4. Being shut is not the same as being the shut
  // the caller took: play can be REOPENED and SHUT AGAIN while a freeze is in
  // flight, and the document the flip then writes against carries an
  // `archiving: true` indistinguishable from the first. The generation id makes
  // the two distinguishable, at the boundary rather than only in the client
  // that checks.
  it('DENIES a flip that OMITS its binding — the stored token cannot be inherited', async () => {
    // Phase 4b P1, PR #1157 run 3. `request.resource.data` is the whole resulting
    // document, so comparing the incoming `archiveToken` let a flip with no
    // token at all inherit the stored one. The binding is a field only the
    // flip writes; after a reopen and a re-shut it must name the NEW generation.
    await quiesce();
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        archiving: false,
      }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 2 }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        archiving: false,
      }),
    );
    await assertFails(flip(ADMIN, { archivedUnder: QUIESCE }));
    await assertSucceeds(flip(ADMIN, { archivedUnder: 2 }));
    // Locked with the record from here.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedUnder: 3 }));
  });

  it('DENIES an archive write bound to a superseded quiesce', async () => {
    await quiesce(2);
    // The caller opened under an earlier generation; play has been reopened and
    // shut again since.
    await assertFails(flip(ADMIN, { archivedUnder: QUIESCE }));
    // The generation actually in force is accepted — so the denial above is
    // about the binding, not about carrying the field at all.
    await assertSucceeds(flip(ADMIN, { archivedUnder: 2 }));
  });

  it('DENIES the flip from a closing state that carries no generation at all', async () => {
    // An unidentified quiesce is exactly the state the binding exists to tell
    // apart from another, so it fails closed. `beginArchive` mints one, which
    // is how a state shut by a pre-token build becomes archivable again.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: true });
    });
    await assertFails(flip(ADMIN));
    // …and with a generation in place the identical write lands.
    await quiesce();
    await assertSucceeds(flip(ADMIN));
  });

  it('DENIES an archive write that leaves the closing flag set', async () => {
    // The quiesce ends with the freeze. A document carrying both would hold a
    // CLEARABLE second spelling of a state that must not be clearable.
    await quiesce();
    await assertFails(flip(ADMIN, { archiving: true }));
  });

  it('leaves the closing flag inert once archived — clearing it cannot reopen play', async () => {
    // `archiving` is deliberately outside the write-once clause, so it stays
    // clearable. That is safe precisely because `status` is not: the freeze is
    // carried by the half that cannot be moved.
    await freeze();
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    await assertFails(
      setDoc(
        doc(db(ALICE), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells([3]), markSeed: 7 },
        { merge: true },
      ),
    );
  });
});

// EVERY gameplay arm, proved against BOTH halves of the freeze. `eventClosedToPlay`
// is one predicate over `status == 'archived'` OR `archiving == true`, and each
// case runs the identical write twice: once on the live Event (where it must
// succeed, or the denial below proves nothing) and once on the closed one. A
// quiescing phase a Player could still write through would quiesce nothing.
describe.each([
  ['closing', () => quiesce()],
  ['archived', () => freeze()],
] as const)('post-sailing-archive — gameplay writes stop at the freeze (%s)', (_half, close) => {
  it('DENIES a Mark: the Board write and its public Tally marker alike', async () => {
    const markBoard = (uid: string) =>
      setDoc(
        doc(db(uid), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells([3]), markSeed: 7 },
        { merge: true },
      );
    const markTally = (uid: string) =>
      setDoc(doc(db(uid), `${eventPath()}/tally/${ITEM}/markers/${uid}`), {
        eventId: EVENT,
        uid,
        displayName: 'Alice',
        markedAt: NOW(),
        itemText: 'Something happens',
        dayIndex: 0,
      });
    await assertSucceeds(markBoard(ALICE));
    await assertSucceeds(markTally(ALICE));
    await close();
    await assertFails(markBoard(ALICE));
    await assertFails(markTally(ALICE));
    // The Admin is bound by the freeze too — an archive its own organiser can
    // still mark is not a frozen record.
    await assertFails(markBoard(ADMIN));
  });

  it('DENIES un-marking (the Tally marker delete)', async () => {
    const unmark = () => deleteDoc(doc(db(ALICE), `${eventPath()}/tally/${ITEM}/markers/${ALICE}`));
    // The live control (CodeRabbit on PR #1157): the SAME delete succeeds
    // before the shut, so the denial below cannot pass for an unrelated reason.
    await assertSucceeds(unmark());
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/tally/${ITEM}/markers/${ALICE}`), {
        eventId: EVENT,
        uid: ALICE,
        displayName: 'Alice',
        markedAt: NOW(),
        itemText: 'Something happens',
        dayIndex: 0,
      });
    });
    await close();
    await assertFails(unmark());
  });

  it('DENIES a Player stat write and a late join', async () => {
    const writeStats = () =>
      setDoc(
        doc(db(ALICE), `${eventPath()}/players/${ALICE}`),
        { bingoCount: 1, squaresMarked: 5 },
        { merge: true },
      );
    const join = () =>
      setDoc(doc(db(BOB), `${eventPath()}/players/${BOB}`), {
        uid: BOB,
        displayName: 'Bob',
        bingoCount: 0,
        squaresMarked: 0,
        firstBingoAt: null,
        reshufflesUsed: 0,
      });
    await assertSucceeds(writeStats());
    await close();
    await assertFails(writeStats());
    await assertFails(join());
  });

  it('DENIES claiming an unclaimed daily First-to-BINGO honour', async () => {
    const claimHonor = (dayIndex: number) =>
      setDoc(doc(db(ALICE), `${eventPath()}/days/${dayIndex}/meta/${dayIndex}`), {
        firstBingo: { uid: ALICE, displayName: 'Alice', at: NOW() },
      });
    await assertSucceeds(claimHonor(0));
    await close();
    await assertFails(claimHonor(1));
  });

  it('DENIES a reshuffle spend (the paired counter bump + marker batch)', async () => {
    // The real shape (specs/reshuffle.md): one batch bumps the Player's
    // allowance counter and mints the marker whose `n` must equal the POST-batch
    // counter, so a marker alone would fail for its own reasons and prove
    // nothing about the freeze.
    const spend = (n: number) => {
      // ONE Firestore instance for the whole batch — `db()` mints a fresh
      // context per call, and mixing two instances throws before the rules are
      // ever consulted.
      const fs = db(ALICE);
      const batch = writeBatch(fs);
      batch.set(
        doc(fs, `${eventPath()}/players/${ALICE}`),
        { reshufflesUsed: n },
        { merge: true },
      );
      batch.set(doc(fs, `${eventPath()}/reshuffles/${ALICE}-${n}`), {
        uid: ALICE,
        n,
        dayIndex: 0,
      });
      return batch.commit();
    };
    await assertSucceeds(spend(1));
    await close();
    await assertFails(spend(2));
  });

  it('DENIES a Prompt submission and a Prompt report', async () => {
    const submit = (id: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/items/${id}`), {
        text: 'A new prompt',
        createdBy: ALICE,
        pool: 'main',
        status: 'pending',
        reportCount: 0,
        spicy: false,
      });
    const report = (count: number) =>
      updateDoc(doc(db(BOB), `${eventPath()}/items/${ITEM}`), { reportCount: count });
    await assertSucceeds(submit('new-prompt'));
    await assertSucceeds(report(1));
    await close();
    await assertFails(submit('later-prompt'));
    await assertFails(report(2));
  });

  it('DENIES a Proof create, a Proof report, and an owner deleting their own Proof', async () => {
    const createProof = (id: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/proofs/${id}`), {
        uid: ALICE,
        displayName: 'Alice',
        photoURL: null,
        type: 'text',
        cellIndex: 4,
        itemText: 'Something happens',
        storagePath: null,
        mediaURL: null,
        thumbURL: null,
        text: 'again',
        createdAt: NOW(),
        reportCount: 0,
        status: 'active',
        visionFlag: null,
        source: null,
        dayIndex: 0,
      });
    const report = (count: number) =>
      updateDoc(doc(db(BOB), `${eventPath()}/proofs/${PROOF}`), { reportCount: count });
    const ownerDelete = (id: string) => deleteDoc(doc(db(ALICE), `${eventPath()}/proofs/${id}`));
    // Live controls for all three writes (CodeRabbit on PR #1157): the report
    // bump and the owner delete each succeed before the shut, on a separately
    // seeded Proof for the delete so the frozen half still has one to refuse.
    await assertSucceeds(createProof('proof-2'));
    await assertSucceeds(report(1));
    await assertSucceeds(ownerDelete('proof-2'));
    await close();
    await assertFails(createProof('proof-3'));
    await assertFails(report(2));
    await assertFails(ownerDelete(PROOF));
  });

  it('DENIES a Claim create', async () => {
    const makeClaim = (id: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/claims/${id}`), {
        uid: ALICE,
        itemId: ITEM,
        cellIndex: 3,
        createdAt: NOW(),
      });
    await assertSucceeds(makeClaim('claim-1'));
    await close();
    await assertFails(makeClaim('claim-2'));
  });

  it('DENIES a Doubt, its satisfaction, and its withdrawal', async () => {
    const doubtId = `${BOB}_${ALICE}_${ITEM}`;
    const raise = () =>
      setDoc(doc(db(BOB), `${eventPath()}/doubts/${doubtId}`), {
        fromUid: BOB,
        targetUid: ALICE,
        itemId: ITEM,
        cellIndex: 3,
        createdAt: NOW(),
      });
    await assertSucceeds(raise());
    await close();
    await assertFails(
      updateDoc(doc(db(ALICE), `${eventPath()}/doubts/${doubtId}`), {
        satisfiedAt: NOW(),
        satisfiedProofId: PROOF,
      }),
    );
    await assertFails(deleteDoc(doc(db(BOB), `${eventPath()}/doubts/${doubtId}`)));
  });

  it('DENIES a Heart and an un-heart', async () => {
    const heartId = `${BOB}_proof_${PROOF}`;
    const heart = () =>
      setDoc(doc(db(BOB), `${eventPath()}/hearts/${heartId}`), {
        uid: BOB,
        targetKind: 'proof',
        targetId: PROOF,
        targetCreatedAt: 0,
        createdAt: NOW(),
      });
    // The live control carries the Proof's real `createdAt` — the incarnation
    // stamp the rule pins — so the success is genuine rather than a shape that
    // would have failed anyway.
    await assertSucceeds(
      setDoc(doc(db(BOB), `${eventPath()}/hearts/${heartId}`), {
        uid: BOB,
        targetKind: 'proof',
        targetId: PROOF,
        targetCreatedAt: proofCreatedAt,
        createdAt: NOW(),
      }),
    );
    await close();
    await assertFails(heart());
    await assertFails(deleteDoc(doc(db(BOB), `${eventPath()}/hearts/${heartId}`)));
  });

  it('DENIES a Moment and its retraction tombstone', async () => {
    const postMoment = (id: string, kind: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/moments/${id}`), {
        uid: ALICE,
        kind,
        displayName: 'Alice',
        createdAt: NOW(),
        dayIndex: 0,
      });
    await assertSucceeds(postMoment(`${ALICE}-bingo-d0`, 'bingo'));
    await close();
    await assertFails(postMoment('first_bingo', 'first_bingo'));
    await assertFails(
      setDoc(doc(db(ALICE), `${eventPath()}/momentRetractions/${ALICE}-bingo-d0`), {
        uid: ALICE,
        kind: 'bingo',
        dayIndex: 0,
        createdAt: NOW(),
      }),
    );
  });

  it('DENIES a proof-media upload but keeps the Admin takedown working', async () => {
    // The Storage half of the same denial: a Proof document and its media must
    // refuse together, or an archive still grows blobs (D8, and the #806 lesson).
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), photoPath), TINY, IMAGE));
    await close();
    await assertFails(
      uploadBytes(ref(storageOf(ALICE), `proofs/${EVENT}/${ALICE}/proof-9.jpg`), TINY, IMAGE),
    );
    // The takedown, IN THE ORDER `deleteProof` PERFORMS IT (#1153, Codex round 5
    // P2): the Proof document's removal COMMITS first and the object is revoked
    // afterwards, so by the time the Storage delete is issued the media is an
    // orphan. Every client delete on this arm now requires that — the Admin's as
    // much as the owner's — because an admin-owner who could empty a live Proof's
    // path could refill it inside the generation-capture window.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`));
    });
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), photoPath)));
  });

  it('DENIES the media delete for a LIVE Proof in EVERY state — OWNER, ADMIN and ADMIN-OWNER alike', async () => {
    // Phase 4b P1, PR #1157 shut this on the freeze; Codex round 4 P2 on PR
    // #1163 shut the OWNER's arm outright; Codex round 5 P2 shut the ADMIN's
    // with it. The owner's arm was unconditional, so a direct `deleteObject`
    // stripped an archived Proof's media although `firestore.rules` refuses the
    // owner's DOCUMENT delete on a closed Event. Binding it to the freeze left
    // the OPEN Event's delete-and-recreate window: `resource == null` refuses an
    // overwrite and welcomes a RECREATE, so a caller who can take a live Proof's
    // object down can immediately upload a replacement between
    // `proofMediaGeneration()`'s read and `deleteProof`'s commit — a tombstone
    // bound to the OLD blob with the new one in the path.
    //
    // Binding only the OWNER's branch left that same window open through the
    // ADMIN branch, because the two rosters OVERLAP: an organiser who plays
    // their own Event is a media owner AND an entry in `admins`, so they passed
    // the admin branch while their Proof stood, and the upload arm then welcomed
    // their recreate as owner. So the condition is on the ARM now — no client
    // delete reaches media a Proof document still points at, whoever they are.
    //
    // EVERY blob here is backed by a seeded Proof DOCUMENT, which is what puts
    // it out of reach at all: the carve-out releases only media nothing points
    // at, so a case built on orphans would prove the opposite.
    const ownerBlob = photoPath;
    const adminBlob = mediaProofPath;
    // The overlapping-role case: ADMIN owns this path AND sits in `admins`.
    const adminOwnedBlob = `proofs/${EVENT}/${ADMIN}/${ADMIN_PROOF}.jpg`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${ADMIN_PROOF}`), {
        uid: ADMIN,
        cellIndex: 5,
        storagePath: adminOwnedBlob,
      });
    });
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), ownerBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), adminBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ADMIN), adminOwnedBlob), TINY, IMAGE));
    // LIVE Event, open to play, and all three are refused anyway — the denial is
    // a claim about the standing Proof document, not about the freeze.
    await assertFails(deleteObject(ref(storageOf(ALICE), ownerBlob)));
    await assertFails(deleteObject(ref(storageOf(ADMIN), adminBlob)));
    await assertFails(deleteObject(ref(storageOf(ADMIN), adminOwnedBlob)));
    await close();
    await assertFails(deleteObject(ref(storageOf(ALICE), ownerBlob)));
    await assertFails(deleteObject(ref(storageOf(ADMIN), adminBlob)));
    await assertFails(deleteObject(ref(storageOf(ADMIN), adminOwnedBlob)));
    // And every object is STILL THERE after every denial, which is the point: a
    // recreate needs an empty path, and the denial is what keeps it occupied.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      for (const path of [ownerBlob, adminBlob, adminOwnedBlob]) {
        await getMetadata(ref(ctx.storage(), path));
      }
    });
  });

  it('lets the ADMIN take media down the moment its Proof document is gone, in EVERY state', async () => {
    // The live control the case above needs, and the reason making
    // `proofDocMissing` the WHOLE arm's condition costs the takedown nothing
    // (#1153, Codex round 5 P2). `deleteProof` — one function for the owner's
    // delete and the Admin's — COMMITS the Proof document's removal before it
    // revokes the object, so an Admin takedown always issues its Storage delete
    // against an orphan. A frozen record that locks out its own Admin is #808's
    // support incident in a new place, and this is what proves that has not
    // happened: the same Admin refused above succeeds here, in the closed state,
    // with nothing changed but the Proof document.
    const adminBlob = mediaProofPath;
    const ownerBlob = photoPath;
    const adminOwnedBlob = `proofs/${EVENT}/${ADMIN}/${ADMIN_PROOF}.jpg`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${ADMIN_PROOF}`), {
        uid: ADMIN,
        cellIndex: 5,
        storagePath: adminOwnedBlob,
      });
    });
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), adminBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), ownerBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ADMIN), adminOwnedBlob), TINY, IMAGE));
    await close();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF_MEDIA}`));
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`));
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${ADMIN_PROOF}`));
    });
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), adminBlob)));
    // Somebody else's media, once orphaned, is still the Admin's to take down —
    // which is also the proof that the admin branch did not simply run out of
    // Firestore accesses and fail closed.
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), ownerBlob)));
    // And the ADMIN-OWNER, refused above while their Proof stood, is allowed the
    // moment it is gone — the overlapping role is not a lockout either.
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), adminOwnedBlob)));
  });

  it('lets the OWNER clear their own media the moment its Proof document is gone, in EVERY state', async () => {
    // The owner half of the same order, so the carve-out is not held up by the
    // Admin case alone: `deleteProof`'s commit lands first and `attachProof`'s
    // rollback deletes an object no document was ever written for, so both
    // client paths reach this arm as orphan deletes — in the closed state as
    // much as the open one, which is what keeps the quiesce recoverable.
    const ownerBlob = photoPath;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), ownerBlob), TINY, IMAGE));
    await close();
    await assertFails(deleteObject(ref(storageOf(ALICE), ownerBlob)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`));
    });
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), ownerBlob)));
  });

  it('RELEASES an ORPHANED blob to its owner even while closed — nothing points at it', async () => {
    // Codex P1, PR #1157. The freeze protects a Proof DOCUMENT's media; media
    // no document points at has no Feed entry to strand, so the owner may clear
    // it in every state. Without this, the two client paths that can produce an
    // orphan across the quiesce — an `attachProof` upload whose transaction the
    // freeze then denies, and a `deleteProof` whose commit landed before its
    // Storage delete could — leave permanent litter in the one Event nothing
    // can be re-posted to.
    const orphan = `proofs/${EVENT}/${ALICE}/no-such-proof.jpg`;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), orphan), TINY, IMAGE));
    await close();
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), orphan)));
  });

  it('lets a signed-in user read a MISSING Proof as not-found, while a hidden one stays denied', async () => {
    // Codex P2, PR #1157. The revocation drain has to observe that a Proof
    // document is GONE before it retries a Storage delete; `resource.data` on a
    // null resource errored into a denial, so an owner could never see absence.
    await assertSucceeds(getDoc(doc(db(BOB), `${eventPath()}/proofs/no-such-proof`)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`), { status: 'hidden' });
    });
    await assertFails(getDoc(doc(db(BOB), `${eventPath()}/proofs/${PROOF}`)));
    await assertSucceeds(getDoc(doc(db(ADMIN), `${eventPath()}/proofs/${PROOF}`)));
    await assertFails(getDoc(doc(unauthDb(), `${eventPath()}/proofs/no-such-proof`)));
  });

  it('keeps a DOTTED Proof id whole when it asks whether the media is orphaned', async () => {
    // Phase 4b P1, PR #1157 run 2. Firestore permits a Proof named `p.q`, and
    // `firestore.rules` accepts its `proofs/{event}/{uid}/p.q.jpg` path; a
    // split on the FIRST dot looked up `proofs/p` — absent — and the orphan
    // branch then released media a surviving document still pointed at.
    const dotted = `proofs/${EVENT}/${ALICE}/p.q.jpg`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/proofs/p.q`), {
        uid: ALICE,
        displayName: 'Alice',
        photoURL: null,
        type: 'photo',
        cellIndex: 6,
        itemText: 'Something happens',
        storagePath: dotted,
        mediaURL: 'https://example.test/p.q.jpg',
        thumbURL: null,
        text: '',
        createdAt: NOW(),
        reportCount: 0,
        status: 'active',
        visionFlag: null,
        source: null,
        dayIndex: 0,
      });
    });
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), dotted), TINY, IMAGE));
    await close();
    // Its document exists, so the freeze holds — this is NOT an orphan.
    await assertFails(deleteObject(ref(storageOf(ALICE), dotted)));
    // A genuinely orphaned dotted name is still the owner's to clear.
    const orphan = `proofs/${EVENT}/${ALICE}/x.y.jpg`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), orphan), TINY, IMAGE);
    });
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), orphan)));
  });

  it('DENIES deleting the Event document itself', async () => {
    // Phase 4b P1, PR #1139. Deleting a document leaves its subcollections in
    // place, and a MISSING Event document reads as open (the pre-freeze default
    // pinned below). An admin delete of a frozen Event would therefore reopen
    // every gameplay write under the surviving subtree in one operation — the
    // freeze undone by the one arm it did not guard. The remedy while closing is
    // the console's own: reopen play first.
    await close();
    await assertFails(deleteDoc(doc(db(ADMIN), eventPath())));
    // A Player never could, live or frozen.
    await assertFails(deleteDoc(doc(db(BOB), eventPath())));
    // The Event, and the freeze it carries, are still there.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), eventPath()));
      if (!snap.exists()) throw new Error('the Event document was deleted');
    });
  });
});

describe('post-sailing-archive — what the freeze deliberately leaves open', () => {
  it('keeps every read working exactly as it did live', async () => {
    // The archived READ posture is #808's question. This ticket changes nothing
    // about it, and this case exists so a future read gate is a deliberate
    // change rather than an accident of the freeze.
    await freeze();
    await assertSucceeds(getDoc(doc(db(BOB), eventPath())));
    await assertSucceeds(getDoc(doc(db(BOB), `${eventPath()}/players/${ALICE}`)));
    await assertSucceeds(getDoc(doc(db(BOB), `${eventPath()}/proofs/${PROOF}`)));
    await assertSucceeds(getDoc(doc(db(ALICE), `${eventPath()}/days/0/boards/${ALICE}`)));
  });

  it('keeps Admin moderation available on an archived Event', async () => {
    await freeze();
    // Hide and delete a Prompt, hide and delete a Proof, ban an author, and
    // remove a Board — the whole takedown path a permanent record needs.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `${eventPath()}/items/${ITEM}`), { status: 'hidden' }),
    );
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `${eventPath()}/proofs/${PROOF}`), { status: 'hidden' }),
    );
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/proofs/${PROOF}`)));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/items/${ITEM}`)));
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { bannedUids: [BOB] }));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/days/0/boards/${ALICE}`)));
    // The two snapshot-defining deletes REOPEN once the Event is frozen (#1139).
    // They are shut only for the length of the quiesce, because a permanent
    // record whose Players could never be erased is #808 again.
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/days/0/meta/0`), {
        firstBingo: { uid: ALICE, displayName: 'Alice', at: 1000 },
      });
    });
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/days/0/meta/0`)));
  });

  it('keeps the admin Proof DELETE open while denying the Board unmark it used to carry', async () => {
    // The shape `deleteProof` used to write in ONE transaction: remove the Proof
    // document, unmark the Board cell it backed, rewrite the owner's stats, drop
    // their Tally marker. The delete is moderation and stays open; the Board and
    // Player writes are gameplay `eventOpenForPlay` denies — for an ADMIN as
    // much as anyone, since the freeze binds the organiser too. One transaction,
    // so those two denials took the delete down with them and the advertised
    // takedown failed on exactly the Event whose play can never resume. The
    // client now skips the cleanup; these are the denials that make that the
    // only workable shape. (The marker delete is admin-open — moderation, like
    // the Proof delete — but it is skipped WITH the unmark it mirrors: dropping
    // the public attribution while the Board still carries the Mark would put
    // the two halves of one Mark out of step, permanently.)
    await freeze();
    await assertFails(
      setDoc(
        doc(db(ADMIN), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells() },
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(db(ADMIN), `${eventPath()}/players/${ALICE}`),
        { squaresMarked: 0, bingoCount: 0 },
        { merge: true },
      ),
    );
    // …and the delete the moderation path actually needs still lands.
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/proofs/${PROOF}`)));
  });

  it('leaves a pending Claim resolvable ON PAPER ONLY — the reason the archive will drain the queue first', async () => {
    // The claims arm keeps `allow update: if isAdmin(eventId)` open on an
    // archived Event, so the CLAIM DOCUMENT still moves. What does not move is
    // everything the resolution actually consists of: `resolve()`
    // (src/data/admin.ts) writes the claimant's Board and Player row in the
    // same transaction, and both are gameplay writes the freeze denies — so a
    // Confirm or Reject offered after the archive can only ever fail, and the
    // claim is pending forever.
    //
    // The remedy is client-side and cannot be expressed here: rules cannot
    // query a collection, so "no pending claims" is not a condition the archive
    // write can carry. The console's drain gate — which refuses to arm while the
    // Review queue holds one — arrives with the snapshot in #1151, because it is
    // the snapshot's inputs it exists to protect. This case pins the shape that
    // makes it necessary.
    const claimPath = `${eventPath()}/claims/claim-open`;
    const resolveBoard = (marked: number[]) =>
      setDoc(
        doc(db(ADMIN), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells(marked), markSeed: 7 },
        { merge: true },
      );
    const resolveStats = (squares: number) =>
      setDoc(
        doc(db(ADMIN), `${eventPath()}/players/${ALICE}`),
        { squaresMarked: squares },
        { merge: true },
      );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), claimPath), {
        uid: ALICE,
        displayName: 'Alice',
        cellIndex: 3,
        itemText: 'Something happens',
        status: 'pending',
        createdAt: NOW(),
        dayIndex: 0,
      });
    });
    // Live, the whole resolution lands.
    await assertSucceeds(resolveBoard([3]));
    await assertSucceeds(resolveStats(1));
    await freeze();
    // Frozen: the claim's own status still moves…
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), claimPath), { status: 'confirmed', resolvedBy: ADMIN }),
    );
    // …and every write that would make it mean anything is denied.
    await assertFails(resolveBoard([3, 4]));
    await assertFails(resolveStats(2));
  });

  // #1151, Codex P2 on PR #1162. The drain gate is what makes the freeze safe to
  // take, and `archiveEvent` re-takes it from the SERVER after the closing write
  // — but the flip's transaction reads only the Event document, so a Claim moved
  // back to `pending` between that read and the commit neither conflicts with it
  // nor retries it. The archive would then be permanent over exactly the state
  // the gate exists to refuse, with a Confirm/Reject pair that can only fail.
  // Rules cannot query a collection, so the drain cannot be a condition of the
  // flip; the TRANSITION that creates the state can be held here instead.
  describe('a Claim cannot go back into the queue once play is closed', () => {
    const claimPath = `${eventPath()}/claims/claim-drained`;
    const seedClaim = (status: string) =>
      testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), claimPath), {
          uid: ALICE,
          displayName: 'Alice',
          cellIndex: 3,
          itemText: 'Something happens',
          status,
          createdAt: NOW(),
          dayIndex: 0,
          resolvedBy: status === 'pending' ? null : ADMIN,
        });
      });
    const reopenClaim = () =>
      updateDoc(doc(db(ADMIN), claimPath), { status: 'pending', resolvedBy: null });

    it('DENIES a terminal Claim being made pending again while the Event is CLOSING', async () => {
      await seedClaim('confirmed');
      // Live, this is an ordinary admin correction and still works — the control
      // that keeps the denial below about the freeze and nothing else.
      await assertSucceeds(reopenClaim());
      await seedClaim('rejected');
      await assertSucceeds(reopenClaim());

      await seedClaim('confirmed');
      await quiesce();
      await assertFails(reopenClaim());
      await seedClaim('rejected');
      await assertFails(reopenClaim());
    });

    it('DENIES it on the ARCHIVED half of the freeze too', async () => {
      await seedClaim('confirmed');
      await freeze();
      await assertFails(reopenClaim());
    });

    // …AND IT MAY NOT RIDE ALONG WITH THE CLOSE ITSELF (#1151, CodeRabbit on
    // PR #1162). `get()` reads the PRE-write Event, so one atomic admin batch
    // that shuts the Event and requeues a terminal Claim was decided against an
    // Event that was still open — both writes committed, and the state they
    // committed together is precisely the one the gate exists to refuse: closed
    // to play, with a Claim back in a queue whose Confirm/Reject pair can now
    // only fail. `getAfter` asks the question of the Event this request will
    // LEAVE behind, which is the only reading a single write cannot slip past.
    it('DENIES an atomic batch that closes the Event and requeues the Claim', async () => {
      await seedClaim('confirmed');
      const database = db(ADMIN);
      const closeAndRequeue = writeBatch(database);
      closeAndRequeue.update(doc(database, eventPath()), {
        archiving: true,
        archiveToken: QUIESCE,
      });
      closeAndRequeue.update(doc(database, claimPath), { status: 'pending', resolvedBy: null });
      await assertFails(closeAndRequeue.commit());

      // The control that keeps the denial about the Claim riding along rather
      // than about the shut: the very same close, alone, still lands.
      const closeAlone = writeBatch(database);
      closeAlone.update(doc(database, eventPath()), { archiving: true, archiveToken: QUIESCE });
      await assertSucceeds(closeAlone.commit());
    });

    it('DENIES an atomic batch that FLIPS the Event and requeues the Claim', async () => {
      // The flip's own arm is reachable only from an ALREADY-quiescing Event, so
      // this batch was denied before the `getAfter` read as well — the stored
      // Event the old clause read was already closing. Pinned anyway, because
      // the two arms are independent and nothing else states that the record's
      // own write cannot carry a requeue beside it.
      await seedClaim('confirmed');
      await quiesce();
      const database = db(ADMIN);
      const flipPayload = {
        status: 'archived',
        archivedAt: ARCHIVED_AT,
        archiving: false,
        archivedUnder: QUIESCE,
        archive: FROZEN_RECORD,
      };
      const flipAndRequeue = writeBatch(database);
      flipAndRequeue.update(doc(database, eventPath()), flipPayload);
      flipAndRequeue.update(doc(database, claimPath), { status: 'pending', resolvedBy: null });
      await assertFails(flipAndRequeue.commit());

      const flipAlone = writeBatch(database);
      flipAlone.update(doc(database, eventPath()), flipPayload);
      await assertSucceeds(flipAlone.commit());
    });

    it('still lets the drain FINISH inside the closing batch', async () => {
      // The resulting status is terminal, so the branch never reaches the Event
      // at all: an Admin may empty the queue and shut the Event in one write.
      await seedClaim('pending');
      const database = db(ADMIN);
      const drainAndClose = writeBatch(database);
      drainAndClose.update(doc(database, eventPath()), {
        archiving: true,
        archiveToken: QUIESCE,
      });
      drainAndClose.update(doc(database, claimPath), { status: 'confirmed', resolvedBy: ADMIN });
      await assertSucceeds(drainAndClose.commit());
    });

    it('leaves the requeue alone in a batch whose Event stays OPEN', async () => {
      // An ordinary admin config write beside the correction: the Event this
      // request leaves behind is open, so the correction is the same ordinary
      // one the live case above already allows.
      await seedClaim('confirmed');
      const database = db(ADMIN);
      const renameAndRequeue = writeBatch(database);
      renameAndRequeue.update(doc(database, eventPath()), { name: 'Archive fixture (renamed)' });
      renameAndRequeue.update(doc(database, claimPath), { status: 'pending', resolvedBy: null });
      await assertSucceeds(renameAndRequeue.commit());
    });

    it('accepts the requeue in a batch that REOPENS play', async () => {
      // The other half of asking about the RESULTING Event, and the one the
      // pre-write read got wrong in the opposite direction: a batch that puts
      // play back leaves an OPEN Event, and a queue an Admin may legitimately
      // refill. Any flip still bound to the quiesce this reopen breaks is
      // refused by the flip arm's own stored-state and generation checks, so
      // nothing downstream depends on the correction being barred here.
      await seedClaim('confirmed');
      await quiesce();
      const database = db(ADMIN);
      const reopenAndRequeue = writeBatch(database);
      reopenAndRequeue.update(doc(database, eventPath()), { archiving: false });
      reopenAndRequeue.update(doc(database, claimPath), { status: 'pending', resolvedBy: null });
      await assertSucceeds(reopenAndRequeue.commit());
    });

    it('still lets the drain FINISH from the closing state', async () => {
      // The window exists so the queue can be emptied. A pending Claim must
      // still reach a terminal status from here, or the gate would bar the very
      // remedy it points the Admin at.
      await seedClaim('pending');
      await quiesce();
      await assertSucceeds(
        updateDoc(doc(db(ADMIN), claimPath), { status: 'confirmed', resolvedBy: ADMIN }),
      );
      await seedClaim('pending');
      await assertSucceeds(
        updateDoc(doc(db(ADMIN), claimPath), { status: 'rejected', resolvedBy: ADMIN }),
      );
    });

    it('leaves an unchanged restatement, other fields, and the DELETE alone while closed', async () => {
      // Restating a stored `pending` is not a transition into it, so a partial
      // update that echoes the status still passes…
      await seedClaim('pending');
      await quiesce();
      await assertSucceeds(
        updateDoc(doc(db(ADMIN), claimPath), { status: 'pending', resolvedBy: null }),
      );
      // …an update that never names `status` at all is untouched…
      await assertSucceeds(updateDoc(doc(db(ADMIN), claimPath), { resolvedBy: ADMIN }));
      // …and the admin's clear-it-away delete is the moderation path the freeze
      // deliberately leaves open (#808).
      await assertSucceeds(deleteDoc(doc(db(ADMIN), claimPath)));
    });

    it('keeps the arm admin-only, closed or not', async () => {
      await seedClaim('confirmed');
      await assertFails(updateDoc(doc(db(BOB), claimPath), { status: 'pending' }));
      await quiesce();
      await assertFails(updateDoc(doc(db(BOB), claimPath), { status: 'pending' }));
    });
  });

  it('keeps the admin Event delete open on a LIVE Event (the control)', async () => {
    await assertFails(deleteDoc(doc(db(BOB), eventPath())));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), eventPath())));
  });

  it('leaves an Event document that carries no status key OPEN', async () => {
    // Every Event written before this ticket has no `status` key at all (and
    // both live Events carry 'active'). A missing status that read as archived
    // would freeze the whole estate on deploy, so absence must mean open.
    await assertSucceeds(
      setDoc(doc(db(BOB), `events/${LEGACY_EVENT}/players/${BOB}`), {
        uid: BOB,
        displayName: 'Bob',
        bingoCount: 0,
        squaresMarked: 0,
        firstBingoAt: null,
        reshufflesUsed: 0,
      }),
    );
  });

  it('keeps the OWNER media delete open where the Event says nothing (#1157)', async () => {
    // The new delete arm reads the Event, so it inherits the absence-means-open
    // obligation the upload arm already carries — and failing closed here would
    // be worse than the hole it fixes: an owner could not clear their own media
    // from a legacy Event, or from a path whose Event document does not exist at
    // all. Neither blob is backed by a Proof document, so the ORPHAN clause is
    // what answers both, and the Event is never fetched at all.
    const legacyBlob = `proofs/${LEGACY_EVENT}/${BOB}/legacy.jpg`;
    const orphanBlob = `proofs/no-such-event/${BOB}/orphan.jpg`;
    await assertSucceeds(uploadBytes(ref(storageOf(BOB), legacyBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(BOB), orphanBlob), TINY, IMAGE));
    await assertSucceeds(deleteObject(ref(storageOf(BOB), legacyBlob)));
    await assertSucceeds(deleteObject(ref(storageOf(BOB), orphanBlob)));
  });

  it('CLOSES the delete-and-recreate window: the OWNER cannot take a LIVE Proof’s object down (#1153)', async () => {
    // Codex round 4 P2. Immutability (`resource == null`) refuses an OVERWRITE
    // and welcomes a RECREATE, so an owner able to delete a live Proof's object
    // could delete it and immediately upload a replacement to the now-empty
    // path. Land that between `proofMediaGeneration()`'s read and `deleteProof`'s
    // commit and the tombstone describes the OLD blob while the path holds the
    // new one: the inline delete fails, the sweeper takes `412`, retires the row
    // as a post-delete replacement, and the deleted Proof's media stays
    // reachable — the outcome immutability was supposed to have closed.
    //
    // The half that closes it is the DELETE arm. With the object unremovable
    // while its document stands, there is nothing to recreate inside the window.
    const blob = photoPath;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), blob), TINY, IMAGE));
    await assertFails(deleteObject(ref(storageOf(ALICE), blob)));
    // The object is STILL THERE, which is the point — a recreate needs an empty
    // path, and the denial is what keeps the path occupied. A second upload is
    // refused as the overwrite immutability already denied.
    await assertFails(uploadBytes(ref(storageOf(ALICE), blob), TINY, IMAGE));
    // …and the moment the Proof document is gone — which is the order
    // `deleteProof` actually runs in, commit first — the same delete is the
    // owner's again.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`));
    });
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), blob)));
  });

  it('keeps an ORPHANED blob the owner’s to clear on a LIVE Event too (#1157)', async () => {
    // The live half of the carve-out, so the closed-Event case above is not the
    // only thing holding it up: an owner may always clear media no Proof
    // document points at, and the Event here plainly exists and is open.
    const orphan = `proofs/${EVENT}/${ALICE}/never-attached.jpg`;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), orphan), TINY, IMAGE));
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), orphan)));
  });

  it('DENIES media whose Proof exists under an Event document that does not (#1157)', async () => {
    // Reachable only for a Proof document living under an Event document that
    // was never written (or was deleted out from under it), and denying is the
    // conservative direction — the blob stays and an Admin-SDK cleanup takes it,
    // rather than the arm falling open on a shape it cannot read.
    //
    // The REASON moved with the arm (#1153, Codex round 5 P2). It used to be the
    // cost of spending the `exists()` on the Proof rather than the Event: the
    // existing-Proof branch's `firestore.get()` on a missing Event errored, and
    // an errored access denies. `proofDocMissing` now gates the whole arm, so
    // this is refused one step earlier and for the plainer reason — a Proof
    // document points at the media. A missing Event document still denies, but
    // now only on the NON-OWNER orphan branch, where the `get()` is the one
    // access left; the OWNER's orphan delete never reads the Event at all, which
    // is what the legacy and Event-less case above proves.
    const strayEvent = 'no-event-document';
    const strayBlob = `proofs/${strayEvent}/${BOB}/stray.jpg`;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `events/${strayEvent}/proofs/stray`), {
        uid: BOB,
        cellIndex: 1,
      });
    });
    await assertSucceeds(uploadBytes(ref(storageOf(BOB), strayBlob), TINY, IMAGE));
    await assertFails(deleteObject(ref(storageOf(BOB), strayBlob)));
  });

  it('never lets a STRANGER delete somebody else\u2019s media, live or frozen', async () => {
    // The control that keeps the case above from reading as "the arm opened up".
    // Bob is neither the path owner nor an admin of this Event.
    const blob = `proofs/${EVENT}/${ALICE}/stranger.jpg`;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), blob), TINY, IMAGE));
    await assertFails(deleteObject(ref(storageOf(BOB), blob)));
    await freeze();
    await assertFails(deleteObject(ref(storageOf(BOB), blob)));
  });
});

// The pending media-revocation tombstone (#134 child 5, #1153). `deleteProof`
// commits the Proof document's removal BEFORE it revokes the media, which fixed
// one failure and opened another: the commit destroys the Proof row, its
// `storagePath` and the retry control at once, so a Storage delete that then
// fails leaves media reachable with nothing recording that it was meant to go.
// `deleteProof` therefore writes the pending revocation in the SAME transaction
// as the Proof delete. These are the arms that make that write safe — and, just
// as importantly, make it POSSIBLE on a frozen Event, since a denial inside that
// transaction would fail the whole takedown, which is the failure this epic
// already fixed once on the Board unmark.
describe('post-sailing-archive — the media-revocation tombstone accompanies its own Proof delete (#1153, #1147)', () => {
  const tombstonePath = (proofId = PROOF, eventId = EVENT) =>
    `events/${eventId}/proofStorageDeletes/${proofId}`;
  const TOMBSTONE = (over: Record<string, unknown> = {}) => ({
    storagePath: photoPath,
    uid: ALICE,
    requestedAt: NOW(),
    ...over,
  });

  /** The takedown in the shape `deleteProof` actually commits it: the tombstone
   *  and its own Proof's delete in ONE request. Both halves must be allowed
   *  together — one denial rejects the whole thing. ONE Firestore instance for
   *  the batch, because `db()` mints a fresh context per call and mixing two
   *  throws before the rules are ever consulted. */
  function takedown(
    uid: string,
    tombstone: Record<string, unknown> = TOMBSTONE(),
    proofId = PROOF,
  ): Promise<void> {
    const fs = db(uid);
    const batch = writeBatch(fs);
    batch.set(doc(fs, tombstonePath(proofId)), tombstone);
    batch.delete(doc(fs, `${eventPath()}/proofs/${proofId}`));
    return batch.commit();
  }

  /** The SAME row, minted ALONE — the squat #1147 is about. */
  const mintAlone = (uid: string, tombstone: Record<string, unknown> = TOMBSTONE(), proofId = PROOF) =>
    setDoc(doc(db(uid), tombstonePath(proofId)), tombstone);

  // THE PROOF THIS SUITE TOMBSTONES ACTUALLY CARRIES MEDIA (#1153, Phase 4b P2).
  // The shared fixture seeds every Proof as a TEXT one — `storagePath: null` —
  // which the arm now refuses a tombstone outright, and rightly: a Proof that
  // stored no object owes no revocation. Every case here is about a Proof that
  // DOES own media, so it is re-seeded to store exactly the `.jpg` the rows
  // below name. (That mismatch is what let the original suite accept a `.jpg`
  // row for a text Proof and miss the binding this arm now makes.)
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`),
        { type: 'photo', storagePath: photoPath, mediaURL: 'https://example.test/p.jpg' },
        { merge: true },
      );
    });
  });

  /** Seed one out-of-band, for the arms that need an existing document. */
  async function seedTombstone(): Promise<void> {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), tombstonePath()), TOMBSTONE());
    });
  }

  /** A Proof create in the shape `attachProof` posts one, under any id. */
  const createProof = (id: string, uid = ALICE, eventId = EVENT) =>
    setDoc(doc(db(uid), `events/${eventId}/proofs/${id}`), {
      uid,
      displayName: 'Alice',
      photoURL: null,
      type: 'text',
      cellIndex: 4,
      itemText: 'Something happens',
      storagePath: null,
      mediaURL: null,
      thumbURL: null,
      text: 'again',
      createdAt: NOW(),
      reportCount: 0,
      status: 'active',
      visionFlag: null,
      source: null,
      dayIndex: 0,
    });

  it('ALLOWS the admin to delete the Proof and record its media IN ONE COMMIT on an ARCHIVED Event', async () => {
    // The Event where it matters most: a permanent record still needs a takedown
    // path (#808), and a denial anywhere in this arm would close it.
    await freeze();
    await assertSucceeds(takedown(ADMIN));
  });

  it('ALLOWS the media’s OWNER while the Event is open, and DENIES it once frozen', async () => {
    // The Proof delete arm's own predicate, restated: exactly the callers who
    // could delete the Proof this accompanies. An owner cannot delete their own
    // Proof out of a frozen record, so they cannot tombstone its media either.
    await assertSucceeds(takedown(ALICE));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), tombstonePath()));
      await setDoc(doc(ctx.firestore(), `${eventPath()}/proofs/${PROOF}`), {
        uid: ALICE,
        displayName: 'Alice',
        type: 'photo',
        cellIndex: 3,
        status: 'active',
        createdAt: NOW(),
        // The object the row names — the arm binds the two together, so a
        // re-seed that dropped it would fail this case for the wrong reason.
        storagePath: photoPath,
      });
    });
    await freeze();
    await assertFails(takedown(ALICE));
  });

  it('DENIES a signed-in stranger, and an unauthenticated writer', async () => {
    await assertFails(takedown(BOB));
    const fs = unauthDb();
    const batch = writeBatch(fs);
    batch.set(doc(fs, tombstonePath()), TOMBSTONE());
    batch.delete(doc(fs, `${eventPath()}/proofs/${PROOF}`));
    await assertFails(batch.commit());
  });

  it('DENIES a tombstone minted WITHOUT the Proof delete it accompanies — and the takedown still runs (#1147)', async () => {
    // The owner-squat hole. Binding the row to a LIVE Proof was not enough on
    // its own: an owner could mint their own Proof's tombstone and leave the
    // Proof standing, after which `deleteProof`'s `set` was an UPDATE against
    // that row, `update` is denied, and a denial inside the takedown's
    // transaction failed the whole takedown — one Player could make every media
    // Proof in the Event permanently un-deletable, and the sweeper would
    // meanwhile revoke media a surviving Feed entry still points at.
    //
    // `existsAfter` closes both by admitting the row ONLY as part of the request
    // that removes its Proof, so a standing row always means a Proof that is
    // already gone and a `set` is always a create.
    await assertFails(mintAlone(ALICE));
    await assertFails(mintAlone(ADMIN));
    // A batch that touches the Proof but does not REMOVE it is the same squat
    // with a decoration, and is refused for the same reason.
    const fs = db(ALICE);
    const batch = writeBatch(fs);
    batch.set(doc(fs, tombstonePath()), TOMBSTONE());
    batch.update(doc(fs, `${eventPath()}/proofs/${PROOF}`), { reportCount: 1 });
    await assertFails(batch.commit());
    // …and with no row standing, the admin takedown the squat used to block
    // still lands.
    await assertSucceeds(takedown(ADMIN));
  });

  it('DENIES a row whose uid is not the Proof’s own owner, or whose Proof does not exist', async () => {
    // The row names the object THAT Proof named, not merely a well-formed path.
    // Bob's own object under Alice's Proof id is the shape the path pin accepts
    // on its own, and the binding is what refuses it — for the admin too.
    await assertFails(
      takedown(ADMIN, TOMBSTONE({ storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg`, uid: BOB })),
    );
    // A Proof that never existed. The admin's Proof-delete arm is a bare
    // `isAdmin` and permits the no-op delete, so this case is about the
    // tombstone alone: `exists()` refuses to mint a revocation for a document
    // that was never there.
    await assertFails(
      takedown(
        ADMIN,
        TOMBSTONE({ storagePath: `proofs/${EVENT}/${ALICE}/never-existed.jpg` }),
        'never-existed',
      ),
    );
  });

  it('DENIES an extra field, a missing field, and a wrong type', async () => {
    await assertFails(takedown(ADMIN, TOMBSTONE({ attempts: 0 })));
    await assertFails(takedown(ADMIN, { storagePath: photoPath, uid: ALICE }));
    await assertFails(takedown(ADMIN, TOMBSTONE({ uid: 7 })));
    await assertFails(takedown(ADMIN, TOMBSTONE({ requestedAt: 'now' })));
  });

  it('ACCEPTS the OPTIONAL generation as a string, and refuses any other shape of it (#1153)', async () => {
    // The object the row targeted, not merely the name it had. Optional because
    // the client reads it from Storage before the commit and that read is best
    // effort: a takedown must not fail because a metadata request did, so a row
    // without the key is still admitted and is revoked by path.
    //
    // The denials run FIRST on purpose: a denied batch writes nothing, so the
    // Proof this arm binds against is still there for the acceptance below —
    // which would otherwise pass for the wrong reason (a missing Proof).
    await assertFails(takedown(ADMIN, TOMBSTONE({ generation: 1700000000000001 })));
    await assertFails(takedown(ADMIN, TOMBSTONE({ generation: null })));
    await assertSucceeds(takedown(ADMIN, TOMBSTONE({ generation: '1700000000000001' })));
  });

  it('DENIES a client-minted row carrying a SWEEP LEASE, and admits the plain row beside it (#1153)', async () => {
    // Codex round 6 P2. `leaseId` / `leaseAt` are `revokeDeletedProofMedia`'s
    // claim on the row — the only fields any server writes to this collection,
    // and what stops two duplicate deliveries of one event both reaching the
    // bucket. A client that could mint a row already carrying one could park an
    // unexpired lease on its own takedown's row and stall the server sweep until
    // the TTL ran out, leaving the reported media in the bucket meanwhile. So
    // `hasOnly` refuses both keys here, exactly as it refuses any other extra.
    //
    // The denials run FIRST on purpose, as in the generation case above: a denied
    // batch writes nothing, so the Proof this arm binds against is still there
    // for the acceptance below — which would otherwise pass for the wrong reason.
    await assertFails(takedown(ADMIN, TOMBSTONE({ leaseId: 'forged' })));
    await assertFails(takedown(ADMIN, TOMBSTONE({ leaseAt: NOW() })));
    await assertFails(takedown(ALICE, TOMBSTONE({ leaseId: 'forged', leaseAt: NOW() })));
    // The same row without them is the ordinary takedown, and still lands.
    await assertSucceeds(takedown(ADMIN, TOMBSTONE()));
  });

  it('DENIES a path naming another Player, another Proof, another Event or another prefix', async () => {
    // The whole point of the durable row is that it authorizes a delete later,
    // so the object it names is pinned by equality to THIS Event, THIS
    // document's Proof id and the uid the row itself declares.
    await assertFails(
      takedown(ADMIN, TOMBSTONE({ storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg` })),
    );
    await assertFails(
      takedown(ADMIN, TOMBSTONE({ storagePath: `proofs/${EVENT}/${ALICE}/other.jpg` })),
    );
    await assertFails(
      takedown(ADMIN, TOMBSTONE({ storagePath: `proofs/${LEGACY_EVENT}/${ALICE}/${PROOF}.jpg` })),
    );
    await assertFails(takedown(ADMIN, TOMBSTONE({ storagePath: `avatars/${ALICE}.jpg` })));
  });

  it('DENIES a row naming an object the live Proof never stored (#1153)', async () => {
    // The gap the shape pin alone left. `{proofId}.webm` satisfies every clause
    // this arm had — the Event prefix, the Proof id, the owner the row declares
    // and the owner the Proof carries — while naming an object this `.jpg`
    // Proof never had. Admitting it lets the client and the sweeper revoke the
    // wrong name, and the Proof document, the only record of which object was
    // really its own, is gone by the time anyone could notice.
    //
    // Both callers are bound: this is a statement about the row, not about
    // permission.
    const wrongObject = `proofs/${EVENT}/${ALICE}/${PROOF}.webm`;
    await assertFails(takedown(ADMIN, TOMBSTONE({ storagePath: wrongObject })));
    await assertFails(takedown(ALICE, TOMBSTONE({ storagePath: wrongObject })));
    // …and the row that names what the Proof actually stores still lands, so
    // the denial above is about the object and not about the arm.
    await assertSucceeds(takedown(ADMIN));
  });

  it('DENIES a tombstone for a TEXT Proof, which stored no object to revoke', async () => {
    // `PROOF_MEDIA` keeps the shared fixture's shape: `type: 'text'`,
    // `storagePath: null`. A Proof that never uploaded anything owes no
    // revocation, so the well-formed `.jpg` row its id would accept on shape
    // alone is refused — `deleteProof` writes none for a text Proof either, and
    // a row that could be minted here would authorize a delete against a name
    // no Proof in this Event ever used.
    await assertFails(
      takedown(
        ADMIN,
        TOMBSTONE({ storagePath: mediaProofPath }),
        PROOF_MEDIA,
      ),
    );
    await assertFails(
      takedown(
        ALICE,
        TOMBSTONE({ storagePath: mediaProofPath }),
        PROOF_MEDIA,
      ),
    );
  });

  it('DENIES every client READ and every UPDATE, the admin’s included', async () => {
    await seedTombstone();
    await assertFails(getDoc(doc(db(ADMIN), tombstonePath())));
    await assertFails(getDoc(doc(db(ALICE), tombstonePath())));
    // Update is denied outright rather than shape-checked, so a pending
    // revocation can never be re-pointed at another object after the fact.
    await assertFails(updateDoc(doc(db(ADMIN), tombstonePath()), { requestedAt: NOW() }));
    await assertFails(
      updateDoc(doc(db(ALICE), tombstonePath()), {
        storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg`,
      }),
    );
    // And a SWEEP LEASE cannot be added after the fact either (#1153, Codex
    // round 6 P2). The update denial now carries that second job: the server
    // stamps `leaseId` / `leaseAt` to claim the row for exclusive processing, so
    // the row is no longer immutable for its whole life — but only to the Admin
    // SDK, which bypasses this file.
    await assertFails(
      updateDoc(doc(db(ALICE), tombstonePath()), { leaseId: 'forged', leaseAt: NOW() }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), tombstonePath()), { leaseId: 'forged', leaseAt: NOW() }),
    );
  });

  it('DENIES every client RETIREMENT — the media’s OWNER above all (#1153)', async () => {
    // Codex round 3 P1. The delete arm used to be `isAdmin || isOwner`, mirrored
    // off who may delete the media directly. That mirror is wrong on the one
    // path this collection exists for: when an Admin takes reported media down
    // and the inline Storage delete fails or is interrupted, this row is the
    // only thing still owing the revocation, and it sits at the entirely
    // predictable `events/{eventId}/proofStorageDeletes/{proofId}`. Denying the
    // READ never prevented a DELETE, so the owner could blind-delete the row,
    // after which `revokeDeletedProofMedia` finds no tombstone, abandons the
    // sweep by design, and the reported photo stays reachable through its
    // download URL. The subject of a takedown must not be able to cancel its
    // durable half, so retirement is SERVER-ONLY — the Admin SDK sweeper
    // bypasses these rules and is untouched.
    await seedTombstone();
    await assertFails(deleteDoc(doc(db(ALICE), tombstonePath())));
    await assertFails(deleteDoc(doc(db(ADMIN), tombstonePath())));
    await assertFails(deleteDoc(doc(db(BOB), tombstonePath())));
    await assertFails(deleteDoc(doc(unauthDb(), tombstonePath())));
    // …and the row is still standing afterwards, so the denials above are real
    // rather than a delete of something already gone.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), tombstonePath()));
      expect(snap.exists()).toBe(true);
    });
  });

  it('DENIES the retirement on a FROZEN Event too — the freeze is not what closes it', async () => {
    // The old arm was deliberately ungated by the freeze, because a tombstone
    // nobody could clear would be swept forever. The sweeper clears it now, so
    // the state of the Event has nothing to do with the answer: no client
    // retires one in any state.
    await seedTombstone();
    await freeze();
    await assertFails(deleteDoc(doc(db(ALICE), tombstonePath())));
    await assertFails(deleteDoc(doc(db(ADMIN), tombstonePath())));
  });

  it('REFUSES bringing the Proof id back while its revocation stands, and FREES it the moment the row is retired (#1153)', async () => {
    // The other half of #1147, closed from the Proof's own side. `existsAfter`
    // stops a row being minted over a LIVE Proof; nothing stopped a live Proof
    // being minted over a STANDING row. An owner could legally delete Proof P
    // together with its tombstone and then re-create P — same id, same
    // `storagePath` — while the Event was open, reassembling exactly the pair the
    // clause forbids: the next admin takedown's `set` becomes an UPDATE against
    // the standing row and is denied, taking the whole transaction with it, and
    // the delayed sweeper meanwhile revokes media the re-created Feed entry
    // still points at, archived Event or not.
    await assertSucceeds(takedown(ALICE));
    await assertFails(createProof(PROOF));
    // The admin is bound by it too — this is not a permission check, it is a
    // statement about an id that still owes a revocation.
    await assertFails(createProof(PROOF, ADMIN));
    // …and the refusal is about THAT id, not about the Event: every other id is
    // untouched, so a Player who just had a Proof taken down can post again.
    await assertSucceeds(createProof('unheld-proof'));
    // Retiring the row releases the id — and ONLY the sweeper can retire one
    // (#1153, Codex round 3 P1), so the release is modelled with the rules
    // disabled, which is what the Admin SDK's bypass actually is. A client
    // attempt is denied and leaves the hold exactly where it was.
    await assertFails(deleteDoc(doc(db(ALICE), tombstonePath())));
    await assertFails(createProof(PROOF));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), tombstonePath()));
    });
    await assertSucceeds(createProof(PROOF));
  });

  it('pins the Proof create arm’s access budget: 10 distinct-Event creates pass and 11 deny', async () => {
    // The measurement the added `exists()` has to answer for. Firestore allows
    // 20 document access calls per multi-document request. The arm spent THREE
    // per Event when its leading predicate was a bare `signedIn()`:
    // `eventOpenForPlay` was `exists()` + `get()` on the Event document, and the
    // revocation check one more `exists()` — six distinct Events cost 18 and
    // passed, seven cost 21 and denied.
    //
    // #804 made the leading predicate `admitted(eventId)`, which reads the SAME
    // Event document with a `get()` — and, measured here, that reordering made
    // the arm CHEAPER, not dearer: the arm now spends TWO accesses per Event,
    // so ten distinct Events cost 20 and pass, eleven cost 22 and deny. Firestore
    // documents only that repeated document access calls on one path within a
    // request may be cached; it does not document which of `get()` and
    // `exists()` seeds that cache for the other, so this test pins the measured
    // count and claims no mechanism. What the number does establish is that no
    // arm gained an access: the admission read absorbed one the freeze check was
    // already paying for.
    //
    // Distinct EVENTS, because the rules engine caches an access per document:
    // repeating the same Event would measure the cache, not the arm. A real
    // request only ever creates one Proof in one Event, which is why the arm's
    // real neighbour is the `attachProof` transaction pinned below.
    const events = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, index) => `${prefix}-${index}`);
    const pass = events(10, 'budget-pass');
    const deny = events(11, 'budget-deny');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      for (const eventId of [...pass, ...deny]) {
        await setDoc(doc(fs, eventPath(eventId)), {
          name: 'Budget fixture',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          settings: { reportHideThreshold: 3 },
          days: [{ index: 0, unlockAt: PAST(), theme: 'neon-playground', pool: 'main' }],
        });
      }
    });

    const create = (ids: string[]) => {
      const fs = db(ALICE);
      const batch = writeBatch(fs);
      for (const eventId of ids) {
        batch.set(doc(fs, `events/${eventId}/proofs/${PROOF}`), {
          uid: ALICE,
          displayName: 'Alice',
          photoURL: null,
          type: 'text',
          cellIndex: 4,
          itemText: 'Something happens',
          storagePath: null,
          mediaURL: null,
          thumbURL: null,
          text: 'again',
          createdAt: NOW(),
          reportCount: 0,
          status: 'active',
          visionFlag: null,
          source: null,
          dayIndex: 0,
        });
      }
      return batch.commit();
    };

    await assertSucceeds(create(pass));
    await assertFails(create(deny));
  });

  it('pins the Proof create arm’s access budget UNDER ENFORCEMENT: 5 distinct-Event creates pass and 6 deny', async () => {
    // The probe above is the UNENFORCED control: its Events carry no
    // `membershipEnforcement`, so `admitted()` returns through the
    // switch-off branch and never spends the membership `exists()` + `get()`.
    // This one seeds the switch ON with an active membership for the writer
    // (Codex round 3 on #1093). Measured, not derived: the membership check is
    // `exists()` then `get()` on the membership record, and the emulator counts
    // those as two accesses, so the arm spends FOUR per Event under enforcement
    // and the boundary moves from ten/eleven to five/six. A real capture creates
    // one Proof in one Event, so four of twenty leaves the same room the
    // `attachProof` transaction below relies on. Both probes stay, because a
    // later clause can regress either path without touching the other.
    const events = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, index) => `${prefix}-${index}`);
    const pass = events(5, 'enforced-pass');
    const deny = events(6, 'enforced-deny');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      for (const eventId of [...pass, ...deny]) {
        await setDoc(doc(fs, eventPath(eventId)), {
          name: 'Enforced budget fixture',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          membershipEnforcement: 'enforced',
          settings: { reportHideThreshold: 3 },
          days: [{ index: 0, unlockAt: PAST(), theme: 'neon-playground', pool: 'main' }],
        });
        await setDoc(doc(fs, `${eventPath(eventId)}/memberships/${ALICE}`), {
          schemaVersion: 1,
          eventId,
          uid: ALICE,
          role: 'member',
          status: 'active',
          grantedAt: NOW(),
          grantedBy: 'system:test',
          invitationId: null,
        });
      }
    });

    const create = (ids: string[]) => {
      const fs = db(ALICE);
      const batch = writeBatch(fs);
      for (const eventId of ids) {
        batch.set(doc(fs, `events/${eventId}/proofs/${PROOF}`), {
          uid: ALICE,
          displayName: 'Alice',
          photoURL: null,
          type: 'text',
          cellIndex: 4,
          itemText: 'Something happens',
          storagePath: null,
          mediaURL: null,
          thumbURL: null,
          text: 'again',
          createdAt: NOW(),
          reportCount: 0,
          status: 'active',
          visionFlag: null,
          source: null,
          dayIndex: 0,
        });
      }
      return batch.commit();
    };

    await assertSucceeds(create(pass));
    await assertFails(create(deny));
  });

  it('ALLOWS the WHOLE attachProof transaction in ONE commit — Proof, Board, stats and Tally marker', async () => {
    // The production shape the create arm's new `exists()` had to stay inside.
    // A capture writes four documents in one transaction, and every arm in it
    // reads the same Event document, so the added access is one more on a
    // request whose Event reads are already cached — not one more per write.
    const fs = db(ALICE);
    const batch = writeBatch(fs);
    batch.set(doc(fs, `${eventPath()}/proofs/fresh-capture`), {
      uid: ALICE,
      displayName: 'Alice',
      photoURL: null,
      type: 'text',
      cellIndex: 6,
      itemText: 'Something happens',
      storagePath: null,
      mediaURL: null,
      thumbURL: null,
      text: 'it happened',
      createdAt: NOW(),
      reportCount: 0,
      status: 'active',
      visionFlag: null,
      source: null,
      dayIndex: 0,
    });
    batch.set(
      doc(fs, `${eventPath()}/days/0/boards/${ALICE}`),
      { cells: cells([6]), markSeed: 7 },
      { merge: true },
    );
    batch.set(doc(fs, `${eventPath()}/players/${ALICE}`), { squaresMarked: 1 }, { merge: true });
    batch.set(doc(fs, `${eventPath()}/tally/${ITEM}/markers/${ALICE}`), {
      eventId: EVENT,
      uid: ALICE,
      displayName: 'Alice',
      markedAt: NOW(),
      itemText: 'Something happens',
      dayIndex: 0,
    });
    await assertSucceeds(batch.commit());
  });

  it('pins the tombstone arm’s access budget: 6 distinct-Event takedowns pass and 7 deny', async () => {
    // The measurement the storagePath binding has to answer for (#1153, Phase
    // 4b P2). It reads the Proof with a `get()` the arm ALREADY performs for the
    // owner check, and the rules engine serves a repeated access to the same
    // document from its per-request cache — so the clause is free. This is what
    // says so out loud rather than leaving it inferred: Firestore allows 20
    // document access calls per multi-document request and the arm spends THREE
    // per Event, so six takedowns cost 18 and pass while seven cost 21 and deny
    // — the SAME boundary as before the binding was added. A future edit that
    // reached for a second distinct document, or that read the Proof by some
    // other path, would move this number.
    //
    // Distinct EVENTS, because the cache is per document: repeating one Event
    // would measure the cache rather than the arm. The real production shape is
    // the single live takedown pinned below.
    const events = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, index) => `${prefix}-${index}`);
    const pass = events(6, 'tombstone-budget-pass');
    const deny = events(7, 'tombstone-budget-deny');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      for (const eventId of [...pass, ...deny]) {
        await setDoc(doc(fs, eventPath(eventId)), {
          name: 'Budget fixture',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          settings: { reportHideThreshold: 3 },
          days: [{ index: 0, unlockAt: PAST(), theme: 'neon-playground', pool: 'main' }],
        });
        await setDoc(doc(fs, `events/${eventId}/proofs/${PROOF}`), {
          uid: ALICE,
          displayName: 'Alice',
          type: 'photo',
          cellIndex: 3,
          status: 'active',
          createdAt: NOW(),
          storagePath: `proofs/${eventId}/${ALICE}/${PROOF}.jpg`,
        });
      }
    });

    const takedowns = (ids: string[]) => {
      const fs = db(ADMIN);
      const batch = writeBatch(fs);
      for (const eventId of ids) {
        batch.set(doc(fs, `events/${eventId}/proofStorageDeletes/${PROOF}`), {
          storagePath: `proofs/${eventId}/${ALICE}/${PROOF}.jpg`,
          uid: ALICE,
          requestedAt: NOW(),
        });
        batch.delete(doc(fs, `events/${eventId}/proofs/${PROOF}`));
      }
      return batch.commit();
    };

    await assertSucceeds(takedowns(pass));
    await assertFails(takedowns(deny));
  });

  it('ALLOWS the WHOLE live-Event takedown in ONE commit — Board, stats, Tally marker, Proof and tombstone', async () => {
    // The budget, spent on the real shape. The tombstone arm adds `exists()`,
    // `get()` and `existsAfter()` on the Proof to a request that already reads
    // the Event document for four other arms, and Firestore caps document
    // access calls per transaction — so the case that would break production is
    // the LIVE takedown, where the gameplay cleanup rides along, rather than the
    // archived one where it is skipped.
    const fs = db(ADMIN);
    const batch = writeBatch(fs);
    batch.set(
      doc(fs, `${eventPath()}/days/0/boards/${ALICE}`),
      { cells: cells(), markSeed: 7 },
      { merge: true },
    );
    batch.set(doc(fs, `${eventPath()}/players/${ALICE}`), { squaresMarked: 0 }, { merge: true });
    batch.delete(doc(fs, `${eventPath()}/tally/${ITEM}/markers/${ALICE}`));
    batch.set(doc(fs, tombstonePath()), TOMBSTONE());
    batch.delete(doc(fs, `${eventPath()}/proofs/${PROOF}`));
    await assertSucceeds(batch.commit());
  });
});
