/**
 * `hostname-projection.mjs` and `recovery-controller.mjs` each derive the
 * canonical `hostnames/{host}` → replica projection, and they are MIRRORS, not
 * independent policies — the same relationship `src/slug.test.ts` records for
 * the reserved-label set and the rehearsal classes, and the same drift hazard.
 *
 * They are not merged into one function because they are not one function:
 * #970's controller validates a RECEIPT for a synthetic host it will attest,
 * refusing every real hostname at its boundary, while #971's module derives a
 * projection it is about to WRITE for a real one. Their overlap is the
 * synthetic host classes, and this suite pins them there.
 *
 * The check is behavioural rather than textual, and it is deliberately a
 * ROUND TRIP: each fixture's ledger is built from THIS module's derivation and
 * then handed to the recovery controller, which refuses `source-ledger-drift`
 * unless its own derivation reproduces the same bytes. The returned digest is
 * compared against `projectionDigest` for the same reason — one canonicalizer
 * is a contract, not a coincidence.
 *
 * The last suite here pins a third program against the same round trip: the
 * DEPLOYED publisher. `router-publisher/src/runtime.ts` is what actually reads
 * a `routerReplicas/{host}` write off Eventarc and sends it to the edge, so a
 * ledger document this repository can write but that parser refuses is a
 * document the edge can never converge on — and nothing else in the suite
 * would notice, because every other reader here is one of ours.
 */
import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { RecoveryControllerRefusal, buildRecoveryArtifacts } from './recovery-controller.mjs';
import { REGISTRY_R0_CONTRACT } from './r0-contract.mjs';
import { applyHostnameMutation } from './hostname-lifecycle.mjs';
import { replicaPayloadFromFirestoreEvent } from '../../router-publisher/src/runtime.ts';
import { SYNC_MAX_BYTES } from '../../worker/src/registry/contracts.ts';
import {
  HostnameProjectionRefusal,
  LEDGER_MAX_BYTES,
  buildLedgerDocument,
  cloneDocumentValue,
  deriveCanonicalProjection,
  projectionDigest,
} from './hostname-projection.mjs';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const ROOT_HOST = 'r2-root-abcdefghijklmnopqrst.fiveacross.app';
const LABEL = HOST.split('.')[0];
const READ_AT = '2026-08-19T12:00:00.000Z';
const ISSUED_AT = '2026-08-19T12:00:30.000Z';
const REVISION = '7';

const QUARANTINED_SUB = '109876543210987654321';
const REPLACEMENT_SUB = '109876543210987654322';
const QUARANTINED_EMAIL = 'router-publisher-old@fiveacross.iam.gserviceaccount.com';
const REPLACEMENT_EMAIL = 'router-publisher-next@fiveacross.iam.gserviceaccount.com';
const OLD_FUNCTION =
  '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publishRouterReplicaDesired';
const NEXT_FUNCTION =
  '//cloudfunctions.googleapis.com/projects/fiveacross/locations/us-central1/functions/publishRouterReplicaDesiredNext';
const OLD_KEY = 'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/router-publisher-old';
const NEXT_KEY = 'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/router-publisher-next';
const OLD_VERSION = `${OLD_KEY}/cryptoKeyVersions/1`;
const NEXT_VERSION = `${NEXT_KEY}/cryptoKeyVersions/1`;
const NEXT_VERSION_FULL = `//cloudkms.googleapis.com/${NEXT_VERSION}`;
const NEXT_ACCOUNT_FULL = `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${REPLACEMENT_EMAIL}`;
const NEXT_MEMBER = `serviceAccount:${REPLACEMENT_EMAIL}`;
const OLD_FINGERPRINT = '1'.repeat(64);
const NEXT_FINGERPRINT = '2'.repeat(64);
const REGISTRY_DIGEST = '3'.repeat(64);
const ATTESTOR_SUB = '109876543210987654399';
const ATTESTOR_KEY = 'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/source-attestor/cryptoKeyVersions/1';
const ATTESTOR_FINGERPRINT = '4'.repeat(64);
const ATTESTOR_AUDIENCE = REGISTRY_R0_CONTRACT.identities.find(({ role }) => role === 'source-attestor').audience;

