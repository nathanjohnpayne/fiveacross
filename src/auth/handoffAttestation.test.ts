import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeHandoffAttestation,
  forgetHandoffAttestation,
  rememberHandoffAttestation,
} from './handoffAttestation';

const acknowledgedSession = { uid: 'sailor-1', refreshToken: 'refresh-one' };

beforeEach(() => forgetHandoffAttestation());

describe('handoff attestation acknowledgement', () => {
  it('is consumed once by the exact uid and refresh token', () => {
    expect(rememberHandoffAttestation(acknowledgedSession)).toBe(true);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(true);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(false);
  });

  it('is retired by a same-uid replacement session', () => {
    expect(rememberHandoffAttestation(acknowledgedSession)).toBe(true);
    expect(
      consumeHandoffAttestation({ ...acknowledgedSession, refreshToken: 'refresh-two' }),
    ).toBe(false);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(false);
  });

  it('is retired by a signed-out first settle', () => {
    expect(rememberHandoffAttestation(acknowledgedSession)).toBe(true);
    expect(consumeHandoffAttestation(null)).toBe(false);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(false);
  });

  it('fails closed when either side has no usable refresh token', () => {
    expect(
      rememberHandoffAttestation({ uid: acknowledgedSession.uid, refreshToken: '' }),
    ).toBe(false);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(false);

    expect(rememberHandoffAttestation(acknowledgedSession)).toBe(true);
    expect(
      consumeHandoffAttestation({ uid: acknowledgedSession.uid, refreshToken: '' }),
    ).toBe(false);
    expect(consumeHandoffAttestation(acknowledgedSession)).toBe(false);
  });
});
