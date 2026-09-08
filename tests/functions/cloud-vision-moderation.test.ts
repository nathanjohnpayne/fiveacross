import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_HIDE_VISION_FLAGS,
  PROOF_SCANS_COLLECTION,
  SAFETY_HIDE_MARKER,
  applyPendingVisionScan,
  awaitsPendingVisionScan,
  isAutoHideVisionFlag,
  proofScanPath,
  qualifiesForVisionHide,
  visionHideAction,
  hideVisionFlaggedIfQualifies,
  applyVisionFlagHide,
  writeVisionVerdict,
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
 * records every write in call order. Mirrors the fake in
 * tests/functions/w4-server-authoritative-hide.test.ts, plus the `set`/`delete`
 * the #1143 scanner hand-off needs — `ops` is what lets a case prove the
 * scanner CREATED nothing, rather than merely that the Proof looks unchanged.
 */
function fakeDb(store: Record<string, Record<string, unknown> | undefined>) {
  const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
  const ops: Array<{ op: 'get' | 'update' | 'set' | 'delete'; path: string; data?: Record<string, unknown> }> = [];
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
        set: (r: { __path: string }, d: Record<string, unknown>) => void;
        delete: (r: { __path: string }) => void;
      }) => Promise<T>,
    ) =>
      fn({
        get: async (r) => {
          ops.push({ op: 'get', path: r.__path });
          return snapFor(r.__path);
        },
        update: (r, d) => {
          store[r.__path] = { ...(store[r.__path] ?? {}), ...d };
          updates.push({ path: r.__path, data: d });
          ops.push({ op: 'update', path: r.__path, data: d });
        },
        set: (r, d) => {
          store[r.__path] = { ...d };
          ops.push({ op: 'set', path: r.__path, data: d });
        },
        delete: (r) => {
          delete store[r.__path];
          ops.push({ op: 'delete', path: r.__path });
        },
      }),
  };
  return { db: db as unknown as AdminFirestore, updates, ops, store };
}

/**
 * A prior snapshot that makes a write an UPDATE rather than the Proof's own
 * create — the shape every case below wants unless it is deliberately exercising
 * the create-time scanner hand-off (#1143).
 */
const PRIOR: VisionFlaggedDoc = { status: 'active', visionFlag: null };

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
      await applyVisionFlagHide('e', 'p1', PRIOR, { status: 'hidden', visionFlag: 'violence' }, { hideIfQualifies: hide }),
    ).toBe(true);
    expect(hide).toHaveBeenCalledWith('e', 'p1');
  });
});

// --- the re-hide arm: an active Proof whose marker still stands ---------------
//
// Codex P1 on #1143. Both client-side gates ship in the SAME bundle, and a bundle
// is cached: an admin tab opened before this work landed still runs the old
// unconditional `confirmClaim` publish, or the old `restoreProof` that wrote no
// marker, either of which leaves `status: 'active'` with `safetyHide: true`. The
// read rule exposes active Proofs to every Player, and the hide arm sees
// 'active', not 'flagged', so it would stand down forever — extreme/illegal media
// back in the Feed with no server-side path to take it down. The marker is
// server-owned and every legitimate lift clears it in the same write as the
// status, so that combination is diagnostic of a stale client and of nothing
// else.

