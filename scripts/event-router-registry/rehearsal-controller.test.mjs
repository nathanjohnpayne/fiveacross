import { describe, expect, it, vi } from 'vitest';
import {
  cleanupRehearsal,
  provisionRehearsal,
  validateRehearsalManifest,
} from './rehearsal-controller.mjs';

const EVENT_HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const ROOT_HOST = 'r2-root-abcdefghijklmnopqrst.vacaybingo.com';
const ACTIVE_HOST = 'r2-bbbbbbbbbbbbbbbbbbbbbbbbbb.fiveacross.app';
const TOMBSTONE_HOST = 'r2-cccccccccccccccccccccccccc.vacaybingo.com';
const UNKNOWN_HOST = 'r2-dddddddddddddddddddddddddd.fiveacross.app';
const COLD_HOST = 'r2-eeeeeeeeeeeeeeeeeeeeeeeeee.vacaybingo.com';

function expectedState(host) {
  if (host.includes('r2-root-')) {
    return {
      kind: 'root',
      revision: '1',
      root: 'doorway',
      edition: host.endsWith('.fiveacross.app') ? 'fiveacross' : 'vacay',
      pathNamespace: null,
    };
  }
  return {
    kind: 'route',
    revision: '1',
    eventId: 'synthetic-event',
    status: 'disabled',
    slug: host.split('.')[0],
    edition: host.endsWith('.fiveacross.app') ? 'fiveacross' : 'vacay',
    pathNamespace: null,
  };
}

function manifest(hosts = [EVENT_HOST, ROOT_HOST]) {
  const sourceCommit = 'a'.repeat(40);
  const scriptVersion = 'registry-router-v1';
  return {
    schemaVersion: 1,
    runId: 'run-1',
    sourceCommit,
    scriptVersion,
    creator: 'nathanjohnpayne',
    expiresAt: '2026-08-20T12:00:00.000Z',
    reviewAuthorization: {
      id: 'review-123',
      reviewer: 'nathanpayne-claude',
      reviewedAt: '2026-08-19T12:00:00.000Z',
      sourceCommit,
      scriptVersion,
      artifactSha256: 'b'.repeat(64),
      signingKeyId: 'rehearsal-controller-v1',
    },
    hosts: hosts.map((host, index) => ({
      host,
      class: host.includes('r2-root-') ? 'root-test' : 'synthetic',
      dnsRecordId: `dns-${index}`,
      routeId: `route-${index}`,
      expectedState: expectedState(host),
    })),
    signature: {
      algorithm: 'RS256',
      keyId: 'rehearsal-controller-v1',
      value: 'signed-manifest-fixture',
    },
  };
}

function reservationReceipt(request, transform = (reservedHosts) => reservedHosts) {
  const reservedHosts = request.reservations.map((reservation) => ({
    host: reservation.host,
    class: reservation.class,
    materialization: reservation.materialization,
    expectedState: structuredClone(reservation.expectedState),
    permanent: reservation.permanent,
    runId: reservation.runId,
    reservationPath: reservation.reservationPath,
    hostnamePath: reservation.hostnamePath,
    ledgerPath: reservation.ledgerPath,
    hostname: structuredClone(reservation.hostname),
    routerReplica: structuredClone(reservation.routerReplica),
    projectionDigest: reservation.projectionDigest,
    sourceReplicaEqual: true,
    reservationPreviouslyAbsent: true,
    hostnamePreviouslyAbsent: true,
    ledgerPreviouslyAbsent: true,
    hostnameAbsent: reservation.hostname === null,
    ledgerAbsent: reservation.routerReplica === null,
  }));
  return {
    committed: true,
    aggregateReservations: request.reservations.length,
    manifestDigest: request.binding.manifestDigest,
    reservedHosts: transform(reservedHosts),
  };
}

