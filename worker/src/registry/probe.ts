const SHA256_HEX = /^[a-f0-9]{64}$/;
const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const OBSERVATION_LIFETIME_MS = 60_000;
const STORED_ATTESTATION_LIFETIME_MS = 5 * 60_000;

export class ProbeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefusedError';
  }
}

function refuse(message: string): never {
  throw new ProbeRefusedError(message);
}

export type ProbePhase = 'blocked-before-worker' | 'canonical-after-unblock';

export type ProbePrincipal = {
  subject: string;
  keyVersion: string;
  keyFingerprint: string;
  region: string;
};

export type ProbeChallenge = {
  probeNonce: string;
  subject: string;
  keyVersion: string;
  keyFingerprint: string;
  region: string;
  phase: ProbePhase;
  host: string;
  expectedStateDigest: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
};

export type ProbeObservation =
  | {
      phase: 'blocked-before-worker';
      probeNonce: string;
      observedAt: string;
      rayId: string;
      host: string;
      requestPath: string;
      expectedStatus: 403;
      observedStatus: 403;
      expectedBlockBodyDigest: string;
      observedBlockBodyDigest: string;
    }
  | {
      phase: 'canonical-after-unblock';
      probeNonce: string;
      observedAt: string;
      rayId: string;
      host: string;
      requestPath: string;
      expectedStatus: number;
      observedStatus: number;
      expectedReason: null | 'inactive' | 'unknown-host';
      observedReason: null | 'inactive' | 'unknown-host';
      expectedRevision: string;
      observedRevision: string;
      expectedServesOrigin: boolean;
      observedServesOrigin: boolean;
      originRequestId: string | null;
    };

export type ProbeAttestation = {
  id: string;
  receivedAt: string;
  subject: string;
  keyVersion: string;
  keyFingerprint: string;
  region: string;
  challenge: ProbeChallenge;
  observation: ProbeObservation;
};

export type CanonicalProbeExpectation = {
  stateDigest: string;
  status: number;
  reason: null | 'inactive' | 'unknown-host';
  revision: string;
  servesOrigin: boolean;
};

export function matchProbeAttestations(
  attestations: readonly ProbeAttestation[],
  expectedIds: readonly string[],
  providerRequests: readonly {
    rayId: string;
    host: string;
    path: string;
    edgeResponseStatus: number;
  }[],
  phase: ProbePhase,
  expected: {
    stateDigest: string;
    now: number;
    canonical?: CanonicalProbeExpectation;
  },
): void {
  if (attestations.length !== 3 || expectedIds.length !== 3 || providerRequests.length !== 3) {
    refuse('exactly three probe attestations required');
  }
  const subjects = new Set<string>();
  const keys = new Set<string>();
  const regions = new Set<string>();
  for (const [index, attestation] of attestations.entries()) {
    const provider = providerRequests[index];
    const receivedAt = Date.parse(attestation.receivedAt);
    if (
      attestation.id !== expectedIds[index] ||
      attestation.challenge.consumed !== true ||
      attestation.observation.phase !== phase ||
      attestation.observation.host !== provider.host ||
      attestation.observation.rayId !== provider.rayId ||
      attestation.observation.requestPath !== provider.path ||
      attestation.observation.observedStatus !== provider.edgeResponseStatus ||
      attestation.challenge.expectedStateDigest !== expected.stateDigest ||
      !Number.isFinite(receivedAt) ||
      receivedAt > expected.now ||
      expected.now - receivedAt > STORED_ATTESTATION_LIFETIME_MS ||
      receivedAt > attestation.challenge.expiresAt ||
      expected.now > attestation.challenge.expiresAt
    ) {
      refuse('probe attestation does not match provider request');
    }
    if (phase === 'canonical-after-unblock') {
      const observation = attestation.observation;
      const canonical = expected.canonical;
      if (
        observation.phase !== 'canonical-after-unblock' ||
        canonical === undefined ||
        canonical.stateDigest !== expected.stateDigest ||
        observation.expectedStatus !== canonical.status ||
        observation.observedStatus !== canonical.status ||
        observation.expectedReason !== canonical.reason ||
        observation.observedReason !== canonical.reason ||
        observation.expectedRevision !== canonical.revision ||
        observation.observedRevision !== canonical.revision ||
        observation.expectedServesOrigin !== canonical.servesOrigin ||
        observation.observedServesOrigin !== canonical.servesOrigin ||
        (canonical.servesOrigin
          ? observation.originRequestId === null || observation.originRequestId.length === 0
          : observation.originRequestId !== null)
      ) {
        refuse('canonical probe does not match committed state');
      }
    }
    subjects.add(attestation.subject);
    keys.add(attestation.keyFingerprint);
    regions.add(attestation.region);
  }
  if (subjects.size !== 3 || keys.size !== 3 || regions.size !== 3) {
    refuse('probe runners, keys, and regions must be distinct');
  }
}

