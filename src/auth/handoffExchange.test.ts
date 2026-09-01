// Covers specs/auth-handoff-client.md § The three legs and § Failure states —
// the two legs that call Cloud Functions (#549).
//
// The invariants worth the most: the server-built return URL is used verbatim
// rather than assembled (that is what keeps the return leg from being an open
// redirect), no uid is ever sent to mint, and the verifier is gone on every
// terminal path — success included.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  deleteApp: vi.fn(),
  initializeAuth: vi.fn(),
  connectAuthEmulator: vi.fn(),
  inMemoryPersistence: { type: 'NONE' },
  httpsCallable: vi.fn(),
  signInWithCustomToken: vi.fn(),
  updateCurrentUser: vi.fn(),
  rememberHandoffAttestation: vi.fn(),
  firebaseEmulatorsEnabled: vi.fn(),
  primaryApp: { options: { apiKey: 'test-api-key', projectId: 'test-project' } },
  primaryAuth: {
    authStateReady: vi.fn(),
    currentUser: null as unknown,
    emulatorConfig: null as unknown,
    tenantId: null as string | null,
  },
  persistedSession: { user: null as unknown },
}));

vi.mock('firebase/app', () => ({
  initializeApp: mocks.initializeApp,
  deleteApp: mocks.deleteApp,
}));
vi.mock('firebase/functions', () => ({ httpsCallable: mocks.httpsCallable }));
vi.mock('firebase/auth', () => ({
  initializeAuth: mocks.initializeAuth,
  connectAuthEmulator: mocks.connectAuthEmulator,
  inMemoryPersistence: mocks.inMemoryPersistence,
  signInWithCustomToken: mocks.signInWithCustomToken,
  updateCurrentUser: mocks.updateCurrentUser,
}));
vi.mock('../firebase', () => ({
  app: mocks.primaryApp,
  auth: mocks.primaryAuth,
  functions: {},
  firebaseEmulatorsEnabled: mocks.firebaseEmulatorsEnabled,
}));
vi.mock('./handoffAttestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./handoffAttestation')>()),
  rememberHandoffAttestation: mocks.rememberHandoffAttestation,
}));

