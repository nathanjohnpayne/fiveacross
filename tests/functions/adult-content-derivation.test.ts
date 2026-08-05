import { describe, it, expect, vi } from 'vitest';
import {
  applyEventAdultContent,
  applyItemAdultContent,
  eventForcesAdultContent,
  isDealablePool,
  itemImpliesAdultContent,
  raiseAdultContentForEvent,
  type AdultFirestore,
} from '../../functions/src/adultContent';

// Covers the server-side derivation of an Event's 18+ posture (#608).
//
//     adultContent = settings.forceAdult || (any ACTIVE spicy Prompt in a dealable pool)
//
// Every dependency is injected, so the whole decision table runs without a
// Functions runtime, a Firestore, or an emulator — the discipline `autohide.ts`
// established next door.

describe('the predicate: which Prompt makes an Event 18+', () => {
  it('counts an active, spicy, main-pool Prompt', () => {
    expect(itemImpliesAdultContent({ status: 'active', spicy: true, pool: 'main' })).toBe(true);
  });

  // The flip point is the ADMIN's approve, not the player's checkbox: a player
  // submission lands `pending` (#210), and a pending Prompt cannot be dealt, so
  // it cannot make the Event adults-only either.
  it('ignores a pending submission — that is a request, not a flip', () => {
    expect(itemImpliesAdultContent({ status: 'pending', spicy: true, pool: 'main' })).toBe(false);
  });

  it('ignores hidden, rejected, tame and deleted rows', () => {
    expect(itemImpliesAdultContent({ status: 'hidden', spicy: true, pool: 'main' })).toBe(false);
    expect(itemImpliesAdultContent({ status: 'rejected', spicy: true, pool: 'main' })).toBe(false);
    expect(itemImpliesAdultContent({ status: 'active', spicy: false, pool: 'main' })).toBe(false);
    expect(itemImpliesAdultContent(undefined)).toBe(false);
  });

  // Tutorial pools cannot hold explicit Prompts by construction — `adminAddItem`
  // forces `safeSpicy = pool === 'main' ? spicy : false`, and the admin pool
  // editor gates its 🔞 control the same way — so a spicy embark row is a data
  // anomaly, not a reason to gate an Event.
  it('scopes to the dealable main pool', () => {
    expect(isDealablePool('main')).toBe(true);
    expect(isDealablePool('embark')).toBe(false);
    expect(isDealablePool('farewell')).toBe(false);
    expect(itemImpliesAdultContent({ status: 'active', spicy: true, pool: 'embark' })).toBe(false);
  });

  // `ItemDoc.pool` arrived with the Phase 1.5 pools (#207); items seeded before
  // it have no field, and every one of them is a main-game Prompt. Reading
  // `undefined` as "not main" would leave exactly the OLDEST explicit content
  // un-gated, which is the wrong direction.
  it('treats a legacy Prompt with no pool as main', () => {
    expect(isDealablePool(undefined)).toBe(true);
    expect(itemImpliesAdultContent({ status: 'active', spicy: true })).toBe(true);
  });
});

describe('the override: settings.forceAdult', () => {
  // `spicy` tracks SEXUAL explicitness specifically — the seeded pool tags
  // `Suite orgy` spicy and `Domestic violence` not — so an Event whose only
  // mature content is non-sexual would derive `false` and show no gate at all.
  it('gates an Event whose mature content the 🔞 tag cannot see', () => {
    expect(eventForcesAdultContent({ settings: { forceAdult: true } })).toBe(true);
  });

  it('is strict about the boolean — a truthy string does not gate', () => {
    expect(eventForcesAdultContent({ settings: { forceAdult: 'true' } })).toBe(false);
    expect(eventForcesAdultContent({ settings: { forceAdult: 1 } })).toBe(false);
    expect(eventForcesAdultContent({ settings: {} })).toBe(false);
    expect(eventForcesAdultContent({})).toBe(false);
    expect(eventForcesAdultContent(undefined)).toBe(false);
  });
});

// A minimal admin-SDK double: the `hostnames` query plus per-doc updates.
function fakeDb(hosts: Record<string, { eventId: string; adultContent?: boolean }>) {
  const updates: Record<string, Record<string, unknown>> = {};
  const db: AdultFirestore = {
    doc: (path: string) => ({
      update: async (data: Record<string, unknown>) => {
        updates[path] = { ...(updates[path] ?? {}), ...data };
        return undefined;
      },
    }),
    collection: () => ({
      where: (_f: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: Object.entries(hosts)
            .filter(([, d]) => d.eventId === value)
            .map(([id, d]) => ({ id, data: () => d as Record<string, unknown> })),
        }),
      }),
    }),
  };
  return { db, updates };
}

