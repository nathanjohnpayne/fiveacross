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
  collectionGroup,
  doc,
  FieldPath,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { MAX_DAYS } from '../../src/data/eventLimits';

// #1079 proved the D-A membership predicate against the real Mark/Echo batch
// maxima before production enforcement. #804 now consumes the deployed rules
// directly; the only source rewrite left is a test-only wrapper probe whose
// insertion is exact-counted so a refactor still fails closed.

const RULES_PATH = fileURLToPath(
  new URL('../../firestore.rules', import.meta.url),
);
const EVENT = 'membership-budget';
const ALICE = 'alice';
const ADMIN = 'admin';
const SHARED_ITEM = 'shared-prompt';
const COMPATIBILITY_PATH = 'markerDeliveryCompatibility/current';
const NOW = () => Date.now();
const PAST = () => NOW() - 3_600_000;

function replaceExactlyOnce(
  source: string,
  label: string,
  from: string,
  to: string,
): string {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `#1079 budget test expected exactly one ${label} anchor; found ${occurrences}`,
    );
  }
  return source.replace(from, to);
}

function requireOccurrences(
  source: string,
  label: string,
  needle: string,
  expected: number,
): void {
  const actual = source.split(needle).length - 1;
  if (actual !== expected) {
    throw new Error(
      `#1079 budget test expected ${expected} ${label} occurrence(s); found ${actual}`,
    );
  }
}

function membershipMarkRules(source: string): string {
  const helperAnchor = 'function admitted(eventId) {';
  requireOccurrences(source, `canonical ${helperAnchor}`, helperAnchor, 1);
  const threadedAnchor = 'function admittedWithEvent(eventId, event) {';
  requireOccurrences(source, `canonical ${threadedAnchor}`, threadedAnchor, 1);
  const threadedBody = source.slice(
    source.indexOf(threadedAnchor),
    source.indexOf(helperAnchor),
  );
  const orderedClauses = [
    'return signedIn()',
    "event.get('membershipEnforcement', 'off') != 'enforced'",
    '|| isAdminWithEvent(event)',
    '|| isEventMember(eventId, request.auth.uid)',
  ];
  let clauseCursor = -1;
  for (const clause of orderedClauses) {
    const next = threadedBody.indexOf(clause, clauseCursor + 1);
    if (next < 0)
      throw new Error(
        `#1079 budget test lost or reordered canonical clause: ${clause}`,
      );
    clauseCursor = next;
  }
  for (const clause of orderedClauses) {
    requireOccurrences(threadedBody, `canonical clause ${clause}`, clause, 1);
  }
  const memberAnchor = 'function isEventMember(eventId, uid) {';
  const memberEnd = source.indexOf(threadedAnchor);
  const memberBody = source.slice(source.indexOf(memberAnchor), memberEnd);
  if (
    source.split(memberAnchor).length - 1 !== 1 ||
    memberBody.indexOf('return exists(membershipDoc(eventId, uid))') < 0 ||
    memberBody.indexOf('&& get(membershipDoc(eventId, uid))') <
      memberBody.indexOf('return exists(membershipDoc(eventId, uid))')
  ) {
    throw new Error(
      '#1079 budget test requires one exists()-then-get() membership predicate',
    );
  }
  requireOccurrences(
    memberBody,
    'membership exists()',
    'exists(membershipDoc(eventId, uid))',
    1,
  );
  requireOccurrences(
    memberBody,
    'membership get()',
    'get(membershipDoc(eventId, uid))',
    1,
  );
  const admittedDefinition = `function admitted(eventId) {
      return admittedWithEvent(eventId, eventData(eventId));
    }`;
  requireOccurrences(
    source,
    'canonical admitted() body',
    admittedDefinition,
    1,
  );

  return replaceExactlyOnce(
    source,
    'unauthenticated wrapper probes',
    `    // Event-filtered collection-group LIST for the Feed's Tally Cards`,
    `    // TEST-ONLY #1079 probes. The negation makes an unauthenticated
    // request succeed only when each wrapper's leading signedIn() prevents
    // its Event argument from being evaluated.
    match /__membershipBudgetUnauthIsAdmin/{eventId} {
      allow create: if !isAdmin(eventId);
    }
    match /__membershipBudgetUnauthAdmitted/{eventId} {
      allow create: if !admitted(eventId);
    }

    // Event-filtered collection-group LIST for the Feed's Tally Cards`,
  );
}

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const eventPath = (eventId: string) => `events/${eventId}`;
const playerPath = (eventId: string, uid: string) =>
  `${eventPath(eventId)}/players/${uid}`;