describe('the re-hide arm — a standing marker outranks an active status (#1143)', () => {
  const PROOF = 'events/e/proofs/p1';

  it('names the re-hide on the marker alone, and only where the status exposes media', () => {
    expect(visionHideAction({ status: 'active', safetyHide: true })).toBe('rehide');
    // No verdict test: the marker is the server's own record, and a lift records
    // itself in the same write it lifts with, so there is nothing to re-derive.
    expect(visionHideAction({ status: 'active', safetyHide: true, visionFlag: 'gore' })).toBe('rehide');
    expect(visionHideAction({ status: 'active', safetyHide: true, visionFlag: null })).toBe('rehide');
    // The warned Restore's explicit `false`, and a Proof this trigger never
    // touched, are both left exactly where the admin (or nobody) put them.
    expect(visionHideAction({ status: 'active', safetyHide: false, visionFlag: 'violence' })).toBe(null);
    expect(visionHideAction({ status: 'active', visionFlag: 'violence' })).toBe(null);
    // Only a literal `true` counts — a truthy value is not the server's record.
    for (const marker of [1, 'true', {}, []]) {
      expect(visionHideAction({ status: 'active', safetyHide: marker as never })).toBe(null);
    }
    // 'pending' is admin-only readable, and is where the claim-aware Restore
    // deliberately parks an undecided Proof: nothing to re-hide, nobody exposed.
    expect(visionHideAction({ status: 'pending', safetyHide: true })).toBe(null);
  });

  it('re-hides the stale-client publish, KEEPING the marker the hold is recorded in', async () => {
    // The exact doc an old confirmClaim leaves behind: published, still marked.
    const { db, updates, store } = fakeDb({
      [PROOF]: { status: 'active', safetyHide: true, visionFlag: 'violence' },
    });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(true);
    expect(updates).toEqual([{ path: PROOF, data: { status: 'hidden' } }]);
    expect(store[PROOF]).toEqual({ status: 'hidden', safetyHide: true, visionFlag: 'violence' });
    // And the doc it produces is one the current client's own gate holds, so the
    // two agree again rather than fighting.
    expect(safetyHideStands(store[PROOF] as { status?: string; safetyHide?: boolean })).toBe(true);
  });

  it('leaves the warned Restore alone — the lift writes `false` in the same update', async () => {
    const { db, updates, store } = fakeDb({
      [PROOF]: { status: 'active', safetyHide: false, visionFlag: 'violence' },
    });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toEqual([]);
    expect(store[PROOF]).toMatchObject({ status: 'active', safetyHide: false });
  });

  it('leaves an active Proof with no marker alone — this path never wrote one', async () => {
    const { db, updates } = fakeDb({ [PROOF]: { status: 'active', visionFlag: 'violence' } });
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toEqual([]);
  });

  it('does not loop: the re-hidden doc matches no arm on the write it re-fires', async () => {
    const { db, updates } = fakeDb({ [PROOF]: { status: 'active', safetyHide: true, visionFlag: 'violence' } });
    await hideVisionFlaggedIfQualifies(db, 'e', 'p1');
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it('reaches Firestore for the stale-client snapshot, and stands down on the honest ones', async () => {
    const hide = vi.fn(async () => true);
    expect(
      await applyVisionFlagHide('e', 'p1', PRIOR, { status: 'active', safetyHide: true }, { hideIfQualifies: hide }),
    ).toBe(true);
    expect(hide).toHaveBeenCalledWith('e', 'p1');
    hide.mockClear();
    for (const after of [
      { status: 'active', safetyHide: false, visionFlag: 'violence' }, // the Restore
      { status: 'active', visionFlag: 'violence' }, // a pre-marker Restore, already lifted
      { status: 'pending', safetyHide: true }, // held for claim review, admin-only
    ] satisfies VisionFlaggedDoc[]) {
      expect(await applyVisionFlagHide('e', 'p1', PRIOR, after, { hideIfQualifies: hide })).toBe(false);
    }
    expect(hide).not.toHaveBeenCalled();
  });
});

// --- the upload-before-document race: the scanner never creates the Proof ----
//
// Codex P1 on #1143. `moderateProof` is a STORAGE trigger and `attachProof`
// (src/data/proofs.ts) uploads the media BEFORE the transaction that writes the
// Proof document, so a fast scan can reach a verdict with no document to put it
// on. The scanner used to close that gap by merge-setting the verdict, which
// CREATES the Proof — and the created doc broke the submission still on its way:
// an ordinary Player's `attachProof` create becomes a rules-denied UPDATE (a
// non-admin is bounded to `reportCount`), so the submission fails outright, while
// an admin uploader's full `set` is ALLOWED and overwrites `status`, `visionFlag`
// and `safetyHide` back to `'active'`, `null` and absent — a doc no arm of
// `visionHideAction` claims, so extreme media stays in the Feed with no
// server-side path left to take it down.
//
// The Proof document now has exactly ONE creator, `attachProof`. A verdict that
// arrives first is parked in the server-only `proofScans` collection and applied
// on the Proof's own create, through the same arms as every other hide.

describe('writeVisionVerdict — the scanner records a verdict, never a Proof (#1143)', () => {
  const PROOF = 'events/e/proofs/p1';
  const SCAN = 'events/e/proofScans/p1';

  it('names the server-only hand-off path both sides agree on', () => {
    expect(PROOF_SCANS_COLLECTION).toBe('proofScans');
    expect(proofScanPath('e', 'p1')).toBe(SCAN);
  });

  it('writes the verdict straight onto a Proof that already exists — the ordinary path', async () => {
    const { db, updates, ops, store } = fakeDb({
      [PROOF]: { uid: 'u1', status: 'active', visionFlag: null, reportCount: 0 },
    });
    expect(await writeVisionVerdict(db, 'e', 'p1', 'violence', 5)).toBe('proof');
    expect(updates).toEqual([{ path: PROOF, data: { status: 'flagged', visionFlag: 'violence' } }]);
    expect(store[PROOF]).toEqual({ uid: 'u1', status: 'flagged', visionFlag: 'violence', reportCount: 0 });
    // No hand-off record when there is nothing to hand off to.
    expect(store[SCAN]).toBeUndefined();
    expect(ops.filter((o) => o.op === 'set')).toEqual([]);
  });

  it('parks the verdict instead of CREATING the Proof when the upload beat the document', async () => {
    const { db, ops, store } = fakeDb({});
    expect(await writeVisionVerdict(db, 'e', 'p1', 'extreme', 5)).toBe('scan');
    // The whole finding, as one assertion: nothing was written to the Proof path,
    // so the Player's still-in-flight create is still a create.
    expect(store[PROOF]).toBeUndefined();
    expect(ops.filter((o) => o.path === PROOF).map((o) => o.op)).toEqual(['get']);
    expect(store[SCAN]).toEqual({ visionFlag: 'extreme', scannedAt: 5 });
  });

  it('uses update, never a re-creating set, so a Proof deleted since the upload stays deleted', async () => {
    // The same promise `hideVisionFlaggedIfQualifies` makes: a two-field ghost
    // Proof is worse than no Proof, and the parked record is the deleted case's
    // answer too — it waits for a create that never comes rather than inventing one.
    const { db, ops } = fakeDb({});
    await writeVisionVerdict(db, 'e', 'p1', 'violence', 5);
    expect(ops.some((o) => o.op === 'update' && o.path === PROOF)).toBe(false);
    expect(ops.some((o) => o.op === 'set' && o.path === PROOF)).toBe(false);
  });
});

describe('applyPendingVisionScan — the parked verdict lands when the Proof appears (#1143)', () => {
  const PROOF = 'events/e/proofs/p1';
  const SCAN = 'events/e/proofScans/p1';
  const created = () => ({ uid: 'u1', status: 'active', visionFlag: null, reportCount: 0 });

  it('flags the freshly created Proof with the parked verdict and CONSUMES the record', async () => {
    const { db, updates, store } = fakeDb({
      [PROOF]: created(),
      [SCAN]: { visionFlag: 'violence', scannedAt: 5 },
    });
    expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(true);
    expect(updates).toEqual([{ path: PROOF, data: { status: 'flagged', visionFlag: 'violence' } }]);
    // Exactly the doc the producer's own write would have left, so the hide is
    // decided where every hide is decided — and the hand-off is gone, so no later
    // write can re-flag a Proof an admin has since acted on.
    expect(store[PROOF]).toEqual({ uid: 'u1', status: 'flagged', visionFlag: 'violence', reportCount: 0 });
    expect(store[SCAN]).toBeUndefined();
  });

  it('hands the flagged doc to the ordinary hide arm — flag, then hide, then mark', async () => {
    const { db, updates, store } = fakeDb({
      [PROOF]: created(),
      [SCAN]: { visionFlag: 'violence', scannedAt: 5 },
    });
    await applyPendingVisionScan(db, 'e', 'p1');
    expect(visionHideAction(store[PROOF] as VisionFlaggedDoc)).toBe('hide');
    expect(await hideVisionFlaggedIfQualifies(db, 'e', 'p1')).toBe(true);
    expect(store[PROOF]).toEqual({
      uid: 'u1', status: 'hidden', safetyHide: true, visionFlag: 'violence', reportCount: 0,
    });
    expect(updates.map((u) => u.data)).toEqual([
      { status: 'flagged', visionFlag: 'violence' },
      { status: 'hidden', safetyHide: true },
    ]);
    // And the doc it produces is one the client's confirm-time gate holds.
    expect(safetyHideStands(store[PROOF] as { status?: string; safetyHide?: boolean })).toBe(true);
  });

  it('applies whatever the PRODUCER flagged — the allowlist decides hiding, not flagging', async () => {
    // A verdict outside AUTO_HIDE_VISION_FLAGS still reaches admins as a
    // 'flagged' doc and is hidden by nobody, exactly as a scan that had won the
    // race would leave it. The race must not become a second, laxer policy.
    const { db, store } = fakeDb({ [PROOF]: created(), [SCAN]: { visionFlag: 'racy', scannedAt: 5 } });
    expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(true);
    expect(store[PROOF]).toMatchObject({ status: 'flagged', visionFlag: 'racy' });
    expect(visionHideAction(store[PROOF] as VisionFlaggedDoc)).toBe(null);
  });

  it('writes nothing when no verdict is parked — the overwhelmingly common create', async () => {
    const { db, ops, store } = fakeDb({ [PROOF]: created() });
    expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(false);
    expect(store[PROOF]).toEqual(created());
    // One read, and it is the cheap one: the absent record short-circuits before
    // the Proof is read at all.
    expect(ops).toEqual([{ op: 'get', path: SCAN }]);
  });

  it('never CREATES the Proof either — a record whose Proof is missing simply waits', async () => {
    const { db, ops, store } = fakeDb({ [SCAN]: { visionFlag: 'violence', scannedAt: 5 } });
    expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(false);
    expect(store[PROOF]).toBeUndefined();
    expect(store[SCAN]).toEqual({ visionFlag: 'violence', scannedAt: 5 }); // kept for the create to come
    expect(ops.every((o) => o.op === 'get')).toBe(true);
  });

  it('drops a malformed record rather than writing it onto the Proof', async () => {
    for (const visionFlag of [null, '', 7, { flag: 'violence' }]) {
      const { db, updates, store } = fakeDb({ [PROOF]: created(), [SCAN]: { visionFlag, scannedAt: 5 } });
      expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(false);
      expect(updates).toEqual([]);
      expect(store[PROOF]).toEqual(created());
      expect(store[SCAN]).toBeUndefined();
    }
  });

  it('is exactly-once: a redelivered trigger finds the record consumed and writes nothing', async () => {
    const { db, updates, store } = fakeDb({
      [PROOF]: created(),
      [SCAN]: { visionFlag: 'violence', scannedAt: 5 },
    });
    await applyPendingVisionScan(db, 'e', 'p1');
    // An admin lifts the flag before the duplicate delivery arrives.
    store[PROOF] = { ...(store[PROOF] as Record<string, unknown>), status: 'active', visionFlag: null };
    expect(await applyPendingVisionScan(db, 'e', 'p1')).toBe(false);
    expect(updates).toHaveLength(1);
    expect(store[PROOF]).toMatchObject({ status: 'active', visionFlag: null });
  });
});

describe('awaitsPendingVisionScan — the create is the only write that looks (#1143)', () => {
  it('is true for the Proof create attachProof writes, and nothing else', () => {
    expect(awaitsPendingVisionScan(undefined, { status: 'active', visionFlag: null })).toBe(true);
    expect(awaitsPendingVisionScan(undefined, { status: 'pending', visionFlag: null })).toBe(true);
    expect(awaitsPendingVisionScan(undefined, { status: 'active' })).toBe(true);
  });

  it('is false for every write that is not a create, so no read is added to them', () => {
    // A report bump, an admin hide, an admin Restore, a claim confirm, and this
    // trigger's own writes re-firing — the pre-#1143 cost, unchanged.
    expect(awaitsPendingVisionScan({ status: 'active', reportCount: 0 } as VisionFlaggedDoc, { status: 'active' })).toBe(false);
    expect(awaitsPendingVisionScan(PRIOR, { status: 'hidden' })).toBe(false);
    expect(awaitsPendingVisionScan(PRIOR, { status: 'active', safetyHide: false })).toBe(false);
    expect(awaitsPendingVisionScan(PRIOR, undefined)).toBe(false); // a delete
    expect(awaitsPendingVisionScan(undefined, undefined)).toBe(false); // no event data at all
  });

  it('is false for a create that already carries a verdict — it cannot be waiting for one', () => {
    // Unreachable through the rules (`visionFlag == null` at create), but the
    // gate states it rather than assuming it.
    expect(awaitsPendingVisionScan(undefined, { status: 'flagged', visionFlag: 'violence' })).toBe(false);
  });
});

describe('applyVisionFlagHide — the create-time hand-off (#1143)', () => {
  it('consults the hand-off on the Proof create, and returns without hiding in the same write', async () => {
    const applyPendingScan = vi.fn(async () => true);
    const hide = vi.fn(async () => true);
    expect(
      await applyVisionFlagHide('e', 'p1', undefined, { status: 'active', visionFlag: null }, {
        applyPendingScan,
        hideIfQualifies: hide,
      }),
    ).toBe(true);
    expect(applyPendingScan).toHaveBeenCalledWith('e', 'p1');
    // The flag write re-fires the trigger; the hide happens there, through the
    // hide arm, so `visionHideAction` stays the only place a status moves.
    expect(hide).not.toHaveBeenCalled();
  });

  it('judges an ordinary create exactly as before when nothing is parked', async () => {
    const applyPendingScan = vi.fn(async () => false);
    const hide = vi.fn(async () => true);
    expect(
      await applyVisionFlagHide('e', 'p1', undefined, { status: 'active', visionFlag: null }, {
        applyPendingScan,
        hideIfQualifies: hide,
      }),
    ).toBe(false);
    expect(applyPendingScan).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
  });

  it('adds NO lookup to any write that is not a create — the cost model is unchanged', async () => {
    const applyPendingScan = vi.fn(async () => true);
    const hide = vi.fn(async () => true);
    for (const [before, after] of [
      [PRIOR, { status: 'active', visionFlag: null }], // a report bump
      [PRIOR, { status: 'flagged', visionFlag: 'violence' }], // the scanner's own write
      [{ status: 'flagged', visionFlag: 'violence' }, { status: 'hidden', safetyHide: true, visionFlag: 'violence' }], // ours, re-firing
      [PRIOR, undefined], // a delete
    ] satisfies Array<[VisionFlaggedDoc | undefined, VisionFlaggedDoc | undefined]>) {
      await applyVisionFlagHide('e', 'p1', before, after, { applyPendingScan, hideIfQualifies: hide });
    }
    expect(applyPendingScan).not.toHaveBeenCalled();
  });

  it('swallows a failing hand-off, so a scan race never crashes the proof pipeline', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => {
      throw new Error('transaction failed');
    });
    await expect(
      applyVisionFlagHide('e', 'p1', undefined, { status: 'active', visionFlag: null }, { applyPendingScan: boom }),
    ).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('drives the whole race end to end: verdict first, Proof second, media hidden', async () => {
    const PROOF = 'events/e/proofs/p1';
    const { db, store } = fakeDb({});
    // 1. The upload finalizes and the scan lands before attachProof commits.
    expect(await writeVisionVerdict(db, 'e', 'p1', 'violence', 5)).toBe('scan');
    // 2. attachProof's create then succeeds as a CREATE — the Proof path is
    //    untouched, so the rules judge it as one and the submission goes through.
    expect(store[PROOF]).toBeUndefined();
    store[PROOF] = { uid: 'u1', status: 'active', visionFlag: null, reportCount: 0 };
    // 3. The create fires the trigger, which consumes the parked verdict...
    const deps = {
      applyPendingScan: (e: string, p: string) => applyPendingVisionScan(db, e, p),
      hideIfQualifies: (e: string, p: string) => hideVisionFlaggedIfQualifies(db, e, p),
    };
    expect(await applyVisionFlagHide('e', 'p1', undefined, store[PROOF] as VisionFlaggedDoc, deps)).toBe(true);
    // 4. ...and the flag write re-fires it, where the hide arm takes over.
    expect(
      await applyVisionFlagHide('e', 'p1', { status: 'active' }, store[PROOF] as VisionFlaggedDoc, deps),
    ).toBe(true);
    expect(store[PROOF]).toEqual({
      uid: 'u1', status: 'hidden', safetyHide: true, visionFlag: 'violence', reportCount: 0,
    });
    expect(store[proofScanPath('e', 'p1')]).toBeUndefined();
    // 5. And it settles: the next write matches no arm.
    expect(
      await applyVisionFlagHide('e', 'p1', { status: 'flagged' }, store[PROOF] as VisionFlaggedDoc, deps),
    ).toBe(false);
  });
});

describe('applyVisionFlagHide — the best-effort trigger body', () => {
  const flagged = (visionFlag: string | null): VisionFlaggedDoc => ({ status: 'flagged', visionFlag });

  it('hides on the scanner write (status flagged + extreme verdict)', async () => {
    const hide = vi.fn(async () => true);
    expect(await applyVisionFlagHide('e', 'p1', PRIOR, flagged('violence'), { hideIfQualifies: hide })).toBe(true);
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
      expect(await applyVisionFlagHide('e', 'p1', PRIOR, after, { hideIfQualifies: hide })).toBe(false);
    }
    expect(hide).not.toHaveBeenCalled();
  });

  it('never throws — a failing write is swallowed so the proof pipeline is untouched (ADR 0001)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => {
      throw new Error('transaction failed');
    });
    await expect(applyVisionFlagHide('e', 'p1', PRIOR, flagged('violence'), { hideIfQualifies: boom })).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('retries on a later write that leaves the Proof flagged — a swallowed first attempt is not terminal', async () => {
    // The state predicate (not a transition one) is what makes this possible: a
    // report bump on a still-flagged Proof re-attempts the hide the earlier
    // best-effort failure never landed.
    const hide = vi.fn(async () => true);
    await applyVisionFlagHide('e', 'p1', PRIOR, flagged('violence'), { hideIfQualifies: hide }); // first attempt
    expect(await applyVisionFlagHide('e', 'p1', PRIOR, flagged('violence'), { hideIfQualifies: hide })).toBe(true);
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
      await applyVisionFlagHide('e', 'p1', PRIOR, { status: 'active', visionFlag: 'violence' }, {
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