describe('the stamp: every routing document for the Event', () => {
  // An Event's canonical address and each of its aliases are SEPARATE
  // `hostnames/{host}` records (ADR 0009). A Player arriving on an un-stamped
  // alias would get the un-gated shell, so the stamp is per-document.
  it('stamps the canonical host and every alias', async () => {
    const { db, updates } = fakeDb({
      'bodega-bay.fiveacross.app': { eventId: 'e1' },
      'bodega.example.com': { eventId: 'e1' },
      'someone-elses.example.com': { eventId: 'e2' },
    });
    expect(await raiseAdultContentForEvent(db, 'e1')).toBe(2);
    expect(updates['hostnames/bodega-bay.fiveacross.app']).toEqual({ adultContent: true });
    expect(updates['hostnames/bodega.example.com']).toEqual({ adultContent: true });
    expect(updates['hostnames/someone-elses.example.com']).toBeUndefined();
  });

  it('skips documents already stamped — the steady state costs no writes', async () => {
    const { db, updates } = fakeDb({
      'a.example.com': { eventId: 'e1', adultContent: true },
      'b.example.com': { eventId: 'e1' },
    });
    expect(await raiseAdultContentForEvent(db, 'e1')).toBe(1);
    expect(updates['hostnames/a.example.com']).toBeUndefined();
    expect(updates['hostnames/b.example.com']).toEqual({ adultContent: true });
  });

  // Every alias is still attempted — one bad document must not abandon the rest —
  // but the failure is then RETHROWN so Cloud Functions retries. Acknowledging the
  // trigger would leave that alias serving the un-gated shell with no second
  // attempt (Codex P2 on #615). Retrying is safe: the stamp is idempotent.
  it('finishes the remaining aliases when one write fails, then throws for retry', async () => {
    const { db } = fakeDb({ 'a.example.com': { eventId: 'e1' }, 'b.example.com': { eventId: 'e1' } });
    const stamped: Record<string, Record<string, unknown>> = {};
    const failing: AdultFirestore = {
      ...db,
      doc: (path: string) => ({
        update: async (data: Record<string, unknown>) => {
          stamped[path] = data;
          // Exact path, not `endsWith` — CodeQL reads a host suffix test as
          // incomplete URL sanitization, and an exact match is what this double
          // means anyway.
          if (path === 'hostnames/a.example.com') throw new Error('nope');
          return undefined;
        },
      }),
    };
    // The message must name the hostname that is still un-gated — that is the
    // only actionable thing in a retry log. Dots escaped: an unescaped `.` in a
    // hostname pattern matches more hosts than intended (CodeQL).
    await expect(raiseAdultContentForEvent(failing, 'e1')).rejects.toThrow(/a\.example\.com/);
    // …and the good alias was still stamped on the way through.
    expect(stamped['hostnames/b.example.com']).toEqual({ adultContent: true });
  });
});

describe('the triggers, end to end', () => {
  it('raises on an item write that leaves an active explicit Prompt', async () => {
    const raiseAdultContent = vi.fn(async () => 1);
    expect(
      await applyItemAdultContent('e1', { status: 'active', spicy: true, pool: 'main' }, { raiseAdultContent }),
    ).toBe(1);
    expect(raiseAdultContent).toHaveBeenCalledWith('e1');
  });

  // The cheap predicate runs BEFORE any read, so the overwhelming majority of
  // item writes — tame Prompts, report-count bumps, the auto-hide's own
  // `status: 'hidden'` flip — cost nothing at all.
  it('never reads for a write that cannot possibly gate the Event', async () => {
    const raiseAdultContent = vi.fn(async () => 0);
    await applyItemAdultContent('e1', { status: 'pending', spicy: true, pool: 'main' }, { raiseAdultContent });
    await applyItemAdultContent('e1', { status: 'active', spicy: false, pool: 'main' }, { raiseAdultContent });
    await applyItemAdultContent('e1', undefined, { raiseAdultContent });
    expect(raiseAdultContent).not.toHaveBeenCalled();
  });

  // NOT crossing-based, unlike the auto-hide next door. A crossing test would
  // make a swallowed failure permanent: the item stays active-and-spicy, no
  // later write is a fresh crossing, and the Event stays un-gated forever.
  it('re-attempts on every subsequent write to an already-qualifying Prompt', async () => {
    const raiseAdultContent = vi.fn(async () => 0);
    const after = { status: 'active' as const, spicy: true, pool: 'main' };
    await applyItemAdultContent('e1', after, { raiseAdultContent });
    await applyItemAdultContent('e1', after, { raiseAdultContent });
    expect(raiseAdultContent).toHaveBeenCalledTimes(2);
  });

  it('raises on an Event whose forceAdult override is on', async () => {
    const raiseAdultContent = vi.fn(async () => 1);
    expect(
      await applyEventAdultContent('e1', { settings: { forceAdult: true } }, { raiseAdultContent }),
    ).toBe(1);
    await applyEventAdultContent('e1', { settings: { forceAdult: false } }, { raiseAdultContent });
    expect(raiseAdultContent).toHaveBeenCalledTimes(1);
  });

  // These triggers deliberately DO throw, parting company with the never-throw
  // discipline in `autohide.ts` (Codex P2 on #615). That module swallows because
  // it shares a document path with the #101 notifiers and must not take them
  // down; these are dedicated triggers whose approval write has already
  // committed, so a throw costs only a retry of an idempotent operation — and
  // swallowing would leave a public fail-closed flag reading `false` on an Event
  // with active explicit content, with no second attempt.
  it('propagates a stamp failure so the platform retries', async () => {
    const raiseAdultContent = vi.fn(async () => {
      throw new Error('firestore is having a day');
    });
    await expect(
      applyItemAdultContent('e1', { status: 'active', spicy: true, pool: 'main' }, { raiseAdultContent }),
    ).rejects.toThrow(/having a day/);
    await expect(
      applyEventAdultContent('e1', { settings: { forceAdult: true } }, { raiseAdultContent }),
    ).rejects.toThrow(/having a day/);
  });

  // …but a write that could never gate the Event still costs nothing and cannot
  // fail, so no amount of ordinary Prompt traffic can put these triggers into a
  // retry loop.
  it('cannot fail on a write that never reaches the stamp', async () => {
    const raiseAdultContent = vi.fn(async () => {
      throw new Error('should never be called');
    });
    await expect(
      applyItemAdultContent('e1', { status: 'pending', spicy: true, pool: 'main' }, { raiseAdultContent }),
    ).resolves.toBe(0);
    await expect(applyEventAdultContent('e1', { settings: {} }, { raiseAdultContent })).resolves.toBe(0);
  });
});
