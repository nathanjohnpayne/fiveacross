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
  REGISTRY_RECOVERY_ZONES,
  REGISTRY_SYNC_AUDIENCE,
  REGISTRY_VERIFICATION_RECORDS,
} from './verificationRecords';
import { GoogleJwksCache } from './oidc';
import { handleRegistryFetch, type HostRegistryNamespace, type RegistryRateLimiter } from './service';
import { applyPublisherSync, initialRegistryState, registryLookup, type RegistryLookup } from './state';
import { AUDIT_PAGE_SIZE, createAuditPage, type RegistryAuditPage } from './audit';
import { applyRecovery, type ActivePublisherMapping, type RecoveryRecord, type RecoveryRequest } from './recovery';
import {
  parseRecoveryHistoryEntry,
  RECOVERY_HISTORY_PREFIX,
  recoveryHistoryKey,
} from './recoveryHistory';
import {
  acceptProbeAttestation,
  consumedProbeEvidence,
  issueProbeChallenge,
  matchProbeAttestations,
  probeAttestationExpiresAt,
  ProbeRefusedError,
  type CanonicalProbeExpectation,
  type ProbeAttestation,
  type ProbeChallenge,
  type ProbeChallengeRequest,
  type ProbeObservation,
  type ProbePrincipal,
} from './probe';
import { parseStoredRegistryState } from './storedState';
import {
  createCardinalitySemanticEvent,
  createRecoverySemanticEvent,
  emitRegistrySemanticEvent,
  isRegistryTelemetryVersion,
  type RegistrySemanticEvent,
} from './telemetry';
import {
  ATTESTATION_PREFIX,
  CHALLENGE_PREFIX,
  PROBE_EXPIRY_PREFIX,
  probeExpiryKey,
  probePrincipalKey,
  probePrincipalPrefix,
  sweepProbeArtifacts,
  type ProbeExpiryIndex,
} from './probeSweep';

const STATE_KEY = 'registry-state';
const HISTORY_PREFIX = RECOVERY_HISTORY_PREFIX;
const PROBE_MAX_OUTSTANDING_PER_HOST = 48;
const PROBE_MAX_OUTSTANDING_PER_PRINCIPAL = 4;
const PROBE_SWEEP_RETRY_MS = 60_000;

function emitSemanticSafely(
  registryVersion: string | undefined,
  create: (validatedRegistryVersion: string) => RegistrySemanticEvent,
): void {
  if (!isRegistryTelemetryVersion(registryVersion)) return;
  try {
    emitRegistrySemanticEvent(create(registryVersion));
  } catch {
    // Logging must not turn a committed registry operation into a retry.
  }
}

class RegistryStorageError extends Error {
  constructor(readonly storageCause: unknown) {
    super('registry storage unavailable');
    this.name = 'RegistryStorageError';
  }
}

function opaqueKey(prefix: string, value: string): string {
  return `${prefix}${encodeURIComponent(value)}`;
}

async function scheduleProbeSweep(transaction: DurableObjectTransaction, expiresAt: number): Promise<void> {
  const scheduledAt = expiresAt + 1;
  const current = await transaction.getAlarm();
  if (current === null || scheduledAt < current) await transaction.setAlarm(scheduledAt);
}

function canonicalProbeExpectation(
  committed: NonNullable<Awaited<ReturnType<typeof parseStoredRegistryState>>['committed']>,
  recoveryLockId: string,
  recoverySequence: string,
  wafRemovedAt: string,
): CanonicalProbeExpectation {
  const desired = committed.payload.desired;
  if (desired.kind === 'tombstone') {
    return {
      stateDigest: committed.digest,
      status: 404,
      reason: 'unknown-host',
      revision: committed.revision,
      servesOrigin: false,
      recoveryLockId,
      recoverySequence,
      wafRemovedAt,
    };
  }
  if (desired.kind === 'route' && desired.status !== 'active') {
    return {
      stateDigest: committed.digest,
      status: 404,
      reason: 'inactive',
      revision: committed.revision,
      servesOrigin: false,
      recoveryLockId,
      recoverySequence,
      wafRemovedAt,
    };
  }
  return {
    stateDigest: committed.digest,
    status: 200,
    reason: null,
    revision: committed.revision,
    servesOrigin: true,
    recoveryLockId,
    recoverySequence,
    wafRemovedAt,
  };
}

export interface RegistryWorkerEnv {
  HOST_REGISTRY?: DurableObjectNamespace<HostRegistryObject>;
  REGISTRY_RATE_LIMITER?: RateLimit;
  REGISTRY_VERSION?: string;
}

