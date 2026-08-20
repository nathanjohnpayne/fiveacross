// @vitest-environment node
import { createHash, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fingerprintSpkiPem,
  importPinnedVerificationKey,
  validateVerificationRecordIdentities,
  validateVerificationRecords,
  verifyPinnedSignature,
  type VerificationRecord,
} from './keys';

function toBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64');
}

async function fixtureRecord(
  overrides: Partial<VerificationRecord> = {},
  modulusLength = 2048,
): Promise<{ record: VerificationRecord; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki)
    .toString('base64')
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END PUBLIC KEY-----\n`;
  const fingerprint = createHash('sha256')
    .update(createPublicKey(pem).export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return {
    record: {
      role: 'publisher',
      subject: '1001',
      epochOrSlot: '1',
      keyVersion: 'projects/p/locations/global/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      pem,
      spkiSha256: fingerprint,
      ...overrides,
    },
    privateKey: pair.privateKey,
  };
}

describe('immutable pinned verification records', () => {
  it('reparses SPKI, recomputes the fingerprint, and imports only RSA/SHA-256', async () => {
    const { record } = await fixtureRecord();
    expect(await fingerprintSpkiPem(record.pem)).toBe(record.spkiSha256);
    const key = await importPinnedVerificationKey(record);
    expect(key.algorithm).toMatchObject({ name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } });
    await expect(validateVerificationRecords([record])).resolves.toEqual([record]);
  });

  it('rejects a fingerprint-valid RSA key whose imported modulus is not 2048 bits', async () => {
    const { record } = await fixtureRecord({}, 4096);
    await expect(validateVerificationRecords([record])).rejects.toThrow('2048-bit');
  });

  it.each([
    ['mismatched fingerprint', { spkiSha256: '0'.repeat(64) }],
    ['wrong algorithm', { algorithm: 'RSA_SIGN_PSS_2048_SHA256' }],
    ['noncanonical KMS key version', { keyVersion: 'not-a-kms-crypto-key-version' }],
    ['non-numeric publisher epoch', { epochOrSlot: '01' }],
    ['non-numeric publisher subject', { subject: 'publisher@example.com' }],
    ['non-numeric recovery subject', { role: 'recovery', epochOrSlot: 'primary', subject: 'recovery@example.com' }],
    [
      'zero-valued regional-probe subject',
      { role: 'regional-probe', epochOrSlot: 'us-west1', subject: '0' },
    ],
  ])('rejects a %s before runtime use', async (_label, override) => {
    const { record } = await fixtureRecord(override as Partial<VerificationRecord>);
    await expect(validateVerificationRecords([record])).rejects.toThrow();
  });

  it('rejects duplicate role slots, key versions, and fingerprints', async () => {
    const first = await fixtureRecord();
    const sameSlot = await fixtureRecord({ keyVersion: first.record.keyVersion.replace(/\/1$/, '/2') });
    await expect(validateVerificationRecords([first.record, sameSlot.record])).rejects.toThrow('role/epoch/slot');

    const duplicateVersion = {
      ...sameSlot.record,
      role: 'recovery' as const,
      epochOrSlot: 'primary',
      keyVersion: first.record.keyVersion,
    };
    await expect(validateVerificationRecords([first.record, duplicateVersion])).rejects.toThrow('key version');

    const duplicateFingerprint = {
      ...first.record,
      role: 'recovery' as const,
      epochOrSlot: 'primary',
      keyVersion: first.record.keyVersion.replace(/\/1$/, '/3'),
    };
    await expect(validateVerificationRecords([first.record, duplicateFingerprint])).rejects.toThrow('fingerprint');
  });

  it('rejects one workload subject reused across security roles', async () => {
    const publisher = await fixtureRecord();
    const recovery = await fixtureRecord({
      role: 'recovery',
      epochOrSlot: 'primary',
      subject: publisher.record.subject,
      keyVersion: 'projects/p/locations/global/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
    });
    await expect(validateVerificationRecords([publisher.record, recovery.record])).rejects.toThrow(
      'cross-role subject',
    );
  });

  it('requires every regional probe slot to have its own numeric Google subject', async () => {
    const west = await fixtureRecord({
      role: 'regional-probe',
      epochOrSlot: 'us-west1',
      subject: '3003',
      keyVersion: 'projects/p/locations/global/keyRings/r/cryptoKeys/probe-west/cryptoKeyVersions/1',
    });
    const east = await fixtureRecord({
      role: 'regional-probe',
      epochOrSlot: 'us-east1',
      subject: west.record.subject,
      keyVersion: 'projects/p/locations/global/keyRings/r/cryptoKeys/probe-east/cryptoKeyVersions/1',
    });

    await expect(validateVerificationRecords([west.record, east.record])).rejects.toThrow(
      'regional probe subject',
    );

    const duplicateWestSlot = await fixtureRecord({
      role: 'regional-probe',
      epochOrSlot: west.record.epochOrSlot,
      subject: '4004',
      keyVersion: 'projects/p/locations/global/keyRings/r/cryptoKeys/probe-west-2/cryptoKeyVersions/1',
    });
    await expect(validateVerificationRecords([west.record, duplicateWestSlot.record])).rejects.toThrow(
      'role/epoch/slot',
    );
  });

  it('validates role identity shape synchronously for Worker startup', async () => {
    const { record } = await fixtureRecord({
      role: 'source-attestor',
      epochOrSlot: 'source',
      subject: 'source@example.com',
    });
    expect(() => validateVerificationRecordIdentities([record])).toThrow(
      'canonical positive decimal',
    );
  });

  it('verifies exact bytes and refuses altered or cross-role signatures', async () => {
    const publisher = await fixtureRecord();
    const recovery = await fixtureRecord({ role: 'recovery', epochOrSlot: 'primary', subject: '2002' });
    const bytes = new TextEncoder().encode('v1\nPOST\n/path\n123\n1\ndigest');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', publisher.privateKey, bytes);

    await expect(verifyPinnedSignature(publisher.record, bytes, toBase64(signature))).resolves.toBe(true);
    await expect(
      verifyPinnedSignature(publisher.record, new TextEncoder().encode('altered'), toBase64(signature)),
    ).resolves.toBe(false);
    await expect(verifyPinnedSignature(recovery.record, bytes, toBase64(signature))).resolves.toBe(false);
  });
});
