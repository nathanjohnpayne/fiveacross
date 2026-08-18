import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteField, doc, setDoc, updateDoc } from 'firebase/firestore';

// specs/d15-finale.md, rules layer: `EventDoc.frozenAt` (the finale freeze stamp,
// set by the 08:00-Day-10 scheduler run via the Admin SDK) is admin/Function-
// writable only — a non-admin Player can never set it directly. The whole event
// doc sits behind the `isAdmin` update gate, so this proves the freeze stamp
// inherits that protection with no client write path of its own.
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected assertFails
// denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, MALLORY] = ['admin-uid', 'mallory'];
const NOW = () => Date.now();
const PAST = () => NOW() - 3600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const unauthDb = () => testEnv.unauthenticatedContext().firestore();

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId so this suite's clearFirestore never races
    // another file's seed (same convention as the other d15 rules suites).
    projectId: 'demo-gaycruisebingo-d15-finale-rules',
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
// shaped so the admin update gate's own field checks pass) with no freeze stamp yet.
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

describe('d15-finale — frozenAt is admin/Function-writable only', () => {
  it('ALLOWS an admin to set frozenAt', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { frozenAt: NOW() }));
  });

  it('DENIES a non-admin Player setting frozenAt', async () => {
    await assertFails(updateDoc(doc(db(MALLORY), `events/${EVENT}`), { frozenAt: NOW() }));
  });

  it('DENIES an unauthenticated write of frozenAt', async () => {
    await assertFails(updateDoc(doc(unauthDb(), `events/${EVENT}`), { frozenAt: NOW() }));
  });
});

// ADR 0011: `standingsFreezeAt` is the CONFIGURED freeze — the schedule, where
// `frozenAt` is the stamp. It rides the same admin gate, and carries the shape
// check the read side depends on.
describe('ADR 0011 — standingsFreezeAt is admin/Function-writable only', () => {
  it('ALLOWS an admin to set a numeric standingsFreezeAt', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() }));
  });

  it('DENIES a non-admin Player setting standingsFreezeAt', async () => {
    await assertFails(updateDoc(doc(db(MALLORY), `events/${EVENT}`), { standingsFreezeAt: NOW() }));
  });

  it('DENIES an unauthenticated write of standingsFreezeAt', async () => {
    await assertFails(updateDoc(doc(unauthDb(), `events/${EVENT}`), { standingsFreezeAt: NOW() }));
  });

  it('DENIES even an admin writing a non-POSITIVE standingsFreezeAt', async () => {
    // Both readers ignore a non-positive instant (0 is the schedule's
    // "always unlocked" sentinel), so accepting one would be a successful
    // write that every consumer silently discards.
    for (const bad of [0, -1]) {
      await assertFails(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: bad }));
    }
  });

  // ADR 0011, Codex P2 on PR #841: once the configured freeze has PASSED, it is
  // locked until the scheduler stamps `frozenAt`. Moving or removing it in that
  // window splits the roster — clients holding the old cutoff have stopped
  // folding stats while refreshed ones follow the new one and resume — and it
  // is exactly the window a scheduler outage widens.
  it('LOCKS a configured freeze once its cutoff has passed', async () => {
    const past = NOW() - 3600_000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { standingsFreezeAt: past });
    });
    // Moving it is rejected.
    await assertFails(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() }));
    // So is DELETING it, which would fall back to the ceremonial-Day
    // derivation — just as much a change of a settled boundary.
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: deleteField() }),
    );
  });

  it('leaves unrelated admin config edits alone once the freeze has passed', async () => {
    // The lock compares the RESULTING document, so a partial update that does
    // not mention the field carries it through unchanged and is still allowed.
    // An admin must not be locked out of the rest of the Event doc just because
    // the freeze has settled.
    const past = NOW() - 3600_000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { standingsFreezeAt: past });
    });
    await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { claimMode: 'proof' }));
    // …as is echoing the same value back explicitly.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { claimMode: 'honor', standingsFreezeAt: past }),
    );
  });

  it('still allows changing a freeze that has NOT yet passed', async () => {
    const future = NOW() + 3600_000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { standingsFreezeAt: future });
    });
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: future + 7200_000 }),
    );
  });

  it('DENIES a positive-INFINITE standingsFreezeAt', async () => {
    // Infinity is a Firestore number and passes `> 0`, but both readers discard
    // it via Number.isFinite — so without the upper bound it is another
    // successful write that silently does nothing.
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: Number.POSITIVE_INFINITY }),
    );
  });

  it('DENIES even an admin writing a non-number standingsFreezeAt', async () => {
    // A string instant reads as "not configured" on every `typeof === 'number'`
    // guard, so it would silently fall back to the schedule derivation instead
    // of failing where the organiser could see it.
    for (const bad of [String(NOW()), null, true, { at: NOW() }]) {
      await assertFails(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: bad }));
    }
  });
});
