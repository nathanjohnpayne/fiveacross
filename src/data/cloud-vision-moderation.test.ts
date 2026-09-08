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

const { txGet, txSet, txUpdate, txDelete, runTx, getDocMock, getDocsMock, ops } = vi.hoisted(() => ({
  txGet: vi.fn(),
  txSet: vi.fn(),
  txUpdate: vi.fn(),
  txDelete: vi.fn(),
  runTx: vi.fn(),
  getDocMock: vi.fn(),
  getDocsMock: vi.fn(),
  // Every transaction operation in call order, so the Firestore
  // reads-before-writes contract is assertable rather than assumed.
  ops: [] as Array<{ op: 'get' | 'set' | 'update' | 'delete'; path: string }>,
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026', storage: {} }));
// attachProof (below, the #1143 create-shape pin) uploads media before its
// transaction; stub the two Storage calls proofs.ts uses so nothing here touches
// a bucket. uploadProofMedia itself is exercised for real against the emulator by
// tests/rules/w0-storage-rules.test.ts.
vi.mock('./storage', () => ({
  uploadProofMedia: vi.fn(async (uid: string, proofId: string) => ({
    path: `proofs/med-2026/${uid}/${proofId}.jpg`,
    url: `https://firebasestorage.googleapis.com/v0/b/b/o/proofs%2Fmed-2026%2F${uid}%2F${proofId}.jpg?alt=media`,
  })),
  deleteStoragePath: vi.fn(),
}));
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
    doc: (a: unknown, ...rest: string[]): Ref => {
      // doc(collectionRef) — the auto-id child ref attachProof mints for the
      // Proof (and its claim) before it writes anything.
      if (a && (a as Ref).__kind === 'collection' && rest.length === 0) {
        const col = (a as Ref).path;
        const id = `auto-${col.split('/').pop()}`;
        return { __kind: 'doc', id, path: `${col}/${id}` };
      }
      return { __kind: 'doc', id: rest[rest.length - 1], path: rest.join('/') };
    },
    runTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => runTx(_db, fn),
    // The claims-by-proofId lookup restoreProof runs BEFORE its transaction (the
    // web SDK's Transaction.get takes a DocumentReference, never a query).
    query: (ref: Ref, ...constraints: unknown[]) => ({ __kind: 'query', ref, constraints }),
    where: (field: string, op: string, value: unknown) => ({ field, op, value }),
    // Faked so the double can APPLY the cap rather than merely observe it: the
    // point of the owner-scoped lookup is which docs survive the page.
    limit: (count: number) => ({ __kind: 'limit', count }),
    getDocs: (...a: unknown[]) => getDocsMock(...a),
    getDoc: (...a: unknown[]) => getDocMock(...a),
    getDocFromCache: vi.fn(() => Promise.reject(new Error('no cache in this test double'))),
    writeBatch: () => ({ set: vi.fn(), commit: () => Promise.resolve() }),
    increment: (n: number) => ({ __inc: n }),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    setDoc: vi.fn(),
  };
});

import { confirmClaim, hideProof, rejectClaim, restoreProof } from './admin';
import { safetyHideStands } from './moderation';
import { attachProof } from './proofs';

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

/**
 * The claims the `where('proofId','==',…)` lookup finds, and the LIVE state each
 * one has by the time the transaction re-reads it. Two separate things on
 * purpose: `restoreProof` discovers candidates outside the transaction and
 * decides inside it, so a claim resolved in that gap must read as resolved.
 */
let claimsForProof: Array<{ id: string; live: Partial<ClaimDoc> | undefined }> = [];

