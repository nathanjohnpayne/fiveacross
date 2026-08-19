import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const NUMERIC_SUBJECT = /^[1-9]\d{5,39}$/;
const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const KMS_KEY = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;
const KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/;
const FUNCTION_RESOURCE = /^\/\/cloudfunctions\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/functions\/[^/]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const ALGORITHM = 'RSA_SIGN_PKCS1_2048_SHA256';
const EDITIONS = new Set(['gcb', 'vacay', 'fiveacross']);
const STATUSES = new Set(['active', 'disabled', 'archived']);
const PATH_NAMESPACES = new Set(['fiveacross.app', 'vacaybingo.com']);
const RESERVED_SLUGS = new Set(['admin', 'api', 'auth', 'd', 'play', 'status', 'www']);
const ROOT_HOSTS = new Map([
  ['fiveacross.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.com', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.com', { edition: 'gcb', pathNamespace: null }],
  ['fiveacross.vercel.app', { edition: 'fiveacross', pathNamespace: 'fiveacross.app' }],
  ['vacaybingo.vercel.app', { edition: 'vacay', pathNamespace: 'vacaybingo.com' }],
  ['gaycruisebingo.vercel.app', { edition: 'gcb', pathNamespace: null }],
]);
const EVENT_HOST = /^([a-z0-9-]+)\.(fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_EVENT = /^r2-[a-z2-7]{26}\.(fiveacross\.app|vacaybingo\.com)$/;
const SYNTHETIC_ROOT = /^r2-root-[a-z2-7]{20}\.(fiveacross\.app|vacaybingo\.com)$/;

export class RecoveryControllerRefusal extends Error {
  constructor(code) {
    super(`recovery evidence refused: ${code}`);
    this.name = 'RecoveryControllerRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new RecoveryControllerRefusal(code);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) refuse(code);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    refuse(code);
  }
}

function isNonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('non-canonical-document');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) refuse('non-canonical-document');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function instant(value, code) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) refuse(code);
  return time;
}

function requireFresh(value, now, code) {
  const time = instant(value, code);
  if (time > now || now - time > MAX_EVIDENCE_AGE_MS) refuse(code);
}

async function injected(dependencies, name, argument, code) {
  if (typeof dependencies?.[name] !== 'function') refuse(code);
  try {
    return await dependencies[name](argument);
  } catch (error) {
    if (error instanceof RecoveryControllerRefusal) throw error;
    refuse(code);
  }
}

function validateHost(host) {
  if (!isNonempty(host) || host !== host.toLowerCase() || host.endsWith('.') || host.includes('/')) {
    refuse('invalid-host');
  }
  if (!SYNTHETIC_EVENT.test(host) && !SYNTHETIC_ROOT.test(host)) refuse('invalid-host');
}

function validSlug(slug) {
  return (
    slug.length >= 3 &&
    slug.length <= 63 &&
    /^[a-z0-9-]+$/.test(slug) &&
    !slug.startsWith('-') &&
    !slug.endsWith('-') &&
    !slug.startsWith('r2-') &&
    !RESERVED_SLUGS.has(slug) &&
    !(slug.length >= 4 && slug[2] === '-' && slug[3] === '-')
  );
}

function validateExpectedCommitted(value) {
  if (value === null) return;
  exactKeys(value, ['revision', 'digest'], 'invalid-expected-state');
  if (!POSITIVE_DECIMAL.test(value.revision) || !SHA256.test(value.digest)) {
    refuse('invalid-expected-state');
  }
}

function validateAudience(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.workers.dev') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/__internal/hostname-replicas/v1' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.toString() !== value
    ) {
      refuse('invalid-attestor-config');
    }
  } catch (error) {
    if (error instanceof RecoveryControllerRefusal) throw error;
    refuse('invalid-attestor-config');
  }
}

function validateAttestorConfig(value) {
  exactKeys(value, ['audience', 'oidcSubject', 'keyVersion', 'keyFingerprint'], 'invalid-attestor-config');
  validateAudience(value.audience);
  if (
    !NUMERIC_SUBJECT.test(value.oidcSubject) ||
    !KMS_KEY_VERSION.test(value.keyVersion) ||
    !SHA256.test(value.keyFingerprint)
  ) {
    refuse('invalid-attestor-config');
  }
}

