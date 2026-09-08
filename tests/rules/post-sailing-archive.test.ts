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
// whole-record validation (#1151), and the pending media-revocation tombstone
// (#1153). This ticket freezes the Event; it does not yet snapshot the
// standings, so the flip arm carries `status`, `archivedAt` and the cleared
// quiesce and nothing else.
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
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;

/** The freeze stamp every archive write in this file carries. Fixed rather than
 *  `Date.now()` so the write-once assertions can restate it exactly. */
const ARCHIVED_AT = 1_700_000_000_000;

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

/** The generation id `beginArchive` mints per quiesce (#1139): `archiving: true`
 *  says the Event is shut, never WHICH shut, and the flip is bound to the one
 *  the caller took. */
const QUIESCE = 'quiesce-1';

/** Shut the Event out-of-band into the archive's QUIESCING phase — gameplay
 *  denied, nothing permanent — so the paired gameplay cases can prove the
 *  closing half of the freeze denies exactly what the archived half does. */
async function quiesce(token: string = QUIESCE): Promise<void> {
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
    });
  });
}

/** The archive flip as the rules accept it: the three transition keys, and
 *  nothing else. */
const flip = (uid: string, overrides: Record<string, unknown> = {}) =>
  updateDoc(doc(db(uid), eventPath()), {
    status: 'archived',
    archivedAt: ARCHIVED_AT,
    archiving: false,
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

  it('LOCKS status and archivedAt once archived', async () => {
    await freeze();
    // Un-archiving is not a client operation at all.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { status: 'active' }));
    // Nor is re-stamping the freeze.
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archivedAt: NOW() }));
    // A partial update that does not mention them carries them through
    // unchanged, so the lock never freezes the rest of the document.
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { claimMode: 'proof_required' }));
    // …and echoing the same values back explicitly is still fine.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { status: 'archived', archivedAt: ARCHIVED_AT }),
    );
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
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-1' }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
  });

  // Codex P1, PR #1157 round 6. `abandonArchive` leaves the token in place when
  // it reopens, so a write that merely set `archiving: true` again re-shut the
  // Event under the OLD generation — and a stale `archiveEvent(A)` whose record
  // predates the reopen then passed `boundToStoredQuiesce`. Every shut now has
  // to mint a fresh generation, and nothing but the shut arm can shut.
  it('REQUIRES a fresh generation on every shut — the old token cannot be reused', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true }));
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: '' }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-1' }),
    );
    await assertSucceeds(updateDoc(doc(db(ADMIN), eventPath()), { archiving: false }));
    // Reopened, token still 'quiesce-1' on the document: re-shutting under it
    // is exactly the replay the arm exists to refuse.
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-1' }),
    );
    await assertFails(updateDoc(doc(db(ADMIN), eventPath()), { archiving: true }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { archiving: true, archiveToken: 'quiesce-2' }),
    );
  });

  it('DENIES a shut that smuggles configuration with it, and a create born shut', async () => {
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        archiving: true,
        archiveToken: 'quiesce-1',
        bannedUids: [BOB],
      }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), `events/${LEGACY_EVENT}-born-shut`), {
        name: 'Born shut',
        admins: [ADMIN],
        archiving: true,
        archiveToken: 'quiesce-1',
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
  it('DENIES an archive write bound to a superseded quiesce', async () => {
    await quiesce();
    // The caller opened under an earlier generation; play has been reopened and
    // shut again since.
    await assertFails(flip(ADMIN, { archiveToken: 'quiesce-0' }));
    // The generation actually in force is accepted — so the denial above is
    // about the binding, not about carrying the field at all.
    await assertSucceeds(flip(ADMIN, { archiveToken: QUIESCE }));
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
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), photoPath)));
  });

  it('FREEZES the OWNER media delete while the Admin takedown stays open', async () => {
    // Phase 4b P1, PR #1157. The owner's Storage delete arm was unconditional,
    // so a direct `deleteObject` stripped an archived Proof's media although
    // `firestore.rules` refuses the owner's DOCUMENT delete on a closed Event —
    // leaving a Feed entry whose image can never load, on the one Event where
    // nothing can be re-posted. The ADMIN takedown is deliberately untouched:
    // a frozen record that locks out its own Admin is #808's incident again.
    //
    // BOTH blobs are backed by a seeded Proof DOCUMENT, which is what puts them
    // inside the freeze at all: the carve-out below releases only media nothing
    // points at, so a case built on orphans would prove the opposite of this one.
    const ownerBlob = photoPath;
    const adminBlob = mediaProofPath;
    // Live controls: BOTH deletes work while the Event is open to play, so the
    // denial below is a claim about the freeze rather than about the arm.
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), ownerBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), adminBlob), TINY, IMAGE));
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), ownerBlob)));
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), adminBlob)));
    // Re-seeded before the shut, because the upload arm closes with it.
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), ownerBlob), TINY, IMAGE));
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), adminBlob), TINY, IMAGE));
    await close();
    await assertFails(deleteObject(ref(storageOf(ALICE), ownerBlob)));
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), adminBlob)));
    // The owner's blob survived its own denial, and the Admin can still take it
    // down — which is also the proof that the admin arm did not simply run out
    // of Firestore accesses and fail closed.
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), ownerBlob)));
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

  it('keeps an ORPHANED blob the owner’s to clear on a LIVE Event too (#1157)', async () => {
    // The live half of the carve-out, so the closed-Event case above is not the
    // only thing holding it up: an owner may always clear media no Proof
    // document points at, and the Event here plainly exists and is open.
    const orphan = `proofs/${EVENT}/${ALICE}/never-attached.jpg`;
    await assertSucceeds(uploadBytes(ref(storageOf(ALICE), orphan), TINY, IMAGE));
    await assertSucceeds(deleteObject(ref(storageOf(ALICE), orphan)));
  });

  it('DENIES media whose Proof exists under an Event document that does not (#1157)', async () => {
    // The cost of spending the arm's `exists()` on the Proof rather than the
    // Event: the existing-Proof branch's `firestore.get()` on a missing Event
    // errors, and an errored access denies. Reachable only for a Proof document
    // living under an Event document that was never written (or was deleted out
    // from under it), and denying is the conservative direction — the blob stays
    // and an Admin-SDK cleanup takes it, rather than the arm falling open on a
    // shape it cannot read.
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