const MAPPINGS = [
  { epoch: '7', subject: QUARANTINED_SUB, keyVersion: OLD_VERSION, algorithm: 'RSA_SIGN_PKCS1_2048_SHA256', spkiSha256: OLD_FINGERPRINT },
  { epoch: '8', subject: REPLACEMENT_SUB, keyVersion: NEXT_VERSION, algorithm: 'RSA_SIGN_PKCS1_2048_SHA256', spkiSha256: NEXT_FINGERPRINT },
];

const replacementPlan = () => ({
  quarantinedEpochCeiling: '7',
  nextPublisherEpoch: '8',
  registryConfigDigest: REGISTRY_DIGEST,
  quarantined: {
    oidcSubject: QUARANTINED_SUB,
    serviceAccountEmail: QUARANTINED_EMAIL,
    functionFullResourceName: OLD_FUNCTION,
    functionRevision: 'publisher-old-00007-abc',
    cryptoKey: OLD_KEY,
    keyVersion: OLD_VERSION,
    keyFingerprint: OLD_FINGERPRINT,
  },
  replacement: {
    oidcSubject: REPLACEMENT_SUB,
    serviceAccountEmail: REPLACEMENT_EMAIL,
    functionFullResourceName: NEXT_FUNCTION,
    functionRevision: 'publisher-next-00001-def',
    cryptoKey: NEXT_KEY,
    keyVersion: NEXT_VERSION,
    keyFingerprint: NEXT_FINGERPRINT,
  },
  activeEpochMappings: MAPPINGS,
});

const controlReadbacks = () => ({
  observedAt: READ_AT,
  functions: [
    { fullResourceName: OLD_FUNCTION, serviceAccountEmail: QUARANTINED_EMAIL, oidcSubject: QUARANTINED_SUB, functionRevision: 'publisher-old-00007-abc', responseDigest: '6'.repeat(64) },
    { fullResourceName: NEXT_FUNCTION, serviceAccountEmail: REPLACEMENT_EMAIL, oidcSubject: REPLACEMENT_SUB, functionRevision: 'publisher-next-00001-def', responseDigest: '7'.repeat(64) },
  ],
  keyAccess: [
    { cryptoKey: OLD_KEY, policyEtag: 'old-etag', signMembers: [], enabledVersions: [{ keyVersion: OLD_VERSION, algorithm: 'RSA_SIGN_PKCS1_2048_SHA256', spkiSha256: OLD_FINGERPRINT }], responseDigest: '8'.repeat(64) },
    { cryptoKey: NEXT_KEY, policyEtag: 'next-etag', signMembers: [NEXT_MEMBER], enabledVersions: [{ keyVersion: NEXT_VERSION, algorithm: 'RSA_SIGN_PKCS1_2048_SHA256', spkiSha256: NEXT_FINGERPRINT }], responseDigest: '9'.repeat(64) },
  ],
  serviceAccountAccess: [
    { fullResourceName: `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${QUARANTINED_EMAIL}`, serviceAccountEmail: QUARANTINED_EMAIL, oidcSubject: QUARANTINED_SUB, policyEtag: 'old-sa-etag', tokenCreatorMembers: [], responseDigest: 'a'.repeat(64) },
    { fullResourceName: NEXT_ACCOUNT_FULL, serviceAccountEmail: REPLACEMENT_EMAIL, oidcSubject: REPLACEMENT_SUB, policyEtag: 'next-sa-etag', tokenCreatorMembers: [], responseDigest: 'b'.repeat(64) },
  ],
  activeRegistry: { configDigest: REGISTRY_DIGEST, mappings: MAPPINGS },
  accessDecisions: [
    { principalEmail: QUARANTINED_EMAIL, fullResourceName: NEXT_VERSION_FULL, permission: 'cloudkms.cryptoKeyVersions.useToSign', requestTime: READ_AT, overallAccessState: 'CANNOT_ACCESS', inheritedPoliciesComplete: true, responseDigest: 'c'.repeat(64) },
    { principalEmail: QUARANTINED_EMAIL, fullResourceName: NEXT_ACCOUNT_FULL, permission: 'iam.serviceAccounts.getOpenIdToken', requestTime: READ_AT, overallAccessState: 'CANNOT_ACCESS', inheritedPoliciesComplete: true, responseDigest: 'd'.repeat(64) },
    { principalEmail: QUARANTINED_EMAIL, fullResourceName: NEXT_ACCOUNT_FULL, permission: 'iam.serviceAccounts.getAccessToken', requestTime: READ_AT, overallAccessState: 'CANNOT_ACCESS', inheritedPoliciesComplete: true, responseDigest: 'e'.repeat(64) },
  ],
});

