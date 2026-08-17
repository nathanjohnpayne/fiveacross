import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// specs/community-prompt-targeting.md (#557) — the firestore.rules contract for
// Day-targeted Community Prompts. Three claims:
//
//   1. `targetDayIndex` is OPTIONAL but, when present, must be a non-negative
//      int — a malformed target is rejected at the door rather than left for the
//      snapshot filter to reason about.
//   2. Only an ADMIN can move a Prompt's Day, and only an admin can approve it.
//      The pre-existing `hasOnly(['reportCount'])` bound on a non-admin update is
//      what enforces both; this file pins that it actually covers the new field,
//      so a submitter cannot re-aim their own Prompt after the fact.
//   3. A suggestion is never visible outside its Event — including to an admin
//      of a DIFFERENT Event, which is the case a same-Event-only test would miss.
//
// The routing decisions themselves are pinned in
// src/data/community-prompt-targeting.test.ts, and the snapshot admission in
// tests/functions/community-prompt-targeting-snapshot.test.ts.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected
// assertFails denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const OTHER_EVENT = 'regatta';
const [ADMIN, ALICE, BOB, OTHER_ADMIN] = ['admin-uid', 'alice', 'bob', 'other-admin-uid'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string, event = EVENT) => `events/${event}/${p}`;

const pendingPayload = (createdBy: string, over: Record<string, unknown> = {}) => ({
  text: 'Put it on tomorrow’s card',
  createdBy,
  createdAt: NOW(),
  status: 'pending',
  pool: 'main',
  reportCount: 0,
  spicy: false,
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId so this suite's clearFirestore() never wipes a
    // concurrently-running file's seed.
    projectId: 'demo-gaycruisebingo-community-prompt-targeting',
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
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise',
      status: 'active',
      admins: [ADMIN],
      settings: { reportHideThreshold: 4 },
      timezone: 'Europe/Rome',
    });
    // A SECOND Event, so cross-Event scoping can be tested against a real admin
    // of somewhere else rather than merely an unprivileged stranger.
    await setDoc(doc(s, `events/${OTHER_EVENT}`), {
      name: 'Regatta',
      status: 'active',
      admins: [OTHER_ADMIN],
      timezone: 'Europe/Rome',
    });
  });
});

describe('create — targetDayIndex shape', () => {
  it('ALLOWS a pending submission carrying a valid target Day', async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('items/p1')), pendingPayload(ALICE, { targetDayIndex: 3 })),
    );
  });

  it('ALLOWS Day 0 as a target — index 0 is a real Day, not a falsy blank', async () => {
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('items/p2')), pendingPayload(ALICE, { targetDayIndex: 0 })),
    );
  });

  it('ALLOWS a submission with NO target — the untargeted every-Day contract', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at('items/p3')), pendingPayload(ALICE)));
  });

  it('DENIES a negative target', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), at('items/p4')), pendingPayload(ALICE, { targetDayIndex: -1 })),
    );
  });

  it('DENIES a non-integer target', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), at('items/p5')), pendingPayload(ALICE, { targetDayIndex: 2.5 })),
    );
  });

  it('DENIES a string target', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), at('items/p6')), pendingPayload(ALICE, { targetDayIndex: '3' })),
    );
  });

  it('DENIES a null target — absent is the no-target spelling, not null', async () => {
    await assertFails(
      setDoc(doc(db(ALICE), at('items/p7')), pendingPayload(ALICE, { targetDayIndex: null })),
    );
  });

  it('DENIES a non-admin creating a targeted item ALREADY active — the approval gate holds', async () => {
    await assertFails(
      setDoc(
        doc(db(ALICE), at('items/p8')),
        pendingPayload(ALICE, { status: 'active', targetDayIndex: 3 }),
      ),
    );
  });

  it('ALLOWS an admin to create an active targeted item, and DENIES a malformed one', async () => {
    await assertSucceeds(
      setDoc(
        doc(db(ADMIN), at('items/p9')),
        pendingPayload(ADMIN, { status: 'active', targetDayIndex: 4 }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db(ADMIN), at('items/p10')),
        pendingPayload(ADMIN, { status: 'active', targetDayIndex: 'soon' }),
      ),
    );
  });
});

