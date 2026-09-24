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
  query,
  runTransaction,
  setDoc,
  Timestamp,
  updateDoc,
  where,
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
const APEX = 'vacaybingo.com';
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

/** An armed path-capability deployment record, as `provision` and the two
 *  repair intents require for a capability-bearing source. */
const BARRIER = {
  releaseTag: 'v2026.09.19-path-capability',
  workerVersionId: 'a1b2c3d4-0000-4000-8000-000000000001',
  resolutionCacheSchemaVersion: 4,
  armedAt: '2026-09-19T00:00:00.000Z',
};

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
    // The ledger's `updatedAt` is a Firestore timestamp field, not text: the
    // deployed publisher's Eventarc parser rejects a `stringValue` for it, so
    // a string here would write events that can never reach the edge.
    timestamp: (date: Date) => Timestamp.fromDate(date),
    runTransaction: createTransactionRunner({
      runTransaction: (work: unknown) => runTransaction(db, work as never),
      documentReference: (path: string) => doc(db, path),
      // The archive interlock's completeness check. The client SDK has no
      // transactional query — `Transaction.get` takes a DocumentReference
      // only — so this arm reads the collection beside the transaction, and
      // the operator command's Admin adapter runs the same query inside it
      // with `transaction.get(query)`. Each named host is still point-read
      // inside the transaction, which is what the archive decides on; this
      // listing only has to name a host the operator left out.
      //
      // THIS ARM PROVES THE RULES, NOT THE CONCURRENCY CONTRACT (Codex P2,
      // PR #1245). The client SDK has no transactional query, so the
      // completeness check here is not atomic: an alias provisioned between
      // this `getDocs` and the commit is absent from `hosts`, is never
      // point-read, and stays active while the Event archives — the exact
      // partial archive the check exists to prevent. Production archives do
      // not run through this adapter. They run through the operator
      // command's Admin runner, where the same query is `transaction.get(query)`
      // inside the transaction and a late alias conflicts the commit. This
      // suite exists to drive the emulator's rules against real transactions,
      // which is the one thing a client SDK can establish, and the atomicity
      // claim in `specs/event-router-registry.md` is about the Admin path.
      listEventMappings: async (eventId: string) => {
        const snapshot = await getDocs(query(collection(db, 'hostnames'), where('eventId', '==', eventId)));
        return snapshot.docs.map((entry) => entry.id);
      },
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

/** Writes a hostname document and backfills its ledger, leaving both at revision 1.
 *  Answers the plan, because its projection digest is the evidence a repoint
 *  or a delete needs at that revision. */
async function seedConverged(db: Firestore, host: string, document: Doc): Promise<Doc> {
  await setDoc(doc(db, `hostnames/${host}`), document);
  return (await applyHostnameMutation(
    mutation({
      intent: 'backfill-ledger',
      host,
      // A repair is the FIRST edge publication for a source nothing in the
      // helper wrote, so a capability-bearing one owes the same deployment
      // barrier `provision` requires. A source projecting `pathNamespace:
      // null` needs none and passes nothing.
      ...(document.pathNamespace === undefined || document.pathNamespace === null
        ? {}
        : { pathCapabilityBarrier: BARRIER }),
    }),
    dependencies(db),
  )) as Doc;
}

/**
 * The audit evidence `repoint` and `delete` require: the revision AND the
 * digest the private audit reads back from the Durable Object once it has
 * committed that projection. Taken from the plan the helper itself reported
 * for that revision, which is the value the audit will echo — revision
 * equality alone is satisfied by a poisoned object carrying a different
 * payload, which is why both intents ask for the digest.
 */
const committedDigest = (plan: Doc): string =>
  ((plan.projections as Doc[])[0] as { digest: string }).digest;

async function refusalCode(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
  } catch (error) {
    // Only the helper's own refusal type counts, so a Firestore error that
    // happens to carry a `code` cannot pass for a named refusal.
    if ((error as Error).name !== 'HostnameLifecycleRefusal') throw error;
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
        // Stored as a Firestore timestamp and read back as one.
        updatedAt: Timestamp.fromDate(NOW),
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
      const seeded = await seedConverged(db, HOST, hostnameDocument());
      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({
              intent: 'repoint',
              host: HOST,
              changes: { eventId: 'sonoma-2027' },
              converged: { revision: '1', digest: committedDigest(seeded) },
            }),
            dependencies(db),
          ),
        ),
      ).toBe('repoint-requires-disabled');
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ eventId: EVENT_ID });

      // The disabling revision is written here; the edge has to have
      // COMMITTED it before the identity may move, so the repoint carries the
      // revision and digest the audit reports for it.
      const disabled = (await applyHostnameMutation(
        mutation({ intent: 'update', host: HOST, changes: { status: 'disabled' } }),
        dependencies(db),
      )) as Doc;
      await applyHostnameMutation(
        mutation({
          intent: 'repoint',
          host: HOST,
          changes: { eventId: 'sonoma-2027' },
          converged: { revision: '2', digest: committedDigest(disabled) },
        }),
        dependencies(db),
      );
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
        // Non-projected fields with their own reviewed writers. The mirror-root
        // conversion replaces the whole document, so a real transaction is
        // where "it carries them forward" has to hold.
        adultContent: true,
        canonicalHost: HOST,
        isCanonical: false,
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
      expect(await read(db, `hostnames/${MIRROR}`)).toEqual({
        root: 'not-found',
        edition: 'vacay',
        pathNamespace: 'vacaybingo.com',
        adultContent: true,
        canonicalHost: HOST,
        isCanonical: false,
      });
      expect(await read(db, `routerReplicas/${MIRROR}`)).toMatchObject({ revision: '2', desired: { kind: 'root', root: 'not-found' } });
      expect(await read(db, `events/${EVENT_ID}`)).toMatchObject({ status: 'archived' });
    });
  });

  it('refuses an archive that omits a mapping the hostnames collection still names', async () => {
    // The completeness check is the one read that has to come from the
    // collection rather than from the caller, so a real query against real
    // Firestore is the only place it is actually proved: an in-memory double
    // would be agreeing with itself about what `where('eventId', '==', ...)`
    // returns.
    await trusted(async (db) => {
      await seedConverged(db, HOST, hostnameDocument());
      await seedConverged(db, ALIAS, hostnameDocument({ canonicalHost: HOST, isCanonical: false }));
      await setDoc(doc(db, `events/${EVENT_ID}`), { status: 'active' });

      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({ intent: 'archive', eventId: EVENT_ID, mappings: [HOST], apexPathHost: HOST, mirrorRootConversions: [] }),
            dependencies(db),
          ),
        ),
      ).toBe('archive-mapping-incomplete');
      // The omitted alias would otherwise have kept serving the archived Event.
      expect(await read(db, `hostnames/${ALIAS}`)).toMatchObject({ status: 'active' });
      expect(await read(db, `hostnames/${HOST}`)).toMatchObject({ status: 'active' });
      expect(await read(db, `events/${EVENT_ID}`)).toMatchObject({ status: 'active' });

      // Naming both is accepted, so the refusal is about the omission rather
      // than about the listing failing to see either host.
      await applyHostnameMutation(
        mutation({ intent: 'archive', eventId: EVENT_ID, mappings: [HOST, ALIAS], apexPathHost: HOST, mirrorRootConversions: [] }),
        dependencies(db),
      );
      expect(await read(db, `hostnames/${ALIAS}`)).toMatchObject({ status: 'archived' });
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
      const seeded = await seedConverged(db, HOST, hostnameDocument({ status: 'disabled' }));
      await applyHostnameMutation(
        mutation({
          intent: 'delete',
          host: HOST,
          convergedRevision: '1',
          convergedDigest: committedDigest(seeded),
        }),
        dependencies(db),
      );
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

  it('refuses to tombstone a serving doorway marker and leaves both documents standing', async () => {
    await trusted(async (db) => {
      // A root marker has no `status`, so "reject active delete" has to be
      // about what the host serves: `root: 'doorway'` is the live doorway
      // `specs/path-addressing-and-root.md` § D1 defines, and the tombstone
      // would be permanent.
      const doorway = await seedConverged(db, APEX, { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' });
      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({
              intent: 'delete',
              host: APEX,
              convergedRevision: '1',
              convergedDigest: committedDigest(doorway),
            }),
            dependencies(db),
          ),
        ),
      ).toBe('delete-requires-inactive');
      expect(await read(db, `hostnames/${APEX}`)).toMatchObject({ root: 'doorway' });
      expect(await read(db, `routerReplicas/${APEX}`)).toMatchObject({ revision: '1' });

      // Its non-serving sibling is deletable: retiring the host's remaining
      // path capability is a real operation.
      const marker = (await applyHostnameMutation(
        mutation({ intent: 'update', host: APEX, changes: { root: 'not-found' } }),
        dependencies(db),
      )) as Doc;
      await applyHostnameMutation(
        mutation({
          intent: 'delete',
          host: APEX,
          convergedRevision: '2',
          convergedDigest: committedDigest(marker),
        }),
        dependencies(db),
      );
      expect(await read(db, `hostnames/${APEX}`)).toBeNull();
      expect(await read(db, `routerReplicas/${APEX}`)).toMatchObject({ revision: '3', desired: { kind: 'tombstone' } });
    });
  });

  // #1251: both conversion directions against a real transaction, one revision
  // each. A mirror's going live is the convergence-barriered activation
  // afterwards, which re-proves the replacement home; the doorway conversion
  // is itself the apex's go-live step and carries the deployment barrier.
  it('converts a not-found mirror marker to a replacement flagship proved live at its own host, then activates it separately', async () => {
    await trusted(async (db) => {
      const REPLACEMENT = 'replacement.vacaybingo.com';
      const seeded = await seedConverged(db, MIRROR, {
        root: 'not-found',
        edition: 'vacay',
        pathNamespace: 'vacaybingo.com',
        // The retired flagship's public face, which must not travel.
        adultContent: true,
        canonicalHost: HOST,
        isCanonical: false,
      });
      const flagship = await seedConverged(db, REPLACEMENT, { eventId: 'replacement-2027', edition: 'vacay', status: 'active', slug: 'replacement', pathNamespace: null });
      const proof = { replacementHost: REPLACEMENT, replacementConverged: { revision: '1', digest: committedDigest(flagship) } };
      const convert = mutation({
        intent: 'convert-to-route',
        host: MIRROR,
        eventId: 'replacement-2027',
        ...proof,
        converged: { revision: '1', digest: committedDigest(seeded) },
      });
      expect(await refusalCode(() => applyHostnameMutation(convert, dependencies(db)))).toBe('replacement-event-missing');
      expect(await read(db, `hostnames/${MIRROR}`)).toMatchObject({ root: 'not-found', adultContent: true });
      expect(await read(db, `routerReplicas/${MIRROR}`)).toMatchObject({ revision: '1' });

      await setDoc(doc(db, 'events/replacement-2027'), { status: 'active', admins: ['nathan'] });
      const converted = (await applyHostnameMutation(convert, dependencies(db))) as Doc;
      expect(await read(db, `hostnames/${MIRROR}`)).toEqual({
        eventId: 'replacement-2027',
        slug: 'replacement',
        status: 'disabled',
        edition: 'vacay',
        pathNamespace: 'vacaybingo.com',
      });
      expect(await read(db, `routerReplicas/${MIRROR}`)).toMatchObject({ revision: '2', desired: { kind: 'route', status: 'disabled' } });

      await applyHostnameMutation(
        mutation({ intent: 'update', host: MIRROR, changes: { status: 'active' }, converged: { revision: '2', digest: committedDigest(converted) }, ...proof }),
        dependencies(db),
      );
      expect(await read(db, `routerReplicas/${MIRROR}`)).toMatchObject({ revision: '3', desired: { kind: 'route', status: 'active' } });
    });
  });

  it('converts a disabled, converged apex route to its doorway, and the delete barrier still holds', async () => {
    await trusted(async (db) => {
      const seeded = await seedConverged(db, APEX, hostnameDocument({ edition: 'vacay', pathNamespace: 'vacaybingo.com' }));
      await setDoc(doc(db, `events/${EVENT_ID}`), { status: 'active' });
      const toDoorway = (revision: string, plan: Doc) =>
        mutation({ intent: 'convert-to-root', host: APEX, root: 'doorway', converged: { revision, digest: committedDigest(plan) }, pathCapabilityBarrier: BARRIER });
      expect(await refusalCode(() => applyHostnameMutation(toDoorway('1', seeded), dependencies(db)))).toBe('convert-requires-inactive');
      expect(await read(db, `hostnames/${APEX}`)).toMatchObject({ status: 'active', eventId: EVENT_ID });

      const disabled = (await applyHostnameMutation(
        mutation({ intent: 'update', host: APEX, changes: { status: 'disabled' } }),
        dependencies(db),
      )) as Doc;
      const doorway = (await applyHostnameMutation(toDoorway('2', disabled), dependencies(db))) as Doc;
      expect(await read(db, `hostnames/${APEX}`)).toEqual({
        root: 'doorway',
        edition: 'vacay',
        pathNamespace: 'vacaybingo.com',
        adultContent: false,
        canonicalHost: HOST,
        isCanonical: true,
      });
      expect(await read(db, `routerReplicas/${APEX}`)).toMatchObject({ revision: '3', desired: { kind: 'root', root: 'doorway' } });
      expect(
        await refusalCode(() =>
          applyHostnameMutation(
            mutation({ intent: 'delete', host: APEX, convergedRevision: '3', convergedDigest: committedDigest(doorway) }),
            dependencies(db),
          ),
        ),
      ).toBe('delete-requires-inactive');
    });
  });

  it('refuses a conversion outside its host scope or while a mirror flagship is live, leaving both documents standing', async () => {
    await trusted(async (db) => {
      const doorway = await seedConverged(db, APEX, { root: 'doorway', edition: 'vacay', pathNamespace: 'vacaybingo.com' });
      const gcb = await seedConverged(db, 'gaycruisebingo.com', hostnameDocument({ edition: 'gcb', status: 'disabled', pathNamespace: null }));
      const mirror = await seedConverged(db, MIRROR, hostnameDocument({ edition: 'vacay', status: 'disabled', pathNamespace: 'vacaybingo.com' }));
      await setDoc(doc(db, `events/${EVENT_ID}`), { status: 'active' });
      const cases: Array<[string, Doc, Doc, string]> = [
        [APEX, doorway, { intent: 'convert-to-route', eventId: EVENT_ID, replacementHost: HOST, replacementConverged: { revision: '1', digest: committedDigest(doorway) } }, 'convert-to-route-requires-mirror'],
        ['gaycruisebingo.com', gcb, { intent: 'convert-to-root', root: 'doorway', pathCapabilityBarrier: BARRIER }, 'root-conversion-requires-archive'],
        [MIRROR, mirror, { intent: 'convert-to-root', root: 'not-found' }, 'root-conversion-flagship-live'],
      ];
      for (const [host, plan, input, expected] of cases) {
        const before = await read(db, `hostnames/${host}`);
        expect(
          await refusalCode(() =>
            applyHostnameMutation(
              mutation({ host, converged: { revision: '1', digest: committedDigest(plan) }, ...input }),
              dependencies(db),
            ),
          ),
        ).toBe(expected);
        expect(await read(db, `hostnames/${host}`)).toEqual(before);
        expect(await read(db, `routerReplicas/${host}`)).toMatchObject({ revision: '1' });
      }
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
