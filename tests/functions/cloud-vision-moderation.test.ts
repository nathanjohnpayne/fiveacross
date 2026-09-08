import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_HIDE_VISION_FLAGS,
  SAFETY_HIDE_MARKER,
  isAutoHideVisionFlag,
  qualifiesForVisionHide,
  visionHideAction,
  hideVisionFlaggedIfQualifies,
  applyVisionFlagHide,
  type VisionFlaggedDoc,
} from '../../functions/src/visionHide';
import {
  shouldHideAtThreshold,
  applyThresholdHide,
  type AdminFirestore,
  type ReportableDoc,
} from '../../functions/src/autohide';
import { safetyHideStands } from '../../src/data/moderation';

// specs/cloud-vision-moderation.md — the CONSUMER half of Cloud Vision (#133,
// ADR 0004). Proves the Vision-flag → hide path: an extreme/illegal `visionFlag`
// takes a `'flagged'` Proof to `status: 'hidden'` server-side with `visionFlag`
// left in place, raciness never auto-hides, an admin Restore sticks, and the
// #43 report-count path (functions/src/autohide.ts) is unchanged by any of it.
// Runs via `npm run test:functions`; every Firestore seam is injected or faked —
// no live runtime, and nothing here needs the Cloud Vision API enabled.

describe('isAutoHideVisionFlag — the extreme/illegal ALLOWLIST (ADR 0004)', () => {
  it('accepts exactly the two verdicts moderateProof emits for extreme/illegal media', () => {
    expect(AUTO_HIDE_VISION_FLAGS).toEqual(['violence', 'extreme']);
    expect(isAutoHideVisionFlag('violence')).toBe(true);
    expect(isAutoHideVisionFlag('extreme')).toBe(true);
  });

  it('NEVER accepts raciness — the app is intentionally racy, so adult/racy auto-hide nothing', () => {
    expect(isAutoHideVisionFlag('racy')).toBe(false);
    expect(isAutoHideVisionFlag('adult')).toBe(false);
  });

  it('fails CLOSED on anything else — unknown, mis-cased, padded, empty, or non-string', () => {
    for (const flag of ['spoof', 'medical', 'VIOLENCE', 'Violence', ' violence', 'violence ', '']) {
      expect(isAutoHideVisionFlag(flag)).toBe(false);
    }
    for (const flag of [null, undefined, 0, 1, true, {}, ['violence']]) {
      expect(isAutoHideVisionFlag(flag)).toBe(false);
    }
  });
});

describe('qualifiesForVisionHide — flagged AND extreme/illegal, at both gates', () => {
  it('qualifies a flagged Proof carrying either extreme verdict', () => {
    expect(qualifiesForVisionHide({ status: 'flagged', visionFlag: 'violence' })).toBe(true);
    expect(qualifiesForVisionHide({ status: 'flagged', visionFlag: 'extreme' })).toBe(true);
  });

  it('does NOT qualify a merely-racy or unflagged Proof, however it got to flagged', () => {
    expect(qualifiesForVisionHide({ status: 'flagged', visionFlag: 'racy' })).toBe(false);
    expect(qualifiesForVisionHide({ status: 'flagged', visionFlag: 'adult' })).toBe(false);
    expect(qualifiesForVisionHide({ status: 'flagged', visionFlag: null })).toBe(false);
    expect(qualifiesForVisionHide({ status: 'flagged' })).toBe(false);
  });

  it('loop guard: our OWN hide write leaves the Proof hidden, which no longer qualifies', () => {
    expect(qualifiesForVisionHide({ status: 'hidden', visionFlag: 'violence' })).toBe(false);
  });

  it('preserves admin Restore: an active Proof that still carries the verdict is NOT re-hidden', () => {
    // restoreProof writes status:'active' and deliberately leaves visionFlag as the
    // record of what the admin overrode. The status is what stops this path re-hiding it.
    expect(qualifiesForVisionHide({ status: 'active', visionFlag: 'violence' })).toBe(false);
  });

  it('leaves pending (admin_confirmed claim) and deleted docs alone', () => {
    expect(qualifiesForVisionHide({ status: 'pending', visionFlag: 'violence' })).toBe(false);
    expect(qualifiesForVisionHide(undefined)).toBe(false);
  });
});