function validateEntity(entity, code) {
  exactKeys(
    entity,
    [
      'oidcSubject',
      'serviceAccountEmail',
      'functionFullResourceName',
      'functionRevision',
      'cryptoKey',
      'keyVersion',
      'keyFingerprint',
    ],
    code,
  );
  if (
    !NUMERIC_SUBJECT.test(entity.oidcSubject) ||
    !SERVICE_ACCOUNT_EMAIL.test(entity.serviceAccountEmail) ||
    !FUNCTION_RESOURCE.test(entity.functionFullResourceName) ||
    !isNonempty(entity.functionRevision) ||
    !KMS_KEY.test(entity.cryptoKey) ||
    !KMS_KEY_VERSION.test(entity.keyVersion) ||
    !entity.keyVersion.startsWith(`${entity.cryptoKey}/cryptoKeyVersions/`) ||
    !SHA256.test(entity.keyFingerprint)
  ) {
    refuse(code);
  }
}

function validateMapping(mapping, code) {
  exactKeys(mapping, ['epoch', 'subject', 'keyVersion', 'algorithm', 'spkiSha256'], code);
  if (
    !POSITIVE_DECIMAL.test(mapping.epoch) ||
    !NUMERIC_SUBJECT.test(mapping.subject) ||
    !KMS_KEY_VERSION.test(mapping.keyVersion) ||
    mapping.algorithm !== ALGORITHM ||
    !SHA256.test(mapping.spkiSha256)
  ) {
    refuse(code);
  }
}

function validateReplacementPlan(value) {
  if (value === null) refuse('replacement-required');
  exactKeys(
    value,
    [
      'quarantinedEpochCeiling',
      'nextPublisherEpoch',
      'registryConfigDigest',
      'quarantined',
      'replacement',
      'activeEpochMappings',
    ],
    'invalid-replacement-plan',
  );
  if (
    !POSITIVE_DECIMAL.test(value.quarantinedEpochCeiling) ||
    !POSITIVE_DECIMAL.test(value.nextPublisherEpoch) ||
    BigInt(value.nextPublisherEpoch) <= BigInt(value.quarantinedEpochCeiling) ||
    !SHA256.test(value.registryConfigDigest) ||
    !Array.isArray(value.activeEpochMappings) ||
    value.activeEpochMappings.length === 0 ||
    value.activeEpochMappings.length > 16
  ) {
    refuse('invalid-replacement-plan');
  }
  validateEntity(value.quarantined, 'invalid-quarantined-publisher');
  validateEntity(value.replacement, 'invalid-replacement-publisher');
  if (
    value.quarantined.oidcSubject === value.replacement.oidcSubject ||
    value.quarantined.serviceAccountEmail === value.replacement.serviceAccountEmail ||
    value.quarantined.functionFullResourceName === value.replacement.functionFullResourceName ||
    value.quarantined.cryptoKey === value.replacement.cryptoKey ||
    value.quarantined.keyVersion === value.replacement.keyVersion ||
    value.quarantined.keyFingerprint === value.replacement.keyFingerprint
  ) {
    refuse('publisher-identities-not-distinct');
  }
  for (const mapping of value.activeEpochMappings) validateMapping(mapping, 'invalid-replacement-mapping');
  const slots = new Set(value.activeEpochMappings.map((mapping) => mapping.epoch));
  if (slots.size !== value.activeEpochMappings.length) refuse('duplicate-replacement-mapping');
  for (const mapping of value.activeEpochMappings) {
    const old =
      mapping.subject === value.quarantined.oidcSubject &&
      mapping.keyVersion === value.quarantined.keyVersion &&
      mapping.spkiSha256 === value.quarantined.keyFingerprint &&
      BigInt(mapping.epoch) <= BigInt(value.quarantinedEpochCeiling);
    const replacement =
      mapping.epoch === value.nextPublisherEpoch &&
      mapping.subject === value.replacement.oidcSubject &&
      mapping.keyVersion === value.replacement.keyVersion &&
      mapping.spkiSha256 === value.replacement.keyFingerprint;
    if (!old && !replacement) refuse('replacement-mapping-mismatch');
  }
  const oldMapping = value.activeEpochMappings.some(
    (mapping) =>
      mapping.subject === value.quarantined.oidcSubject &&
      mapping.keyVersion === value.quarantined.keyVersion &&
      mapping.spkiSha256 === value.quarantined.keyFingerprint &&
      BigInt(mapping.epoch) <= BigInt(value.quarantinedEpochCeiling),
  );
  const nextMapping = value.activeEpochMappings.some(
    (mapping) =>
      mapping.epoch === value.nextPublisherEpoch &&
      mapping.subject === value.replacement.oidcSubject &&
      mapping.keyVersion === value.replacement.keyVersion &&
      mapping.spkiSha256 === value.replacement.keyFingerprint,
  );
  if (!oldMapping || !nextMapping) refuse('replacement-mapping-mismatch');
}

