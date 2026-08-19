import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { classifyHost, normalizeHost } from '../host';
import {
  REGISTRY_LOCATION_HINT,
  type RegistryState,
  type RouterReplicaDesired,
} from './contracts';
import { REGISTRY_SYNC_AUDIENCE, REGISTRY_VERIFICATION_RECORDS } from './verificationRecords';
import { GoogleJwksCache } from './oidc';
import {
  handleRegistryFetch,
  type HostRegistryNamespace,
  type RegistryRateLimiter,
} from './service';
import { applyPublisherSync, initialRegistryState, registryLookup, type RegistryLookup } from './state';

const STATE_KEY = 'registry-state';

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
}

export interface RegistryLookupService {
  lookup(host: string): Promise<RegistryLookup>;
}

export class RegistryLookupEntrypoint extends WorkerEntrypoint<RegistryWorkerEnv> {
  async lookup(rawHost: string): Promise<RegistryLookup> {
    const host = normalizeHost(rawHost);
    const classified = classifyHost(rawHost);
    if (host !== rawHost || classified.kind === 'rejected') return { kind: 'unknown-host' };
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
        verificationRecords: REGISTRY_VERIFICATION_RECORDS,
      },
      {
        now: () => Date.now(),
        jwks,
        hostRegistry: env.HOST_REGISTRY as unknown as HostRegistryNamespace,
        rateLimiter: env.REGISTRY_RATE_LIMITER as unknown as RegistryRateLimiter,
      },
    );
  },
} satisfies ExportedHandler<RegistryWorkerEnv>;
