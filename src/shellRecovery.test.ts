import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearShell,
  enforceBuildFloor,
  markResetAttempted,
  resetAttempted,
  resetShell,
} from './shellRecovery';
import { PROOF_MEDIA_CACHE_NAME } from './data/proofMediaCache';

// Regression pins for the 2026-07-24 blank-screen incident (src/shellRecovery.ts):
// a pre-cells-map precached shell crashed the whole React root, which killed
// `UpdatePrompt` — the only caller of `updateServiceWorker(true)` — so the
// waiting worker never activated and the broken shell served itself forever.
// The invariant these tests hold: recovery works WITHOUT the app rendering, and
// can never turn into a reload loop.

const unregister = vi.fn();

function installBrowserMocks({
  cacheKeys = [],
  registrations = 1,
  onLine = true,
}: { cacheKeys?: string[]; registrations?: number; onLine?: boolean } = {}) {
  const deleted: string[] = [];
  unregister.mockReset().mockResolvedValue(true);
  vi.stubGlobal('navigator', {
    onLine,
    serviceWorker: {
      getRegistrations: vi.fn().mockResolvedValue(Array.from({ length: registrations }, () => ({ unregister }))),
    },
  });
  vi.stubGlobal('caches', {
    keys: vi.fn().mockResolvedValue(cacheKeys),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
      return true;
    }),
  });
  return { deleted };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('clearShell', () => {
  it('unregisters every service worker', async () => {
    installBrowserMocks({ registrations: 2 });
    await clearShell();
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it('deletes the workbox precache but PRESERVES the proof-media runtime cache', async () => {
    // The precache is the broken shell; proof media is the player's photos —
    // immutable Storage objects that are expensive to refetch mid-cruise and
    // have nothing to do with the shell being stale.
    const { deleted } = installBrowserMocks({
      cacheKeys: ['workbox-precache-v2-https://gaycruisebingo.com/', PROOF_MEDIA_CACHE_NAME],
    });
    await clearShell();
    expect(deleted).toEqual(['workbox-precache-v2-https://gaycruisebingo.com/']);
    expect(deleted).not.toContain(PROOF_MEDIA_CACHE_NAME);
  });

  it('never throws when the SW and CacheStorage APIs are absent or blocked', async () => {
    // Privacy modes and SSR: a recovery path that can itself throw is not one.
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockRejectedValue(new Error('blocked')),
      },
    });
    vi.stubGlobal('caches', { keys: vi.fn().mockRejectedValue(new Error('blocked')) });
    await expect(clearShell()).resolves.toBeUndefined();
  });
});

describe('resetShell', () => {
  it('clears the shell and THEN reloads', async () => {
    const order: string[] = [];
    installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    unregister.mockImplementation(async () => {
      order.push('unregister');
      return true;
    });
    await resetShell(() => order.push('reload'));
    expect(order).toEqual(['unregister', 'reload']);
  });

  it('reloads WITHOUT tearing down the shell while offline', async () => {
    // Codex P1 on #513. The precache is the only copy of index.html and the
    // bundle a disconnected device has; deleting it mid-cruise replaces the
    // recovery panel with the browser's offline error page and the installed
    // PWA cannot reopen until connectivity returns.
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'], onLine: false });
    const reload = vi.fn();
    await resetShell(reload);
    expect(unregister).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    expect(reload).toHaveBeenCalledOnce(); // the retry path stays alive
  });
});

describe('the one-attempt guard', () => {
  it('starts unspent and latches once marked', () => {
    expect(resetAttempted()).toBe(false);
    expect(markResetAttempted()).toBe(true);
    expect(resetAttempted()).toBe(true);
  });

  it('reports the attempt as SPENT when sessionStorage is unreadable', () => {
    // Fails closed: forgo an automatic recovery we cannot count rather than
    // risk an unbounded reload loop. The manual button still works.
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(resetAttempted()).toBe(true);
  });

  it('reports FAILURE when the write throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(markResetAttempted()).toBe(false);
  });

  it('reports FAILURE when the store silently drops the write', () => {
    // Codex P1 on #513: the dangerous case is readable-but-unwritable, where
    // setItem resolves but nothing persists. Without the read-back this looked
    // like a spent attempt, so every load re-armed the reset — an unbounded
    // destructive reload loop, the exact failure this guard exists to prevent.
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
    expect(markResetAttempted()).toBe(false);
  });
});

describe('enforceBuildFloor', () => {
  const FLOOR = '2026-07-24T00:00:00.000Z';

  function stubFloorFetch(floor: string | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ floor }) } as unknown as Response),
    );
  }

  it('resets a build BELOW the floor — the stranded-client rescue', async () => {
    installBrowserMocks();
    stubFloorFetch(FLOOR);
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('leaves a build AT OR ABOVE the floor alone', async () => {
    installBrowserMocks();
    stubFloorFetch(FLOOR);
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-28T01:22:17.835Z', reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when the floor is inert (the shipped default)', async () => {
    installBrowserMocks();
    stubFloorFetch('1970-01-01T00:00:00.000Z');
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('fires at most ONCE per tab, so a misconfigured floor cannot reload-loop', async () => {
    installBrowserMocks();
    stubFloorFetch(FLOOR);
    const reload = vi.fn();
    await enforceBuildFloor('2026-07-20T14:17:04.539Z', reload);
    await enforceBuildFloor('2026-07-20T14:17:04.539Z', reload);
    await enforceBuildFloor('2026-07-20T14:17:04.539Z', reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload when the floor cannot be read (offline mid-cruise)', async () => {
    installBrowserMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not even probe the floor while definitely offline', async () => {
    const fetchSpy = vi.fn();
    installBrowserMocks({ onLine: false });
    vi.stubGlobal('fetch', fetchSpy);
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('declines to reset when the attempt cannot be durably recorded', async () => {
    // Codex P1 on #513: resetting without a countable attempt is the reload
    // loop. The floor stays armed, so the rescue is deferred, not cancelled.
    installBrowserMocks();
    stubFloorFetch(FLOOR);
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
