/**
 * #971's lifecycle/helper-specific emulator coverage, layered on #970's
 * deny-all `routerReplicas/{host}` and `routerRehearsals/{host}` baseline
 * (proved in `event-router-registry.test.ts`, which this suite does not
 * repeat).
 *
 * Two things can only be proved here rather than in the pure suite beside the
 * module. The first is ATOMICITY: `scripts/event-router-registry/hostname-
 * lifecycle.mjs` claims the canonical hostname document and its private replica
 * ledger move together, and an in-memory double can be made to honour that by
 * construction. A real Firestore transaction cannot — so the refusal arms below
 * run against the emulator and then read both documents back.
 *
 * The second is that the documents the helper writes stay exactly as invisible
 * to a Firebase client as the empty ones were: the trusted path creates real
 * routing state, and "denied" must keep meaning denied once there is something
 * behind the rule.
 */
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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
// The operator module is plain `.mjs` with no build step and no type
// declarations. `tests/` sits outside every tsconfig program (`tsconfig.json`
// includes `src` only), so Vitest resolves this import and `tsc` never sees it.
import { applyHostnameMutation, createTransactionRunner } from '../../scripts/event-router-registry/hostname-lifecycle.mjs';

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const RULES = readFileSync(RULES_PATH, 'utf8');

const HOST = 'bodega-bay.fiveacross.app';
const ALIAS = 'bodega-bay.vacaybingo.com';
const MIRROR = 'vacaybingo.vercel.app';
const SYNTHETIC = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const EVENT_ID = 'bodega-bay-2026';
const NOW = new Date('2026-09-20T12:00:00.000Z');

type Doc = Record<string, unknown>;

const hostnameDocument = (overrides: Doc = {}): Doc => ({
  eventId: EVENT_ID,
  canonicalHost: HOST,
  edition: 'fiveacross',
  status: 'active',
  slug: 'bodega-bay',
  isCanonical: true,
  adultContent: false,
  ...overrides,
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const endpoint = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [host, port] = endpoint.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gcb-hostname-lifecycle',
    firestore: { host, port: Number(port), rules: RULES },
  });
});

beforeEach(async () => testEnv.clearFirestore());

afterAll(async () => testEnv?.cleanup());

/** The Admin-SDK stand-in: the trusted writer bypasses Security Rules. */
async function trusted<T>(work: (db: Firestore) => Promise<T>): Promise<T> {
  let result!: T;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    result = await work(context.firestore() as unknown as Firestore);
  });
  return result;
}

function dependencies(db: Firestore) {
  return {
    now: () => NOW,
    runTransaction: createTransactionRunner({
      runTransaction: (work: unknown) => runTransaction(db, work as never),
      documentReference: (path: string) => doc(db, path),
    }),
  };
}

const mutation = (overrides: Doc): Doc => ({
  schemaVersion: 1,
  apply: true,
  actor: 'nathanjohnpayne',
  reason: 'emulator lifecycle proof',
  ...overrides,
});

async function read(db: Firestore, path: string): Promise<Doc | null> {
  const snapshot = await getDoc(doc(db, path));
  return snapshot.exists() ? (snapshot.data() as Doc) : null;
}

/** Writes a hostname document and backfills its ledger, leaving both at revision 1. */
async function seedConverged(db: Firestore, host: string, document: Doc): Promise<void> {
  await setDoc(doc(db, `hostnames/${host}`), document);
  await applyHostnameMutation(mutation({ intent: 'backfill-ledger', host }), dependencies(db));
}

async function refusalCode(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
  return null;
}