function setPayload(frag: string): Record<string, unknown> | undefined {
  const call = txSet.mock.calls.find((c) => (c[0] as Ref).path.includes(frag));
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

function updatePayload(frag: string): Record<string, unknown> | undefined {
  const call = txUpdate.mock.calls.find((c) => (c[0] as Ref).path.includes(frag));
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  ops.length = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  liveProof = undefined;
  claimsForProof = [];
  // The Proof read `restoreProof` runs before its transaction, to scope the
  // claims lookup to the owner. Everything else keeps the inert default.
  getDocMock.mockImplementation((ref: Ref) =>
    Promise.resolve(
      ref.path === 'events/med-2026/proofs/P'
        ? { exists: () => !!liveProof, data: () => liveProof }
        : { exists: () => true, data: () => ({}) },
    ),
  );
  // A real-enough query: the equality filters select, and the `limit` bounds the
  // page — in that order, exactly as Firestore does, so a test can prove that
  // forged docs cannot occupy the page the owner's claim needs to be on.
  getDocsMock.mockImplementation((q: { constraints?: unknown[] }) => {
    const constraints = (q?.constraints ?? []) as Array<{
      field?: string;
      op?: string;
      value?: unknown;
      __kind?: string;
      count?: number;
    }>;
    const equalities = constraints.filter((c) => c.op === '==');
    const cap = constraints.find((c) => c.__kind === 'limit')?.count;
    const selected = claimsForProof.filter(
      ({ live }) =>
        // A claim deleted between the lookup and the re-read was still returned
        // by the lookup, so an absent LIVE state is not an absent match.
        live === undefined ||
        equalities.every((c) => (live as Record<string, unknown>)[c.field as string] === c.value),
    );
    return Promise.resolve({
      docs: (cap === undefined ? selected : selected.slice(0, cap)).map(({ id }) => ({ id })),
    });
  });
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
      update: (ref: Ref, ...rest: unknown[]) => {
        ops.push({ op: 'update', path: ref.path });
        return txUpdate(ref, ...rest);
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
    if (ref.path.includes('/claims/')) {
      const match = claimsForProof.find((c) => ref.path.endsWith(`/claims/${c.id}`));
      return Promise.resolve({ exists: () => !!match?.live, data: () => match?.live });
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

// --- Restore returns the Proof to the state it came from ---------------------
//
// The console's Hide is offered on a 'flagged' row — the row renders the moment
// moderateProof writes the verdict, and hideProofOnVisionFlag is neither
// instantaneous nor guaranteed (best-effort; a failed write is swallowed and
// retried on the next write). An admin clicking Hide there AGREES with the AI
// screen. A bare `status: 'hidden'` would nonetheless move the doc out of the
// state the trigger's hide arm looks for while leaving no marker behind, and
// `safetyHideStands` reads that as a PLAIN hide — so a later Confirm would
// publish the media the admin had just taken down (Codex P1 on #1143).

describe('hideProof — an admin Hide preserves a standing safety hold (#1143)', () => {
  it('carries the hold onto the hidden doc when one stands on the Proof', async () => {
    liveProof = { status: 'flagged', visionFlag: 'violence' };

    await hideProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'hidden', safetyHide: true });
    // Which is the doc the confirm-time gate holds — the point of the write.
    expect(safetyHideStands({ status: 'hidden', safetyHide: true })).toBe(true);
  });

  it('stays byte-for-byte the write it always was on an ordinary moderation hide', async () => {
    // No hold: a plain reported Proof. Hiding it must not mint a safety hide an
    // admin never made — this one is liftable by Restore and publishable by a
    // confirm, exactly as before.
    liveProof = { status: 'active', reportCount: 4 };

    await hideProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'hidden' });
  });

  it('reads the LIVE doc, so a row that moved since it rendered is not misjudged', async () => {
    // The trigger may have hidden and marked the Proof already, or an admin at
    // another console may have Restored it. Both read live inside the transaction.
    liveProof = { status: 'active', safetyHide: false, visionFlag: 'violence' };

    await hideProof('P');

    expect(ops).toEqual([
      { op: 'get', path: 'events/med-2026/proofs/P' },
      { op: 'update', path: 'events/med-2026/proofs/P' },
    ]);
    expect(updatePayload('/proofs/')).toEqual({ status: 'hidden' }); // the lift is not re-applied
  });

  it('reads no verdict at all, so a stale bundle can only ever UNDER-stamp', async () => {
    // A verdict this build has never heard of still holds, because the gate reads
    // the server's own facts. And where the client does miss a hold, the trigger's
    // backfill arm stamps the marker on the hidden doc anyway
    // (functions/src/visionHide.ts § visionHideAction).
    liveProof = { status: 'flagged', visionFlag: 'gore' };

    await hideProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'hidden', safetyHide: true });
  });

  it('hides a Proof that is missing through the same failing update, not a silent no-op', async () => {
    liveProof = undefined;

    await hideProof('P');

    // `tx.update` on a doc that does not exist rejects at commit exactly as the
    // previous `updateDoc` did; the payload carries no invented marker.
    expect(updatePayload('/proofs/')).toEqual({ status: 'hidden' });
  });
});

