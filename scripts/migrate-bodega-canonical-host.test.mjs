// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertReviewedDeployCredential,
  assertReviewedMainCheckout,
  BODEGA_EVENT_ID,
  BODEGA_HOSTS,
  CANONICAL_HOST,
  executeCanonicalHostMigration,
  LEGACY_HOST,
  planCanonicalHostMigration,
} from './migrate-bodega-canonical-host.mjs';
import { selectFirestoreCredential } from './seed.mjs';

const reviewedDeployEnvironment = () => ({
  GOOGLE_APPLICATION_CREDENTIALS: '/tmp/fiveacross-firebase-deployer.json',
  OP_PREFLIGHT_FIREBASE_SA_TMPFILE: '/tmp/fiveacross-firebase-deployer.json',
  OP_PREFLIGHT_FIREBASE_PROJECT: 'fiveacross',
});

const canonicalDocuments = () => [
  {
    host: CANONICAL_HOST,
    data: {
      eventId: BODEGA_EVENT_ID,
      status: 'active',
      edition: 'vacay',
      canonicalHost: CANONICAL_HOST,
      isCanonical: true,
      preview: { eventName: 'Weekend in Bodega Bay' },
    },
  },
  {
    host: LEGACY_HOST,
    data: {
      eventId: BODEGA_EVENT_ID,
      status: 'active',
      edition: 'vacay',
      canonicalHost: CANONICAL_HOST,
      isCanonical: false,
      preview: { eventName: 'Weekend in Bodega Bay' },
    },
  },
  {
    host: 'fiveacross.app',
    data: {
      eventId: BODEGA_EVENT_ID,
      status: 'active',
      edition: 'fiveacross',
      canonicalHost: CANONICAL_HOST,
      isCanonical: false,
      preview: { eventName: 'Weekend in Bodega Bay' },
    },
  },
];

const withLegacyDrift = () =>
  canonicalDocuments().map((row) =>
    row.host === LEGACY_HOST
      ? {
          ...row,
          data: { ...row.data, canonicalHost: LEGACY_HOST, isCanonical: true },
        }
      : row,
  );

const replace = (rows, host, patch) =>
  rows.map((row) => (row.host === host ? { ...row, data: { ...row.data, ...patch } } : row));

const snapshotsFor = (rows) =>
  BODEGA_HOSTS.map((host) => {
    const row = rows.find((candidate) => candidate.host === host);
    return {
      exists: row !== undefined,
      data: () => row?.data,
    };
  });

function executionFixture({
  initialRows = withLegacyDrift(),
  transactionAttempts = [withLegacyDrift()],
  readbackRows = canonicalDocuments(),
} = {}) {
  const refs = BODEGA_HOSTS.map((host) => ({ path: `hostnames/${host}` }));
  const transactions = [];
  const db = {
    doc: vi.fn((path) => refs.find((ref) => ref.path === path)),
    getAll: vi
      .fn()
      .mockResolvedValueOnce(snapshotsFor(initialRows))
      .mockResolvedValueOnce(snapshotsFor(readbackRows)),
    runTransaction: vi.fn(async (callback) => {
      let result;
      for (const rows of transactionAttempts) {
        const transaction = {
          get: vi.fn(async (ref) => {
            const host = ref.path.slice('hostnames/'.length);
            const row = rows.find((candidate) => candidate.host === host);
            return { exists: row !== undefined, data: () => row?.data };
          }),
          update: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
        };
        transactions.push(transaction);
        result = await callback(transaction);
      }
      return result;
    }),
  };
  const initializeFirestore = vi.fn(async () => ({
    db,
    projectId: 'fiveacross',
    EVENT_ID: BODEGA_EVENT_ID,
  }));
  return { db, initializeFirestore, refs, transactions };
}