describe('the trusted hostname mutation helper against a real transaction', () => {
  it('writes the canonical document and its replica ledger in one committed transaction', async () => {
    await trusted(async (db) => {
      await applyHostnameMutation(
        mutation({
          intent: 'provision',
          host: HOST,
          hostname: { eventId: EVENT_ID, canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay', isCanonical: true },
        }),
        dependencies(db),
      );
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ status: 'disabled', eventId: EVENT_ID });
      expect(await read(db, `routerReplicas/${HOST}`)).toEqual({
        schemaVersion: 1,
        revision: '1',
        host: HOST,
        desired: { kind: 'route', eventId: EVENT_ID, status: 'disabled', slug: 'bodega-bay', edition: 'fiveacross', pathNamespace: null },
        updatedAt: NOW.toISOString(),
      });
    });
  });

  it('commits nothing at all when a dry run plans the same write', async () => {
    await trusted(async (db) => {
      await applyHostnameMutation(
        mutation({
          intent: 'provision',
          apply: false,
          host: HOST,
          hostname: { eventId: EVENT_ID, canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay' },
        }),
        dependencies(db),
      );
      expect(await read(db, `hostnames/${HOST}`)).toBeNull();
      expect(await read(db, `routerReplicas/${HOST}`)).toBeNull();
    });
  });

  it('refuses both globally reserved classes and every permanent rehearsal reservation, writing neither side', async () => {
    await trusted(async (db) => {
      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({
              intent: 'provision',
              host: SYNTHETIC,
              hostname: { eventId: 'e', edition: 'fiveacross', slug: SYNTHETIC.split('.')[0] },
            }),
            dependencies(db),
          ),
        ),
      ).toBe('reserved-class');
      expect(await read(db, `hostnames/${SYNTHETIC}`)).toBeNull();
      expect(await read(db, `routerReplicas/${SYNTHETIC}`)).toBeNull();

      await setDoc(doc(db, `routerRehearsals/${HOST}`), { class: 'route', reservedAt: 1 });
      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({
              intent: 'provision',
              host: HOST,
              hostname: { eventId: EVENT_ID, canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay' },
            }),
            dependencies(db),
          ),
        ),
      ).toBe('rehearsal-reservation');
      expect(await read(db, `hostnames/${HOST}`)).toBeNull();
      expect(await read(db, `routerReplicas/${HOST}`)).toBeNull();
    });
  });

  it('spends one revision on a status change and none on the non-projected adultContent derivation', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      await applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { adultContent: true } }), dependencies(db));
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '1' });
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ adultContent: true });

      await applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), dependencies(db));
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '2', desired: { status: 'disabled' } });
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ status: 'disabled', adultContent: true });
    });
  });

  it('repoints only behind the disabled barrier and keeps the projection equal to the source', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      expect(
        await refusalCode(() =>
          applyHostnameMutation(mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' } }), dependencies(db)),
        ),
      ).toBe('repoint-requires-disabled');
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ eventId: EVENT_ID });

      await applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), dependencies(db));
      await applyHostnameMutation(mutation({ intent: 'repoint', host: HOST, changes: { eventId: 'sonoma-2027' } }), dependencies(db));
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ eventId: 'sonoma-2027' });
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '3', desired: { eventId: 'sonoma-2027' } });
    });
  });

  it('archives every mapping, the mirror root marker and the Event document in one transaction', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      await seedConverged(db, ALIAS, hostnameDocument({ canonicalHost: HOST, isCanonical: false }));
      await seedConverged(db, MIRROR, {
        eventId: EVENT_ID,
        edition: 'vacay',
        status: 'active',
        slug: 'bodega-bay',
        pathNamespace: 'vacaybingo.com',
      });
      await setDoc(doc(db, `events/${EVENT_ID}`), { status: 'active', admins: ['nathan'] });

      await applyHostnameMutation(
        mutation({
          intent: 'archive',
          eventId: EVENT_ID,
          mappings: [HOST, ALIAS],
          apexPathHost: HOST,
          mirrorRootConversions: [{ host: MIRROR, root: 'not-found' }],
        }),
        dependencies(db),
      );

      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ status: 'archived', apexPath: true });
      expect(await read(db, `hostnames/${ALIAS}`)).toMatchObject({ status: 'archived' });
      expect(await read(db, `hostnames/${MIRROR}`)).toEqual({ root: 'not-found', edition: 'vacay', pathNamespace: 'vacaybingo.com' });
      expect(await read(db, `routerReplicas/${MIRROR}`)).toMatchObject({ revision: '2', desired: { kind: 'root', root: 'not-found' } });
      expect(await read(db, `events/${EVENT_ID}`)).toMatchObject({ status: 'archived' });
    });
  });

  it('leaves every document untouched when one mapping in the archive is ineligible', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      await seedConverged(db, ALIAS, hostnameDocument({ canonicalHost: HOST, isCanonical: false, status: 'disabled' }));
      await setDoc(doc(db, `events/${EVENT_ID}`), { status: 'active' });

      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({ intent: 'archive', eventId: EVENT_ID, mappings: [HOST, ALIAS], apexPathHost: HOST, mirrorRootConversions: [] }),
            dependencies(db),
          ),
        ),
      ).toBe('archive-requires-active');
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ status: 'active' });
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '1' });
      expect(await read(db, `events/${EVENT_ID}`)).toMatchObject({ status: 'active' });
    });
  });

  it('deletes the source and leaves a permanent tombstone the address cannot be reclaimed from', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument({ status: 'disabled' }));
      await applyHostnameMutation(mutation({ intent: 'delete', host: HOST, convergedRevision: '1' }), dependencies(db));
      expect(await read(db, `hostnames/${HOST}`)).toBeNull();
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '2', desired: { kind: 'tombstone' } });

      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({ intent: 'provision', host: HOST, hostname: { eventId: 'new-2027', canonicalHost: HOST, edition: 'fiveacross', slug: 'bodega-bay' } }),
            dependencies(db),
          ),
        ),
      ).toBe('tombstoned-address');
    });
  });

  it('advances a source-behind ledger above the edge high-water mark without touching the public document', async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      const before = await read(db, `hostnames/${HOST}`);
      // A direct partial write is the contract violation the audit catches; the
      // explicit Admin advance is the only repair, and every ordinary intent
      // refuses the drifted pair until it has run.
      await setDoc(doc(db, `routerReplicas/${HOST}`), {
        schemaVersion: 1,
        revision: '1',
        host: HOST,
        desired: { kind: 'route' },
        updatedAt: NOW.toISOString(),
      });
      expect(
        await refusalCode(() =>
          applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), dependencies(db)),
        ),
      ).toBe('malformed-ledger');

      await applyHostnameMutation(
        mutation({
          intent: 'advance-ledger',
          host: HOST,
          durableObjectHighWaterRevision: '11',
          incidentUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/971',
        }),
        dependencies(db),
      );
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({
        revision: '12',
        desired: { kind: 'route', eventId: EVENT_ID, status: 'active' },
      });
      expect(await read(db, `hostnames/${HOST}`)).toEqual(before);

      // Repair-then-reattest: the pair is admissible again from a fresh read.
      await applyHostnameMutation(mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }), dependencies(db));
      expect(await read(db, `routerReplicas/${HOST}`)).toMatchObject({ revision: '13' });
    });
  });
});

