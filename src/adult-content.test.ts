import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ADULT_CONTENT_DEFAULT,
  adultContentRequired,
  coerceAdultContent,
  setActiveAdultContent,
} from './adultContent';
import { readCache, resolveEvent, writeCache, type StorageLike } from './eventResolution';
import type { HostnameDoc } from './types';

// Covers the dynamic 18+ posture's RESOLUTION half (#608): the coercion, the
// fail direction, and the fact that both the network and cache paths agree about
// the same bytes. The GATE half — what the app renders once a posture is
// installed — is `components/adult-content-gate.test.tsx`.

afterEach(() => setActiveAdultContent(true));

const HOST = 'bodega-bay.fiveacross.app';
const DOC: HostnameDoc = {
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'fiveacross',
  status: 'active',
  adultContent: false,
  slug: 'bodega-bay',
};

function fakeStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('the fail direction is CLOSED', () => {
  // Under-gating is the harmful direction; over-gating costs one checkbox. This
  // is also what makes every hostname document written before #608 correct with
  // no backfill: they have no field, so they read as gated.
  it('reads anything that is not a literal false as adult content', () => {
    for (const value of [undefined, null, 'false', 0, '', {}, [], NaN, true]) {
      expect(coerceAdultContent(value), String(value)).toBe(true);
    }
    expect(coerceAdultContent(false)).toBe(false);
    expect(ADULT_CONTENT_DEFAULT).toBe(true);
  });

  it('answers gated before anything has resolved', () => {
    // A gate rendered before resolution — or in a build that never resolves —
    // must be the over-gating one.
    expect(adultContentRequired()).toBe(true);
  });

  it('refuses to widen the fail direction through the setter', () => {
    setActiveAdultContent(undefined);
    expect(adultContentRequired()).toBe(true);
    setActiveAdultContent(null);
    expect(adultContentRequired()).toBe(true);
    setActiveAdultContent(false);
    expect(adultContentRequired()).toBe(false);
  });
});

describe('the network and cache paths agree about the same bytes', () => {
  it('round-trips a non-adult mapping through the cache', () => {
    const storage = fakeStorage();
    writeCache(storage, HOST, DOC, 1000);
    expect(readCache(storage, HOST, 1000)?.doc.adultContent).toBe(false);
  });

  // The reason CACHE_VERSION is deliberately NOT bumped for this field: a bump
  // evicts every stored mapping, and the entries it would evict are exactly the
  // ones an offline cold boot depends on. Coercion gets the same answer without
  // trading a correct default for a not-found screen.
  it('reads a pre-#608 cache entry as gated rather than as a miss', () => {
    const legacy = { v: 1, fetchedAt: 1000, doc: { ...DOC, adultContent: undefined } };
    const storage = fakeStorage({ [`fa:hostname:${HOST}`]: JSON.stringify(legacy) });
    const read = readCache(storage, HOST, 1000);
    expect(read, 'a legacy entry must still be a HIT').not.toBeNull();
    expect(read?.doc.adultContent).toBe(true);
  });

  it('carries the posture onto the resolution from the network', async () => {
    const resolution = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => DOC,
      storage: fakeStorage(),
      now: () => 1000,
    });
    expect(resolution.kind).toBe('event');
    if (resolution.kind !== 'event') return;
    expect(resolution.adultContent).toBe(false);
  });

  // Codex P1 on #615. `adultContent` is the one cached field that moves in only
  // one direction, and it is the direction that matters: a fresh cache hit
  // holding `false` would short-circuit for the whole 12-hour TTL, so a device
  // could keep booting past a gate the Event acquired hours ago and the
  // mid-Event re-gate path would simply never fire there.
  it('revalidates a cached NON-adult posture instead of short-circuiting on it', async () => {
    const storage = fakeStorage();
    writeCache(storage, HOST, DOC, 1000); // adultContent: false, and FRESH
    const fetchDoc = vi.fn(async () => ({ ...DOC, adultContent: true }));
    const resolution = await resolveEvent({ hostname: HOST, fetchDoc, storage, now: () => 2000 });
    expect(fetchDoc, 'a cached false must not answer on its own').toHaveBeenCalledTimes(1);
    expect(resolution.kind).toBe('event');
    if (resolution.kind !== 'event') return;
    expect(resolution.adultContent).toBe(true);
    expect(resolution.source).toBe('network');
  });

  it('still short-circuits on a cached GATED posture — the offline-first path is untouched', async () => {
    const storage = fakeStorage();
    writeCache(storage, HOST, { ...DOC, adultContent: true }, 1000);
    const fetchDoc = vi.fn(async () => {
      throw new Error('a fresh gated cache must never touch the network');
    });
    const resolution = await resolveEvent({ hostname: HOST, fetchDoc, storage, now: () => 2000 });
    expect(fetchDoc).not.toHaveBeenCalled();
    expect(resolution.kind === 'event' && resolution.source).toBe('cache');
  });

  // …and revalidation FAILING must not strand the device or gate it. An offline
  // client cannot learn about a flip by any means, and forcing the gate on would
  // ask a Player of a tame Event for an attestation they were never offered —
  // holding them on the loading screen instead of their cached board. The
  // exposure this closes is the online device that would never ask.
  it('falls back to the cached non-adult mapping when revalidation fails', async () => {
    const storage = fakeStorage();
    writeCache(storage, HOST, DOC, 1000);
    const fetchDoc = vi.fn(async () => {
      throw new Error('offline');
    });
    const resolution = await resolveEvent({ hostname: HOST, fetchDoc, storage, now: () => 2000 });
    expect(resolution.kind).toBe('event');
    if (resolution.kind !== 'event') return;
    expect(resolution.adultContent).toBe(false);
    expect(resolution.source).toBe('cache');
  });

  // Codex P2 on #615. A single-Event build never reads a hostname document, so
  // without a build-time input it could never be anything but adults-only —
  // there is nowhere for the server derivation to publish `false`.
  it('lets a single-Event build opt out with VITE_ADULT_CONTENT=false', async () => {
    const resolve = (envAdultContent: string | null) =>
      resolveEvent({
        hostname: HOST,
        fetchDoc: async () => {
          throw new Error('the env short-circuit must never touch the network');
        },
        envEventId: 'bodega-bay-2026',
        envAdultContent,
      });
    const off = await resolve('false');
    expect(off.kind === 'event' && off.adultContent).toBe(false);
    // Only the literal string. A typo, a blank, an unset var — all still gate.
    for (const bad of ['False', 'FALSE', '0', 'no', '', null]) {
      const on = await resolve(bad);
      expect(on.kind === 'event' && on.adultContent, JSON.stringify(bad)).toBe(true);
    }
  });

  // The env short-circuit reads no hostname document at all, so unlike `edition`
  // — which defers to whatever `VITE_EDITION` already seeded — there is nothing
  // to defer to. It reports the fail-closed default, which reproduces the legacy
  // Gay Cruise Bingo build's gate exactly.
  it('reports the gated default on the single-Event short-circuit', async () => {
    const resolution = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => {
        throw new Error('the env short-circuit must never touch the network');
      },
      envEventId: 'med-2026',
    });
    expect(resolution.kind).toBe('event');
    if (resolution.kind !== 'event') return;
    expect(resolution.adultContent).toBe(true);
    expect(resolution.edition).toBeNull();
  });
});
