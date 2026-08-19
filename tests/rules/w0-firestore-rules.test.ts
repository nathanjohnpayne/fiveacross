import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// A minimal CANONICAL cells map (#458: the board rule requires exactly the 25
// decimal keys) — these suites test gates other than cell mechanics, so the
// cells are inert placeholders.
function fullCellsMap() {
  return Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      String(i),
      { index: i, itemId: i === 12 ? null : `i${i}`, text: 'p', free: i === 12, marked: i === 12, markedAt: null },
    ]),
  );
}


// Substantive firestore.rules invariants on the w0-test-harness (#8) rules layer.
// This extends firestore-harness.test.ts (which only proves the emulator boots and
// enforces rules) with the honor-system contract the ADRs pin:
//   ADR 0001 — Marks are client-authoritative: boards/players are self-writable BY
//              DESIGN, so these tests assert those writes are ALLOWED (not a hole).
//   ADR 0002 — a Mark is private on the Board but public as an attributed per-Prompt
//              Tally; Moments broadcast a big beat.
//   ADR 0004 — reactive moderation: items updates are report-only increments and
//              settings.reportHideThreshold is validated.
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected assertFails
// denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB, CAROL] = ['admin-uid', 'alice', 'bob', 'carol'];
const NOW = () => Date.now();
// Day 0 is UNLOCKED (unlockAt an hour in the past); the day-scoped Board write
// gate reads this Day's `unlockAt` from the Event doc's `days` DayDef[] array.
const PAST = () => NOW() - 3600_000;

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;

// A fully-valid `photo` Proof whose storagePath + mediaURL are pinned to this
// proof's OWN doc id (proofs/{event}/{uid}/{id}.jpg); `over` mutates one field.
const photoProof = (id: string, over: Record<string, unknown> = {}) => ({
  uid: ALICE,
  displayName: 'Alice',
  photoURL: null,
  type: 'photo',
  cellIndex: 5,
  itemText: 'Saw a drag show',
  storagePath: `proofs/${EVENT}/${ALICE}/${id}.jpg`,
  mediaURL: `https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/proofs%2F${EVENT}%2F${ALICE}%2F${id}.jpg?alt=media&token=t`,
  thumbURL: null,
  text: null,
  createdAt: NOW(),
  reportCount: 0,
  status: 'active',
  visionFlag: null,
  ...over,
});

beforeAll(async () => {
  // Under `firebase emulators:exec` the host is exported here; fall back to the
  // firebase.json firestore port so a direct run still connects.
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-rules',
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

// Each test starts clean with a canonical Event (admins=[ADMIN], numeric threshold),
// a reportable prompt, and public-read fixtures (a foreign Tally entry, Doubt, Moment).
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise',
      sailStart: '2026-01-01',
      sailEnd: '2026-01-07',
      status: 'active',
      defaultTheme: 'neon-playground',
      claimMode: 'honor',
      admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
      days: [{ index: 0, unlockAt: PAST() }],
    });
    await setDoc(doc(s, at('items/item1')), {
      text: 'Saw a drag show',
      createdBy: ALICE,
      createdAt: NOW(),
      isFreeSpace: false,
      status: 'active',
      reportCount: 0,
      spicy: false,
    });
    await setDoc(doc(s, at(`tally/item1/markers/${CAROL}`)), {
      uid: CAROL,
      displayName: 'Carol',
      markedAt: NOW(),
    });
    await setDoc(doc(s, at('doubts/seed')), {
      itemId: 'item1',
      cellIndex: 4,
      fromUid: CAROL,
      fromDisplayName: 'Carol',
      targetUid: BOB,
      targetDisplayName: 'Bob',
      createdAt: NOW(),
    });
    await setDoc(doc(s, at('moments/seed')), {
      kind: 'bingo',
      uid: CAROL,
      displayName: 'Carol',
      photoURL: null,
      createdAt: NOW(),
    });
  });
});

