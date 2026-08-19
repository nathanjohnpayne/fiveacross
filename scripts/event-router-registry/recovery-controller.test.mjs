import { describe, expect, it, vi } from 'vitest';
import { buildRecoveryArtifacts } from './recovery-controller.mjs';
import { REGISTRY_R0_CONTRACT } from './r0-contract.mjs';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const READ_AT = '2026-08-19T12:00:00.000Z';
const ISSUED_AT = '2026-08-19T12:00:30.000Z';
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
const OLD_VERSION_2 = `${OLD_KEY}/cryptoKeyVersions/2`;
const NEXT_VERSION = `${NEXT_KEY}/cryptoKeyVersions/1`;
const NEXT_VERSION_FULL = `//cloudkms.googleapis.com/${NEXT_VERSION}`;
const NEXT_ACCOUNT_FULL = `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${REPLACEMENT_EMAIL}`;
const OLD_MEMBER = `serviceAccount:${QUARANTINED_EMAIL}`;
const NEXT_MEMBER = `serviceAccount:${REPLACEMENT_EMAIL}`;
const OLD_FINGERPRINT = '1'.repeat(64);
const OLD_FINGERPRINT_2 = '0'.repeat(64);
const NEXT_FINGERPRINT = '2'.repeat(64);
const REGISTRY_DIGEST = '3'.repeat(64);
const SOURCE_ATTESTOR_SUB = '109876543210987654399';
const SOURCE_ATTESTOR_KEY =
  'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/source-attestor/cryptoKeyVersions/1';
const SOURCE_ATTESTOR_FINGERPRINT = '4'.repeat(64);
const SOURCE_ATTESTOR_AUDIENCE = REGISTRY_R0_CONTRACT.identities.find(
  ({ role }) => role === 'source-attestor',
).audience;

const hostnameDocument = {
  eventId: 'synthetic-event',
  canonicalHost: HOST,
  edition: 'fiveacross',
  status: 'active',
  slug: 'r2-abcdefghijklmnopqrstuvwxyz',
  pathNamespace: null,
  isCanonical: true,
  adultContent: false,
};

const ledgerDocument = {
  schemaVersion: 1,
  revision: '7',
  host: HOST,
  desired: {
    kind: 'route',
    eventId: 'synthetic-event',
    status: 'active',
    slug: 'r2-abcdefghijklmnopqrstuvwxyz',
    edition: 'fiveacross',
    pathNamespace: null,
  },
  updatedAt: READ_AT,
};

function replacementPlan() {
  return {
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
    activeEpochMappings: [
      {
        epoch: '7',
        subject: QUARANTINED_SUB,
        keyVersion: OLD_VERSION,
        algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
        spkiSha256: OLD_FINGERPRINT,
      },
      {
        epoch: '8',
        subject: REPLACEMENT_SUB,
        keyVersion: NEXT_VERSION,
        algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
        spkiSha256: NEXT_FINGERPRINT,
      },
    ],
  };
}

function recoveryInput(overrides = {}) {
  return {
    schemaVersion: 1,
    host: HOST,
    expectedCommitted: { revision: '7', digest: '5'.repeat(64) },
    lockId: 'lock-970',
    incidentUrl: 'https://github.com/nathanjohnpayne/gaycruisebingo/issues/970',
    reason: 'Replace a quarantined publisher after exact provider readback.',
    sourceAttestor: {
      audience: SOURCE_ATTESTOR_AUDIENCE,
      oidcSubject: SOURCE_ATTESTOR_SUB,
      keyVersion: SOURCE_ATTESTOR_KEY,
      keyFingerprint: SOURCE_ATTESTOR_FINGERPRINT,
    },
    publisherReplacement: replacementPlan(),
    ...overrides,
  };
}

