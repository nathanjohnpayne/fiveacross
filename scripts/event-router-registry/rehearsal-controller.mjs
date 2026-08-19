const SYNTHETIC_EVENT = /^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_ROOT = /^r2-root-[a-z2-7]{20}\.(fiveacross\.app|vacaybingo\.com)$/;
const COMMIT = /^[a-f0-9]{40}$/;
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

export function validateRehearsalManifest(value, { existingReservations }) {
  exactKeys(
    value,
    ['schemaVersion', 'runId', 'sourceCommit', 'scriptVersion', 'creator', 'expiresAt', 'hosts'],
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
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length === 0
  ) {
    throw new Error('manifest metadata is malformed');
  }
  if (!Number.isInteger(existingReservations) || existingReservations < 0) {
    throw new Error('existing reservation count is malformed');
  }
  if (existingReservations + value.hosts.length > MAX_RESERVATIONS) {
    throw new Error('rehearsal reservation total exceeds 64');
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
  { existingReservations, dryRun = true },
) {
  const manifest = validateRehearsalManifest(input, { existingReservations });
  const planned = operations(manifest);
  if (dryRun) return { dryRun: true, operations: planned, manifest };

  const reservations = manifest.hosts.map((item) => ({
    host: item.host,
    class: item.class,
    permanent: true,
    runId: manifest.runId,
    rootProjection: item.class === 'root-test' ? { pathNamespace: null } : null,
  }));
  await dependencies.reserveTransaction(reservations);
  for (const item of manifest.hosts) {
    await dependencies.createExactDns(item.host, item.dnsRecordId, { proxied: true });
    await dependencies.attachExactRoute(item.host, `${item.host}/*`, item.routeId);
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
  const manifest = validateRehearsalManifest(input, { existingReservations: 0 });
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

  await dependencies.tombstoneAndWait(manifest.hosts.map((item) => item.host));
  for (const item of manifest.hosts) {
    await dependencies.removeExactRoute(item.host, item.routeId);
    await dependencies.removeExactDns(item.host, item.dnsRecordId);
  }
  await dependencies.verifyAbsent(manifest.hosts);
  return { dryRun: false, operations: planned, permanentReservationsRetained: true };
}
