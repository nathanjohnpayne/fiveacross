import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { clearStorageDeep } from '../support/storage-emulator';

// specs/sec-rules-shape-hardening.md — the type/size/host checks on the
// participant-authored fields other clients render (users, players, proofs,
// moments), the Claim create shape and its Proof-ownership binding, the Proof id
// shape the media regexes splice in, and the Storage content-type / object-name
// / Event-existence checks on uploads. Each clause has a DENY case for the shape
// it refuses and an ALLOW case for the write the app actually makes.
//
// ADR 0001 stays intact: the Player row's STATS remain freely self-written, and
// a legacy row carrying a value the new checks would refuse is still writable
// for every field it does not touch (pinned below).

const firestoreRules = readFileSync(
  fileURLToPath(new URL('../../firestore.rules', import.meta.url)),
  'utf8',
);
const storageRules = readFileSync(
  fileURLToPath(new URL('../../storage.rules', import.meta.url)),
  'utf8',
);

const EVENT = 'evtshape';
const MISSING_EVENT = 'evtmissing';
const [ALICE, BOB, ADMIN] = ['alice', 'bob', 'carol'];
const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocK-example=s96-c';
const STORAGE_PHOTO =
  'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Falice.jpg?alt=media&token=t';
// The same object path in a bucket some other Firebase project owns, and
// another user's avatar object in the app's own bucket.
const FOREIGN_BUCKET_PHOTO =
  'https://firebasestorage.googleapis.com/v0/b/attacker-project.appspot.com/o/avatars%2Falice.jpg?alt=media';
const OTHER_USERS_AVATAR =
  'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/avatars%2Fbob.jpg?alt=media';
const OFF_HOST_PHOTO = 'https://tracker.example/pixel.gif';
const NOW = () => Date.now();
const at = (path: string) => `events/${EVENT}/${path}`;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();

beforeAll(async () => {
  // Storage's cross-service `firestore.get()` resolves against the project the
  // emulator booted with, so this env binds to that project (the same reason
  // w0-storage-rules.test.ts does).
  const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  const [stHost, stPort] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? 'gaycruisebingo',
    firestore: { host: fsHost, port: Number(fsPort), rules: firestoreRules },
    storage: { host: stHost, port: Number(stPort), rules: storageRules },
  });
});

