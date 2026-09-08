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
      archiving: false,
    });
  });
}

/** The generation id `beginArchive` mints per quiesce (#1139): `archiving: true`
 *  says the Event is shut, never WHICH shut, and the flip is bound to the one
 *  its record was read against. */
const QUIESCE = 'quiesce-1';

/** Shut the Event out-of-band into the archive's QUIESCING phase — gameplay
 *  denied, no record taken — so the paired gameplay cases can prove the closing
 *  half of the freeze denies exactly what the archived half does. */
async function quiesce(token: string = QUIESCE): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: true, archiveToken: token });
  });
}

describe('post-sailing-archive — the archive toggle is admin-only and write-once', () => {
  it('ALLOWS an admin to flip status, stamp archivedAt and persist the frozen record', async () => {
    await quiesce();
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        // The document stamp and the record's own stamp are ONE value written
        // in one update, and the rules hold them equal.
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
      }),
    );
  });

  it('DENIES a Player archiving the Event', async () => {
    await quiesce();
    await assertFails(
      updateDoc(doc(db(ALICE), eventPath()), {
        status: 'archived',
        archivedAt: NOW(),
        archive: FROZEN_RECORD,
      }),
    );
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

  it('DENIES archiving without a numeric archivedAt stamp', async () => {
    await quiesce();
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

// Codex P1, PR #1139. The archive transaction reads ONE document and writes ONE
// document, so it serializes against nothing in `players`, `boards`, `claims` or
// `tally`. The quiesce is what closes that hole: gameplay is shut by a first
// admin write, and only from THAT state may the record be taken — which is a
// property the rules must hold, because a client-side ordering convention is
// exactly what a direct SDK write ignores.
describe('post-sailing-archive — the quiesce shuts gameplay before the record is taken', () => {
  it('ALLOWS an admin to shut the Event, and to reopen it while the archive is uncommitted', async () => {
    // REVERSIBLE on purpose: the first write shuts gameplay for everyone, so a
    // freeze that failed halfway (or an Admin who changed their mind) must not
    // leave a live Event permanently unplayable.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
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

  it('DENIES a Mark, a Claim and a proof-media upload once the Event is closing', async () => {
    // The SAME paired shape the archived half uses: each write succeeds while
    // the Event is open and fails once shut, with nothing else changed. This is
    // the whole point of the closing state — a quiescing phase a Player could
    // still write through would quiesce nothing.
    const markBoard = () =>
      setDoc(
        doc(db(ALICE), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells([3]), markSeed: 7 },
        { merge: true },
      );
    const makeClaim = (id: string) =>
      setDoc(doc(db(ALICE), `${eventPath()}/claims/${id}`), {
        uid: ALICE,
        itemId: ITEM,
        cellIndex: 3,
        createdAt: NOW(),
      });
    await assertSucceeds(markBoard());
    await assertSucceeds(makeClaim('claim-open'));
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), photoPath), TINY, IMAGE));

    await quiesce();

    await assertFails(markBoard());
    await assertFails(makeClaim('claim-closed'));
    await assertFails(
      uploadBytes(ref(storageOf(ALICE), `proofs/${EVENT}/${ALICE}/proof-closing.jpg`), TINY, IMAGE),
    );
    // Admins are bound by the closing state too, exactly as they are by the
    // freeze: a quiesce its own organiser can mark through freezes nothing.
    await assertFails(
      setDoc(
        doc(db(ADMIN), `${eventPath()}/days/0/boards/${ALICE}`),
        { cells: cells([4]), markSeed: 7 },
        { merge: true },
      ),
    );
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
  // but the two documents the frozen record is BUILT from are the exception.
  // `archiveEvent` re-reads the roster and every Day's honour pin from the
  // server after the close and then commits in a transaction that reads ONLY
  // the Event document, so a delete landing in that window is neither ordered
  // against the freeze nor caught by it: the write-once record keeps a row
  // moderation had already removed. They hold still until the record exists.
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

    // Shut: the record is being read against these documents.
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
    const archive = () =>
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
      });
    // Straight off a live Event: refused. There is no window in which the
    // roster had stopped moving, so the record cannot be trusted to be whole.
    await assertFails(archive());
    await quiesce();
    await assertSucceeds(archive());
  });

  it('DENIES an archive write that smuggles a configuration change with it', async () => {
    // The flip rides its own arm, which skips the schedule and freeze-boundary
    // validation the ordinary admin arm performs. `affectedKeys().hasOnly` is
    // what keeps that a short-circuit rather than a hole: anything beyond the
    // four archive fields is not an archive write and falls through to the arm
    // that does check those fields — where a not-yet-archived document is
    // refused.
    await quiesce();
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
        standingsFreezeAt: PAST(),
      }),
    );
  });

  // Codex P1, PR #1139 round 4. Being shut is not the same as being the shut
  // the record was read against: play can be REOPENED and SHUT AGAIN while a
  // snapshot is in flight, and the document the freeze then writes against
  // carries an `archiving: true` indistinguishable from the first. The
  // generation id makes the two distinguishable, at the boundary rather than
  // only in the client that checks.
  it('DENIES an archive write bound to a superseded quiesce', async () => {
    const archiveBoundTo = (token: string) =>
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
        archiveToken: token,
      });
    await quiesce();
    // The record was read under an earlier generation; play has been reopened
    // and shut again since.
    await assertFails(archiveBoundTo('quiesce-0'));
    // The generation actually in force is accepted — so the denial above is
    // about the binding, not about carrying the field at all.
    await assertSucceeds(archiveBoundTo(QUIESCE));
  });

  it('DENIES the flip from a closing state that carries no generation at all', async () => {
    // An unidentified quiesce is exactly the state the binding exists to tell
    // apart from another, so it fails closed. `beginArchive` mints one, which
    // is how a state shut by a pre-token build becomes archivable again.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), eventPath()), { archiving: true });
    });
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
      }),
    );
    // …and with a generation in place the identical write lands.
    await quiesce();
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: false,
      }),
    );
  });

  it('DENIES an archive write that leaves the closing flag set', async () => {
    // The quiesce ends with the freeze. A document carrying both would hold a
    // CLEARABLE second spelling of a state that must not be clearable.
    await quiesce();
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archive: FROZEN_RECORD,
        archiving: true,
      }),
    );
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

