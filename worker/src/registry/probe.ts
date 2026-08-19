const SHA256_HEX = /^[a-f0-9]{64}$/;
const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const OBSERVATION_LIFETIME_MS = 60_000;

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

export function matchProbeAttestations(
  attestations: readonly ProbeAttestation[],
  expectedIds: readonly string[],
  providerRequests: readonly { rayId: string; host: string; path: string; edgeResponseStatus: number }[],
  phase: ProbePhase,
): void {
  if (attestations.length !== 3 || expectedIds.length !== 3 || providerRequests.length !== 3) {
    throw new Error('exactly three probe attestations required');
  }
  const subjects = new Set<string>();
  const keys = new Set<string>();
  const regions = new Set<string>();
  for (const [index, attestation] of attestations.entries()) {
    const provider = providerRequests[index];
    if (
      attestation.id !== expectedIds[index] ||
      attestation.challenge.consumed !== true ||
      attestation.observation.phase !== phase ||
      attestation.observation.host !== provider.host ||
      attestation.observation.rayId !== provider.rayId ||
      attestation.observation.requestPath !== provider.path ||
      attestation.observation.observedStatus !== provider.edgeResponseStatus
    ) {
      throw new Error('probe attestation does not match provider request');
    }
    subjects.add(attestation.subject);
    keys.add(attestation.keyFingerprint);
    regions.add(attestation.region);
  }
  if (subjects.size !== 3 || keys.size !== 3 || regions.size !== 3) {
    throw new Error('probe runners, keys, and regions must be distinct');
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
    throw new Error('probe challenge input malformed');
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
  if (challenge.consumed) throw new Error('probe challenge already consumed');
  if (now > challenge.expiresAt) throw new Error('probe challenge expired');
  if (
    challenge.subject !== principal.subject ||
    challenge.keyVersion !== principal.keyVersion ||
    challenge.keyFingerprint !== principal.keyFingerprint ||
    challenge.region !== principal.region
  ) {
    throw new Error('probe challenge subject or key does not match');
  }
  if (Object.prototype.hasOwnProperty.call(observation, 'region')) {
    throw new Error('probe observation must not choose a region');
  }
  if (observation.probeNonce !== challenge.probeNonce) throw new Error('probe nonce mismatch');
  if (observation.host !== challenge.host) throw new Error('probe host mismatch');
  if (observation.phase !== challenge.phase) throw new Error('probe phase mismatch');
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > OBSERVATION_LIFETIME_MS) {
    throw new Error('probe observation is stale or future');
  }
  if (observation.rayId.length === 0 || !observation.requestPath.includes(challenge.probeNonce)) {
    throw new Error('probe observation request identity mismatch');
  }
  if (observation.expectedStatus !== observation.observedStatus) {
    throw new Error('probe response status mismatch');
  }
  if (observation.phase === 'blocked-before-worker') {
    if (
      !SHA256_HEX.test(observation.expectedBlockBodyDigest) ||
      observation.expectedBlockBodyDigest !== observation.observedBlockBodyDigest
    ) {
      throw new Error('probe block response mismatch');
    }
  } else if (
    observation.expectedReason !== observation.observedReason ||
    observation.expectedRevision !== observation.observedRevision ||
    observation.expectedServesOrigin !== observation.observedServesOrigin
  ) {
    throw new Error('probe canonical response mismatch');
  }
  if (attestationId.length === 0) throw new Error('attestation id is required');
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
