import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { classifyHost, normalizeHost } from '../host';
import {
  REGISTRY_LOCATION_HINT,
  isSyntheticRegistryHost,
  type RegistryState,
  type RouterReplicaDesired,
} from './contracts';
import {
  REGISTRY_ROLE_AUDIENCES,
  REGISTRY_SYNC_AUDIENCE,
  REGISTRY_VERIFICATION_RECORDS,
} from './verificationRecords';
import { GoogleJwksCache } from './oidc';
import {
  handleRegistryFetch,
  type HostRegistryNamespace,
  type RegistryRateLimiter,
} from './service';
import { applyPublisherSync, initialRegistryState, registryLookup, type RegistryLookup } from './state';
import { AUDIT_PAGE_SIZE, createAuditPage, type RegistryAuditPage } from './audit';
import { applyRecovery, type RecoveryRecord, type RecoveryRequest } from './recovery';
import {
  acceptProbeAttestation,
  issueProbeChallenge,
  matchProbeAttestations,
  type ProbeAttestation,
  type ProbeChallenge,
  type ProbeObservation,
  type ProbePhase,
  type ProbePrincipal,
} from './probe';

const STATE_KEY = 'registry-state';
const HISTORY_PREFIX = 'recovery/';
const CHALLENGE_PREFIX = 'probe/challenge/';
const ATTESTATION_PREFIX = 'probe/attestation/';

function decimalKey(prefix: string, value: string): string {
  return `${prefix}${value.length.toString().padStart(6, '0')}:${value}`;
}

function opaqueKey(prefix: string, value: string): string {
  return `${prefix}${encodeURIComponent(value)}`;
}

export interface RegistryWorkerEnv {
  HOST_REGISTRY?: DurableObjectNamespace<HostRegistryObject>;
  REGISTRY_RATE_LIMITER?: RateLimit;
  REGISTRY_VERSION?: string;
}

function isRegistryState(value: unknown): value is RegistryState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Partial<RegistryState>;
  return (
    (state.committed === null || typeof state.committed === 'object') &&
    typeof state.minimumPublisherEpoch === 'string' &&
    typeof state.highestAuthenticatedPublisherEpoch === 'string' &&
    typeof state.highestQuarantinedPublisherEpoch === 'string' &&
    (state.recoveryLock === null || typeof state.recoveryLock === 'object') &&
    typeof state.recoverySequence === 'string'
  );
}

export class HostRegistryObject extends DurableObject<RegistryWorkerEnv> {
  async sync(payload: RouterReplicaDesired, publisherEpoch: string) {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      if (stored !== undefined && !isRegistryState(stored)) {
        throw new Error('registry state malformed');
      }
      const result = await applyPublisherSync(stored ?? initialRegistryState(), payload, publisherEpoch);
      await transaction.put(STATE_KEY, result.state);
      return result.response;
    });
  }

  async lookup(): Promise<RegistryLookup> {
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY);
    if (stored === undefined) return { kind: 'unknown-host' };
    if (!isRegistryState(stored)) return { kind: 'unavailable' };
    try {
      return registryLookup(stored);
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async audit(afterRecoverySequence = '0'): Promise<RegistryAuditPage> {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : stored;
      if (!isRegistryState(state)) throw new Error('registry state malformed');
      const records = await transaction.list<RecoveryRecord>({
        prefix: HISTORY_PREFIX,
        startAfter: decimalKey(HISTORY_PREFIX, afterRecoverySequence),
        limit: AUDIT_PAGE_SIZE + 1,
      });
      return createAuditPage(state, [...records.values()], afterRecoverySequence);
    });
  }

  async recover(
    request: RecoveryRequest,
    context: {
      now: number;
      operatorSub: string;
      lockId: string;
      publisherIntegrityProven?: boolean;
    },
  ): Promise<{ sequence: string; action: RecoveryRecord['action'] }> {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state = stored === undefined ? initialRegistryState() : stored;
      if (!isRegistryState(state)) throw new Error('registry state malformed');
      const result = await applyRecovery(state, request, {
        ...context,
        consumeAttestations: async (ids, phase) => {
          const keys = ids.map((id) => opaqueKey(ATTESTATION_PREFIX, id));
          const storedAttestations = await transaction.get<ProbeAttestation>(keys);
          const attestations = keys.map((key) => storedAttestations.get(key));
          if (attestations.some((attestation) => attestation === undefined)) {
            throw new Error('probe attestation is missing or already consumed');
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
          );
          await transaction.delete(keys);
        },
      });
      await transaction.put(STATE_KEY, result.state);
      await transaction.put(decimalKey(HISTORY_PREFIX, result.record.sequence), result.record);
      return { sequence: result.record.sequence, action: result.record.action };
    });
  }

  async issueProbeChallenge(
    request: { host: string; phase: ProbePhase; expectedStateDigest: string },
    principal: ProbePrincipal,
    now: number,
    nonce: string,
  ): Promise<ProbeChallenge> {
    const challenge = issueProbeChallenge(request, principal, now, nonce);
    const key = opaqueKey(CHALLENGE_PREFIX, nonce);
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get(key)) !== undefined) throw new Error('probe challenge collision');
      await transaction.put(key, challenge);
      return challenge;
    });
  }

  async attestProbe(
    observation: ProbeObservation,
    principal: ProbePrincipal,
    now: number,
    attestationId: string,
  ): Promise<ProbeAttestation> {
    const challengeKey = opaqueKey(CHALLENGE_PREFIX, observation.probeNonce);
    const attestationKey = opaqueKey(ATTESTATION_PREFIX, attestationId);
    return this.ctx.storage.transaction(async (transaction) => {
      const challenge = await transaction.get<ProbeChallenge>(challengeKey);
      if (challenge === undefined) throw new Error('probe challenge missing or already consumed');
      if ((await transaction.get(attestationKey)) !== undefined) {
        throw new Error('probe attestation collision');
      }
      const accepted = acceptProbeAttestation(challenge, observation, principal, now, attestationId);
      await transaction.delete(challengeKey);
      await transaction.put(attestationKey, accepted.attestation);
      return accepted.attestation;
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
      (classified.kind === 'rejected' && !isSyntheticRegistryHost(rawHost))
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