function dependencies(host, hostname, routerReplica) {
  return {
    now: vi
      .fn()
      .mockImplementationOnce(() => new Date('2026-08-19T12:00:20.000Z'))
      .mockImplementation(() => new Date(ISSUED_AT)),
    readSourceTransaction: vi.fn(async () => ({
      atomic: true,
      readAt: READ_AT,
      hostnamePath: `hostnames/${host}`,
      ledgerPath: `routerReplicas/${host}`,
      hostname,
      routerReplica,
    })),
    readPublisherControlReadbacks: vi.fn(async () => controlReadbacks()),
    obtainSourceAttestorSession: vi.fn(async () => ({
      oidcToken: 'header.payload.signature',
      credentialSource: 'interactive-human-impersonation',
      tokenIssuedAt: '2026-08-19T12:00:25.000Z',
      tokenExpiresAt: '2026-08-19T12:15:25.000Z',
      audience: ATTESTOR_AUDIENCE,
      oidcSubject: ATTESTOR_SUB,
      keyVersion: ATTESTOR_KEY,
      keyFingerprint: ATTESTOR_FINGERPRINT,
      sign: vi.fn(async () => Buffer.from('parity-signature').toString('base64')),
    })),
  };
}

const recoveryInput = (host) => ({
  schemaVersion: 1,
  host,
  expectedCommitted: { revision: REVISION, digest: '5'.repeat(64) },
  lockId: 'lock-971',
  incidentUrl: 'https://github.com/nathanjohnpayne/fiveacross/issues/971',
  reason: 'Parity fixture: derive the canonical projection for one host.',
  sourceAttestor: {
    audience: ATTESTOR_AUDIENCE,
    oidcSubject: ATTESTOR_SUB,
    keyVersion: ATTESTOR_KEY,
    keyFingerprint: ATTESTOR_FINGERPRINT,
  },
  publisherReplacement: replacementPlan(),
});

/**
 * Hostname documents both programs must read the same way, over every arm the
 * synthetic classes can reach: each status of a route, both root markers, and
 * the absent document that derives a tombstone.
 */
const FIXTURES = [
  ['an active synthetic route', HOST, { eventId: 'synthetic-event', canonicalHost: HOST, edition: 'fiveacross', status: 'active', slug: LABEL, pathNamespace: null, isCanonical: true, adultContent: false }],
  ['a disabled synthetic route', HOST, { eventId: 'synthetic-event', edition: 'vacay', status: 'disabled', slug: LABEL, pathNamespace: null }],
  ['an archived synthetic route', HOST, { eventId: 'synthetic-event', edition: 'gcb', status: 'archived', slug: LABEL, pathNamespace: null }],
  ['a synthetic doorway root', ROOT_HOST, { root: 'doorway', edition: 'fiveacross', pathNamespace: null }],
  ['a synthetic not-found root', ROOT_HOST, { root: 'not-found', edition: 'vacay', pathNamespace: null }],
  ['an absent document', HOST, null],
];

describe('the sync-size ceiling is one number in two programs', () => {
  // The projection module cannot import the worker's TypeScript, so the
  // constant is stated twice and pinned here rather than left to drift: a
  // helper that allowed more than the edge accepts writes revisions that can
  // never converge, and one that allowed less would refuse documents the
  // edge would have taken.
  it('states the same ceiling as the worker sync parser', () => {
    expect(LEDGER_MAX_BYTES).toBe(SYNC_MAX_BYTES);
  });
});