/**
 * A fake AdminFirestore: an in-memory doc store keyed by path (a missing key ⇒
 * the doc does not exist), and a runTransaction that reads the live store and
 * records updates. Mirrors the fake in
 * tests/functions/w4-server-authoritative-hide.test.ts.
 */
function fakeDb(store: Record<string, Record<string, unknown> | undefined>) {
  const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  const snapFor = (path: string) => ({
    exists: store[path] !== undefined,
    id: path.split('/').pop() as string,
    data: () => store[path],
  });
  const ref = (path: string) => ({ __path: path, get: async () => snapFor(path) });
  const db = {
    doc: (path: string) => ref(path),
    collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }), get: async () => ({ docs: [] }) }),
    runTransaction: async <T>(
      fn: (tx: {
        get: (r: { __path: string }) => Promise<ReturnType<typeof snapFor>>;
        update: (r: { __path: string }, d: Record<string, unknown>) => void;
      }) => Promise<T>,
    ) =>
      fn({
        get: async (r) => snapFor(r.__path),
        update: (r, d) => {
          store[r.__path] = { ...(store[r.__path] ?? {}), ...d };
          updates.push({ path: r.__path, data: d });
        },
      }),
  };
  return { db: db as unknown as AdminFirestore, updates, store };
}

describe('hideVisionFlaggedIfQualifies — transactional conditional hide', () => {
  const PROOF = 'events/e/proofs/p1';

  it('flips a flagged extreme Proof to hidden, STAMPING the safety marker, and returns true', async () => {
    // One update, both fields: the marker is what the client's confirm-time gate
    // reads (src/data/moderation.ts safetyHideStands), so there must be no window
    // in which the Proof is hidden without the server's record of why, and no
    // second write for a client to observe half of.
    const { db, updates } = fakeDb({ [PROOF]: { status: 'flagged', visionFlag: 'violence', reportCount: 0 } });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(true);
    expect(updates).toEqual([{ path: PROOF, data: { status: 'hidden', safetyHide: true } }]);
    expect(SAFETY_HIDE_MARKER).toBe('safetyHide'); // the field name the client and the rules both name
  });

  it('writes status + the marker and NOTHING else — visionFlag survives, so the hide stays legible', async () => {
    const { db, store } = fakeDb({ [PROOF]: { status: 'flagged', visionFlag: 'extreme', reportCount: 2 } });
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    expect(store[PROOF]).toEqual({ status: 'hidden', safetyHide: true, visionFlag: 'extreme', reportCount: 2 });
  });

  it('re-confirms LIVE state: an admin who Restored since the trigger fired is not reverted', async () => {
    const { db, updates } = fakeDb({ [PROOF]: { status: 'active', visionFlag: 'violence' } });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toEqual([]);
  });

  it('never re-creates a Proof deleted since the snapshot', async () => {
    const { db, updates, store } = fakeDb({});
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toEqual([]);
    expect(store[PROOF]).toBeUndefined();
  });

  it('no-ops on a live flag outside the allowlist, and on an already-hidden Proof (idempotent)', async () => {
    const racy = fakeDb({ [PROOF]: { status: 'flagged', visionFlag: 'racy' } });
    expect(await hideVisionFlaggedIfQualifies(racy.db, 'e', 'p1')).toBe(false);
    expect(racy.updates).toEqual([]);

    const already = fakeDb({ [PROOF]: { status: 'hidden', safetyHide: true, visionFlag: 'violence' } });
    expect(await hideVisionFlaggedIfQualifies(already.db, 'e', 'p1')).toBe(false);
    expect(already.updates).toEqual([]);
  });

  it('never re-stamps a Proof an admin Restored — the lift is not overwritten by a retry', async () => {
    // restoreProof writes { status: 'active', safetyHide: false }. A late or
    // duplicate trigger delivery re-reads the LIVE doc and stands down, so the
    // admin's `false` (and the media) survive.
    const { db, updates, store } = fakeDb({
      [PROOF]: { status: 'active', safetyHide: false, visionFlag: 'violence' },
    });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toEqual([]);
    expect(store[PROOF]).toMatchObject({ status: 'active', safetyHide: false });
  });
});