import { HANDOFF_FRAGMENT_KEY, consumeHandoffFailure } from './handoffClient';
import { HANDOFF_EXCHANGE_TIMEOUT_MS, completeAuthHandoff, mintAuthHandoff } from './handoffExchange';
import {
  HANDOFF_TRANSACTION_KEY,
  HANDOFF_TRANSACTION_TTL_MS,
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

/** Model the installed SDK: the target Auth is persisted before sign-in resolves. */
function firebaseSignInResult(targetAuth: unknown, user: unknown): { user: unknown } {
  (targetAuth as { currentUser: unknown }).currentUser = user;
  if (targetAuth === mocks.primaryAuth) mocks.persistedSession.user = user;
  return { user };
}

function deferredFirebaseSignIn() {
  let settle: (user: unknown) => void = () => {
    throw new Error('sign-in has not started');
  };
  return {
    implementation: (targetAuth: unknown) =>
      new Promise((resolve) => {
        settle = (user) => resolve(firebaseSignInResult(targetAuth, user));
      }),
    land: (user: unknown) => settle(user),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('localStorage', memoryStorage());
  mocks.initializeApp.mockReset().mockImplementation((options: unknown, name: string) => ({ name, options }));
  mocks.deleteApp.mockReset().mockResolvedValue(undefined);
  mocks.initializeAuth.mockReset().mockImplementation((isolatedApp: unknown, deps: unknown) => ({
    app: isolatedApp,
    currentUser: null,
    emulatorConfig: null,
    tenantId: null,
    persistence: (deps as { persistence: unknown }).persistence,
  }));
  mocks.connectAuthEmulator.mockReset();
  mocks.httpsCallable.mockReset();
  mocks.signInWithCustomToken.mockReset().mockImplementation(async (targetAuth: unknown) => {
    return firebaseSignInResult(targetAuth, { uid: 'u1' });
  });
  mocks.updateCurrentUser.mockReset().mockImplementation(async (targetAuth: unknown, user: unknown) => {
    (targetAuth as { currentUser: unknown }).currentUser = user;
    if (targetAuth === mocks.primaryAuth) mocks.persistedSession.user = user;
  });
  mocks.rememberHandoffAttestation.mockReset().mockReturnValue(true);
  mocks.firebaseEmulatorsEnabled.mockReset().mockReturnValue(false);
  mocks.primaryAuth.authStateReady.mockReset().mockResolvedValue(undefined);
  mocks.primaryAuth.currentUser = null;
  mocks.primaryAuth.emulatorConfig = null;
  mocks.primaryAuth.tenantId = null;
  mocks.persistedSession.user = null;
  consumeHandoffFailure();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  function armTransaction(
    overrides: Partial<{
      targetOrigin: string;
      verifier: string;
      acknowledgedAdultContent: boolean;
      createdAt: number;
    }> = {},
  ) {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      acknowledgedAdultContent: false,
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
    expect(mocks.signInWithCustomToken).toHaveBeenCalledWith(
      expect.objectContaining({ persistence: mocks.inMemoryPersistence }),
      'ct-1',
    );
    expect(mocks.updateCurrentUser).toHaveBeenCalledWith(mocks.primaryAuth, { uid: 'u1' });
    expect(mocks.deleteApp).toHaveBeenCalledOnce();
    expect(consumeHandoffFailure()).toBeNull();
  });

  it('mirrors the primary tenant and Auth Emulator before sign-in in an e2e build', async () => {
    const emulator = {
      protocol: 'http',
      host: '127.0.0.1',
      port: 9099,
      options: { disableWarnings: true },
    };
    mocks.firebaseEmulatorsEnabled.mockReturnValue(true);
    mocks.primaryAuth.tenantId = 'tenant-1';
    mocks.primaryAuth.emulatorConfig = emulator;
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);

    const isolatedAuth = mocks.initializeAuth.mock.results[0]?.value as { tenantId: string | null };
    expect(mocks.initializeAuth).toHaveBeenCalledWith(expect.anything(), {
      persistence: mocks.inMemoryPersistence,
      popupRedirectResolver: undefined,
    });
    expect(isolatedAuth.tenantId).toBe('tenant-1');
    expect(mocks.connectAuthEmulator).toHaveBeenCalledWith(
      isolatedAuth,
      'http://127.0.0.1:9099',
      emulator.options,
    );
    expect(mocks.connectAuthEmulator.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInWithCustomToken.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('does not connect the isolated Auth to an emulator outside an e2e build', async () => {
    mocks.primaryAuth.emulatorConfig = {
      protocol: 'http',
      host: '127.0.0.1',
      port: 9099,
      options: { disableWarnings: true },
    };
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.connectAuthEmulator).not.toHaveBeenCalled();
  });

  it('stages a collected acknowledgement for the exact session returned by this handoff', async () => {
    const returnedUser = { uid: 'handoff-user', refreshToken: 'handoff-refresh-token' };
    armTransaction({ acknowledgedAdultContent: true });
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockResolvedValue({ user: returnedUser });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.rememberHandoffAttestation).toHaveBeenCalledOnce();
    expect(mocks.rememberHandoffAttestation).toHaveBeenCalledWith(returnedUser);
  });

  it('does not turn a live session into sign-in-failed when attestation staging throws', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    armTransaction({ acknowledgedAdultContent: true });
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.rememberHandoffAttestation.mockImplementation(() => {
      throw new Error('staging failed');
    });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(consumeHandoffFailure()).toBeNull();
    expect(debug).toHaveBeenCalledWith('[auth-handoff] adult attestation handoff could not be staged');
  });

  it('does not stage attestation when this handoff collected no acknowledgement', async () => {
    armTransaction({ acknowledgedAdultContent: false });
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.rememberHandoffAttestation).not.toHaveBeenCalled();
  });

  it('cannot use an expired handoff acknowledgement', async () => {
    armTransaction({
      acknowledgedAdultContent: true,
      createdAt: Date.now() - HANDOFF_TRANSACTION_TTL_MS - 1,
    });
    const exchange = vi.fn();
    callables({ exchangeAuthHandoff: exchange });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(mocks.rememberHandoffAttestation).not.toHaveBeenCalled();
  });

  it('cannot carry an abandoned acknowledgement into its replacement transaction', async () => {
    armTransaction({ verifier: 'A'.repeat(43), acknowledgedAdultContent: true });
    armTransaction({ verifier: 'B'.repeat(43), acknowledgedAdultContent: false });
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.rememberHandoffAttestation).not.toHaveBeenCalled();
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

  it('fails and deletes the isolated app when the primary session commit rejects', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.updateCurrentUser.mockRejectedValue(new Error('primary persistence failed'));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(mocks.persistedSession.user).toBeNull();
    expect(mocks.deleteApp).toHaveBeenCalledOnce();
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('reports success when primary persistence rejects after installing this exact session in memory', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const returnedUser = { uid: 'u1', refreshToken: 'handoff-refresh-token' };
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockResolvedValue({ user: returnedUser });
    mocks.updateCurrentUser.mockImplementation(async (targetAuth: unknown, user: unknown) => {
      // Firebase Auth assigns currentUser before awaiting persistence. A failed
      // IndexedDB write therefore rejects after the in-memory session exists.
      (targetAuth as { currentUser: unknown }).currentUser = { ...(user as object) };
      throw new Error('primary persistence failed');
    });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.primaryAuth.currentUser).toEqual(returnedUser);
    expect(mocks.persistedSession.user).toBeNull();
    expect(consumeHandoffFailure()).toBeNull();
    expect(debug).toHaveBeenCalledWith(
      '[auth-handoff] primary persistence rejected after the session entered memory',
    );
  });

  it('does not mistake a different same-uid session for this handoff after commit rejection', async () => {
    const returnedUser = { uid: 'same-user', refreshToken: 'handoff-refresh-token' };
    const newerUser = { uid: 'same-user', refreshToken: 'newer-refresh-token' };
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockResolvedValue({ user: returnedUser });
    mocks.updateCurrentUser.mockImplementation(async (targetAuth: unknown) => {
      (targetAuth as { currentUser: unknown }).currentUser = newerUser;
      throw new Error('primary persistence failed');
    });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(false);
    expect(mocks.primaryAuth.currentUser).toBe(newerUser);
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
  function armTransaction(acknowledgedAdultContent = false) {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      acknowledgedAdultContent,
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

  it('gives up before exchange when primary Auth never becomes ready', async () => {
    armTransaction();
    const exchange = vi.fn();
    callables({ exchangeAuthHandoff: exchange });
    mocks.primaryAuth.authStateReady.mockImplementation(() => new Promise(() => {}));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(mocks.signInWithCustomToken).not.toHaveBeenCalled();
    expect(readHandoffTransaction(Date.now())).toBeNull();
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('gives up on a sign-in that never settles', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockImplementation(() => new Promise(() => {}));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('shares one pre-commit deadline across Auth readiness, exchange, and isolated sign-in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    armTransaction();
    mocks.primaryAuth.authStateReady.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 4)),
    );
    callables({
      exchangeAuthHandoff: () =>
        new Promise((resolve) => setTimeout(() => resolve({ data: { customToken: 'ct-1' } }), 4)),
    });
    mocks.signInWithCustomToken.mockImplementation(
      (targetAuth: unknown) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(firebaseSignInResult(targetAuth, { uid: 'u1' })), 4),
        ),
    );

    const completion = completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(12);

    expect(await completion).toBe(false);
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('rejects an isolated sign-in that settles at the deadline before its timer callback runs', async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockImplementation(async (targetAuth: unknown) => {
      elapsedMs = 10;
      return firebaseSignInResult(targetAuth, { uid: 'u1' });
    });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('rechecks the deadline at the shared-auth mutation after the fulfillment hop', async () => {
    let isolatedSignInSettled = false;
    let postSignInClockReads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      if (!isolatedSignInSettled) return 0;
      postSignInClockReads += 1;
      return postSignInClockReads === 1 ? 9 : 10;
    });
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.signInWithCustomToken.mockImplementation(async (targetAuth: unknown) => {
      isolatedSignInSettled = true;
      return firebaseSignInResult(targetAuth, { uid: 'u1' });
    });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
  });

  it('does not start the exchange after Auth readiness consumes the whole deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    armTransaction();
    mocks.primaryAuth.authStateReady.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    const exchange = vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } });
    callables({ exchangeAuthHandoff: exchange });

    const completion = completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    expect(await completion).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(mocks.signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('does not let isolated-app cleanup hold the app mount forever', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.deleteApp.mockImplementation(() => new Promise(() => {}));

    const completion = completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 100 });
    const result = await Promise.race([
      completion.then((value) => ({ kind: 'result' as const, value })),
      new Promise<{ kind: 'late' }>((resolve) => setTimeout(() => resolve({ kind: 'late' }), 30)),
    ]);

    expect(result).toEqual({ kind: 'result', value: true });
  });

  it('logs isolated-app cleanup failure with fixed text without changing success', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.deleteApp.mockRejectedValue(new Error('secret cleanup detail'));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    await Promise.resolve();

    expect(debug).toHaveBeenCalledWith('[auth-handoff] isolated Auth cleanup failed');
    expect(debug.mock.calls.flat().join(' ')).not.toContain('secret cleanup detail');
  });

  it('keeps authentication successful when fixed-text diagnostics throw', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('broken console');
    });
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    mocks.deleteApp.mockRejectedValue(new Error('cleanup failed'));

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    await Promise.resolve();
    expect(consumeHandoffFailure()).toBeNull();
  });

  it('leaves room for a slow phone on bad wifi rather than a snappy default', () => {
    expect(HANDOFF_EXCHANGE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// `bounded` REJECTS, it does not CANCEL. The Firebase SDK persists the Auth it
// receives before signInWithCustomToken resolves, so the only safe boundary for
// abandonable work is a secondary Auth whose persistence is memory-only. A
// timely credential is copied to the primary Auth; a late one never is.
describe('a timed-out sign-in cannot mutate auth state later', () => {
  function armTransaction() {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      acknowledgedAdultContent: false,
      createdAt: Date.now(),
    });
  }

  it('keeps an attempt that lands after the bound out of shared auth', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    const lateSignIn = deferredFirebaseSignIn();
    mocks.signInWithCustomToken.mockImplementation(lateSignIn.implementation);

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    expect(consumeHandoffFailure()).toEqual({ reason: 'sign-in-failed' });
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
    expect(mocks.persistedSession.user).toBeNull();
    expect(mocks.deleteApp).toHaveBeenCalledOnce();

    // …and now the abandoned operation completes.
    lateSignIn.land({ uid: 'u1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
    expect(mocks.persistedSession.user).toBeNull();
  });

  it('commits a sign-in that lands inside the bound to shared auth', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.updateCurrentUser).toHaveBeenCalledOnce();
    expect(mocks.persistedSession.user).toEqual({ uid: 'u1' });
  });
});

