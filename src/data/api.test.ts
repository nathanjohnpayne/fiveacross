import { describe, it, expect, vi, beforeEach } from 'vitest';

// specs/d15-approvals.md, data layer. The one write-side claim this file pins:
// `addItem` now lands a main-pool submission `status: 'pending'` (was
// `'active'`) — the gate the rest of the approval flow (the Admin Approvals
// queue, the submitter's own "pending review" row in ItemPool) hangs off. No
// emulator needed — this is a pure "what payload did addDoc receive" check,
// mirroring the mocking shape src/data/w3-claim-modes.test.ts already uses for
// this module's sibling writes.

type Ref = { __kind: 'doc' | 'collection'; id?: string; path: string };

const { addDocMock, getDocsFromCacheMock } = vi.hoisted(() => ({
  addDocMock: vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'new-item' })),
  getDocsFromCacheMock: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    collection: (_db: unknown, ...segments: string[]): Ref => ({
      __kind: 'collection',
      path: segments.join('/'),
    }),
    collectionGroup: (_db: unknown, id: string): Ref => ({ __kind: 'collection', path: id }),
    doc: (_a: unknown, ...rest: string[]): Ref => {
      const ref: Ref = {
        __kind: 'doc',
        id: rest[rest.length - 1],
        path: rest.join('/'),
      };
      return { ...ref, withConverter: () => ref } as Ref;
    },
    // `addItem` reads the Event's schedule to resolve a default target Day
    // (#557). A read FAILURE now propagates rather than falling back to an
    // untargeted write, so this stand-in has to answer — reporting no Event doc,
    // which is the schedule-less case these tests already assume.
    getDoc: () => Promise.resolve({ exists: () => false, data: () => undefined }),
    addDoc: (...args: unknown[]) => addDocMock(...args),
    getDocsFromCache: (...args: unknown[]) => getDocsFromCacheMock(...args),
  };
});

import { addItem, hasCachedCard } from './api';

// A cached board-doc stand-in: hasCachedCard reads `.ref.path` (event scope) and
// `.data().uid`. EVENT_ID is mocked to 'med-2026' above.
const boardDoc = (uid: string | undefined, path: string) => ({
  ref: { path },
  data: () => (uid === undefined ? {} : { uid }),
});
const snapshotOf = (docs: ReturnType<typeof boardDoc>[]) => ({ docs });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addItem — main-pool submissions land pending (specs/d15-approvals.md)', () => {
  it('writes status: "pending" (not "active") alongside pool: "main"', async () => {
    await addItem('u1', 'Wore Crocs to dinner', false);

    expect(addDocMock).toHaveBeenCalledTimes(1);
    const [, payload] = addDocMock.mock.calls[0] as [Ref, Record<string, unknown>];
    expect(payload).toMatchObject({
      text: 'Wore Crocs to dinner',
      createdBy: 'u1',
      status: 'pending',
      pool: 'main',
      reportCount: 0,
      spicy: false,
    });
  });

  it('preserves the spicy flag the submitter checked', async () => {
    await addItem('u1', 'A spicy one', true);
    const [, payload] = addDocMock.mock.calls[0] as [Ref, Record<string, unknown>];
    expect(payload).toMatchObject({ status: 'pending', spicy: true });
  });

  it('a blank/whitespace-only submission never calls addDoc', async () => {
    await addItem('u1', '   ');
    expect(addDocMock).not.toHaveBeenCalled();
  });

  it('writes through the Event scope captured by the caller', async () => {
    await addItem('u1', 'Event A prompt', false, undefined, 'event-a');
    const [ref] = addDocMock.mock.calls[0] as [Ref, Record<string, unknown>];
    expect(ref.path).toBe('events/event-a/items');
  });
});

describe('hasCachedCard — cached-card probe for the #403 deal-failure fallback', () => {
  it('is true when a cached board (legacy or day) for the ACTIVE event carries this uid', async () => {
    // Mixed cache: another Player's board plus this Player's day card, both under
    // the active events/med-2026 tree.
    getDocsFromCacheMock.mockResolvedValueOnce(
      snapshotOf([
        boardDoc('other-uid', 'events/med-2026/boards/other-uid'),
        boardDoc('me', 'events/med-2026/days/0/boards/me'),
      ]),
    );
    expect(await hasCachedCard('me')).toBe(true);
  });

  it('is false when no cached board matches this uid (row-only / other players)', async () => {
    getDocsFromCacheMock.mockResolvedValueOnce(
      snapshotOf([
        boardDoc('someone-else', 'events/med-2026/boards/someone-else'),
        boardDoc(undefined, 'events/med-2026/boards/malformed'),
      ]),
    );
    expect(await hasCachedCard('me')).toBe(false);
  });

  it('is false when only a PRIOR event board matches this uid — active-event scoped (Codex #408 round 2)', async () => {
    // A cached board from a past cruise for the same uid must NOT read as a current
    // card, or a first-deal failure for the new event would be wrongly swallowed.
    getDocsFromCacheMock.mockResolvedValueOnce(
      snapshotOf([boardDoc('me', 'events/old-cruise-2025/boards/me')]),
    );
    expect(await hasCachedCard('me')).toBe(false);
  });

  it('uses the Event captured by the recovery caller, not the later live binding', async () => {
    getDocsFromCacheMock.mockResolvedValueOnce(
      snapshotOf([boardDoc('me', 'events/event-a/days/0/boards/me')]),
    );
    expect(await hasCachedCard('me', 'event-a')).toBe(true);
  });

  it('is false (fail-closed) when the cache read throws — no local card', async () => {
    getDocsFromCacheMock.mockRejectedValueOnce(new Error('no cache'));
    expect(await hasCachedCard('me')).toBe(false);
  });
});