const boardPath = (eventId: string, dayIndex: number, uid: string) =>
  `${eventPath(eventId)}/days/${dayIndex}/boards/${uid}`;
const membershipPath = (eventId: string, uid: string) =>
  `${eventPath(eventId)}/memberships/${uid}`;
const markerPath = (eventId: string, itemId: string, uid: string) =>
  `${eventPath(eventId)}/tally/${itemId}/markers/${uid}`;

type MembershipStatus = 'active' | 'revoked';

function days(count = MAX_DAYS) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    unlockAt: PAST(),
    pool: 'main',
    tutorial: false,
  }));
}

function cell(
  dayIndex: number,
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const free = index === 12;
  const shared = index === 3;
  const itemId = free
    ? null
    : shared
      ? SHARED_ITEM
      : `day-${dayIndex}-prompt-${index}`;
  return {
    index,
    itemId,
    text: free
      ? 'FREE'
      : shared
        ? 'Shared prompt'
        : `Prompt ${dayIndex}-${index}`,
    free,
    marked: free,
    markedAt: null,
    ...overrides,
  };
}

function cells(
  dayIndex: number,
  overrides: Record<number, Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      String(index),
      cell(dayIndex, index, overrides[index]),
    ]),
  );
}

function cellsPatch(
  dayIndex: number,
  overrides: Record<number, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.keys(overrides).map((rawIndex) => {
      const index = Number(rawIndex);
      return [rawIndex, cell(dayIndex, index, overrides[index])];
    }),
  );
}

function board(uid: string, dayIndex: number, seed: number) {
  return {
    uid,
    dayIndex,
    seed,
    createdAt: NOW(),
    cells: cells(dayIndex),
  };
}

function marker(
  eventId: string,
  uid: string,
  itemText: string,
  dayIndex?: number,
) {
  return {
    eventId,
    uid,
    displayName: uid === ALICE ? 'Alice' : uid,
    markedAt: NOW(),
    itemText,
    ...(typeof dayIndex === 'number' ? { dayIndex } : {}),
  };
}

function legacyMarker(uid: string, itemText: string, dayIndex: number) {
  return {
    uid,
    displayName: uid === ALICE ? 'Alice' : uid,
    markedAt: NOW(),
    itemText,
    dayIndex,
  };
}

async function seedEvent(
  database: Firestore,
  eventId: string,
  options: {
    enforcement?: 'off' | 'enforced';
    omitEnforcement?: boolean;
    admins?: string[];
    dayCount?: number;
  } = {},
): Promise<void> {
  await setDoc(doc(database, eventPath(eventId)), {
    name: eventId,
    status: 'active',
    admins: options.admins ?? [],
    days: days(options.dayCount ?? MAX_DAYS),
    ...(!options.omitEnforcement
      ? { membershipEnforcement: options.enforcement ?? 'enforced' }
      : {}),
  });
}

async function seedMembership(
  database: Firestore,
  eventId: string,
  uid: string,
  status: MembershipStatus,
): Promise<void> {
  await setDoc(doc(database, membershipPath(eventId, uid)), {
    uid,
    status,
    schemaVersion: 1,
    grantedAt: NOW(),
  });
}

async function seedPlayerAndBoards(
  database: Firestore,
  eventId: string,
  uid: string,
  dayCount = MAX_DAYS,
): Promise<void> {
  await setDoc(doc(database, playerPath(eventId, uid)), {
    uid,
    displayName: uid === ALICE ? 'Alice' : uid,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed: 0,
  });
  await Promise.all(
    Array.from({ length: dayCount }, (_, dayIndex) =>
      setDoc(
        doc(database, boardPath(eventId, dayIndex, uid)),
        board(uid, dayIndex, 100 + dayIndex),
      ),
    ),
  );
}

function setBoardCell(
  batch: ReturnType<typeof writeBatch>,
  database: Firestore,
  eventId: string,
  dayIndex: number,
  uid: string,
  index: number,
  overrides: Record<string, unknown>,
): void {
  batch.set(
    doc(database, boardPath(eventId, dayIndex, uid)),
    {
      cells: cellsPatch(dayIndex, { [index]: overrides }),
      markSeed: 100 + dayIndex,
    },
    { mergeFields: [new FieldPath('cells', String(index)), 'markSeed'] },
  );
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fa-membership-mark-budget',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: membershipMarkRules(readFileSync(RULES_PATH, 'utf8')),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const database = ctx.firestore();
    await seedEvent(database, EVENT, { admins: [ADMIN] });
    await seedMembership(database, EVENT, ALICE, 'active');
    await seedPlayerAndBoards(database, EVENT, ALICE);
  });
});

