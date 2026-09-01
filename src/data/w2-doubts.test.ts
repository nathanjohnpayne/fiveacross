import { describe, it, expect, vi, beforeEach } from 'vitest';

// specs/w2-doubts.md, unit layer. Proves the two write-side + derivation halves of
// a Doubt (ADR 0001 — social pressure, never a gate):
//   1. `raiseDoubt` self-publishes a Doubt at the DETERMINISTIC once-only slot
//      events/{EVENT_ID}/doubts/{fromUid}_{targetUid}_{itemId} (Codex P2, PR #106
//      round 2 finding 2) with the rules-block shape (own fromUid, target's uid,
//      itemId, numeric cellIndex + createdAt), attributed via the SHARED
//      saved-player helper (`markerDisplayName`, bounded to the ≤100 rule, falling
//      back to the CACHED player row before 'Anonymous' — round 2 finding 3), as a
//      plain offline-queueable `setDoc` (never a transaction, never a Feed post),
//      and fires the `demand_proof` analytics event ONLY once the write settles
//      successfully — a persisted Doubt counts, an in-flight or rejected one does
//      not (round 3 finding 2). Every duplicate path is a no-op — a self-doubt, an
//      open duplicate in `currentlyOpen`, a slot already in the LOCAL cache (the
//      writeMomentOnce-style pre-check), and a server-side once-only denial
//      (logged at debug, not error) — none writes, none fires analytics.
//   2. Satisfaction is a PURE derivation over Proofs — no write is added to
//      `attachProof`, no Doubt doc is mutated. `isDoubtSatisfied` /`openDoubts`/
//      `doubtStatusFor` are exercised as a truth table: a Doubt is answered when
//      the doubted Player has a Proof for the SAME Prompt (by itemText) at or
//      after the Doubt — within the rules' 60s clock-skew tolerance (round 2
//      finding 1) and with the cutoff clamped to no-later-than `now` (finding 3).
//      A Proof genuinely before the Doubt, by another Player, or for another
//      Prompt does NOT answer it. None of this touches the Mark.
// The rules-side accept/deny proof is tests/rules/w2-doubts.test.ts; the Board
// wiring proof is src/components/w2-doubts.test.tsx.

const EVENT_ID = 'med-2026'; // src/firebase.ts default when VITE_EVENT_ID is unset
const EVENT_H = vi.hoisted(() => ({ eventId: 'med-2026' }));

const { setDocSpy, trackSpy, getDocFromCacheSpy } = vi.hoisted(() => ({
  // Typed params so `.mock.calls[i]` carries the (ref, data) tuple types.
  setDocSpy: vi.fn((_ref: { path: string }, _data: Record<string, unknown>) => Promise.resolve()),
  trackSpy: vi.fn(),
  // Default: nothing cached (getDocFromCache rejects on a cache miss, like the SDK).
  getDocFromCacheSpy: vi.fn(
    (_ref: {
      path: string;
    }): Promise<{ exists: () => boolean; data: () => Record<string, unknown> | undefined }> =>
      Promise.reject(new Error('cache miss')),
  ),
}));

// Inline the id literal — a vi.mock factory is hoisted above the module-level
// `EVENT_ID` const, so referencing it here would hit its temporal dead zone.
vi.mock('../firebase', () => ({
  db: {},
  get EVENT_ID() {
    return EVENT_H.eventId;
  },
}));
vi.mock('../analytics', () => ({ track: trackSpy }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    // collection(db, ...segments) → a ref carrying its path; doc(collectionRef, id)
    // → the child doc under it (raiseDoubt's deterministic-slot create); doc(db,
    // ...segments) → an absolute path (the raw player-row ref).
    collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    doc: (refOrDb: unknown, ...segments: string[]) => {
      const base = (refOrDb as { path?: string }).path;
      const path = base ? [base, ...segments].join('/') : segments.join('/');
      return { path, id: segments[segments.length - 1] ?? 'auto-doubt-id' };
    },
    setDoc: setDocSpy,
    getDocFromCache: getDocFromCacheSpy,
  };
});

import {
  raiseDoubt,
  doubtDocId,
  isDoubtSatisfied,
  openDoubts,
  doubtStatusFor,
} from './doubts';

