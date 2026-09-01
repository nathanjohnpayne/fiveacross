import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandoffPageAuthObserver } from './handoffPageAuthObserver';

afterEach(() => {
  vi.useRealTimers();
});

describe('handoff page Auth observer', () => {
  it('waits for the exact refresh-token digest, not merely the same uid', async () => {
    const observer: {
      current: ((user: { uid: string; refreshToken: string } | null) => void) | null;
    } = { current: null };
    const unsubscribe = vi.fn();
    const auth = {
      currentUser: null as { uid: string; refreshToken: string } | null,
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };
    const pageAuth = createHandoffPageAuthObserver(
      async () => ({
        auth,
        subscribe: (_auth, next) => {
          observer.current = next;
          return unsubscribe;
        },
      }),
      async ({ refreshToken }) =>
        refreshToken === 'exact-token' ? 'exact-digest' : 'different-digest',
    );
    const signal = new AbortController().signal;
    await pageAuth.ready(signal);
    const exact = pageAuth.observeExact(
      { uid: 'same-user', refreshTokenDigest: 'exact-digest' },
      'owner',
      signal,
    );

    auth.currentUser = { uid: 'same-user', refreshToken: 'older-token' };
    observer.current?.(auth.currentUser);
    await Promise.resolve();
    let settled = false;
    void exact.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    auth.currentUser = { uid: 'same-user', refreshToken: 'exact-token' };
    observer.current?.(auth.currentUser);
    await expect(exact).resolves.toEqual(auth.currentUser);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('polls currentUser so a same-uid token replacement cannot hide behind a silent listener', async () => {
    vi.useFakeTimers();
    const auth = {
      currentUser: { uid: 'same-user', refreshToken: 'older-token' },
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };
    const pageAuth = createHandoffPageAuthObserver(
      async () => ({ auth, subscribe: () => () => {} }),
      async ({ refreshToken }) =>
        refreshToken === 'exact-token' ? 'exact-digest' : 'different-digest',
    );
    const signal = new AbortController().signal;
    await pageAuth.ready(signal);
    const exact = pageAuth.observeExact(
      { uid: 'same-user', refreshTokenDigest: 'exact-digest' },
      'owner',
      signal,
    );

    auth.currentUser = { uid: 'same-user', refreshToken: 'exact-token' };
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(exact).resolves.toEqual(auth.currentUser);
  });

  it('unsubscribes when the cumulative deadline aborts', async () => {
    const unsubscribe = vi.fn();
    const auth = { currentUser: null, authStateReady: vi.fn().mockResolvedValue(undefined) };
    const pageAuth = createHandoffPageAuthObserver(
      async () => ({
        auth,
        subscribe: () => unsubscribe,
      }),
      async () => 'different-digest',
    );
    const controller = new AbortController();
    await pageAuth.ready(controller.signal);
    const exact = pageAuth.observeExact(
      { uid: 'user', refreshTokenDigest: 'never' },
      'owner',
      controller.signal,
    );

    controller.abort();
    await expect(exact).rejects.toThrow('handoff-timeout');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('accepts an already-current exact credential without waiting for an event', async () => {
    const user = { uid: 'same-user', refreshToken: 'exact-token' };
    const unsubscribe = vi.fn();
    const auth = { currentUser: user, authStateReady: vi.fn().mockResolvedValue(undefined) };
    const pageAuth = createHandoffPageAuthObserver(
      async () => ({ auth, subscribe: () => unsubscribe }),
      async () => 'exact-digest',
    );
    const signal = new AbortController().signal;

    await pageAuth.ready(signal);
    await expect(
      pageAuth.observeExact(
        { uid: user.uid, refreshTokenDigest: 'exact-digest' },
        'owner',
        signal,
      ),
    ).resolves.toBe(user);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('retries an exact token that went stale during asynchronous hashing', async () => {
    const observer: {
      current: ((user: { uid: string; refreshToken: string } | null) => void) | null;
    } = { current: null };
    let resolveFirst = (_digest: string) => {};
    const fingerprint = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue('exact-digest');
    const exactUser = { uid: 'same-user', refreshToken: 'exact-token' };
    const auth = {
      currentUser: exactUser as { uid: string; refreshToken: string } | null,
      authStateReady: vi.fn().mockResolvedValue(undefined),
    };
    const pageAuth = createHandoffPageAuthObserver(
      async () => ({
        auth,
        subscribe: (_auth, next) => {
          observer.current = next;
          return () => {};
        },
      }),
      fingerprint,
    );
    const signal = new AbortController().signal;
    await pageAuth.ready(signal);
    const exact = pageAuth.observeExact(
      { uid: exactUser.uid, refreshTokenDigest: 'exact-digest' },
      'owner',
      signal,
    );

    auth.currentUser = { uid: 'different-user', refreshToken: 'other-token' };
    resolveFirst('exact-digest');
    await Promise.resolve();
    await Promise.resolve();
    auth.currentUser = exactUser;
    observer.current?.(exactUser);
    await Promise.resolve();

    expect(fingerprint).toHaveBeenCalledTimes(2);
    await expect(exact).resolves.toBe(exactUser);
  });

  it('cleans up when listener installation throws synchronously', async () => {
    const auth = { currentUser: null, authStateReady: vi.fn().mockResolvedValue(undefined) };
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pageAuth = createHandoffPageAuthObserver(async () => ({
      auth,
      subscribe: () => {
        throw new Error('listener unavailable');
      },
    }));
    await pageAuth.ready(controller.signal);

    expect(() =>
      pageAuth.observeExact(
        { uid: 'user', refreshTokenDigest: 'digest' },
        'owner',
        controller.signal,
      ),
    ).toThrow('handoff-page-auth-observer-failed');
    expect(remove).toHaveBeenCalled();
  });
});
