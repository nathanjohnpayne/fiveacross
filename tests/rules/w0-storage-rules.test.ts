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
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { doc, setDoc } from 'firebase/firestore';

// Storage security-rules coverage for storage.rules (ADR 0004): the okImage()
// (image/* < 8 MB) and okAudio() (audio/* < 12 MB) upload caps, the
// filename-pinned avatars path, the owner/admin proofs path, the now-removed
// /og/** block staying unmatched (#39, ADR 0005), and — critically — the
// cross-check that a Proof object which passes storage.rules also passes the
// Firestore `proofs` create rule, so the two stay in lockstep. Runs on the
// rules-emulator layer via `npm run test:rules`, which boots both the
// Firestore and Storage emulators.

const storageRules = readFileSync(
  fileURLToPath(new URL('../../storage.rules', import.meta.url)),
  'utf8',
);
const firestoreRules = readFileSync(
  fileURLToPath(new URL('../../firestore.rules', import.meta.url)),
  'utf8',
);

const EVENT = 'evt1';
const OWNER = 'alice';
const OTHER = 'bob';
const ADMIN = 'carol';
const PROOF = 'proof1';

// Object paths built from one (event, uid, proof) triple, mirroring
// src/data/storage.ts. The cross-check reuses these so it proves the SAME path
// satisfies both Storage and Firestore, not two independently-chosen strings.
const photoPath = `proofs/${EVENT}/${OWNER}/${PROOF}.jpg`;
const audioPath = `proofs/${EVENT}/${OWNER}/${PROOF}.webm`;
// #295: iOS Safari's MediaRecorder records MP4/AAC, not WebM — uploadProofMedia
// names that clip `.m4a` (Content-Type `audio/mp4`) instead of `.webm`.
// `okAudio()` gates on contentType alone, so this path exercises the SAME rule
// under the extension a Safari upload actually produces.
const audioPathM4a = `proofs/${EVENT}/${OWNER}/${PROOF}.m4a`;
const avatarPath = (uid: string) => `avatars/${uid}.jpg`;

// A byte payload of an exact size, so request.resource.size hits the rule caps.
const sized = (mb: number) => new Uint8Array(Math.round(mb * 1024 * 1024));
const TINY = new Uint8Array(64);
const IMAGE = { contentType: 'image/jpeg' };
const AUDIO = { contentType: 'audio/webm' };
const AUDIO_MP4 = { contentType: 'audio/mp4' };

let testEnv: RulesTestEnvironment;

const put = (
  ctx: RulesTestContext,
  path: string,
  data: Uint8Array,
  meta: { contentType: string },
) => uploadBytes(ref(ctx.storage(), path), data, meta);

beforeAll(async () => {
  // Under `firebase emulators:exec` the emulator hosts + the active project are
  // exported here. The Storage isEventAdmin() rule does a cross-service
  // firestore.get(), which the Storage emulator resolves against the project the
  // emulator was booted with (GCLOUD_PROJECT, from .firebaserc), NOT the
  // client-supplied projectId — so bind this env to that same project, letting
  // the seeded events/{id} admins doc be visible to the admin-delete rule. Fall
  // back to the firebase.json ports and .firebaserc default for a direct run.
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

beforeEach(async () => {
  await testEnv.clearStorage();
  await testEnv.clearFirestore();
  // The Firestore half of the lockstep Proof tests writes beneath a real Event.
  // Membership enforcement is deliberately off here, preserving the legacy
  // signed-in posture without treating an orphaned/deleted Event subtree as a
  // valid place to inject Proof content (#804).
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `events/${EVENT}`), {
      admins: [ADMIN],
      membershipEnforcement: 'off',
    });
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe('storage.rules — okImage / okAudio upload caps (ADR 0004)', () => {
  it('allows a 7 MB image but denies a 9 MB image (okImage < 8 MB)', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, photoPath, sized(7), IMAGE));
    await assertFails(put(owner, photoPath, sized(9), IMAGE));
  });

  it('allows an 11 MB audio but denies a 13 MB audio (okAudio < 12 MB)', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, audioPath, sized(11), AUDIO));
    await assertFails(put(owner, audioPath, sized(13), AUDIO));
  });

  it('#295: applies the SAME okAudio() cap to a Safari-recorded .m4a/audio-mp4 clip', async () => {
    // okAudio() gates on request.resource.contentType.matches('audio/.*'), not
    // the object's filename — an .m4a object with Content-Type audio/mp4 (what
    // uploadProofMedia() writes for iOS Safari's MP4/AAC recording) is checked
    // by the exact same rule as a .webm/audio-webm object, not a separate path.
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, audioPathM4a, sized(11), AUDIO_MP4));
    await assertFails(put(owner, audioPathM4a, sized(13), AUDIO_MP4));
  });

  it('denies an over-cap image CREATE on a brand-new path, not just an update', async () => {
    // Reusing `photoPath` (as the tests above do) would make the denied
    // request an update, since a 7 MB object was already put() there first.
    // A path with no prior object isolates the cap on the first-write create
    // that uploadProofMedia() actually performs for a new proof.
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, `proofs/${EVENT}/${OWNER}/${PROOF}-fresh.jpg`, sized(9), IMAGE));
  });

  it('denies an over-cap audio CREATE on a brand-new path, not just an update', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, `proofs/${EVENT}/${OWNER}/${PROOF}-fresh.webm`, sized(13), AUDIO));
  });

  it('denies a non-image, non-audio content type on a proof path', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, photoPath, TINY, { contentType: 'application/pdf' }));
  });
});

