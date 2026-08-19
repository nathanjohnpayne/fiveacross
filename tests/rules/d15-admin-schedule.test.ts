import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';

// specs/d15-admin-schedule.md — the Admin Schedule editor's write-time lock
// (#221, daily-cards-spec § "Admin console" / § "Itinerary and schedule"):
// "changing a locked-future Day's theme is safe, changing an already-unlocked
// Day is disallowed." The UI's disabled dropdown (src/components/Admin.tsx)
// is a courtesy — THIS is the guarantee: `firestore.rules`' `daysThemeLockOk`
// denies a direct-SDK write that changes a past/unlocked Day's `days[i].theme`,
// time-gated against a FIXED `request.time` (PAST/FUTURE relative to `NOW()`
// captured once at module load, mirroring d15-firestore-rules.test.ts).
//
// The PERMISSION_DENIED lines the SDK logs to stderr are the expected
// assertFails denials, not test failures.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE] = ['admin-uid', 'alice'];
// Pin NOW at module load (like d15-firestore-rules.test.ts) so every
// seededDays() call — the beforeEach seed AND a test body re-sending the array —
// stamps IDENTICAL unlockAt values. A real Admin client re-sends the exact
// `unlockAt` it holds from its subscription, so an UNCHANGED Day must compare
// equal; a per-call Date.now() would drift by milliseconds and trip the
// unlockAt-immutability lock on Days the write never meant to touch.
const NOW = Date.now();
const PAST = () => NOW - 3600_000; // an hour ago — this Day has already unlocked
const FUTURE = () => NOW + 3600_000; // an hour from now — still locked-future

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const eventDoc = (ctxDb: ReturnType<typeof db>) => doc(ctxDb, 'events', EVENT);

// Day 0 unlocked an hour ago; Day 1 unlocks an hour from now — the same
// PAST/FUTURE two-Day fixture shape as d15-firestore-rules.test.ts.
const seededDays = () => [
  {
    index: 0,
    date: '2026-07-15',
    port: 'Trieste',
    portEmoji: '🇮🇹',
    theme: 'welcome-aboard',
    tonight: ['Sail-Away Party', 'Welcome Party'],
    pool: 'embark',
    tutorial: true,
    unlockAt: PAST(),
  },
  {
    index: 1,
    date: '2026-07-16',
    port: 'Split',
    portEmoji: '🇭🇷',
    theme: 'get-sporty',
    tonight: ['Dog Tag T-Dance', 'Duty Free'],
    pool: 'main',
    tutorial: false,
    unlockAt: FUTURE(),
  },
];

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Unique per-file projectId (like every other w/d15-suite) so this
    // suite's `clearFirestore()` never wipes another concurrently-running
    // file's seed.
    projectId: 'demo-gaycruisebingo-d15-admin-schedule',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, 'events', EVENT), {
      name: 'Cruise',
      sailStart: '2026-07-15',
      sailEnd: '2026-07-24',
      status: 'active',
      defaultTheme: 'neon-playground',
      claimMode: 'honor',
      admins: [ADMIN],
      timezone: 'Europe/Rome',
      settings: { reportHideThreshold: 4 },
      days: seededDays(),
    });
  });
});

