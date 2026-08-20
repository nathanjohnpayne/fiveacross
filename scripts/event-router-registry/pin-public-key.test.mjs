import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { crc32cUtf8 } from './public-key.mjs';
import {
  parsePinPublicKeyArgs,
  pinPublicKeyFromResponse,
  runPinPublicKeyCli,
} from './pin-public-key.mjs';

const KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';

function publicPem() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    type: 'spki',
    format: 'pem',
  });
}

function responseFor(pem = publicPem()) {
  return {
    name: KEY_VERSION,
    algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
    pem,
    pemCrc32c: String(crc32cUtf8(pem)),
    protectionLevel: 'SOFTWARE',
  };
}

const ARGS = [
  '--role=publisher',
  '--subject=1001',
  '--epoch-or-slot=1',
  `--key-version=${KEY_VERSION}`,
  '--kms-response=-',
];

describe('reviewed public-key provisioning renderer', () => {
  it('parses only the closed provisioning input schema', () => {
    expect(parsePinPublicKeyArgs(ARGS)).toEqual({
      request: {
        role: 'publisher',
        subject: '1001',
        epochOrSlot: '1',
        keyVersion: KEY_VERSION,
      },
      kmsResponsePath: '-',
    });
    expect(() => parsePinPublicKeyArgs([...ARGS, '--access-token=secret'])).toThrow('unknown argument');
    expect(() => parsePinPublicKeyArgs([...ARGS, '--role=recovery'])).toThrow('duplicate argument');
  });

  it('exact-reads one injected KMS version and emits a reviewed VerificationRecord', async () => {
    const getPublicKey = vi.fn(async () => responseFor());
    const record = await pinPublicKeyFromResponse(
      {
        role: 'publisher',
        subject: '1001',
        epochOrSlot: '1',
        keyVersion: KEY_VERSION,
      },
      { getPublicKey },
    );
    expect(getPublicKey).toHaveBeenCalledExactlyOnceWith(KEY_VERSION);
    expect(Object.keys(record)).toEqual([
      'role',
      'subject',
      'epochOrSlot',
      'keyVersion',
      'algorithm',
      'pem',
      'spkiSha256',
    ]);
    expect(record).toMatchObject({
      role: 'publisher',
      subject: '1001',
      epochOrSlot: '1',
      keyVersion: KEY_VERSION,
      algorithm: 'RSA_SIGN_PKCS1_2048_SHA256',
      spkiSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('runs from an injected/stdin response without credentials or provider writes', async () => {
    const writes = [];
    const readText = vi.fn(async (path) => {
      expect(path).toBe('-');
      return JSON.stringify(responseFor());
    });
    await runPinPublicKeyCli(ARGS, {
      readText,
      writeStdout: (text) => writes.push(text),
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      role: 'publisher',
      keyVersion: KEY_VERSION,
    });
    expect(writes[0]).not.toContain('access_token');
    expect(writes[0]).not.toContain('private_key');
  });

  it.each([
    ['unknown response field', { oauthToken: 'secret' }],
    ['missing response field', { pemCrc32c: undefined }],
    ['wrong resource', { name: `${KEY_VERSION}0` }],
  ])('fails closed on %s', async (_label, override) => {
    const response = { ...responseFor(), ...override };
    if (response.pemCrc32c === undefined) delete response.pemCrc32c;
    await expect(
      pinPublicKeyFromResponse(
        {
          role: 'publisher',
          subject: '1001',
          epochOrSlot: '1',
          keyVersion: KEY_VERSION,
        },
        { getPublicKey: async () => response },
      ),
    ).rejects.toThrow();
  });
});