function validateInput(input) {
  exactKeys(
    input,
    [
      'schemaVersion',
      'host',
      'expectedCommitted',
      'lockId',
      'incidentUrl',
      'reason',
      'sourceAttestor',
      'publisherReplacement',
    ],
    'invalid-input',
  );
  if (input.schemaVersion !== 1) refuse('invalid-input');
  validateHost(input.host);
  validateExpectedCommitted(input.expectedCommitted);
  if (!isNonempty(input.lockId) || !isNonempty(input.reason) || input.reason.trim() !== input.reason) {
    refuse('invalid-input');
  }
  try {
    const incident = new URL(input.incidentUrl);
    if (incident.protocol !== 'https:' || incident.toString() !== input.incidentUrl) refuse('invalid-input');
  } catch (error) {
    if (error instanceof RecoveryControllerRefusal) throw error;
    refuse('invalid-input');
  }
  validateAttestorConfig(input.sourceAttestor);
  validateReplacementPlan(input.publisherReplacement);
}

function deriveDesired(host, source) {
  if (source === null) return { kind: 'tombstone' };
  if (!isRecord(source)) refuse('malformed-hostname-source');
  const hasEvent = Object.hasOwn(source, 'eventId');
  const hasRoot = Object.hasOwn(source, 'root');
  if (hasEvent === hasRoot) refuse('malformed-hostname-source');
  if (!EDITIONS.has(source.edition)) refuse('malformed-hostname-source');
  if (source.pathNamespace !== null && !PATH_NAMESPACES.has(source.pathNamespace)) {
    refuse('malformed-hostname-source');
  }
  if (hasRoot) {
    if (
      (source.root !== 'doorway' && source.root !== 'not-found') ||
      Object.hasOwn(source, 'status') ||
      Object.hasOwn(source, 'slug')
    ) {
      refuse('malformed-hostname-source');
    }
    const root = ROOT_HOSTS.get(host);
    const synthetic = SYNTHETIC_ROOT.test(host);
    if (
      (!synthetic && root === undefined) ||
      (synthetic && source.pathNamespace !== null) ||
      (root !== undefined && (source.edition !== root.edition || source.pathNamespace !== root.pathNamespace))
    ) {
      refuse('malformed-hostname-source');
    }
    return {
      kind: 'root',
      root: source.root,
      edition: source.edition,
      pathNamespace: source.pathNamespace,
    };
  }
  if (
    !isNonempty(source.eventId) ||
    !STATUSES.has(source.status) ||
    !isNonempty(source.slug) ||
    (!validSlug(source.slug) && !(SYNTHETIC_EVENT.test(host) && source.slug === host.split('.')[0]))
  ) {
    refuse('malformed-hostname-source');
  }
  const root = ROOT_HOSTS.get(host);
  const event = EVENT_HOST.exec(host);
  if (
    (root === undefined && (event === null || event[1] !== source.slug || source.pathNamespace !== null)) ||
    (root !== undefined && source.pathNamespace !== root.pathNamespace)
  ) {
    refuse('malformed-hostname-source');
  }
  return {
    kind: 'route',
    eventId: source.eventId,
    status: source.status,
    slug: source.slug,
    edition: source.edition,
    pathNamespace: source.pathNamespace,
  };
}

