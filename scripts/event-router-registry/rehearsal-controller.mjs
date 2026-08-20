import { createHash } from 'node:crypto';

const SYNTHETIC_EVENT = /^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_ROOT = /^r2-root-[a-z2-7]{20}\.(fiveacross\.app|vacaybingo\.com)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_RESOURCE_ID = /^[a-f0-9]{32}$/;
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

function editionForHost(host) {
  return host.endsWith('.fiveacross.app') ? 'fiveacross' : 'vacay';
}

function validateExpectedState(host, hostClass, value) {
  if (hostClass === 'root-test') {
    exactKeys(
      value,
      ['kind', 'revision', 'root', 'edition', 'pathNamespace'],
      'manifest expected state',
    );
    if (
      value.kind !== 'root' ||
      value.revision !== '1' ||
      (value.root !== 'doorway' && value.root !== 'not-found') ||
      value.edition !== editionForHost(host) ||
      value.pathNamespace !== null
    ) {
      throw new Error('manifest expected state does not match its synthetic root-test host');
    }
    return;
  }

  if (value?.kind === 'route') {
    exactKeys(
      value,
      ['kind', 'revision', 'eventId', 'status', 'slug', 'edition', 'pathNamespace'],
      'manifest expected state',
    );
    if (
      value.revision !== '1' ||
      typeof value.eventId !== 'string' ||
      value.eventId.length === 0 ||
      (value.status !== 'active' && value.status !== 'disabled') ||
      value.slug !== host.split('.')[0] ||
      value.edition !== editionForHost(host) ||
      value.pathNamespace !== null
    ) {
      throw new Error('manifest expected state does not match its synthetic event host');
    }
    return;
  }

  if (value?.kind === 'tombstone') {
    exactKeys(value, ['kind', 'revision'], 'manifest expected state');
    if (value.revision !== '1') {
      throw new Error('manifest expected state does not match its synthetic tombstone host');
    }
    return;
  }

  if (value?.kind === 'uninitialized') {
    exactKeys(value, ['kind', 'scenario'], 'manifest expected state');
    if (value.scenario !== 'unknown' && value.scenario !== 'cold') {
      throw new Error('manifest expected state does not match an uninitialized synthetic host');
    }
    return;
  }

  throw new Error('manifest expected state does not match its synthetic host');
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
      item.routeId.length === 0
    ) {
      throw new Error('manifest artifact metadata is malformed');
    }
    validateExpectedState(item.host, expectedClass, item.expectedState);
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

function sameCanonicalValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function boundProviderArtifact(expected, providerId, binding) {
  return {
    schemaVersion: 1,
    kind: expected.kind,
    providerId,
    host: expected.host,
    pattern: expected.pattern,
    candidateId: expected.candidateId,
    binding: structuredClone(binding),
  };
}

function validateProviderArtifactReadback(readback, expected, binding) {
  exactKeys(
    readback,
    expected.kind === 'dns'
      ? ['kind', 'id', 'host', 'pattern', 'candidateId', 'proxied', 'binding']
      : ['kind', 'id', 'host', 'pattern', 'candidateId', 'binding'],
    `${expected.kind} provider readback`,
  );
  if (
    readback.kind !== expected.kind ||
    typeof readback.id !== 'string' ||
    !PROVIDER_RESOURCE_ID.test(readback.id) ||
    readback.host !== expected.host ||
    readback.pattern !== expected.pattern ||
    readback.candidateId !== expected.candidateId ||
    !sameCanonicalValue(readback.binding, binding) ||
    (expected.kind === 'dns' && readback.proxied !== true)
  ) {
    throw new Error(`${expected.kind} provider readback does not match the signed candidate`);
  }
  return boundProviderArtifact(expected, readback.id, binding);
}