export class HostRegistryObject extends DurableObject<RegistryWorkerEnv> {
  #host(): string {
    const host = this.ctx.id.name;
    if (host === undefined) throw new Error('registry object is not name-addressed');
    return host;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      await this.ctx.storage.transaction((transaction) => sweepProbeArtifacts(transaction, now));
    } catch (error) {
      // Cloudflare's automatic retries are bounded. Persist our own retry alarm
      // as well so a prolonged storage outage cannot turn five-minute probe
      // evidence into indefinitely retained state.
      try {
        await this.ctx.storage.setAlarm(now + PROBE_SWEEP_RETRY_MS);
      } catch {
        // Throwing preserves the platform retry when even the retry write is
        // unavailable; the next successful attempt sets the durable alarm.
      }
      throw error;
    }
  }

  async sync(payload: RouterReplicaDesired, publisherEpoch: string) {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state =
        stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored, this.#host());
      const result = await applyPublisherSync(state, payload, publisherEpoch);
      await transaction.put(STATE_KEY, result.state);
      return result.response;
    });
  }

  async lookup(telemetryHost?: string): Promise<RegistryLookup> {
    const startedAt = Date.now();
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY);
    if (stored === undefined) {
      if (telemetryHost !== undefined) {
        emitSemanticSafely(this.env.REGISTRY_VERSION, (registryVersion) =>
          createCardinalitySemanticEvent({
            registryVersion,
            host: telemetryHost,
            startedAt,
            finishedAt: Date.now(),
          }),
        );
      }
      return { kind: 'unknown-host' };
    }
    try {
      return registryLookup(await parseStoredRegistryState(stored, this.#host()));
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async audit(
    afterRecoverySequence = '0',
  ): Promise<{ ok: true; page: RegistryAuditPage } | { ok: false; error: 'invalid-cursor' }> {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state =
        stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored, this.#host());
      if (
        !/^(?:0|[1-9]\d*)$/.test(afterRecoverySequence) ||
        BigInt(afterRecoverySequence) > BigInt(state.recoverySequence)
      ) {
        return { ok: false as const, error: 'invalid-cursor' as const };
      }
      const records = await transaction.list<unknown>({
        prefix: HISTORY_PREFIX,
        startAfter: recoveryHistoryKey(afterRecoverySequence),
        limit: AUDIT_PAGE_SIZE + 1,
      });
      const parsedRecords = [...records.entries()].map(([key, value]) =>
        parseRecoveryHistoryEntry(key, value),
      );
      return {
        ok: true as const,
        page: createAuditPage(state, parsedRecords, afterRecoverySequence),
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
      activePublisherMappings?: readonly ActivePublisherMapping[];
      operatorKeyVersion: string;
      operatorKeyFingerprint: string;
      operatorSignature: string;
      operatorSignatureScheme: 'v1';
      operatorSignedRole: 'recovery';
      operatorSignedMethod: 'POST';
      operatorSignedPath: string;
      operatorIssuedAt: string;
      requestBodyDigest: string;
      expectedWafZone: {
        namespace: 'fiveacross.app' | 'vacaybingo.com';
        zoneId: string;
        rulesetId: string;
      };
    },
  ): Promise<
    { ok: true; sequence: string; action: RecoveryRecord['action'] } | { ok: false; error: 'recovery-refused' }
  > {
    const startedAt = Date.now();
    const response = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state =
        stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored, this.#host());
      let result: Awaited<ReturnType<typeof applyRecovery>>;
      let consumedAttestationKeys: string[] = [];
      let consumedAttestationExpiryKeys: string[] = [];
      let consumedAttestationPrincipalKeys: string[] = [];
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
                  phase === 'canonical' &&
                  state.committed !== null &&
                  state.recoveryLock !== null &&
                  request.action.kind === 'clear-lock'
                    ? canonicalProbeExpectation(
                        state.committed,
                        state.recoveryLock.lockId,
                        state.recoverySequence,
                        request.action.wafRemovedAt,
                      )
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
            consumedAttestationKeys = keys;
            consumedAttestationExpiryKeys = (attestations as ProbeAttestation[]).map((attestation, index) =>
              probeExpiryKey(probeAttestationExpiresAt(attestation), keys[index]),
            );
            consumedAttestationPrincipalKeys = (attestations as ProbeAttestation[]).map((attestation, index) =>
              probePrincipalKey(attestation, keys[index]),
            );
            return (attestations as ProbeAttestation[]).map(consumedProbeEvidence);
          },
        });
      } catch (error) {
        if (error instanceof RegistryStorageError) throw error.storageCause;
        return { ok: false as const, error: 'recovery-refused' as const };
      }
      await transaction.put(STATE_KEY, result.state);
      await transaction.put(recoveryHistoryKey(result.record.sequence), result.record);
      if (consumedAttestationKeys.length > 0) {
        await transaction.delete([
          ...consumedAttestationKeys,
          ...consumedAttestationExpiryKeys,
          ...consumedAttestationPrincipalKeys,
        ]);
      }
      return {
        ok: true as const,
        sequence: result.record.sequence,
        action: result.record.action,
      };
    });
    if (response.ok) {
      emitSemanticSafely(this.env.REGISTRY_VERSION, (registryVersion) =>
        createRecoverySemanticEvent({
          registryVersion,
          host: request.host,
          revision: request.sourceAudit.revision,
          recoveryAction: response.action,
          keyVersion: context.operatorKeyVersion,
          startedAt,
          finishedAt: Date.now(),
        }),
      );
    }
    return response;
  }

  async issueProbeChallenge(
    request: ProbeChallengeRequest,
    principal: ProbePrincipal,
    now: number,
    nonce: string,
  ): Promise<{ ok: true; challenge: ProbeChallenge } | { ok: false; error: 'probe-refused' }> {
    const key = opaqueKey(CHALLENGE_PREFIX, nonce);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      const state =
        stored === undefined ? initialRegistryState() : await parseStoredRegistryState(stored, this.#host());
      if (state.committed === null || request.expectedStateDigest !== state.committed.digest) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      if (
        request.phase === 'canonical-after-unblock' &&
        (state.recoveryLock === null ||
          request.recoveryLockId !== state.recoveryLock.lockId ||
          request.recoverySequence !== state.recoverySequence ||
          Date.parse(request.wafRemovedAt) <= Date.parse(state.recoveryLock.acquiredAt))
      ) {
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
      const [hostOutstanding, principalOutstanding] = await Promise.all([
        transaction.list({ prefix: PROBE_EXPIRY_PREFIX, limit: PROBE_MAX_OUTSTANDING_PER_HOST }),
        transaction.list({
          prefix: probePrincipalPrefix(principal),
          limit: PROBE_MAX_OUTSTANDING_PER_PRINCIPAL,
        }),
      ]);
      if (
        hostOutstanding.size >= PROBE_MAX_OUTSTANDING_PER_HOST ||
        principalOutstanding.size >= PROBE_MAX_OUTSTANDING_PER_PRINCIPAL
      ) {
        return { ok: false as const, error: 'probe-refused' as const };
      }
      const principalIndexKey = probePrincipalKey(principal, key);
      await transaction.put(key, challenge);
      await transaction.put(principalIndexKey, true);
      await transaction.put(probeExpiryKey(challenge.expiresAt, key), {
        artifactKey: key,
        expiresAt: challenge.expiresAt,
        principalIndexKey,
      } satisfies ProbeExpiryIndex);
      await scheduleProbeSweep(transaction, challenge.expiresAt);
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
      await transaction.delete(probeExpiryKey(challenge.expiresAt, challengeKey));
      await transaction.delete(probePrincipalKey(principal, challengeKey));
      await transaction.put(attestationKey, accepted.attestation);
      const attestationExpiresAt = probeAttestationExpiresAt(accepted.attestation);
      const attestationPrincipalIndexKey = probePrincipalKey(principal, attestationKey);
      await transaction.put(attestationPrincipalIndexKey, true);
      await transaction.put(probeExpiryKey(attestationExpiresAt, attestationKey), {
        artifactKey: attestationKey,
        expiresAt: attestationExpiresAt,
        principalIndexKey: attestationPrincipalIndexKey,
      } satisfies ProbeExpiryIndex);
      await scheduleProbeSweep(transaction, attestationExpiresAt);
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
      return await namespace.getByName(host, { locationHint: REGISTRY_LOCATION_HINT }).lookup(host);
    } catch {
      return { kind: 'unavailable' };
    }
  }
}

let jwks: GoogleJwksCache | null = null;

export default {
  async fetch(request: Request, env: RegistryWorkerEnv): Promise<Response> {
    if (
      env.HOST_REGISTRY === undefined ||
      env.REGISTRY_RATE_LIMITER === undefined ||
      !isRegistryTelemetryVersion(env.REGISTRY_VERSION)
    ) {
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
        registryVersion: env.REGISTRY_VERSION,
        auditSubject: REGISTRY_AUDIT_SUBJECT,
        roleAudiences: REGISTRY_ROLE_AUDIENCES,
        recoveryZones: REGISTRY_RECOVERY_ZONES,
        verificationRecords: REGISTRY_VERIFICATION_RECORDS,
      },
      {
        now: () => Date.now(),
        jwks,
        hostRegistry: env.HOST_REGISTRY as unknown as HostRegistryNamespace,
        rateLimiter: env.REGISTRY_RATE_LIMITER as unknown as RegistryRateLimiter,
        randomId: () => crypto.randomUUID(),
        semanticLogger: emitRegistrySemanticEvent,
      },
    );
  },
} satisfies ExportedHandler<RegistryWorkerEnv>;