function controlReadbacks(overrides = {}) {
  const readback = {
    observedAt: READ_AT,
    functions: [
      {
        fullResourceName: OLD_FUNCTION,
        serviceAccountEmail: QUARANTINED_EMAIL,
        oidcSubject: QUARANTINED_SUB,
        functionRevision: 'publisher-old-00007-abc',
        responseDigest: '6'.repeat(64),
      },
      {
        fullResourceName: NEXT_FUNCTION,
        serviceAccountEmail: REPLACEMENT_EMAIL,
        oidcSubject: REPLACEMENT_SUB,
        functionRevision: 'publisher-next-00001-def',
        responseDigest: '7'.repeat(64),
      },
    ],
    keyAccess: [
      {
        cryptoKey: OLD_KEY,
        policyEtag: 'old-etag',
        signMembers: [],
        enabledVersions: [
          {
            keyVersion: OLD_VERSION,
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
            spkiSha256: OLD_FINGERPRINT,
          },
        ],
        responseDigest: '8'.repeat(64),
      },
      {
        cryptoKey: NEXT_KEY,
        policyEtag: 'next-etag',
        signMembers: [NEXT_MEMBER],
        enabledVersions: [
          {
            keyVersion: NEXT_VERSION,
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
            spkiSha256: NEXT_FINGERPRINT,
          },
        ],
        responseDigest: '9'.repeat(64),
      },
    ],
    serviceAccountAccess: [
      {
        fullResourceName: `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${QUARANTINED_EMAIL}`,
        serviceAccountEmail: QUARANTINED_EMAIL,
        oidcSubject: QUARANTINED_SUB,
        policyEtag: 'old-sa-etag',
        tokenCreatorMembers: [],
        responseDigest: 'a'.repeat(64),
      },
      {
        fullResourceName: NEXT_ACCOUNT_FULL,
        serviceAccountEmail: REPLACEMENT_EMAIL,
        oidcSubject: REPLACEMENT_SUB,
        policyEtag: 'next-sa-etag',
        tokenCreatorMembers: [],
        responseDigest: 'b'.repeat(64),
      },
    ],
    activeRegistry: {
      configDigest: REGISTRY_DIGEST,
      mappings: replacementPlan().activeEpochMappings,
    },
    accessDecisions: [
      {
        principalEmail: QUARANTINED_EMAIL,
        fullResourceName: NEXT_VERSION_FULL,
        permission: 'cloudkms.cryptoKeyVersions.useToSign',
        requestTime: READ_AT,
        overallAccessState: 'CANNOT_ACCESS',
        inheritedPoliciesComplete: true,
        responseDigest: 'c'.repeat(64),
      },
      {
        principalEmail: QUARANTINED_EMAIL,
        fullResourceName: NEXT_ACCOUNT_FULL,
        permission: 'iam.serviceAccounts.getOpenIdToken',
        requestTime: READ_AT,
        overallAccessState: 'CANNOT_ACCESS',
        inheritedPoliciesComplete: true,
        responseDigest: 'd'.repeat(64),
      },
      {
        principalEmail: QUARANTINED_EMAIL,
        fullResourceName: NEXT_ACCOUNT_FULL,
        permission: 'iam.serviceAccounts.getAccessToken',
        requestTime: READ_AT,
        overallAccessState: 'CANNOT_ACCESS',
        inheritedPoliciesComplete: true,
        responseDigest: 'e'.repeat(64),
      },
    ],
  };
  return Object.assign(readback, overrides);
}

