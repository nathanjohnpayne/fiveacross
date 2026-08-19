import type {
  RouterReplicaDesired,
  RouterReplicaPublisherDeps,
} from './publisher';

const METADATA_ROOT =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' } as const;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;

export class PublisherRuntimeError extends Error {
  constructor() {
    super('router replica publisher runtime unavailable');
    this.name = 'PublisherRuntimeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSignature(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new PublisherRuntimeError();
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) {
      throw new PublisherRuntimeError();
    }
    return new Uint8Array(decoded);
  } catch {
    throw new PublisherRuntimeError();
  }
}

export function createPublisherRuntimeDeps(
  fetchImpl: typeof fetch,
  now: () => number,
): RouterReplicaPublisherDeps {
  return {
    now,
    async getIdentityToken(audience) {
      try {
        const response = await fetchImpl(
          `${METADATA_ROOT}/identity?audience=${encodeURIComponent(audience)}&format=full`,
          { headers: METADATA_HEADERS },
        );
        if (!response.ok) throw new PublisherRuntimeError();
        const token = (await response.text()).trim();
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
          throw new PublisherRuntimeError();
        }
        return token;
      } catch {
        throw new PublisherRuntimeError();
      }
    },
    async signDigest({ keyVersion, digest }) {
      if (!KMS_KEY_VERSION.test(keyVersion) || digest.byteLength !== 32) {
        throw new PublisherRuntimeError();
      }
      try {
        const tokenResponse = await fetchImpl(`${METADATA_ROOT}/token`, {
          headers: METADATA_HEADERS,
        });
        if (!tokenResponse.ok) throw new PublisherRuntimeError();
        const tokenBody: unknown = await tokenResponse.json();
        if (
          !isRecord(tokenBody) ||
          typeof tokenBody.access_token !== 'string' ||
          tokenBody.access_token.length === 0 ||
          tokenBody.token_type !== 'Bearer' ||
          typeof tokenBody.expires_in !== 'number' ||
          tokenBody.expires_in <= 0
        ) {
          throw new PublisherRuntimeError();
        }
        const response = await fetchImpl(
          `https://cloudkms.googleapis.com/v1/${keyVersion}:asymmetricSign`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tokenBody.access_token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ digest: { sha256: Buffer.from(digest).toString('base64') } }),
          },
        );
        if (!response.ok) throw new PublisherRuntimeError();
        const body: unknown = await response.json();
        if (!isRecord(body)) throw new PublisherRuntimeError();
        return decodeSignature(body.signature);
      } catch {
        throw new PublisherRuntimeError();
      }
    },
    fetch: (url, init) => fetchImpl(url, init),
  };
}

export function replicaPayloadFromEvent(host: string, data: unknown): RouterReplicaDesired {
  if (!isRecord(data)) throw new Error('invalid router replica event');
  if (
    data.schemaVersion !== 1 ||
    typeof data.revision !== 'string' ||
    !/^[1-9]\d*$/.test(data.revision) ||
    data.host !== host ||
    !isRecord(data.desired)
  ) {
    throw new Error('invalid router replica event');
  }
  const timestamp = data.updatedAt;
  let updatedAt: string;
  if (typeof timestamp === 'string') {
    updatedAt = timestamp;
  } else if (
    isRecord(timestamp) &&
    typeof timestamp.toDate === 'function'
  ) {
    const value = timestamp.toDate();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('invalid router replica event');
    }
    updatedAt = value.toISOString();
  } else {
    throw new Error('invalid router replica event');
  }
  return { ...data, updatedAt } as RouterReplicaDesired;
}
