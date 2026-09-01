import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

const RULES_PATH = fileURLToPath(
  new URL('../../firestore.rules', import.meta.url),
);
const [EVENT_A, EVENT_B] = ['event-a', 'event-b'];
const ITEM = 'shared-item';
const UID = 'shared-player';
const READER = 'reader';
const COMPATIBILITY_PATH = 'markerDeliveryCompatibility/current';
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const markerPath = (eventId: string, itemId: string, uid: string) =>
  `events/${eventId}/tally/${itemId}/markers/${uid}`;

function marker(uid: string, eventId?: unknown): Record<string, unknown> {
  return {
    uid,
    displayName: uid,
    markedAt: NOW(),
    dayIndex: 0,
    itemText: 'Shared prompt',
    ...(eventId === undefined ? {} : { eventId }),
  };
}

async function seedCompatibility(
  database: Firestore,
  acceptLegacyUntil: unknown,
): Promise<void> {
  await setDoc(doc(database, COMPATIBILITY_PATH), {
    schemaVersion: 1,
    projectId: 'demo-fiveacross-marker-event-delivery',
    acceptLegacyUntil,
  });
}

async function seedEvents(database: Firestore): Promise<void> {
  for (const eventId of [EVENT_A, EVENT_B]) {
    await setDoc(doc(database, `events/${eventId}`), {
      name: eventId,
      status: 'active',
      admins: [],
    });
  }
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fiveacross-marker-event-delivery',
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

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) =>
    seedEvents(ctx.firestore()),
  );
});

describe('marker Event identity compatibility window (#1072)', () => {
  it('accepts a fieldless legacy create/update only while the numeric cutoff is open', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() + 60_000);
    });

    const legacyRef = doc(db(UID), markerPath(EVENT_A, ITEM, UID));
    await assertSucceeds(setDoc(legacyRef, marker(UID)));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
    });
    await assertSucceeds(setDoc(legacyRef, marker(UID)));
  });

  it('keeps exact string identities writable regardless of compatibility state', async () => {
    const exactRef = doc(db(UID), markerPath(EVENT_A, ITEM, UID));
    await assertSucceeds(setDoc(exactRef, marker(UID, EVENT_A)));
    await assertSucceeds(setDoc(exactRef, marker(UID, EVENT_A)));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() - 60_000);
    });
    await assertSucceeds(
      setDoc(
        doc(db(UID), markerPath(EVENT_B, ITEM, UID)),
        marker(UID, EVENT_B),
      ),
    );
  });

  it('always rejects a present mismatched or non-string Event identity', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() + 60_000);
    });

    const mine = doc(db(UID), markerPath(EVENT_A, ITEM, UID));
    await assertFails(setDoc(mine, marker(UID, EVENT_B)));
    await assertFails(setDoc(mine, marker(UID, 42)));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
    });
    await assertFails(setDoc(mine, marker(UID, EVENT_B)));
    await assertFails(setDoc(mine, marker(UID, 42)));
  });

  it('fails closed when the compatibility document is missing, expired, or malformed', async () => {
    const mine = doc(db(UID), markerPath(EVENT_A, ITEM, UID));
    await assertFails(setDoc(mine, marker(UID)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
    });
    await assertFails(setDoc(mine, marker(UID)));

    for (const cutoff of [NOW() - 60_000, 'tomorrow']) {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await seedCompatibility(ctx.firestore(), cutoff);
      });
      await assertFails(setDoc(mine, marker(UID)));
    }

    for (const malformed of [
      {
        schemaVersion: 2,
        projectId: 'demo-project',
        acceptLegacyUntil: NOW() + 60_000,
      },
      { schemaVersion: 1, projectId: '', acceptLegacyUntil: NOW() + 60_000 },
      { schemaVersion: 1, projectId: '   ', acceptLegacyUntil: NOW() + 60_000 },
      { schemaVersion: 1, projectId: 42, acceptLegacyUntil: NOW() + 60_000 },
      {
        schemaVersion: 1,
        projectId: 'demo-project',
        acceptLegacyUntil: Number.NaN,
      },
      {
        schemaVersion: 1,
        projectId: 'demo-project',
        acceptLegacyUntil: Number.POSITIVE_INFINITY,
      },
      {
        schemaVersion: 1,
        projectId: 'demo-project',
        acceptLegacyUntil: 4_102_444_800_000,
      },
      { projectId: 'demo-project', acceptLegacyUntil: NOW() + 60_000 },
      { schemaVersion: 1, acceptLegacyUntil: NOW() + 60_000 },
    ]) {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), COMPATIBILITY_PATH), malformed);
      });
      await assertFails(setDoc(mine, marker(UID)));
    }
  });

  it('reuses one compatibility lookup across the maximum 24-marker legacy repair batch', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() + 60_000);
    });

    const database = db(UID);
    const batch = writeBatch(database);
    for (let index = 0; index < 24; index += 1) {
      batch.set(
        doc(database, markerPath(EVENT_A, `legacy-item-${index}`, UID)),
        marker(UID),
      );
    }

    await assertSucceeds(batch.commit());
  });

  it('treats a nonblank wrong-project value as trusted Admin metadata', async () => {
    // Firestore Rules expose the database id (`(default)` here), but not the
    // Firebase project id. The deny-all control path therefore lets Rules
    // validate this field's shape only; the migration and retrying Function
    // enforce exact project identity before using or writing the control.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), COMPATIBILITY_PATH), {
        schemaVersion: 1,
        projectId: 'different-project',
        acceptLegacyUntil: NOW() + 60_000,
      });
    });

    await assertSucceeds(
      setDoc(doc(db(UID), markerPath(EVENT_A, ITEM, UID)), marker(UID)),
    );
  });

  it('keeps the server-owned compatibility document unreadable and unwritable to clients', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() + 60_000);
    });

    await assertFails(getDoc(doc(db(READER), COMPATIBILITY_PATH)));
    await assertFails(
      setDoc(doc(db(READER), COMPATIBILITY_PATH), {
        acceptLegacyUntil: NOW() + 120_000,
      }),
    );
  });
});

