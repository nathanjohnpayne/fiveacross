// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { acceptProbeAttestation, issueProbeChallenge, matchProbeAttestations, type ProbeObservation } from './probe';

const HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const NOW = Date.parse('2026-08-19T12:35:00.000Z');
const WAF_REMOVED_AT = new Date(NOW - 1_000).toISOString();
const PRINCIPAL = {
  subject: 'probe-sub-1',
  keyVersion: 'probe-key/1',
  keyFingerprint: 'a'.repeat(64),
  region: 'us-west1',
};

function blockedObservation(nonce = 'nonce-1'): ProbeObservation {
  return {
    phase: 'blocked-before-worker',
    probeNonce: nonce,
    observedAt: '2026-08-19T12:34:45.000Z',
    rayId: 'ray-1',
    host: HOST,
    requestPath: `/__registry-probe?nonce=${nonce}`,
    expectedStatus: 403,
    observedStatus: 403,
    expectedBlockBodyDigest: 'b'.repeat(64),
    observedBlockBodyDigest: 'b'.repeat(64),
  };
}

describe('regional probe challenges', () => {
  it('binds a random one-use challenge to subject, slot-derived region, phase, host, and state', () => {
    const challenge = issueProbeChallenge(
      {
        host: HOST,
        phase: 'blocked-before-worker',
        expectedStateDigest: 'c'.repeat(64),
      },
      PRINCIPAL,
      NOW,
      'nonce-1',
    );
    expect(challenge).toMatchObject({
      probeNonce: 'nonce-1',
      subject: 'probe-sub-1',
      region: 'us-west1',
      phase: 'blocked-before-worker',
      host: HOST,
      consumed: false,
    });
    expect(challenge.expiresAt).toBe(NOW + 5 * 60_000);
  });

  it('accepts an exact fresh observation and marks the challenge consumed', () => {
    const challenge = issueProbeChallenge(
      {
        host: HOST,
        phase: 'blocked-before-worker',
        expectedStateDigest: 'c'.repeat(64),
      },
      PRINCIPAL,
      NOW,
      'nonce-1',
    );
    const result = acceptProbeAttestation(challenge, blockedObservation(), PRINCIPAL, NOW, 'attestation-1');
    expect(result.challenge.consumed).toBe(true);
    expect(result.attestation).toMatchObject({
      id: 'attestation-1',
      subject: 'probe-sub-1',
      region: 'us-west1',
      observation: { rayId: 'ray-1' },
    });
  });

  it('rejects an absolute runner URL even when its path and nonce match', () => {
    const challenge = issueProbeChallenge(
      {
        host: HOST,
        phase: 'blocked-before-worker',
        expectedStateDigest: 'c'.repeat(64),
      },
      PRINCIPAL,
      NOW,
      'nonce-1',
    );
    expect(() =>
      acceptProbeAttestation(
        challenge,
        { ...blockedObservation(), requestPath: 'https://attacker.invalid/__registry-probe?nonce=nonce-1' },
        PRINCIPAL,
        NOW,
        'attestation-1',
      ),
    ).toThrow('request identity');
  });

  it.each([
    [
      'replay',
      (challenge: ReturnType<typeof issueProbeChallenge>) => ({
        ...challenge,
        consumed: true,
      }),
    ],
    [
      'wrong subject',
      (challenge: ReturnType<typeof issueProbeChallenge>) => ({
        ...challenge,
        subject: 'other',
      }),
    ],
    [
      'expired',
      (challenge: ReturnType<typeof issueProbeChallenge>) => ({
        ...challenge,
        expiresAt: NOW - 1,
      }),
    ],
  ])('rejects %s', (_label, change) => {
    const challenge = change(
      issueProbeChallenge(
        {
          host: HOST,
          phase: 'blocked-before-worker',
          expectedStateDigest: 'c'.repeat(64),
        },
        PRINCIPAL,
        NOW,
        'nonce-1',
      ),
    );
    expect(() => acceptProbeAttestation(challenge, blockedObservation(), PRINCIPAL, NOW, 'attestation-1')).toThrow();
  });

  it('rejects a forged nonce, host, wrong phase, caller-supplied region, or stale observation', () => {
    const challenge = issueProbeChallenge(
      {
        host: HOST,
        phase: 'blocked-before-worker',
        expectedStateDigest: 'c'.repeat(64),
      },
      PRINCIPAL,
      NOW,
      'nonce-1',
    );
    expect(() => acceptProbeAttestation(challenge, blockedObservation('forged'), PRINCIPAL, NOW, 'a')).toThrow('nonce');
    expect(() =>
      acceptProbeAttestation(
        challenge,
        { ...blockedObservation(), host: 'r2-other.fiveacross.app' },
        PRINCIPAL,
        NOW,
        'a',
      ),
    ).toThrow('host');
    expect(() =>
      acceptProbeAttestation(
        challenge,
        {
          ...blockedObservation(),
          phase: 'canonical-after-unblock',
        } as ProbeObservation,
        PRINCIPAL,
        NOW,
        'a',
      ),
    ).toThrow('phase');
    expect(() =>
      acceptProbeAttestation(
        challenge,
        {
          ...blockedObservation(),
          region: 'caller-chosen',
        } as unknown as ProbeObservation,
        PRINCIPAL,
        NOW,
        'a',
      ),
    ).toThrow('region');
    expect(() =>
      acceptProbeAttestation(
        challenge,
        { ...blockedObservation(), observedAt: '2026-08-19T12:30:00.000Z' },
        PRINCIPAL,
        NOW,
        'a',
      ),
    ).toThrow('stale');
  });

  it('pairs exactly three distinct configured runners to provider Ray/path/status evidence', () => {
    const attestations = [0, 1, 2].map((index) => {
      const principal = {
        subject: `probe-sub-${index}`,
        keyVersion: `probe-key/${index}`,
        keyFingerprint: String(index + 1).repeat(64),
        region: ['us-west1', 'us-east1', 'europe-west1'][index],
      };
      const nonce = `nonce-${index}`;
      const challenge = issueProbeChallenge(
        {
          host: HOST,
          phase: 'blocked-before-worker',
          expectedStateDigest: 'c'.repeat(64),
        },
        principal,
        NOW,
        nonce,
      );
      return acceptProbeAttestation(
        challenge,
        { ...blockedObservation(nonce), rayId: `ray-${index}` },
        principal,
        NOW,
        `att-${index}`,
      ).attestation;
    });
    const providers = attestations.map((attestation) => ({
      rayId: attestation.observation.rayId,
      host: HOST,
      path: '/__registry-probe',
      query: `nonce=${attestation.challenge.probeNonce}`,
      edgeResponseStatus: 403,
    }));
    expect(() =>
      matchProbeAttestations(
        attestations,
        attestations.map((attestation) => attestation.id),
        providers,
        'blocked-before-worker',
        { stateDigest: 'c'.repeat(64), now: NOW },
      ),
    ).not.toThrow();

    const wrongProviderQuery = providers.map((provider) => ({ ...provider }));
    wrongProviderQuery[0].query = 'nonce=different';
    expect(() =>
      matchProbeAttestations(
        attestations,
        attestations.map((attestation) => attestation.id),
        wrongProviderQuery,
        'blocked-before-worker',
        { stateDigest: 'c'.repeat(64), now: NOW },
      ),
    ).toThrow('provider request');

    const duplicateRunner = [...attestations];
    duplicateRunner[2] = {
      ...duplicateRunner[2],
      subject: duplicateRunner[0].subject,
    };
    expect(() =>
      matchProbeAttestations(
        duplicateRunner,
        duplicateRunner.map((attestation) => attestation.id),
        providers,
        'blocked-before-worker',
        { stateDigest: 'c'.repeat(64), now: NOW },
      ),
    ).toThrow('distinct');
  });

  it('rejects an expired stored attestation and a runner-invented canonical expectation', () => {
    const principal = PRINCIPAL;
    const challenge = issueProbeChallenge(
      {
        host: HOST,
        phase: 'canonical-after-unblock',
        expectedStateDigest: 'c'.repeat(64),
        recoveryLockId: 'lock-1',
        recoverySequence: '1',
        wafRemovedAt: WAF_REMOVED_AT,
      },
      principal,
      NOW,
      'nonce-canonical',
    );
    const observation: ProbeObservation = {
      phase: 'canonical-after-unblock',
      probeNonce: 'nonce-canonical',
      observedAt: new Date(NOW).toISOString(),
      rayId: 'ray-canonical',
      host: HOST,
      requestPath: '/__registry-probe?nonce=nonce-canonical',
      expectedStatus: 503,
      observedStatus: 503,
      expectedReason: 'inactive',
      observedReason: 'inactive',
      expectedRevision: '1',
      observedRevision: '1',
      expectedServesOrigin: false,
      observedServesOrigin: false,
      originRequestId: null,
    };
    const accepted = acceptProbeAttestation(challenge, observation, principal, NOW, 'canonical-1').attestation;
    const provider = [
      {
        rayId: observation.rayId,
        host: HOST,
        path: '/__registry-probe',
        query: 'nonce=nonce-canonical',
        edgeResponseStatus: 503,
      },
    ];
    const expected = {
      stateDigest: 'c'.repeat(64),
      now: NOW,
      canonical: {
        stateDigest: 'c'.repeat(64),
        status: 200,
        reason: null,
        revision: '1',
        servesOrigin: true,
        recoveryLockId: 'lock-1',
        recoverySequence: '1',
        wafRemovedAt: WAF_REMOVED_AT,
      } as const,
    };
    expect(() =>
      matchProbeAttestations(
        [accepted, accepted, accepted],
        ['canonical-1', 'canonical-1', 'canonical-1'],
        [provider[0], provider[0], provider[0]],
        'canonical-after-unblock',
        expected,
      ),
    ).toThrow('committed state');

    const stale = {
      ...accepted,
      receivedAt: new Date(NOW - 5 * 60_000 - 1).toISOString(),
    };
    expect(() =>
      matchProbeAttestations(
        [stale, stale, stale],
        ['canonical-1', 'canonical-1', 'canonical-1'],
        [provider[0], provider[0], provider[0]],
        'canonical-after-unblock',
        { ...expected, now: NOW + 1 },
      ),
    ).toThrow('provider request');
  });

  it('requires canonical challenge issuance strictly after the WAF removal timestamp', () => {
    expect(() =>
      issueProbeChallenge(
        {
          host: HOST,
          phase: 'canonical-after-unblock',
          expectedStateDigest: 'c'.repeat(64),
          recoveryLockId: 'lock-1',
          recoverySequence: '1',
          wafRemovedAt: new Date(NOW).toISOString(),
        },
        PRINCIPAL,
        NOW,
        'nonce-equal-boundary',
      ),
    ).toThrow('malformed');
  });
});
