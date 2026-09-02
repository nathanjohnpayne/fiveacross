import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

// The complete deployed Firestore half of specs/event-membership.md. This file
// uses two enforced Events in one emulator project so every positive same-Event
// assertion has a symmetric foreign-Event denial. Events whose switch is off or
// absent retain the pre-#804 signed-in posture.

const RULES_PATH = fileURLToPath(
  new URL('../../firestore.rules', import.meta.url),
);
const RULES_SOURCE = readFileSync(RULES_PATH, 'utf8');
const EVENT_A = 'membership-event-a';
const EVENT_B = 'membership-event-b';
const OFF_EVENT = 'membership-event-off';
const ABSENT_EVENT = 'membership-event-absent';
const MEMBER_A = 'member-a';
const MEMBER_B = 'member-b';
const STRANGER = 'stranger';
const REVOKED = 'revoked';
const ADMIN_A = 'admin-a';
const ADMIN_WITHOUT_MEMBERSHIP = 'transitional-admin';
const FRESH_MEMBER_A = 'fresh-member-a';
const FRESH_STRANGER = 'fresh-stranger';
const TALLY_TARGET = 'tally-target';
const NOW = Date.now();
const PAST = NOW - 3_600_000;

let testEnv: RulesTestEnvironment;
const authed = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const eventPath = (eventId: string) => `events/${eventId}`;
const membershipPath = (eventId: string, uid: string) =>
  `${eventPath(eventId)}/memberships/${uid}`;
const markerPath = (eventId: string, uid: string) =>
  `${eventPath(eventId)}/tally/shared-item/markers/${uid}`;

function fullCellsMap() {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      String(index),
      {
        index,
        itemId: index === 12 ? null : `item-${index}`,
        text: index === 12 ? 'FREE' : `Prompt ${index}`,
        free: index === 12,
        marked: index === 12,
        markedAt: null,
      },
    ]),
  );
}

function playerData(uid: string, reshufflesUsed = 1) {
  return {
    uid,
    displayName: uid,
    photoURL: null,
    joinedAt: NOW,
    bingoCount: 0,
    squaresMarked: 0,
    firstBingoAt: null,
    reshufflesUsed,
  };
}

function proofData(uid: string) {
  return {
    uid,
    displayName: uid,
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: 'Membership proof',
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'It happened.',
    createdAt: NOW,
    reportCount: 0,
    status: 'active',
    visionFlag: null,
    source: null,
    dayIndex: 0,
  };
}

function publicReadPaths(eventId: string, uid: string): string[] {
  return [
    eventPath(eventId),
    `${eventPath(eventId)}/items/active-item`,
    `${eventPath(eventId)}/players/${uid}`,
    `${eventPath(eventId)}/players/${uid}/analyticsTransitions/transition`,
    `${eventPath(eventId)}/reshuffles/seeded-marker`,
    `${eventPath(eventId)}/days/0/boards/${uid}`,
    `${eventPath(eventId)}/days/0/meta/0`,
    `${eventPath(eventId)}/proofs/target-proof`,
    `${eventPath(eventId)}/claims/${uid}`,
    `${eventPath(eventId)}/tally/shared-item`,
    markerPath(eventId, TALLY_TARGET),
    `${eventPath(eventId)}/doubts/seeded-doubt`,
    `${eventPath(eventId)}/hearts/seeded-heart`,
    `${eventPath(eventId)}/moments/seeded-moment`,
    `${eventPath(eventId)}/momentRetractions/seeded-retraction`,
    `${eventPath(eventId)}/notices/seeded-notice`,
  ];
}

async function expectReads(
  database: Firestore,
  paths: string[],
  outcome: 'allow' | 'deny',
): Promise<void> {
  for (const path of paths) {
    const operation = getDoc(doc(database, path));
    if (outcome === 'allow') {
      await assertSucceeds(operation);
    } else {
      await assertFails(operation);
    }
  }
}