function validateDesired(host, desired) {
  if (!isRecord(desired) || typeof desired.kind !== 'string') refuse('malformed-ledger');
  const keys =
    desired.kind === 'route'
      ? ['kind', 'eventId', 'status', 'slug', 'edition', 'pathNamespace']
      : desired.kind === 'root'
        ? ['kind', 'root', 'edition', 'pathNamespace']
        : desired.kind === 'tombstone'
          ? ['kind']
          : [];
  if (keys.length === 0) refuse('malformed-ledger');
  exactKeys(desired, keys, 'malformed-ledger');
  if (desired.kind === 'tombstone') return { kind: 'tombstone' };
  const syntheticSource =
    desired.kind === 'root'
      ? { root: desired.root, edition: desired.edition, pathNamespace: desired.pathNamespace }
      : {
          eventId: desired.eventId,
          status: desired.status,
          slug: desired.slug,
          edition: desired.edition,
          pathNamespace: desired.pathNamespace,
        };
  return deriveDesired(host, syntheticSource);
}

function validateSourceRead(host, receipt) {
  exactKeys(
    receipt,
    ['atomic', 'readAt', 'hostnamePath', 'ledgerPath', 'hostname', 'routerReplica'],
    'invalid-source-transaction',
  );
  if (
    receipt.atomic !== true ||
    receipt.hostnamePath !== `hostnames/${host}` ||
    receipt.ledgerPath !== `routerReplicas/${host}`
  ) {
    refuse('invalid-source-transaction');
  }
  instant(receipt.readAt, 'invalid-source-transaction');
  if (receipt.routerReplica === null) refuse('missing-ledger');
  exactKeys(receipt.routerReplica, ['schemaVersion', 'revision', 'host', 'desired', 'updatedAt'], 'malformed-ledger');
  const ledger = receipt.routerReplica;
  if (
    ledger.schemaVersion !== 1 ||
    !POSITIVE_DECIMAL.test(ledger.revision) ||
    ledger.host !== host ||
    !isNonempty(ledger.updatedAt) ||
    !Number.isFinite(Date.parse(ledger.updatedAt))
  ) {
    refuse('malformed-ledger');
  }
  const canonicalDesired = deriveDesired(host, receipt.hostname);
  const ledgerDesired = validateDesired(host, ledger.desired);
  if (!sameValue(canonicalDesired, ledgerDesired)) refuse('source-ledger-drift');
  const sourceDocumentDigest = sha256(canonicalJson(receipt.hostname));
  const ledgerDocumentDigest = sha256(canonicalJson(ledger));
  const tuple =
    ledgerDesired.kind === 'route'
      ? [
          1,
          ledger.revision,
          host,
          'route',
          ledgerDesired.eventId,
          ledgerDesired.status,
          ledgerDesired.slug,
          ledgerDesired.edition,
          ledgerDesired.pathNamespace,
        ]
      : ledgerDesired.kind === 'root'
        ? [1, ledger.revision, host, 'root', ledgerDesired.root, ledgerDesired.edition, ledgerDesired.pathNamespace]
        : [1, ledger.revision, host, 'tombstone'];
  return {
    observedAt: receipt.readAt,
    sourceDocumentDigest,
    ledgerDocumentDigest,
    digest: sha256(JSON.stringify(tuple)),
    ledgerPayload: structuredClone(ledger),
    desired: canonicalDesired,
  };
}

function cryptoKeyOf(version) {
  return version.replace(/\/cryptoKeyVersions\/[1-9]\d*$/, '');
}

function iamFullName(email) {
  const projectId = email.slice(email.indexOf('@') + 1, -'.iam.gserviceaccount.com'.length);
  return `//iam.googleapis.com/projects/${projectId}/serviceAccounts/${email}`;
}

function kmsFullName(resource) {
  return `//cloudkms.googleapis.com/${resource}`;
}