beforeEach(async () => {
  await clearStorageDeep(testEnv);
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, `events/${EVENT}`), { admins: [ADMIN], membershipEnforcement: 'off' });
    // A LEGACY profile and Player row carrying values the new checks refuse:
    // the rows must stay writable for every field a write does not touch.
    await setDoc(doc(fs, `users/${BOB}`), {
      displayName: 42,
      photoURL: OFF_HOST_PHOTO,
      createdAt: NOW(),
      legacyKey: true,
    });
    await setDoc(doc(fs, at(`players/${BOB}`)), {
      uid: BOB,
      displayName: { not: 'a string' },
      photoURL: OFF_HOST_PHOTO,
      joinedAt: NOW(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
    });
    // Bob's own pending Proof — the one a forged Claim would try to name.
    await setDoc(doc(fs, at('proofs/bobProof1')), textProof(BOB, 'pending'));
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

function textProof(uid: string, status: 'active' | 'pending' = 'active', extra: Record<string, unknown> = {}) {
  return {
    uid,
    displayName: uid,
    photoURL: null,
    type: 'text',
    cellIndex: 3,
    itemText: 'A prompt',
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'It happened.',
    createdAt: NOW(),
    reportCount: 0,
    status,
    visionFlag: null,
    source: null,
    dayIndex: 0,
    ...extra,
  };
}

function claim(uid: string, proofId: string | null, extra: Record<string, unknown> = {}) {
  return {
    uid,
    displayName: uid,
    cellIndex: 3,
    itemText: 'A prompt',
    proofId,
    status: 'pending',
    createdAt: NOW(),
    resolvedBy: null,
    dayIndex: 0,
    ...extra,
  };
}

describe('users/{uid} — the owner writes only the profile fields the app writes', () => {
  it('ALLOWS the bootstrap create with a Google photo, and the edits the app makes', async () => {
    const ref = doc(db(ALICE), `users/${ALICE}`);
    await assertSucceeds(setDoc(ref, { displayName: 'Alice', photoURL: GOOGLE_PHOTO, createdAt: NOW() }));
    await assertSucceeds(setDoc(ref, { displayName: 'Alice B' }, { merge: true }));
    await assertSucceeds(setDoc(ref, { photoURL: STORAGE_PHOTO, customPhoto: true }, { merge: true }));
    await assertSucceeds(setDoc(ref, { attestedAdultAt: NOW() }, { merge: true }));
    await assertSucceeds(setDoc(ref, { photoURL: null }, { merge: true }));
  });

  it('DENIES an avatar on any other host, scheme or type', async () => {
    const ref = doc(db(ALICE), `users/${ALICE}`);
    for (const photoURL of [
      OFF_HOST_PHOTO,
      FOREIGN_BUCKET_PHOTO,
      OTHER_USERS_AVATAR,
      'https://firebasestorage.googleapis.com/v0/b/fiveacross.firebasestorage.app/o/proofs%2Fe%2Falice%2Fp.jpg',
      'http://lh3.googleusercontent.com/a/x',
      'https://lh3.googleusercontent.com.tracker.example/a/x',
      'javascript:alert(1)',
      42,
      { url: GOOGLE_PHOTO },
      `https://lh3.googleusercontent.com/${'a'.repeat(1100)}`,
    ]) {
      await assertFails(setDoc(ref, { displayName: 'Alice', photoURL, createdAt: NOW() }));
    }
  });

  it('DENIES a non-string or over-long displayName, an unknown key, and a non-boolean customPhoto', async () => {
    const ref = doc(db(ALICE), `users/${ALICE}`);
    await assertFails(setDoc(ref, { displayName: 7, photoURL: null, createdAt: NOW() }));
    await assertFails(setDoc(ref, { displayName: 'A'.repeat(101), photoURL: null, createdAt: NOW() }));
    await assertFails(setDoc(ref, { displayName: 'Alice', photoURL: null, createdAt: NOW(), isAdmin: true }));
    await assertFails(setDoc(ref, { displayName: 'Alice', photoURL: null, customPhoto: 'yes' }));
  });

  it('keeps a LEGACY row writable for the fields a write does not touch, and checks the ones it does', async () => {
    const ref = doc(db(BOB), `users/${BOB}`);
    await assertSucceeds(setDoc(ref, { attestedAdultAt: NOW() }, { merge: true }));
    await assertSucceeds(setDoc(ref, { displayName: 'Bob' }, { merge: true }));
    await assertFails(setDoc(ref, { photoURL: 'https://other.example/b.jpg' }, { merge: true }));
    await assertFails(setDoc(ref, { anotherLegacyKey: 1 }, { merge: true }));
    // REMOVING a stale key (or clearing a field) only makes the row cleaner.
    await assertSucceeds(updateDoc(ref, { legacyKey: deleteField() }));
    await assertSucceeds(updateDoc(ref, { photoURL: deleteField() }));
  });
});

describe('players/{uid} — identity fields are typed; stats stay self-written (ADR 0001)', () => {
  const base = (extra: Record<string, unknown> = {}) => ({
    uid: ALICE,
    displayName: 'Alice',
    photoURL: GOOGLE_PHOTO,
    joinedAt: NOW(),
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    blackout: false,
    ...extra,
  });

  it('ALLOWS the join write and a later identity refresh', async () => {
    const ref = doc(db(ALICE), at(`players/${ALICE}`));
    await assertSucceeds(setDoc(ref, base(), { merge: true }));
    await assertSucceeds(setDoc(ref, { displayName: 'Alice B', photoURL: STORAGE_PHOTO }, { merge: true }));
    await assertSucceeds(setDoc(ref, { photoURL: null }, { merge: true }));
  });

  it('DENIES a non-string or over-long name and an off-host or non-string avatar', async () => {
    const ref = doc(db(ALICE), at(`players/${ALICE}`));
    await assertFails(setDoc(ref, base({ displayName: 12345 })));
    await assertFails(setDoc(ref, base({ displayName: 'A'.repeat(101) })));
    await assertFails(setDoc(ref, base({ photoURL: OFF_HOST_PHOTO })));
    await assertFails(setDoc(ref, base({ photoURL: FOREIGN_BUCKET_PHOTO })));
    await assertFails(setDoc(ref, base({ photoURL: OTHER_USERS_AVATAR })));
    await assertFails(setDoc(ref, base({ photoURL: { src: GOOGLE_PHOTO } })));
  });

  it('still ALLOWS stat-only writes on a legacy row whose stored identity would now be refused', async () => {
    const ref = doc(db(BOB), at(`players/${BOB}`));
    await assertSucceeds(setDoc(ref, { bingoCount: 1, squaresMarked: 5 }, { merge: true }));
    await assertFails(setDoc(ref, { displayName: ['still', 'not', 'a', 'string'] }, { merge: true }));
  });
});

describe('proofs/{proofId} — the create holds the id, the Callout text and the avatar', () => {
  it('ALLOWS the text Proof attachProof writes under an auto-id', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at('proofs/Ab3dEf6hIj9kLm2nOp4q')), textProof(ALICE)));
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('proofs/googlePhotoProof')), textProof(ALICE, 'active', { photoURL: GOOGLE_PHOTO })),
    );
  });

  it('DENIES a Proof id carrying regex metacharacters or other non-auto-id characters', async () => {
    for (const id of ['a.b', 'x|y', 'p(1)', 'star*', 'under_score', 'sp ace', 'a'.repeat(41)]) {
      await assertFails(setDoc(doc(db(ALICE), at(`proofs/${id}`)), textProof(ALICE)));
    }
  });

  it('DENIES a photo Proof whose id would widen the mediaURL pattern to another object', async () => {
    // Before the id check, `.` in the id reached `matches()` unescaped, so this
    // pair — a storagePath for one name and a mediaURL for a DIFFERENT one — was
    // admitted. It is refused on the id before the pattern is ever built.
    const id = 'pa.b';
    await assertFails(
      setDoc(doc(db(ALICE), at(`proofs/${id}`)), {
        ...textProof(ALICE),
        type: 'photo',
        text: null,
        storagePath: `proofs/${EVENT}/${ALICE}/${id}.jpg`,
        mediaURL: `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2F${EVENT}%2F${ALICE}%2FpaXb.jpg?alt=media`,
      }),
    );
  });

  it('DENIES a non-string or over-long Callout text, and an off-host avatar', async () => {
    const put = (id: string, extra: Record<string, unknown>) =>
      setDoc(doc(db(ALICE), at(`proofs/${id}`)), textProof(ALICE, 'active', extra));
    await assertFails(put('textMap', { text: { rich: true } }));
    await assertFails(put('textNum', { text: 5 }));
    await assertFails(put('textLong', { text: 'x'.repeat(1001) }));
    await assertFails(put('photoOff', { photoURL: OFF_HOST_PHOTO }));
    await assertFails(put('photoForeign', { photoURL: FOREIGN_BUCKET_PHOTO }));
    await assertFails(put('photoOthers', { photoURL: OTHER_USERS_AVATAR }));
    await assertSucceeds(put('photoOwn', { photoURL: STORAGE_PHOTO }));
    await assertSucceeds(put('textNull', { text: null }));
  });
});

