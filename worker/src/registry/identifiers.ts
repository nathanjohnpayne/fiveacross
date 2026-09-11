/**
 * Shared strict validators for the two identifier shapes the registry Worker parses in many
 * places: Cloud KMS `CryptoKeyVersion` resource names and lowercase SHA-256 hex digests.
 *
 * Both patterns were previously copy-pasted into keys.ts, recovery.ts, recoveryHistory.ts,
 * service.ts, telemetry.ts, controlService.ts, probe.ts and storedState.ts, and the copies had
 * already drifted: keys.ts pinned the strict segment classes while every other copy accepted
 * `[^/]+` for all four resource segments — so whitespace, control characters and any other
 * non-`/` byte passed validation outside keys.ts. This module is the single definition, and it
 * keeps the strict keys.ts shape (#1015).
 *
 * Strictness is deliberate and matches Cloud KMS itself: key-ring and crypto-key IDs are limited
 * to letters, numbers, hyphens and underscores, and a version suffix is a positive decimal with
 * no leading zero. Project and location segments stay `[^/\s]+` because their own grammars are
 * owned by Google, not by this Worker; rejecting embedded whitespace is the part that matters for
 * header parsing and log integrity.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

const KMS_CRYPTO_KEY_VERSION =
  /^projects\/[^/\s]+\/locations\/[^/\s]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9]\d*$/;

/** A lowercase, unpadded, 64-character hex SHA-256 digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** A canonical Cloud KMS `projects/…/cryptoKeyVersions/<n>` resource name. */
export function isKmsCryptoKeyVersion(value: unknown): value is string {
  return typeof value === 'string' && KMS_CRYPTO_KEY_VERSION.test(value);
}