// Restore is the one control that may override an AI verdict, and #133 gave it a
// warning that says so. It also has to say WHERE the photo goes. In
// admin_confirmed mode a Proof is created 'pending' and stays admin-only readable
// until its claim is confirmed, and Cloud Vision scans the uploaded object — so a
// photo whose claim nobody has judged can be flagged, hidden, and then Restored.
// Publishing it 'active' there would put it in every Player's Feed BEFORE the
// decision, and rejecting the claim afterwards would leave it public: rejectClaim
// deliberately writes nothing to the Proof, so nothing would take it back down.

describe('restoreProof — claim-aware (specs/cloud-vision-moderation.md)', () => {
  // The Proof's owner is `u1`; only u1's pending claim may steer the restore.
  beforeEach(() => {
    liveProof = { uid: 'u1', status: 'hidden', safetyHide: true, visionFlag: 'violence' };
  });

  it('restores to PENDING while a claim on the Proof is still undecided', async () => {
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'pending', safetyHide: false });
  });

  it('restores to ACTIVE when no claim references the Proof at all', async () => {
    // The honor / proof_required modes, and every Proof that never had a claim.
    claimsForProof = [];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
  });

  it('restores to ACTIVE once the claim is decided — confirmed or rejected', async () => {
    for (const status of ['confirmed', 'rejected'] as const) {
      vi.clearAllMocks();
      claimsForProof = [{ id: 'claim-1', live: { status, proofId: 'P', uid: 'u1' } }];

      await restoreProof('P');

      expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
    }
  });

  it('decides on the LIVE claim, so one resolved since the lookup is not treated as pending', async () => {
    // The candidate ids come from a query outside the transaction (the web SDK's
    // Transaction.get takes a DocumentReference, never a query), so the claim is
    // re-read inside it. Here the lookup found it and another admin confirmed it
    // in the gap: the restore publishes rather than sending it back for a
    // decision that has already been made.
    claimsForProof = [{ id: 'claim-1', live: { status: 'confirmed', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(ops.filter((o) => o.op === 'get').map((o) => o.path)).toContain('events/med-2026/claims/claim-1');
    expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
  });

  it('reads every claim BEFORE it writes, per the reads-before-writes contract', async () => {
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    const lastRead = ops.map((o) => o.op).lastIndexOf('get');
    const firstWrite = ops.findIndex((o) => o.op !== 'get');
    expect(lastRead).toBeLessThan(firstWrite);
  });

  it('clears the safety marker in the SAME write, so the admin lift actually lifts', async () => {
    // The marker is what confirmClaim gates on. Leaving it set would hold the
    // Proof after the admin had explicitly overridden the verdict, and the
    // console would offer no second control that could clear it.
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    const written = updatePayload('/proofs/')!;
    expect(safetyHideStands({ status: written.status as string, safetyHide: written.safetyHide as boolean })).toBe(
      false,
    );
    expect(txUpdate).toHaveBeenCalledTimes(1); // one write, not a publish followed by a clear
  });

  it("ignores a pending claim that is not the Proof owner's — a forged claim cannot steer Restore", async () => {
    // Codex P2 on #1143: any signed-in user can create a pending claim naming
    // another Player's Proof (the create rule binds uid to the caller, not
    // proofId to the caller's Proof). Only the owner's claim counts.
    claimsForProof = [{ id: 'forged-1', live: { status: 'pending', proofId: 'P', uid: 'attacker' } }];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
  });

  it("still honours the owner's pending claim beside forged ones", async () => {
    claimsForProof = [
      { id: 'forged-1', live: { status: 'pending', proofId: 'P', uid: 'attacker' } },
      { id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } },
    ];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'pending', safetyHide: false });
  });

  it('restores to ACTIVE when the Proof itself is missing, whatever claims name it', async () => {
    liveProof = undefined;
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
  });

  it("asks for the OWNER's claims, bounded — both equalities, then the cap", async () => {
    // Two equality filters and a limit. Equality-only conjunctions are served by
    // merging the single-field indexes Firestore maintains by default, so this
    // needs no composite index (firestore.indexes.json is untouched).
    claimsForProof = [];

    await restoreProof('P');

    const lookup = getDocsMock.mock.calls[0]?.[0] as { constraints?: unknown[] } | undefined;
    expect(lookup?.constraints).toEqual([
      { field: 'proofId', op: '==', value: 'P' },
      { field: 'uid', op: '==', value: 'u1' },
      { __kind: 'limit', count: 25 },
    ]);
  });

  it("cannot be crowded out: 25 forged claims do not displace the owner's", async () => {
    // Codex P2 round 2 on #1143. The bound is applied to the QUERY, so a lookup
    // filtered only by proofId lets any signed-in user decide what comes back:
    // enough forged pending claims fill the page, the owner's real claim falls
    // off the end, and Restore publishes a photo nobody has judged. Filtering by
    // the owner in the query is what makes the page uncrowdable — the forged docs
    // are gone before the cap is reached.
    claimsForProof = [
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `forged-${i}`,
        live: { status: 'pending' as const, proofId: 'P', uid: `attacker-${i}` },
      })),
      { id: 'claim-1', live: { status: 'pending' as const, proofId: 'P', uid: 'u1' } },
    ];

    await restoreProof('P');

    expect(updatePayload('/proofs/')).toEqual({ status: 'pending', safetyHide: false });
    // And the forged docs are not even read: the transaction's read budget is
    // spent on the Proof and the owner's own claim.
    expect(ops.filter((o) => o.op === 'get').map((o) => o.path)).toEqual([
      'events/med-2026/proofs/P',
      'events/med-2026/claims/claim-1',
    ]);
  });

  it('scopes the lookup with the owner from a plain read, not a transactional one', async () => {
    // `uid` is written once at create and is immutable, so the pre-transaction
    // read cannot be stale in any way that matters — it only decides which claims
    // are FETCHED. The owner check that decides the restore is still the live
    // re-read inside the transaction, which is why both reads exist.
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(getDocMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'events/med-2026/proofs/P' }),
    );
    expect(ops[0]).toEqual({ op: 'get', path: 'events/med-2026/proofs/P' });
  });

  it('skips the lookup entirely when there is no Proof to own the claims', async () => {
    liveProof = undefined;
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(getDocsMock).not.toHaveBeenCalled();
    expect(updatePayload('/proofs/')).toEqual({ status: 'active', safetyHide: false });
  });

  it('never touches the claim itself — Restore moves the photo, not the decision', async () => {
    claimsForProof = [{ id: 'claim-1', live: { status: 'pending', proofId: 'P', uid: 'u1' } }];

    await restoreProof('P');

    expect(ops.filter((o) => o.op !== 'get')).toEqual([{ op: 'update', path: 'events/med-2026/proofs/P' }]);
  });
});