async function seedEventContent(
  database: Firestore,
  eventId: string,
): Promise<void> {
  const at = (suffix: string) => `${eventPath(eventId)}/${suffix}`;
  await setDoc(doc(database, at('items/active-item')), {
    text: 'Active prompt',
    createdBy: TALLY_TARGET,
    status: 'active',
    reportCount: 0,
    spicy: false,
  });
  await setDoc(doc(database, at('reshuffles/seeded-marker')), {
    uid: TALLY_TARGET,
    n: 1,
    dayIndex: 0,
  });
  await setDoc(
    doc(database, at('proofs/target-proof')),
    proofData(TALLY_TARGET),
  );
  await setDoc(doc(database, at('tally/shared-item')), {
    itemId: 'shared-item',
    count: 1,
  });
  await setDoc(doc(database, markerPath(eventId, TALLY_TARGET)), {
    eventId,
    uid: TALLY_TARGET,
    displayName: 'Target',
    markedAt: NOW,
  });
  await setDoc(doc(database, at('doubts/seeded-doubt')), {
    fromUid: TALLY_TARGET,
    targetUid: MEMBER_A,
    itemId: 'shared-item',
    cellIndex: 0,
    createdAt: NOW,
  });
  await setDoc(doc(database, at('hearts/seeded-heart')), {
    uid: TALLY_TARGET,
    targetKind: 'proof',
    targetId: 'target-proof',
    targetCreatedAt: NOW,
    createdAt: NOW,
  });
  await setDoc(doc(database, at('moments/seeded-moment')), {
    kind: 'bingo',
    uid: TALLY_TARGET,
    displayName: 'Target',
    photoURL: null,
    dayIndex: 0,
    createdAt: NOW,
  });
  await setDoc(doc(database, at('momentRetractions/seeded-retraction')), {
    uid: TALLY_TARGET,
    kind: 'bingo',
    dayIndex: 0,
    createdAt: NOW,
  });
  await setDoc(doc(database, at('notices/seeded-notice')), {
    uid: ADMIN_A,
    title: 'Notice',
    body: 'Membership fixture',
    pinned: false,
    createdAt: NOW,
  });

  for (const uid of [
    MEMBER_A,
    MEMBER_B,
    STRANGER,
    REVOKED,
    ADMIN_A,
    ADMIN_WITHOUT_MEMBERSHIP,
  ]) {
    await setDoc(doc(database, at(`players/${uid}`)), playerData(uid));
    await setDoc(doc(database, at(`days/0/boards/${uid}`)), {
      uid,
      dayIndex: 0,
      seed: 1,
      createdAt: NOW,
      cells: fullCellsMap(),
    });
    await setDoc(doc(database, at(`claims/${uid}`)), { uid });
    await setDoc(
      doc(database, at(`players/${uid}/analyticsTransitions/transition`)),
      { uid, delivered: false },
    );
    await setDoc(doc(database, at(`items/existing-${uid}`)), {
      text: `Existing prompt for ${uid}`,
      createdBy: uid,
      status: 'active',
      reportCount: 0,
      spicy: false,
    });
    await setDoc(
      doc(database, at(`proofs/existing-${uid}`)),
      proofData(uid),
    );
    await setDoc(doc(database, markerPath(eventId, uid)), {
      eventId,
      uid,
      displayName: uid,
      markedAt: NOW,
    });
    await setDoc(doc(database, at(`doubts/from-${uid}`)), {
      fromUid: uid,
      targetUid: TALLY_TARGET,
      itemId: 'shared-item',
      cellIndex: 0,
      createdAt: NOW,
    });
    await setDoc(doc(database, at(`doubts/to-${uid}`)), {
      fromUid: TALLY_TARGET,
      targetUid: uid,
      itemId: 'shared-item',
      cellIndex: 0,
      createdAt: NOW,
    });
    await setDoc(
      doc(database, at(`hearts/${uid}_proof_existing-${uid}`)),
      {
        uid,
        targetKind: 'proof',
        targetId: `existing-${uid}`,
        targetCreatedAt: NOW,
        createdAt: NOW,
      },
    );
    await setDoc(doc(database, at(`moments/${uid}-blackout-d0`)), {
      kind: 'blackout',
      uid,
      displayName: uid,
      photoURL: null,
      dayIndex: 0,
      createdAt: NOW,
    });
  }

  await setDoc(doc(database, at('days/0/meta/admin-seeded')), {
    firstBingo: { uid: TALLY_TARGET, displayName: 'Target', at: NOW },
  });
}