describe('moments/{momentId} — the avatar is pinned like every other', () => {
  const moment = (photoURL: unknown) => ({
    kind: 'bingo',
    uid: ALICE,
    displayName: 'Alice',
    photoURL,
    createdAt: NOW(),
  });

  it('ALLOWS a Moment with a Google avatar or none', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at(`moments/${ALICE}-bingo`)), moment(GOOGLE_PHOTO)));
    await assertSucceeds(setDoc(doc(db(ALICE), at(`moments/${ALICE}-blackout`)), { ...moment(null), kind: 'blackout' }));
  });

  it('DENIES a Moment carrying an off-host, foreign-bucket or someone else\'s avatar', async () => {
    for (const photoURL of [OFF_HOST_PHOTO, FOREIGN_BUCKET_PHOTO, OTHER_USERS_AVATAR]) {
      await assertFails(setDoc(doc(db(ALICE), at(`moments/${ALICE}-bingo`)), moment(photoURL)));
    }
  });
});

describe('claims/{claimId} — the create is the attachProof shape, naming the creator’s own Proof', () => {
  it('ALLOWS the pending Proof and its Claim written together, as attachProof does', async () => {
    const alice = db(ALICE);
    const batch = writeBatch(alice);
    batch.set(doc(alice, at('proofs/aliceProof1')), textProof(ALICE, 'pending'));
    batch.set(doc(alice, at('claims/aliceClaim1')), claim(ALICE, 'aliceProof1'));
    await assertSucceeds(batch.commit());
  });

  it('DENIES a batch that creates somebody else’s Claim beside one’s own Proof', async () => {
    const bob = db(BOB);
    const batch = writeBatch(bob);
    batch.set(doc(bob, at('proofs/bobProof2')), textProof(BOB, 'pending'));
    batch.set(doc(bob, at('claims/bobClaimForAlice')), claim(BOB, 'aliceNone'));
    await assertFails(batch.commit());
  });

  it('ALLOWS a Claim naming the creator’s own existing Proof, and a proofless legacy Claim', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('proofs/aliceProof2')), textProof(ALICE, 'pending'));
    });
    await assertSucceeds(setDoc(doc(db(ALICE), at('claims/c2')), claim(ALICE, 'aliceProof2')));
    const legacy: Record<string, unknown> = claim(ALICE, null);
    delete legacy.dayIndex;
    await assertSucceeds(setDoc(doc(db(ALICE), at('claims/c3')), legacy));
  });

  it('DENIES a Claim naming ANOTHER Player’s Proof, or one that does not exist', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('claims/forged')), claim(ALICE, 'bobProof1')));
    await assertFails(setDoc(doc(db(ALICE), at('claims/ghost')), claim(ALICE, 'noSuchProof')));
  });

  it('DENIES a proofId that is not an auto-id, so the lookup cannot be walked elsewhere', async () => {
    await assertFails(setDoc(doc(db(ALICE), at('claims/walk')), claim(ALICE, `x/../${ALICE}`)));
    await assertFails(setDoc(doc(db(ALICE), at('claims/walk2')), claim(ALICE, 'a.b')));
  });

  it('DENIES a bare or pre-resolved Claim, an extra key, and a mistyped name or cell', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('proofs/aliceProof3')), textProof(ALICE, 'pending'));
    });
    const put = (id: string, data: Record<string, unknown>) => setDoc(doc(db(ALICE), at(`claims/${id}`)), data);
    await assertFails(put('bare', { uid: ALICE }));
    await assertFails(put('confirmed', claim(ALICE, 'aliceProof3', { status: 'confirmed' })));
    await assertFails(put('resolved', claim(ALICE, 'aliceProof3', { resolvedBy: ALICE })));
    await assertFails(put('extra', claim(ALICE, 'aliceProof3', { itemId: 'i1' })));
    await assertFails(put('nameNum', claim(ALICE, 'aliceProof3', { displayName: 99 })));
    await assertFails(put('nameLong', claim(ALICE, 'aliceProof3', { displayName: 'A'.repeat(101) })));
    await assertFails(put('cellFloat', claim(ALICE, 'aliceProof3', { cellIndex: 1.5 })));
    await assertFails(put('cellHigh', claim(ALICE, 'aliceProof3', { cellIndex: 25 })));
    await assertSucceeds(put('ok', claim(ALICE, 'aliceProof3')));
  });
});