describe('projection parity with the #970 recovery controller', () => {
  it.each(FIXTURES)('agrees on %s', async (_why, host, hostname) => {
    const desired = deriveCanonicalProjection(host, hostname);
    const ledger = buildLedgerDocument(host, REVISION, desired, READ_AT);
    const artifacts = await buildRecoveryArtifacts(recoveryInput(host), dependencies(host, hostname, ledger));
    const { sourceAudit } = artifacts.request;
    // Equality here is the parity assertion: the controller refuses
    // `source-ledger-drift` when its derivation differs from the ledger this
    // module built.
    expect(sourceAudit.canonicalProjection.desired).toEqual(desired);
    expect(sourceAudit.ledgerPayload.desired).toEqual(desired);
    expect(sourceAudit.digest).toBe(projectionDigest(REVISION, host, desired));
    expect(sourceAudit.revision).toBe(REVISION);
  });

  // Every fixture above carries `pathNamespace` EXPLICITLY, which is why this
  // suite never saw the one place the two derivations disagree: this module
  // reads an absent field as `null`, and the controller requires
  // `source.pathNamespace === null` off the raw document. A writer that stored
  // the omission would therefore publish a host that can never be attested.
  //
  // This is the SHAPE half of that loop. The drive half cannot be written as
  // one test, because the two programs have disjoint host domains by design:
  // the controller refuses every real hostname at its boundary and the
  // lifecycle helper refuses every reserved class, so no host reaches both.
  // What closes it is that `planProvision` writes the explicit `null` on the
  // way in, and `backfill-ledger` and `advance-ledger` now normalize a legacy
  // source that omits it — pinned over a real host in
  // `hostname-lifecycle.test.mjs` — so the shape those three produce is the
  // shape this test proves the controller accepts.
  it('refuses a source document that omits pathNamespace, though this module derives one from it', async () => {
    const omitted = { eventId: 'synthetic-event', edition: 'fiveacross', status: 'active', slug: LABEL };
    const desired = deriveCanonicalProjection(HOST, omitted);
    expect(desired.pathNamespace).toBe(null);
    const ledger = buildLedgerDocument(HOST, REVISION, desired, READ_AT);
    await expect(buildRecoveryArtifacts(recoveryInput(HOST), dependencies(HOST, omitted, ledger))).rejects.toBeInstanceOf(
      RecoveryControllerRefusal,
    );
    // The same document with the field written out is the shape the helper now
    // stores, and the controller attests it.
    const explicit = { ...omitted, pathNamespace: null };
    const artifacts = await buildRecoveryArtifacts(
      recoveryInput(HOST),
      dependencies(HOST, explicit, buildLedgerDocument(HOST, REVISION, deriveCanonicalProjection(HOST, explicit), READ_AT)),
    );
    expect(artifacts.request.sourceAudit.canonicalProjection.desired).toEqual(desired);
  });

  it('refuses a ledger this module would not have produced for the host', async () => {
    const desired = deriveCanonicalProjection(HOST, FIXTURES[0][2]);
    const ledger = buildLedgerDocument(HOST, REVISION, desired, READ_AT);
    ledger.desired = { ...ledger.desired, status: 'disabled' };
    await expect(buildRecoveryArtifacts(recoveryInput(HOST), dependencies(HOST, FIXTURES[0][2], ledger))).rejects.toBeInstanceOf(
      RecoveryControllerRefusal,
    );
  });

  it.each([
    ['a route on a root-test host', ROOT_HOST, { eventId: 'e', edition: 'fiveacross', status: 'active', slug: ROOT_HOST.split('.')[0], pathNamespace: null }],
    ['a root marker on an Event host', HOST, { root: 'doorway', edition: 'fiveacross', pathNamespace: null }],
    ['a path capability on a synthetic host', HOST, { eventId: 'e', edition: 'fiveacross', status: 'active', slug: LABEL, pathNamespace: 'fiveacross.app' }],
    ['an unknown Edition', HOST, { eventId: 'e', edition: 'westminster', status: 'active', slug: LABEL, pathNamespace: null }],
  ])('both programs refuse %s', async (_why, host, hostname) => {
    expect(() => deriveCanonicalProjection(host, hostname)).toThrow(HostnameProjectionRefusal);
    const ledger = { schemaVersion: 1, revision: REVISION, host, desired: { kind: 'tombstone' }, updatedAt: READ_AT };
    await expect(buildRecoveryArtifacts(recoveryInput(host), dependencies(host, hostname, ledger))).rejects.toBeInstanceOf(
      RecoveryControllerRefusal,
    );
  });
});