function validateJournalArtifact(value, manifest, binding) {
  exactKeys(
    value,
    ['schemaVersion', 'kind', 'providerId', 'host', 'pattern', 'candidateId', 'binding'],
    'rehearsal artifact journal entry',
  );
  const item = manifest.hosts.find((candidate) => candidate.host === value.host);
  if (value.kind !== 'dns' && value.kind !== 'route') {
    throw new Error('rehearsal artifact journal entry has an invalid kind');
  }
  const expectedCandidate =
    value.kind === 'dns' ? item?.dnsRecordId : value.kind === 'route' ? item?.routeId : undefined;
  const expectedPattern = value.kind === 'dns' ? value.host : `${value.host}/*`;
  if (
    value.schemaVersion !== 1 ||
    item === undefined ||
    typeof value.providerId !== 'string' ||
    !PROVIDER_RESOURCE_ID.test(value.providerId) ||
    value.candidateId !== expectedCandidate ||
    value.pattern !== expectedPattern ||
    !sameCanonicalValue(value.binding, binding)
  ) {
    throw new Error('rehearsal artifact journal entry does not match the signed manifest');
  }
  return structuredClone(value);
}

function validateJournalReceipt(receipt, artifact) {
  exactKeys(receipt, ['committed', 'artifact'], 'artifact journal receipt');
  if (receipt.committed !== true || !sameCanonicalValue(receipt.artifact, artifact)) {
    throw new Error('artifact journal did not durably bind the provider resource');
  }
}

function artifactRecoveryError(journalError, artifact, compensationError) {
  const compensated = compensationError === undefined;
  const journalMessage =
    journalError instanceof Error ? journalError.message : String(journalError);
  const message = compensated
    ? `${journalMessage}; compensated unjournaled ${artifact.kind} ${artifact.providerId}`
    : `${journalMessage}; compensation failed for ${artifact.kind} ${artifact.providerId}`;
  const errors = compensated ? [journalError] : [journalError, compensationError];
  const error = new AggregateError(errors, message);
  error.recoveryArtifact = structuredClone(artifact);
  error.compensated = compensated;
  return error;
}

function providerReconciliationError(validationError, readback, expected, binding) {
  const reportedProviderId =
    typeof readback === 'object' &&
    readback !== null &&
    !Array.isArray(readback) &&
    typeof readback.id === 'string'
      ? readback.id
      : null;
  const validationMessage =
    validationError instanceof Error ? validationError.message : String(validationError);
  const error = new AggregateError(
    [validationError],
    `${validationMessage}; provider returned no usable ${expected.kind} ID`,
  );
  error.reconciliationCandidate = {
    kind: expected.kind,
    host: expected.host,
    pattern: expected.pattern,
    candidateId: expected.candidateId,
    reportedProviderId,
    binding: structuredClone(binding),
  };
  error.compensated = false;
  error.requiresReconciliation = true;
  return error;
}

async function compensateUnjournaledArtifact(dependencies, artifact) {
  const remove =
    artifact.kind === 'dns' ? dependencies.removeExactDns : dependencies.removeExactRoute;
  if (typeof remove !== 'function') {
    throw new Error(`exact ${artifact.kind} compensation is unavailable`);
  }
  await remove(artifact.host, artifact.providerId, artifact.binding);
  if (typeof dependencies.verifyExactArtifactAbsent !== 'function') {
    throw new Error('exact provider absence verification is unavailable');
  }
  const receipt = await dependencies.verifyExactArtifactAbsent(structuredClone(artifact));
  exactKeys(receipt, ['absent', 'artifact'], 'exact provider absence readback');
  if (receipt.absent !== true || !sameCanonicalValue(receipt.artifact, artifact)) {
    throw new Error('exact provider resource compensation was not verified absent');
  }
}

async function validateOrCompensateProviderReadback(
  dependencies,
  readback,
  expected,
  binding,
) {
  try {
    return validateProviderArtifactReadback(readback, expected, binding);
  } catch (validationError) {
    const providerId =
      typeof readback === 'object' &&
      readback !== null &&
      !Array.isArray(readback) &&
      typeof readback.id === 'string' &&
      PROVIDER_RESOURCE_ID.test(readback.id)
        ? readback.id
        : null;
    if (providerId === null) {
      throw providerReconciliationError(validationError, readback, expected, binding);
    }
    const artifact = boundProviderArtifact(expected, providerId, binding);
    try {
      await compensateUnjournaledArtifact(dependencies, artifact);
    } catch (compensationError) {
      throw artifactRecoveryError(validationError, artifact, compensationError);
    }
    throw artifactRecoveryError(validationError, artifact);
  }
}

