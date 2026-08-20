import type { ProbePrincipal } from './probe';

export const CHALLENGE_PREFIX = 'probe/challenge/';
export const ATTESTATION_PREFIX = 'probe/attestation/';
export const PROBE_EXPIRY_PREFIX = 'probe/expiry/';
export const PROBE_PRINCIPAL_PREFIX = 'probe/principal/';
const PROBE_SWEEP_LIMIT = 64;

export type ProbeSweepStorage = {
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  get<T>(key: string): Promise<T | undefined>;
  delete(keys: string[]): Promise<unknown>;
  setAlarm(scheduledTime: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
};

export type ProbeExpiryIndex = {
  artifactKey: string;
  expiresAt: number;
  principalIndexKey: string;
};

type ProbeExpiryIdentity = {
  artifactKey: string;
  expiresAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedProbePrincipal(value: unknown): ProbePrincipal | null {
  if (
    !isRecord(value) ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    typeof value.keyVersion !== 'string' ||
    value.keyVersion.length === 0 ||
    typeof value.keyFingerprint !== 'string' ||
    value.keyFingerprint.length === 0 ||
    typeof value.region !== 'string' ||
    value.region.length === 0
  ) {
    return null;
  }
  return {
    subject: value.subject,
    keyVersion: value.keyVersion,
    keyFingerprint: value.keyFingerprint,
    region: value.region,
  };
}

function probeExpiryIdentity(indexKey: string): ProbeExpiryIdentity | null {
  if (!indexKey.startsWith(PROBE_EXPIRY_PREFIX)) return null;
  const encoded = indexKey.slice(PROBE_EXPIRY_PREFIX.length);
  const match = /^(\d{16}):(.+)$/.exec(encoded);
  if (match === null) return null;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return null;
  let artifactKey: string;
  try {
    artifactKey = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (
    encodeURIComponent(artifactKey) !== match[2] ||
    (!artifactKey.startsWith(CHALLENGE_PREFIX) && !artifactKey.startsWith(ATTESTATION_PREFIX)) ||
    probeExpiryKey(expiresAt, artifactKey) !== indexKey
  ) {
    return null;
  }
  return { artifactKey, expiresAt };
}

export function probeExpiryKey(expiresAt: number, artifactKey: string): string {
  return `${PROBE_EXPIRY_PREFIX}${String(expiresAt).padStart(16, '0')}:${encodeURIComponent(artifactKey)}`;
}

export function probePrincipalPrefix(principal: ProbePrincipal): string {
  return `${PROBE_PRINCIPAL_PREFIX}${encodeURIComponent(principal.subject)}:${encodeURIComponent(
    principal.keyFingerprint,
  )}:${encodeURIComponent(principal.region)}/`;
}

export function probePrincipalKey(principal: ProbePrincipal, artifactKey: string): string {
  return `${probePrincipalPrefix(principal)}${encodeURIComponent(artifactKey)}`;
}

/**
 * Deletes expired probe artifacts and their quota indexes from an alarm
 * transaction. The expiry key is the durable recovery source of truth: if its
 * value is malformed, the artifact identity and expiry are recovered from the
 * canonical key itself. An unrecoverable key/artifact throws before deletion so
 * the outer alarm handler can retain the only sweep reference and retry.
 */
export async function sweepProbeArtifacts(storage: ProbeSweepStorage, now: number): Promise<void> {
  const indexes = await storage.list<unknown>({
    prefix: PROBE_EXPIRY_PREFIX,
    limit: PROBE_SWEEP_LIMIT,
  });
  const deleteKeys: string[] = [];
  let nextExpiry: number | null = null;
  for (const indexKey of indexes.keys()) {
    const identity = probeExpiryIdentity(indexKey);
    if (identity === null) throw new Error('probe expiry index is malformed');
    if (now <= identity.expiresAt) {
      nextExpiry = identity.expiresAt;
      break;
    }
    const principal = storedProbePrincipal(await storage.get<unknown>(identity.artifactKey));
    if (principal === null) throw new Error('probe expiry artifact is malformed');
    deleteKeys.push(
      identity.artifactKey,
      probePrincipalKey(principal, identity.artifactKey),
      indexKey,
    );
  }
  if (deleteKeys.length > 0) await storage.delete(deleteKeys);
  if (nextExpiry !== null) {
    await storage.setAlarm(nextExpiry + 1);
  } else if (indexes.size === PROBE_SWEEP_LIMIT) {
    await storage.setAlarm(now + 1);
  } else {
    await storage.deleteAlarm();
  }
}