// --- the backfill arm: a hide that reached 'hidden' without the marker --------
//
// Codex P1 on #1143. The console offers Hide on a 'flagged' row — the row renders
// the moment moderateProof writes the verdict, and this trigger is neither
// instantaneous nor guaranteed (its write is best-effort and a failure is
// swallowed). An admin who clicks it there agrees WITH the AI screen, but the
// resulting doc is 'hidden' with no marker, which is exactly the shape
// `safetyHideStands` reads as a PLAIN hide — so a later Confirm on the same Proof
// publishes the media the admin had just taken down, and the trigger's hide arm
// (flagged-only) can never fire on it again. The backfill arm supplies the
// missing record instead.

describe('the backfill arm — a marker-less hidden extreme Proof is stamped (#1143)', () => {
  const PROOF = 'events/e/proofs/p1';

  it('names the backfill only where the hold is real and its record is missing', () => {
    // Absent OR non-boolean, never `false`: the console Restore writes `false` as
    // the admin's explicit override, and re-stamping over it would let the server
    // silently overrule the one decision ADR 0004 reserves for a human.
    expect(visionHideAction({ status: 'hidden', visionFlag: 'violence' })).toBe('backfill');
    expect(visionHideAction({ status: 'hidden', visionFlag: 'extreme', safetyHide: null })).toBe('backfill');
    expect(visionHideAction({ status: 'hidden', visionFlag: 'violence', safetyHide: false })).toBe(null);
    expect(visionHideAction({ status: 'hidden', visionFlag: 'violence', safetyHide: true })).toBe(null);
    // Raciness never gains a marker any more than it gains a hide (ADR 0004),
    // and a hide with no verdict at all is a plain one.
    expect(visionHideAction({ status: 'hidden', visionFlag: 'racy' })).toBe(null);
    expect(visionHideAction({ status: 'hidden' })).toBe(null);
    // The hide arm is unchanged, and still the only one that moves a status.
    expect(visionHideAction({ status: 'flagged', visionFlag: 'violence' })).toBe('hide');
    expect(visionHideAction({ status: 'active', visionFlag: 'violence' })).toBe(null);
    expect(visionHideAction(undefined)).toBe(null);
  });

  it('stamps the marker and NOTHING else — the status it did not decide is left alone', async () => {
    const { db, updates, store } = fakeDb({
      [PROOF]: { status: 'hidden', visionFlag: 'violence', reportCount: 1 },
    });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(true);
    expect(updates).toEqual([{ path: PROOF, data: { safetyHide: true } }]);
    expect(store[PROOF]).toEqual({ status: 'hidden', safetyHide: true, visionFlag: 'violence', reportCount: 1 });
  });

  it('never re-applies the marker over an admin lift, whatever the doc then does', async () => {
    // restoreProof writes `false`; an admin who then hand-Hides the Proof keeps
    // it, so the result is a plain hide — liftable by Restore, publishable by a
    // confirm — because the admin has already seen the verdict and overridden it.
    const lifted = fakeDb({ [PROOF]: { status: 'hidden', safetyHide: false, visionFlag: 'violence' } });
    expect(await hideVisionFlaggedIfQualifies(lifted.db, 'e', 'p1')).toBe(false);
    expect(lifted.updates).toEqual([]);
    expect(lifted.store[PROOF]).toMatchObject({ safetyHide: false });
  });

  it('is idempotent: the stamped doc re-fires the trigger and takes no second write', async () => {
    const { db, updates } = fakeDb({ [PROOF]: { status: 'hidden', visionFlag: 'violence' } });
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toHaveLength(1); // the backfill, and no loop after it
  });

  it('the stamped doc is one the confirm-time gate holds — which is the whole point', async () => {
    const { db, store } = fakeDb({ [PROOF]: { status: 'hidden', visionFlag: 'violence' } });
    expect(safetyHideStands(store[PROOF] as { status?: string; safetyHide?: boolean })).toBe(false);
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    expect(safetyHideStands(store[PROOF] as { status?: string; safetyHide?: boolean })).toBe(true);
  });

  it('reaches Firestore for the backfill snapshot, unlike every write no arm claims', async () => {
    const hide = vi.fn(async () => true);
    expect(
      await applyVisionFlagHide('e', 'p1', { status: 'hidden', visionFlag: 'violence' }, { hideIfQualifies: hide }),
    ).toBe(true);
    expect(hide).toHaveBeenCalledWith('e', 'p1');
  });
});