describe('what a Firebase client may see once the helper has written real routing state', () => {
  beforeEach(async () => {
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      await setDoc(doc(db, `routerRehearsals/${SYNTHETIC}`), { class: 'route', reservedAt: 1 });
      await setDoc(doc(db, `events/${EVENT_ID}`), { admins: ['admin'] });
    });
  });

  it.each(['anonymous', 'player', 'event admin'])('%s still gets the hostname document and nothing more', async (actor) => {
    const db = (
      actor === 'anonymous'
        ? testEnv.unauthenticatedContext().firestore()
        : testEnv.authenticatedContext(actor === 'event admin' ? 'admin' : 'player').firestore()
    ) as unknown as Firestore;
    await assertSucceeds(getDoc(doc(db, `hostnames/${HOST}`)));
    await assertFails(getDocs(collection(db, 'hostnames')));
    await assertFails(getDoc(doc(db, `routerReplicas/${HOST}`)));
    await assertFails(getDocs(collection(db, 'routerReplicas')));
    await assertFails(getDoc(doc(db, `routerRehearsals/${SYNTHETIC}`)));
  });

  it.each(['anonymous', 'player', 'event admin'])('%s cannot write any side of the lifecycle', async (actor) => {
    const db = (
      actor === 'anonymous'
        ? testEnv.unauthenticatedContext().firestore()
        : testEnv.authenticatedContext(actor === 'event admin' ? 'admin' : 'player').firestore()
    ) as unknown as Firestore;
    await assertFails(updateDoc(doc(db, `hostnames/${HOST}`), { status: 'active' }));
    await assertFails(deleteDoc(doc(db, `hostnames/${HOST}`)));
    await assertFails(setDoc(doc(db, `hostnames/forged.fiveacross.app`), { eventId: 'x' }));
    await assertFails(updateDoc(doc(db, `routerReplicas/${HOST}`), { revision: '99' }));
    await assertFails(setDoc(doc(db, `routerReplicas/forged.fiveacross.app`), { schemaVersion: 1 }));
    await assertFails(deleteDoc(doc(db, `routerReplicas/${HOST}`)));
    await assertFails(setDoc(doc(db, `routerRehearsals/${SYNTHETIC}`), { class: 'root' }));
  });
});
