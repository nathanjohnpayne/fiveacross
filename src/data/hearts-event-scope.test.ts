import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocFromCache: vi.fn(),
  serverTimestamp: vi.fn(() => ({ transform: 'serverTimestamp' })),
  track: vi.fn(),
  heartRef: vi.fn((id: string, eventId: string) => ({ path: `events/${eventId}/hearts/${id}` })),
}));

vi.mock('../firebase', () => ({
  get EVENT_ID() {
    return H.eventId;
  },
}));
vi.mock('../analytics', () => ({ track: H.track }));
vi.mock('./paths', () => ({ heartRef: H.heartRef }));
vi.mock('firebase/firestore', () => ({ setDoc: H.setDoc, deleteDoc: H.deleteDoc, getDocFromCache: H.getDocFromCache, serverTimestamp: H.serverTimestamp }));

import { setHeart } from './hearts';

beforeEach(() => {
  vi.clearAllMocks();
  H.eventId = 'event-a';
  H.setDoc.mockResolvedValue(undefined);
  H.deleteDoc.mockResolvedValue(undefined);
  H.getDocFromCache.mockResolvedValue({ exists: () => false });
});

describe('Heart Event ownership', () => {
  it.each([
    { on: true, settle: H.setDoc },
    { on: false, settle: H.deleteDoc },
  ])('keeps an Event A $on write under A and suppresses its analytics after B activates', async ({ on, settle }) => {
    let finish!: () => void;
    settle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const pending = setHeart({
      uid: 'alice',
      targetKind: 'proof',
      targetId: 'post-1',
      targetCreatedAt: 123,
      on,
    });

    expect(H.heartRef).toHaveBeenCalledWith('alice_proof_post-1', 'event-a');
    H.eventId = 'event-b';
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    await pending;

    expect(H.track).not.toHaveBeenCalled();
  });

  it('tracks a settled Heart while its captured Event is still active', async () => {
    await setHeart({
      uid: 'alice',
      targetKind: 'moment',
      targetId: 'post-2',
      targetCreatedAt: 456,
      on: true,
    });

    expect(H.track).toHaveBeenCalledWith('heart_post', { targetKind: 'moment', on: true });
  });
});


describe('server-owned Heart binding enqueue', () => {
  const intent = { uid: 'alice', targetKind: 'proof' as const, targetId: 'post-1', targetCreatedAt: 123, on: true };
  it('preserves a matching committed or pending timestamp through a merge retry', async () => {
    H.getDocFromCache.mockResolvedValue({ exists: () => true, data: () => ({ ...intent, bindingCommittedAt: null }) });
    await setHeart(intent);
    expect(H.setDoc.mock.calls[0][1]).not.toHaveProperty('bindingCommittedAt');
    expect(H.setDoc.mock.calls[0][2]).toEqual({ merge: true });
  });
  it('stamps a genuine incarnation rebinding instead of adopting the old slot timestamp', async () => {
    H.getDocFromCache.mockResolvedValue({ exists: () => true, data: () => ({ ...intent, targetCreatedAt: 122, bindingCommittedAt: { seconds: 1, nanoseconds: 0 } }) });
    await setHeart(intent);
    expect(H.setDoc.mock.calls[0][1].bindingCommittedAt).toEqual({ transform: 'serverTimestamp' });
  });
  it('keeps rapid offline on/off writes in intent order without holding on server ACK', async () => {
    let cache!: (value: unknown) => void;
    H.getDocFromCache.mockImplementationOnce(() => new Promise(resolve => { cache = resolve; }));
    H.setDoc.mockImplementationOnce(() => new Promise(() => {}));
    void setHeart(intent);
    const off = setHeart({ ...intent, on: false });
    await vi.waitFor(() => expect(cache).toBeTypeOf('function'));
    expect(H.deleteDoc).not.toHaveBeenCalled();
    cache({ exists: () => false });
    await off;
    expect(H.setDoc.mock.invocationCallOrder[0]).toBeLessThan(H.deleteDoc.mock.invocationCallOrder[0]);
  });
});
