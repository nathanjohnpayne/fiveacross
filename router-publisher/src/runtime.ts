import type {
  RouterReplicaDesired,
  RouterReplicaPublisherDeps,
} from './publisher';

const METADATA_ROOT =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' } as const;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;
const FIRESTORE_EVENT_TYPE = 'google.cloud.firestore.document.v1.written';
const FIRESTORE_SOURCE =
  '//firestore.googleapis.com/projects/fiveacross/databases/(default)';
const FIRESTORE_DOCUMENT_PREFIX =
  'projects/fiveacross/databases/(default)/documents/routerReplicas/';
const FIRESTORE_SUBJECT_PREFIX = 'documents/routerReplicas/';
const ROOT_HOSTS = new Map<string, readonly [string, string | null]>([
  ['fiveacross.app', ['fiveacross', 'fiveacross.app']],
  ['vacaybingo.com', ['vacay', 'vacaybingo.com']],
  ['gaycruisebingo.com', ['gcb', null]],
  ['fiveacross.vercel.app', ['fiveacross', 'fiveacross.app']],
  ['vacaybingo.vercel.app', ['vacay', 'vacaybingo.com']],
  ['gaycruisebingo.vercel.app', ['gcb', null]],
]);
// MIRROR of `RESERVED_LABELS` in `src/slug.ts`, not an independent policy.
// It cannot import that module: this service's `tsconfig.json` pins
// `rootDir: "src"`, so reaching outside it would change the emitted artifact
// shape of a separately deployed Cloud Function. The copy is instead pinned by
// the parity test in `src/slug.test.ts`, which reads this file — the same
// device `dailyEmailTheme.ts` uses for its Theme-token mirror, and for the
// same reason: a mirror without a parity test is how mirrors drift. `send`
// carries the Resend return-path MX for `fiveacross.app` (#1102).
const RESERVED_EVENT_SLUGS = new Set([
  'admin',
  'api',
  'auth',
  'd',
  'play',
  'send',
  'status',
  'www',
]);

export class PublisherRuntimeError extends Error {
  constructor() {
    super('router replica publisher runtime unavailable');
    this.name = 'PublisherRuntimeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function stringValue(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['stringValue'])) {
    throw new Error('invalid router replica event');
  }
  if (typeof value.stringValue !== 'string') {
    throw new Error('invalid router replica event');
  }
  return value.stringValue;
}

function nullableStringValue(value: unknown): string | null {
  if (isRecord(value) && hasExactKeys(value, ['nullValue']) && value.nullValue === null) {
    return null;
  }
  return stringValue(value);
}

function decodeDesired(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['mapValue']) ||
    !isRecord(value.mapValue) ||
    !hasExactKeys(value.mapValue, ['fields']) ||
    !isRecord(value.mapValue.fields)
  ) {
    throw new Error('invalid router replica event');
  }
  const result: Record<string, unknown> = {};
  for (const [field, encoded] of Object.entries(value.mapValue.fields)) {
    result[field] = field === 'pathNamespace'
      ? nullableStringValue(encoded)
      : stringValue(encoded);
  }
  return result;
}

function isValidEventSlug(slug: string): boolean {
  return (
    slug.length >= 3 &&
    slug.length <= 63 &&
    /^[a-z0-9-]+$/.test(slug) &&
    !slug.startsWith('-') &&
    !slug.endsWith('-') &&
    !slug.startsWith('r2-') &&
    !RESERVED_EVENT_SLUGS.has(slug) &&
    !(slug.length >= 4 && slug[2] === '-' && slug[3] === '-')
  );
}

export function replicaPayloadFromFirestoreEvent(
  event: unknown,
): RouterReplicaDesired {
  if (
    !isRecord(event) ||
    event.specversion !== '1.0' ||
    event.type !== FIRESTORE_EVENT_TYPE ||
    event.source !== FIRESTORE_SOURCE ||
    typeof event.id !== 'string' ||
    event.id.length === 0 ||
    typeof event.time !== 'string' ||
    !Number.isFinite(Date.parse(event.time)) ||
    typeof event.subject !== 'string' ||
    !event.subject.startsWith(FIRESTORE_SUBJECT_PREFIX) ||
    !isRecord(event.data) ||
    !isRecord(event.data.value) ||
    typeof event.data.value.name !== 'string' ||
    !event.data.value.name.startsWith(FIRESTORE_DOCUMENT_PREFIX) ||
    !isRecord(event.data.value.fields)
  ) {
    throw new Error('invalid router replica event');
  }

  const subjectHost = event.subject.slice(FIRESTORE_SUBJECT_PREFIX.length);
  const documentHost = event.data.value.name.slice(FIRESTORE_DOCUMENT_PREFIX.length);
  if (
    subjectHost.length === 0 ||
    subjectHost.includes('/') ||
    subjectHost !== documentHost
  ) {
    throw new Error('invalid router replica event');
  }
  const fields = event.data.value.fields;
  if (!hasExactKeys(fields, ['schemaVersion', 'revision', 'host', 'desired', 'updatedAt'])) {
    throw new Error('invalid router replica event');
  }
  const schemaVersion = fields.schemaVersion;
  const updatedAt = fields.updatedAt;
  if (
    !isRecord(schemaVersion) ||
    !hasExactKeys(schemaVersion, ['integerValue']) ||
    schemaVersion.integerValue !== '1' ||
    !isRecord(updatedAt) ||
    !hasExactKeys(updatedAt, ['timestampValue']) ||
    typeof updatedAt.timestampValue !== 'string'
  ) {
    throw new Error('invalid router replica event');
  }

  return replicaPayloadFromEvent(subjectHost, {
    schemaVersion: 1,
    revision: stringValue(fields.revision),
    host: stringValue(fields.host),
    desired: decodeDesired(fields.desired),
    updatedAt: updatedAt.timestampValue,
  });
}