describe('Bodega canonical-host migration plan', () => {
  it('keeps normative analytics examples on the migrated canonical host', () => {
    const pathAddressingSpec = readFileSync(
      new URL('../specs/path-addressing-and-root.md', import.meta.url),
      'utf8',
    );

    expect(pathAddressingSpec).toContain(
      'reports `https://bodega-bay.fiveacross.app/feed`',
    );
    expect(pathAddressingSpec).toContain(
      'becomes `bodega-bay.fiveacross.app/feed`',
    );
  });

  it('pins the complete serving inventory and exact two-field correction', () => {
    expect(BODEGA_HOSTS).toEqual([CANONICAL_HOST, LEGACY_HOST, 'fiveacross.app']);

    const plan = planCanonicalHostMigration(withLegacyDrift());

    expect(plan).toEqual({
      changed: true,
      host: LEGACY_HOST,
      update: { canonicalHost: CANONICAL_HOST, isCanonical: false },
      before: { canonicalHost: LEGACY_HOST, isCanonical: true },
      after: { canonicalHost: CANONICAL_HOST, isCanonical: false },
    });
  });

  it('is idempotent once the legacy host is an alias of the new canonical host', () => {
    expect(planCanonicalHostMigration(canonicalDocuments())).toMatchObject({
      changed: false,
      update: null,
      before: { canonicalHost: CANONICAL_HOST, isCanonical: false },
    });
  });

  it('does not mutate ride-along document data while planning', () => {
    const rows = withLegacyDrift();
    const before = structuredClone(rows);

    planCanonicalHostMigration(rows);

    expect(rows).toEqual(before);
  });

  it.each(BODEGA_HOSTS)('refuses a missing serving document: %s', (host) => {
    const rows = withLegacyDrift().filter((row) => row.host !== host);
    expect(() => planCanonicalHostMigration(rows)).toThrow(`hostnames/${host} is missing`);
  });

  it('refuses duplicate reads rather than choosing one value', () => {
    const rows = withLegacyDrift();
    expect(() => planCanonicalHostMigration([...rows, rows[0]])).toThrow(/duplicate hostname read/);
  });

  it.each([
    ['eventId', 'another-event', /targets another-event/],
    ['status', 'disabled', /is disabled/],
  ])('refuses a %s drift on any serving document', (field, value, message) => {
    const rows = replace(withLegacyDrift(), 'fiveacross.app', { [field]: value });
    expect(() => planCanonicalHostMigration(rows)).toThrow(message);
  });

  it.each([
    [CANONICAL_HOST, 'fiveacross', /expected vacay/],
    [LEGACY_HOST, 'fiveacross', /expected vacay/],
    ['fiveacross.app', 'vacay', /expected fiveacross/],
  ])('refuses Edition drift on %s', (host, edition, message) => {
    const rows = replace(withLegacyDrift(), host, { edition });
    expect(() => planCanonicalHostMigration(rows)).toThrow(message);
  });

  it.each([
    [CANONICAL_HOST, { canonicalHost: LEGACY_HOST }, /canonical document metadata drifted/],
    [CANONICAL_HOST, { isCanonical: false }, /canonical document metadata drifted/],
    ['fiveacross.app', { canonicalHost: LEGACY_HOST }, /alias metadata drifted/],
    ['fiveacross.app', { isCanonical: true }, /alias metadata drifted/],
  ])('refuses unrelated canonical metadata drift on %s', (host, patch, message) => {
    expect(() => planCanonicalHostMigration(replace(withLegacyDrift(), host, patch))).toThrow(message);
  });

  it.each([
    [{ canonicalHost: 'unexpected.example', isCanonical: true }, /unrecognised canonical metadata/],
    [{ canonicalHost: LEGACY_HOST, isCanonical: false }, /partial canonical metadata/],
    [{ canonicalHost: CANONICAL_HOST, isCanonical: true }, /partial canonical metadata/],
  ])('refuses an unsafe legacy-host state %#', (patch, message) => {
    expect(() => planCanonicalHostMigration(replace(withLegacyDrift(), LEGACY_HOST, patch))).toThrow(message);
  });
});

