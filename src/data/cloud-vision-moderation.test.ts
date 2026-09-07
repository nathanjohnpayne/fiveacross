import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cell, ClaimDoc, ProofDoc } from '../types';

// specs/cloud-vision-moderation.md, data layer (fake Firestore, no emulator).
// The claim-confirm half of the Vision auto-hide: `confirmClaim` publishes an
// admin_confirmed claim's 'pending' Proof by writing `status: 'active'`, and
// active Proofs are OUTSIDE `qualifiesForVisionHide` — so an unconditional
// publish would put extreme/illegal media back in front of every Player and the
// `hideProofOnVisionFlag` trigger would never hide it again. Cloud Vision scans
// the uploaded object, so this is not a corner case: a photo is routinely
// flagged and hidden BEFORE its claim reaches the queue.
//
// The Confirm control shows only the submitter and the Prompt, so it is not the
// warned, explicit moderation Restore (the one place an admin may override an AI
// verdict). These cases pin the split: the CLAIM still resolves and the Mark is
// still confirmed; only the media stays hidden.
//
// The gate is `safetyHideStands` (./moderation), and it reads ONLY facts the
// server writes: `hideProofOnVisionFlag`'s `safetyHide` marker, and the
// `'flagged'` status no client may set. It holds no allowlist of its own (Codex
// P1 round 2) — Functions and this bundle deploy separately, so a client that
// re-derived the verdict would publish a Proof hidden for a verdict its cached
// copy of the list had never heard of.

type Ref = { __kind: 'doc' | 'collection'; id?: string; path: string };
type Snap = { data: () => unknown; exists: () => boolean };

const { txGet, txSet, txDelete, runTx, ops } = vi.hoisted(() => ({
  txGet: vi.fn(),
  txSet: vi.fn(),
  txDelete: vi.fn(),
  runTx: vi.fn(),
  // Every transaction operation in call order, so the Firestore
  // reads-before-writes contract is assertable rather than assumed.
  ops: [] as Array<{ op: 'get' | 'set' | 'delete'; path: string }>,
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('./markAnalytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./markAnalytics')>()),
  directMarkAnalyticsRequest: vi.fn(() => ({ id: 'req-1' })),
}));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    collection: (_db: unknown, ...segments: string[]): Ref => ({
      __kind: 'collection',
      path: segments.join('/'),
    }),
    doc: (_a: unknown, ...rest: string[]): Ref => ({
      __kind: 'doc',
      id: rest[rest.length - 1],
      path: rest.join('/'),
    }),
    runTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => runTx(_db, fn),
    getDoc: vi.fn(() => Promise.resolve({ data: () => ({}) })),
    getDocFromCache: vi.fn(() => Promise.reject(new Error('no cache in this test double'))),
    writeBatch: () => ({ set: vi.fn(), commit: () => Promise.resolve() }),
    increment: (n: number) => ({ __inc: n }),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    setDoc: vi.fn(),
  };
});

import { confirmClaim, rejectClaim } from './admin';
import { safetyHideStands } from './moderation';

/** A dealt board whose Square 4 is the pending claim backed by proof `P`. */
function boardWithPendingClaim(): Cell[] {
  const cells: Cell[] = Array.from({ length: 25 }, (_, index) => ({
    index,
    itemId: index === 12 ? null : `i${index}`,
    text: index === 12 ? 'FREE' : `p${index}`,
    free: index === 12,
    marked: index === 12,
    markedAt: null,
  }));
  cells[4] = { ...cells[4], marked: true, markedAt: 9, proofId: 'P', status: 'pending' };
  return cells;
}

const pendingClaim = (over: Partial<ClaimDoc> = {}): ClaimDoc => ({
  id: 'claim-1',
  uid: 'u1',
  displayName: 'Deck Daddy',
  cellIndex: 4,
  itemText: 'Saw a sailor in Speedos',
  proofId: 'P',
  status: 'pending',
  createdAt: 1,
  resolvedBy: null,
  ...over,
});

/** The live Proof `tx.get` will return for `events/med-2026/proofs/P`. */
let liveProof: Partial<ProofDoc> | undefined;

