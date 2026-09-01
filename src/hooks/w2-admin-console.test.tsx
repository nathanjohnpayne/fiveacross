import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/w2-admin-console.md, RTL-jsdom layer. Proves the ADR 0004 Phase 0
// community auto-hide is load-bearing in the READ hooks: a Prompt or Proof whose
// reportCount has REACHED event.settings.reportHideThreshold self-hides from the
// public read paths (useProofFeed — and through it the merged useFeed — and
// useItems) on every client, with no Admin action and the doc untouched. The
// Admin views (useAllItems / useReportedProofs) apply NO such filter, so an Admin
// can still reach and restore threshold-hidden content. A missing/undefined
// threshold means NO filtering (fail-open). The hide is presentational and
// bypassable by design (tamper-proof server enforcement is #43); here we drive
// the REAL hooks with Firestore's onSnapshot stubbed so we can hand-deliver the
// event doc (carrying the threshold) alongside the proofs/items snapshots.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn() }));

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
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
    // #216: useFeed now composes useTallyCards, which opens an Event-filtered
    // query over the markers collection group. Stubbed so the merged-Feed hook
    // renders; the tally stream is delivered empty via the existing `col` slot.
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => makeRef('query', args),
    where: (...args: unknown[]) => makeRef('where', args),
    onSnapshot: H.onSnapshot,
  };
});

import { isReportHidden, useProofFeed, useItems, useAllItems, useReportedProofs, useFeed } from './useData';
import type { ItemDoc, ProofDoc } from '../types';

beforeEach(() => {
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {}); // unsubscribe fn
});

// Route each subscription's onNext by target so a test can deliver the event doc
// (the threshold source — a `doc` ref), the proofs FEED (a `query`), and any
// admin/moments COLLECTION separately. The real hooks call
// onSnapshot(target, options, onNext, onError).
type SnapCb = (snap: unknown) => void;
function capture() {
  // `doc` is an ARRAY: since #108, useProofFeed AND useMoments each read the SAME
  // event doc (threshold + bannedUids via useEventModeration), so `useFeed` opens
  // TWO event-doc subscriptions. fireDoc must deliver the event snapshot to BOTH,
  // not just the last-registered one — otherwise one half keeps its default
  // (threshold undefined → no filtering) and the merged assertion drifts.
  const cbs: { docs: SnapCb[]; query: SnapCb | null; col: SnapCb | null } = {
    docs: [],
    query: null,
    col: null,
  };
  H.onSnapshot.mockImplementation((target: unknown, _o: unknown, onNext: SnapCb) => {
    if (target && typeof target === 'object') {
      const ref = target as { kind?: string; args?: unknown[] };
      const querySource = ref.kind === 'query' && ref.args?.[0] && typeof ref.args[0] === 'object'
        ? (ref.args[0] as { kind?: string; args?: unknown[] })
        : undefined;
      if (ref.kind === 'query' && querySource?.kind === 'collectionGroup' && querySource.args?.[1] === 'markers') {
        cbs.col = onNext;
      }
      else if (ref.kind === 'query') cbs.query = onNext;
      else if (ref.kind === 'doc') cbs.docs.push(onNext);
      else cbs.col = onNext;
    }
    return () => {};
  });
  return {
    fireDoc: (s: unknown) => act(() => cbs.docs.forEach((cb) => cb(s))),
    fireQuery: (s: unknown) => act(() => cbs.query?.(s)),
    fireCol: (s: unknown) => act(() => cbs.col?.(s)),
  };
}

// The event doc as useDocSub reads it (exists()/data()); `threshold === undefined`
// omits settings.reportHideThreshold entirely — the "config unset" case.
const eventSnap = (threshold: number | undefined) => ({
  exists: () => true,
  data: () =>
    threshold === undefined
      ? { admins: [] }
      : { admins: [], settings: { reportHideThreshold: threshold } },
  metadata: { fromCache: false },
});
// A collection/query snapshot in the shape useColSub reads.
const colSnap = (docs: object[]) => ({
  docs: docs.map((d) => ({ data: () => d })),
  metadata: { fromCache: false },
});

const proof = (id: string, reportCount: number, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: `u-${id}`,
    displayName: id,
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: 'x',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    reportCount,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

const item = (id: string, reportCount: number, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: `u-${id}`,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    isFreeSpace: false,
    status: 'active',
    reportCount,
    spicy: false,
    pool: 'main',
    ...over,
  }) as ItemDoc;

describe('isReportHidden — the at/over/below boundary (ADR 0004 Phase 0)', () => {
  it('hides at OR over the threshold, shows below it', () => {
    expect(isReportHidden(3, 4)).toBe(false); // below
    expect(isReportHidden(4, 4)).toBe(true); // AT the threshold hides
    expect(isReportHidden(5, 4)).toBe(true); // over
    expect(isReportHidden(0, 4)).toBe(false);
  });

  it('fails OPEN on a missing/undefined threshold — no filtering', () => {
    expect(isReportHidden(999, undefined)).toBe(false);
    expect(isReportHidden(0, undefined)).toBe(false);
  });

  it('fails OPEN on a NON-POSITIVE threshold — a 0/negative/NaN typo hides nothing (Codex P2, PR #107 finding 2)', () => {
    // A threshold <= 0 would make reportCount >= threshold true for ALL content and
    // blank the whole app from one admin typo; only a POSITIVE threshold is active.
    expect(isReportHidden(0, 0)).toBe(false);
    expect(isReportHidden(5, 0)).toBe(false);
    expect(isReportHidden(5, -1)).toBe(false);
    expect(isReportHidden(0, -1)).toBe(false);
    // NaN is `typeof 'number'` but not > 0, so the same guard rejects it.
    expect(isReportHidden(5, Number.NaN)).toBe(false);
    expect(isReportHidden(0, Number.NaN)).toBe(false);
  });
});

