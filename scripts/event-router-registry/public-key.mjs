import { createHash, createPublicKey } from 'node:crypto';

const REQUIRED_ALGORITHM = 'RSA_SIGN_PKCS1_2048_SHA256';
const ROLES = new Set(['publisher', 'recovery', 'source-attestor', 'regional-probe']);

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32cUtf8(value) {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(value)) {
    crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPinRequest(request) {
  if (!ROLES.has(request.role)) throw new Error('invalid verification role');
  for (const field of ['subject', 'epochOrSlot', 'keyVersion']) {
    if (typeof request[field] !== 'string' || request[field].length === 0) {
      throw new Error(`invalid ${field}`);
    }
  }
  if (request.role === 'publisher' && !/^[1-9]\d*$/.test(request.epochOrSlot)) {
    throw new Error('publisher epoch must be canonical positive decimal');
  }
}

function fingerprintPem(pem) {
  const publicKey = createPublicKey(pem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export async function fetchPinnedPublicKey(request, deps) {
  assertPinRequest(request);
  const response = await deps.getPublicKey(request.keyVersion);
  if (response.name !== request.keyVersion) throw new Error('KMS returned the wrong key version');
  if (response.algorithm !== REQUIRED_ALGORITHM) throw new Error('KMS returned the wrong algorithm');
  if (typeof response.pem !== 'string' || !response.pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error('KMS returned an invalid public key PEM');
  }
  if (!/^\d+$/.test(String(response.pemCrc32c))) throw new Error('KMS omitted pemCrc32c');
  if (BigInt(response.pemCrc32c) !== BigInt(crc32cUtf8(response.pem))) {
    throw new Error('KMS public key PEM checksum mismatch');
  }
  return Object.freeze({
    ...request,
    algorithm: REQUIRED_ALGORITHM,
    pem: response.pem,
    spkiSha256: fingerprintPem(response.pem),
  });
}

function recordSlot(record) {
  return `${record.role}\u0000${record.epochOrSlot}`;
}

function stableRecord(record) {
  return JSON.stringify({
    role: record.role,
    subject: record.subject,
    epochOrSlot: record.epochOrSlot,
    keyVersion: record.keyVersion,
    algorithm: record.algorithm,
    pem: record.pem,
    spkiSha256: record.spkiSha256,
  });
}

export function mergeImmutableVerificationRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [recordSlot(record), record]));
  for (const record of incoming) {
    const slot = recordSlot(record);
    const prior = merged.get(slot);
    if (prior !== undefined && stableRecord(prior) !== stableRecord(record)) {
      throw new Error(`immutable verification mapping changed: ${record.role}/${record.epochOrSlot}`);
    }
    merged.set(slot, prior ?? record);
  }
  const result = [...merged.values()];
  const keyVersions = new Set();
  const fingerprints = new Set();
  const subjectRoles = new Map();
  for (const record of result) {
    if (keyVersions.has(record.keyVersion)) throw new Error('duplicate key version mapping');
    if (fingerprints.has(record.spkiSha256)) throw new Error('duplicate fingerprint mapping');
    const subjectRole = subjectRoles.get(record.subject);
    if (subjectRole !== undefined && subjectRole !== record.role) {
      throw new Error('cross-role subject reuse is forbidden');
    }
    keyVersions.add(record.keyVersion);
    fingerprints.add(record.spkiSha256);
    subjectRoles.set(record.subject, record.role);
  }
  return result;
}
