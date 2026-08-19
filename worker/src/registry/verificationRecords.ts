import { validateVerificationRecordIdentities, type VerificationRecord } from './keys';

/**
 * Provisioning writes reviewed public verification records here before the
 * registry can accept a request. Keeping these public keys in source makes a
 * role/epoch change an immutable, reviewable deployment change; no runtime
 * environment variable or Google credential can replace the mapping.
 *
 * Empty is deliberately fail-closed for the private, unprovisioned tracer.
 * `scripts/event-router-registry/pin-public-key.mjs` emits records in this
 * exact shape after checking the KMS version, algorithm, PEM CRC32C and SPKI
 * fingerprint. No private key or OAuth credential belongs in this file.
 */
const REGISTRY_VERIFICATION_RECORD_CONFIG: readonly VerificationRecord[] = Object.freeze([]);

// Role/subject/slot/key uniqueness is synchronous and runs as the module is
// instantiated. Invalid reviewed identity configuration therefore prevents a
// Worker isolate from starting rather than waiting for the first request.
export const REGISTRY_VERIFICATION_RECORDS = validateVerificationRecordIdentities(
  REGISTRY_VERIFICATION_RECORD_CONFIG,
);

export const REGISTRY_SYNC_AUDIENCE =
  'https://five-across-event-registry.nathanpayne.workers.dev/__internal/hostname-replicas/v1';

const REGISTRY_ORIGIN = 'https://five-across-event-registry.nathanpayne.workers.dev';

export const REGISTRY_ROLE_AUDIENCES = {
  audit: `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1/audit`,
  recovery: `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1/recover`,
  'source-attestor': `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1/source-attestor`,
  'regional-probe': `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1/regional-probe`,
} as const;

// Provisioning replaces this fail-closed placeholder with the dedicated audit
// service account's numeric Google subject before any private audit is run.
export const REGISTRY_AUDIT_SUBJECT = '';

// Provisioning replaces this fail-closed map with the reviewed Cloudflare
// zone and account-level custom-ruleset identifiers for each served
// Namespace. Recovery refuses WAF evidence until the exact mapping is pinned.
export const REGISTRY_RECOVERY_ZONES = Object.freeze({});