describe('storage.rules — avatars/{uid}.jpg (owner + filename pinned)', () => {
  it('allows the owner to write their own avatars/{uid}.jpg', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, avatarPath(OWNER), TINY, IMAGE));
  });

  it('denies an over-cap (9 MB) avatar image (okImage applies to avatars too)', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, avatarPath(OWNER), sized(9), IMAGE));
  });

  it("denies writing another user's avatar filename", async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, avatarPath(OTHER), TINY, IMAGE));
  });

  it('denies a wrong avatar filename for the owner', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, `avatars/${OWNER}.png`, TINY, IMAGE));
  });
});

describe('storage.rules — proofs/{eventId}/{uid}/{file} (owner create, owner/admin delete)', () => {
  it('allows the owning uploader to create their proof object', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, photoPath, TINY, IMAGE));
  });

  it("denies a non-owner writing under another user's proof folder", async () => {
    const other = testEnv.authenticatedContext(OTHER);
    await assertFails(put(other, photoPath, TINY, IMAGE));
  });

  it('allows the owner to delete their own proof object', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx, photoPath, TINY, IMAGE);
    });
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(deleteObject(ref(owner.storage(), photoPath)));
  });

  it('allows an Event admin to delete the proof object', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx, photoPath, TINY, IMAGE);
      await setDoc(doc(ctx.firestore(), `events/${EVENT}`), { admins: [ADMIN] });
    });
    const admin = testEnv.authenticatedContext(ADMIN);
    await assertSucceeds(deleteObject(ref(admin.storage(), photoPath)));
  });

  it('denies deleting the proof object when the caller is signed in but neither the owner nor an Event admin', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx, photoPath, TINY, IMAGE);
      // Seed an admins list that does NOT include OTHER, so the denial proves
      // the non-admin branch specifically, not just a missing events doc.
      await setDoc(doc(ctx.firestore(), `events/${EVENT}`), { admins: [ADMIN] });
    });
    const other = testEnv.authenticatedContext(OTHER);
    await assertFails(deleteObject(ref(other.storage(), photoPath)));
  });
});

describe('storage.rules — /og/** removed (#39, ADR 0005)', () => {
  it('denies reads under og/** now that no rule matches the path (default deny)', async () => {
    // Pre-#39, this same object was public-read via the inert OG-renderer
    // block. That block is gone, so an unmatched path now falls through to
    // Storage's default deny for read too — proving the removal actually
    // took effect, not just that a comment was deleted.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx, 'og/card.png', TINY, { contentType: 'image/png' });
    });
    const anon = testEnv.unauthenticatedContext();
    await assertFails(getMetadata(ref(anon.storage(), 'og/card.png')));
  });

  it('denies writing a brand-new object under og/** (no rule grants it)', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(put(owner, 'og/new-card.png', TINY, { contentType: 'image/png' }));
  });
});