function broadMember(member) {
  return (
    member === 'allUsers' ||
    member === 'allAuthenticatedUsers' ||
    member.startsWith('group:') ||
    member.startsWith('domain:')
  );
}

function sameUnordered(left, right) {
  if (left.length !== right.length) return false;
  const leftJson = left.map(canonicalJson).sort();
  const rightJson = right.map(canonicalJson).sort();
  return leftJson.every((entry, index) => entry === rightJson[index]);
}

function validateControlReadbacks(plan, readbacks, now) {
  exactKeys(
    readbacks,
    ['observedAt', 'functions', 'keyAccess', 'serviceAccountAccess', 'activeRegistry', 'accessDecisions'],
    'malformed-control-readback',
  );
  requireFresh(readbacks.observedAt, now, 'stale-control-readback');
  if (
    !Array.isArray(readbacks.functions) ||
    readbacks.functions.length !== 2 ||
    !Array.isArray(readbacks.keyAccess) ||
    readbacks.keyAccess.length !== 2 ||
    !Array.isArray(readbacks.serviceAccountAccess) ||
    readbacks.serviceAccountAccess.length !== 2 ||
    !Array.isArray(readbacks.accessDecisions) ||
    readbacks.accessDecisions.length !== 3
  ) {
    refuse('malformed-control-readback');
  }
  const entities = [plan.quarantined, plan.replacement];
  const normalizedFunctions = [];
  const normalizedKeys = [];
  const normalizedAccounts = [];
  for (const entity of entities) {
    const runtime = readbacks.functions.find(
      (candidate) => isRecord(candidate) && candidate.fullResourceName === entity.functionFullResourceName,
    );
    exactKeys(
      runtime,
      ['fullResourceName', 'serviceAccountEmail', 'oidcSubject', 'functionRevision', 'responseDigest'],
      'malformed-function-readback',
    );
    if (
      runtime.serviceAccountEmail !== entity.serviceAccountEmail ||
      runtime.oidcSubject !== entity.oidcSubject ||
      runtime.functionRevision !== entity.functionRevision ||
      !SHA256.test(runtime.responseDigest)
    ) {
      refuse('function-readback-mismatch');
    }
    normalizedFunctions.push({
      subject: entity.oidcSubject,
      serviceAccountEmail: entity.serviceAccountEmail,
      iamMember: `serviceAccount:${entity.serviceAccountEmail}`,
      functionFullResourceName: runtime.fullResourceName,
      functionRevision: runtime.functionRevision,
      responseDigest: runtime.responseDigest,
    });

    const key = readbacks.keyAccess.find(
      (candidate) => isRecord(candidate) && candidate.cryptoKey === entity.cryptoKey,
    );
    exactKeys(
      key,
      ['cryptoKey', 'policyEtag', 'signMembers', 'enabledVersions', 'responseDigest'],
      'malformed-key-readback',
    );
    if (
      !isNonempty(key.policyEtag) ||
      !SHA256.test(key.responseDigest) ||
      !Array.isArray(key.signMembers) ||
      !Array.isArray(key.enabledVersions) ||
      key.signMembers.length > 16 ||
      key.enabledVersions.length > 16 ||
      key.signMembers.some((member) => !isNonempty(member) || broadMember(member))
    ) {
      refuse('malformed-key-readback');
    }
    for (const version of key.enabledVersions) {
      exactKeys(version, ['keyVersion', 'algorithm', 'spkiSha256'], 'malformed-key-readback');
      if (
        !KMS_KEY_VERSION.test(version.keyVersion) ||
        cryptoKeyOf(version.keyVersion) !== key.cryptoKey ||
        version.algorithm !== ALGORITHM ||
        !SHA256.test(version.spkiSha256)
      ) {
        refuse('malformed-key-readback');
      }
    }
    const expectedVersions = plan.activeEpochMappings
      .filter((mapping) => cryptoKeyOf(mapping.keyVersion) === entity.cryptoKey)
      .map((mapping) => ({
        keyVersion: mapping.keyVersion,
        algorithm: mapping.algorithm,
        spkiSha256: mapping.spkiSha256,
      }));
    if (!sameUnordered(key.enabledVersions, expectedVersions)) refuse('key-version-readback-mismatch');
    const oldMember = `serviceAccount:${plan.quarantined.serviceAccountEmail}`;
    const nextMember = `serviceAccount:${plan.replacement.serviceAccountEmail}`;
    if (
      key.signMembers.includes(oldMember) ||
      (entity === plan.replacement && (key.signMembers.length !== 1 || key.signMembers[0] !== nextMember))
    ) {
      refuse('key-policy-readback-mismatch');
    }
    normalizedKeys.push({
      cryptoKey: key.cryptoKey,
      policyEtag: key.policyEtag,
      signMembers: [...key.signMembers],
      enabledVersions: structuredClone(key.enabledVersions),
      responseDigest: key.responseDigest,
    });

    const account = readbacks.serviceAccountAccess.find(
      (candidate) => isRecord(candidate) && candidate.fullResourceName === iamFullName(entity.serviceAccountEmail),
    );
    exactKeys(
      account,
      ['fullResourceName', 'serviceAccountEmail', 'oidcSubject', 'policyEtag', 'tokenCreatorMembers', 'responseDigest'],
      'malformed-service-account-readback',
    );
    if (
      account.serviceAccountEmail !== entity.serviceAccountEmail ||
      account.oidcSubject !== entity.oidcSubject ||
      !isNonempty(account.policyEtag) ||
      !SHA256.test(account.responseDigest) ||
      !Array.isArray(account.tokenCreatorMembers) ||
      account.tokenCreatorMembers.length > 16 ||
      account.tokenCreatorMembers.some(
        (member) =>
          !isNonempty(member) ||
          broadMember(member) ||
          member === `serviceAccount:${plan.quarantined.serviceAccountEmail}`,
      )
    ) {
      refuse('service-account-readback-mismatch');
    }
    normalizedAccounts.push({
      subject: entity.oidcSubject,
      serviceAccountEmail: entity.serviceAccountEmail,
      iamMember: `serviceAccount:${entity.serviceAccountEmail}`,
      fullResourceName: account.fullResourceName,
      policyEtag: account.policyEtag,
      tokenCreatorMembers: [...account.tokenCreatorMembers],
      responseDigest: account.responseDigest,
    });
  }
  exactKeys(readbacks.activeRegistry, ['configDigest', 'mappings'], 'malformed-registry-readback');
  if (
    readbacks.activeRegistry.configDigest !== plan.registryConfigDigest ||
    !Array.isArray(readbacks.activeRegistry.mappings) ||
    readbacks.activeRegistry.mappings.length > 16
  ) {
    refuse('registry-readback-mismatch');
  }
  for (const mapping of readbacks.activeRegistry.mappings) {
    validateMapping(mapping, 'malformed-registry-readback');
  }
  if (!sameUnordered(readbacks.activeRegistry.mappings, plan.activeEpochMappings)) {
    refuse('registry-readback-mismatch');
  }

  const oldPrincipal = plan.quarantined.serviceAccountEmail;
  const expectedDecisions = new Map([
    ['cloudkms.cryptoKeyVersions.useToSign', kmsFullName(plan.replacement.keyVersion)],
    ['iam.serviceAccounts.getOpenIdToken', iamFullName(plan.replacement.serviceAccountEmail)],
    ['iam.serviceAccounts.getAccessToken', iamFullName(plan.replacement.serviceAccountEmail)],
  ]);
  const normalizedDecisions = [];
  for (const [permission, resource] of expectedDecisions) {
    const decision = readbacks.accessDecisions.find(
      (candidate) => isRecord(candidate) && candidate.permission === permission,
    );
    exactKeys(
      decision,
      [
        'principalEmail',
        'fullResourceName',
        'permission',
        'requestTime',
        'overallAccessState',
        'inheritedPoliciesComplete',
        'responseDigest',
      ],
      'malformed-access-decision',
    );
    requireFresh(decision.requestTime, now, 'stale-access-decision');
    if (
      decision.principalEmail !== oldPrincipal ||
      decision.fullResourceName !== resource ||
      decision.overallAccessState !== 'CANNOT_ACCESS' ||
      decision.inheritedPoliciesComplete !== true ||
      !SHA256.test(decision.responseDigest)
    ) {
      refuse('access-decision-mismatch');
    }
    normalizedDecisions.push({
      principal: decision.principalEmail,
      fullResourceName: decision.fullResourceName,
      permission: decision.permission,
      requestTime: decision.requestTime,
      overallAccessState: decision.overallAccessState,
      inheritedPoliciesComplete: decision.inheritedPoliciesComplete,
      responseDigest: decision.responseDigest,
    });
  }
  return {
    observedAt: readbacks.observedAt,
    quarantinedRuntime: normalizedFunctions[0],
    replacementRuntime: normalizedFunctions[1],
    activeEpochMappings: structuredClone(readbacks.activeRegistry.mappings),
    keyAccess: normalizedKeys,
    serviceAccountAccess: normalizedAccounts,
    quarantinedAccessDecisions: normalizedDecisions,
  };
}

