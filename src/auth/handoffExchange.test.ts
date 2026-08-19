// Covers specs/auth-handoff-client.md § The three legs and § Failure states —
// the two legs that call Cloud Functions (#549).
//
// The invariants worth the most: the server-built return URL is used verbatim
// rather than assembled (that is what keeps the return leg from being an open
// redirect), no uid is ever sent to mint, and the verifier is gone on every
// terminal path — success included.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  httpsCallable: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('firebase/functions', () => ({ httpsCallable: mocks.httpsCallable }));
vi.mock('firebase/auth', () => ({
  signInWithCustomToken: mocks.signInWithCustomToken,
  signOut: mocks.signOut,
}));
vi.mock('../firebase', () => ({ auth: {}, functions: {} }));

import { HANDOFF_FRAGMENT_KEY, consumeHandoffFailure } from './handoffClient';
import { HANDOFF_EXCHANGE_TIMEOUT_MS, completeAuthHandoff, mintAuthHandoff } from './handoffExchange';
import {
  HANDOFF_TRANSACTION_KEY,
  rememberHandoffTransaction,
  readHandoffTransaction,
} from './handoffTransaction';

const CODE = 'C'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

/** Point `httpsCallable` at one fake per callable name. */
function callables(impl: Record<string, (payload: unknown) => Promise<{ data: unknown }>>) {
  mocks.httpsCallable.mockImplementation((_fns: unknown, name: string) => {
    const fn = impl[name];
    if (!fn) throw new Error(`unexpected callable ${name}`);
    return fn;
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('localStorage', memoryStorage());
  mocks.httpsCallable.mockReset();
  mocks.signInWithCustomToken.mockReset().mockResolvedValue({ user: { uid: 'u1' } });
  mocks.signOut.mockReset().mockResolvedValue(undefined);
  consumeHandoffFailure();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mintAuthHandoff', () => {
  it('returns the server-built URL untouched', async () => {
    const mint = vi.fn().mockResolvedValue({
      data: { handoffUrl: `${ORIGIN}/board#${HANDOFF_FRAGMENT_KEY}=${CODE}`, targetOrigin: ORIGIN, expiresAt: 1 },
    });
    callables({ mintAuthHandoff: mint });

    const url = await mintAuthHandoff({
      targetOrigin: ORIGIN,
      transactionId: 'T'.repeat(43),
      returnPath: '/board',
    });

    expect(url).toBe(`${ORIGIN}/board#${HANDOFF_FRAGMENT_KEY}=${CODE}`);
    expect(mint).toHaveBeenCalledWith({
      targetOrigin: ORIGIN,
      transactionId: 'T'.repeat(43),
      returnPath: '/board',
    });
  });

  // The uid comes from `request.auth`, which the runtime derives from a verified
  // ID token. A client-supplied uid would let any signed-in caller mint a code
  // bound to somebody else's identity — the takeover the design exists to stop.
  it('never sends a uid', async () => {
    const mint = vi.fn().mockResolvedValue({ data: { handoffUrl: ORIGIN } });
    callables({ mintAuthHandoff: mint });
    await mintAuthHandoff({ targetOrigin: ORIGIN, transactionId: 'T'.repeat(43), returnPath: '/' });
    expect(Object.keys(mint.mock.calls[0][0] as object)).toEqual([
      'targetOrigin',
      'transactionId',
      'returnPath',
    ]);
  });
});

describe('completeAuthHandoff', () => {
  function armTransaction(overrides: Partial<{ targetOrigin: string; verifier: string }> = {}) {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      createdAt: Date.now(),
      ...overrides,
    });
  }

  it('exchanges the code and signs in', async () => {
    armTransaction();
    const exchange = vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } });
    callables({ exchangeAuthHandoff: exchange });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(exchange).toHaveBeenCalledWith({
      code: CODE,
      transactionVerifier: 'V'.repeat(43),
      origin: ORIGIN,
    });
    expect(mocks.signInWithCustomToken).toHaveBeenCalledWith({}, 'ct-1');
    expect(consumeHandoffFailure()).toBeNull();
  });

  // "Delete it the moment the exchange completes or fails" — success included.
  // A verifier that outlives its transaction is a credential guarding nothing.
  it('deletes the verifier on success', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    await completeAuthHandoff({ code: CODE, origin: ORIGIN });
    expect(readHandoffTransaction(Date.now())).toBeNull();
    expect(sessionStorage.getItem(HANDOFF_TRANSACTION_KEY)).toBeNull();
    expect(localStorage.getItem(HANDOFF_TRANSACTION_KEY)).toBeNull();
  });

  it('fails when the verifier is gone, without calling the server', async () => {
    const exchange = vi.fn();
    callables({ exchangeAuthHandoff: exchange });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'transaction-missing' });
  });

  // Refusing here does not replace the server's origin check — it just declines
  // to send this origin's verifier somewhere it does not belong.
  it('fails on an origin the transaction did not start at, without sending the verifier', async () => {
    armTransaction({ targetOrigin: 'https://elsewhere.fiveacross.app' });
    const exchange = vi.fn();
    callables({ exchangeAuthHandoff: exchange });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'origin-mismatch' });
  });

  it('fails and clears the verifier when the server rejects the exchange', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockRejectedValue(new Error('permission-denied')) });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(readHandoffTransaction(Date.now())).toBeNull();
    expect(mocks.signInWithCustomToken).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'exchange-rejected' });
  });

  it('fails when the custom token does not produce a session', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockRejectedValue(new Error('invalid token'));
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  // Single use is enforced server-side; the client simply must not hold anything
  // that would let it try twice.
  it('cannot be replayed from the client, because the verifier is already gone', async () => {
    armTransaction();
    const exchange = vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } });
    callables({ exchangeAuthHandoff: exchange });

    await completeAuthHandoff({ code: CODE, origin: ORIGIN });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

