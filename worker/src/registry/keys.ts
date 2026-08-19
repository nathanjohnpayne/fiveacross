export type VerificationRole =
  | 'publisher'
  | 'audit'
  | 'recovery'
  | 'source-attestor'
  | 'regional-probe';

export type VerificationRecord = {
  role: VerificationRole;
  subject: string;
  epochOrSlot: string;
  keyVersion: string;
  algorithm: 'RSA_SIGN_PKCS1_2048_SHA256';
  pem: string;
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
  return crypto.subtle.importKey(
    'spki',
    spkiBytes(record.pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export async function validateVerificationRecords(
  records: readonly VerificationRecord[],
): Promise<readonly VerificationRecord[]> {
  const slots = new Set<string>();
  const versions = new Set<string>();
  const fingerprints = new Set<string>();

  for (const record of records) {
    if (record.subject.length === 0 || record.keyVersion.length === 0 || record.epochOrSlot.length === 0) {
      throw new Error('verification record has an empty identity field');
    }
    if (record.role === 'publisher' && !POSITIVE_DECIMAL.test(record.epochOrSlot)) {
      throw new Error('publisher epoch must be canonical positive decimal');
    }
    const slot = `${record.role}\u0000${record.epochOrSlot}`;
    if (slots.has(slot)) throw new Error('duplicate role/epoch/slot mapping');
    if (versions.has(record.keyVersion)) throw new Error('duplicate key version mapping');
    if (fingerprints.has(record.spkiSha256)) throw new Error('duplicate fingerprint mapping');
    slots.add(slot);
    versions.add(record.keyVersion);
    fingerprints.add(record.spkiSha256);
  }

  await Promise.all(records.map((record) => importPinnedVerificationKey(record)));
  return records;
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