function validateAttestorSession(session, expected, now) {
  exactKeys(
    session,
    [
      'oidcToken',
      'credentialSource',
      'tokenIssuedAt',
      'tokenExpiresAt',
      'audience',
      'oidcSubject',
      'keyVersion',
      'keyFingerprint',
      'sign',
    ],
    'attestor-session-unavailable',
  );
  const tokenIssuedAt = instant(session.tokenIssuedAt, 'attestor-session-mismatch');
  const tokenExpiresAt = instant(session.tokenExpiresAt, 'attestor-session-mismatch');
  if (
    typeof session.oidcToken !== 'string' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.oidcToken) ||
    session.credentialSource !== 'interactive-human-impersonation' ||
    tokenIssuedAt > now ||
    tokenExpiresAt <= now ||
    tokenExpiresAt - tokenIssuedAt > 60 * 60_000 ||
    session.audience !== expected.audience ||
    session.oidcSubject !== expected.oidcSubject ||
    session.keyVersion !== expected.keyVersion ||
    session.keyFingerprint !== expected.keyFingerprint ||
    typeof session.sign !== 'function'
  ) {
    refuse('attestor-session-mismatch');
  }
}

async function sign(session, purpose, canonicalInput) {
  let signature;
  try {
    signature = await session.sign({
      purpose,
      keyVersion: session.keyVersion,
      exactBytes: new TextEncoder().encode(canonicalInput),
    });
  } catch {
    refuse('attestor-signing-unavailable');
  }
  if (typeof signature !== 'string' || !BASE64.test(signature) || Buffer.from(signature, 'base64').length === 0) {
    refuse('attestor-signature-malformed');
  }
  return signature;
}