// `main.tsx` awaits the return leg BEFORE it renders anything, so an exchange
// that never settles renders nothing at all — the blank-screen shape the whole
// bootstrap path is written to avoid. Captive and shipboard wifi produce exactly
// that: `navigator.onLine` true and a request that hangs forever.
describe('completeAuthHandoff is bounded against a hung network', () => {
  function armTransaction() {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      createdAt: Date.now(),
    });
  }

  it('gives up on an exchange that never settles, rather than hanging the mount', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: () => new Promise(() => {}) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'exchange-rejected' });
    // Still cleared: a verifier whose code is spent must not outlive the attempt
    // just because the network stalled.
    expect(readHandoffTransaction(Date.now())).toBeNull();
  });

  it('gives up on a sign-in that never settles', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockImplementation(() => new Promise(() => {}));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('leaves room for a slow phone on bad wifi rather than a snappy default', () => {
    expect(HANDOFF_EXCHANGE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// Codex P2, round 1. `bounded` REJECTS, it does not CANCEL — so a slow
// signInWithCustomToken can still succeed after we have given up. By then
// main.tsx has mounted the app signed out and the player is on a retry prompt,
// so a session materialising underneath is either a surprise entry into the app
// or a race against the second handoff they just started.
describe('a timed-out sign-in cannot mutate auth state later', () => {
  function armTransaction() {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      createdAt: Date.now(),
    });
  }

  it('signs out an attempt that lands after the bound gave up', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    let land: (v: unknown) => void = () => {};
    mocks.signInWithCustomToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
    expect(mocks.signOut).not.toHaveBeenCalled();

    // …and now the abandoned operation completes.
    land({ user: { uid: 'u1' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('leaves a sign-in that lands inside the bound completely alone', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

// Phase 4b P1. The failure surface invites an immediate retry, so the likely
// sequence is: attempt 1 times out, the player taps again, attempt 2 SUCCEEDS,
// and only then does attempt 1's abandoned promise resolve. An unconditional
// sign-out at that point destroys the good session attempt 2 just established.
describe('late reconciliation is generation-aware', () => {
  function armTransaction() {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      createdAt: Date.now(),
    });
  }

  it('does NOT sign out when a newer attempt has already succeeded', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    let landFirst: (v: unknown) => void = () => {};
    mocks.signInWithCustomToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landFirst = resolve;
        }),
    );

    // Attempt 1 times out.
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    consumeHandoffFailure();

    // The player retries; attempt 2 succeeds.
    armTransaction();
    mocks.signInWithCustomToken.mockResolvedValue({ user: { uid: 'u1' } });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);

    // Only NOW does attempt 1's abandoned promise land.
    landFirst({ user: { uid: 'u1' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('still signs out when no newer attempt intervened', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    let land: (v: unknown) => void = () => {};
    mocks.signInWithCustomToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    land({ user: { uid: 'u1' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
});
