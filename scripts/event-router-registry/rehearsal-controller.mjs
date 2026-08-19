import { createHash } from 'node:crypto';

const SYNTHETIC_EVENT = /^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_ROOT = /^r2-root-[a-z2-7]{20}\.(fiveacross\.app|vacaybingo\.com)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE_VALUE = /^[A-Za-z0-9_-]+$/;
const MAX_RESERVATIONS = 64;

function exactKeys(value, expected, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has extra or missing fields`);
  }
}

function closedClass(host) {
  if (SYNTHETIC_EVENT.test(host)) return 'synthetic';
  if (SYNTHETIC_ROOT.test(host)) return 'root-test';
  throw new Error(`host is outside the closed synthetic class: ${host}`);
}

export function validateRehearsalManifest(value) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'runId',
      'sourceCommit',
      'scriptVersion',
      'creator',
      'expiresAt',
      'reviewAuthorization',
      'hosts',
      'signature',
    ],
    'manifest',
  );
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    typeof value.sourceCommit !== 'string' ||
    !COMMIT.test(value.sourceCommit) ||
    typeof value.scriptVersion !== 'string' ||
    value.scriptVersion.length === 0 ||
    typeof value.creator !== 'string' ||
    value.creator.length === 0 ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length === 0
  ) {
    throw new Error('manifest metadata is malformed');
  }
  if (value.hosts.length > MAX_RESERVATIONS) {
    throw new Error('rehearsal manifest exceeds 64 hosts');
  }

  exactKeys(
    value.reviewAuthorization,
    [
      'id',
      'reviewer',
      'reviewedAt',
      'sourceCommit',
      'scriptVersion',
      'artifactSha256',
      'signingKeyId',
    ],
    'review authorization',
  );
  const review = value.reviewAuthorization;
  if (
    typeof review.id !== 'string' ||
    review.id.length === 0 ||
    typeof review.reviewer !== 'string' ||
    review.reviewer.length === 0 ||
    typeof review.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    review.sourceCommit !== value.sourceCommit ||
    review.scriptVersion !== value.scriptVersion ||
    typeof review.artifactSha256 !== 'string' ||
    !SHA256.test(review.artifactSha256) ||
    typeof review.signingKeyId !== 'string' ||
    review.signingKeyId.length === 0 ||
    Date.parse(review.reviewedAt) > Date.parse(value.expiresAt)
  ) {
    throw new Error('review authorization is malformed or does not match the candidate');
  }

  exactKeys(value.signature, ['algorithm', 'keyId', 'value'], 'manifest signature');
  if (
    value.signature.algorithm !== 'RS256' ||
    typeof value.signature.keyId !== 'string' ||
    value.signature.keyId.length === 0 ||
    value.signature.keyId !== review.signingKeyId ||
    typeof value.signature.value !== 'string' ||
    !SIGNATURE_VALUE.test(value.signature.value)
  ) {
    throw new Error('manifest signature metadata is malformed');
  }

  const hosts = new Set();
  const dnsIds = new Set();
  const routeIds = new Set();
  for (const item of value.hosts) {
    exactKeys(item, ['host', 'class', 'dnsRecordId', 'routeId', 'expectedState'], 'manifest host');
    if (typeof item.host !== 'string') throw new Error('manifest host is malformed');
    const expectedClass = closedClass(item.host);
    if (item.class !== expectedClass) throw new Error('manifest host class mismatch');
    if (
      typeof item.dnsRecordId !== 'string' ||
      item.dnsRecordId.length === 0 ||
      typeof item.routeId !== 'string' ||
      item.routeId.length === 0 ||
      typeof item.expectedState !== 'string' ||
      item.expectedState.length === 0
    ) {
      throw new Error('manifest artifact metadata is malformed');
    }
    if (hosts.has(item.host) || dnsIds.has(item.dnsRecordId) || routeIds.has(item.routeId)) {
      throw new Error('manifest hosts and artifact IDs must be unique');
    }
    hosts.add(item.host);
    dnsIds.add(item.dnsRecordId);
    routeIds.add(item.routeId);
  }
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('manifest contains an unsupported value');
  return encoded;
}

function signedPayloadBytes(manifest) {
  const { signature: _signature, ...payload } = manifest;
  return new TextEncoder().encode(canonicalJson(payload));
}

function manifestBinding(manifest, payloadBytes) {
  return Object.freeze({
    manifestDigest: createHash('sha256').update(payloadBytes).digest('hex'),
    runId: manifest.runId,
    sourceCommit: manifest.sourceCommit,
    scriptVersion: manifest.scriptVersion,
    artifactSha256: manifest.reviewAuthorization.artifactSha256,
    expiresAt: manifest.expiresAt,
    reviewAuthorizationId: manifest.reviewAuthorization.id,
    reviewer: manifest.reviewAuthorization.reviewer,
    reviewedAt: manifest.reviewAuthorization.reviewedAt,
    signingKeyId: manifest.reviewAuthorization.signingKeyId,
  });
}

async function verifySignedManifest(manifest, dependencies) {
  if (typeof dependencies.verifyManifestSignature !== 'function') {
    throw new Error('signed-manifest verifier is unavailable');
  }
  const payloadBytes = signedPayloadBytes(manifest);
  const verified = await dependencies.verifyManifestSignature(payloadBytes, manifest.signature);
  if (verified !== true) throw new Error('signed rehearsal manifest is invalid');
  return manifestBinding(manifest, payloadBytes);
}

function validateCurrentTime(now) {
  const time = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(time)) throw new Error('authoritative rehearsal clock is unavailable');
  return time;
}

function validateReviewedArtifact(readback, manifest) {
  exactKeys(
    readback,
    [
      'branch',
      'clean',
      'reviewed',
      'sourceCommit',
      'scriptVersion',
      'artifactSha256',
      'reviewAuthorizationId',
    ],
    'reviewed artifact readback',
  );
  const review = manifest.reviewAuthorization;
  if (
    readback.branch !== 'main' ||
    readback.clean !== true ||
    readback.reviewed !== true ||
    readback.sourceCommit !== manifest.sourceCommit ||
    readback.scriptVersion !== manifest.scriptVersion ||
    readback.artifactSha256 !== review.artifactSha256 ||
    readback.reviewAuthorizationId !== review.id
  ) {
    throw new Error('reviewed artifact does not exactly match the clean main candidate');
  }
}

function validateReservationReceipt(receipt, manifest, binding) {
  exactKeys(
    receipt,
    ['committed', 'aggregateReservations', 'manifestDigest', 'reservedHosts'],
    'reservation transaction receipt',
  );
  if (
    receipt.committed !== true ||
    !Number.isInteger(receipt.aggregateReservations) ||
    receipt.aggregateReservations < manifest.hosts.length ||
    receipt.aggregateReservations > MAX_RESERVATIONS ||
    receipt.manifestDigest !== binding.manifestDigest ||
    !Array.isArray(receipt.reservedHosts)
  ) {
    throw new Error('authoritative reservation transaction did not enforce the aggregate 64 cap');
  }
  const expected = [...manifest.hosts.map((item) => item.host)].sort();
  const actual = [...new Set(receipt.reservedHosts)].sort();
  if (
    actual.length !== expected.length ||
    actual.some((host, index) => host !== expected[index])
  ) {
    throw new Error('authoritative reservation transaction did not reserve the exact manifest');
  }
}

function operations(manifest) {
  return manifest.hosts.flatMap((item) => [
    `reserve permanently ${item.host}`,
    `create proxied exact DNS ${item.host}`,
    `attach exact route ${item.host}/*`,
  ]);
}

export async function provisionRehearsal(
  input,
  dependencies,
  { dryRun = true } = {},
) {
  const manifest = validateRehearsalManifest(input);
  const planned = operations(manifest);
  if (dryRun) return { dryRun: true, operations: planned, manifest };

  if (typeof dependencies.now !== 'function') {
    throw new Error('authoritative rehearsal clock is unavailable');
  }
  const now = validateCurrentTime(dependencies.now());
  if (now >= Date.parse(manifest.expiresAt)) throw new Error('rehearsal manifest has expired');
  if (Date.parse(manifest.reviewAuthorization.reviewedAt) > now) {
    throw new Error('review authorization is not yet valid');
  }
  const binding = await verifySignedManifest(manifest, dependencies);
  if (typeof dependencies.inspectReviewedArtifact !== 'function') {
    throw new Error('reviewed artifact inspection is unavailable');
  }
  const artifact = await dependencies.inspectReviewedArtifact({
    sourceCommit: manifest.sourceCommit,
    scriptVersion: manifest.scriptVersion,
    artifactSha256: manifest.reviewAuthorization.artifactSha256,
    reviewAuthorizationId: manifest.reviewAuthorization.id,
  });
  validateReviewedArtifact(artifact, manifest);

  const reservations = manifest.hosts.map((item) => ({
    host: item.host,
    class: item.class,
    permanent: true,
    runId: manifest.runId,
    rootProjection: item.class === 'root-test' ? { pathNamespace: null } : null,
  }));
  if (typeof dependencies.reserveTransaction !== 'function') {
    throw new Error('authoritative reservation transaction is unavailable');
  }
  const receipt = await dependencies.reserveTransaction({
    maximumAggregate: MAX_RESERVATIONS,
    runId: manifest.runId,
    binding,
    reservations,
  });
  validateReservationReceipt(receipt, manifest, binding);
  for (const item of manifest.hosts) {
    await dependencies.createExactDns(item.host, item.dnsRecordId, { proxied: true, binding });
    await dependencies.attachExactRoute(item.host, `${item.host}/*`, item.routeId, binding);
  }
  return { dryRun: false, operations: planned, manifest };
}

function recordedArtifactKeys(manifest) {
  const keys = new Set();
  for (const item of manifest.hosts) {
    keys.add(`dns\0${item.dnsRecordId}\0${item.host}`);
    keys.add(`route\0${item.routeId}\0${item.host}`);
  }
  return keys;
}

export async function cleanupRehearsal(
  input,
  dependencies,
  { dryRun = true, observedArtifacts = [] } = {},
) {
  const manifest = validateRehearsalManifest(input);
  const recorded = recordedArtifactKeys(manifest);
  for (const artifact of observedArtifacts) {
    if (
      !recorded.has(`${artifact.kind}\0${artifact.id}\0${artifact.host}`) ||
      (artifact.kind !== 'dns' && artifact.kind !== 'route')
    ) {
      throw new Error('provider reported an unrecorded artifact');
    }
  }
  const planned = [
    ...manifest.hosts.map((item) => `tombstone and await DO convergence ${item.host}`),
    ...manifest.hosts.map((item) => `remove exact route ${item.routeId}`),
    ...manifest.hosts.map((item) => `remove exact DNS ${item.dnsRecordId}`),
  ];
  if (dryRun) {
    return { dryRun: true, operations: planned, permanentReservationsRetained: true };
  }

  // Cleanup remains authorized after expiry so an old route can always be contained.
  const binding = await verifySignedManifest(manifest, dependencies);
  await dependencies.tombstoneAndWait(
    manifest.hosts.map((item) => item.host),
    binding,
  );
  for (const item of manifest.hosts) {
    await dependencies.removeExactRoute(item.host, item.routeId, binding);
    await dependencies.removeExactDns(item.host, item.dnsRecordId, binding);
  }
  await dependencies.verifyAbsent(manifest.hosts, binding);
  return { dryRun: false, operations: planned, permanentReservationsRetained: true };
}
