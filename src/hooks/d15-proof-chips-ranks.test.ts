import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/d15-proof-chips-ranks.md, hooks layer (#218, union semantics #604).
// Harness mirrors src/hooks/w2-doubts.test.tsx — the REAL hook with
// Firestore's onSnapshot stubbed, event doc + proofs query hand-delivered
// separately.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn() }));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', storage: {}, auth: {}, googleProvider: {}, analytics: null }));
vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref;
    return ref;
  };
  return {
    doc: (...a: unknown[]) => makeRef('doc', a),
    collection: (...a: unknown[]) => makeRef('collection', a),
    query: (...a: unknown[]) => ({ query: a }),
    where: (...a: unknown[]) => ({ where: a }),
    onSnapshot: H.onSnapshot,
  };
});

import { useProofKindsByUid } from './useData';
import type { ProofDoc } from '../types';

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {});
});

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
  return { fireDoc: (s: unknown) => act(() => cbs.doc?.(s)), fireQuery: (s: unknown) => act(() => cbs.query?.(s)) };
}

const eventSnap = (threshold: number | undefined, bannedUids: string[] = []) => ({
  exists: () => true,
  data: () => (threshold === undefined ? { admins: [], bannedUids } : { admins: [], bannedUids, settings: { reportHideThreshold: threshold } }),
  metadata: { fromCache: false },
});
const colSnap = (docs: object[]) => ({ docs: docs.map((d) => ({ data: () => d })), metadata: { fromCache: false } });

const proof = (id: string, uid: string, createdAt: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id, uid, displayName: uid, photoURL: null, type: 'text', cellIndex: 0,
    itemText: 'Wore a sequin harness', storagePath: null, mediaURL: null, thumbURL: null,
    text: 'x', createdAt, reportCount: 0, status: 'active', visionFlag: null, ...over,
  }) as ProofDoc;

describe('useProofKindsByUid (#604)', () => {
  it('unions every proof kind a Player has used across different Days, not just their most recent', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofKindsByUid());
    cap.fireDoc(eventSnap(undefined));
    cap.fireQuery(colSnap([
      // Nathan mixed a live photo, a library photo, and written proof —
      // the reported #604 case — none of these is the "latest" alone.
      proof('p1', 'nathan', 1_000, { type: 'photo', source: 'camera' }),
      proof('p2', 'nathan', 2_000, { type: 'photo', source: 'library' }),
      proof('p3', 'nathan', 3_000, { type: 'text' }),
      proof('p4', 'ana', 2_000, { type: 'audio' }),
    ]));

    expect(result.current.kindsByUid.nathan).toEqual({ photo: true, library: true, audio: false, text: true });
    expect(result.current.kindsByUid.ana).toEqual({ photo: false, library: false, audio: true, text: false });
    expect(Object.keys(result.current.kindsByUid).sort()).toEqual(['ana', 'nathan']);
  });

  it('a single-kind Player unions down to exactly that one flag', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofKindsByUid());
    cap.fireDoc(eventSnap(undefined));
    cap.fireQuery(colSnap([proof('p1', 'bob', 1_000, { type: 'text' }), proof('p2', 'bob', 2_000, { type: 'text' })]));

    expect(result.current.kindsByUid.bob).toEqual({ photo: false, library: false, audio: false, text: true });
  });

  it('applies the community auto-hide (report threshold) and the Admin ban (#108)', () => {
    // Threshold: an at/over-threshold Proof never contributes a kind.
    let cap = capture();
    let hook = renderHook(() => useProofKindsByUid());
    cap.fireDoc(eventSnap(4));
    cap.fireQuery(colSnap([
      proof('p1', 'bob', 1_000, { type: 'text', reportCount: 2 }),
      proof('p2', 'bob', 3_000, { type: 'photo', reportCount: 4 }),
    ]));
    expect(hook.result.current.kindsByUid.bob).toEqual({ photo: false, library: false, audio: false, text: true });

    // Ban: a banned Player's Proofs are dropped entirely.
    cap = capture();
    hook = renderHook(() => useProofKindsByUid());
    cap.fireDoc(eventSnap(undefined, ['bob']));
    cap.fireQuery(colSnap([proof('p1', 'bob', 1_000), proof('p2', 'ana', 2_000)]));
    expect(hook.result.current.kindsByUid.bob).toBeUndefined();
    expect(hook.result.current.kindsByUid.ana).toEqual({ photo: false, library: false, audio: false, text: true });
  });
});
