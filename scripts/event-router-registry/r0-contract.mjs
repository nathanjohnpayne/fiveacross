export const REGISTRY_R0_CONTRACT = Object.freeze({
  identities: Object.freeze([
    {
      role: 'publisher',
      subjectAccount: 'event-router-replica-publisher@fiveacross.iam.gserviceaccount.com',
      audience: 'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1',
      key: 'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher',
      runtime: true,
      humanOnly: false,
      region: null,
    },
    {
      role: 'audit',
      subjectAccount: 'event-router-registry-audit@fiveacross.iam.gserviceaccount.com',
      audience: 'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1/audit',
      key: null,
      runtime: false,
      humanOnly: true,
      region: null,
    },
    {
      role: 'recovery',
      subjectAccount: 'event-router-registry-recovery@fiveacross.iam.gserviceaccount.com',
      audience: 'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1/recover',
      key: 'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/recovery',
      runtime: false,
      humanOnly: true,
      region: null,
    },
    {
      role: 'source-attestor',
      subjectAccount: 'event-router-registry-source-attestor@fiveacross.iam.gserviceaccount.com',
      audience: 'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1/source-attestor',
      key: 'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/source-attestor',
      runtime: false,
      humanOnly: true,
      region: null,
    },
    ...['us-west1', 'us-east1', 'europe-west1'].map((region, index) => ({
      role: 'regional-probe',
      subjectAccount: `event-router-registry-probe-${index + 1}@fiveacross.iam.gserviceaccount.com`,
      audience: 'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1/regional-probe',
      key: `projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/regional-probe-${index + 1}`,
      runtime: true,
      humanOnly: false,
      region,
    })),
  ]),
  publisherRuntime: Object.freeze({
    allow: Object.freeze(['logging.logEntries.create', 'cloudkms.cryptoKeyVersions.useToSign']),
    deny: Object.freeze([
      'datastore.*',
      'iam.serviceAccountKeys.*',
      'secretmanager.*',
      'cloudkms.cryptoKeyVersions.viewPublicKey',
      'cloudflare.*',
    ]),
  }),
  cloudflare: Object.freeze({
    durableObjectClass: 'HostRegistryObject',
    locationHint: 'wnam',
    rateLimitPerMinute: 60,
    kvNamespaces: 0,
    publicNamespaceRoutes: 0,
    wafExpression: 'http.host eq "<normalized-host>"',
    wafAction: 'block',
    logExplorer: Object.freeze({
      datasets: Object.freeze(['http_requests', 'firewall_events']),
      sampled: false,
      costAlertRequired: true,
      tokenRuntimeVisible: false,
    }),
    observability: Object.freeze({
      semanticEvent: 'event-router-registry.semantic',
      requiredFields: Object.freeze(['outcome', 'registryVersion', 'host', 'revision', 'latencyMs']),
      excludedFields: Object.freeze([
        'authorization',
        'token',
        'signature',
        'requestBody',
        'eventData',
        'firebaseKey',
      ]),
      alertPolicies: Object.freeze([
        Object.freeze({
          id: 'revision-conflict',
          outcome: 'conflict',
          countGreaterThan: 0,
          windowSeconds: 60,
        }),
        Object.freeze({
          id: 'aged-revision-gap',
          outcome: 'gap',
          gapAgeMsGreaterThan: 300_000,
          windowSeconds: 60,
        }),
        Object.freeze({
          id: 'recovery-action',
          outcome: 'recovered',
          countGreaterThan: 0,
          windowSeconds: 60,
        }),
        Object.freeze({
          id: 'recovery-locked',
          outcome: 'recovery-locked',
          countGreaterThan: 0,
          windowSeconds: 60,
        }),
        Object.freeze({
          id: 'empty-object-cardinality',
          outcome: 'empty-object',
          distinctHostsGreaterThan: 64,
          windowSeconds: 300,
        }),
      ]),
    }),
  }),
});

