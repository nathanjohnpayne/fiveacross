import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';

// specs/post-sailing-archive.md, rules layer (#134). Two claims, proved in
// pairs so neither can pass vacuously:
//
//   1. Every GAMEPLAY write that succeeds while the Event is live is DENIED once
//      `EventDoc.status` is 'archived' — Firestore documents and the Storage
//      proof media alike. `specs/path-addressing-and-root.md` § D8 is explicit
//      that hiding the controls client-side would not satisfy this, so each
//      case here is a direct SDK write, not a UI path.
//   2. Admin MODERATION and administration keep working on an archived Event
//      (#808: "an archive that locks out its own Admin is a support incident"),
//      and READS are untouched — the archived read posture is #808's question,
//      not this ticket's.
//
// Plus the archive toggle itself: admin-only, shape-checked, and WRITE-ONCE, so
// the frozen final standings persist unchanged.
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
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const unauthDb = () => testEnv.unauthenticatedContext().firestore();
const storageOf = (uid: string) => testEnv.authenticatedContext(uid).storage();

const eventPath = (eventId = EVENT) => `events/${eventId}`;
const photoPath = `proofs/${EVENT}/${ALICE}/${PROOF}.jpg`;
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

const FROZEN_RECORD = {
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
  dailyHonors: [{ dayIndex: 0, uid: ALICE, displayName: 'Alice', firstBingoAt: 1000 }],
  freezeAt: null,
  archivedAt: 1_700_000_000_000,
};

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
// variable between the "live" and "archived" halves is `status`.
/** The seeded Proof's own `createdAt` — the incarnation stamp a Heart write has
 *  to echo back exactly, so the live control in that case is a real success. */
let proofCreatedAt = 0;

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
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
    await setDoc(doc(fs, `${eventPath()}/proofs/${PROOF}`), {
      uid: ALICE,
      displayName: 'Alice',
      photoURL: null,
      type: 'text',
      cellIndex: 3,
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

/** Freeze the Event out-of-band, so each gameplay case can prove the SAME write
 *  succeeding before and failing after with nothing else changed. */
async function freeze(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), eventPath()), {
      status: 'archived',
      archivedAt: FROZEN_RECORD.archivedAt,
      archive: FROZEN_RECORD,
    });
  });
}

describe('post-sailing-archive — the archive toggle is admin-only and write-once', () => {
  it('ALLOWS an admin to flip status, stamp archivedAt and persist the frozen record', async () => {
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: NOW(),
        archive: FROZEN_RECORD,
      }),
    );
  });

  it('DENIES a Player archiving the Event', async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), eventPath()), {
        status: 'archived',
        archivedAt: NOW(),
        archive: FROZEN_RECORD,
      }),
    );
  });

  it('DENIES an unauthenticated archive', async () => {
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

  it('DENIES archiving without a numeric archivedAt stamp', async () => {
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { status: 'archived', archive: FROZEN_RECORD }),
    );
    for (const bad of ['now', 0, -1, Number.POSITIVE_INFINITY]) {
      await assertFails(
        updateDoc(doc(db(ADMIN), eventPath()), { status: 'archived', archivedAt: bad }),
      );
    }
  });

  it('LOCKS status, archivedAt and the frozen record once archived', async () => {
    await freeze();
    // Un-archiving is not a client operation at all.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { status: 'active' }));
    // Nor is re-stamping…
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedAt: NOW() }));
    // …nor rewriting the record with a later roster.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        archive: { ...FROZEN_RECORD, standings: [], playerCount: 0 },
      }),
    );
    // A partial update that does not mention them carries them through
    // unchanged, so the lock never freezes the rest of the document.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
    // …and echoing the same values back explicitly is still fine.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
      }),
    );
  });
});

describe('post-sailing-archive — gameplay writes stop at the freeze', () => {
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
    await freeze();
    await assertFails(markBoard(ALICE));
    await assertFails(markTally(ALICE));
    // The Admin is bound by the freeze too — an archive its own organiser can
    // still mark is not a frozen record.
    await assertFails(markBoard(ADMIN));
  });

  it('DENIES un-marking (the Tally marker delete) after the freeze', async () => {
    await freeze();
    await assertFails(deleteDoc(doc(db(ALICE), `${eventPath()}/tally/${ITEM}/markers/${ALICE}`)));
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
    await freeze();
    await assertFails(writeStats());
    await assertFails(join());
  });

  it('DENIES claiming an unclaimed daily First-to-BINGO honour', async () => {
    const claimHonor = (dayIndex: number) =>
      setDoc(doc(db(ALICE), `${eventPath()}/days/${dayIndex}/meta/${dayIndex}`), {
        firstBingo: { uid: ALICE, displayName: 'Alice', at: NOW() },
      });
    await assertSucceeds(claimHonor(0));
    await freeze();
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
    await freeze();
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
    const report = () =>
      updateDoc(doc(db(BOB), `${eventPath()}/items/${ITEM}`), { reportCount: 1 });
    await assertSucceeds(submit('new-prompt'));
    await assertSucceeds(report());
    await freeze();
    await assertFails(submit('later-prompt'));
    await assertFails(updateDoc(doc(db(BOB), `${eventPath()}/items/${ITEM}`), { reportCount: 2 }));
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
    await assertSucceeds(createProof('proof-2'));
    await freeze();
    await assertFails(createProof('proof-3'));
    await assertFails(updateDoc(doc(db(BOB), `${eventPath()}/proofs/${PROOF}`), { reportCount: 1 }));
    await assertFails(deleteDoc(doc(db(ALICE), `${eventPath()}/proofs/${PROOF}`)));
  });

  it('leaves a pending Claim resolvable ON PAPER ONLY — the reason the archive drains the queue first', async () => {
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
    // write can carry. `ArchiveEvent` refuses to arm while the Review queue
    // holds one (specs/post-sailing-archive.md § "The admin action"), which is
    // what keeps this state unreachable in the first place.
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

  it('DENIES a Claim create', async () => {
    const makeClaim = (id: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/claims/${id}`), {
        uid: ALICE,
        itemId: ITEM,
        cellIndex: 3,
        createdAt: NOW(),
      });
    await assertSucceeds(makeClaim('claim-1'));
    await freeze();
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
    await freeze();
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
    await freeze();
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
    await freeze();
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
    await freeze();
    await assertFails(
      uploadBytes(ref(storageOf(ALICE), `proofs/${EVENT}/${ALICE}/proof-9.jpg`), TINY, IMAGE),
    );
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), photoPath)));
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
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
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
});