describe('Bodega canonical-host migration execution', () => {
  it('ignores a present repo-root key when local service accounts are disabled', () => {
    const localKeyExists = vi.fn(() => true);
    const readLocalKey = vi.fn(() => JSON.stringify({ type: 'service_account' }));
    const certificate = vi.fn(() => ({ source: 'local-key' }));
    const applicationDefaultCredential = vi.fn(() => ({ source: 'reviewed-preflight' }));

    expect(
      selectFirestoreCredential({
        allowLocalServiceAccountKey: false,
        keyUrl: new URL('file:///repo/serviceAccountKey.json'),
        localKeyExists,
        readLocalKey,
        certificate,
        applicationDefaultCredential,
      }),
    ).toEqual({ source: 'reviewed-preflight' });
    expect(localKeyExists).not.toHaveBeenCalled();
    expect(readLocalKey).not.toHaveBeenCalled();
    expect(certificate).not.toHaveBeenCalled();
    expect(applicationDefaultCredential).toHaveBeenCalledOnce();
  });

  it('preserves the shared initializer default for existing seed callers', () => {
    const keyUrl = new URL('file:///repo/serviceAccountKey.json');
    const localKeyExists = vi.fn(() => true);
    const readLocalKey = vi.fn(() => JSON.stringify({ type: 'service_account' }));
    const certificate = vi.fn(() => ({ source: 'local-key' }));
    const applicationDefaultCredential = vi.fn(() => ({ source: 'adc' }));

    expect(
      selectFirestoreCredential({
        keyUrl,
        localKeyExists,
        readLocalKey,
        certificate,
        applicationDefaultCredential,
      }),
    ).toEqual({ source: 'local-key' });
    expect(localKeyExists).toHaveBeenCalledWith(keyUrl);
    expect(readLocalKey).toHaveBeenCalledWith(keyUrl, 'utf8');
    expect(certificate).toHaveBeenCalledWith({ type: 'service_account' });
    expect(applicationDefaultCredential).not.toHaveBeenCalled();
  });

  it('accepts only the exact Five Across deployer service-account identity', () => {
    const credential = {
      type: 'service_account',
      project_id: 'fiveacross',
      client_email: 'firebase-deployer@fiveacross.iam.gserviceaccount.com',
    };
    const readCredential = vi.fn(() => JSON.stringify(credential));

    expect(
      assertReviewedDeployCredential({
        environment: reviewedDeployEnvironment(),
        readCredential,
      }),
    ).toBe('/tmp/fiveacross-firebase-deployer.json');
    expect(readCredential).toHaveBeenCalledWith('/tmp/fiveacross-firebase-deployer.json', 'utf8');
  });

  it.each([
    ['invalid JSON', '{'],
    [
      'ambient user ADC',
      JSON.stringify({
        type: 'authorized_user',
        project_id: 'fiveacross',
        client_email: 'firebase-deployer@fiveacross.iam.gserviceaccount.com',
      }),
    ],
    [
      'another Firebase project',
      JSON.stringify({
        type: 'service_account',
        project_id: 'gaycruisebingo',
        client_email: 'firebase-deployer@gaycruisebingo.iam.gserviceaccount.com',
      }),
    ],
    [
      'another service account',
      JSON.stringify({
        type: 'service_account',
        project_id: 'fiveacross',
        client_email: 'different@fiveacross.iam.gserviceaccount.com',
      }),
    ],
  ])('refuses %s as an apply credential', (_label, rawCredential) => {
    expect(() =>
      assertReviewedDeployCredential({
        environment: reviewedDeployEnvironment(),
        readCredential: () => rawCredential,
      }),
    ).toThrow('exact Five Across deploy preflight credential');
  });

  it.each([
    ["current branch is 'codex/unreviewed', not 'main'"],
    ['local main does not exactly match origin/main'],
    ['working tree is dirty'],
  ])('propagates a strict reviewed-main refusal without impossible bypass advice: %s', (reason) => {
    const runGuard = vi.fn(() => ({
      status: 1,
      stderr: `Refusing to deploy: ${reason}.\n\nTo override branch and freshness checks: command --force\nTo override the clean-tree check: DEPLOY_ALLOW_DIRTY=1 command`,
    }));

    let caught;
    try {
      assertReviewedMainCheckout({
        cwd: '/repo',
        runGuard,
        environment: { PATH: '/bin' },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain(reason);
    expect(caught.message).not.toContain('--force');
    expect(caught.message).not.toContain('DEPLOY_ALLOW_DIRTY');
    expect(runGuard).toHaveBeenCalledOnce();
    expect(runGuard.mock.calls[0][1][1]).toContain('guard_deploy_main_checkout "$3" false');
    expect(runGuard.mock.calls[0][2].env).toMatchObject({ DEPLOY_ALLOW_DIRTY: '0' });
  });

  it('refuses apply before initializing Firestore when reviewed-main proof fails', async () => {
    const initializeFirestore = vi.fn();

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore,
        verifyReviewedSource: () => {
          throw new Error('unreviewed source');
        },
        environment: {},
      }),
    ).rejects.toThrow('unreviewed source');

    expect(initializeFirestore).not.toHaveBeenCalled();
  });

  it('refuses apply without the exact Five Across deploy-preflight credential before Firestore init', async () => {
    const initializeFirestore = vi.fn();

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore,
        verifyReviewedSource: vi.fn(),
        environment: {},
      }),
    ).rejects.toThrow('Five Across deploy preflight');

    expect(initializeFirestore).not.toHaveBeenCalled();
  });

  it('keeps dry-run read-only while reporting the exact planned correction', async () => {
    const fixture = executionFixture();
    const verifyReviewedSource = vi.fn();
    const log = vi.fn();
    const environment = {};

    await expect(
      executeCanonicalHostMigration({
        apply: false,
        initializeFirestore: fixture.initializeFirestore,
        verifyReviewedSource,
        environment,
        log,
      }),
    ).resolves.toEqual({ changed: true, wrote: false });

    expect(verifyReviewedSource).not.toHaveBeenCalled();
    expect(environment).toEqual({
      GOOGLE_CLOUD_PROJECT: 'fiveacross',
      VITE_EVENT_ID: BODEGA_EVENT_ID,
    });
    expect(fixture.db.getAll).toHaveBeenCalledOnce();
    expect(fixture.db.runTransaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('canonicalHost: bodega-bay.vacaybingo.com -> bodega-bay.fiveacross.app'));
  });

  it('revalidates transactionally and updates only the two legacy-host fields', async () => {
    const fixture = executionFixture();
    const verifyReviewedSource = vi.fn();

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore: fixture.initializeFirestore,
        verifyReviewedSource,
        verifyReviewedCredential: vi.fn(),
        environment: {},
        log: vi.fn(),
      }),
    ).resolves.toEqual({ changed: true, wrote: true });

    expect(verifyReviewedSource).toHaveBeenCalledOnce();
    expect(fixture.initializeFirestore).toHaveBeenCalledWith({
      allowLocalServiceAccountKey: false,
    });
    expect(fixture.db.getAll).toHaveBeenCalledTimes(2);
    expect(fixture.db.runTransaction).toHaveBeenCalledOnce();
    const transaction = fixture.transactions[0];
    expect(transaction.get).toHaveBeenCalledTimes(3);
    expect(transaction.update).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledWith(fixture.refs[1], {
      canonicalHost: CANONICAL_HOST,
      isCanonical: false,
    });
    expect(transaction.set).not.toHaveBeenCalled();
    expect(transaction.delete).not.toHaveBeenCalled();
  });

  it('fails a changed transactional revalidation without writing', async () => {
    const driftedAttempt = replace(withLegacyDrift(), 'fiveacross.app', { edition: 'vacay' });
    const fixture = executionFixture({ transactionAttempts: [driftedAttempt] });

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore: fixture.initializeFirestore,
        verifyReviewedSource: vi.fn(),
        verifyReviewedCredential: vi.fn(),
        environment: {},
        log: vi.fn(),
      }),
    ).rejects.toThrow('expected fiveacross');

    expect(fixture.transactions[0].update).not.toHaveBeenCalled();
  });

  it('handles a transaction retry that observes another writer already converged', async () => {
    const fixture = executionFixture({
      transactionAttempts: [withLegacyDrift(), canonicalDocuments()],
    });
    const log = vi.fn();

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore: fixture.initializeFirestore,
        verifyReviewedSource: vi.fn(),
        verifyReviewedCredential: vi.fn(),
        environment: {},
        log,
      }),
    ).resolves.toEqual({ changed: true, wrote: false });

    expect(fixture.transactions).toHaveLength(2);
    expect(fixture.transactions[0].update).toHaveBeenCalledOnce();
    expect(fixture.transactions[1].update).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('another writer corrected'));
  });

  it('fails closed when the post-write readback has not converged', async () => {
    const fixture = executionFixture({ readbackRows: withLegacyDrift() });

    await expect(
      executeCanonicalHostMigration({
        apply: true,
        initializeFirestore: fixture.initializeFirestore,
        verifyReviewedSource: vi.fn(),
        verifyReviewedCredential: vi.fn(),
        environment: {},
        log: vi.fn(),
      }),
    ).rejects.toThrow('post-commit readback did not converge');
  });
});