beforeEach(() => {
  vi.clearAllMocks();
  EVENT_H.eventId = EVENT_ID;
  // Re-pin the defaults (clearAllMocks clears calls, not implementations set by a
  // previous test's mockImplementation).
  setDocSpy.mockImplementation(() => Promise.resolve());
  getDocFromCacheSpy.mockImplementation(() => Promise.reject(new Error('cache miss')));
});

describe('raiseDoubt — self-published Doubt + demand_proof (specs/w2-doubts.md)', () => {
  it('writes a Doubt at the deterministic once-only slot and fires demand_proof at the raise', async () => {
    await raiseDoubt({
      fromUid: 'alice',
      fromDisplayName: 'Alice',
      targetUid: 'bob',
      targetDisplayName: 'Bob',
      itemId: 'i3',
      cellIndex: 3,
    });

    // One plain setDoc — the deterministic {fromUid}_{targetUid}_{itemId} slot
    // under the flat doubts collection (PR #106 round 2 finding 2). Not a
    // transaction, not a Feed post (ADR 0001/0002).
    expect(doubtDocId('alice', 'bob', 'i3')).toBe('alice_bob_i3');
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    const [ref, data] = setDocSpy.mock.calls[0];
    expect(ref.path).toBe(`events/${EVENT_ID}/doubts/alice_bob_i3`);
    expect(data).toMatchObject({
      itemId: 'i3',
      cellIndex: 3,
      fromUid: 'alice',
      fromDisplayName: 'Alice',
      targetUid: 'bob',
      targetDisplayName: 'Bob',
    });
    expect(typeof data.createdAt).toBe('number');
    // The doc id IS the slot (converter pins it on read); nothing stores `id`,
    // and satisfaction is DERIVED so no satisfied* is written.
    expect(data.id).toBeUndefined();
    expect(data.satisfiedAt).toBeUndefined();

    // demand_proof fired exactly once — the awaited raise settled successfully,
    // so the persisted-only rule (round 3 finding 2) is satisfied here.
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('demand_proof', { itemId: 'i3' });
  });

  it('fires demand_proof ONLY once the write settles successfully — not at tap time (PR #106 round 3 finding 2)', async () => {
    // A deferred setDoc models the in-flight window (an online round-trip, or an
    // offline queue awaiting drain): the demand is not yet PERSISTED, so nothing
    // may be counted yet — the old tap-time fire counted demands the once-only
    // backstop then rejected, inflating the metric.
    let resolveWrite: () => void = () => {};
    setDocSpy.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolveWrite = () => res();
        }),
    );
    const settled = raiseDoubt({ fromUid: 'alice', targetUid: 'bob', itemId: 'i1', cellIndex: 1 });
    await vi.waitFor(() => expect(setDocSpy).toHaveBeenCalledTimes(1));
    expect(trackSpy).not.toHaveBeenCalled(); // in flight — nothing persisted, nothing counted

    resolveWrite(); // the server acknowledged (or the offline queue drained)
    await settled;
    expect(trackSpy).toHaveBeenCalledTimes(1); // exactly one persisted demand
    expect(trackSpy).toHaveBeenCalledWith('demand_proof', { itemId: 'i1' });
  });

  it('attributes via the shared saved-player helper: Anonymous fallback + ≤100 bound', async () => {
    await raiseDoubt({ fromUid: 'alice', targetUid: 'bob', itemId: 'i1', cellIndex: 1 }); // no names, nothing cached
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({
      fromDisplayName: 'Anonymous',
      targetDisplayName: 'Anonymous',
    });

    setDocSpy.mockClear();
    await raiseDoubt({
      fromUid: 'alice',
      fromDisplayName: 'x'.repeat(140),
      targetUid: 'bob',
      targetDisplayName: 'y'.repeat(140),
      itemId: 'i1',
      cellIndex: 1,
    });
    const data = setDocSpy.mock.calls[0][1];
    expect((data.fromDisplayName as string).length).toBe(100);
    expect((data.targetDisplayName as string).length).toBe(100);
  });

  it('falls back to the CACHED player row’s name before Anonymous when no preferred name is passed (PR #106 round 2 finding 3)', async () => {
    // The identity window: the caller has no KNOWN name (Board passes undefined
    // while the player row loads), but THIS device's cache holds the saved row —
    // the same fallback attribution setMark uses (api.ts). The doubt slot itself
    // is not cached, so the pre-check falls through to the write.
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path === `events/${EVENT_ID}/players/alice`
        ? Promise.resolve({ exists: () => true, data: () => ({ displayName: 'Saved Alice' }) })
        : Promise.reject(new Error('cache miss')),
    );
    await raiseDoubt({ fromUid: 'alice', targetUid: 'bob', itemId: 'i1', cellIndex: 1 });
    expect(setDocSpy).toHaveBeenCalledTimes(1);
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({ fromDisplayName: 'Saved Alice' });
  });

  it('keeps both cache reads and the write in Event A when the active Event changes mid-raise', async () => {
    let rejectSlotRead!: () => void;
    let resolvePlayerRead!: () => void;
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) => {
      if (ref.path.includes('/doubts/')) {
        return new Promise((_resolve, reject) => {
          rejectSlotRead = () => reject(new Error('cache miss'));
        });
      }
      return new Promise((resolve) => {
        resolvePlayerRead = () =>
          resolve({ exists: () => true, data: () => ({ displayName: 'Saved Event A Alice' }) });
      });
    });

    const settled = raiseDoubt({
      fromUid: 'alice',
      targetUid: 'bob',
      itemId: 'i1',
      cellIndex: 1,
    });
    await vi.waitFor(() => expect(getDocFromCacheSpy).toHaveBeenCalledTimes(1));
    EVENT_H.eventId = 'event-b';
    rejectSlotRead();
    await vi.waitFor(() => expect(getDocFromCacheSpy).toHaveBeenCalledTimes(2));
    expect(getDocFromCacheSpy.mock.calls[1][0].path).toBe(
      `events/${EVENT_ID}/players/alice`,
    );
    resolvePlayerRead();
    await settled;

    expect(setDocSpy.mock.calls[0][0].path).toBe(
      `events/${EVENT_ID}/doubts/alice_bob_i1`,
    );
    expect(setDocSpy.mock.calls[0][1]).toMatchObject({
      fromDisplayName: 'Saved Event A Alice',
    });
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('a self-doubt is a no-op — no write, no analytics (ADR 0001, rules deny it too)', async () => {
    await raiseDoubt({ fromUid: 'alice', targetUid: 'alice', itemId: 'i1', cellIndex: 1 });
    expect(setDocSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
    expect(getDocFromCacheSpy).not.toHaveBeenCalled(); // rejected before any read
  });

  it('skips the raise when an OPEN duplicate is already in currentlyOpen (finding 1 backstop)', async () => {
    await raiseDoubt({
      fromUid: 'alice',
      targetUid: 'bob',
      itemId: 'i1',
      cellIndex: 1,
      currentlyOpen: [{ fromUid: 'alice', targetUid: 'bob', itemId: 'i1' }],
    });
    expect(setDocSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('skips the write AND the analytics when the slot is already in the local cache (round 2 finding 2)', async () => {
    // The writeMomentOnce-style pre-check: a duplicate setDoc would locally
    // overwrite the cached Doubt (latency compensation) with a refreshed
    // createdAt — flipping a satisfied Doubt back open until the server denial —
    // so a cached slot is skipped entirely, logged at debug (designed path).
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getDocFromCacheSpy.mockImplementation((ref: { path: string }) =>
      ref.path === `events/${EVENT_ID}/doubts/alice_bob_i1`
        ? Promise.resolve({ exists: () => true, data: () => ({}) })
        : Promise.reject(new Error('cache miss')),
    );
    await raiseDoubt({ fromUid: 'alice', targetUid: 'bob', itemId: 'i1', cellIndex: 1 });
    expect(setDocSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('treats the once-only permission denial as benign (debug), keeps console.error for real failures (round 2 finding 2)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A cross-client duplicate that beat this client to the slot: the write lands
    // on the doc-exists update rule and rejects permission-denied — the designed
    // once-only backstop, not an error. The settle promise still resolves.
    setDocSpy.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' })),
    );
    await raiseDoubt({ fromUid: 'alice', targetUid: 'bob', itemId: 'i1', cellIndex: 1 });
    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    // The denied duplicate never persisted — it counts NOTHING (round 3 finding 2).
    expect(trackSpy).not.toHaveBeenCalled();

    // Any OTHER rejection is a genuine online failure — observability kept, and an
    // unpersisted demand still fires no analytics.
    setDocSpy.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    await raiseDoubt({ fromUid: 'alice', targetUid: 'carol', itemId: 'i1', cellIndex: 1 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('satisfied-by-Proof — pure derivation truth table (specs/w2-doubts.md)', () => {
  const TEXT = 'Saw a drag show';
  // ms-scale stamps: the 60s skew tolerance (DOUBT_SATISFACTION_SKEW_MS) is real
  // wall-clock milliseconds, so the fixtures live at that scale.
  const DOUBT_AT = 1_000_000;
  const doubt = (over: Partial<{ targetUid: string; createdAt: number }> = {}) => ({
    targetUid: 'bob',
    createdAt: DOUBT_AT,
    ...over,
  });
  const proof = (over: Partial<{ uid: string; itemText: string; createdAt: number }> = {}) => ({
    uid: 'bob',
    itemText: TEXT,
    createdAt: DOUBT_AT + 50_000,
    ...over,
  });

  it('is answered ONLY by the doubted Player’s Proof for the same Prompt, at or after the Doubt (within the rules’ skew)', () => {
    expect(isDoubtSatisfied(doubt(), TEXT, [])).toBe(false); // no Proof
    expect(isDoubtSatisfied(doubt(), TEXT, [proof()])).toBe(true); // after, same target + Prompt
    expect(isDoubtSatisfied(doubt(), TEXT, [proof({ createdAt: DOUBT_AT })])).toBe(true); // exactly at
    expect(isDoubtSatisfied(doubt(), TEXT, [proof({ createdAt: DOUBT_AT - 61_000 })])).toBe(false); // genuinely before (beyond the skew)
    expect(isDoubtSatisfied(doubt(), TEXT, [proof({ uid: 'carol' })])).toBe(false); // another Player
    expect(isDoubtSatisfied(doubt(), TEXT, [proof({ itemText: 'Other' })])).toBe(false); // another Prompt
  });

  it('tolerates the rules’ +60s clock skew — an immediate Proof against a fast-clock Doubt satisfies (PR #106 round 2 finding 1)', () => {
    // The doubter's clock runs 59s fast — a stamp the rules ACCEPT (the +60s
    // bound). The target proofs IMMEDIATELY on a normal clock: numerically before
    // the Doubt. Without the tolerance the Doubt stays open until a SECOND Proof.
    const base = 10_000_000;
    const fastDoubt = doubt({ createdAt: base + 59_000 });
    expect(isDoubtSatisfied(fastDoubt, TEXT, [proof({ createdAt: base })])).toBe(true); // the immediate Proof answers it
    // The skew edge, exactly: cutoff − 60s.
    expect(isDoubtSatisfied(fastDoubt, TEXT, [proof({ createdAt: base - 1_000 })])).toBe(true);
    // A Proof from genuinely BEFORE the Doubt − 60s does NOT answer it — the
    // Doubt still asks for fresh pics.
    expect(isDoubtSatisfied(fastDoubt, TEXT, [proof({ createdAt: base - 1_001 })])).toBe(false);
  });

  it('treats an ILLEGALLY-future stamp as garbage — ANY matching Proof answers it (PR #106 finding 3, reshaped by round 5)', () => {
    const now = 20_000_000;
    // A Doubt stamped an hour ahead of eval time — beyond the +60s the rules could
    // ever have accepted, so a legacy/malformed doc. The stamp carries no
    // information: WITHOUT the guard, satisfaction is unreachable until that
    // future instant (finding 3); with it, any matching Proof answers, regardless
    // of the Proof's own age (round 5 — a garbage stamp cannot justify rejecting).
    const garbage = doubt({ createdAt: now + 3_600_000 });
    expect(isDoubtSatisfied(garbage, TEXT, [proof({ createdAt: now })], now)).toBe(true);
    expect(isDoubtSatisfied(garbage, TEXT, [proof({ createdAt: now - 60_001 })], now)).toBe(true); // even an old Proof
    // ...but only a MATCHING Proof: uid + itemText still gate.
    expect(isDoubtSatisfied(garbage, TEXT, [proof({ uid: 'carol', createdAt: now })], now)).toBe(false);
    expect(isDoubtSatisfied(garbage, TEXT, [proof({ itemText: 'Other', createdAt: now })], now)).toBe(false);
    // A normal past-dated Doubt is unaffected (its own stamp is the cutoff).
    expect(isDoubtSatisfied(doubt(), TEXT, [proof()], now)).toBe(true);
    expect(isDoubtSatisfied(doubt(), TEXT, [proof({ createdAt: DOUBT_AT - 61_000 })], now)).toBe(false);
  });

  it('keeps a garbage-stamped Doubt SATISFIED as now advances — monotone, never re-opening on a shown Proof (PR #106 round 5, P3)', () => {
    const T = 30_000_000;
    const garbage = doubt({ createdAt: T + 3_600_000 }); // +1h — illegally future throughout
    const answered = [proof({ createdAt: T })]; // the Proof attached "now"
    expect(isDoubtSatisfied(garbage, TEXT, answered, T)).toBe(true); // satisfied at T...
    // ...and STILL satisfied later. On the round-3 shape the sliding
    // min(createdAt, now) cutoff outran the Proof at T + 60s: the badge/status
    // re-opened on evidence already shown. Once answered, always answered (for as
    // long as the stamp remains provably garbage — the whole offset minus the skew).
    expect(isDoubtSatisfied(garbage, TEXT, answered, T + 61_000)).toBe(true);
    expect(isDoubtSatisfied(garbage, TEXT, answered, T + 1_800_000)).toBe(true); // 30 min on
  });

  it('keeps the legal-window semantics — a stamp within the rules’ +60s is NOT garbage (round 5 pins rounds 1–3 unchanged)', () => {
    const now = 40_000_000;
    // A fast-but-rules-legal clock (+59s): the finding-3 clamp still applies —
    // answerable immediately, but an old Proof beyond now − skew still does not
    // count (this stamp is plausible, so it still gates freshness).
    const fastClock = doubt({ createdAt: now + 59_000 });
    expect(isDoubtSatisfied(fastClock, TEXT, [proof({ createdAt: now })], now)).toBe(true);
    expect(isDoubtSatisfied(fastClock, TEXT, [proof({ createdAt: now - 60_001 })], now)).toBe(false);
  });

  it('openDoubts keeps only the unanswered Doubts (the per-Prompt open count)', () => {
    const answered = doubt({ targetUid: 'bob' }); // bob's Proof (50s after) answers it
    const stillOpen = doubt({ targetUid: 'carol' }); // carol never proofs
    const proofs = [proof()]; // bob only
    expect(openDoubts([answered, stillOpen], TEXT, proofs)).toEqual([stillOpen]);
    expect(openDoubts([answered, stillOpen], TEXT, [])).toEqual([answered, stillOpen]); // none answered
  });

  it('doubtStatusFor is none / open / satisfied per Player, open winning any mix', () => {
    const answered = doubt({ targetUid: 'bob' });
    const open = doubt({ targetUid: 'carol' });
    const proofs = [proof()]; // answers bob's

    expect(doubtStatusFor('dave', [answered, open], TEXT, proofs)).toBe('none'); // undoubted
    expect(doubtStatusFor('carol', [open], TEXT, proofs)).toBe('open'); // unanswered
    expect(doubtStatusFor('bob', [answered], TEXT, proofs)).toBe('satisfied'); // all answered
    // A second Doubt against bob raised 70s AFTER his Proof — beyond the skew
    // window — flips the whole row back to open.
    const alsoOpen = doubt({ targetUid: 'bob', createdAt: DOUBT_AT + 120_000 });
    expect(doubtStatusFor('bob', [answered, alsoOpen], TEXT, proofs)).toBe('open');
  });
});