function setPayload(frag: string): Record<string, unknown> | undefined {
  const call = txSet.mock.calls.find((c) => (c[0] as Ref).path.includes(frag));
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  ops.length = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  liveProof = undefined;
  runTx.mockImplementation((_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      get: (ref: Ref) => {
        ops.push({ op: 'get', path: ref.path });
        return txGet(ref);
      },
      set: (ref: Ref, ...rest: unknown[]) => {
        ops.push({ op: 'set', path: ref.path });
        return txSet(ref, ...rest);
      },
      delete: (ref: Ref) => {
        ops.push({ op: 'delete', path: ref.path });
        return txDelete(ref);
      },
    }),
  );
  txGet.mockImplementation((ref: Ref): Promise<Snap> => {
    if (ref.path.includes('/boards/')) {
      return Promise.resolve({ exists: () => true, data: () => ({ cells: boardWithPendingClaim() }) });
    }
    if (ref.path.includes('/players/')) {
      return Promise.resolve({ exists: () => true, data: () => ({ firstBingoAt: null }) });
    }
    if (ref.path === 'events/med-2026/proofs/P') {
      return Promise.resolve({ exists: () => !!liveProof, data: () => liveProof });
    }
    return Promise.resolve({ exists: () => false, data: () => undefined });
  });
});

describe('safetyHideStands — the SERVER-OWNED confirm-time gate (#133)', () => {
  it('stands on the marker the hide trigger stamps, and on a still-flagged Proof', () => {
    expect(safetyHideStands({ status: 'hidden', safetyHide: true })).toBe(true);
    expect(safetyHideStands({ status: 'flagged' })).toBe(true);
  });

  it('reads NO verdict: an unknown future verdict holds, a known one without the marker does not', () => {
    // The staggered-deploy case the mirror could not survive. A widened Functions
    // allowlist hides a Proof for a verdict this bundle has never heard of and
    // stamps the marker — and the gate holds, because the verdict is not an input.
    expect(safetyHideStands({ status: 'hidden', safetyHide: true, visionFlag: 'gore' } as never)).toBe(true);
    // The converse is the same fact: `violence` alone is not a safety hide. Only
    // the server's own record is.
    expect(safetyHideStands({ status: 'hidden', visionFlag: 'violence' } as never)).toBe(false);
  });

  it('never stands on a Proof the trigger does not own — pending, active, or missing', () => {
    // 'pending'/'active' are outside qualifiesForVisionHide, so there is no
    // server-authoritative hide to preserve; an absent doc has no state at all.
    expect(safetyHideStands({ status: 'pending' })).toBe(false);
    expect(safetyHideStands({ status: 'active' })).toBe(false);
    expect(safetyHideStands(undefined)).toBe(false);
  });

  it('never stands once an admin Restored — the explicit lift clears the marker', () => {
    expect(safetyHideStands({ status: 'active', safetyHide: false })).toBe(false);
  });

  it('is not fooled by a non-boolean marker value — only a literal `true` holds', () => {
    for (const marker of [1, 'true', {}, [], null, undefined]) {
      expect(safetyHideStands({ status: 'hidden', safetyHide: marker as never })).toBe(false);
    }
  });
});