type ClientOperation = readonly [name: string, run: () => Promise<unknown>];

function clientWriteInventory(
  database: Firestore,
  eventId: string,
  uid: string,
): ClientOperation[] {
  const at = (suffix: string) => `${eventPath(eventId)}/${suffix}`;
  const momentId = `${uid}-bingo-d0`;
  return [
    [
      'item create',
      () =>
        setDoc(doc(database, at(`items/pending-${uid}`)), {
          text: 'Pending membership prompt',
          createdBy: uid,
          pool: 'main',
          status: 'pending',
          reportCount: 0,
          spicy: false,
        }),
    ],
    [
      'item report update',
      () =>
        updateDoc(doc(database, at(`items/existing-${uid}`)), {
          reportCount: 1,
        }),
    ],
    [
      'player update',
      () =>
        setDoc(doc(database, at(`players/${uid}`)), {
          ...playerData(uid),
          squaresMarked: 1,
        }),
    ],
    [
      'reshuffle marker create',
      () =>
        setDoc(doc(database, at(`reshuffles/${uid}-1`)), {
          uid,
          n: 1,
          dayIndex: 0,
        }),
    ],
    [
      'board update',
      () =>
        setDoc(doc(database, at(`days/0/boards/${uid}`)), {
          uid,
          dayIndex: 0,
          seed: 1,
          createdAt: NOW,
          cells: fullCellsMap(),
          touchedByMembershipTest: true,
        }),
    ],
    [
      'day meta create',
      () =>
        setDoc(doc(database, at('days/0/meta/0')), {
          firstBingo: { uid, displayName: uid, at: NOW },
        }),
    ],
    [
      'proof create',
      () => setDoc(doc(database, at(`proofs/proof-${uid}`)), proofData(uid)),
    ],
    [
      'proof report update',
      () =>
        updateDoc(doc(database, at(`proofs/existing-${uid}`)), {
          reportCount: 1,
        }),
    ],
    [
      'claim create',
      () => setDoc(doc(database, at(`claims/claim-${uid}`)), { uid }),
    ],
    [
      'Tally marker create',
      () =>
        setDoc(doc(database, at(`tally/write-item/markers/${uid}`)), {
          eventId,
          uid,
          displayName: uid,
          markedAt: NOW,
        }),
    ],
    [
      'Tally marker update',
      () =>
        updateDoc(doc(database, markerPath(eventId, uid)), {
          markedAt: NOW,
        }),
    ],
    [
      'Tally marker delete',
      () => deleteDoc(doc(database, markerPath(eventId, uid))),
    ],
    [
      'doubt create',
      () =>
        setDoc(doc(database, at(`doubts/${uid}_${TALLY_TARGET}_shared-item`)), {
          fromUid: uid,
          targetUid: TALLY_TARGET,
          itemId: 'shared-item',
          cellIndex: 0,
          createdAt: NOW,
        }),
    ],
    [
      'doubt satisfaction update',
      () =>
        updateDoc(doc(database, at(`doubts/to-${uid}`)), {
          satisfiedAt: NOW,
          satisfiedProofId: 'target-proof',
        }),
    ],
    [
      'doubt owner delete',
      () => deleteDoc(doc(database, at(`doubts/from-${uid}`))),
    ],
    [
      'heart create',
      () =>
        setDoc(doc(database, at(`hearts/${uid}_proof_target-proof`)), {
          uid,
          targetKind: 'proof',
          targetId: 'target-proof',
          targetCreatedAt: NOW,
          createdAt: NOW,
        }),
    ],
    [
      'heart update',
      () =>
        updateDoc(
          doc(database, at(`hearts/${uid}_proof_existing-${uid}`)),
          { createdAt: NOW },
        ),
    ],
    [
      'heart owner delete',
      () =>
        deleteDoc(
          doc(database, at(`hearts/${uid}_proof_existing-${uid}`)),
        ),
    ],
    [
      'proof owner delete',
      () => deleteDoc(doc(database, at(`proofs/existing-${uid}`))),
    ],
    [
      'moment create',
      () =>
        setDoc(doc(database, at(`moments/${momentId}`)), {
          kind: 'bingo',
          uid,
          displayName: uid,
          photoURL: null,
          dayIndex: 0,
          createdAt: NOW,
        }),
    ],
    [
      'moment retraction create',
      () =>
        setDoc(doc(database, at(`momentRetractions/${momentId}`)), {
          uid,
          kind: 'bingo',
          dayIndex: 0,
          createdAt: NOW,
        }),
    ],
    [
      'moment owner delete with both retraction forms',
      () => {
        const batch = writeBatch(database);
        const scopedId = `${uid}-blackout-d0`;
        const legacyId = `${uid}-blackout`;
        const retraction = {
          uid,
          kind: 'blackout',
          dayIndex: 0,
          createdAt: NOW,
        };
        batch.delete(doc(database, at(`moments/${scopedId}`)));
        batch.set(
          doc(database, at(`momentRetractions/${scopedId}`)),
          retraction,
        );
        batch.set(
          doc(database, at(`momentRetractions/${legacyId}`)),
          retraction,
        );
        return batch.commit();
      },
    ],
  ];
}