function isRegistryHost(host: string): boolean {
  if (
    [
      'fiveacross.app',
      'vacaybingo.com',
      'gaycruisebingo.com',
      'fiveacross.vercel.app',
      'vacaybingo.vercel.app',
      'gaycruisebingo.vercel.app',
    ].includes(host) ||
    /^(?:r2-[a-z2-7]{26}|r2-root-[a-z2-7]{20})\.(?:fiveacross\.app|vacaybingo\.com)$/.test(
      host,
    )
  ) {
    return true;
  }
  const match = /^([a-z0-9-]+)\.(fiveacross\.app|vacaybingo\.com)$/.exec(host);
  if (match === null) return false;
  return isValidEventSlug(match[1]);
}

function validDesired(host: string, value: Record<string, unknown>): boolean {
  if (value.kind === 'tombstone') return hasExactKeys(value, ['kind']) && isRegistryHost(host);
  if (!['gcb', 'vacay', 'fiveacross'].includes(String(value.edition))) return false;
  if (
    value.pathNamespace !== null &&
    value.pathNamespace !== 'fiveacross.app' &&
    value.pathNamespace !== 'vacaybingo.com'
  ) {
    return false;
  }
  if (value.kind === 'route') {
    const rootClass = ROOT_HOSTS.get(host);
    const rootTest = /^r2-root-[a-z2-7]{20}\.(?:fiveacross\.app|vacaybingo\.com)$/.test(
      host,
    );
    return (
      hasExactKeys(value, ['kind', 'eventId', 'status', 'slug', 'edition', 'pathNamespace']) &&
      typeof value.eventId === 'string' &&
      value.eventId.length > 0 &&
      typeof value.slug === 'string' &&
      isRegistryHost(host) &&
      !rootTest &&
      ['active', 'disabled', 'archived'].includes(String(value.status)) &&
      (rootClass === undefined
        ? value.slug === host.split('.')[0] && value.pathNamespace === null
        : isValidEventSlug(value.slug) && value.pathNamespace === rootClass[1])
    );
  }
  if (value.kind === 'root') {
    const syntheticRoot = /^r2-root-[a-z2-7]{20}\.(?:fiveacross\.app|vacaybingo\.com)$/.test(host);
    const rootClass = ROOT_HOSTS.get(host);
    return (
      hasExactKeys(value, ['kind', 'root', 'edition', 'pathNamespace']) &&
      (value.root === 'doorway' || value.root === 'not-found') &&
      (syntheticRoot || rootClass !== undefined) &&
      (syntheticRoot
        ? value.pathNamespace === null
        : value.edition === rootClass?.[0] && value.pathNamespace === rootClass?.[1])
    );
  }
  return false;
}

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
            body: JSON.stringify({
              digest: { sha256: Buffer.from(digest).toString('base64') },
              digestCrc32c: String(crc32c(digest)),
            }),
          },
        );
        if (!response.ok) throw new PublisherRuntimeError();
        const body: unknown = await response.json();
        if (!isRecord(body)) throw new PublisherRuntimeError();
        const signature = decodeSignature(body.signature);
        if (
          body.name !== keyVersion ||
          body.verifiedDigestCrc32c !== true ||
          typeof body.signatureCrc32c !== 'string' ||
          !/^(?:0|[1-9]\d*)$/.test(body.signatureCrc32c) ||
          BigInt(body.signatureCrc32c) !== BigInt(crc32c(signature))
        ) {
          throw new PublisherRuntimeError();
        }
        return signature;
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
    !hasExactKeys(data, ['schemaVersion', 'revision', 'host', 'desired', 'updatedAt']) ||
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
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(updatedAt) ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    host !== host.toLowerCase() ||
    host.endsWith('.') ||
    !validDesired(host, data.desired)
  ) {
    throw new Error('invalid router replica event');
  }
  return { ...data, updatedAt } as RouterReplicaDesired;
}