describe('applyVisionFlagHide — the best-effort trigger body', () => {
  const flagged = (visionFlag: string | null): VisionFlaggedDoc => ({ status: 'flagged', visionFlag });

  it('hides on the scanner write (status flagged + extreme verdict)', async () => {
    const hide = vi.fn(async () => true);
    expect(await applyVisionFlagHide('e', 'p1', flagged('violence'), { hideIfQualifies: hide })).toBe(true);
    expect(hide).toHaveBeenCalledWith('e', 'p1');
  });

  it('short-circuits with NO Firestore access on every write that does not qualify', async () => {
    const hide = vi.fn(async () => true);
    const skipped: Array<VisionFlaggedDoc | undefined> = [
      flagged('racy'), // merely racy — never auto-hidden (ADR 0004)
      flagged('adult'),
      flagged(null), // flagged by an admin path with no verdict
      { status: 'active', visionFlag: 'violence' }, // the admin Restore write
      { status: 'hidden', safetyHide: true, visionFlag: 'violence' }, // our own hide write re-firing
      { status: 'hidden', safetyHide: false, visionFlag: 'violence' }, // Restored, then hand-Hidden
      { status: 'hidden', visionFlag: 'racy' }, // hidden by an admin; nothing to back-fill
      { status: 'active', visionFlag: null }, // an ordinary report bump on an unflagged Proof
      { status: 'pending', visionFlag: 'violence' }, // an unresolved admin_confirmed claim
      undefined, // a delete
    ];
    for (const after of skipped) {
      expect(await applyVisionFlagHide('e', 'p1', after, { hideIfQualifies: hide })).toBe(false);
    }
    expect(hide).not.toHaveBeenCalled();
  });

  it('never throws — a failing write is swallowed so the proof pipeline is untouched (ADR 0001)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => {
      throw new Error('transaction failed');
    });
    await expect(applyVisionFlagHide('e', 'p1', flagged('violence'), { hideIfQualifies: boom })).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('retries on a later write that leaves the Proof flagged — a swallowed first attempt is not terminal', async () => {
    // The state predicate (not a transition one) is what makes this possible: a
    // report bump on a still-flagged Proof re-attempts the hide the earlier
    // best-effort failure never landed.
    const hide = vi.fn(async () => true);
    await applyVisionFlagHide('e', 'p1', flagged('violence'), { hideIfQualifies: hide }); // first attempt
    expect(await applyVisionFlagHide('e', 'p1', flagged('violence'), { hideIfQualifies: hide })).toBe(true);
    expect(hide).toHaveBeenCalledTimes(2);
  });
});

describe('composition with the #43 report-count auto-hide — the two paths never fight', () => {
  const threshold = 4;

  it('the report path still refuses to downgrade a flagged Proof (active-only invariant intact)', () => {
    expect(
      shouldHideAtThreshold(
        { status: 'flagged', reportCount: 3 },
        { status: 'flagged', reportCount: 4 },
        threshold,
      ),
    ).toBe(false);
  });

  it('a Vision-hidden Proof takes no further report-count write — it is hidden, not active', async () => {
    const hide = vi.fn(async () => true);
    const hidden: ReportableDoc = { status: 'hidden', reportCount: 9 };
    expect(
      await applyThresholdHide('proofs', 'e', 'p1', { status: 'hidden', reportCount: 8 }, hidden, {
        getReportHideThreshold: async () => threshold,
        hideIfQualifies: hide,
      }),
    ).toBe(false);
    expect(hide).not.toHaveBeenCalled();
  });

  it('after an admin Restore the report path owns the Proof again, and the Vision path stands down', async () => {
    // The restored Proof is active and still over the bar. A further report is a
    // rise, so the community hide applies — as a plain hide, which is now correct:
    // an admin has already seen and overridden the AI verdict. The Vision path
    // does not contest it, because the Proof is no longer 'flagged'.
    const reportHide = vi.fn(async () => true);
    const visionHide = vi.fn(async () => true);
    expect(
      await applyThresholdHide(
        'proofs',
        'e',
        'p1',
        { status: 'active', reportCount: 4 },
        { status: 'active', reportCount: 5 },
        { getReportHideThreshold: async () => threshold, hideIfQualifies: reportHide },
      ),
    ).toBe(true);
    expect(reportHide).toHaveBeenCalledWith('proofs', 'e', 'p1');
    expect(
      await applyVisionFlagHide('e', 'p1', { status: 'active', visionFlag: 'violence' }, {
        hideIfQualifies: visionHide,
      }),
    ).toBe(false);
    expect(visionHide).not.toHaveBeenCalled();
  });
});