async function expectClientWrites(
  database: Firestore,
  eventId: string,
  uid: string,
  outcome: 'allow' | 'deny',
): Promise<void> {
  for (const [name, run] of clientWriteInventory(database, eventId, uid)) {
    try {
      if (outcome === 'allow') {
        await assertSucceeds(run());
      } else {
        await assertFails(run());
      }
    } catch (error) {
      throw new Error(`${name} did not ${outcome}`, { cause: error });
    }
  }
}

function adminWriteInventory(
  database: Firestore,
  eventId: string,
): ClientOperation[] {
  const at = (suffix: string) => `${eventPath(eventId)}/${suffix}`;
  return [
    [
      'root Event update',
      () =>
        updateDoc(doc(database, eventPath(eventId)), {
          name: `${eventId} — Admin updated`,
        }),
    ],
    [
      'item moderation update',
      () =>
        updateDoc(doc(database, at('items/active-item')), {
          text: 'Admin-updated prompt',
        }),
    ],
    [
      'item delete',
      () => deleteDoc(doc(database, at('items/active-item'))),
    ],
    [
      'player delete',
      () => deleteDoc(doc(database, at(`players/${STRANGER}`))),
    ],
    [
      'reshuffle marker delete',
      () => deleteDoc(doc(database, at('reshuffles/seeded-marker'))),
    ],
    [
      'Board delete',
      () =>
        deleteDoc(doc(database, at(`days/0/boards/${STRANGER}`))),
    ],
    [
      'Day meta delete',
      () => deleteDoc(doc(database, at('days/0/meta/admin-seeded'))),
    ],
    [
      'Proof moderation update',
      () =>
        updateDoc(doc(database, at('proofs/target-proof')), {
          reportCount: 2,
        }),
    ],
    [
      'Proof delete',
      () => deleteDoc(doc(database, at('proofs/target-proof'))),
    ],
    [
      'Claim resolution update',
      () =>
        updateDoc(doc(database, at(`claims/${STRANGER}`)), {
          status: 'active',
        }),
    ],
    [
      'Claim delete',
      () => deleteDoc(doc(database, at(`claims/${STRANGER}`))),
    ],
    [
      'Tally aggregate update',
      () =>
        updateDoc(doc(database, at('tally/shared-item')), {
          count: 2,
        }),
    ],
    [
      'Tally aggregate delete',
      () => deleteDoc(doc(database, at('tally/shared-item'))),
    ],
    [
      'Doubt moderation update',
      () =>
        updateDoc(doc(database, at('doubts/seeded-doubt')), {
          satisfiedAt: NOW,
          satisfiedProofId: 'target-proof',
        }),
    ],
    [
      'Doubt delete',
      () => deleteDoc(doc(database, at('doubts/seeded-doubt'))),
    ],
    [
      'Heart delete',
      () => deleteDoc(doc(database, at('hearts/seeded-heart'))),
    ],
    [
      'Moment delete',
      () => deleteDoc(doc(database, at('moments/seeded-moment'))),
    ],
    [
      'Moment retraction delete',
      () =>
        deleteDoc(
          doc(database, at('momentRetractions/seeded-retraction')),
        ),
    ],
    [
      'Notice update',
      () =>
        updateDoc(doc(database, at('notices/seeded-notice')), {
          body: 'Admin-updated membership fixture',
          editedAt: NOW,
        }),
    ],
    [
      'Notice delete',
      () => deleteDoc(doc(database, at('notices/seeded-notice'))),
    ],
  ];
}

