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
  // Default: the origin answers with a real build-floor document, so the
  // destructive teardown is licensed. Tests override to model interception.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okFloorResponse()));
  return { deleted };
}

/** A response that clears all three `originReachable` barriers. */
function okFloorResponse(
  over: Partial<{ ok: boolean; redirected: boolean; url: string; json: () => Promise<unknown> }> = {},
) {
  return {
    ok: true,
    redirected: false,
    url: 'http://localhost:3000/build-floor.json',
    json: async () => ({ floor: '1970-01-01T00:00:00.000Z' }),
    ...over,
  } as unknown as Response;
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

  it('never throws when reload() itself throws', async () => {
    // CodeRabbit on #513: every caller uses `void resetShell()`, so an escaping
    // throw is an unhandled rejection rather than a contained no-op.
    installBrowserMocks();
    await expect(
      resetShell(() => {
        throw new Error('navigation blocked');
      }),
    ).resolves.toBeUndefined();
  });

  it('does NOT tear down when the origin is unreachable despite navigator.onLine === true', async () => {
    // Phase 4b P1 on #513 — the ship Wi-Fi / captive-portal case, which is this
    // app's primary surface. `onLine` stays true while the origin is not
    // reachable, so the weaker `!definitelyOffline()` gate would have deleted
    // the only shell and reloaded into an error page: the exact stranding this
    // module exists to prevent, re-created by the fix for it.
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'], onLine: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('captive portal')));
    const reload = vi.fn();
    await resetShell(reload);
    expect(unregister).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does NOT tear down when the origin answers non-OK', async () => {
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okFloorResponse({ ok: false })));
    await resetShell(vi.fn());
    expect(deleted).toEqual([]);
  });

  // Phase 4b P1 on #513: `fetch` follows redirects by default, so a captive
  // portal returning a readable 2xx login page satisfies a bare `res.ok` — and
  // would license the teardown in the exact state the probe exists to refuse.
  // A portal only has to defeat ONE barrier, so all three are pinned.
  it('does NOT tear down when the probe was REDIRECTED (captive portal bounce)', async () => {
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okFloorResponse({ redirected: true })));
    await resetShell(vi.fn());
    expect(deleted).toEqual([]);
  });

  it('does NOT tear down when the final URL is CROSS-ORIGIN (in-place interception)', async () => {
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okFloorResponse({ url: 'http://portal.ship/login' })));
    await resetShell(vi.fn());
    expect(deleted).toEqual([]);
  });

  it('does NOT tear down when the body is not a build-floor document', async () => {
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okFloorResponse({
          json: async () => {
            throw new Error('<html>portal login</html>');
          },
        }),
      ),
    );
    await resetShell(vi.fn());
    expect(deleted).toEqual([]);
  });

  it('requests the probe with redirect:error so a bounce rejects outright', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okFloorResponse());
    installBrowserMocks();
    vi.stubGlobal('fetch', fetchSpy);
    await resetShell(vi.fn());
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/build-floor.json'),
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });

  it('tears down when a caller has already PROVEN connectivity, without re-probing', async () => {
    const fetchSpy = vi.fn();
    const { deleted } = installBrowserMocks({ cacheKeys: ['workbox-precache-v2-x'] });
    vi.stubGlobal('fetch', fetchSpy);
    await resetShell(vi.fn(), true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deleted).toEqual(['workbox-precache-v2-x']);
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

  it('skips the probe entirely when definitely offline', async () => {
    const fetchSpy = vi.fn();
    installBrowserMocks({ onLine: false });
    vi.stubGlobal('fetch', fetchSpy);
    await resetShell(vi.fn());
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it('re-checks the attempt across the floor fetch — no double teardown per load', async () => {
    // CodeRabbit on #513: this starts at module scope, so a render crash can
    // spend the attempt from the ErrorBoundary while the fetch is in flight.
    installBrowserMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        markResetAttempted(); // the boundary got there first, mid-flight
        return { ok: true, json: async () => ({ floor: FLOOR }) } as unknown as Response;
      }),
    );
    const reload = vi.fn();
    await expect(enforceBuildFloor('2026-07-20T14:17:04.539Z', reload)).resolves.toBe(false);
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