describe('parity with the deployed publisher that reads what the helper writes', () => {
  const LIVE_HOST = 'bodega-bay.fiveacross.app';
  const WRITTEN_AT = '2026-09-20T12:00:00.000Z';
  const HOSTNAME = {
    eventId: 'bodega-bay-2026',
    canonicalHost: LIVE_HOST,
    edition: 'fiveacross',
    status: 'active',
    slug: 'bodega-bay',
    isCanonical: true,
  };

  /** The one write the helper makes, taken from a real run of it. */
  async function writtenLedger() {
    const docs = new Map([[`hostnames/${LIVE_HOST}`, HOSTNAME]]);
    await applyHostnameMutation(
      {
        schemaVersion: 1,
        intent: 'backfill-ledger',
        apply: true,
        actor: 'nathanjohnpayne',
        reason: 'publisher parity',
        host: LIVE_HOST,
      },
      {
        now: () => new Date(WRITTEN_AT),
        timestamp: (date) => Timestamp.fromDate(date),
        runTransaction: async (work) => {
          const staged = [];
          const result = await work({
            async get(path) {
              return docs.has(path) ? cloneDocumentValue(docs.get(path)) : null;
            },
            set: (path, value) => staged.push([path, value]),
            update: (path, value) => staged.push([path, value]),
            delete: (path) => docs.delete(path),
          });
          for (const [path, value] of staged) docs.set(path, cloneDocumentValue(value));
          return result;
        },
      },
    );
    return docs.get(`routerReplicas/${LIVE_HOST}`);
  }

  /**
   * How Firestore encodes a stored value into the `Document` payload Eventarc
   * delivers. Only the types a ledger document can hold are covered, and the
   * `Timestamp`-versus-string branch is the whole point: it is what turns the
   * stored field into a `timestampValue` or a `stringValue`, which is the exact
   * distinction the publisher's parser accepts or refuses on.
   */
  function firestoreValue(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return { integerValue: String(value) };
    if (Array.isArray(value)) return { arrayValue: { values: value.map((entry) => firestoreValue(entry)) } };
    if (typeof value.toDate === 'function') return { timestampValue: value.toDate().toISOString() };
    return { mapValue: { fields: encodeFields(value) } };
  }

  function encodeFields(document) {
    return Object.fromEntries(Object.entries(document).map(([key, value]) => [key, firestoreValue(value)]));
  }

  const writtenEvent = (document) => ({
    specversion: '1.0',
    type: 'google.cloud.firestore.document.v1.written',
    source: '//firestore.googleapis.com/projects/fiveacross/databases/(default)',
    id: 'a5c0f0ec-0000-4000-8000-000000000001',
    time: WRITTEN_AT,
    subject: `documents/routerReplicas/${LIVE_HOST}`,
    data: {
      value: {
        name: `projects/fiveacross/databases/(default)/documents/routerReplicas/${LIVE_HOST}`,
        fields: encodeFields(document),
      },
    },
  });

  it('publishes a freshly written ledger document through the publisher own parser', async () => {
    const document = await writtenLedger();
    expect(replicaPayloadFromFirestoreEvent(writtenEvent(document))).toEqual({
      schemaVersion: 1,
      revision: '1',
      host: LIVE_HOST,
      desired: deriveCanonicalProjection(LIVE_HOST, HOSTNAME),
      updatedAt: WRITTEN_AT,
    });
  });

  it('refuses the same document with updatedAt stored as text, which is what made this a parity test', async () => {
    // The negative arm is the load-bearing one: it proves the encoder above
    // really does distinguish the two stored shapes, so the passing arm is
    // evidence about the field and not about the fixture. A helper that wrote
    // RFC 3339 text would produce exactly this event.
    const document = { ...(await writtenLedger()), updatedAt: WRITTEN_AT };
    expect(() => replicaPayloadFromFirestoreEvent(writtenEvent(document))).toThrow('invalid router replica event');
  });
});