describe('useProofFeed — the public Feed excludes threshold-hidden Proofs', () => {
  it('drops a Proof at/over reportHideThreshold; keeps below-threshold Proofs', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofFeed());

    cap.fireDoc(eventSnap(4)); // threshold = 4 (the seeded value)
    cap.fireQuery(
      colSnap([
        proof('p1', 5), // over → hidden
        proof('p2', 4), // AT → hidden
        proof('p3', 3), // below → shown
        proof('p4', 0), // unreported → shown
      ]),
    );

    expect(result.current.proofs.map((p) => p.id).sort()).toEqual(['p3', 'p4']);
  });

  it('applies NO filter when the threshold is unset (fail-open)', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofFeed());

    cap.fireDoc(eventSnap(undefined)); // config unset
    cap.fireQuery(colSnap([proof('p1', 99)])); // heavily reported

    expect(result.current.proofs.map((p) => p.id)).toEqual(['p1']); // still shown
  });

  it('does NOT blank the Feed when the threshold is 0 — a non-positive typo hides nothing (finding 2)', () => {
    const cap = capture();
    const { result } = renderHook(() => useProofFeed());

    cap.fireDoc(eventSnap(0)); // admin typo: 0 would hide reportCount >= 0 = everything
    cap.fireQuery(colSnap([proof('p1', 99), proof('p2', 1), proof('p3', 0)]));

    // All three still show — a 0 threshold is inactive, not "hide all".
    expect(result.current.proofs.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('useFeed — the merged Feed hides threshold-hidden Proofs on the proof side', () => {
  it('excludes an at/over-threshold Proof from the merged stream (Moments untouched)', () => {
    const cap = capture();
    const { result } = renderHook(() => useFeed());

    cap.fireDoc(eventSnap(4));
    cap.fireQuery(colSnap([proof('p1', 4), proof('p2', 1)])); // p1 hidden, p2 shown
    cap.fireCol(colSnap([])); // moments empty

    const proofIds = result.current.entries
      .filter((e) => e.feedKind === 'proof')
      .map((e) => (e.feedKind === 'proof' ? e.proof.id : ''));
    expect(proofIds).toEqual(['p2']);
  });
});

describe('useItems — the live Prompt pool excludes threshold-hidden Prompts', () => {
  it('drops a Prompt at/over reportHideThreshold; keeps below-threshold Prompts', () => {
    const cap = capture();
    const { result } = renderHook(() => useItems());

    cap.fireDoc(eventSnap(4));
    // Since #43 F4 the player pool is a status=='active' query, so it arrives on
    // the query channel (like useProofFeed), not the bare collection channel.
    cap.fireQuery(
      colSnap([
        item('i1', 4), // AT → hidden
        item('i2', 6), // over → hidden
        item('i3', 2), // below → shown
        item('i4', 0),
      ]),
    );

    expect(result.current.items.map((i) => i.id).sort()).toEqual(['i3', 'i4']);
  });

  it('keeps only main-pool Prompts in the player-facing pool', () => {
    const cap = capture();
    const { result } = renderHook(() => useItems());

    cap.fireDoc(eventSnap(undefined));
    cap.fireQuery(
      colSnap([
        item('legacy-main', 0, { pool: undefined as unknown as ItemDoc['pool'] }),
        item('explicit-main', 0, { pool: 'main' }),
        item('easy', 0, { pool: 'easy' }),
        item('closing', 0, { pool: 'closing' }),
      ]),
    );

    expect(result.current.items.map((i) => i.id)).toEqual(['legacy-main', 'explicit-main']);
  });
});

describe('Admin views stay UNfiltered — threshold-hidden content is reachable', () => {
  it('useAllItems includes a Prompt at/over the threshold', () => {
    const cap = capture();
    const { result } = renderHook(() => useAllItems());

    // useAllItems opens NO event subscription (it never filters), so there is no
    // threshold to deliver — only the admin items collection.
    cap.fireCol(colSnap([item('i1', 9), item('i2', 0)]));

    expect(result.current.items.map((i) => i.id).sort()).toEqual(['i1', 'i2']);
  });

  it('useReportedProofs includes a threshold-hidden Proof so an Admin can restore it', () => {
    const cap = capture();
    const { result } = renderHook(() => useReportedProofs());

    cap.fireCol(colSnap([proof('p1', 9), proof('p2', 4), proof('p3', 0)]));

    // p1 and p2 are at/over the seeded threshold of 4 (hidden on the Feed) but
    // still surface in the report queue; p3 is unreported so it is not queued.
    expect(result.current.flagged.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('useReportedProofs includes a hard-hidden ZERO-count Proof — clear-then-restore can never orphan it (Codex P2, PR #107 round 2)', () => {
    // The clear-then-restore ordering trap: Clear reports on a doubly-hidden Proof
    // (status 'hidden' AND over threshold) zeroes reportCount FIRST. There is no
    // all-proofs admin list (unlike Prompts' useAllItems), so if membership were
    // only `reportCount > 0 || flagged`, the still-hidden Proof would vanish from
    // the console forever. Queue membership is reported OR flagged OR hidden.
    const cap = capture();
    const { result } = renderHook(() => useReportedProofs());

    cap.fireCol(
      colSnap([
        proof('p-cleared', 0, { status: 'hidden' }), // cleared first, not yet restored → MUST stay queued
        proof('p-flagged', 0, { status: 'flagged' }),
        proof('p-clean', 0), // active + unreported → not queued
      ]),
    );

    expect(result.current.flagged.map((p) => p.id).sort()).toEqual(['p-cleared', 'p-flagged']);
  });
});
