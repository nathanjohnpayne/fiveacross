import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_HIDE_VISION_FLAGS,
  isAutoHideVisionFlag,
  qualifiesForVisionHide,
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
import {
  AUTO_HIDE_VISION_FLAGS as clientAutoHideFlags,
  isAutoHideVisionFlag as clientIsAutoHideVisionFlag,
  visionHideStands,
} from '../../src/data/moderation';

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

  it('flips a flagged extreme Proof to hidden and returns true', async () => {
    const { db, updates } = fakeDb({ [PROOF]: { status: 'flagged', visionFlag: 'violence', reportCount: 0 } });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(true);
    expect(updates).toEqual([{ path: PROOF, data: { status: 'hidden' } }]);
  });

  it('writes status and NOTHING else — visionFlag survives, so the hide stays legible as a Vision hide', async () => {
    const { db, store } = fakeDb({ [PROOF]: { status: 'flagged', visionFlag: 'extreme', reportCount: 2 } });
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    expect(store[PROOF]).toEqual({ status: 'hidden', visionFlag: 'extreme', reportCount: 2 });
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

    const already = fakeDb({ [PROOF]: { status: 'hidden', visionFlag: 'violence' } });
    expect(await hideVisionFlaggedIfQualifies(already.db, 'e', 'p1')).toBe(false);
    expect(already.updates).toEqual([]);
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
      { status: 'hidden', visionFlag: 'violence' }, // our own hide write re-firing
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

// --- client/functions parity: the confirm-time gate --------------------------
//
// The Vision hide is server-authoritative, but ONE client write can undo it.
// `confirmClaim` (src/data/admin.ts) publishes an admin_confirmed claim's
// 'pending' Proof by writing `status: 'active'`, and active Proofs sit OUTSIDE
// `qualifiesForVisionHide` — so confirming a Mark whose photo had already been
// safety-hidden would re-expose extreme/illegal media and this trigger would
// never hide it again. The client gates that publish on `visionHideStands`
// (src/data/moderation.ts), which MIRRORS this module's allowlist because the
// app and the Functions package are deliberately decoupled (the same shape as
// the last-call-copy mirror in tests/functions/lastcall-copy-parity.test.ts).
//
// A mirror without a parity test is how two predicates drift apart. These cases
// feed ONE verdict set to both sides and are intended to FAIL if either side
// changes alone.

describe('client/functions parity — the auto-hide allowlist (#133)', () => {
  it('exports the SAME verdict list on both sides', () => {
    expect([...clientAutoHideFlags]).toEqual([...AUTO_HIDE_VISION_FLAGS]);
  });

  it('agrees verdict-for-verdict on what counts as an auto-hide flag', () => {
    const verdicts: unknown[] = [
      'violence',
      'extreme',
      'racy',
      'adult',
      'spoof',
      'medical',
      'Violence',
      'EXTREME',
      ' violence',
      '',
      null,
      undefined,
      7,
      {},
      ['violence'],
    ];
    for (const verdict of verdicts) {
      expect(clientIsAutoHideVisionFlag(verdict)).toBe(isAutoHideVisionFlag(verdict));
    }
  });

  it('holds the client gate closed on exactly the states the trigger owns', () => {
    for (const verdict of ['violence', 'extreme', 'racy', 'adult', null]) {
      // 'flagged': the doc the trigger owns — the two predicates must agree.
      const flaggedDoc: VisionFlaggedDoc = { status: 'flagged', visionFlag: verdict };
      expect(visionHideStands('flagged', verdict)).toBe(qualifiesForVisionHide(flaggedDoc));
      // 'hidden': the doc the trigger already produced and now stands down on
      // (its loop guard) — precisely the one a confirm would re-expose, so the
      // client gate holds where the trigger cannot.
      expect(qualifiesForVisionHide({ status: 'hidden', visionFlag: verdict })).toBe(false);
      expect(visionHideStands('hidden', verdict)).toBe(isAutoHideVisionFlag(verdict));
      // Everything the trigger never owned publishes exactly as it always did.
      expect(visionHideStands('pending', verdict)).toBe(false);
      expect(visionHideStands('active', verdict)).toBe(false);
    }
  });
});
