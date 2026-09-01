import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  eventId: 'event-a',
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
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
vi.mock('firebase/firestore', () => ({ setDoc: H.setDoc, deleteDoc: H.deleteDoc }));

import { setHeart } from './hearts';

beforeEach(() => {
  vi.clearAllMocks();
  H.eventId = 'event-a';
  H.setDoc.mockResolvedValue(undefined);
  H.deleteDoc.mockResolvedValue(undefined);
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