describe('firestore.rules — Admin Schedule editor day-theme lock (specs/d15-admin-schedule.md)', () => {
  it('an Admin CAN change days[i].theme for a Day with a future unlockAt', async () => {
    const days = seededDays();
    days[1] = { ...days[1], theme: 'duty-free' };
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CANNOT change days[i].theme for a Day whose unlockAt has already passed', async () => {
    const days = seededDays();
    days[0] = { ...days[0], theme: 'so-long-farewell' };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CAN change days[i].tonight for a Day with a future unlockAt', async () => {
    const days = seededDays();
    days[1] = { ...days[1], tonight: ['Tea Dance', 'After-Hours Karaoke'] };
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CANNOT write a malformed days[i].tonight for a Day with a future unlockAt', async () => {
    const oneEntry = seededDays();
    oneEntry[1] = { ...oneEntry[1], tonight: ['Tea Dance'] };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: oneEntry }));

    const threeEntries = seededDays();
    threeEntries[1] = { ...threeEntries[1], tonight: ['Tea Dance', 'Karaoke', 'Deck Party'] };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: threeEntries }));

    const nonString = seededDays();
    nonString[1] = { ...nonString[1], tonight: ['Tea Dance', 123] as unknown as string[] };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: nonString }));
  });

  it('an Admin CANNOT drop tonight for a Day with a future unlockAt once the field exists', async () => {
    const days = seededDays();
    const { tonight: _dropped, ...withoutTonight } = days[1];
    days[1] = withoutTonight as (typeof days)[number];
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CANNOT change days[i].tonight for a Day whose unlockAt has already passed', async () => {
    const days = seededDays();
    days[0] = { ...days[0], tonight: ['Late Dinner', 'Deck Party'] };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('a non-admin can never write days[] at all — locked or unlocked Day, any field', async () => {
    const lockedChange = seededDays();
    lockedChange[1] = { ...lockedChange[1], theme: 'duty-free' };
    await assertFails(updateDoc(eventDoc(db(ALICE)), { days: lockedChange }));

    const pastChange = seededDays();
    pastChange[0] = { ...pastChange[0], theme: 'so-long-farewell' };
    await assertFails(updateDoc(eventDoc(db(ALICE)), { days: pastChange }));
  });

  it('an Admin write that leaves days untouched (e.g. claimMode) is unaffected by the lock', async () => {
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { claimMode: 'proof_required' }));
  });

  // Codex P2 (firestore.rules:48) — dropping `theme` on an already-unlocked Day
  // is a CHANGE, not "nothing to lock": otherwise a follow-up write could add any
  // new theme because `oldDay` no longer carries one, bypassing "locked once
  // unlocked".
  it('an Admin CANNOT drop the theme of a Day whose unlockAt has already passed', async () => {
    const days = seededDays();
    const { theme: _dropped, ...withoutTheme } = days[0];
    days[0] = withoutTheme as (typeof days)[number];
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CANNOT drop tonight for a Day whose unlockAt has already passed', async () => {
    const days = seededDays();
    const { tonight: _dropped, ...withoutTonight } = days[0];
    days[0] = withoutTonight as (typeof days)[number];
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  // Codex P2 (firestore.rules:49) — rescheduling an already-unlocked Day's
  // `unlockAt` (theme unchanged) is denied: otherwise pushing it into the future
  // would re-open the theme lock for a second write.
  it('an Admin CANNOT move the unlockAt of a Day that has already unlocked', async () => {
    const days = seededDays();
    days[0] = { ...days[0], unlockAt: FUTURE() };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  // The flip side: a still-future Day stays fully editable — both its theme and
  // its unlockAt may change before it opens.
  it('an Admin CAN reschedule the unlockAt of a still-future Day', async () => {
    const days = seededDays();
    days[1] = { ...days[1], unlockAt: FUTURE() + 3600_000 };
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  // ADR 0011 (#551): `scoring` joins the same lock. Flipping an already-played
  // Day's Scoring Policy re-interprets the podium at once, while every Player's
  // denormalized root totals keep the OLD policy until that Player folds
  // another Mark — one roster, two rules, no way to tell the rows apart.
  it('an Admin CANNOT change days[i].scoring for a Day whose unlockAt has already passed', async () => {
    const days = seededDays();
    days[0] = { ...days[0], scoring: 'ceremonial' };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('an Admin CANNOT ADD or DROP scoring on an already-unlocked Day', async () => {
    const added = seededDays();
    added[0] = { ...added[0], scoring: 'competitive' }; // seeded Days carry none
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: added }));

    const withPolicy = seededDays().map((d, i) => (i === 0 ? { ...d, scoring: 'competitive' } : d));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days: withPolicy });
    });
    const dropped = withPolicy.map((d, i) => {
      if (i !== 0) return d;
      const { scoring, ...rest } = d as Record<string, unknown>;
      return rest;
    });
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: dropped }));
  });

  it('an Admin CAN set days[i].scoring on a still-future Day', async () => {
    const days = seededDays();
    days[1] = { ...days[1], scoring: 'ceremonial' };
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  it('DENIES a malformed scoring value on a still-future Day', async () => {
    const days = seededDays();
    days[1] = { ...days[1], scoring: 'ceremoniall' };
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days }));
  });

  // Bodega Bay's shape — FOUR Days, the largest Event that actually evaluates
  // within Firestore's expression cap today. The enum check unrolls ten times,
  // so this is the measurement that decides whether it can ship at all: if a
  // legitimate four-Day edit still succeeds, the check costs nothing real for
  // every Event that works, and the ten-Day case is #850's to fix.
  it('still ALLOWS a legitimate edit on a FOUR-Day schedule with the enum check', async () => {
    const fourDays = Array.from({ length: 4 }, (_, index) => ({
      index,
      date: `2026-08-0${7 + Math.min(index, 2)}`,
      port: 'Bodega Bay',
      portEmoji: '🐦',
      theme: index === 0 ? 'welcome-aboard' : 'get-sporty',
      tonight: ['One', 'Two'],
      pool: index === 0 ? 'embark' : index === 3 ? 'farewell' : 'main',
      tutorial: index === 3,
      scoring: index === 3 ? 'ceremonial' : 'competitive',
      unlockAt: index < 2 ? PAST() : FUTURE(),
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days: fourDays });
    });
    const edited = fourDays.map((d, i) => (i === 2 ? { ...d, theme: 'neon-pink-playground' } : d));
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days: edited }));
  });

  // Gay Cruise Bingo's production shape: the full ten-Day schedule must stay
  // below Firestore's 1000-expression cap when an Admin changes one future Day.
  it('still ALLOWS a legitimate edit on a full TEN-Day schedule (expression budget)', async () => {
    const tenDays = Array.from({ length: 10 }, (_, index) => ({
      index,
      date: `2026-07-${String(15 + index).padStart(2, '0')}`,
      port: `Port ${index}`,
      portEmoji: '🇮🇹',
      theme: index === 0 ? 'welcome-aboard' : 'get-sporty',
      tonight: ['One', 'Two'],
      pool: index === 0 ? 'embark' : index === 9 ? 'farewell' : 'main',
      tutorial: index === 0 || index === 9,
      scoring: index === 9 ? 'ceremonial' : 'competitive',
      // Days 0-4 are already open; 5-9 are still ahead.
      unlockAt: index < 5 ? PAST() : FUTURE(),
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days: tenDays });
    });

    const edited = tenDays.map((d, i) => (i === 7 ? { ...d, theme: 'neon-pink-playground' } : d));
    await assertSucceeds(updateDoc(eventDoc(db(ADMIN)), { days: edited }));
  });

  it('still DENIES a locked-Day edit on a full TEN-Day schedule', async () => {
    // Paired with the allow case above so reducing expression cost never weakens
    // the lock on a changed Day that has already opened.
    const tenDays = Array.from({ length: 10 }, (_, index) => ({
      index,
      date: `2026-07-${String(15 + index).padStart(2, '0')}`,
      port: `Port ${index}`,
      portEmoji: '🇮🇹',
      theme: index === 0 ? 'welcome-aboard' : 'get-sporty',
      tonight: ['One', 'Two'],
      pool: index === 0 ? 'embark' : index === 9 ? 'farewell' : 'main',
      tutorial: index === 0 || index === 9,
      scoring: index === 9 ? 'ceremonial' : 'competitive',
      unlockAt: index < 5 ? PAST() : FUTURE(),
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days: tenDays });
    });

    const edited = tenDays.map((d, i) => (i === 2 ? { ...d, theme: 'neon-pink-playground' } : d));
    await assertFails(updateDoc(eventDoc(db(ADMIN)), { days: edited }));
  });
});
