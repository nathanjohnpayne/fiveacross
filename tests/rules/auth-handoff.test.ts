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
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  setDoc,
  updateDoc,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import {
  HANDOFF_TTL_MS,
  buildHandoffRecord,
  exchangeHandoff,
  handoffPath,
  mintHandoff,
  transactionIdFor,
  type ExchangeDeps,
  type HandoffDocRef,
  type HandoffFirestore,
  type HandoffSnapshot,
} from '../../functions/src/authHandoff';

// Covers specs/auth-handoff.md at the emulator layer, in two halves that need
// the same fixture and belong in one file:
//
//   RULES. `authHandoffs/{codeHash}` is denied to every client in both
//   directions. A deny-all block reads like it could be deleted as redundant
//   with Firestore's default deny; it cannot, and this half is what turns "we
//   meant to deny it" into a failing test if a later edit widens it.
//
//   CONSUMPTION, against REAL Firestore. Single-use is a claim about
//   transaction semantics, and a claim about transaction semantics cannot be
//   proven by a fake that implements those semantics — the fake would only be
//   proving itself. The unit suite (tests/functions/auth-handoff.test.ts)
//   enumerates the rejection branches cheaply; this half drives the same
//   `exchangeHandoff` through a thin adapter onto the real emulator, so the
//   replay and concurrent-exchange guarantees are checked against the database
//   that will actually enforce them.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'bodega';
const HOST = 'bodega-bay.fiveacross.app';
const ORIGIN = `https://${HOST}`;
const [ADMIN, ALICE] = ['admin-uid', 'alice'];
const T0 = 1_760_000_000_000;

const token = (seed: string) => (seed + 'x'.repeat(43)).slice(0, 43);
const VERIFIER = token('verifier-');
const CODE = token('code-');

let testEnv: RulesTestEnvironment;
const authed = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

/** The document a real mint writes, so the rules arms below aim at a real path. */
const HANDOFF_PATH = handoffPath(CODE);

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // A suite-specific projectId: the emulator hosts each projectId as isolated
    // data, so two suites sharing one id race each other's clearFirestore().
    projectId: 'demo-gcb-auth-handoff',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const raw = ctx.firestore();
    // An admin roster, so "not even an admin" below is a real assertion.
    await setDoc(doc(raw, `events/${EVENT}`), { name: 'Bodega', admins: [ADMIN] });
    await setDoc(doc(raw, `hostnames/${HOST}`), {
      eventId: EVENT,
      canonicalHost: HOST,
      edition: 'vacay',
      status: 'active',
      isCanonical: true,
    });
    // A live, unconsumed handoff — written through the production builder rather
    // than a hand-copied shape, so this fixture cannot drift from what mint writes.
    await setDoc(
      doc(raw, HANDOFF_PATH),
      buildHandoffRecord({
        uid: ALICE,
        targetOrigin: ORIGIN,
        transactionId: transactionIdFor(VERIFIER),
        eventId: EVENT,
        issuedAt: T0,
        expiresAt: T0 + HANDOFF_TTL_MS,
        timestamp: (ms) => Timestamp.fromMillis(ms),
      }),
    );
  });
});

// --- Rules: denied to every client ----------------------------------------------

describe('authHandoffs rules', () => {
  it.each([
    ['unauthenticated', () => anon()],
    ['the player the code belongs to', () => authed(ALICE)],
    ['another signed-in player', () => authed('mallory')],
    ['an Event admin', () => authed(ADMIN)],
  ])('denies %s a read of a handoff document', async (_label, db) => {
    await assertFails(getDoc(doc(db(), HANDOFF_PATH)));
  });

  it.each([
    ['unauthenticated', () => anon()],
    ['a signed-in player', () => authed(ALICE)],
    ['an Event admin', () => authed(ADMIN)],
  ])('denies %s a listing of the collection', async (_label, db) => {
    await assertFails(getDocs(collection(db(), 'authHandoffs')));
  });

  it.each([
    ['unauthenticated', () => anon()],
    ['a signed-in player', () => authed(ALICE)],
    ['an Event admin', () => authed(ADMIN)],
  ])('denies %s minting a document of their own', async (_label, db) => {
    // The forgery this closes: a self-minted code naming somebody else's uid
    // would be a sign-in as that person, with no Google round trip at all.
    await assertFails(
      setDoc(doc(db(), 'authHandoffs/forged'), { uid: 'victim', targetOrigin: ORIGIN }),
    );
  });

  it('denies clearing consumedAt — the replay that would defeat single use', async () => {
    await assertFails(updateDoc(doc(authed(ALICE), HANDOFF_PATH), { consumedAt: null }));
  });

  it('denies pushing expiresAt forward — the TTL that would never arrive', async () => {
    await assertFails(
      updateDoc(doc(authed(ALICE), HANDOFF_PATH), {
        expiresAt: Timestamp.fromMillis(T0 + 86_400_000),
      }),
    );
  });

  it('denies deleting a handoff document', async () => {
    await assertFails(deleteDoc(doc(authed(ADMIN), HANDOFF_PATH)));
  });

  it('leaves the neighbouring collections alone', async () => {
    // The guard against an over-broad edit: the deny must be scoped to this
    // collection, and the pre-auth hostname lookup in particular must still work
    // — the handoff cannot even start without it.
    await assertSucceeds(getDoc(doc(anon(), `hostnames/${HOST}`)));
  });
});

// --- The consume path, against the real emulator ---------------------------------