// #913. A module-local generation can serialize retries in one tab but each tab
// has its own module realm. Firebase persistence is origin-wide, so the proof
// must use separate module instances and assert the persisted session itself.
describe('late sign-in isolation is cross-tab safe', () => {
  function armTransaction(acknowledgedAdultContent = false) {
    rememberHandoffTransaction({
      verifier: 'V'.repeat(43),
      targetOrigin: ORIGIN,
      returnPath: '/board',
      acknowledgedAdultContent,
      createdAt: Date.now(),
    });
  }

  it('preserves a newer attempt in the same tab', async () => {
    armTransaction(true);
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });

    const lateSignIn = deferredFirebaseSignIn();
    mocks.signInWithCustomToken.mockImplementationOnce(lateSignIn.implementation);

    // Attempt 1 times out.
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    consumeHandoffFailure();

    // The player retries; attempt 2 succeeds.
    armTransaction();
    const newerUser = { uid: 'same-user', refreshToken: 'newer-refresh-token' };
    mocks.signInWithCustomToken.mockImplementationOnce(async (targetAuth: unknown) => {
      return firebaseSignInResult(targetAuth, newerUser);
    });
    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN })).toBe(true);
    expect(mocks.persistedSession.user).toBe(newerUser);

    // Only NOW does attempt 1's abandoned promise land.
    lateSignIn.land({ uid: 'same-user', refreshToken: 'older-refresh-token' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.persistedSession.user).toBe(newerUser);
    expect(mocks.updateCurrentUser).toHaveBeenCalledTimes(1);
    expect(mocks.rememberHandoffAttestation).not.toHaveBeenCalled();
  });

  it('leaves shared auth signed out when no newer attempt intervened', async () => {
    armTransaction();
    callables({ exchangeAuthHandoff: vi.fn().mockResolvedValue({ data: { customToken: 'ct-1' } }) });
    const lateSignIn = deferredFirebaseSignIn();
    mocks.signInWithCustomToken.mockImplementation(lateSignIn.implementation);

    expect(await completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);
    lateSignIn.land({ uid: 'u1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.persistedSession.user).toBeNull();
    expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
  });

  it('cannot overwrite a newer handoff session established in another tab', async () => {
    const exchange = vi
      .fn()
      .mockResolvedValueOnce({ data: { customToken: 'ct-old' } })
      .mockResolvedValueOnce({ data: { customToken: 'ct-new' } });
    callables({ exchangeAuthHandoff: exchange });

    // Each dynamic import after a module reset models a separate tab/module
    // realm. The mocked persistence remains shared across both.
    vi.resetModules();
    const oldTab = await import('./handoffExchange');
    armTransaction();
    const oldTabSignIn = deferredFirebaseSignIn();
    mocks.signInWithCustomToken.mockImplementationOnce(oldTabSignIn.implementation);

    expect(await oldTab.completeAuthHandoff({ code: CODE, origin: ORIGIN, timeoutMs: 10 })).toBe(false);

    vi.resetModules();
    const newerTab = await import('./handoffExchange');
    armTransaction();
    const newerUser = { uid: 'same-user', refreshToken: 'newer-refresh-token' };
    mocks.signInWithCustomToken.mockImplementationOnce(async (targetAuth: unknown) => {
      return firebaseSignInResult(targetAuth, newerUser);
    });
    expect(await newerTab.completeAuthHandoff({ code: 'N'.repeat(43), origin: ORIGIN })).toBe(true);
    expect(mocks.persistedSession.user).toBe(newerUser);

    // Only now does the abandoned operation in the old tab settle. It mutates
    // its isolated Auth exactly as Firebase does, but cannot touch the shared
    // Auth session the newer tab committed.
    oldTabSignIn.land({ uid: 'same-user', refreshToken: 'older-refresh-token' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.signInWithCustomToken).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ persistence: mocks.inMemoryPersistence }),
      'ct-old',
    );
    expect(mocks.signInWithCustomToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ persistence: mocks.inMemoryPersistence }),
      'ct-new',
    );
    expect(mocks.persistedSession.user).toBe(newerUser);
    expect(mocks.updateCurrentUser).toHaveBeenCalledTimes(1);
  });
});