// Codex P2, PR #1139. Type-checking `archive` only when present accepted
// `{status: 'archived', archivedAt}` on its own — a state that is both
// irreversible and useless: the freeze denies every gameplay write while the
// Leaderboard falls back to the LIVE view the archive exists to replace, and a
// half-built map throws in `ArchivedLeaderboard`.
describe('post-sailing-archive — the archive write must carry the whole record', () => {
  const archiveWith = (record: unknown) =>
    updateDoc(doc(db(ADMIN), eventPath()), {
      status: 'archived',
      archivedAt: FROZEN_RECORD.archivedAt,
      archive: record,
      archiving: false,
    });

  beforeEach(async () => {
    await quiesce();
  });

  it('DENIES the flip with no record at all, or an empty one', async () => {
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        status: 'archived',
        archivedAt: FROZEN_RECORD.archivedAt,
        archiving: false,
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

  it('ALLOWS the pair when both halves name the same holder', async () => {
    // The matching control, so the denials above are not vacuous.
    await assertSucceeds(archiveWith(FROZEN_RECORD));
  });

  it('DENIES a record whose stamp disagrees with the document stamp', async () => {
    // Two answers to one question is exactly what the archived surfaces would
    // then show; both are written from one value in one update.
    await assertFails(archiveWith({ ...FROZEN_RECORD, archivedAt: FROZEN_RECORD.archivedAt + 1 }));
  });

  it('ALLOWS the complete record, including the legitimately null trio', async () => {
    // `firstBingo`/`firstBingoRow: null` means nobody got there and
    // `freezeAt: null` means the Event had no Standings Freeze — both are real
    // records, so the check is presence-then-type-or-null rather than a bare
    // `is map`/`is number`.
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
    // The two snapshot-defining deletes REOPEN once the record exists (#1139).
    // They are shut only for the length of the quiesce, because the archived
    // Leaderboard renders the frozen record rather than these documents — and a
    // permanent record whose Players could never be erased is #808 again.
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/players/${ALICE}`)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${eventPath()}/days/0/meta/0`), {
        firstBingo: { uid: ALICE, displayName: 'Alice', at: 1000 },
      });
    });
    await assertSucceeds(deleteDoc(doc(db(ADMIN), `${eventPath()}/days/0/meta/0`)));
  });

  it("keeps the admin Proof DELETE open while denying the Board unmark it used to carry", async () => {
    // The shape `deleteProof` used to write in ONE transaction: remove the Proof
    // document, unmark the Board cell it backed, rewrite the owner's stats, drop
    // their Tally marker. The delete is moderation and stays open; the Board and
    // Player writes are gameplay `eventOpenForPlay` denies — for an ADMIN as
    // much as anyone, since the freeze binds the organiser too. One transaction,
    // so those two denials took the delete down with them and the advertised
    // takedown failed on exactly the Event whose record can never be rewritten.
    // The client now skips the cleanup; these are the denials that make that the
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

// #134, Codex P1 on PR #1139 (specs/post-sailing-archive.md § "Moderation is not
// a gameplay write"). Moving the Storage delete after the Firestore commit fixed
// one failure and opened another: the commit destroys the Proof row, its
// `storagePath` and the retry control at once, so a Storage delete that then
// fails leaves media reachable with nothing recording that it was meant to go.
// `deleteProof` therefore writes the pending revocation in the SAME transaction
// as the Proof delete. These are the arms that make that write safe — and, just
// as importantly, make it POSSIBLE on a frozen Event, since a denial inside that
// transaction would fail the whole takedown, which is the failure this ticket
// already fixed once on the Board unmark.
describe('post-sailing-archive — the pending media-revocation tombstone is admin/owner-only and shape-pinned', () => {
  const tombstonePath = (proofId = PROOF, eventId = EVENT) =>
    `events/${eventId}/proofStorageDeletes/${proofId}`;
  const TOMBSTONE = () => ({ storagePath: photoPath, uid: ALICE, requestedAt: NOW() });

  /** Seed one out-of-band, for the arms that need an existing document. */
  async function seedTombstone(): Promise<void> {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), tombstonePath()), TOMBSTONE());
    });
  }

  it('ALLOWS an admin to record a pending revocation for the object the Proof named', async () => {
    await assertSucceeds(setDoc(doc(db(ADMIN), tombstonePath()), TOMBSTONE()));
  });

  it('ALLOWS the admin takedown to delete the Proof and record its media IN ONE COMMIT on an ARCHIVED Event', async () => {
    // The shape `deleteProof` actually writes, on the Event where it matters
    // most. Both halves must be allowed together: one denial rejects the whole
    // transaction, and a permanent record still needs a takedown path (#808).
    await freeze();
    const adminDb = db(ADMIN);
    const batch = writeBatch(adminDb);
    batch.set(doc(adminDb, tombstonePath()), TOMBSTONE());
    batch.delete(doc(adminDb, `${eventPath()}/proofs/${PROOF}`));
    await assertSucceeds(batch.commit());
  });

  it('ALLOWS the media’s OWNER to record one while the Event is open, and DENIES it once frozen', async () => {
    // The Proof delete arm’s own predicate, restated: exactly the callers who
    // could delete the Proof this accompanies. An owner cannot delete their own
    // Proof out of a frozen record, so they cannot tombstone its media either.
    await assertSucceeds(setDoc(doc(db(ALICE), tombstonePath()), TOMBSTONE()));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), tombstonePath()));
    });
    await freeze();
    await assertFails(setDoc(doc(db(ALICE), tombstonePath()), TOMBSTONE()));
  });

  it('DENIES a signed-in stranger, and an unauthenticated writer', async () => {
    await assertFails(setDoc(doc(db(BOB), tombstonePath()), TOMBSTONE()));
    await assertFails(setDoc(doc(unauthDb(), tombstonePath()), TOMBSTONE()));
  });

  it('DENIES SQUATTING another Player’s Proof id, which would make the takedown un-runnable', async () => {
    // Without the binding to the live Proof, BOB could pre-create the row at
    // ALICE's Proof id — naming an object under his OWN uid, which the path pin
    // accepts on its own — and `deleteProof`'s `set` would then be an UPDATE
    // against a squatted row. `update` is denied, and a denial inside that
    // transaction fails the whole takedown, so one Player could make every media
    // Proof in the Event permanently un-deletable.
    await assertFails(
      setDoc(doc(db(BOB), tombstonePath()), {
        storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg`,
        uid: BOB,
        requestedAt: NOW(),
      }),
    );
    // …and no row may be minted for a Proof that does not exist at all, which is
    // the same squat aimed one step earlier.
    await assertFails(
      setDoc(doc(db(ALICE), tombstonePath('never-existed')), {
        storagePath: `proofs/${EVENT}/${ALICE}/never-existed.jpg`,
        uid: ALICE,
        requestedAt: NOW(),
      }),
    );
    // The admin is bound by the same binding — the row must name the Proof's
    // real owner, not merely a well-formed path.
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), {
        storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg`,
        uid: BOB,
        requestedAt: NOW(),
      }),
    );
  });

  it('DENIES an extra field, a missing field, and a wrong type', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), attempts: 0 }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { storagePath: photoPath, uid: ALICE }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), uid: 7 }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), requestedAt: 'now' }),
    );
  });

  it('DENIES a path naming another Player, another Proof, another Event or another prefix', async () => {
    // The whole point of the durable row is that it authorizes a delete later,
    // so the object it names is pinned by equality to THIS Event, THIS document's
    // Proof id and the uid the row itself declares.
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg` }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), storagePath: `proofs/${EVENT}/${ALICE}/other.jpg` }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), storagePath: `proofs/${LEGACY_EVENT}/${ALICE}/${PROOF}.jpg` }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), tombstonePath()), { ...TOMBSTONE(), storagePath: `avatars/${ALICE}.jpg` }),
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
      updateDoc(doc(db(ALICE), tombstonePath()), { storagePath: `proofs/${EVENT}/${BOB}/${PROOF}.jpg` }),
    );
  });

  it('ALLOWS the admin and the named owner to retire a discharged revocation, and DENIES a stranger', async () => {
    await seedTombstone();
    await assertFails(deleteDoc(doc(db(BOB), tombstonePath())));
    await assertSucceeds(deleteDoc(doc(db(ALICE), tombstonePath())));
    await seedTombstone();
    await assertSucceeds(deleteDoc(doc(db(ADMIN), tombstonePath())));
  });

  it('leaves the retirement OPEN on a frozen Event — a tombstone that could not be cleared would be swept forever', async () => {
    await seedTombstone();
    await freeze();
    await assertSucceeds(deleteDoc(doc(db(ALICE), tombstonePath())));
  });
});
