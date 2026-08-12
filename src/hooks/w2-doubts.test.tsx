import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/w2-doubts.md, hooks layer (PR #106 round 4, Codex P2). The two scoped
// Doubt-satisfaction inputs — useMyProofs (the viewer-scoped Square badge) and
// useProofsForItemText (the Tally sheet's per-Prompt status) — must honor the
// SAME ADR 0004 community auto-hide as useProofFeed (#107): a Proof whose
// reportCount has reached event.settings.reportHideThreshold is invisible in the
// public Feed, so it must not satisfy a Doubt either — the sheet would otherwise
// read "Proof shown ✓" (and the badge clear) on evidence the group can no longer
// see. If the group cannot see the proof, it cannot answer the accusation. The
// filter fails OPEN exactly like #107: a missing/non-positive threshold filters
// nothing. Harness mirrors src/hooks/w2-admin-console.test.tsx — the REAL hooks
// with Firestore's onSnapshot stubbed, the event doc (threshold source) and the
// proofs query hand-delivered; the derivation coherence is asserted through the
// REAL pure openDoubts/isDoubtSatisfied over the hook output.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn() }));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
  analyticsReady: Promise.resolve(null),
}));

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref; // paths.ts chains .withConverter on refs
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    onSnapshot: H.onSnapshot,
    getDocFromCache: () => Promise.reject(new Error('cache miss')), // doubts.ts import surface
    setDoc: () => Promise.resolve(),
  };
});

import { useMyProofs, useProofsForItemText } from './useData';
import { openDoubts, isDoubtSatisfied } from '../data/doubts';
import type { ProofDoc } from '../types';

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {}); // unsubscribe fn
});

// Route each subscription's onNext by target: the event doc (the threshold
// source — a `doc` ref via useReportHideThreshold) vs the proofs `query`.
type SnapCb = (snap: unknown) => void;
function capture() {
  const cbs: { doc: SnapCb | null; query: SnapCb | null } = { doc: null, query: null };
  H.onSnapshot.mockImplementation((target: unknown, _o: unknown, onNext: SnapCb) => {
    if (target && typeof target === 'object') {
      if ('query' in (target as object)) cbs.query = onNext;
      else if ((target as { kind?: string }).kind === 'doc') cbs.doc = onNext;
    }
    return () => {};
  });
  return {
    fireDoc: (s: unknown) => act(() => cbs.doc?.(s)),
    fireQuery: (s: unknown) => act(() => cbs.query?.(s)),
  };
}

// The event doc as useDocSub reads it; `threshold === undefined` omits
// settings.reportHideThreshold entirely — the "config unset" case.
const eventSnap = (threshold: number | undefined) => ({
  exists: () => true,
  data: () =>
    threshold === undefined
      ? { admins: [] }
      : { admins: [], settings: { reportHideThreshold: threshold } },
  metadata: { fromCache: false },
});
const colSnap = (docs: object[]) => ({
  docs: docs.map((d) => ({ data: () => d })),
  metadata: { fromCache: false },
});

const TEXT = 'Saw a drag show';
const proof = (id: string, reportCount: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: 'bob',
    displayName: 'Bob',
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: TEXT,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'x',
    createdAt: 1_050_000, // 50s after the Doubt below — a satisfying stamp
    reportCount,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;
// A Doubt against Bob that proof() above WOULD satisfy — unless the hide drops it.
const doubtAgainstBob = { targetUid: 'bob', createdAt: 1_000_000 };
const EVAL_NOW = 2_000_000; // injected `now` so the derivation is deterministic

describe('useMyProofs — the badge’s satisfaction input honors the community hide (PR #106 round 4)', () => {
  it('drops an at/over-threshold Proof — a community-hidden Proof cannot satisfy a Doubt, so the badge stays', () => {
    const cap = capture();
    const { result } = renderHook(() => useMyProofs('bob'));

    cap.fireDoc(eventSnap(4)); // threshold = 4 (the seeded value)
    cap.fireQuery(colSnap([proof('p1', 4)])); // AT the threshold → community-hidden

    expect(result.current.proofs).toEqual([]); // filtered before the derivation
    // Coherence: through the REAL derivation, the Doubt against Bob stays OPEN —
    // the group cannot see p1, so p1 cannot answer the accusation.
    expect(isDoubtSatisfied(doubtAgainstBob, TEXT, result.current.proofs, EVAL_NOW)).toBe(false);
    expect(openDoubts([doubtAgainstBob], TEXT, result.current.proofs)).toEqual([doubtAgainstBob]);
  });

  it('keeps a below-threshold Proof — it still satisfies', () => {
    const cap = capture();
    const { result } = renderHook(() => useMyProofs('bob'));

    cap.fireDoc(eventSnap(4));
    cap.fireQuery(colSnap([proof('p1', 3)])); // below → visible

    expect(result.current.proofs.map((p) => p.id)).toEqual(['p1']);
    expect(isDoubtSatisfied(doubtAgainstBob, TEXT, result.current.proofs, EVAL_NOW)).toBe(true);
  });

  it('fails OPEN on an unset or non-positive threshold — no filtering (the #107 rule)', () => {
    // Unset config: even a heavily-reported Proof passes through.
    let cap = capture();
    const unset = renderHook(() => useMyProofs('bob'));
    cap.fireDoc(eventSnap(undefined));
    cap.fireQuery(colSnap([proof('p1', 99)]));
    expect(unset.result.current.proofs.map((p) => p.id)).toEqual(['p1']);

    // A 0 threshold (admin typo) is inactive, not "hide all".
    cap = capture();
    const zero = renderHook(() => useMyProofs('bob'));
    cap.fireDoc(eventSnap(0));
    cap.fireQuery(colSnap([proof('p2', 99), proof('p3', 0)]));
    expect(zero.result.current.proofs.map((p) => p.id).sort()).toEqual(['p2', 'p3']);
  });
});

describe('useProofsForItemText — the sheet’s satisfaction input honors the community hide (PR #106 round 4)', () => {
  it('drops an at/over-threshold Proof — the sheet keeps the open count instead of "Proof shown ✓"', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofsForItemText(TEXT));

    cap.fireDoc(eventSnap(4));
    cap.fireQuery(colSnap([proof('p1', 5), proof('p2', 3)])); // p1 hidden, p2 visible

    expect(result.current.proofs.map((p) => p.id)).toEqual(['p2']);
  });

  it('a Doubt answered ONLY by a community-hidden Proof reads OPEN through the real derivation', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofsForItemText(TEXT));

    cap.fireDoc(eventSnap(4));
    cap.fireQuery(colSnap([proof('p1', 4)])); // the only answering Proof is hidden

    expect(openDoubts([doubtAgainstBob], TEXT, result.current.proofs)).toEqual([doubtAgainstBob]);
  });

  it('fails OPEN on an unset or non-positive threshold — no filtering (the #107 rule)', () => {
    let cap = capture();
    const unset = renderHook(() => useProofsForItemText(TEXT));
    cap.fireDoc(eventSnap(undefined));
    cap.fireQuery(colSnap([proof('p1', 99)]));
    expect(unset.result.current.proofs.map((p) => p.id)).toEqual(['p1']);

    cap = capture();
    const zero = renderHook(() => useProofsForItemText(TEXT));
    cap.fireDoc(eventSnap(0));
    cap.fireQuery(colSnap([proof('p2', 99)]));
    expect(zero.result.current.proofs.map((p) => p.id)).toEqual(['p2']);
  });
});
