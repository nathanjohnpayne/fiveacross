import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  crc32cUtf8,
  fetchPinnedPublicKey,
  mergeImmutableVerificationRecords,
} from './public-key.mjs';

const KEY_VERSION = 'projects/p/locations/global/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1';

function publicPem() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    type: 'spki',
    format: 'pem',
  });
}

describe('provisioning-only KMS public-key pinning', () => {
  it('implements the independently known CRC32C check vector', () => {
    expect(crc32cUtf8('123456789')).toBe(3_808_858_755);
  });

  it('pins the exact version, algorithm, PEM checksum, and SPKI fingerprint', async () => {
    const pem = publicPem();
    const getPublicKey = vi.fn(async (name) => ({
      name,
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      pem,
      pemCrc32c: String(crc32cUtf8(pem)),
    }));
    const record = await fetchPinnedPublicKey(
      {
        role: 'publisher',
        subject: '1001',
        epochOrSlot: '1',
        keyVersion: KEY_VERSION,
      },
      { getPublicKey },
    );
    expect(getPublicKey).toHaveBeenCalledWith(KEY_VERSION);
    expect(record).toMatchObject({
      role: 'publisher',
      subject: '1001',
      epochOrSlot: '1',
      keyVersion: KEY_VERSION,
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      pem,
      spkiSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    ['wrong version', { name: `${KEY_VERSION}-other` }],
    ['wrong algorithm', { algorithm: 'RSA_SIGN_PSS_2048_SHA256' }],
    ['wrong checksum', { pemCrc32c: '1' }],
  ])('fails closed on %s', async (_label, responseOverride) => {
    const pem = publicPem();
    await expect(
      fetchPinnedPublicKey(
        { role: 'publisher', subject: '1001', epochOrSlot: '1', keyVersion: KEY_VERSION },
        {
          getPublicKey: async () => ({
            name: KEY_VERSION,
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
            pem,
            pemCrc32c: String(crc32cUtf8(pem)),
            ...responseOverride,
          }),
        },
      ),
    ).rejects.toThrow();
  });

  it('refuses to mutate an immutable role/epoch mapping', async () => {
    const pem = publicPem();
    const existing = [
      await fetchPinnedPublicKey(
        { role: 'publisher', subject: '1001', epochOrSlot: '1', keyVersion: KEY_VERSION },
        {
          getPublicKey: async () => ({
            name: KEY_VERSION,
            algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
            pem,
            pemCrc32c: String(crc32cUtf8(pem)),
          }),
        },
      ),
    ];
    expect(mergeImmutableVerificationRecords(existing, existing)).toEqual(existing);
    expect(() =>
      mergeImmutableVerificationRecords(existing, [{ ...existing[0], subject: 'changed' }]),
    ).toThrow('immutable');
  });
});