async function journalProviderArtifact(dependencies, artifact) {
  try {
    if (typeof dependencies.journalArtifact !== 'function') {
      throw new Error('durable rehearsal artifact journal is unavailable');
    }
    const receipt = await dependencies.journalArtifact(structuredClone(artifact));
    validateJournalReceipt(receipt, artifact);
    return artifact;
  } catch (journalError) {
    try {
      await compensateUnjournaledArtifact(dependencies, artifact);
    } catch (compensationError) {
      throw artifactRecoveryError(journalError, artifact, compensationError);
    }
    throw artifactRecoveryError(journalError, artifact);
  }
}

async function readArtifactJournal(dependencies, manifest, binding) {
  if (typeof dependencies.readArtifactJournal !== 'function') {
    throw new Error('durable rehearsal artifact journal readback is unavailable');
  }
  const receipt = await dependencies.readArtifactJournal({
    binding,
    runId: manifest.runId,
    hosts: manifest.hosts.map((item) => item.host),
  });
  exactKeys(receipt, ['manifestDigest', 'runId', 'artifacts'], 'artifact journal readback');
  if (
    receipt.manifestDigest !== binding.manifestDigest ||
    receipt.runId !== manifest.runId ||
    !Array.isArray(receipt.artifacts)
  ) {
    throw new Error('artifact journal readback does not match the signed run');
  }
  const artifacts = receipt.artifacts.map((artifact) =>
    validateJournalArtifact(artifact, manifest, binding),
  );
  const candidateKeys = new Set();
  const providerKeys = new Set();
  const dnsHosts = new Set(
    artifacts.filter((artifact) => artifact.kind === 'dns').map((artifact) => artifact.host),
  );
  for (const artifact of artifacts) {
    const candidateKey = `${artifact.kind}\0${artifact.host}\0${artifact.candidateId}`;
    const providerKey = `${artifact.kind}\0${artifact.providerId}`;
    if (candidateKeys.has(candidateKey) || providerKeys.has(providerKey)) {
      throw new Error('artifact journal readback contains duplicate resources');
    }
    if (artifact.kind === 'route' && !dnsHosts.has(artifact.host)) {
      throw new Error('artifact journal route is missing its preceding DNS record');
    }
    candidateKeys.add(candidateKey);
    providerKeys.add(providerKey);
  }
  return artifacts;
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

function validateReservationReceipt(receipt, reservations, binding) {
  exactKeys(
    receipt,
    ['committed', 'aggregateReservations', 'manifestDigest', 'reservedHosts'],
    'reservation transaction receipt',
  );
  if (
    receipt.committed !== true ||
    !Number.isInteger(receipt.aggregateReservations) ||
    receipt.aggregateReservations < reservations.length ||
    receipt.aggregateReservations > MAX_RESERVATIONS ||
    receipt.manifestDigest !== binding.manifestDigest ||
    !Array.isArray(receipt.reservedHosts)
  ) {
    throw new Error('authoritative reservation transaction did not enforce the aggregate 64 cap');
  }

  if (receipt.reservedHosts.length !== reservations.length) {
    throw new Error('authoritative reservation transaction did not attest every reserved host');
  }
  const expectedByHost = new Map(
    reservations.map((reservation) => [reservation.host, reservation]),
  );
  const seen = new Set();
  for (const attestation of receipt.reservedHosts) {
    exactKeys(
      attestation,
      [
        'host',
        'class',
        'materialization',
        'expectedState',
        'permanent',
        'runId',
        'reservationPath',
        'hostnamePath',
        'ledgerPath',
        'hostname',
        'routerReplica',
        'projectionDigest',
        'sourceReplicaEqual',
        'reservationPreviouslyAbsent',
        'hostnamePreviouslyAbsent',
        'ledgerPreviouslyAbsent',
        'hostnameAbsent',
        'ledgerAbsent',
      ],
      'reservation transaction host attestation',
    );
    const expected = expectedByHost.get(attestation.host);
    if (
      expected === undefined ||
      seen.has(attestation.host) ||
      attestation.class !== expected.class ||
      attestation.materialization !== expected.materialization ||
      canonicalJson(attestation.expectedState) !== canonicalJson(expected.expectedState) ||
      attestation.permanent !== expected.permanent ||
      attestation.runId !== expected.runId ||
      attestation.reservationPath !== expected.reservationPath ||
      attestation.hostnamePath !== expected.hostnamePath ||
      attestation.ledgerPath !== expected.ledgerPath ||
      attestation.sourceReplicaEqual !== true ||
      attestation.reservationPreviouslyAbsent !== true ||
      attestation.hostnamePreviouslyAbsent !== true ||
      attestation.ledgerPreviouslyAbsent !== true ||
      attestation.hostnameAbsent !== (expected.hostname === null) ||
      attestation.ledgerAbsent !== (expected.routerReplica === null) ||
      attestation.projectionDigest !== expected.projectionDigest ||
      canonicalJson(attestation.hostname) !== canonicalJson(expected.hostname) ||
      canonicalJson(attestation.routerReplica) !== canonicalJson(expected.routerReplica)
    ) {
      throw new Error('authoritative reservation transaction did not attest exact equal state');
    }
    seen.add(attestation.host);
  }
}

function desiredForExpectedState(expectedState) {
  if (expectedState.kind === 'route') {
    return {
      kind: 'route',
      eventId: expectedState.eventId,
      status: expectedState.status,
      slug: expectedState.slug,
      edition: expectedState.edition,
      pathNamespace: expectedState.pathNamespace,
    };
  }
  if (expectedState.kind === 'tombstone') return { kind: 'tombstone' };
  return {
    kind: 'root',
    root: expectedState.root,
    edition: expectedState.edition,
    pathNamespace: expectedState.pathNamespace,
  };
}

function hostnameForExpectedState(host, expectedState) {
  if (expectedState.kind === 'route') {
    return {
      eventId: expectedState.eventId,
      canonicalHost: host,
      edition: expectedState.edition,
      status: expectedState.status,
      slug: expectedState.slug,
      pathNamespace: expectedState.pathNamespace,
      isCanonical: true,
    };
  }
  if (expectedState.kind === 'tombstone') return null;
  return {
    root: expectedState.root,
    edition: expectedState.edition,
    pathNamespace: expectedState.pathNamespace,
  };
}

function digestProjection(routerReplica) {
  const { desired } = routerReplica;
  let tuple;
  if (desired.kind === 'route') {
    tuple = [
      1,
      routerReplica.revision,
      routerReplica.host,
      'route',
      desired.eventId,
      desired.status,
      desired.slug,
      desired.edition,
      desired.pathNamespace,
    ];
  } else if (desired.kind === 'root') {
    tuple = [
      1,
      routerReplica.revision,
      routerReplica.host,
      'root',
      desired.root,
      desired.edition,
      desired.pathNamespace,
    ];
  } else {
    tuple = [1, routerReplica.revision, routerReplica.host, 'tombstone'];
  }
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function reservationFor(item, runId, updatedAt) {
  const uninitialized = item.expectedState.kind === 'uninitialized';
  const desired = uninitialized ? null : desiredForExpectedState(item.expectedState);
  const routerReplica = uninitialized
    ? null
    : {
        schemaVersion: 1,
        revision: item.expectedState.revision,
        host: item.host,
        desired,
        updatedAt,
      };
  const hostname = uninitialized ? null : hostnameForExpectedState(item.host, item.expectedState);
  return {
    host: item.host,
    class: item.class,
    materialization: uninitialized
      ? 'reserved-only'
      : item.expectedState.kind === 'tombstone'
        ? 'ledger-only'
        : 'source-and-ledger',
    expectedState: structuredClone(item.expectedState),
    requirePriorAbsence: true,
    permanent: true,
    runId,
    reservationPath: `routerRehearsals/${item.host}`,
    hostnamePath: `hostnames/${item.host}`,
    ledgerPath: `routerReplicas/${item.host}`,
    hostname,
    routerReplica,
    projectionDigest: routerReplica === null ? null : digestProjection(routerReplica),
  };
}

function operations(manifest) {
  return manifest.hosts.flatMap((item) => [
    `reserve permanently ${item.host}`,
    `create proxied exact DNS ${item.host}`,
    `attach exact route ${item.host}/*`,
  ]);
}

export async function provisionRehearsal(input, dependencies, { dryRun = true } = {}) {
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

  const updatedAt = new Date(now).toISOString();
  const reservations = manifest.hosts.map((item) =>
    reservationFor(item, manifest.runId, updatedAt),
  );
  if (typeof dependencies.reserveTransaction !== 'function') {
    throw new Error('authoritative reservation transaction is unavailable');
  }
  const receipt = await dependencies.reserveTransaction({
    maximumAggregate: MAX_RESERVATIONS,
    runId: manifest.runId,
    binding,
    reservations,
  });
  validateReservationReceipt(receipt, reservations, binding);
  const journaledArtifacts = [];
  // Provider create seams must reject failure-atomically; only resolved readbacks may represent
  // a created resource. A usable ID in a malformed readback is compensated below.
  for (const item of manifest.hosts) {
    const dnsReadback = await dependencies.createExactDns(item.host, item.dnsRecordId, {
      proxied: true,
      binding,
    });
    const dnsArtifact = await validateOrCompensateProviderReadback(
      dependencies,
      dnsReadback,
      {
        kind: 'dns',
        host: item.host,
        pattern: item.host,
        candidateId: item.dnsRecordId,
      },
      binding,
    );
    journaledArtifacts.push(await journalProviderArtifact(dependencies, dnsArtifact));

    const routePattern = `${item.host}/*`;
    const routeReadback = await dependencies.attachExactRoute(
      item.host,
      routePattern,
      item.routeId,
      binding,
    );
    const routeArtifact = await validateOrCompensateProviderReadback(
      dependencies,
      routeReadback,
      {
        kind: 'route',
        host: item.host,
        pattern: routePattern,
        candidateId: item.routeId,
      },
      binding,
    );
    journaledArtifacts.push(await journalProviderArtifact(dependencies, routeArtifact));
  }
  return { dryRun: false, operations: planned, manifest, journaledArtifacts };
}

export async function cleanupRehearsal(
  input,
  dependencies,
  { dryRun = true, observedArtifacts = [] } = {},
) {
  const manifest = validateRehearsalManifest(input);
  const planned = [
    ...manifest.hosts.map((item) => `tombstone and await DO convergence ${item.host}`),
    ...manifest.hosts.map((item) => `remove journaled exact route for ${item.host}`),
    ...manifest.hosts.map((item) => `remove journaled exact DNS for ${item.host}`),
  ];
  if (dryRun) {
    if (observedArtifacts.length > 0) {
      throw new Error('provider artifact readback requires a durable journal read');
    }
    return {
      dryRun: true,
      operations: planned,
      permanentReservationsRetained: true,
    };
  }

  // Cleanup remains authorized after expiry so an old route can always be contained.
  const binding = await verifySignedManifest(manifest, dependencies);
  const journaledArtifacts = await readArtifactJournal(dependencies, manifest, binding);
  const recorded = new Set(
    journaledArtifacts.map(
      (artifact) => `${artifact.kind}\0${artifact.providerId}\0${artifact.host}`,
    ),
  );
  for (const artifact of observedArtifacts) {
    if (
      (artifact.kind !== 'dns' && artifact.kind !== 'route') ||
      !recorded.has(`${artifact.kind}\0${artifact.id}\0${artifact.host}`)
    ) {
      throw new Error('provider reported an unrecorded artifact');
    }
  }
  await dependencies.tombstoneAndWait(
    manifest.hosts.map((item) => item.host),
    binding,
  );
  for (const artifact of journaledArtifacts.filter((candidate) => candidate.kind === 'route')) {
    await dependencies.removeExactRoute(artifact.host, artifact.providerId, binding);
  }
  for (const artifact of journaledArtifacts.filter((candidate) => candidate.kind === 'dns')) {
    await dependencies.removeExactDns(artifact.host, artifact.providerId, binding);
  }
  await dependencies.verifyAbsent(manifest.hosts, binding);
  return {
    dryRun: false,
    operations: planned,
    permanentReservationsRetained: true,
    journaledArtifacts,
  };
}