describe('#1079/#804 membership enforcement — Mark/Echo rule budget', () => {
  it('keeps explicit-off and absent-switch Events open to a signed-in Player without a Membership', async () => {
    const offEvent = 'unenforced-explicit';
    const absentEvent = 'unenforced-absent';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await seedEvent(database, offEvent, { enforcement: 'off', dayCount: 1 });
      await seedEvent(database, absentEvent, {
        omitEnforcement: true,
        dayCount: 1,
      });
    });
    await assertSucceeds(
      // Legacy marker payloads predate the optional Daily Cards `dayIndex`.
      setDoc(
        doc(db(ALICE), markerPath(offEvent, 'prompt', ALICE)),
        marker(offEvent, ALICE, 'Prompt'),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db(ALICE), markerPath(absentEvent, 'prompt', ALICE)),
        marker(absentEvent, ALICE, 'Prompt', 0),
      ),
    );
  });

  it('keeps an unenforced Event closed to an unauthenticated caller', async () => {
    const eventId = 'unenforced-unauthenticated';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedEvent(ctx.firestore(), eventId, {
        enforcement: 'off',
        dayCount: 1,
      });
    });
    await assertFails(
      setDoc(
        doc(
          testEnv.unauthenticatedContext().firestore(),
          markerPath(eventId, 'prompt', ALICE),
        ),
        marker(eventId, ALICE, 'Prompt'),
      ),
    );
  });

  it('leaves wrapper Event arguments unevaluated after an unauthenticated short-circuit', async () => {
    const database = testEnv.unauthenticatedContext().firestore();

    for (const collection of [
      '__membershipBudgetUnauthIsAdmin',
      '__membershipBudgetUnauthAdmitted',
    ]) {
      const batch = writeBatch(database);
      for (let index = 0; index < 21; index += 1) {
        // None of these Event documents exists. If eventData(eventId) were
        // evaluated before the callee's signedIn() short-circuit, the request
        // would error or exceed the twenty-access aggregate ceiling.
        batch.set(doc(database, collection, `missing-event-${index}`), {
          probe: true,
        });
      }
      await assertSucceeds(batch.commit());
    }
  });

  it('admits an active member and denies missing or revoked Memberships', async () => {
    const missingEvent = 'membership-missing';
    const revokedEvent = 'membership-revoked';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await seedEvent(database, missingEvent, { dayCount: 1 });
      await seedEvent(database, revokedEvent, { dayCount: 1 });
      await seedMembership(database, revokedEvent, ALICE, 'revoked');
    });

    await assertSucceeds(
      setDoc(
        doc(db(ALICE), markerPath(EVENT, 'active-member', ALICE)),
        marker(EVENT, ALICE, 'Active', 0),
      ),
    );
    await assertFails(
      setDoc(
        doc(db(ALICE), markerPath(missingEvent, 'missing', ALICE)),
        marker(missingEvent, ALICE, 'Missing', 0),
      ),
    );
    await assertFails(
      setDoc(
        doc(db(ALICE), markerPath(revokedEvent, 'revoked', ALICE)),
        marker(revokedEvent, ALICE, 'Revoked', 0),
      ),
    );
  });

  it('enforces #804 admission on both direct and Event-scoped collection-group marker reads', async () => {
    const otherEvent = 'membership-other-read';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await seedEvent(database, otherEvent, { dayCount: 1 });
      // Both Events deliberately use the same item and marker ids: the Event
      // field, not a coincidentally unique descendant path, is the delivery key.
      await setDoc(
        doc(database, markerPath(EVENT, SHARED_ITEM, ALICE)),
        marker(EVENT, ALICE, 'Shared prompt', 0),
      );
      await setDoc(
        doc(database, markerPath(otherEvent, SHARED_ITEM, ALICE)),
        marker(otherEvent, ALICE, 'Shared prompt', 0),
      );
    });

    await assertSucceeds(
      getDoc(doc(db(ALICE), markerPath(EVENT, SHARED_ITEM, ALICE))),
    );
    await expect(
      getDoc(doc(db(ALICE), markerPath(otherEvent, SHARED_ITEM, ALICE))),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      getDoc(doc(db('nonmember'), markerPath(EVENT, SHARED_ITEM, ALICE))),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const memberQuery = query(
      collectionGroup(db(ALICE), 'markers'),
      where('eventId', '==', EVENT),
    );
    const memberResult = await getDocs(memberQuery);
    expect(memberResult.docs.map((snapshot) => snapshot.ref.path)).toEqual([
      markerPath(EVENT, SHARED_ITEM, ALICE),
    ]);

    await expect(
      getDocs(
        query(
          collectionGroup(db(ALICE), 'markers'),
          where('eventId', '==', otherEvent),
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      getDocs(
        query(
          collectionGroup(db('nonmember'), 'markers'),
          where('eventId', '==', EVENT),
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('denies missing and revoked acted-Mark batches atomically', async () => {
    const deniedEvents = [
      { eventId: 'atomic-missing', status: null },
      { eventId: 'atomic-revoked', status: 'revoked' as const },
    ];
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      for (const denied of deniedEvents) {
        await seedEvent(database, denied.eventId, { dayCount: 1 });
        if (denied.status)
          await seedMembership(database, denied.eventId, ALICE, denied.status);
        await seedPlayerAndBoards(database, denied.eventId, ALICE, 1);
      }
    });

    for (const denied of deniedEvents) {
      const database = db(ALICE);
      const batch = writeBatch(database);
      setBoardCell(batch, database, denied.eventId, 0, ALICE, 3, {
        marked: true,
        markedAt: NOW(),
        status: 'confirmed',
      });
      batch.set(
        doc(database, playerPath(denied.eventId, ALICE)),
        { squaresMarked: 1 },
        { merge: true },
      );
      batch.set(
        doc(database, markerPath(denied.eventId, SHARED_ITEM, ALICE)),
        marker(denied.eventId, ALICE, 'Shared prompt', 0),
      );
      await assertFails(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const readDatabase = ctx.firestore();
        const boardSnap = await getDoc(
          doc(readDatabase, boardPath(denied.eventId, 0, ALICE)),
        );
        const playerSnap = await getDoc(
          doc(readDatabase, playerPath(denied.eventId, ALICE)),
        );
        const markerSnap = await getDoc(
          doc(readDatabase, markerPath(denied.eventId, SHARED_ITEM, ALICE)),
        );
        expect(
          (boardSnap.data()?.cells as Record<string, { marked: boolean }>)['3']
            .marked,
        ).toBe(false);
        expect(playerSnap.data()?.squaresMarked).toBe(0);
        expect(markerSnap.exists()).toBe(false);
      });
    }
  });

  it('preserves Decision D-A: an enforced Event admin is admitted without a Membership', async () => {
    const adminEvent = 'transitional-admin';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedEvent(ctx.firestore(), adminEvent, {
        admins: [ADMIN],
        dayCount: 1,
      });
    });
    await assertSucceeds(
      setDoc(
        doc(db(ADMIN), markerPath(adminEvent, 'admin-prompt', ADMIN)),
        marker(adminEvent, ADMIN, 'Admin prompt', 0),
      ),
    );
  });

  it('allows a member Mark and its symmetric unmark across Board, Player, and Tally marker arms', async () => {
    const database = db(ALICE);
    const markedAt = NOW();
    const mark = writeBatch(database);
    setBoardCell(mark, database, EVENT, 0, ALICE, 3, {
      marked: true,
      markedAt,
      status: 'confirmed',
    });
    mark.set(
      doc(database, playerPath(EVENT, ALICE)),
      {
        dayStats: {
          0: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        },
        bingoCount: 0,
        squaresMarked: 1,
        firstBingoAt: null,
        blackout: false,
      },
      { merge: true },
    );
    mark.set(
      doc(database, markerPath(EVENT, SHARED_ITEM, ALICE)),
      marker(EVENT, ALICE, 'Shared prompt', 0),
    );
    await assertSucceeds(mark.commit());

    const unmark = writeBatch(database);
    setBoardCell(unmark, database, EVENT, 0, ALICE, 3, {
      marked: false,
      markedAt: null,
      status: 'confirmed',
      echoOptOut: true,
    });
    unmark.set(
      doc(database, playerPath(EVENT, ALICE)),
      {
        dayStats: {
          0: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null },
        },
        bingoCount: 0,
        squaresMarked: 0,
        firstBingoAt: null,
        blackout: false,
      },
      { merge: true },
    );
    unmark.delete(doc(database, markerPath(EVENT, SHARED_ITEM, ALICE)));
    await assertSucceeds(unmark.commit());
  });

  it('accepts the real maximum 10-Day setMark shape: 10 Boards + Player + marker (12 writes)', async () => {
    const database = db(ALICE);
    const batch = writeBatch(database);
    const markedAt = NOW();
    let writes = 0;

    for (let dayIndex = 0; dayIndex < MAX_DAYS; dayIndex += 1) {
      setBoardCell(batch, database, EVENT, dayIndex, ALICE, 3, {
        marked: true,
        markedAt,
        status: 'confirmed',
        ...(dayIndex > 0 ? { echo: true } : {}),
      });
      writes += 1;
    }
    // Since #491, setMark's one Player write carries the acted-Day fold; echo
    // buckets reconcile from server truth after this batch is acknowledged.
    batch.set(
      doc(database, playerPath(EVENT, ALICE)),
      {
        dayStats: {
          0: { bingoCount: 0, squaresMarked: 1, firstBingoAt: null },
        },
        bingoCount: 0,
        squaresMarked: 1,
        firstBingoAt: null,
        blackout: false,
      },
      { merge: true },
    );
    writes += 1;
    batch.set(
      doc(database, markerPath(EVENT, SHARED_ITEM, ALICE)),
      marker(EVENT, ALICE, 'Shared prompt', 0),
    );
    writes += 1;

    expect(writes).toBe(12);
    await assertSucceeds(batch.commit());
  });

  it('accepts the real maximum reconcile shape, including 24 fieldless legacy markers in-window', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), COMPATIBILITY_PATH), {
        schemaVersion: 1,
        projectId: 'demo-fa-membership-mark-budget',
        acceptLegacyUntil: NOW() + 60_000,
      });
    });

    const database = db(ALICE);
    const changedIndexes = Array.from(
      { length: 25 },
      (_, index) => index,
    ).filter((index) => index !== 12);
    const markedAt = NOW();
    const makeRepairBatch = (fieldless = false) => {
      const batch = writeBatch(database);
      const overrides = Object.fromEntries(
        changedIndexes.map((index) => [
          index,
          { marked: true, markedAt, status: 'confirmed', echo: true },
        ]),
      );
      const mergeFields: Array<string | FieldPath> = changedIndexes.map(
        (index) => new FieldPath('cells', String(index)),
      );
      mergeFields.push('markSeed');
      batch.set(
        doc(database, boardPath(EVENT, 0, ALICE)),
        { cells: cellsPatch(0, overrides), markSeed: 100 },
        { mergeFields },
      );
      let writes = 1;

      for (const index of changedIndexes) {
        const repairedCell = cell(0, index);
        const itemId = repairedCell.itemId;
        expect(typeof itemId).toBe('string');
        batch.set(
          doc(database, markerPath(EVENT, itemId as string, ALICE)),
          fieldless
            ? legacyMarker(ALICE, repairedCell.text as string, 0)
            : marker(EVENT, ALICE, repairedCell.text as string, 0),
        );
        writes += 1;
      }
      return { batch, writes };
    };

    const first = makeRepairBatch();
    expect(first.writes).toBe(25);
    await assertSucceeds(first.batch.commit());

    // A lost acknowledgement may replay the same idempotent repair. The
    // second maximum-size batch exercises Board and marker UPDATE arms.
    const retry = makeRepairBatch();
    expect(retry.writes).toBe(25);
    await assertSucceeds(retry.batch.commit());

    // The old bundle's full-set marker payloads omit eventId. All 24 marker
    // authorizations share one deny-all compatibility lookup, in addition to
    // the Event/Membership paths shared by the #804 preview. This maximum
    // batch proves those cached reads stay below Firestore's aggregate budget.
    const legacy = makeRepairBatch(true);
    expect(legacy.writes).toBe(25);
    await assertSucceeds(legacy.batch.commit());
  });

  it('pins the aggregate access boundary: 6 distinct Event/Membership paths pass and 7 deny', async () => {
    const passEvents = Array.from(
      { length: 6 },
      (_, index) => `distinct-pass-${index}`,
    );
    const denyEvents = Array.from(
      { length: 7 },
      (_, index) => `distinct-deny-${index}`,
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      for (const eventId of [...passEvents, ...denyEvents]) {
        await seedEvent(database, eventId, { dayCount: 1 });
        await seedMembership(database, eventId, ALICE, 'active');
      }
    });

    const database = db(ALICE);
    const six = writeBatch(database);
    for (const eventId of passEvents) {
      six.set(
        doc(database, markerPath(eventId, `prompt-${eventId}`, ALICE)),
        marker(eventId, ALICE, eventId, 0),
      );
    }
    await assertSucceeds(six.commit());

    const seven = writeBatch(database);
    for (const eventId of denyEvents) {
      seven.set(
        doc(database, markerPath(eventId, `prompt-${eventId}`, ALICE)),
        marker(eventId, ALICE, eventId, 0),
      );
    }
    await assertFails(seven.commit());
  });
});