describe('marker collection-group delivery cutover (#1072)', () => {
  it('keeps the legacy unfiltered collection-group query available only in-window', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await seedCompatibility(database, NOW() + 60_000);
      await setDoc(doc(database, markerPath(EVENT_A, ITEM, UID)), marker(UID));
      await setDoc(
        doc(database, markerPath(EVENT_B, ITEM, UID)),
        marker(UID, EVENT_B),
      );
    });

    const open = await assertSucceeds(
      getDocs(collectionGroup(db(READER), 'markers')),
    );
    expect(open.docs).toHaveLength(2);

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), NOW() - 60_000);
    });
    await assertFails(getDocs(collectionGroup(db(READER), 'markers')));
  });

  it('denies the legacy unfiltered query when the compatibility document is absent or malformed', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await setDoc(
        doc(database, markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
      await setDoc(
        doc(database, markerPath(EVENT_B, ITEM, UID)),
        marker(UID, EVENT_B),
      );
    });
    await assertFails(getDocs(collectionGroup(db(READER), 'markers')));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedCompatibility(ctx.firestore(), 'tomorrow');
    });
    await assertFails(getDocs(collectionGroup(db(READER), 'markers')));
  });

  it('delivers only Event A over the wire after cutoff, even when A and B share ids', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await seedCompatibility(database, NOW() - 60_000);
      await setDoc(
        doc(database, markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
      await setDoc(
        doc(database, markerPath(EVENT_B, ITEM, UID)),
        marker(UID, EVENT_B),
      );
    });

    const scoped = query(
      collectionGroup(db(READER), 'markers'),
      where('eventId', '==', EVENT_A),
    );
    const result = await assertSucceeds(getDocs(scoped));
    expect(result.docs.map((snap) => snap.ref.path)).toEqual([
      markerPath(EVENT_A, ITEM, UID),
    ]);
    expect(result.docs[0].data().eventId).toBe(EVENT_A);
  });
});

describe('direct Tally marker reads remain path-scoped (#1072)', () => {
  it('keeps direct list behavior while get accepts absent/legacy/exact and rejects mismatch', async () => {
    const [ABSENT, LEGACY, EXACT, MISMATCH] = [
      'absent',
      'legacy',
      'exact',
      'mismatch',
    ];
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await setDoc(
        doc(database, markerPath(EVENT_A, ITEM, LEGACY)),
        marker(LEGACY),
      );
      await setDoc(
        doc(database, markerPath(EVENT_A, ITEM, EXACT)),
        marker(EXACT, EVENT_A),
      );
      await setDoc(
        doc(database, markerPath(EVENT_A, ITEM, MISMATCH)),
        marker(MISMATCH, EVENT_B),
      );
    });

    const direct = collection(
      db(READER),
      `events/${EVENT_A}/tally/${ITEM}/markers`,
    );
    const listed = await assertSucceeds(getDocs(direct));
    expect(listed.docs).toHaveLength(3);
    const absent = await assertSucceeds(
      getDoc(doc(db(READER), markerPath(EVENT_A, ITEM, ABSENT))),
    );
    expect(absent.exists()).toBe(false);
    await assertSucceeds(
      getDoc(doc(db(READER), markerPath(EVENT_A, ITEM, LEGACY))),
    );
    await assertSucceeds(
      getDoc(doc(db(READER), markerPath(EVENT_A, ITEM, EXACT))),
    );
    await assertFails(
      getDoc(doc(db(READER), markerPath(EVENT_A, ITEM, MISMATCH))),
    );
  });

  it('denies signed-out direct and collection-group reads', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), markerPath(EVENT_A, ITEM, UID)),
        marker(UID, EVENT_A),
      );
    });
    const anonymous = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(anonymous, markerPath(EVENT_A, ITEM, UID))));
    await assertFails(
      getDocs(collection(anonymous, `events/${EVENT_A}/tally/${ITEM}/markers`)),
    );
    await assertFails(
      getDocs(
        query(
          collectionGroup(anonymous, 'markers'),
          where('eventId', '==', EVENT_A),
        ),
      ),
    );
  });
});
