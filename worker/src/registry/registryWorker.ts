import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { classifyHost, normalizeHost } from '../host';
import {
  REGISTRY_LOCATION_HINT,
  isRegistryRootHost,
  isSyntheticRegistryHost,
  type RouterReplicaDesired,
} from './contracts';
import {
  REGISTRY_ROLE_AUDIENCES,
  REGISTRY_AUDIT_SUBJECT,
  REGISTRY_SYNC_AUDIENCE,
  REGISTRY_VERIFICATION_RECORDS,
} from './verificationRecords';
import { GoogleJwksCache } from './oidc';
import { handleRegistryFetch, type HostRegistryNamespace, type RegistryRateLimiter } from './service';
import { applyPublisherSync, initialRegistryState, registryLookup, type RegistryLookup } from './state';
import { AUDIT_PAGE_SIZE, createAuditPage, type RegistryAuditPage } from './audit';
import { applyRecovery, type RecoveryRecord, type RecoveryRequest } from './recovery';
import {
  acceptProbeAttestation,
  issueProbeChallenge,
  matchProbeAttestations,
  ProbeRefusedError,
  type CanonicalProbeExpectation,
  type ProbeAttestation,
  type ProbeChallenge,
  type ProbeObservation,
  type ProbePhase,
  type ProbePrincipal,
} from './probe';
import { parseStoredRegistryState } from './storedState';

const STATE_KEY = 'registry-state';
const HISTORY_PREFIX = 'recovery/';
const CHALLENGE_PREFIX = 'probe/challenge/';
const ATTESTATION_PREFIX = 'probe/attestation/';

class RegistryStorageError extends Error {
  constructor(readonly storageCause: unknown) {
    super('registry storage unavailable');
    this.name = 'RegistryStorageError';
  }
}

function decimalKey(prefix: string, value: string): string {
  return `${prefix}${value.length.toString().padStart(6, '0')}:${value}`;
}

function opaqueKey(prefix: string, value: string): string {
  return `${prefix}${encodeURIComponent(value)}`;
}

function canonicalProbeExpectation(
  committed: NonNullable<Awaited<ReturnType<typeof parseStoredRegistryState>>['committed']>,
): CanonicalProbeExpectation {
  const desired = committed.payload.desired;
  if (desired.kind === 'tombstone') {
    return {
      stateDigest: committed.digest,
      status: 404,
      reason: 'unknown-host',
      revision: committed.revision,
      servesOrigin: false,
    };
  }
  if (desired.kind === 'route' && desired.status !== 'active') {
    return {
      stateDigest: committed.digest,
      status: 404,
      reason: 'inactive',
      revision: committed.revision,
      servesOrigin: false,
    };
  }
  return {
    stateDigest: committed.digest,
    status: 200,
    reason: null,
    revision: committed.revision,
    servesOrigin: true,
  };
}

export interface RegistryWorkerEnv {
  HOST_REGISTRY?: DurableObjectNamespace<HostRegistryObject>;
  REGISTRY_RATE_LIMITER?: RateLimit;
  REGISTRY_VERSION?: string;
}