describe('confirmClaim — a Vision safety hide survives the claim confirm (specs/cloud-vision-moderation.md)', () => {
  it('leaves a MARKED Proof hidden: no proof write at all, while the Mark is confirmed', async () => {
    liveProof = { status: 'hidden', safetyHide: true, visionFlag: 'violence' };

    await confirmClaim(pendingClaim(), 'admin-1');

    // Nothing is written to the Proof — no `status: 'active'`, so the media stays
    // out of the Feed and the trigger's own state is untouched.
    expect(setPayload('/proofs/')).toBeUndefined();
    // The claim still resolves and the Square still credits: only the media is held.
    expect(setPayload('/claims/')).toMatchObject({ status: 'confirmed', resolvedBy: 'admin-1' });
    const board = setPayload('/boards/') as { cells: Cell[] };
    expect(board.cells[4]).toMatchObject({ status: 'confirmed', markedAt: 1000 });
    expect(setPayload('/players/')).toMatchObject({ squaresMarked: 1 });
  });

  it('leaves a FLAGGED Vision-flagged Proof flagged, so the pending hide still lands', async () => {
    // The window between moderateProof's flag write and hideProofOnVisionFlag's
    // hide (or a swallowed best-effort failure it will retry). Publishing here
    // would move the doc out of 'flagged' and the retry could never fire.
    liveProof = { status: 'flagged', visionFlag: 'extreme' };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toBeUndefined();
    expect(setPayload('/claims/')).toMatchObject({ status: 'confirmed' });
  });

  it('publishes a genuinely PENDING Proof with no verdict — the ordinary confirm is unchanged', async () => {
    liveProof = { status: 'pending', visionFlag: null };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
  });

  it('publishes a Proof whose verdict is outside the allowlist — nothing withholds for raciness', async () => {
    // ADR 0004 in the confirm path: a racy verdict is a reason on the queue row,
    // never a hide, so nothing marks it and the claim's photo publishes exactly
    // as it always did.
    liveProof = { status: 'pending', visionFlag: 'racy' };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
  });

  it('holds an UNKNOWN future verdict the server hid — the gate never reads the verdict', async () => {
    // The whole reason the client mirror is gone (Codex P1 round 2). A widened
    // Functions allowlist hides a Proof for a verdict this bundle has never heard
    // of; the marker is what this code reads, so the hold survives the skew.
    liveProof = { status: 'hidden', safetyHide: true, visionFlag: 'gore' };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toBeUndefined();
    expect(setPayload('/claims/')).toMatchObject({ status: 'confirmed' });
  });

  it('publishes a plain hidden Proof carrying NO marker — a report or manual hide is confirm\'s to lift', async () => {
    // The counterpart fact: an extreme verdict alone is not a safety hide. This
    // doc was hidden by the #43 threshold or an admin's own Hide, each with its
    // own console lift, and confirm's behaviour toward them is unchanged.
    liveProof = { status: 'hidden', visionFlag: 'violence' };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
  });

  it('publishes a Proof an admin already Restored, so the override is not re-applied', async () => {
    // restoreProof clears the marker and leaves `visionFlag` set as the audit
    // record of the override, so the confirm publishes.
    liveProof = { status: 'active', safetyHide: false, visionFlag: 'violence' };

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
  });

  it('reads the Proof LIVE and BEFORE any write, so a stale console cannot beat the scan', async () => {
    // The admin's queue may have opened before moderateProof ran. The gate reads
    // the doc inside the transaction, and Firestore requires every read to
    // precede every write, so the read must sit ahead of the first tx.set.
    liveProof = { status: 'hidden', safetyHide: true, visionFlag: 'violence' };

    await confirmClaim(pendingClaim(), 'admin-1');

    const proofGet = ops.findIndex((o) => o.op === 'get' && o.path === 'events/med-2026/proofs/P');
    const firstWrite = ops.findIndex((o) => o.op !== 'get');
    expect(proofGet).toBeGreaterThanOrEqual(0);
    expect(proofGet).toBeLessThan(firstWrite);
  });

  it('keeps the pre-#133 write when the Proof snapshot is missing', async () => {
    // A deleted/absent Proof has no Vision state to preserve; the publish write
    // is left exactly as it was rather than silently changing on this path.
    liveProof = undefined;

    await confirmClaim(pendingClaim(), 'admin-1');

    expect(setPayload('/proofs/')).toMatchObject({ status: 'active' });
  });

  it('never reads the Proof on a REJECT — a rejected claim publishes nothing either way', async () => {
    liveProof = { status: 'hidden', safetyHide: true, visionFlag: 'violence' };

    await rejectClaim(pendingClaim(), 'admin-1');

    expect(ops.some((o) => o.path === 'events/med-2026/proofs/P')).toBe(false);
    expect(setPayload('/proofs/')).toBeUndefined();
    expect(setPayload('/claims/')).toMatchObject({ status: 'rejected' });
  });

  it('never reads the Proof for a legacy claim carrying no proofId', async () => {
    await confirmClaim(pendingClaim({ proofId: null }), 'admin-1');

    expect(ops.some((o) => o.path.includes('/proofs/'))).toBe(false);
  });
});