describe('firestore.rules — honor-system invariants', () => {
  it('ADR 0001: boards/players are self-writable; cross-player writes denied', async () => {
    // Phase 1.5 moved Boards under days/{dayIndex} (daily-cards-spec § Data model
    // + Migration); the self-writable-by-design posture is unchanged — it just
    // rides on the day-scoped path with the unlock-time gate on top (Day 0 is
    // unlocked, so the owner write clears the gate).
    const board = (uid: string, dayIndex: number) => ({
      uid,
      dayIndex,
      seed: 1,
      createdAt: NOW(),
      cells: fullCellsMap(),
    });
    const player = (uid: string) => ({
      uid,
      displayName: uid,
      photoURL: null,
      joinedAt: NOW(),
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
    });
    await assertSucceeds(setDoc(doc(db(ALICE), at(`days/0/boards/${ALICE}`)), board(ALICE, 0)));
    await assertFails(setDoc(doc(db(ALICE), at(`days/0/boards/${BOB}`)), board(BOB, 0)));
    await assertSucceeds(setDoc(doc(db(ALICE), at(`players/${ALICE}`)), player(ALICE)));
    await assertFails(setDoc(doc(db(ALICE), at(`players/${BOB}`)), player(BOB)));
  });

  it('keeps direct-mark analytics records server-authored and private to the owner/admin', async () => {
    const transitionPath = at(`players/${ALICE}/analyticsTransitions/transition-1`);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), transitionPath), {
        transitionId: 'transition-1',
        kind: 'mark',
        createdAt: NOW(),
      });
    });

    await assertSucceeds(getDoc(doc(db(ALICE), transitionPath)));
    await assertSucceeds(getDoc(doc(db(ADMIN), transitionPath)));
    await assertFails(getDoc(doc(db(BOB), transitionPath)));
    await assertFails(setDoc(doc(db(ALICE), transitionPath), { kind: 'forged' }));
    await assertFails(setDoc(doc(db(ALICE), at(`players/${ALICE}/analyticsTransitions/forged`)), { kind: 'forged' }));
    await assertFails(deleteDoc(doc(db(ALICE), transitionPath)));
  });

  it('ADR 0002: a Mark publishes an attributed Tally entry; forgery denied; reads public', async () => {
    const entry = (uid: string) => ({ uid, displayName: uid, markedAt: NOW() });
    const mine = doc(db(ALICE), at(`tally/item1/markers/${ALICE}`));
    await assertSucceeds(setDoc(mine, entry(ALICE))); // own attributed entry
    await assertSucceeds(deleteDoc(mine)); // unmarking removes exactly that entry
    await assertFails(setDoc(doc(db(ALICE), at(`tally/item1/markers/${BOB}`)), entry(ALICE))); // another's slot
    await assertFails(setDoc(doc(db(ALICE), at(`tally/item1/markers/${ALICE}`)), entry(BOB))); // forged uid in own slot
    await assertSucceeds(getDoc(doc(db(BOB), at(`tally/item1/markers/${CAROL}`)))); // public read, no anonymity
    // The denormalized aggregate is admin/Cloud-Function-maintained, never client-forged.
    const agg = { itemId: 'item1', count: 1, markers: [] };
    await assertFails(setDoc(doc(db(ALICE), at('tally/item1')), agg));
    await assertSucceeds(setDoc(doc(db(ADMIN), at('tally/item1')), agg));
  });

  it('ADR 0004: items are report-only increments; reportHideThreshold validated', async () => {
    const item = doc(db(ALICE), at('items/item1'));
    await assertFails(updateDoc(item, { reportCount: 1, text: 'changed' })); // any other field
    await assertSucceeds(updateDoc(item, { reportCount: 1 })); // +1 only
    const event = doc(db(ADMIN), `events/${EVENT}`);
    await assertSucceeds(updateDoc(event, { 'settings.reportHideThreshold': 5 })); // numeric
    await assertFails(updateDoc(event, { 'settings.reportHideThreshold': 'high' })); // non-numeric
    await assertFails(updateDoc(doc(db(ALICE), `events/${EVENT}`), { name: 'Hacked' })); // non-admin
  });

  it('items create requires a boolean spicy tag for stratified board composition', async () => {
    const item = (over = {}) => ({
      text: 'New prompt',
      createdBy: ALICE,
      createdAt: NOW(),
      isFreeSpace: false,
      status: 'pending',
      pool: 'main',
      reportCount: 0,
      spicy: false,
      ...over,
    });
    const missingSpicy = item() as Record<string, unknown>;
    delete missingSpicy.spicy;

    await assertSucceeds(setDoc(doc(db(ALICE), at('items/tame')), item({ spicy: false })));
    await assertSucceeds(setDoc(doc(db(ALICE), at('items/spicy')), item({ spicy: true })));
    await assertFails(setDoc(doc(db(ALICE), at('items/missing-spicy')), missingSpicy));
    await assertFails(setDoc(doc(db(ALICE), at('items/string-spicy')), item({ spicy: 'false' })));
  });

  it('proofs media is pinned to the proof’s own Storage object', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), at('proofs/p1')), photoProof('p1'))); // matching pin
    // Fresh create at a distinct id whose mediaURL points at a DIFFERENT object.
    await assertFails(
      setDoc(
        doc(db(ALICE), at('proofs/p2')),
        photoProof('p2', {
          mediaURL: `https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/proofs%2F${EVENT}%2F${ALICE}%2Fp2.png?alt=media&token=t`,
        }),
      ),
    );
  });

  it('#190/#211: proofs carry source + dayIndex; invalid shapes denied', async () => {
    // attachProof ALWAYS writes both keys (null when absent), so the create must
    // pass with them present and null, and with real values.
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('proofs/s1')), photoProof('s1', { source: null, dayIndex: null })),
    );
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('proofs/s2')), photoProof('s2', { source: 'library', dayIndex: 2 })),
    );
    await assertSucceeds(
      setDoc(doc(db(ALICE), at('proofs/s3')), photoProof('s3', { source: 'camera', dayIndex: 0 })),
    );
    // Shape is validated even though the values are flavour (ADR 0001).
    await assertFails(
      setDoc(doc(db(ALICE), at('proofs/s4')), photoProof('s4', { source: 'screenshot' })),
    );
    await assertFails(
      setDoc(doc(db(ALICE), at('proofs/s5')), photoProof('s5', { dayIndex: 'day-2' })),
    );
  });

  it('ADR 0001: a User self-attests 18+ (attestedAdultAt); cross/invalid denied', async () => {
    const profile = (over = {}) => ({
      displayName: 'Alice',
      photoURL: null,
      createdAt: NOW(),
      attestedAdultAt: NOW(),
      ...over,
    });
    await assertSucceeds(setDoc(doc(db(ALICE), `users/${ALICE}`), profile())); // self-write
    await assertFails(setDoc(doc(db(ALICE), `users/${BOB}`), profile())); // cross-user
    await assertFails(setDoc(doc(db(ALICE), `users/${ALICE}`), profile({ attestedAdultAt: 'yes' }))); // non-numeric
  });

  it('ADR 0001: Doubts are social pressure — own-attributed, public, never a gate', async () => {
    const doubt = (over = {}) => ({
      itemId: 'item1',
      cellIndex: 5,
      fromUid: ALICE,
      fromDisplayName: 'Alice',
      targetUid: CAROL,
      targetDisplayName: 'Carol',
      createdAt: NOW(),
      ...over,
    });
    // Canonical `${fromUid}_${targetUid}_${itemId}` slots so these turn on
    // ownership, not the #106 id↔triple binding (mirroring the moments ids below),
    // and the target is CAROL — this file's seeded tally/item1 marker — because
    // the create rule requires the target's STANDING Mark (#106 round 3). Both
    // bindings are pinned in tests/rules/w2-doubts.test.ts.
    await assertSucceeds(setDoc(doc(db(ALICE), at(`doubts/${ALICE}_${CAROL}_item1`)), doubt())); // raised on another's standing Mark
    await assertFails(setDoc(doc(db(ALICE), at(`doubts/${BOB}_${CAROL}_item1`)), doubt({ fromUid: BOB }))); // forged fromUid
    await assertSucceeds(getDoc(doc(db(ALICE), at('doubts/seed')))); // public read
  });

  it('ADR 0002: Moments broadcast a big beat — own-attributed, public', async () => {
    const moment = (over = {}) => ({
      kind: 'bingo',
      uid: ALICE,
      displayName: 'Alice',
      photoURL: null,
      createdAt: NOW(),
      ...over,
    });
    // Canonical `${uid}-${kind}` ids so these turn on ownership, not the #103 id↔kind
    // binding: an own beat at its deterministic id is allowed, a forged uid is denied.
    await assertSucceeds(setDoc(doc(db(ALICE), at(`moments/${ALICE}-bingo`)), moment())); // own beat
    await assertFails(setDoc(doc(db(ALICE), at(`moments/${BOB}-bingo`)), moment({ uid: BOB }))); // forged uid
    await assertSucceeds(getDoc(doc(db(ALICE), at('moments/seed')))); // public read
  });

  it('keeps bug reports and rate-limit state server-only', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'bugReports/report_123'), { description: 'private' });
      await setDoc(doc(ctx.firestore(), 'bugReportEscalations/report_123'), {
        state: 'pending', reporterUid: ALICE, eventId: EVENT,
      });
    });
    await assertFails(getDoc(doc(db(ALICE), 'bugReports/report_123')));
    await assertFails(setDoc(doc(db(ALICE), 'bugReports/forged'), { description: 'forged' }));
    // `kind` is the field that decides whether an admin is mailed (#670), so a
    // client able to write it could either mint admin alerts at will or bury a
    // real abuse report by rewriting it down to a bug. Denied in both
    // directions, like every other field on the document.
    await assertFails(setDoc(doc(db(ALICE), 'bugReports/forged-abuse'), { description: 'forged', kind: 'abuse' }));
    await assertFails(updateDoc(doc(db(ALICE), 'bugReports/report_123'), { kind: 'bug' }));
    await assertFails(getDoc(doc(db(ALICE), `bugReportRateLimits/${ALICE}`)));
    await assertFails(setDoc(doc(db(ALICE), `bugReportRateLimits/${ALICE}`), { submissionMs: [NOW()] }));
    await assertFails(getDoc(doc(db(ALICE), 'bugReportEscalations/report_123')));
    await assertFails(setDoc(doc(db(ALICE), 'bugReportEscalations/forged'), {
      state: 'pending', reporterUid: ALICE, eventId: EVENT,
    }));
    await assertFails(updateDoc(doc(db(ADMIN), 'bugReportEscalations/report_123'), { state: 'terminal' }));
    await assertFails(deleteDoc(doc(db(ADMIN), 'bugReportEscalations/report_123')));
  });
});
