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
      // An Event still IN PROGRESS: Day 0 has opened, Day 1 has not. That is
      // the state an organiser configures in, and it matters for the ADR 0011
      // freeze rules below — adding a freeze to an Event whose schedule has
      // already run out crosses a boundary that has settled, and is denied.
      days: [
        { index: 0, unlockAt: PAST(), theme: 'neon-playground' },
        { index: 1, unlockAt: NOW() + 7200_000, theme: 'get-sporty' },
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
  it('ALLOWS an admin to set a numeric, still-FUTURE standingsFreezeAt', async () => {
    // Future by construction: a freeze may only ever be scheduled ahead of
    // itself, so `NOW()` is deliberately not the fixture.
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
  });

  it('DENIES a non-admin Player setting standingsFreezeAt', async () => {
    // A FUTURE value, so the denial is about identity rather than the bound.
    await assertFails(
      updateDoc(doc(db(MALLORY), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
  });

  it('DENIES an unauthenticated write of standingsFreezeAt', async () => {
    await assertFails(
      updateDoc(doc(unauthDb(), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
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
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
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

  it('DENIES setting a freeze that is already in the PAST', async () => {
    // Instantly frozen for a refreshed client, still live for a cached one.
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() - 3600_000 }),
    );
  });

  it('DENIES deleting a still-FUTURE freeze', async () => {
    // Removal falls back to the ceremonial-Day derivation, which may already
    // have elapsed — the same settled-boundary crossing, by another route.
    const future = NOW() + 3600_000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { standingsFreezeAt: future });
    });
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: deleteField() }),
    );
  });

  // Phase 4b P2: adding an explicit freeze to a doc that had none, once the
  // Event's own schedule has run out, crosses a boundary that has already
  // settled — refreshed clients un-freeze while cached ones stay frozen.
  it('DENIES adding a freeze once the schedule has already run out', async () => {
    // The seeded fixture's Days are both in the PAST, so the derived boundary
    // has elapsed and no explicit value exists yet.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), `events/${EVENT}`),
        {
          name: 'Cruise',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          settings: { reportHideThreshold: 3 },
          timezone: 'Europe/Rome',
          days: [
            { index: 0, unlockAt: PAST(), theme: 'neon-playground' },
            { index: 1, unlockAt: PAST(), theme: 'get-sporty', pool: 'closing' },
          ],
        },
      );
    });
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
  });

  it('DENIES adding a freeze after an early ceremonial Day has settled the derived boundary', async () => {
    const now = NOW();
    const days = Array.from({ length: 10 }, (_, index) => ({
      index,
      unlockAt: index <= 2 ? now - (3 - index) * 3600_000 : now + index * 3600_000,
      theme: `theme-${index}`,
      scoring: index === 2 ? 'ceremonial' : 'competitive',
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days });
    });

    // The derived freeze is Day 2's past unlock, even though seven later
    // competitive Days remain in the future. Adding an explicit future freeze
    // would make refreshed clients resume standings that cached clients keep
    // frozen at the already-settled derived boundary.
    await assertFails(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: now + 12 * 3600_000 }),
    );
  });

  it('still ALLOWS adding a freeze before a last-Day ceremonial boundary on a full ten-Day schedule', async () => {
    const now = NOW();
    const days = Array.from({ length: 10 }, (_, index) => ({
      index,
      unlockAt: now + (index + 1) * 3600_000,
      theme: `theme-${index}`,
      scoring: index === 9 ? 'ceremonial' : 'competitive',
    }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days });
    });

    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: now + 12 * 3600_000 }),
    );
  });

  it('still ALLOWS configuring a freeze while the Event is still running', async () => {
    // The legitimate case this must not block: the schedule has not run out, so
    // no boundary has settled and an organiser may still state one.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), `events/${EVENT}`),
        {
          name: 'Cruise',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          settings: { reportHideThreshold: 3 },
          timezone: 'Europe/Rome',
          days: [
            { index: 0, unlockAt: PAST(), theme: 'neon-playground' },
            { index: 1, unlockAt: NOW() + 7200_000, theme: 'get-sporty' },
          ],
        },
      );
    });
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: NOW() + 3600_000 }),
    );
  });

  // Phase 4b P1: once `last_call` has posted, the finale's clock is settled.
  // That Moment persists the freeze phrase it announced and is deduped on every
  // later scheduler run, so moving the boundary afterwards leaves a permanently
  // wrong deadline on the Feed — and `scoring` was previously locked only from
  // a Day's own unlock, which is AFTER last-call posts.
  describe('once the finale has been announced', () => {
    const announce = async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `events/${EVENT}/moments/last_call`), {
          kind: 'last_call',
          uid: 'system',
          createdAt: NOW(),
        });
      });
    };

    it('DENIES moving a still-future standingsFreezeAt', async () => {
      const future = NOW() + 7200_000;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { standingsFreezeAt: future });
      });
      // Allowed right up until the announcement…
      await assertSucceeds(
        updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: future + 60_000 }),
      );
      await announce();
      // …and refused after it.
      await assertFails(
        updateDoc(doc(db(ADMIN), `events/${EVENT}`), { standingsFreezeAt: future + 120_000 }),
      );
    });

    it('DENIES flipping the sole future ceremonial Day to competitive', async () => {
      // The sharper half: this would make `finaleTimes` return null, so the
      // announced freeze never happens and no podium is ever posted — while the
      // last-call Moment sits on the Feed still promising one.
      const days = [
        { index: 0, unlockAt: PAST(), theme: 'neon-playground' },
        { index: 1, unlockAt: NOW() + 7200_000, theme: 'get-sporty', pool: 'closing' },
      ];
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days });
      });
      const flipped = days.map((d, i) => (i === 1 ? { ...d, scoring: 'competitive' } : d));
      // The Day is still in the future, so the per-Day lock alone permits this.
      await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { days: flipped }));

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), `events/${EVENT}`), { days });
      });
      await announce();
      await assertFails(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { days: flipped }));
    });

    it('still ALLOWS unrelated admin config edits', async () => {
      await announce();
      await assertSucceeds(updateDoc(doc(db(ADMIN), `events/${EVENT}`), { claimMode: 'proof' }));
    });
  });

  // Phase 4b P2 noted that the future-boundary clauses short-circuit on
  // `resource == null`, so a CREATE could smuggle in an already-elapsed freeze.
  // The clause now applies on create too — but the finding turns out not to be
  // reachable from a client at all, and that is worth recording rather than
  // leaving as an assumption: `isAdmin` resolves the roster by READING the
  // event doc, so on a create there is no doc to read, the `get()` errors, and
  // the write denies before any field check runs. Client-side Event creation is
  // a seed/Admin-SDK operation. The clause stands as defence-in-depth for any
  // future path that does permit creation.
  it('DENIES creating an Event at all — with a past freeze or a future one', async () => {
    for (const freeze of [NOW() - 3600_000, NOW() + 3600_000]) {
      await assertFails(
        setDoc(doc(db(ADMIN), `events/cruise-fresh-${freeze}`), {
          name: 'Fresh',
          status: 'active',
          admins: [ADMIN],
          bannedUids: [],
          settings: { reportHideThreshold: 3 },
          timezone: 'Europe/Rome',
          days: [],
          standingsFreezeAt: freeze,
        }),
      );
    }
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