function eventData(
  eventId: string,
  membershipEnforcement: 'off' | 'enforced' | undefined,
  admins: string[] = [],
) {
  return {
    name: eventId,
    status: 'active',
    defaultTheme: 'neon-playground',
    claimMode: 'honor',
    admins,
    settings: { reportHideThreshold: 3 },
    days: [
      {
        index: 0,
        date: '2026-09-02',
        port: 'Test place',
        portEmoji: '✨',
        theme: 'neon-playground',
        tonight: ['One', 'Two'],
        pool: 'main',
        tutorial: false,
        scoring: 'competitive',
        unlockAt: PAST,
      },
    ],
    ...(membershipEnforcement === undefined ? {} : { membershipEnforcement }),
  };
}

async function seedMembership(
  database: Firestore,
  eventId: string,
  uid: string,
  status: 'active' | 'revoked' = 'active',
): Promise<void> {
  await setDoc(doc(database, membershipPath(eventId, uid)), {
    schemaVersion: 1,
    eventId,
    uid,
    role: uid.startsWith('admin') ? 'admin' : 'member',
    status,
    grantedAt: NOW,
    grantedBy: 'system:test',
    invitationId: null,
    ...(status === 'revoked' ? { revokedAt: NOW, revokedBy: ADMIN_A } : {}),
  });
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fiveacross-event-membership',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: RULES_SOURCE,
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
    await setDoc(
      doc(database, eventPath(EVENT_A)),
      eventData(EVENT_A, 'enforced', [ADMIN_A, ADMIN_WITHOUT_MEMBERSHIP]),
    );
    await setDoc(
      doc(database, eventPath(EVENT_B)),
      eventData(EVENT_B, 'enforced'),
    );
    await setDoc(
      doc(database, eventPath(OFF_EVENT)),
      eventData(OFF_EVENT, 'off', [ADMIN_A]),
    );
    await setDoc(
      doc(database, eventPath(ABSENT_EVENT)),
      eventData(ABSENT_EVENT, undefined, [ADMIN_A]),
    );

    await seedMembership(database, EVENT_A, MEMBER_A);
    await seedMembership(database, EVENT_A, ADMIN_A);
    await seedMembership(database, EVENT_A, FRESH_MEMBER_A);
    await seedMembership(database, EVENT_A, REVOKED, 'revoked');
    await seedMembership(database, EVENT_B, MEMBER_B);

    for (const eventId of [EVENT_A, EVENT_B, OFF_EVENT, ABSENT_EVENT]) {
      await seedEventContent(database, eventId);
    }

    for (const [eventId, uid] of [
      [EVENT_A, MEMBER_A],
      [EVENT_A, MEMBER_B],
      [EVENT_A, STRANGER],
      [EVENT_B, MEMBER_B],
    ] as const) {
      await setDoc(doc(database, markerPath(eventId, uid)), {
        eventId,
        uid,
        displayName: uid,
        markedAt: NOW,
      });
    }
  });
});