describe('storage.rules — private bug-report evidence', () => {
  const bugPath = 'bug-reports/0123456789abcdefabcd/report_123/screenshot.png';

  it('denies signed-in players direct reads and writes', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await put(ctx, bugPath, TINY, { contentType: 'image/png' });
    });
    const owner = testEnv.authenticatedContext(OWNER);
    await assertFails(getMetadata(ref(owner.storage(), bugPath)));
    await assertFails(put(owner, 'bug-reports/0123456789abcdefabcd/forged/screenshot.png', TINY, { contentType: 'image/png' }));
  });
});

describe('Storage ↔ Firestore Proof pinning (lockstep)', () => {
  // A Proof object that satisfies storage.rules must also satisfy the Firestore
  // `proofs` create rule: identical proofs/{eventId}/{uid}/{proofId}.{ext} path.
  const mediaURL = (ext: string) =>
    `https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/proofs%2F${EVENT}%2F${OWNER}%2F${PROOF}.${ext}?alt=media&token=t`;

  const proofDoc = (type: 'photo' | 'audio', storagePath: string, url: string) => ({
    uid: OWNER,
    displayName: 'Alice',
    photoURL: null,
    type,
    cellIndex: 5,
    itemText: 'Saw a sailor',
    storagePath,
    mediaURL: url,
    thumbURL: null,
    text: null,
    createdAt: Date.now(),
    reportCount: 0,
    status: 'active',
    visionFlag: null,
  });

  it('accepts the same photo object in Storage and Firestore', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, photoPath, TINY, IMAGE));
    await assertSucceeds(
      setDoc(
        doc(owner.firestore(), `events/${EVENT}/proofs/${PROOF}`),
        proofDoc('photo', photoPath, mediaURL('jpg')),
      ),
    );
  });

  it('accepts the same audio object in Storage and Firestore', async () => {
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, audioPath, TINY, AUDIO));
    await assertSucceeds(
      setDoc(
        doc(owner.firestore(), `events/${EVENT}/proofs/${PROOF}`),
        proofDoc('audio', audioPath, mediaURL('webm')),
      ),
    );
  });

  it('#295: accepts the same .m4a audio object (Safari MP4/AAC recording) in Storage and Firestore', async () => {
    // The SAME lockstep proof as the .webm case above, for the extension
    // uploadProofMedia() actually names a Safari-recorded clip — proving the
    // Firestore create rule's audio pin isn't hardcoded to .webm alone.
    const owner = testEnv.authenticatedContext(OWNER);
    await assertSucceeds(put(owner, audioPathM4a, TINY, AUDIO_MP4));
    await assertSucceeds(
      setDoc(
        doc(owner.firestore(), `events/${EVENT}/proofs/${PROOF}`),
        proofDoc('audio', audioPathM4a, mediaURL('m4a')),
      ),
    );
  });

  it('rejects a mismatched proof path: Storage accepts the object, but Firestore denies pinning it to a different proof', async () => {
    // storage.rules only checks ownership + content type on the proofs path
    // (the {file} segment is a free wildcard), so an object NOT named after
    // the target proofId still uploads successfully. The Firestore create
    // rule additionally pins storagePath to the exact
    // proofs/{eventId}/{uid}/{proofId}.{ext} object, so pointing the PROOF
    // doc at this mismatched object must be denied — proving Storage and
    // Firestore diverge outside the canonical path, not just agree on it.
    const owner = testEnv.authenticatedContext(OWNER);
    const mismatchedPath = `proofs/${EVENT}/${OWNER}/not-${PROOF}.jpg`;
    const mismatchedURL = `https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/proofs%2F${EVENT}%2F${OWNER}%2Fnot-${PROOF}.jpg?alt=media&token=t`;
    await assertSucceeds(put(owner, mismatchedPath, TINY, IMAGE));
    await assertFails(
      setDoc(
        doc(owner.firestore(), `events/${EVENT}/proofs/${PROOF}`),
        proofDoc('photo', mismatchedPath, mismatchedURL),
      ),
    );
  });
});