export function issueProbeChallenge(
  request: { host: string; phase: ProbePhase; expectedStateDigest: string },
  principal: ProbePrincipal,
  now: number,
  probeNonce: string,
): ProbeChallenge {
  if (
    request.host.length === 0 ||
    !SHA256_HEX.test(request.expectedStateDigest) ||
    principal.subject.length === 0 ||
    principal.keyVersion.length === 0 ||
    !SHA256_HEX.test(principal.keyFingerprint) ||
    principal.region.length === 0 ||
    probeNonce.length < 7
  ) {
    refuse('probe challenge input malformed');
  }
  return {
    probeNonce,
    subject: principal.subject,
    keyVersion: principal.keyVersion,
    keyFingerprint: principal.keyFingerprint,
    region: principal.region,
    phase: request.phase,
    host: request.host,
    expectedStateDigest: request.expectedStateDigest,
    issuedAt: now,
    expiresAt: now + CHALLENGE_LIFETIME_MS,
    consumed: false,
  };
}

export function acceptProbeAttestation(
  challenge: ProbeChallenge,
  observation: ProbeObservation,
  principal: ProbePrincipal,
  now: number,
  attestationId: string,
): { challenge: ProbeChallenge; attestation: ProbeAttestation } {
  if (challenge.consumed) refuse('probe challenge already consumed');
  if (now > challenge.expiresAt) refuse('probe challenge expired');
  if (
    challenge.subject !== principal.subject ||
    challenge.keyVersion !== principal.keyVersion ||
    challenge.keyFingerprint !== principal.keyFingerprint ||
    challenge.region !== principal.region
  ) {
    refuse('probe challenge subject or key does not match');
  }
  if (Object.prototype.hasOwnProperty.call(observation, 'region')) {
    refuse('probe observation must not choose a region');
  }
  if (observation.probeNonce !== challenge.probeNonce) refuse('probe nonce mismatch');
  if (observation.host !== challenge.host) refuse('probe host mismatch');
  if (observation.phase !== challenge.phase) refuse('probe phase mismatch');
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > OBSERVATION_LIFETIME_MS) {
    refuse('probe observation is stale or future');
  }
  if (observation.rayId.length === 0 || !observation.requestPath.includes(challenge.probeNonce)) {
    refuse('probe observation request identity mismatch');
  }
  if (observation.expectedStatus !== observation.observedStatus) {
    refuse('probe response status mismatch');
  }
  if (observation.phase === 'blocked-before-worker') {
    if (
      !SHA256_HEX.test(observation.expectedBlockBodyDigest) ||
      observation.expectedBlockBodyDigest !== observation.observedBlockBodyDigest
    ) {
      refuse('probe block response mismatch');
    }
  } else if (
    observation.expectedReason !== observation.observedReason ||
    observation.expectedRevision !== observation.observedRevision ||
    observation.expectedServesOrigin !== observation.observedServesOrigin
  ) {
    refuse('probe canonical response mismatch');
  }
  if (attestationId.length === 0) refuse('attestation id is required');
  const consumed = { ...challenge, consumed: true };
  return {
    challenge: consumed,
    attestation: {
      id: attestationId,
      receivedAt: new Date(now).toISOString(),
      subject: principal.subject,
      keyVersion: principal.keyVersion,
      keyFingerprint: principal.keyFingerprint,
      region: principal.region,
      challenge: consumed,
      observation,
    },
  };
}
