// Covers specs/auth-handoff-client.md Leg 2. Leg 3 moved to the dedicated
// Worker/coordinator suites in #1060; this file retains the mint wire contract.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.httpsCallable }));
vi.mock('../firebaseCore', () => ({ functions: {} }));

import { HANDOFF_FRAGMENT_KEY } from './handoffClient';
import { mintAuthHandoff } from './handoffExchange';

const CODE = 'C'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mintAuthHandoff', () => {
  it('returns the server-built URL untouched', async () => {
    const mint = vi.fn().mockResolvedValue({
      data: {
        handoffUrl: `${ORIGIN}/board#${HANDOFF_FRAGMENT_KEY}=${CODE}`,
        targetOrigin: ORIGIN,
        expiresAt: 1,
      },
    });
    mocks.httpsCallable.mockReturnValue(mint);

    await expect(
      mintAuthHandoff({
        targetOrigin: ORIGIN,
        transactionId: 'T'.repeat(43),
        returnPath: '/board',
      }),
    ).resolves.toBe(`${ORIGIN}/board#${HANDOFF_FRAGMENT_KEY}=${CODE}`);
  });

  it('never sends a client-supplied uid', async () => {
    const mint = vi.fn().mockResolvedValue({ data: { handoffUrl: ORIGIN } });
    mocks.httpsCallable.mockReturnValue(mint);
    await mintAuthHandoff({
      targetOrigin: ORIGIN,
      transactionId: 'T'.repeat(43),
      returnPath: '/',
    });

    expect(mocks.httpsCallable).toHaveBeenCalledWith({}, 'mintAuthHandoff');
    expect(mint).toHaveBeenCalledWith({
      targetOrigin: ORIGIN,
      transactionId: 'T'.repeat(43),
      returnPath: '/',
    });
  });
});
