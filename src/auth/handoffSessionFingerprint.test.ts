import { describe, expect, it } from 'vitest';
import { fingerprintHandoffSession } from './handoffSessionFingerprint';

describe('handoff session fingerprint', () => {
  it('binds the uid and refresh token to one attempt without retaining the token', async () => {
    const input = {
      ownerNonce: 'attempt-one',
      uid: 'same-user',
      refreshToken: 'long-lived-refresh-token',
    };

    const first = await fingerprintHandoffSession(input);
    expect(first).toBe(await fingerprintHandoffSession(input));
    expect(first).not.toContain(input.refreshToken);
    expect(first).not.toBe(
      await fingerprintHandoffSession({ ...input, refreshToken: 'replacement-refresh-token' }),
    );
    expect(first).not.toBe(
      await fingerprintHandoffSession({ ...input, ownerNonce: 'attempt-two' }),
    );
  });
});
