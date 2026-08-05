import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BUILD_STAMP_REPLY,
  BUILD_STAMP_REQUEST,
  DISMISSED_BUILD_KEY,
  dismissedBuild,
  isDismissedBuild,
  readWaitingBuildStamp,
  rememberDismissedBuild,
} from './updateDismissal';

// Covers specs/app-update-reload-prompt.md § "Not now" declines a BUILD (#605):
// the per-build suppression store and the query that gives a waiting worker an
// identity to key it on.
//
// WHAT THESE TESTS CANNOT PROVE (the #513/#517 lesson, stated rather than
// papered over): jsdom has no service-worker implementation, so the container,
// the registration, and the waiting worker below are all fakes, and a fake that
// answers a `postMessage` proves only that this module reads the reply
// correctly. It does NOT prove the browser delivers `GET_BUILD_STAMP` to a
// worker in the `waiting` state, nor that `src/sw.ts`'s listener is reached
// there. `src/sw-worker.test.ts` covers the worker's half against the real
// module's handlers, which is as close as a unit suite gets; the delivery
// itself is only ever proven in a browser.

type FakeWaiting = { postMessage: ReturnType<typeof vi.fn> };

/**
 * Stubs `navigator.serviceWorker` with a registration whose waiting worker
 * replies with `stamp` — or, when `stamp` is undefined, never replies at all
 * (the pre-#605 worker: it has no handler for this message).
 */
function stubWaitingWorker(stamp?: string, replyType: string = BUILD_STAMP_REPLY): FakeWaiting {
  const waiting: FakeWaiting = {
    postMessage: vi.fn((message: unknown, transfer: MessagePort[]) => {
      if (stamp === undefined) return;
      // Answer on the caller's port, exactly as the worker does.
      transfer[0].postMessage({ type: replyType, stamp });
    }),
  };
  vi.stubGlobal('navigator', {
    ...window.navigator,
    serviceWorker: { getRegistration: vi.fn(async () => ({ waiting })) },
  });
  return waiting;
}

/** Minimal in-memory localStorage stand-in — same stub + rationale as
 *  src/components/w1-pwa.test.tsx (the runtime's own global is not usable here). */
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorageStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readWaitingBuildStamp', () => {
  it('asks the waiting worker for its build stamp and returns it', async () => {
    const waiting = stubWaitingWorker('2026-08-05T12:00:00.000Z');
    await expect(readWaitingBuildStamp()).resolves.toBe('2026-08-05T12:00:00.000Z');
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: BUILD_STAMP_REQUEST }, [expect.anything()]);
  });

  it('resolves null when there is no waiting worker (nothing to identify)', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      serviceWorker: { getRegistration: vi.fn(async () => ({ waiting: null })) },
    });
    await expect(readWaitingBuildStamp()).resolves.toBeNull();
  });

  it('resolves null when service workers are unavailable at all', async () => {
    vi.stubGlobal('navigator', { ...window.navigator, serviceWorker: undefined });
    await expect(readWaitingBuildStamp()).resolves.toBeNull();
  });

  it('resolves null when the registration lookup throws', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      serviceWorker: {
        getRegistration: vi.fn(async () => {
          throw new Error('blocked');
        }),
      },
    });
    await expect(readWaitingBuildStamp()).resolves.toBeNull();
  });

  it('times out to null when the waiting worker never answers — the pre-#605 transition build', async () => {
    stubWaitingWorker(undefined);
    const pending = readWaitingBuildStamp(50);
    await expect(pending).resolves.toBeNull();
  });

  it('ignores a reply that is not the expected build-stamp answer', async () => {
    stubWaitingWorker('2026-08-05T12:00:00.000Z', 'SOMETHING_ELSE');
    await expect(readWaitingBuildStamp(50)).resolves.toBeNull();
  });
});

describe('the per-build suppression store', () => {
  it('suppresses the declined build and nothing else', () => {
    rememberDismissedBuild('2026-08-01T00:00:00.000Z');
    expect(dismissedBuild()).toBe('2026-08-01T00:00:00.000Z');
    expect(isDismissedBuild('2026-08-01T00:00:00.000Z')).toBe(true);
    // A genuinely newer build is a different stamp, so it still prompts.
    expect(isDismissedBuild('2026-08-02T00:00:00.000Z')).toBe(false);
  });

  it('keeps only the most recent decline — one slot, overwritten', () => {
    rememberDismissedBuild('2026-08-01T00:00:00.000Z');
    rememberDismissedBuild('2026-08-02T00:00:00.000Z');
    expect(isDismissedBuild('2026-08-01T00:00:00.000Z')).toBe(false);
    expect(isDismissedBuild('2026-08-02T00:00:00.000Z')).toBe(true);
    expect(localStorage.length).toBe(1);
  });

  it('records nothing for an unidentifiable build, so it can never suppress indefinitely', () => {
    rememberDismissedBuild(null);
    expect(dismissedBuild()).toBeNull();
    expect(isDismissedBuild(null)).toBe(false);
    expect(localStorage.getItem(DISMISSED_BUILD_KEY)).toBeNull();
  });

  it('fails open — and never throws — when storage refuses', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => rememberDismissedBuild('2026-08-01T00:00:00.000Z')).not.toThrow();
    expect(dismissedBuild()).toBeNull();
    expect(isDismissedBuild('2026-08-01T00:00:00.000Z')).toBe(false);
  });
});