function sourceReceipt(overrides = {}) {
  return {
    atomic: true,
    readAt: READ_AT,
    hostnamePath: `hostnames/${HOST}`,
    ledgerPath: `routerReplicas/${HOST}`,
    hostname: structuredClone(hostnameDocument),
    routerReplica: structuredClone(ledgerDocument),
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const order = [];
  const sourceSignature = Buffer.from('source-signature').toString('base64');
  const controlSignature = Buffer.from('control-signature').toString('base64');
  const provider = {
    now: vi
      .fn()
      .mockImplementationOnce(() => new Date('2026-08-19T12:00:20.000Z'))
      .mockImplementation(() => new Date(ISSUED_AT)),
    readSourceTransaction: vi.fn(async (paths) => {
      order.push('source-read');
      return sourceReceipt({ hostnamePath: paths.hostnamePath, ledgerPath: paths.ledgerPath });
    }),
    readPublisherControlReadbacks: vi.fn(async () => {
      order.push('control-read');
      return controlReadbacks();
    }),
    obtainSourceAttestorSession: vi.fn(async () => {
      order.push('credential');
      return {
        oidcToken: 'header.payload.signature',
        credentialSource: 'interactive-human-impersonation',
        tokenIssuedAt: '2026-08-19T12:00:25.000Z',
        tokenExpiresAt: '2026-08-19T12:15:25.000Z',
        audience: SOURCE_ATTESTOR_AUDIENCE,
        oidcSubject: SOURCE_ATTESTOR_SUB,
        keyVersion: SOURCE_ATTESTOR_KEY,
        keyFingerprint: SOURCE_ATTESTOR_FINGERPRINT,
        sign: vi.fn(async ({ purpose }) => (purpose === 'source-audit' ? sourceSignature : controlSignature)),
      };
    }),
    __order: order,
    __sourceSignature: sourceSignature,
    __controlSignature: controlSignature,
  };
  return Object.assign(provider, overrides);
}

describe('operator recovery evidence controller', () => {
  it('builds exact source and publisher-control artifacts without submitting or returning credentials', async () => {
    const deps = dependencies();
    const result = await buildRecoveryArtifacts(recoveryInput(), deps);

    expect(deps.readSourceTransaction).toHaveBeenCalledWith({
      hostnamePath: `hostnames/${HOST}`,
      ledgerPath: `routerReplicas/${HOST}`,
    });
    expect(deps.readSourceTransaction).toHaveBeenCalledOnce();
    expect(deps.readPublisherControlReadbacks).toHaveBeenCalledOnce();
    expect(deps.obtainSourceAttestorSession).toHaveBeenCalledOnce();
    expect(deps.__order).toEqual(['source-read', 'control-read', 'credential']);
    expect(result).toMatchObject({
      dryRun: true,
      request: {
        schemaVersion: 1,
        host: HOST,
        action: {
          kind: 'apply',
          lockId: 'lock-970',
          publisherReplacement: {
            quarantinedEpochCeiling: '7',
            nextPublisherEpoch: '8',
            replacementSubject: REPLACEMENT_SUB,
            replacementKeyVersion: NEXT_VERSION,
            replacementKeyFingerprint: NEXT_FINGERPRINT,
            registryConfigDigest: REGISTRY_DIGEST,
            controlEvidence: {
              quarantinedRuntime: {
                subject: QUARANTINED_SUB,
                serviceAccountEmail: QUARANTINED_EMAIL,
                iamMember: OLD_MEMBER,
                functionFullResourceName: OLD_FUNCTION,
                functionRevision: 'publisher-old-00007-abc',
              },
              replacementRuntime: {
                subject: REPLACEMENT_SUB,
                serviceAccountEmail: REPLACEMENT_EMAIL,
                iamMember: NEXT_MEMBER,
                functionFullResourceName: NEXT_FUNCTION,
                functionRevision: 'publisher-next-00001-def',
              },
              attestorSub: SOURCE_ATTESTOR_SUB,
              attestorKeyVersion: SOURCE_ATTESTOR_KEY,
              attestorKeyFingerprint: SOURCE_ATTESTOR_FINGERPRINT,
              attestationIssuedAt: ISSUED_AT,
              attestationSignature: deps.__controlSignature,
            },
          },
        },
        sourceAudit: {
          revision: '7',
          observedAt: READ_AT,
          canonicalProjection: {
            host: HOST,
            desired: ledgerDocument.desired,
            sourceDocumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          ledgerPayload: ledgerDocument,
          ledgerDocumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          attestorSub: SOURCE_ATTESTOR_SUB,
          attestorKeyVersion: SOURCE_ATTESTOR_KEY,
          attestorKeyFingerprint: SOURCE_ATTESTOR_FINGERPRINT,
          attestationIssuedAt: ISSUED_AT,
          attestationSignature: deps.__sourceSignature,
        },
      },
      evidence: {
        sourceReadAt: READ_AT,
        credentialMaterialOmitted: true,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('header.payload.signature');
    expect(serialized).not.toMatch(/authorization|oidcToken|access_token/i);
    expect(Object.keys(result)).toEqual(['dryRun', 'request', 'evidence', 'signatureInputs']);
    expect(result.request.sourceAudit).toMatchObject({
      digest: '152e46f1ee0701bf57847f19d876bd9643ae5d13b3c29f26710304abce80f1e0',
      canonicalProjection: {
        sourceDocumentDigest: 'f2e031d77642678e103217b121c164b06f22dacac6066f9d3ca2381c8cb815ee',
      },
      ledgerDocumentDigest: '770afcfb2616483142d34a23c51e1dcf30a6740af6b1457337c1985931948e52',
    });
    expect(result.signatureInputs.sourceAudit).toBe(
      [
        'v1',
        'source-audit',
        HOST,
        '7',
        '152e46f1ee0701bf57847f19d876bd9643ae5d13b3c29f26710304abce80f1e0',
        READ_AT,
        ISSUED_AT,
        '8dd4bd28e9f5a0c72ca8838840875ba794dde10bb97430c39d9baae200f36d53',
        '770afcfb2616483142d34a23c51e1dcf30a6740af6b1457337c1985931948e52',
        'f2e031d77642678e103217b121c164b06f22dacac6066f9d3ca2381c8cb815ee',
        '770afcfb2616483142d34a23c51e1dcf30a6740af6b1457337c1985931948e52',
      ].join('\n'),
    );
    expect(result.signatureInputs.publisherControl?.split('\n').slice(0, 4)).toEqual([
      'v1',
      'publisher-quarantine',
      READ_AT,
      ISSUED_AT,
    ]);
    expect(result.signatureInputs.publisherControl?.split('\n')[4]).toBe(
      '4ba4fa60823e1356f7b674f75e35aa6e513868c320c824e482acdd0e66c46aee',
    );

    const control = result.request.action.publisherReplacement.controlEvidence;
    expect(control.serviceAccountAccess).toEqual([
      expect.objectContaining({
        subject: QUARANTINED_SUB,
        serviceAccountEmail: QUARANTINED_EMAIL,
        iamMember: OLD_MEMBER,
        fullResourceName: `//iam.googleapis.com/projects/fiveacross/serviceAccounts/${QUARANTINED_EMAIL}`,
      }),
      expect.objectContaining({
        subject: REPLACEMENT_SUB,
        serviceAccountEmail: REPLACEMENT_EMAIL,
        iamMember: NEXT_MEMBER,
        fullResourceName: NEXT_ACCOUNT_FULL,
      }),
    ]);
    expect(control.quarantinedAccessDecisions).toEqual([
      expect.objectContaining({
        principal: QUARANTINED_EMAIL,
        fullResourceName: NEXT_VERSION_FULL,
        inheritedPoliciesComplete: true,
      }),
      expect.objectContaining({
        principal: QUARANTINED_EMAIL,
        fullResourceName: NEXT_ACCOUNT_FULL,
        inheritedPoliciesComplete: true,
      }),
      expect.objectContaining({
        principal: QUARANTINED_EMAIL,
        fullResourceName: NEXT_ACCOUNT_FULL,
        inheritedPoliciesComplete: true,
      }),
    ]);
  });

  it('accepts every enabled overlap version for the quarantined publisher key through its epoch ceiling', async () => {
    const plan = replacementPlan();
    plan.activeEpochMappings.unshift({
      epoch: '6',
      subject: QUARANTINED_SUB,
      keyVersion: OLD_VERSION_2,
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      spkiSha256: OLD_FINGERPRINT_2,
    });
    const readback = controlReadbacks();
    readback.activeRegistry.mappings = structuredClone(plan.activeEpochMappings);
    readback.keyAccess[0].enabledVersions.push({
      keyVersion: OLD_VERSION_2,
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      spkiSha256: OLD_FINGERPRINT_2,
    });
    const deps = dependencies({
      readPublisherControlReadbacks: vi.fn(async () => readback),
    });

    const result = await buildRecoveryArtifacts(recoveryInput({ publisherReplacement: plan }), deps);

    expect(result.request.action.publisherReplacement.controlEvidence.activeEpochMappings).toEqual(
      plan.activeEpochMappings,
    );
  });

  it('refuses source/ledger drift before reading controls or obtaining human credentials', async () => {
    const drifted = structuredClone(ledgerDocument);
    drifted.desired.eventId = 'poisoned-event';
    const deps = dependencies({
      readSourceTransaction: vi.fn(async () => sourceReceipt({ routerReplica: drifted })),
    });

    await expect(buildRecoveryArtifacts(recoveryInput(), deps)).rejects.toMatchObject({
      name: 'RecoveryControllerRefusal',
      code: 'source-ledger-drift',
    });
    expect(deps.readPublisherControlReadbacks).not.toHaveBeenCalled();
    expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
  });

  it('refuses missing or malformed source documents and ledgers without attestor credentials', async () => {
    const cases = [
      sourceReceipt({ routerReplica: null }),
      sourceReceipt({ hostname: { ...hostnameDocument, root: 'doorway' } }),
      sourceReceipt({ routerReplica: { ...ledgerDocument, extra: true } }),
    ];
    for (const receipt of cases) {
      const deps = dependencies({ readSourceTransaction: vi.fn(async () => receipt) });
      await expect(buildRecoveryArtifacts(recoveryInput(), deps)).rejects.toBeInstanceOf(Error);
      expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
    }
  });

  it('derives synthetic root and tombstone projections only from the raw authoritative hostname result', async () => {
    const rootHost = 'r2-root-abcdefghijklmnopqrst.fiveacross.app';
    const rootDesired = {
      kind: 'root',
      root: 'doorway',
      edition: 'fiveacross',
      pathNamespace: null,
    };
    const rootReceipt = {
      atomic: true,
      readAt: READ_AT,
      hostnamePath: `hostnames/${rootHost}`,
      ledgerPath: `routerReplicas/${rootHost}`,
      hostname: {
        root: 'doorway',
        edition: 'fiveacross',
        pathNamespace: null,
        adultContent: true,
      },
      routerReplica: {
        ...ledgerDocument,
        host: rootHost,
        desired: rootDesired,
      },
    };
    const rootDeps = dependencies({
      readSourceTransaction: vi.fn(async () => rootReceipt),
    });
    const root = await buildRecoveryArtifacts(recoveryInput({ host: rootHost }), rootDeps);
    expect(root.request.sourceAudit.canonicalProjection.desired).toEqual(rootDesired);

    const tombstoneReceipt = sourceReceipt({
      hostname: null,
      routerReplica: { ...ledgerDocument, desired: { kind: 'tombstone' } },
    });
    const tombstoneDeps = dependencies({
      readSourceTransaction: vi.fn(async () => tombstoneReceipt),
    });
    const tombstone = await buildRecoveryArtifacts(recoveryInput(), tombstoneDeps);
    expect(tombstone.request.sourceAudit.canonicalProjection.desired).toEqual({ kind: 'tombstone' });
  });

  it('rejects real event and apex hosts before any source or credential access', async () => {
    for (const host of ['weekend.fiveacross.app', 'fiveacross.app']) {
      const deps = dependencies();
      await expect(buildRecoveryArtifacts(recoveryInput({ host }), deps)).rejects.toMatchObject({
        code: 'invalid-host',
      });
      expect(deps.readSourceTransaction).not.toHaveBeenCalled();
      expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
    }
  });

  it('refuses an unsigned null replacement before any source or credential access', async () => {
    const deps = dependencies();
    await expect(buildRecoveryArtifacts(recoveryInput({ publisherReplacement: null }), deps)).rejects.toMatchObject({
      code: 'replacement-required',
    });
    expect(deps.readSourceTransaction).not.toHaveBeenCalled();
    expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
  });

  it('rejects extra provider fields before obtaining the source-attestor session', async () => {
    const readback = controlReadbacks({ unexpected: 'not part of the reviewed API response' });
    const deps = dependencies({
      readPublisherControlReadbacks: vi.fn(async () => readback),
    });
    await expect(buildRecoveryArtifacts(recoveryInput(), deps)).rejects.toMatchObject({
      code: 'malformed-control-readback',
    });
    expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      'function resource',
      (readback) => {
        readback.functions[1].fullResourceName = `${NEXT_FUNCTION}-wrong`;
      },
    ],
    [
      'service-account resource',
      (readback) => {
        readback.serviceAccountAccess[1].fullResourceName = `//iam.googleapis.com/projects/other/serviceAccounts/${REPLACEMENT_EMAIL}`;
      },
    ],
    [
      'registry mapping',
      (readback) => {
        readback.activeRegistry.mappings[1].spkiSha256 = '0'.repeat(64);
      },
    ],
    [
      'troubleshooter resource',
      (readback) => {
        readback.accessDecisions[0].fullResourceName = `//cloudkms.googleapis.com/${OLD_VERSION}`;
      },
    ],
  ])('requires the exact %s readback', async (_label, mutate) => {
    const readback = controlReadbacks();
    mutate(readback);
    const deps = dependencies({
      readPublisherControlReadbacks: vi.fn(async () => readback),
    });
    await expect(buildRecoveryArtifacts(recoveryInput(), deps)).rejects.toBeInstanceOf(Error);
    expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
  });

  it('requires fresh provider readbacks and a short-lived human-impersonated attestor session', async () => {
    const stale = controlReadbacks({ observedAt: '2026-08-19T11:00:00.000Z' });
    const staleDeps = dependencies({
      readPublisherControlReadbacks: vi.fn(async () => stale),
    });
    await expect(buildRecoveryArtifacts(recoveryInput(), staleDeps)).rejects.toMatchObject({
      code: 'stale-control-readback',
    });
    expect(staleDeps.obtainSourceAttestorSession).not.toHaveBeenCalled();

    const runtimeSession = dependencies();
    runtimeSession.obtainSourceAttestorSession = vi.fn(async () => ({
      oidcToken: 'header.payload.signature',
      credentialSource: 'runtime-service-account',
      tokenIssuedAt: '2026-08-19T12:00:25.000Z',
      tokenExpiresAt: '2026-08-19T12:15:25.000Z',
      audience: recoveryInput().sourceAttestor.audience,
      oidcSubject: SOURCE_ATTESTOR_SUB,
      keyVersion: SOURCE_ATTESTOR_KEY,
      keyFingerprint: SOURCE_ATTESTOR_FINGERPRINT,
      sign: vi.fn(),
    }));
    await expect(buildRecoveryArtifacts(recoveryInput(), runtimeSession)).rejects.toMatchObject({
      code: 'attestor-session-mismatch',
    });
  });

  it('sanitizes dependency failures and never leaks provider or credential error text', async () => {
    const secret = 'ya29.secret-access-token';
    const deps = dependencies({
      readSourceTransaction: vi.fn(async () => {
        throw new Error(`provider rejected ${secret}`);
      }),
    });
    let caught;
    try {
      await buildRecoveryArtifacts(recoveryInput(), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'RecoveryControllerRefusal',
      code: 'source-transaction-unavailable',
      message: 'recovery evidence refused: source-transaction-unavailable',
    });
    expect(String(caught)).not.toContain(secret);
    expect(deps.obtainSourceAttestorSession).not.toHaveBeenCalled();
  });
});