/** The web SDK dressed as the admin-SDK surface `authHandoff.ts` declares. */
interface AdaptedRef extends HandoffDocRef {
  ref: DocumentReference;
}

function adapt(raw: Firestore): HandoffFirestore {
  const snapOf = (s: { exists: () => boolean; data: () => unknown }): HandoffSnapshot => ({
    exists: s.exists(),
    data: () => s.data() as Record<string, unknown> | undefined,
  });
  const refOf = (r: HandoffDocRef) => (r as AdaptedRef).ref;

  return {
    doc: (path: string): AdaptedRef => {
      const ref = doc(raw, path);
      return {
        ref,
        get: async () => snapOf(await getDoc(ref)),
        // Test-only: the emulator fixture writes into a freshly cleared
        // database, so the admin SDK's create-if-absent semantics are not what
        // is under test here. Single-use is enforced by the transaction below,
        // never by this call.
        create: async (data) => setDoc(ref, data),
      };
    },
    runTransaction: (fn) =>
      runTransaction(raw, (tx) =>
        fn({
          get: async (r) => snapOf(await tx.get(refOf(r))),
          update: (r, d) => {
            tx.update(refOf(r), d);
          },
        }),
      ),
  };
}

const deps = (db: HandoffFirestore, over: Partial<ExchangeDeps> = {}): ExchangeDeps => ({
  db,
  now: () => T0 + 1_000,
  timestamp: (ms) => Timestamp.fromMillis(ms),
  createCustomToken: async (uid: string) => `custom-token-for:${uid}`,
  ...over,
});

describe('handoff consumption against a real Firestore', () => {
  it('mints and redeems once, then refuses every replay', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = adapt(ctx.firestore());

      const minted = await mintHandoff(
        { uid: ALICE, targetOrigin: ORIGIN, transactionId: transactionIdFor(VERIFIER) },
        {
          db,
          now: () => T0,
          timestamp: (ms) => Timestamp.fromMillis(ms),
          policy: { allowLocalDev: false },
        },
      );
      if (!minted.ok) throw new Error(`expected a mint, got ${minted.reason}`);

      const code = new URL(minted.handoffUrl).hash.split('=')[1];
      const payload = { code, transactionVerifier: VERIFIER, origin: ORIGIN };

      expect(await exchangeHandoff(payload, deps(db))).toMatchObject({ ok: true, uid: ALICE });
      expect(await exchangeHandoff(payload, deps(db))).toEqual({ ok: false, reason: 'replayed' });
    });
  });

  it('rejects the loser when two exchanges race for the same code', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = adapt(ctx.firestore());
      const payload = { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN };

      // Real Firestore transactions, real contention: whichever commits second
      // is aborted, its callback re-runs, and the re-read finds consumedAt set.
      const outcomes = await Promise.all([
        exchangeHandoff(payload, deps(db)),
        exchangeHandoff(payload, deps(db)),
        exchangeHandoff(payload, deps(db)),
      ]);

      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      expect(outcomes.filter((r) => !r.ok)).toEqual([
        { ok: false, reason: 'replayed' },
        { ok: false, reason: 'replayed' },
      ]);
    });
  });

  it('rejects an expired code and leaves it unconsumed', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const raw = ctx.firestore();
      const db = adapt(raw);

      const result = await exchangeHandoff(
        { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
        deps(db, { now: () => T0 + HANDOFF_TTL_MS + 1 }),
      );

      expect(result).toEqual({ ok: false, reason: 'expired' });
      const stored = await getDoc(doc(raw, HANDOFF_PATH));
      expect(stored.data()?.consumedAt).toBeNull();
    });
  });

  it('rejects redemption from the wrong origin and leaves the code redeemable', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = adapt(ctx.firestore());

      expect(
        await exchangeHandoff(
          {
            code: CODE,
            transactionVerifier: VERIFIER,
            origin: 'https://someone-else.fiveacross.app',
          },
          deps(db),
        ),
      ).toEqual({ ok: false, reason: 'origin-mismatch' });

      // The rightful origin can still redeem: a wrong-origin attempt must not be
      // a denial-of-service on the player's own sign-in.
      expect(
        await exchangeHandoff(
          { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
          deps(db),
        ),
      ).toMatchObject({ ok: true, uid: ALICE });
    });
  });

  it('rejects a stolen code presented without the transaction verifier', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = adapt(ctx.firestore());

      expect(
        await exchangeHandoff(
          { code: CODE, transactionVerifier: token('stolen-'), origin: ORIGIN },
          deps(db),
        ),
      ).toEqual({ ok: false, reason: 'transaction-mismatch' });

      // And the real holder is unaffected.
      expect(
        await exchangeHandoff(
          { code: CODE, transactionVerifier: VERIFIER, origin: ORIGIN },
          deps(db),
        ),
      ).toMatchObject({ ok: true, uid: ALICE });
    });
  });

  it('rejects an unregistered target origin at mint time', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = adapt(ctx.firestore());

      // No `hostnames/never-registered...` document exists, which is exactly what
      // "unrecognised slug" means — and the same check is the open-redirect
      // defence, since an attacker's domain can never acquire one.
      expect(
        await mintHandoff(
          {
            uid: ALICE,
            targetOrigin: 'https://never-registered.fiveacross.app',
            transactionId: transactionIdFor(VERIFIER),
          },
          {
            db,
            now: () => T0,
            timestamp: (ms) => Timestamp.fromMillis(ms),
            policy: { allowLocalDev: false },
          },
        ),
      ).toEqual({ ok: false, reason: 'origin-not-allowed' });
    });
  });
});