describe('storage.rules — named content types, auto-id object names, a real Event', () => {
  const TINY = new Uint8Array(64);
  const put = (ctx: RulesTestContext, path: string, contentType: string) =>
    uploadBytes(ref(ctx.storage(), path), TINY, { contentType });

  it('ALLOWS the avatar and proof uploads the app makes', async () => {
    const alice = testEnv.authenticatedContext(ALICE);
    await assertSucceeds(put(alice, `avatars/${ALICE}.jpg`, 'image/jpeg'));
    await assertSucceeds(put(alice, `proofs/${EVENT}/${ALICE}/Ab3dEf6hIj9kLm2nOp4q.jpg`, 'image/jpeg'));
    await assertSucceeds(put(alice, `proofs/${EVENT}/${ALICE}/Ab3dEf6hIj9kLm2nOp4r.webm`, 'audio/webm'));
    await assertSucceeds(put(alice, `proofs/${EVENT}/${ALICE}/Ab3dEf6hIj9kLm2nOp4s.m4a`, 'audio/mp4'));
  });

  it('DENIES an SVG, or any non-JPEG type, under a .jpg name', async () => {
    const alice = testEnv.authenticatedContext(ALICE);
    await assertFails(put(alice, `avatars/${ALICE}.jpg`, 'image/svg+xml'));
    await assertFails(put(alice, `avatars/${ALICE}.jpg`, 'image/png'));
    await assertFails(put(alice, `proofs/${EVENT}/${ALICE}/svgProof.jpg`, 'image/svg+xml'));
    await assertFails(put(alice, `proofs/${EVENT}/${ALICE}/pngProof.jpg`, 'image/png'));
    await assertFails(put(alice, `proofs/${EVENT}/${ALICE}/audioAsJpg.jpg`, 'audio/webm'));
    await assertFails(put(alice, `proofs/${EVENT}/${ALICE}/imageAsAudio.webm`, 'image/jpeg'));
  });

  it('DENIES a proof object whose name is not <auto-id>.<jpg|webm|m4a>', async () => {
    const alice = testEnv.authenticatedContext(ALICE);
    for (const name of ['proof.svg', 'proof.png', 'under_score.jpg', 'x_thumb.jpg', 'a.b.jpg', `${'a'.repeat(41)}.jpg`]) {
      await assertFails(put(alice, `proofs/${EVENT}/${ALICE}/${name}`, 'image/jpeg'));
    }
  });

  it('DENIES a proof upload under an Event id that names no Event', async () => {
    const alice = testEnv.authenticatedContext(ALICE);
    await assertFails(put(alice, `proofs/${MISSING_EVENT}/${ALICE}/Ab3dEf6hIj9kLm2nOp4q.jpg`, 'image/jpeg'));
  });
});