export class HostRegistryObject extends DurableObject<RegistryWorkerEnv> {
  async sync(payload: RouterReplicaDesired, publisherEpoch: string) {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored);
      const result = await applyPublisherSync(state, payload, publisherEpoch);
      await transaction.put(STATE_KEY, result.state);
      return result.response;
    });
  }

  async lookup(): Promise<RegistryLookup> {
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY);
    if (stored === undefined) return { kind: 'unknown-host' };
    try {
      return registryLookup(await parseStoredRegistryState(stored));
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async audit(
    afterRecoverySequence = '0',
  ): Promise<{ ok: true; page: RegistryAuditPage } | { ok: false; error: 'invalid-cursor' }> {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored);
      if (
        !/^(?:0|[1-9]\d*)$/.test(afterRecoverySequence) ||
        BigInt(afterRecoverySequence) > BigInt(state.recoverySequence)
      ) {
        return { ok: false as const, error: 'invalid-cursor' as const };
      }
      const records = await transaction.list<RecoveryRecord>({
        prefix: HISTORY_PREFIX,
        startAfter: decimalKey(HISTORY_PREFIX, afterRecoverySequence),
        limit: AUDIT_PAGE_SIZE + 1,
      });
      return {
        ok: true as const,
        page: createAuditPage(state, [...records.values()], afterRecoverySequence),
      };
    });
  }

  async recover(
    request: RecoveryRequest,
    context: {
      now: number;
      operatorSub: string;
      lockId: string;
      publisherIntegrityProven?: boolean;
      activeRegistryConfigDigest?: string;
    },
  ): Promise<
    { ok: true; sequence: string; action: RecoveryRecord['action'] } | { ok: false; error: 'recovery-refused' }
  > {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored);
      let result: Awaited<ReturnType<typeof applyRecovery>>;
      try {
        result = await applyRecovery(state, request, {
          ...context,
          consumeAttestations: async (ids, phase) => {
            const keys = ids.map((id) => opaqueKey(ATTESTATION_PREFIX, id));
            let storedAttestations: Map<string, ProbeAttestation>;
            try {
              storedAttestations = await transaction.get<ProbeAttestation>(keys);
            } catch (error) {
              throw new RegistryStorageError(error);
            }
            const attestations = keys.map((key) => storedAttestations.get(key));
            if (attestations.some((attestation) => attestation === undefined)) {
              throw new ProbeRefusedError('probe attestation is missing or already consumed');
            }
            const providerRequests =
              request.action.kind === 'clear-lock'
                ? request.action.providerRequests
                : request.action.kind === 'acquire-lock' || request.action.kind === 'abort-lock'
                  ? request.action.wafEvidence.providerRequests
                  : [];
            matchProbeAttestations(
              attestations as ProbeAttestation[],
              ids,
              providerRequests,
              phase === 'blocked' ? 'blocked-before-worker' : 'canonical-after-unblock',
              {
                stateDigest: state.committed?.digest ?? '',
                now: context.now,
                canonical:
                  phase === 'canonical' && state.committed !== null
                    ? canonicalProbeExpectation(state.committed)
                    : undefined,
              },
            );
            for (const attestation of attestations as ProbeAttestation[]) {
              if (phase === 'blocked') {
                const expectedDigest =
                  request.action.kind === 'acquire-lock' || request.action.kind === 'abort-lock'
                    ? request.action.wafEvidence.providerRule.customResponseBodyDigest
                    : null;
                if (
                  attestation.observation.phase !== 'blocked-before-worker' ||
                  attestation.observation.observedBlockBodyDigest !== expectedDigest
                ) {
                  throw new ProbeRefusedError('blocked probe does not match the active WAF response');
                }
              } else if (
                attestation.observation.phase !== 'canonical-after-unblock' ||
                attestation.observation.observedRevision !== request.sourceAudit.revision
              ) {
                throw new ProbeRefusedError('canonical probe does not match the committed source revision');
              }
            }
            try {
              await transaction.delete(keys);
            } catch (error) {
              throw new RegistryStorageError(error);
            }
          },
        });
      } catch (error) {
        if (error instanceof RegistryStorageError) throw error.storageCause;
        return { ok: false as const, error: 'recovery-refused' as const };
      }
      await transaction.put(STATE_KEY, result.state);
      await transaction.put(decimalKey(HISTORY_PREFIX, result.record.sequence), result.record);
      return {
        ok: true as const,
        sequence: result.record.sequence,
        action: result.record.action,
      };
    });
  }

  async issueProbeChallenge(
    request: { host: string; phase: ProbePhase; expectedStateDigest: string },
    principal: ProbePrincipal,
    now: number,
    nonce: string,
  ): Promise<{ ok: true; challenge: ProbeChallenge } | { ok: false; error: 'probe-refused' }> {
    const key = opaqueKey(CHALLENGE_PREFIX, nonce);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored);
      if (state.committed === null || request.expectedStateDigest !== state.committed.digest) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      let challenge: ProbeChallenge;
      try {
        challenge = issueProbeChallenge(request, principal, now, nonce);
      } catch {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      if ((await transaction.get(key)) !== undefined) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      await transaction.put(key, challenge);
      return { ok: true as const, challenge };
    });
  }

  async attestProbe(
    observation: ProbeObservation,
    principal: ProbePrincipal,
    now: number,
    attestationId: string,
  ): Promise<{ ok: true; attestation: ProbeAttestation } | { ok: false; error: 'probe-refused' }> {
    const challengeKey = opaqueKey(CHALLENGE_PREFIX, observation.probeNonce);
    const attestationKey = opaqueKey(ATTESTATION_PREFIX, attestationId);
    return this.ctx.storage.transaction(async (transaction) => {
      const challenge = await transaction.get<ProbeChallenge>(challengeKey);
      if (challenge === undefined) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      if ((await transaction.get(attestationKey)) !== undefined) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      let accepted: ReturnType<typeof acceptProbeAttestation>;
      try {
        accepted = acceptProbeAttestation(challenge, observation, principal, now, attestationId);
      } catch {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      await transaction.delete(challengeKey);
      await transaction.put(attestationKey, accepted.attestation);
      return { ok: true as const, attestation: accepted.attestation };
    });
  }
}

export interface RegistryLookupService {
  lookup(host: string): Promise<RegistryLookup>;
}

export class RegistryLookupEntrypoint extends WorkerEntrypoint<RegistryWorkerEnv> {
  async lookup(rawHost: string): Promise<RegistryLookup> {
    const host = normalizeHost(rawHost);
    const classified = classifyHost(rawHost);
    if (
      host !== rawHost ||
      (classified.kind === 'rejected' && !isSyntheticRegistryHost(rawHost) && !isRegistryRootHost(rawHost))
    ) {
      return { kind: 'unknown-host' };
    }
    const namespace = this.env.HOST_REGISTRY;
    if (namespace === undefined) return { kind: 'unavailable' };
    try {
      return await namespace.getByName(host, { locationHint: REGISTRY_LOCATION_HINT }).lookup();
    } catch {
      return { kind: 'unavailable' };
    }
  }
}

let jwks: GoogleJwksCache | null = null;

export default {
  async fetch(request: Request, env: RegistryWorkerEnv): Promise<Response> {
    if (env.HOST_REGISTRY === undefined || env.REGISTRY_RATE_LIMITER === undefined) {
      return Response.json(
        { error: 'configuration-unavailable' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    jwks ??= new GoogleJwksCache({
      fetch: (url) => fetch(url),
      now: () => Date.now(),
    });
    return handleRegistryFetch(
      request,
      {
        audience: REGISTRY_SYNC_AUDIENCE,
        auditSubject: REGISTRY_AUDIT_SUBJECT,
        roleAudiences: REGISTRY_ROLE_AUDIENCES,
        verificationRecords: REGISTRY_VERIFICATION_RECORDS,
      },
      {
        now: () => Date.now(),
        jwks,
        hostRegistry: env.HOST_REGISTRY as unknown as HostRegistryNamespace,
        rateLimiter: env.REGISTRY_RATE_LIMITER as unknown as RegistryRateLimiter,
        randomId: () => crypto.randomUUID(),
      },
    );
  },
} satisfies ExportedHandler<RegistryWorkerEnv>;