describe('update — only an admin re-targets or approves', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), at('items/p1')),
        pendingPayload(ALICE, { targetDayIndex: 3 }),
      );
    });
  });

  it('DENIES the SUBMITTER re-aiming their own Prompt at another Day', async () => {
    // Re-targeting is an organiser decision. A submitter who could move their
    // own Prompt could walk it onto whichever Day they liked, approval or not.
    await assertFails(updateDoc(doc(db(ALICE), at('items/p1')), { targetDayIndex: 4 }));
  });

  it('DENIES any other non-admin re-aiming it', async () => {
    await assertFails(updateDoc(doc(db(BOB), at('items/p1')), { targetDayIndex: 4 }));
  });

  it('DENIES a non-admin approving it, with or without a target change', async () => {
    await assertFails(
      updateDoc(doc(db(ALICE), at('items/p1')), { status: 'active', approvedBy: ALICE }),
    );
    await assertFails(
      updateDoc(doc(db(ALICE), at('items/p1')), { status: 'active', targetDayIndex: 4 }),
    );
  });

  it('DENIES an admin of a DIFFERENT Event approving or re-aiming it', async () => {
    await assertFails(updateDoc(doc(db(OTHER_ADMIN), at('items/p1')), { status: 'active' }));
    await assertFails(updateDoc(doc(db(OTHER_ADMIN), at('items/p1')), { targetDayIndex: 4 }));
  });

  it('ALLOWS this Event’s admin to approve AND roll the Prompt forward in one write', async () => {
    // The approval-routing write: status, attribution and the rolled-forward Day
    // land together, which is what makes the placement atomic.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('items/p1')), {
        status: 'active',
        approvedBy: ADMIN,
        approvedAt: NOW(),
        targetDayIndex: 5,
      }),
    );
  });

  it('ALLOWS this Event’s admin to stamp retainedAt instead of a new Day', async () => {
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('items/p1')), {
        status: 'active',
        approvedBy: ADMIN,
        approvedAt: NOW(),
        retainedAt: NOW(),
      }),
    );
  });

  it('DENIES even an ADMIN moving a Prompt to a MALFORMED Day', async () => {
    // The create rule has always rejected these shapes; the update arm now
    // matches it, so a malformed target cannot be minted through the rules at
    // all (CodeRabbit, PR #812). No legitimate admin operation needs to: an
    // approval writes a routed integer, and a repair writes a real Day.
    for (const bad of [null, -1, 1.5, '4']) {
      await assertFails(updateDoc(doc(db(ADMIN), at('items/p1')), { targetDayIndex: bad }));
    }
  });

  it('ALLOWS an admin to REMOVE the target — repair is not the same as corruption', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), at('items/p1')), { targetDayIndex: deleteField() }));
  });

  it('ALLOWS RETAINING a row that ALREADY carries a malformed target', async () => {
    // The interaction the new bound has to survive. `approveItems` retains such a
    // row by stamping `retainedAt` and deliberately NOT touching the malformed
    // value (guessing the intended Day would be inventing one), so the check is
    // conditioned on the field CHANGING. An unconditional check would deny this
    // write and strand the very row it exists to retain — the row can predate the
    // rule, arriving through an import on the Admin SDK, which bypasses rules.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), at('items/malformed')), {
        ...pendingPayload(ALICE),
        targetDayIndex: null,
      });
    });
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), at('items/malformed')), {
        status: 'active',
        approvedBy: ADMIN,
        approvedAt: NOW(),
        retainedAt: NOW(),
      }),
    );
  });

  it('still ALLOWS the one non-admin update there has ever been: the report increment', async () => {
    await assertSucceeds(updateDoc(doc(db(BOB), at('items/p1')), { reportCount: 1 }));
  });
});

describe('read — a suggestion is never visible outside its Event', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), at('items/p1')),
        pendingPayload(ALICE, { targetDayIndex: 3 }),
      );
    });
  });

  it('DENIES an admin of ANOTHER Event reading this Event’s pending suggestion', async () => {
    // The Event-scoping claim. `isAdmin(eventId)` is evaluated against the
    // Event in the PATH, so privilege somewhere else buys nothing here.
    await assertFails(getDoc(doc(db(OTHER_ADMIN), at('items/p1'))));
  });

  it('DENIES another Player in the same Event reading it', async () => {
    await assertFails(getDoc(doc(db(BOB), at('items/p1'))));
  });

  it('ALLOWS the submitter to read their own pending suggestion back', async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), at('items/p1'))));
  });

  it('ALLOWS this Event’s admin to read it', async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), at('items/p1'))));
  });

  it('DENIES a submitter reading their OWN suggestion once it is rejected', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), at('items/p2')),
        pendingPayload(ALICE, { status: 'rejected', targetDayIndex: 3 }),
      );
    });
    await assertFails(getDoc(doc(db(ALICE), at('items/p2'))));
  });

  it('DENIES reading a targeted suggestion that lives in another Event entirely', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), at('items/theirs', OTHER_EVENT)),
        pendingPayload(OTHER_ADMIN, { targetDayIndex: 1 }),
      );
    });
    await assertFails(getDoc(doc(db(ALICE), at('items/theirs', OTHER_EVENT))));
  });
});