export function validateRegistryR0Contract(contract = REGISTRY_R0_CONTRACT) {
  const identities = contract.identities;
  const roles = identities.map((identity) => identity.role);
  if (
    roles.filter((role) => role === 'publisher').length !== 1 ||
    roles.filter((role) => role === 'audit').length !== 1 ||
    roles.filter((role) => role === 'recovery').length !== 1 ||
    roles.filter((role) => role === 'source-attestor').length !== 1 ||
    roles.filter((role) => role === 'regional-probe').length !== 3
  ) {
    throw new Error('R0 requires publisher, audit, recovery, source-attestor, and three probe identities');
  }
  if (new Set(identities.map((identity) => identity.subjectAccount)).size !== identities.length) {
    throw new Error('R0 identities must be distinct');
  }
  const keys = identities.flatMap((identity) => (identity.key === null ? [] : [identity.key]));
  if (new Set(keys).size !== keys.length) throw new Error('R0 signing keys must be distinct');
  const probeRegions = identities
    .filter((identity) => identity.role === 'regional-probe')
    .map((identity) => identity.region);
  if (probeRegions.some((region) => region === null) || new Set(probeRegions).size !== 3) {
    throw new Error('R0 probe regions must be configured and distinct');
  }
  const humanRoles = new Set(
    identities.filter((identity) => identity.humanOnly).map((identity) => identity.role),
  );
  if (!humanRoles.has('audit') || !humanRoles.has('recovery') || !humanRoles.has('source-attestor')) {
    throw new Error('R0 operator identities must require interactive human impersonation');
  }
  if (
    !contract.publisherRuntime.deny.includes('datastore.*') ||
    !contract.publisherRuntime.deny.includes('cloudkms.cryptoKeyVersions.viewPublicKey') ||
    !contract.publisherRuntime.deny.includes('cloudflare.*')
  ) {
    throw new Error('R0 publisher runtime capability boundary is incomplete');
  }
  if (
    contract.cloudflare.locationHint !== 'wnam' ||
    contract.cloudflare.kvNamespaces !== 0 ||
    contract.cloudflare.publicNamespaceRoutes !== 0 ||
    contract.cloudflare.wafExpression !== 'http.host eq "<normalized-host>"' ||
    contract.cloudflare.logExplorer.sampled !== false ||
    contract.cloudflare.logExplorer.tokenRuntimeVisible !== false ||
    contract.cloudflare.logExplorer.costAlertRequired !== true ||
    JSON.stringify(contract.cloudflare.logExplorer.datasets) !==
      JSON.stringify(['http_requests', 'firewall_events'])
  ) {
    throw new Error('R0 Cloudflare capability/evidence boundary is incomplete');
  }
  const observability = contract.cloudflare.observability;
  const expectedAlertPolicies = [
    { id: 'revision-conflict', outcome: 'conflict', countGreaterThan: 0, windowSeconds: 60 },
    { id: 'aged-revision-gap', outcome: 'gap', gapAgeMsGreaterThan: 300_000, windowSeconds: 60 },
    { id: 'recovery-action', outcome: 'recovered', countGreaterThan: 0, windowSeconds: 60 },
    { id: 'recovery-locked', outcome: 'recovery-locked', countGreaterThan: 0, windowSeconds: 60 },
    {
      id: 'empty-object-cardinality',
      outcome: 'empty-object',
      distinctHostsGreaterThan: 64,
      windowSeconds: 300,
    },
  ];
  if (
    observability?.semanticEvent !== 'event-router-registry.semantic' ||
    JSON.stringify(observability.requiredFields) !==
      JSON.stringify(['outcome', 'registryVersion', 'host', 'revision', 'latencyMs']) ||
    JSON.stringify(observability.excludedFields) !==
      JSON.stringify(['authorization', 'token', 'signature', 'requestBody', 'eventData', 'firebaseKey']) ||
    JSON.stringify(observability.alertPolicies) !== JSON.stringify(expectedAlertPolicies)
  ) {
    throw new Error('R0 registry semantic observability contract is incomplete');
  }
  return contract;
}
