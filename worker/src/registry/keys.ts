export type VerificationRole = 'publisher' | 'recovery' | 'source-attestor' | 'regional-probe';

export type VerificationRecord = {
  role: VerificationRole;
  subject: string;
  epochOrSlot: string;
  keyVersion: string;
  algorithm: 'RSA_SIGN_PKCS1_2048_SHA256';
  pem: string;
  spkiSha256: string;
};

export type PublisherVerificationMapping = {
  epoch: string;
  subject: string;
  keyVersion: string;
  algorithm: VerificationRecord['algorithm'];
  spkiSha256: string;
};

const PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PUBLIC KEY-----\n?$/;
const LOWER_SHA_256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('invalid base64');
  }
}

function spkiBytes(pem: string): Uint8Array {
  const match = PUBLIC_KEY_PEM.exec(pem);
  if (match === null) throw new Error('verification PEM must be SubjectPublicKeyInfo');
  return decodeBase64(match[1].replace(/\n/g, ''));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintSpkiPem(pem: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', spkiBytes(pem));
  return bytesToHex(new Uint8Array(digest));
}

export async function importPinnedVerificationKey(record: VerificationRecord): Promise<CryptoKey> {
  if (record.algorithm !== 'RSA_SIGN_PKCS1_2048_SHA256') {
    throw new Error('unsupported verification algorithm');
  }
  if (!LOWER_SHA_256.test(record.spkiSha256)) throw new Error('invalid SPKI fingerprint');
  const recomputed = await fingerprintSpkiPem(record.pem);
  if (recomputed !== record.spkiSha256) throw new Error('SPKI fingerprint mismatch');
  return crypto.subtle.importKey('spki', spkiBytes(record.pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ]);
}

export function validateVerificationRecordIdentities(
  records: readonly VerificationRecord[],
): readonly VerificationRecord[] {
  const slots = new Set<string>();
  const versions = new Set<string>();
  const fingerprints = new Set<string>();
  const subjectRoles = new Map<string, VerificationRole>();
  const regionalProbeSubjects = new Set<string>();

  for (const record of records) {
    if (record.subject.length === 0 || record.keyVersion.length === 0 || record.epochOrSlot.length === 0) {
      throw new Error('verification record has an empty identity field');
    }
    if (!POSITIVE_DECIMAL.test(record.subject)) {
      throw new Error('verification subject must be a canonical positive decimal');
    }
    if (record.role === 'publisher' && !POSITIVE_DECIMAL.test(record.epochOrSlot)) {
      throw new Error('publisher epoch must be a canonical positive decimal');
    }
    if (record.role === 'regional-probe') {
      if (regionalProbeSubjects.has(record.subject)) {
        throw new Error('regional probe subject must be distinct per slot');
      }
      regionalProbeSubjects.add(record.subject);
    }
    const slot = `${record.role}\u0000${record.epochOrSlot}`;
    if (slots.has(slot)) throw new Error('duplicate role/epoch/slot mapping');
    if (versions.has(record.keyVersion)) throw new Error('duplicate key version mapping');
    if (fingerprints.has(record.spkiSha256)) throw new Error('duplicate fingerprint mapping');
    const subjectRole = subjectRoles.get(record.subject);
    if (subjectRole !== undefined && subjectRole !== record.role) {
      throw new Error('cross-role subject reuse is forbidden');
    }
    slots.add(slot);
    versions.add(record.keyVersion);
    fingerprints.add(record.spkiSha256);
    subjectRoles.set(record.subject, record.role);
  }

  return records;
}

export async function validateVerificationRecords(
  records: readonly VerificationRecord[],
): Promise<readonly VerificationRecord[]> {
  const identityValidated = validateVerificationRecordIdentities(records);
  await Promise.all(identityValidated.map((record) => importPinnedVerificationKey(record)));
  return identityValidated;
}

export async function verifyPinnedSignature(
  record: VerificationRecord,
  exactBytes: Uint8Array,
  signatureBase64: string,
): Promise<boolean> {
  const key = await importPinnedVerificationKey(record);
  let signature: Uint8Array;
  try {
    signature = decodeBase64(signatureBase64);
  } catch {
    return false;
  }
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, exactBytes);
}

export async function verificationRecordMappingDigest(records: readonly VerificationRecord[]): Promise<string> {
  const projection = [...records]
    .map((record) => [
      record.role,
      record.subject,
      record.epochOrSlot,
      record.keyVersion,
      record.algorithm,
      record.spkiSha256,
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(projection)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function publisherVerificationMappings(
  records: readonly VerificationRecord[],
): readonly PublisherVerificationMapping[] {
  return records
    .filter((record) => record.role === 'publisher')
    .map((record) => ({
      epoch: record.epochOrSlot,
      subject: record.subject,
      keyVersion: record.keyVersion,
      algorithm: record.algorithm,
      spkiSha256: record.spkiSha256,
    }))
    .sort((left, right) => {
      const epochOrder =
        BigInt(left.epoch) < BigInt(right.epoch) ? -1 : BigInt(left.epoch) > BigInt(right.epoch) ? 1 : 0;
      return epochOrder || left.keyVersion.localeCompare(right.keyVersion);
    });
}