// --- the server-owned marker is the client's ONLY input ----------------------
//
// The Vision hide is server-authoritative, but ONE client write can undo it.
// `confirmClaim` (src/data/admin.ts) publishes an admin_confirmed claim's
// 'pending' Proof by writing `status: 'active'`, and active Proofs sit OUTSIDE
// `qualifiesForVisionHide` — so confirming a Mark whose photo had already been
// safety-hidden would re-expose extreme/illegal media and this trigger would
// never hide it again.
//
// That gate used to MIRROR the allowlist above on the client and lean on a parity
// test to keep the two copies honest. It does not any more (Codex P1 round 2): a
// parity test compares two files in ONE revision, and the risk is two revisions
// running at once — Functions and the PWA deploy separately, so a cached bundle
// holding yesterday's list reads a newly hide-worthy verdict as safe and
// publishes a Proof the server had deliberately hidden. The client now reads only
// what THIS module writes. These cases pin the seam from both ends: the verdict
// list stays here alone, and the marker this module stamps is what the client acts
// on.

describe('the confirm-time gate reads the SERVER marker, not the verdict (#133)', () => {
  it('holds on the marker for ANY verdict — including one this build has never heard of', () => {
    // The staggered-deploy case in full. A future Functions release widens
    // AUTO_HIDE_VISION_FLAGS, hides a Proof for 'gore' and stamps the marker; a
    // client built before that release still holds, because it never reads the
    // verdict at all.
    for (const verdict of ['violence', 'extreme', 'gore', 'weapons', 'Violence', '', null]) {
      expect(isAutoHideVisionFlag(verdict)).toBe(['violence', 'extreme'].includes(verdict as string));
      expect(safetyHideStands({ status: 'hidden', safetyHide: true })).toBe(true);
    }
  });

  it('holds on a still-flagged Proof, the one state the marker has not landed on yet', () => {
    // The window between moderateProof's flag write and this trigger's hide (or a
    // swallowed best-effort failure it will retry on the next write). Publishing
    // there would move the doc out of the state `qualifiesForVisionHide` looks
    // for, so the retry could never fire.
    expect(safetyHideStands({ status: 'flagged' })).toBe(true);
    expect(safetyHideStands({ status: 'flagged', safetyHide: false })).toBe(true);
  });

  it('stands down wherever this trigger never wrote a marker — including a plain hide', () => {
    // A 'hidden' Proof with no marker was hidden by an admin's own Hide or by the
    // #43 report threshold; each has its own console lift and confirm has never
    // withheld for either. A restored Proof carries the admin's explicit `false`.
    expect(safetyHideStands({ status: 'hidden' })).toBe(false);
    expect(safetyHideStands({ status: 'hidden', safetyHide: false })).toBe(false);
    expect(safetyHideStands({ status: 'active', safetyHide: false })).toBe(false);
    expect(safetyHideStands({ status: 'pending' })).toBe(false);
    expect(safetyHideStands({ status: 'active' })).toBe(false);
    expect(safetyHideStands(undefined)).toBe(false);
  });

  it('agrees with the trigger on the doc the trigger owns, and covers the one it cannot', () => {
    const flagged: VisionFlaggedDoc = { status: 'flagged', visionFlag: 'violence' };
    // 'flagged' + extreme: the trigger is about to hide it, and the client holds.
    expect(qualifiesForVisionHide(flagged)).toBe(true);
    expect(safetyHideStands(flagged)).toBe(true);
    // 'hidden' + the marker: the doc the trigger already produced and now stands
    // down on (its loop guard) — precisely the one a confirm would re-expose, so
    // the client gate holds exactly where the trigger cannot.
    const hidden = { status: 'hidden', safetyHide: true, visionFlag: 'violence' };
    expect(qualifiesForVisionHide(hidden)).toBe(false);
    expect(safetyHideStands(hidden)).toBe(true);
  });

  it('names the marker field identically on both sides of the seam', async () => {
    const { db, updates } = fakeDb({
      'events/e/proofs/p1': { status: 'flagged', visionFlag: 'violence' },
    });
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    const written = updates[0].data as { status?: string; safetyHide?: boolean };
    expect(Object.keys(updates[0].data)).toContain(SAFETY_HIDE_MARKER);
    // The client reads that written doc back through the same key, with no
    // translation layer between them to drift.
    expect(safetyHideStands(written)).toBe(true);
  });
});

