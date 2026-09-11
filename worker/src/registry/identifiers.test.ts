// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isKmsCryptoKeyVersion, isSha256Hex } from './identifiers';

const CANONICAL_KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';

describe('isKmsCryptoKeyVersion', () => {
  it('accepts the canonical publisher key-version fixture and the test-fixture shapes in use', () => {
    expect(isKmsCryptoKeyVersion(CANONICAL_KEY_VERSION)).toBe(true);
    for (const name of [
      'projects/p/locations/l/keyRings/r/cryptoKeys/recovery/cryptoKeyVersions/1',
      'projects/p/locations/global/keyRings/r/cryptoKeys/probe-west-2/cryptoKeyVersions/1',
      'projects/p/locations/l/keyRings/r/cryptoKeys/source-attestor/cryptoKeyVersions/2',
      'projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/publisher/cryptoKeyVersions/7',
      'projects/p/locations/l/keyRings/key_ring-1/cryptoKeys/A_b-9/cryptoKeyVersions/1234567890',
    ]) {
      expect(isKmsCryptoKeyVersion(name)).toBe(true);
    }
  });

  it('rejects whitespace anywhere in the project or location segment', () => {
    for (const name of [
      'projects/p q/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      'projects/p/locations/l l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      'projects/p\n/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      'projects/p/locations/\tl/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      `${CANONICAL_KEY_VERSION} `,
      ` ${CANONICAL_KEY_VERSION}`,
    ]) {
      expect(isKmsCryptoKeyVersion(name)).toBe(false);
    }
  });

  it('rejects key-ring and crypto-key segments outside the Cloud KMS id alphabet', () => {
    for (const name of [
      'projects/p/locations/l/keyRings/ring.1/cryptoKeys/publisher/cryptoKeyVersions/1',
      'projects/p/locations/l/keyRings/r/cryptoKeys/pub lisher/cryptoKeyVersions/1',
      'projects/p/locations/l/keyRings/r/cryptoKeys/pub:lisher/cryptoKeyVersions/1',
      'projects/p/locations/l/keyRings/r%2F/cryptoKeys/publisher/cryptoKeyVersions/1',
      'projects/p/locations/l/keyRings//cryptoKeys/publisher/cryptoKeyVersions/1',
    ]) {
      expect(isKmsCryptoKeyVersion(name)).toBe(false);
    }
  });

  it('rejects non-canonical version suffixes, wrong collections, and non-strings', () => {
    for (const name of [
      'projects/p/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/0',
      'projects/p/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/01',
      'projects/p/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/-1',
      'projects/p/locations/l/keyRings/r/cryptoKeys/publisher',
      'projects/p/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1/extra',
      '//cloudkms.googleapis.com/projects/p/locations/l/keyRings/r/cryptoKeys/publisher/cryptoKeyVersions/1',
      '',
    ]) {
      expect(isKmsCryptoKeyVersion(name)).toBe(false);
    }
    for (const value of [null, undefined, 1, {}, [CANONICAL_KEY_VERSION]]) {
      expect(isKmsCryptoKeyVersion(value)).toBe(false);
    }
  });
});

describe('isSha256Hex', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects uppercase, wrong length, whitespace, and non-strings', () => {
    for (const value of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      `${'a'.repeat(63)} `,
      ` ${'a'.repeat(63)}`,
      `${'a'.repeat(64)}\n`,
      'g'.repeat(64),
      '',
    ]) {
      expect(isSha256Hex(value)).toBe(false);
    }
    for (const value of [null, undefined, 0, {}, ['a'.repeat(64)]]) {
      expect(isSha256Hex(value)).toBe(false);
    }
  });
});