describe('firestore.rules — Event membership enforcement (#804)', () => {
  it('gates root Event updates without pulling its impossible client create into admission', () => {
    const helperStart = RULES_SOURCE.indexOf(
      'function eventConfigWriteAuthorized(eventId) {',
    );
    const helperEnd = RULES_SOURCE.indexOf(
      'function markerDeliveryCompatibilityDoc()',
      helperStart,
    );
    const helper = RULES_SOURCE.slice(helperStart, helperEnd);

    if (
      helperStart < 0 ||
      helperEnd < 0 ||
      !helper.includes('return isAdminWithEvent(event)') ||
      !helper.includes('resource == null') ||
      !helper.includes('|| (admittedWithEvent(eventId, event)') ||
      !helper.includes('&& membershipEnforcementUnchanged()') ||
      !RULES_SOURCE.includes(
        'allow create, update: if eventConfigWriteAuthorized(eventId)',
      )
    ) {
      throw new Error(
        'root Event create must retain its old roster-only impossibility while update is admission-gated and freezes membershipEnforcement',
      );
    }
  });

  it('gates the root Event read in both cohort directions', async () => {
    await assertSucceeds(getDoc(doc(authed(MEMBER_A), eventPath(EVENT_A))));
    await assertSucceeds(getDoc(doc(authed(MEMBER_B), eventPath(EVENT_B))));
    await assertFails(getDoc(doc(authed(MEMBER_A), eventPath(EVENT_B))));
    await assertFails(getDoc(doc(authed(MEMBER_B), eventPath(EVENT_A))));
    await assertFails(getDoc(doc(authed(STRANGER), eventPath(EVENT_A))));
    await assertFails(getDoc(doc(authed(REVOKED), eventPath(EVENT_A))));
  });

  it('gates every Event-scoped read in both cohort directions without narrowing same-Event visibility', async () => {
    await expectReads(
      authed(MEMBER_A),
      publicReadPaths(EVENT_A, MEMBER_A),
      'allow',
    );
    await expectReads(
      authed(MEMBER_B),
      publicReadPaths(EVENT_B, MEMBER_B),
      'allow',
    );

    // Keep the private path predicates in the challenge: each caller asks for
    // their own Board, Claim and analytics row in the foreign Event. A denial
    // therefore proves admission was conjoined rather than replacing or being
    // hidden behind the pre-existing owner check.
    await expectReads(
      authed(MEMBER_A),
      publicReadPaths(EVENT_B, MEMBER_A),
      'deny',
    );
    await expectReads(
      authed(MEMBER_B),
      publicReadPaths(EVENT_A, MEMBER_B),
      'deny',
    );
    await expectReads(
      authed(STRANGER),
      publicReadPaths(EVENT_A, STRANGER),
      'deny',
    );
    await expectReads(
      authed(REVOKED),
      publicReadPaths(EVENT_A, REVOKED),
      'deny',
    );
  });

  it('keeps explicit-off and absent-switch Events open to signed-in callers', async () => {
    await expectReads(
      authed(STRANGER),
      publicReadPaths(OFF_EVENT, STRANGER),
      'allow',
    );
    await expectReads(
      authed(STRANGER),
      publicReadPaths(ABSENT_EVENT, STRANGER),
      'allow',
    );
  });

  it('ships Decision D-A: a roster Admin remains admitted without Membership', async () => {
    await expectReads(
      authed(ADMIN_WITHOUT_MEMBERSHIP),
      publicReadPaths(EVENT_A, ADMIN_WITHOUT_MEMBERSHIP),
      'allow',
    );
  });

  it('allows the Event A member every existing client write and denies the same writes in Event B', async () => {
    await expectClientWrites(authed(MEMBER_A), EVENT_A, MEMBER_A, 'allow');
    await expectClientWrites(authed(MEMBER_A), EVENT_B, MEMBER_A, 'deny');
  });

  it('allows the Event B member every existing client write and denies the same writes in Event A', async () => {
    await expectClientWrites(authed(MEMBER_B), EVENT_B, MEMBER_B, 'allow');
    await expectClientWrites(authed(MEMBER_B), EVENT_A, MEMBER_B, 'deny');
  });

  it('denies every otherwise-valid client write to a stranger or revoked member', async () => {
    await expectClientWrites(authed(STRANGER), EVENT_A, STRANGER, 'deny');
    await expectClientWrites(authed(REVOKED), EVENT_A, REVOKED, 'deny');
  });

  it('preserves every existing client write while the switch is explicit-off or absent', async () => {
    await expectClientWrites(authed(STRANGER), OFF_EVENT, STRANGER, 'allow');
    await expectClientWrites(authed(STRANGER), ABSENT_EVENT, STRANGER, 'allow');
  });

  it('closes self-admission on brand-new Player and Board documents', async () => {
    await assertSucceeds(
      setDoc(
        doc(
          authed(FRESH_MEMBER_A),
          `${eventPath(EVENT_A)}/players/${FRESH_MEMBER_A}`,
        ),
        playerData(FRESH_MEMBER_A, 0),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(
          authed(FRESH_MEMBER_A),
          `${eventPath(EVENT_A)}/days/0/boards/${FRESH_MEMBER_A}`,
        ),
        {
          uid: FRESH_MEMBER_A,
          dayIndex: 0,
          seed: 1,
          createdAt: NOW,
          cells: fullCellsMap(),
        },
      ),
    );

    await assertFails(
      setDoc(
        doc(
          authed(FRESH_MEMBER_A),
          `${eventPath(EVENT_B)}/players/${FRESH_MEMBER_A}`,
        ),
        playerData(FRESH_MEMBER_A, 0),
      ),
    );
    await assertFails(
      setDoc(
        doc(
          authed(FRESH_MEMBER_A),
          `${eventPath(EVENT_B)}/days/0/boards/${FRESH_MEMBER_A}`,
        ),
        {
          uid: FRESH_MEMBER_A,
          dayIndex: 0,
          seed: 1,
          createdAt: NOW,
          cells: fullCellsMap(),
        },
      ),
    );
    await assertFails(
      setDoc(
        doc(
          authed(FRESH_STRANGER),
          `${eventPath(EVENT_A)}/players/${FRESH_STRANGER}`,
        ),
        playerData(FRESH_STRANGER, 0),
      ),
    );
  });

  it('keeps an enforced Board reshuffle within the ten-call per-operation budget', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), `${eventPath(EVENT_A)}/players/${MEMBER_A}`),
        playerData(MEMBER_A, 0),
      );
    });

    const database = authed(MEMBER_A);
    const batch = writeBatch(database);
    batch.set(
      doc(database, `${eventPath(EVENT_A)}/days/0/boards/${MEMBER_A}`),
      {
        uid: MEMBER_A,
        dayIndex: 0,
        seed: 2,
        createdAt: NOW,
        cells: fullCellsMap(),
      },
    );
    batch.update(doc(database, `${eventPath(EVENT_A)}/players/${MEMBER_A}`), {
      reshufflesUsed: 1,
    });
    batch.set(doc(database, `${eventPath(EVENT_A)}/reshuffles/${MEMBER_A}-1`), {
      uid: MEMBER_A,
      n: 1,
      dayIndex: 0,
    });

    await assertSucceeds(batch.commit());
  });

  it('applies Decision D-A to privileged Firestore writes during the transition', async () => {
    const database = authed(ADMIN_WITHOUT_MEMBERSHIP);
    await assertSucceeds(
      setDoc(doc(database, `${eventPath(EVENT_A)}/tally/admin-aggregate`), {
        itemId: 'admin-aggregate',
        count: 0,
      }),
    );
    await assertSucceeds(
      setDoc(doc(database, `${eventPath(EVENT_A)}/notices/transitional`), {
        uid: ADMIN_WITHOUT_MEMBERSHIP,
        title: 'Transition',
        body: 'D-A remains live during backfill.',
        pinned: false,
        createdAt: NOW,
      }),
    );
    await assertSucceeds(
      getDocs(collection(database, `${eventPath(EVENT_A)}/memberships`)),
    );
    for (const [name, run] of adminWriteInventory(database, EVENT_A)) {
      try {
        await assertSucceeds(run());
      } catch (error) {
        throw new Error(`${name} did not preserve Decision D-A`, {
          cause: error,
        });
      }
    }
    // Root delete runs last because Firestore leaves subcollections orphaned;
    // the test exercises every other privileged arm before removing the root.
    await assertSucceeds(deleteDoc(doc(database, eventPath(EVENT_A))));
  });

  it('keeps Memberships client-unwritable while preserving self-inspection', async () => {
    await assertSucceeds(
      getDoc(doc(authed(REVOKED), membershipPath(EVENT_A, REVOKED))),
    );
    await assertSucceeds(
      getDoc(doc(authed(STRANGER), membershipPath(EVENT_A, STRANGER))),
    );
    await assertFails(
      setDoc(doc(authed(STRANGER), membershipPath(EVENT_A, STRANGER)), {
        status: 'active',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(MEMBER_A), membershipPath(EVENT_A, MEMBER_A)), {
        status: 'revoked',
      }),
    );
    await assertFails(
      deleteDoc(doc(authed(MEMBER_A), membershipPath(EVENT_A, MEMBER_A))),
    );
  });

  it('allows only an admitted Admin to list the roster', async () => {
    await assertSucceeds(
      getDocs(collection(authed(ADMIN_A), `${eventPath(EVENT_A)}/memberships`)),
    );
    await assertFails(
      getDocs(
        collection(authed(MEMBER_A), `${eventPath(EVENT_A)}/memberships`),
      ),
    );
    await assertFails(
      getDocs(
        collection(authed(STRANGER), `${eventPath(EVENT_A)}/memberships`),
      ),
    );
  });

  it('makes the Event switch immutable to every client Admin', async () => {
    await assertFails(
      updateDoc(doc(authed(ADMIN_A), eventPath(EVENT_A)), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(ADMIN_A), eventPath(OFF_EVENT)), {
        membershipEnforcement: 'enforced',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(ADMIN_A), eventPath(ABSENT_EVENT)), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(ADMIN_WITHOUT_MEMBERSHIP), eventPath(EVENT_A)), {
        membershipEnforcement: 'off',
      }),
    );
  });

  it('denies switch mutation on an otherwise-valid low-expression Event update', async () => {
    const enforcedId = 'membership-switch-cheap-enforced';
    const absentId = 'membership-switch-cheap-absent';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      const { days: _enforcedDays, ...enforced } = eventData(
        enforcedId,
        'enforced',
        [ADMIN_A],
      );
      const { days: _absentDays, ...absent } = eventData(absentId, undefined, [
        ADMIN_A,
      ]);
      await setDoc(doc(database, eventPath(enforcedId)), enforced);
      await setDoc(doc(database, eventPath(absentId)), absent);
      await seedMembership(database, enforcedId, ADMIN_A);
    });

    // The control proves this is a valid Admin update, then the two denials pin
    // value and presence immutability without relying on the schedule rule's
    // expression ceiling as the reason for refusal.
    await assertSucceeds(
      updateDoc(doc(authed(ADMIN_A), eventPath(enforcedId)), {
        name: 'Cheap enforced control',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(ADMIN_A), eventPath(enforcedId)), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(authed(ADMIN_A), eventPath(absentId)), {
        membershipEnforcement: 'off',
      }),
    );
  });

  it('keeps an enforced ten-Day all-theme update below the expression budget', async () => {
    const eventId = 'membership-ten-day-budget';
    const days = Array.from({ length: 10 }, (_, index) => ({
      index,
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      port: `Future ${index}`,
      portEmoji: '✨',
      theme: 'neon-playground',
      tonight: ['One', 'Two'],
      pool: 'main',
      tutorial: false,
      scoring: 'competitive',
      unlockAt: NOW + (index + 1) * 86_400_000,
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await setDoc(doc(database, eventPath(eventId)), {
        ...eventData(eventId, 'enforced', [ADMIN_A]),
        days,
      });
      await seedMembership(database, eventId, ADMIN_A);
    });

    await assertSucceeds(
      updateDoc(doc(authed(ADMIN_A), eventPath(eventId)), {
        days: days.map((day, index) => ({
          ...day,
          theme: index % 2 === 0 ? 'vacation' : 'neon-playground',
        })),
      }),
    );
  });

  it('keeps the Event-scoped collection-group Tally surface working when enforced', async () => {
    const result = await assertSucceeds(
      getDocs(
        query(
          collectionGroup(authed(MEMBER_A), 'markers'),
          where('eventId', '==', EVENT_A),
        ),
      ),
    );
    if (result.docs.length !== 7) {
      throw new Error(
        `expected seven Event A markers, got ${result.docs.length}`,
      );
    }
    await assertFails(
      getDocs(
        query(
          collectionGroup(authed(MEMBER_A), 'markers'),
          where('eventId', '==', EVENT_B),
        ),
      ),
    );
  });
});