function deps(overrides = {}) {
  const provider = {
    now: vi.fn(() => new Date('2026-08-19T13:00:00.000Z')),
    verifyManifestSignature: vi.fn(async () => true),
    inspectReviewedArtifact: vi.fn(async () => ({
      branch: 'main',
      clean: true,
      reviewed: true,
      sourceCommit: 'a'.repeat(40),
      scriptVersion: 'registry-router-v1',
      artifactSha256: 'b'.repeat(64),
      reviewAuthorizationId: 'review-123',
    })),
    reserveTransaction: vi.fn(async (request) => reservationReceipt(request)),
    createExactDns: vi.fn(),
    attachExactRoute: vi.fn(),
    tombstoneAndWait: vi.fn(),
    removeExactRoute: vi.fn(),
    removeExactDns: vi.fn(),
    verifyAbsent: vi.fn(),
  };
  return Object.assign(provider, overrides);
}

describe('guarded rehearsal controller', () => {
  it('accepts only the two closed synthetic classes and at most 64 hosts per manifest', () => {
    expect(validateRehearsalManifest(manifest())).toMatchObject({
      runId: 'run-1',
    });
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const hosts = Array.from({ length: 65 }, (_, index) => {
      const suffix = `${alphabet[Math.floor(index / alphabet.length)]}${alphabet[index % alphabet.length]}`;
      return `r2-${'a'.repeat(24)}${suffix}.fiveacross.app`;
    });
    expect(() => validateRehearsalManifest(manifest(hosts))).toThrow('64');

    const wrongSigner = manifest();
    wrongSigner.signature.keyId = 'unreviewed-signer';
    expect(() => validateRehearsalManifest(wrongSigner)).toThrow('signature');
  });

  it('accepts the complete signed materialized and uninitialized rehearsal state matrix', () => {
    const candidate = manifest([
      ACTIVE_HOST,
      EVENT_HOST,
      ROOT_HOST,
      TOMBSTONE_HOST,
      UNKNOWN_HOST,
      COLD_HOST,
    ]);
    candidate.hosts[0].expectedState = {
      ...expectedState(ACTIVE_HOST),
      status: 'active',
    };
    candidate.hosts[3].expectedState = { kind: 'tombstone', revision: '1' };
    candidate.hosts[4].expectedState = {
      kind: 'uninitialized',
      scenario: 'unknown',
    };
    candidate.hosts[5].expectedState = {
      kind: 'uninitialized',
      scenario: 'cold',
    };

    expect(validateRehearsalManifest(candidate).hosts.map((item) => item.expectedState)).toEqual(
      candidate.hosts.map((item) => item.expectedState),
    );
  });

  it('requires exact state shapes, revision 1 for materialized state, and valid host bindings', () => {
    expect(validateRehearsalManifest(manifest())).toMatchObject({
      runId: 'run-1',
    });

    const invalidStates = [
      'disabled',
      { ...expectedState(EVENT_HOST), status: 'archived' },
      { ...expectedState(EVENT_HOST), slug: 'another-host' },
      { ...expectedState(EVENT_HOST), edition: 'vacay' },
      { ...expectedState(EVENT_HOST), pathNamespace: 'fiveacross.app' },
      { ...expectedState(EVENT_HOST), revision: '01' },
      { ...expectedState(EVENT_HOST), revision: '2' },
      { ...expectedState(EVENT_HOST), root: 'doorway' },
      { kind: 'tombstone', revision: '2' },
      { kind: 'uninitialized', scenario: 'warm' },
      { kind: 'uninitialized', scenario: 'unknown', revision: '1' },
      expectedState(ROOT_HOST),
    ];
    for (const state of invalidStates) {
      const candidate = manifest([EVENT_HOST]);
      candidate.hosts[0].expectedState = state;
      expect(() => validateRehearsalManifest(candidate)).toThrow('expected state');
    }

    const routeOnRoot = manifest([ROOT_HOST]);
    routeOnRoot.hosts[0].expectedState = expectedState(EVENT_HOST);
    expect(() => validateRehearsalManifest(routeOnRoot)).toThrow('expected state');

    const invalidRootStates = [
      { ...expectedState(ROOT_HOST), root: 'redirect' },
      { ...expectedState(ROOT_HOST), edition: 'fiveacross' },
      { ...expectedState(ROOT_HOST), pathNamespace: 'vacaybingo.com' },
      { ...expectedState(ROOT_HOST), revision: '0' },
      { ...expectedState(ROOT_HOST), revision: '2' },
      { ...expectedState(ROOT_HOST), slug: 'r2-root-abcdefghijklmnopqrst' },
    ];
    for (const state of invalidRootStates) {
      const candidate = manifest([ROOT_HOST]);
      candidate.hosts[0].expectedState = state;
      expect(() => validateRehearsalManifest(candidate)).toThrow('expected state');
    }
  });

  it.each([
    '*.fiveacross.app',
    'fiveacross.app',
    'bodega-bay.fiveacross.app',
    'r2-ABCDEFGHIJKLMNOPQRSTUVWXYZ.fiveacross.app',
    'r2-short.fiveacross.app',
  ])('hard-rejects wildcard, apex, real, or out-of-class host %s', (host) => {
    expect(() => validateRehearsalManifest(manifest([host]))).toThrow('closed synthetic class');
  });

  it('is dry-run by default and describes exact host-only DNS/route operations without mutation', async () => {
    const provider = deps();
    const result = await provisionRehearsal(manifest(), provider);
    expect(result.dryRun).toBe(true);
    expect(result.operations).toContain(`attach exact route ${EVENT_HOST}/*`);
    expect(provider.reserveTransaction).not.toHaveBeenCalled();
    expect(provider.createExactDns).not.toHaveBeenCalled();
    expect(provider.attachExactRoute).not.toHaveBeenCalled();
    expect(provider.verifyManifestSignature).not.toHaveBeenCalled();
  });

  it('passes exact hostname and equal replica state into one authoritative reservation transaction', async () => {
    const provider = deps();
    await provisionRehearsal(manifest(), provider, { dryRun: false, existingReservations: 10_000 });
    expect(provider.reserveTransaction).toHaveBeenCalledOnce();
    expect(provider.reserveTransaction.mock.calls[0][0]).toMatchObject({
      maximumAggregate: 64,
    });
    expect(provider.reserveTransaction.mock.calls[0][0].reservations[0]).toEqual({
      host: EVENT_HOST,
      class: 'synthetic',
      materialization: 'source-and-ledger',
      requirePriorAbsence: true,
      expectedState: expectedState(EVENT_HOST),
      permanent: true,
      runId: 'run-1',
      reservationPath: `routerRehearsals/${EVENT_HOST}`,
      hostnamePath: `hostnames/${EVENT_HOST}`,
      ledgerPath: `routerReplicas/${EVENT_HOST}`,
      hostname: {
        eventId: 'synthetic-event',
        canonicalHost: EVENT_HOST,
        edition: 'fiveacross',
        status: 'disabled',
        slug: 'r2-abcdefghijklmnopqrstuvwxyz',
        pathNamespace: null,
        isCanonical: true,
      },
      routerReplica: {
        schemaVersion: 1,
        revision: '1',
        host: EVENT_HOST,
        desired: {
          kind: 'route',
          eventId: 'synthetic-event',
          status: 'disabled',
          slug: 'r2-abcdefghijklmnopqrstuvwxyz',
          edition: 'fiveacross',
          pathNamespace: null,
        },
        updatedAt: '2026-08-19T13:00:00.000Z',
      },
      projectionDigest: '99bf68a026a95b1138b7c4817574612436f29c8ae0ea1fe8fd623012026f9755',
    });
    expect(provider.reserveTransaction.mock.calls[0][0].reservations[1]).toEqual({
      host: ROOT_HOST,
      class: 'root-test',
      materialization: 'source-and-ledger',
      requirePriorAbsence: true,
      expectedState: expectedState(ROOT_HOST),
      permanent: true,
      runId: 'run-1',
      reservationPath: `routerRehearsals/${ROOT_HOST}`,
      hostnamePath: `hostnames/${ROOT_HOST}`,
      ledgerPath: `routerReplicas/${ROOT_HOST}`,
      hostname: {
        root: 'doorway',
        edition: 'vacay',
        pathNamespace: null,
      },
      routerReplica: {
        schemaVersion: 1,
        revision: '1',
        host: ROOT_HOST,
        desired: {
          kind: 'root',
          root: 'doorway',
          edition: 'vacay',
          pathNamespace: null,
        },
        updatedAt: '2026-08-19T13:00:00.000Z',
      },
      projectionDigest: '24d9a66fb9999e8a754ab1738f3f420fbf6507c62aa5534468b7d722f38ce39b',
    });
    expect(provider.createExactDns).toHaveBeenCalledTimes(2);
    expect(provider.attachExactRoute).toHaveBeenCalledWith(
      ROOT_HOST,
      `${ROOT_HOST}/*`,
      'route-1',
      expect.objectContaining({
        sourceCommit: 'a'.repeat(40),
        scriptVersion: 'registry-router-v1',
        expiresAt: '2026-08-20T12:00:00.000Z',
        reviewAuthorizationId: 'review-123',
      }),
    );
  });

  it('atomically materializes the full matrix while leaving unknown and cold hosts reserved-only', async () => {
    const candidate = manifest([
      ACTIVE_HOST,
      EVENT_HOST,
      ROOT_HOST,
      TOMBSTONE_HOST,
      UNKNOWN_HOST,
      COLD_HOST,
    ]);
    candidate.hosts[0].expectedState = {
      ...expectedState(ACTIVE_HOST),
      status: 'active',
    };
    candidate.hosts[3].expectedState = { kind: 'tombstone', revision: '1' };
    candidate.hosts[4].expectedState = {
      kind: 'uninitialized',
      scenario: 'unknown',
    };
    candidate.hosts[5].expectedState = {
      kind: 'uninitialized',
      scenario: 'cold',
    };
    const provider = deps();

    await provisionRehearsal(candidate, provider, { dryRun: false });

    const reservations = provider.reserveTransaction.mock.calls[0][0].reservations;
    expect(reservations[0]).toMatchObject({
      host: ACTIVE_HOST,
      materialization: 'source-and-ledger',
      requirePriorAbsence: true,
      routerReplica: {
        revision: '1',
        desired: { kind: 'route', status: 'active' },
      },
    });
    expect(reservations[3]).toEqual({
      host: TOMBSTONE_HOST,
      class: 'synthetic',
      materialization: 'ledger-only',
      requirePriorAbsence: true,
      expectedState: { kind: 'tombstone', revision: '1' },
      permanent: true,
      runId: 'run-1',
      reservationPath: `routerRehearsals/${TOMBSTONE_HOST}`,
      hostnamePath: `hostnames/${TOMBSTONE_HOST}`,
      ledgerPath: `routerReplicas/${TOMBSTONE_HOST}`,
      hostname: null,
      routerReplica: {
        schemaVersion: 1,
        revision: '1',
        host: TOMBSTONE_HOST,
        desired: { kind: 'tombstone' },
        updatedAt: '2026-08-19T13:00:00.000Z',
      },
      projectionDigest: '0646abacdcf6a5153d3cbbea3bbeb809ab72981587f4283be8119472572d38ce',
    });
    for (const [index, scenario] of [
      [4, 'unknown'],
      [5, 'cold'],
    ]) {
      expect(reservations[index]).toMatchObject({
        materialization: 'reserved-only',
        requirePriorAbsence: true,
        expectedState: { kind: 'uninitialized', scenario },
        hostname: null,
        routerReplica: null,
        projectionDigest: null,
      });
      expect(candidate.hosts[index].expectedState).toEqual({
        kind: 'uninitialized',
        scenario,
      });
    }
    expect(provider.createExactDns).toHaveBeenCalledTimes(6);
    expect(provider.attachExactRoute).toHaveBeenCalledTimes(6);
  });

  it('requires prior-absence and reserved-only absence attestations before provider mutation', async () => {
    const candidate = manifest([UNKNOWN_HOST]);
    candidate.hosts[0].expectedState = {
      kind: 'uninitialized',
      scenario: 'unknown',
    };
    const forgeries = [
      (attestation) => {
        attestation.reservationPreviouslyAbsent = false;
      },
      (attestation) => {
        attestation.hostnamePreviouslyAbsent = false;
      },
      (attestation) => {
        attestation.ledgerPreviouslyAbsent = false;
      },
      (attestation) => {
        attestation.hostnameAbsent = false;
      },
      (attestation) => {
        attestation.ledgerAbsent = false;
      },
      (attestation) => {
        attestation.hostname = { status: 'disabled' };
      },
      (attestation) => {
        attestation.routerReplica = { revision: '1' };
      },
      (attestation) => {
        attestation.projectionDigest = 'f'.repeat(64);
      },
      (attestation) => {
        attestation.materialization = 'source-and-ledger';
      },
      (attestation) => {
        attestation.expectedState = { kind: 'uninitialized', scenario: 'cold' };
      },
    ];

    for (const forge of forgeries) {
      const provider = deps({
        reserveTransaction: vi.fn(async (request) =>
          reservationReceipt(request, (attestations) => {
            forge(attestations[0]);
            return attestations;
          }),
        ),
      });
      await expect(provisionRehearsal(candidate, provider, { dryRun: false })).rejects.toThrow(
        'reservation transaction',
      );
      expect(provider.createExactDns).not.toHaveBeenCalled();
      expect(provider.attachExactRoute).not.toHaveBeenCalled();
    }
  });

  it('refuses invalid signatures, expired manifests, and dirty or non-main artifacts before mutation', async () => {
    for (const provider of [
      deps({ verifyManifestSignature: vi.fn(async () => false) }),
      deps({ now: vi.fn(() => new Date('2026-08-20T12:00:00.000Z')) }),
      deps({
        inspectReviewedArtifact: vi.fn(async () => ({
          branch: 'feature',
          clean: false,
          reviewed: false,
          sourceCommit: 'a'.repeat(40),
          scriptVersion: 'registry-router-v1',
          artifactSha256: 'b'.repeat(64),
          reviewAuthorizationId: 'review-123',
        })),
      }),
    ]) {
      await expect(provisionRehearsal(manifest(), provider, { dryRun: false })).rejects.toThrow();
      expect(provider.reserveTransaction).not.toHaveBeenCalled();
      expect(provider.createExactDns).not.toHaveBeenCalled();
      expect(provider.attachExactRoute).not.toHaveBeenCalled();
    }
  });

  it('refuses a mismatched reviewed candidate and an invalid authoritative reservation receipt', async () => {
    const mismatched = deps({
      inspectReviewedArtifact: vi.fn(async () => ({
        branch: 'main',
        clean: true,
        reviewed: true,
        sourceCommit: 'c'.repeat(40),
        scriptVersion: 'registry-router-v1',
        artifactSha256: 'b'.repeat(64),
        reviewAuthorizationId: 'review-123',
      })),
    });
    await expect(provisionRehearsal(manifest(), mismatched, { dryRun: false })).rejects.toThrow(
      'reviewed artifact',
    );

    const overCap = deps({
      reserveTransaction: vi.fn(async (request) => ({
        ...reservationReceipt(request),
        aggregateReservations: 65,
      })),
    });
    await expect(provisionRehearsal(manifest(), overCap, { dryRun: false })).rejects.toThrow('64');
    expect(overCap.createExactDns).not.toHaveBeenCalled();
    expect(overCap.attachExactRoute).not.toHaveBeenCalled();
  });

  it('requires exact state, equality, and digest attestations for every host before provider mutation', async () => {
    const valid = deps();
    await expect(provisionRehearsal(manifest(), valid, { dryRun: false })).resolves.toMatchObject({
      dryRun: false,
    });
    expect(valid.createExactDns).toHaveBeenCalledTimes(2);
    expect(valid.attachExactRoute).toHaveBeenCalledTimes(2);

    const forgeries = [
      (hosts) => hosts.slice(0, 1),
      (hosts) => {
        delete hosts[0].hostname;
        return hosts;
      },
      (hosts) => {
        hosts[0].hostname.status = 'active';
        return hosts;
      },
      (hosts) => {
        hosts[0].routerReplica.desired.status = 'active';
        return hosts;
      },
      (hosts) => {
        hosts[0].projectionDigest = 'c'.repeat(64);
        return hosts;
      },
      (hosts) => {
        hosts[0].sourceReplicaEqual = false;
        return hosts;
      },
      (hosts) => {
        hosts[0].reservationPreviouslyAbsent = false;
        return hosts;
      },
      (hosts) => {
        hosts[0].hostnamePreviouslyAbsent = false;
        return hosts;
      },
      (hosts) => {
        hosts[0].ledgerPreviouslyAbsent = false;
        return hosts;
      },
      (hosts) => {
        hosts[0].hostnameAbsent = true;
        return hosts;
      },
      (hosts) => {
        hosts[0].ledgerAbsent = true;
        return hosts;
      },
      (hosts) => {
        hosts[0].materialization = 'reserved-only';
        return hosts;
      },
      (hosts) => {
        hosts[0].permanent = false;
        return hosts;
      },
      (hosts) => {
        hosts[0].reservationPath = `routerRehearsals/forged.${EVENT_HOST}`;
        return hosts;
      },
      (hosts) => {
        hosts[0].unattested = true;
        return hosts;
      },
    ];
    for (const forge of forgeries) {
      const provider = deps({
        reserveTransaction: vi.fn(async (request) => reservationReceipt(request, forge)),
      });
      await expect(provisionRehearsal(manifest(), provider, { dryRun: false })).rejects.toThrow(
        'reservation transaction',
      );
      expect(provider.createExactDns).not.toHaveBeenCalled();
      expect(provider.attachExactRoute).not.toHaveBeenCalled();
    }
  });

  it('binds every provider artifact to the signed manifest and reviewed candidate', async () => {
    const provider = deps();
    await provisionRehearsal(manifest(), provider, { dryRun: false });

    const dnsOptions = provider.createExactDns.mock.calls[0][2];
    const routeBinding = provider.attachExactRoute.mock.calls[0][3];
    expect(dnsOptions).toMatchObject({ proxied: true, binding: routeBinding });
    expect(routeBinding).toEqual(
      expect.objectContaining({
        manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceCommit: 'a'.repeat(40),
        scriptVersion: 'registry-router-v1',
        artifactSha256: 'b'.repeat(64),
        expiresAt: '2026-08-20T12:00:00.000Z',
        reviewAuthorizationId: 'review-123',
      }),
    );
    const signedPayload = new TextDecoder().decode(
      provider.verifyManifestSignature.mock.calls[0][0],
    );
    expect(signedPayload).toContain('"reviewAuthorization"');
    expect(signedPayload).not.toContain('signed-manifest-fixture');
    expect(provider.inspectReviewedArtifact).toHaveBeenCalledWith({
      sourceCommit: 'a'.repeat(40),
      scriptVersion: 'registry-router-v1',
      artifactSha256: 'b'.repeat(64),
      reviewAuthorizationId: 'review-123',
    });
  });

  it('tombstones and waits for DO convergence before removing only manifest-recorded artifacts', async () => {
    const provider = deps();
    const result = await cleanupRehearsal(manifest(), provider, {
      dryRun: false,
      observedArtifacts: [
        { kind: 'dns', id: 'dns-0', host: EVENT_HOST },
        { kind: 'route', id: 'route-0', host: EVENT_HOST },
        { kind: 'dns', id: 'dns-1', host: ROOT_HOST },
        { kind: 'route', id: 'route-1', host: ROOT_HOST },
      ],
    });
    expect(result.permanentReservationsRetained).toBe(true);
    expect(provider.tombstoneAndWait).toHaveBeenCalledBefore(provider.removeExactRoute);
    expect(provider.removeExactRoute).toHaveBeenCalledTimes(2);
    expect(provider.removeExactDns).toHaveBeenCalledTimes(2);
    expect(provider.verifyAbsent).toHaveBeenCalledOnce();
    expect(provider.verifyManifestSignature).toHaveBeenCalledOnce();
  });

  it('refuses cleanup when the provider reports an unrecorded artifact', async () => {
    const provider = deps();
    await expect(
      cleanupRehearsal(manifest(), provider, {
        observedArtifacts: [{ kind: 'route', id: 'unknown-route', host: EVENT_HOST }],
      }),
    ).rejects.toThrow('unrecorded artifact');
    expect(provider.tombstoneAndWait).not.toHaveBeenCalled();
  });

  it('allows signature-authorized cleanup after the run expires', async () => {
    const provider = deps({ now: vi.fn(() => new Date('2027-01-01T00:00:00.000Z')) });
    await expect(cleanupRehearsal(manifest(), provider, { dryRun: false })).resolves.toMatchObject({
      permanentReservationsRetained: true,
    });
    expect(provider.verifyManifestSignature).toHaveBeenCalledOnce();
    expect(provider.tombstoneAndWait).toHaveBeenCalledOnce();
  });
});