// --- the Proof document has exactly ONE creator (#1143) ----------------------
//
// Codex P1. `moderateProof` is a STORAGE trigger and `attachProof` uploads the
// media BEFORE the transaction below, so a fast scan can reach a verdict with no
// Proof document to put it on. While the scanner closed that gap by merge-setting
// the verdict — which CREATES the doc — this write broke against it: the rules
// judge a write by whether the document exists, so a Player's create became an
// UPDATE that `hasOnly(['reportCount'])` denies (the submission fails outright),
// while an admin uploader's is ALLOWED and the full `set` overwrote `status`,
// `visionFlag` and `safetyHide` back to a public Proof no arm of the hide trigger
// could reach again.
//
// The fix is on the scanner side (functions/src/visionHide.ts: a verdict that
// arrives first is parked in the server-only `proofScans` collection), so this
// write is unchanged — and these cases are the pin that says what it relies on.

describe('attachProof — the Proof write stays a plain CREATE (specs/cloud-vision-moderation.md)', () => {
  /**
   * The `create` rule's `hasOnly` allowlist in firestore.rules, verbatim. A
   * create carrying anything else is denied outright — which is why the scanner
   * may not pre-create the doc, and why the client carries no server field.
   */
  const CREATE_ALLOWLIST = [
    'uid', 'displayName', 'photoURL', 'type', 'cellIndex', 'itemText',
    'storagePath', 'mediaURL', 'thumbURL', 'text', 'createdAt',
    'reportCount', 'status', 'visionFlag', 'source', 'dayIndex',
  ];

  const attach = (claimMode: 'proof_required' | 'admin_confirmed') =>
    attachProof({
      uid: 'u1',
      displayName: 'Deck Daddy',
      photoURL: null,
      cells: boardWithPendingClaim(),
      cellIndex: 5,
      itemId: 'i5',
      itemText: 'Saw a sailor in Speedos',
      claimMode,
      currentFirstBingoAt: null,
      proof: { type: 'photo', blob: new Blob(['x'], { type: 'image/jpeg' }) },
    });

  const proofWrite = () => txSet.mock.calls.find((c) => (c[0] as Ref).path.includes('/proofs/'));

  it('writes exactly the create-allowlisted keys, with no merge option and no server field', async () => {
    await attach('proof_required');

    const call = proofWrite()!;
    // Two arguments: a whole-document `set`, never `{ merge: true }`. That is only
    // safe while nothing else can have created the doc — a merge onto an existing
    // one would be an update touching `status`, which the rules bound to
    // `reportCount` for every non-admin.
    expect(call).toHaveLength(2);
    const payload = call[1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([...CREATE_ALLOWLIST].sort());
    // The server-owned moderation fields, from the client's side: the verdict is
    // written as an explicit null, and the marker is absent entirely — a create
    // carrying either a verdict or the marker is DENIED.
    expect(payload.visionFlag).toBeNull();
    expect(payload.status).toBe('active');
    expect(payload).not.toHaveProperty('safetyHide');
  });

  it('starts an admin_confirmed Proof pending, and still carries no server field', async () => {
    await attach('admin_confirmed');

    const payload = proofWrite()![1] as Record<string, unknown>;
    expect(payload.status).toBe('pending');
    expect(payload.visionFlag).toBeNull();
    expect(payload).not.toHaveProperty('safetyHide');
  });

  it('never READS the Proof, which is exactly why nothing else may create it', async () => {
    // The transaction reads the board, the player row and the tally marker — and
    // no Proof. So this write cannot notice a scanner-created doc, let alone carry
    // its verdict forward; the guarantee has to be that no such doc exists, and
    // that guarantee lives in `writeVisionVerdict` (functions/src/visionHide.ts).
    await attach('proof_required');

    expect(ops.filter((o) => o.op === 'get' && o.path.includes('/proofs/'))).toEqual([]);
    expect(ops.some((o) => o.op === 'set' && o.path.includes('/proofs/'))).toBe(true);
  });
});
