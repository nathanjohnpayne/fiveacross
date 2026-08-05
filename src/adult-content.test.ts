import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ADULT_CONTENT_DEFAULT,
  adultContentRequired,
  adultContentSettledAdult,
  coerceAdultContent,
  resetAdultContentForTests,
  setActiveAdultContent,
} from './adultContent';
import { readCache, resolveEvent, writeCache, type StorageLike } from './eventResolution';
import { isExplicitWithheld } from './data/moderation';
import type { HostnameDoc } from './types';

// Covers the dynamic 18+ posture's RESOLUTION half (#608): the coercion, the
// fail direction, and the fact that both the network and cache paths agree about
// the same bytes. The GATE half — what the app renders once a posture is
// installed — is `components/adult-content-gate.test.tsx`.

afterEach(() => resetAdultContentForTests());

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

  // …and a FAILED revalidation resolves to GATED (Phase 4b P1). The first cut of
  // this rule fell back to the cached `false` on the grounds that an offline
  // device cannot learn about a flip anyway — but that answers the wrong
  // question. Failure does not mean "still false", it means UNKNOWN, and the one
  // direction this monotone field could have moved in is the one that matters.
  it('gates when revalidation of a cached non-adult posture FAILS', async () => {
    const storage = fakeStorage();
    writeCache(storage, HOST, DOC, 1000);
    const fetchDoc = vi.fn(async () => {
      throw new Error('offline');
    });
    const resolution = await resolveEvent({ hostname: HOST, fetchDoc, storage, now: () => 2000 });
    expect(resolution.kind).toBe('event');
    if (resolution.kind !== 'event') return;
    // The EVENT still resolves — routing is durable, so the player is not
    // stranded on a not-found screen — but its posture is the safe one.
    expect(resolution.eventId).toBe(DOC.eventId);
    expect(resolution.adultContent).toBe(true);
    // …and UNPROVEN, so this is a gate until we can ask, not a gate forever:
    // the first successful revalidation lowers it again.
    expect(resolution.adultContentProven).toBe(false);
  });

  it('does not latch the session on that provisional gate', async () => {
    // The distinction the `proven` flag exists for. A gate we assumed must stay
    // lowerable; a gate a live read established must not.
    setActiveAdultContent(true, { proven: false });
    expect(adultContentSettledAdult()).toBe(false);
    setActiveAdultContent(false, { proven: true });
    expect(adultContentRequired()).toBe(false);
  });

  it('LATCHES once a live read has said adult, and never lowers again', async () => {
    setActiveAdultContent(true, { proven: true });
    expect(adultContentSettledAdult()).toBe(true);
    // Every route back down is refused: a stale edge read, a malformed answer,
    // a lost race between two in-flight polls.
    setActiveAdultContent(false, { proven: true });
    setActiveAdultContent(false, { proven: false });
    expect(adultContentRequired()).toBe(true);
  });

  // Phase 4b P1. The baked opt-out is a SEED, not an answer: it paints the first
  // frame and then has to be confirmed like any other ungated claim. Marking it
  // unproven is what makes `revalidateAdultContent` able to override it — and
  // what stops it latching the session against a later `true`.
  it('marks a single-Event build\u2019s baked opt-out UNPROVEN', async () => {
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => {
        throw new Error('the env short-circuit must never touch the network');
      },
      envEventId: 'bodega-bay-2026',
      envAdultContent: 'false',
    });
    expect(r.kind === 'event' && r.adultContent).toBe(false);
    expect(r.kind === 'event' && r.adultContentProven).toBe(false);
  });

  // Codex P2 on #615. A single-Event build never reads a hostname document for
  // ROUTING, so without a build-time input it could never be anything but
  // adults-only — there is nowhere for the server derivation to publish `false`.
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

// THE PUBLISH RACE (Phase 4b round 4).
//
// An admin approving the first explicit Prompt performs ONE write —
// `status: 'active'` — and the 18+ posture is published by a Cloud Function
// reacting to it. Two writes with an invocation between them, so for a moment
// the Prompt is live and the posture is not: every Player's `status == 'active'`
// listener delivers the explicit text while `hostnames/{host}.adultContent`
// still says `false`. No amount of listener promptness closes that — it is an
// ordering problem, not a latency one — and the client cannot make the two
// writes atomic, because no client may write `hostnames` at all.
//
// So the invariant is enforced where it has to hold: an explicit Prompt is not
// rendered or dealt into a session that has not raised the gate.
describe('explicit content is withheld from an ungated session', () => {
  it('withholds a spicy Prompt while the posture is ungated', () => {
    expect(isExplicitWithheld(true, false)).toBe(true);
  });

  it('shows it the moment the gate goes up', () => {
    // The window resolves itself: the stamp lands, the posture raises, the gate
    // appears and the Prompt becomes visible in the same motion.
    expect(isExplicitWithheld(true, true)).toBe(false);
  });

  it('never withholds a tame Prompt, on either posture', () => {
    for (const adult of [true, false]) {
      expect(isExplicitWithheld(false, adult), String(adult)).toBe(false);
      expect(isExplicitWithheld(undefined, adult), String(adult)).toBe(false);
    }
  });

  // `spicy` is coerced to a strict boolean everywhere else in the deal path
  // (CodeRabbit, PR #135) because a legacy doc may omit it or carry a truthy
  // non-boolean. Withholding on a truthy non-boolean would hide tame Prompts
  // from every ungated Event, so this predicate matches that discipline.
  it('treats a malformed spicy value as tame, matching the deal path', () => {
    expect(isExplicitWithheld('true' as unknown as boolean, false)).toBe(false);
    expect(isExplicitWithheld(1 as unknown as boolean, false)).toBe(false);
  });

  it('costs nothing in the steady state', () => {
    // A gated Event withholds nothing; a genuinely tame Event has nothing spicy
    // to withhold. The predicate only ever bites inside the race window.
    expect(isExplicitWithheld(true, true)).toBe(false);
    expect(isExplicitWithheld(false, false)).toBe(false);
  });
});
