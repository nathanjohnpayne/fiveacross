import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// specs/most-loved-photo.md, rules layer (#534/#560): `EventDoc.mostLovedPhoto`
// (the frozen Most-Loved Photo award, persisted by the freeze-time scheduler
// beat via the Admin SDK) inherits `frozenAt`'s EXACT posture — the whole
// events/{eventId} doc is `read: if signedIn()` and `create, update: if
// isAdmin(eventId)`, so a non-admin Player can never write the award, every
// signed-in Player can read it (what the finale render needs), and the
// scheduler's Admin SDK write bypasses rules entirely. DELIBERATELY no
// dedicated clause: this suite is the d15-finale.test.ts clone that pins the
// inherited protection, the documented precedent for scheduler-stamped
// Event-level frozen state.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected assertFails
// denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, MALLORY] = ['admin-uid', 'mallory'];
const NOW = () => Date.now();
const PAST = () => NOW() - 3600_000;

/** A frozen award shaped like the scheduler persists it (one winner + the
 *  explicit-record fields). Built per call so timestamps stay fresh. */
const AWARD = () => ({
  winners: [
    {
      proofId: 'proof-1',
      uid: 'player-1',
      displayName: 'Sam',
      promptText: 'Golden hour on the bluff',
      dayIndex: 1,
      proofCreatedAt: PAST(),
    },
  ],
  heartCount: 4,
  frozenAt: PAST(),
  computedAt: NOW(),
});

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const unauthDb = () => testEnv.unauthenticatedContext().firestore();

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId so this suite's clearFirestore never races
    // another file's seed (same convention as the other rules suites).
    projectId: 'demo-gaycruisebingo-most-loved-photo-rules',
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

// A canonical, valid Event doc (admins/settings/bannedUids/timezone/days all
// shaped so the admin update gate's own field checks pass) with no award yet.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [ADMIN],
      bannedUids: [],
      settings: { reportHideThreshold: 3 },
      timezone: 'Europe/Rome',
      days: [
        { index: 0, unlockAt: PAST(), theme: 'neon-playground' },
        { index: 1, unlockAt: PAST(), theme: 'get-sporty' },
      ],
    });
  });
});

describe('most-loved-photo — mostLovedPhoto is admin/Function-writable only', () => {
  it('ALLOWS an admin update carrying mostLovedPhoto', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { mostLovedPhoto: AWARD() }));
  });

  it('DENIES a non-admin Player setting mostLovedPhoto', async () => {
    await assertFails(updateDoc(doc(db(MALLORY), `events/${EVENT}`), { mostLovedPhoto: AWARD() }));
  });

  it('DENIES an unauthenticated write of mostLovedPhoto', async () => {
    await assertFails(updateDoc(doc(unauthDb(), `events/${EVENT}`), { mostLovedPhoto: AWARD() }));
  });

  it('lets any signed-in Player read the event doc once the award is present', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { mostLovedPhoto: AWARD() });
    });
    await assertSucceeds(getDoc(doc(db(MALLORY), `events/${EVENT}`)));
  });

  it('still DENIES an unauthenticated read with the award present (signedIn gate intact)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { mostLovedPhoto: AWARD() });
    });
    await assertFails(getDoc(doc(unauthDb(), `events/${EVENT}`)));
  });
});