function authoritativeNow(dependencies) {
  if (typeof dependencies?.now !== 'function') refuse('authoritative-clock-unavailable');
  let value;
  try {
    value = dependencies.now();
  } catch {
    refuse('authoritative-clock-unavailable');
  }
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(time)) refuse('authoritative-clock-unavailable');
  return { time, iso: new Date(time).toISOString() };
}

export async function buildRecoveryArtifacts(input, dependencies) {
  validateInput(input);
  const receipt = await injected(
    dependencies,
    'readSourceTransaction',
    {
      hostnamePath: `hostnames/${input.host}`,
      ledgerPath: `routerReplicas/${input.host}`,
    },
    'source-transaction-unavailable',
  );
  const source = validateSourceRead(input.host, receipt);

  const readbacks = await injected(
    dependencies,
    'readPublisherControlReadbacks',
    structuredClone(input.publisherReplacement),
    'control-readback-unavailable',
  );
  const now = authoritativeNow(dependencies);
  requireFresh(source.observedAt, now.time, 'stale-source-transaction');
  const control = validateControlReadbacks(input.publisherReplacement, readbacks, now.time);

  const session = await injected(
    dependencies,
    'obtainSourceAttestorSession',
    {
      audience: input.sourceAttestor.audience,
      oidcSubject: input.sourceAttestor.oidcSubject,
      keyVersion: input.sourceAttestor.keyVersion,
      keyFingerprint: input.sourceAttestor.keyFingerprint,
    },
    'attestor-session-unavailable',
  );
  const issued = authoritativeNow(dependencies);
  validateAttestorSession(session, input.sourceAttestor, issued.time);
  requireFresh(source.observedAt, issued.time, 'stale-source-transaction');
  requireFresh(control.observedAt, issued.time, 'stale-control-readback');

  const unsignedSourceAudit = {
    revision: source.ledgerPayload.revision,
    digest: source.digest,
    observedAt: source.observedAt,
    canonicalProjection: {
      sourceDocumentDigest: source.sourceDocumentDigest,
      host: input.host,
      desired: structuredClone(source.desired),
    },
    ledgerPayload: structuredClone(source.ledgerPayload),
    ledgerDocumentDigest: source.ledgerDocumentDigest,
    attestorSub: input.sourceAttestor.oidcSubject,
    attestorKeyVersion: input.sourceAttestor.keyVersion,
    attestorKeyFingerprint: input.sourceAttestor.keyFingerprint,
    attestationIssuedAt: issued.iso,
  };
  const sourceInput = [
    'v1',
    'source-audit',
    input.host,
    unsignedSourceAudit.revision,
    unsignedSourceAudit.digest,
    unsignedSourceAudit.observedAt,
    unsignedSourceAudit.attestationIssuedAt,
    sha256(canonicalJson(unsignedSourceAudit.canonicalProjection)),
    sha256(canonicalJson(unsignedSourceAudit.ledgerPayload)),
    unsignedSourceAudit.canonicalProjection.sourceDocumentDigest,
    unsignedSourceAudit.ledgerDocumentDigest,
  ].join('\n');
  const sourceSignature = await sign(session, 'source-audit', sourceInput);
  const sourceAudit = { ...unsignedSourceAudit, attestationSignature: sourceSignature };

  let publisherReplacement = null;
  let controlInput = null;
  if (input.publisherReplacement !== null) {
    const unsignedControl = {
      ...control,
      attestorSub: input.sourceAttestor.oidcSubject,
      attestorKeyVersion: input.sourceAttestor.keyVersion,
      attestorKeyFingerprint: input.sourceAttestor.keyFingerprint,
      attestationIssuedAt: issued.iso,
    };
    controlInput = [
      'v1',
      'publisher-quarantine',
      unsignedControl.observedAt,
      unsignedControl.attestationIssuedAt,
      sha256(canonicalJson(unsignedControl)),
    ].join('\n');
    const controlSignature = await sign(session, 'publisher-quarantine', controlInput);
    publisherReplacement = {
      quarantinedEpochCeiling: input.publisherReplacement.quarantinedEpochCeiling,
      nextPublisherEpoch: input.publisherReplacement.nextPublisherEpoch,
      replacementSubject: input.publisherReplacement.replacement.oidcSubject,
      replacementKeyVersion: input.publisherReplacement.replacement.keyVersion,
      replacementKeyFingerprint: input.publisherReplacement.replacement.keyFingerprint,
      registryConfigDigest: input.publisherReplacement.registryConfigDigest,
      controlEvidence: { ...unsignedControl, attestationSignature: controlSignature },
    };
  }

  return {
    dryRun: true,
    request: {
      schemaVersion: 1,
      host: input.host,
      expectedCommitted: structuredClone(input.expectedCommitted),
      sourceAudit,
      action: {
        kind: 'apply',
        lockId: input.lockId,
        publisherReplacement,
      },
      incidentUrl: input.incidentUrl,
      reason: input.reason,
    },
    evidence: {
      sourceReadAt: source.observedAt,
      sourceDocumentDigest: source.sourceDocumentDigest,
      ledgerDocumentDigest: source.ledgerDocumentDigest,
      credentialMaterialOmitted: true,
    },
    signatureInputs: {
      sourceAudit: sourceInput,
      publisherControl: controlInput,
    },
  };
}
