import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// specs/cloud-vision-moderation.md, RTL-jsdom layer. Pins the queue-membership
// half of the Vision treatment (#133): `useReportedProofs` is the ONLY admin
// surface for Proofs, so an AI-screened Proof must stay reachable through the
// whole Vision lifecycle — flagged, hidden, and (the arm this ticket adds)
// restored, where an admin's override leaves `status: 'active'` with
// `reportCount` 0 and only `visionFlag` left to hold the row in the queue. The
// REAL hook runs with Firestore's onSnapshot stubbed so the proofs snapshot is
// hand-delivered.

const H = vi.hoisted(() => ({ onSnapshot: vi.fn(), snapshots: new Map<unknown, unknown>() }));

// Private queue fixtures use an authenticated, recovered memory session.
vi.mock('./usePrivateFirestore', () => ({ usePrivateFirestore: () => ({
  uid: 'admin', db: { name: 'private-memory' }, generation: 1, recoveryRequired: false, failed: false,
}) }));

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
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => makeRef('query', args),
    where: (...args: unknown[]) => makeRef('where', args),
    onSnapshot: H.onSnapshot,
    waitForPendingWrites: async () => {},
    getDocsFromServer: async (target: unknown) => H.snapshots.get(target),
  };
});

import { useReportedProofs } from './useData';
import type { ProofDoc } from '../types';

beforeEach(() => {
  H.snapshots.clear();
  H.onSnapshot.mockReset();
  H.onSnapshot.mockReturnValue(() => {});
});

// useReportedProofs opens exactly one broad collection subscription and no event
// doc (it filters by nothing the Event owns), so a single capture slot suffices.
function capture() {
  let target: unknown;
  let onNext: ((snap: unknown) => void) | null = null;
  H.onSnapshot.mockImplementation((_t: unknown, _o: unknown, next: (snap: unknown) => void) => {
    target = _t;
    onNext = next;
    return () => {};
  });
  return (docs: object[]) =>
    act(async () => {
      const snap = { docs: docs.map((d, index) => ({ id: String(Reflect.get(d, 'id') ?? index), data: () => d })), metadata: { fromCache: false, hasPendingWrites: false } };
      H.snapshots.set(target, snap);
      onNext?.(snap);
    });
}

const proof = (id: string, over: Partial<ProofDoc> = {}): ProofDoc =>
  ({
    id,
    uid: `u-${id}`,
    displayName: id,
    photoURL: null,
    type: 'photo',
    cellIndex: 0,
    itemText: `prompt ${id}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: null,
    createdAt: 1,
    reportCount: 0,
    status: 'active',
    visionFlag: null,
    ...over,
  }) as ProofDoc;

describe('useReportedProofs — the AI-screened Proof stays reachable for its whole lifecycle', () => {
  it('queues a Vision-flagged Proof at every stage, including after an admin Restore', async () => {
    const fire = capture();
    const { result } = renderHook(() => useReportedProofs());

    await fire([
      proof('flagged', { status: 'flagged', visionFlag: 'violence' }), // scanned, hide not landed yet
      proof('vision-hidden', { status: 'hidden', visionFlag: 'violence' }), // auto-hidden
      proof('restored', { status: 'active', visionFlag: 'violence' }), // admin override — the #133 arm
      proof('clean'), // active, unreported, never screened → not queued
    ]);

    expect(result.current.flagged.map((p) => p.id).sort()).toEqual([
      'flagged',
      'restored',
      'vision-hidden',
    ]);
  });

  it('queues a Proof carrying a non-auto-hide verdict too (racy as a synthetic stand-in) — reviewable, never auto-hidden', async () => {
    const fire = capture();
    const { result } = renderHook(() => useReportedProofs());

    await fire([proof('racy', { status: 'active', visionFlag: 'racy' }), proof('clean')]);

    expect(result.current.flagged.map((p) => p.id)).toEqual(['racy']);
  });

  it('leaves the three pre-existing arms intact — reported, flagged, and hard-hidden still queue', async () => {
    const fire = capture();
    const { result } = renderHook(() => useReportedProofs());

    await fire([
      proof('reported', { reportCount: 2 }),
      proof('admin-hidden', { status: 'hidden' }),
      proof('clean'),
    ]);

    expect(result.current.flagged.map((p) => p.id).sort()).toEqual(['admin-hidden', 'reported']);
  });
});
