import { describe, expect, it } from 'vitest';
import { parseHandoffPageMessage, parseHandoffWorkerMessage } from './handoffCommitProtocol';

const attempt = { transactionId: 'transaction', ownerNonce: 'owner' };

describe('handoff Worker protocol parsing', () => {
  it('accepts only nonempty attempt-bound inputs', () => {
    expect(
      parseHandoffPageMessage({
        type: 'initialize',
        attempt,
        firebaseOptions: { apiKey: 'key' },
        tenantId: null,
        emulatorUrl: null,
      }),
    ).not.toBeNull();
    expect(
      parseHandoffPageMessage({ type: 'prepare', attempt, customToken: 'custom-token' }),
    ).not.toBeNull();
    expect(parseHandoffPageMessage({ type: 'prepare', attempt, customToken: '' })).toBeNull();
    expect(
      parseHandoffPageMessage({ type: 'commit', attempt: { ...attempt, ownerNonce: '' } }),
    ).toBeNull();
  });

  it('rejects blank or raw-token-shaped candidates', () => {
    expect(
      parseHandoffWorkerMessage({
        type: 'prepared',
        attempt,
        candidate: { uid: 'user', refreshTokenDigest: 'digest' },
      }),
    ).not.toBeNull();
    expect(
      parseHandoffWorkerMessage({
        type: 'prepared',
        attempt,
        candidate: { uid: '', refreshTokenDigest: 'digest' },
      }),
    ).toBeNull();
    expect(
      parseHandoffWorkerMessage({
        type: 'prepared',
        attempt,
        candidate: { uid: 'user', refreshTokenDigest: '' },
      }),
    ).toBeNull();
    expect(
      parseHandoffWorkerMessage({
        type: 'prepared',
        attempt,
        candidate: { uid: 'user', refreshToken: 'bearer-secret' },
      }),
    ).toBeNull();
    expect(
      parseHandoffWorkerMessage({
        type: 'prepared',
        attempt,
        candidate: {
          uid: 'user',
          refreshTokenDigest: 'digest',
          refreshToken: 'bearer-secret',
        },
      }),
    ).toBeNull();
  });
});
