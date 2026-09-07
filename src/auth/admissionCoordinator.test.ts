import { describe, expect, it, vi } from 'vitest';
import {
  createAdmissionCoordinator,
  INVITATION_NO_LONGER_VALID_MESSAGE,
  mayDealUnderAdmission,
  sameAdmissionState,
  type AdmissionCoordinatorDependencies,
  type AdmissionState,
  type AdmissionVisit,
} from './admissionCoordinator';
import type { PendingEventInvitationRecord } from '../pendingEventInvitation';
import type { RedeemEventInvitationResult } from '../data/eventInvitations';

const ORIGIN = 'https://summer-camp.fiveacross.app';
const VISIT: AdmissionVisit = { eventId: 'summer-camp-2026', uid: 'user-a', origin: ORIGIN };

function record(overrides: Partial<PendingEventInvitationRecord> = {}): PendingEventInvitationRecord {
  return {
    captureId: 'capture-1',
    captureOrdinal: 0,
    code: 'A'.repeat(43),
    origin: ORIGIN,
    capturedAt: 1_000,
    ...overrides,
  };
}

interface Harness {
  deps: AdmissionCoordinatorDependencies;
  redeem: ReturnType<typeof vi.fn>;
  forgetIf: ReturnType<typeof vi.fn>;
  states: AdmissionState[];
  /** Resolve the n-th redeem call (0-based) with a result. */
  resolve(index: number, result: RedeemEventInvitationResult): Promise<void>;
  reject(index: number): Promise<void>;
  setPending(next: PendingEventInvitationRecord | null): void;
}

function harness(initial: PendingEventInvitationRecord | null = record()): Harness {
  let pending = initial;
  const settlers: Array<{
    resolve: (result: RedeemEventInvitationResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const redeem = vi.fn(
    () =>
      new Promise<RedeemEventInvitationResult>((resolve, reject) => {
        settlers.push({ resolve, reject });
      }),
  );
  const forgetIf = vi.fn(() => true);
  const deps: AdmissionCoordinatorDependencies = {
    readPending: ({ origin }) => (pending !== null && pending.origin === origin ? { record: pending } : null),
    forgetIf,
    redeem,
    now: () => 5_000,
  };
  const states: AdmissionState[] = [];
  return {
    deps,
    redeem,
    forgetIf,
    states,
    async resolve(index, result) {
      settlers[index]!.resolve(result);
      await Promise.resolve();
      await Promise.resolve();
    },
    async reject(index) {
      settlers[index]!.reject(new Error('unexpected'));
      await Promise.resolve();
      await Promise.resolve();
    },
    setPending(next) {
      pending = next;
    },
  };
}

function coordinatorOver(h: Harness) {
  const coordinator = createAdmissionCoordinator(h.deps);
  coordinator.subscribe((state) => h.states.push(state));
  return coordinator;
}

describe('the deal gate', () => {
  it('lets the deal proceed only when admission is clear or granted', () => {
    expect(mayDealUnderAdmission({ kind: 'clear' })).toBe(true);
    expect(mayDealUnderAdmission({ kind: 'admitted', outcome: 'membership-created' })).toBe(true);
    expect(mayDealUnderAdmission({ kind: 'admitted', outcome: 'already-member' })).toBe(true);
    expect(mayDealUnderAdmission({ kind: 'pending', captureId: 'c' })).toBe(false);
    expect(mayDealUnderAdmission({ kind: 'retryable', captureId: 'c', reason: 'unavailable' })).toBe(false);
    expect(mayDealUnderAdmission({ kind: 'blocked', message: 'm' })).toBe(false);
  });
});

describe('structural equality for a React mirror', () => {
  it('treats equal states as the same and any differing field as a change', () => {
    expect(sameAdmissionState({ kind: 'clear' }, { kind: 'clear' })).toBe(true);
    expect(
      sameAdmissionState({ kind: 'pending', captureId: 'c' }, { kind: 'pending', captureId: 'c' }),
    ).toBe(true);
    expect(
      sameAdmissionState({ kind: 'pending', captureId: 'c' }, { kind: 'pending', captureId: 'd' }),
    ).toBe(false);
    expect(
      sameAdmissionState(
        { kind: 'retryable', captureId: 'c', reason: 'unavailable' },
        { kind: 'retryable', captureId: 'c', reason: 'rate-limited' },
      ),
    ).toBe(false);
    expect(
      sameAdmissionState({ kind: 'blocked', message: 'm' }, { kind: 'blocked', message: 'm' }),
    ).toBe(true);
    expect(
      sameAdmissionState(
        { kind: 'admitted', outcome: 'already-member' },
        { kind: 'admitted', outcome: 'membership-created' },
      ),
    ).toBe(false);
    expect(sameAdmissionState({ kind: 'clear' }, { kind: 'pending', captureId: 'c' })).toBe(false);
  });
});

describe('a visit with no invitation', () => {
  it('is clear at once and never reaches the callable', () => {
    const h = harness(null);
    const coordinator = coordinatorOver(h);
    expect(coordinator.state()).toEqual({ kind: 'clear' });
    expect(coordinator.begin(VISIT)).toEqual({ kind: 'clear' });
    expect(h.redeem).not.toHaveBeenCalled();
    expect(h.forgetIf).not.toHaveBeenCalled();
  });

  it('ignores a record captured for another origin', () => {
    const h = harness(record({ origin: 'https://other.fiveacross.app' }));
    const coordinator = coordinatorOver(h);
    expect(coordinator.begin(VISIT)).toEqual({ kind: 'clear' });
    expect(h.redeem).not.toHaveBeenCalled();
  });
});

describe('redeeming the pending invitation', () => {
  it('holds the deal while the redemption is in flight, exposing only the capture id', () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    const state = coordinator.begin(VISIT);
    expect(state).toEqual({ kind: 'pending', captureId: 'capture-1' });
    expect(mayDealUnderAdmission(state)).toBe(false);
    expect(h.redeem).toHaveBeenCalledExactlyOnceWith({
      code: 'A'.repeat(43),
      expectedEventId: 'summer-camp-2026',
    });
    // The bearer is handed to the callable and to nothing else.
    expect(JSON.stringify(h.states)).not.toContain('A'.repeat(43));
  });

  it.each(['membership-created', 'already-member'] as const)(
    'admits on %s, forgetting exactly the consumed record',
    async (outcome) => {
      const h = harness();
      const coordinator = coordinatorOver(h);
      coordinator.begin(VISIT);
      await h.resolve(0, { ok: true, eventId: 'summer-camp-2026', outcome });
      expect(coordinator.state()).toEqual({ kind: 'admitted', outcome });
      expect(mayDealUnderAdmission(coordinator.state())).toBe(true);
      expect(h.forgetIf).toHaveBeenCalledExactlyOnceWith(record());
    },
  );

  it('blocks on a terminally invalid invitation, forgets it, and shares the one message', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'invitation-unavailable' });
    expect(coordinator.state()).toEqual({
      kind: 'blocked',
      message: INVITATION_NO_LONGER_VALID_MESSAGE,
    });
    expect(mayDealUnderAdmission(coordinator.state())).toBe(false);
    expect(h.forgetIf).toHaveBeenCalledExactlyOnceWith(record());
    expect(INVITATION_NO_LONGER_VALID_MESSAGE).toBe(
      'This invitation is no longer valid. Ask the organizer for a new one.',
    );
  });

  it.each(['unavailable', 'rate-limited', 'authentication-required'] as const)(
    'keeps the record and offers Retry on a transient %s failure',
    async (reason) => {
      const h = harness();
      const coordinator = coordinatorOver(h);
      coordinator.begin(VISIT);
      await h.resolve(0, { ok: false, reason });
      expect(coordinator.state()).toEqual({ kind: 'retryable', captureId: 'capture-1', reason });
      expect(mayDealUnderAdmission(coordinator.state())).toBe(false);
      expect(h.forgetIf).not.toHaveBeenCalled();
    },
  );

  it('treats a seam that rejects as transient rather than as admission or deletion', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.reject(0);
    expect(coordinator.state()).toEqual({
      kind: 'retryable',
      captureId: 'capture-1',
      reason: 'unavailable',
    });
    expect(h.forgetIf).not.toHaveBeenCalled();
  });

  it('refuses a success that names another Event, and deletes nothing', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: true, eventId: 'someone-elses-event', outcome: 'membership-created' });
    expect(coordinator.state()).toEqual({
      kind: 'retryable',
      captureId: 'capture-1',
      reason: 'unavailable',
    });
    expect(h.forgetIf).not.toHaveBeenCalled();
  });
});

describe('Retry', () => {
  it('re-attempts the same visit and admits on success', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'unavailable' });
    expect(coordinator.retry()).toEqual({ kind: 'pending', captureId: 'capture-1' });
    expect(h.redeem).toHaveBeenCalledTimes(2);
    await h.resolve(1, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    expect(coordinator.state()).toEqual({ kind: 'admitted', outcome: 'membership-created' });
    expect(h.forgetIf).toHaveBeenCalledExactlyOnceWith(record());
  });

  it('re-reads the pending record, so a newer capture supersedes the failed one', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'unavailable' });
    const newer = record({ captureId: 'capture-2', captureOrdinal: 1, code: 'B'.repeat(43) });
    h.setPending(newer);
    expect(coordinator.retry()).toEqual({ kind: 'pending', captureId: 'capture-2' });
    expect(h.redeem).toHaveBeenLastCalledWith({
      code: 'B'.repeat(43),
      expectedEventId: 'summer-camp-2026',
    });
    await h.resolve(1, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    expect(h.forgetIf).toHaveBeenCalledExactlyOnceWith(newer);
  });

  it('clears when the record expired between the failure and the retry', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'rate-limited' });
    h.setPending(null);
    expect(coordinator.retry()).toEqual({ kind: 'clear' });
    expect(h.redeem).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'clear' },
    { kind: 'pending', captureId: 'capture-1' },
    { kind: 'blocked', message: INVITATION_NO_LONGER_VALID_MESSAGE },
    { kind: 'admitted', outcome: 'membership-created' },
  ] as AdmissionState[])('is a no-op from %j', async (target) => {
    const h = harness(target.kind === 'clear' ? null : record());
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    if (target.kind === 'blocked') await h.resolve(0, { ok: false, reason: 'invitation-unavailable' });
    if (target.kind === 'admitted') {
      await h.resolve(0, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    }
    expect(coordinator.state()).toEqual(target);
    const calls = h.redeem.mock.calls.length;
    expect(coordinator.retry()).toEqual(target);
    expect(h.redeem).toHaveBeenCalledTimes(calls);
  });
});

describe('the stale-visit guards', () => {
  it.each([
    ['a different Event', { ...VISIT, eventId: 'autumn-camp-2026' }],
    ['a different account', { ...VISIT, uid: 'user-b' }],
    ['the same visit begun again', VISIT],
  ])('drops an older attempt that settles after %s began, deleting nothing', async (_label, newer) => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    coordinator.begin(newer);
    expect(h.redeem).toHaveBeenCalledTimes(2);

    // The OLD attempt succeeds. That success is evidence about the old visit
    // only: it must not admit the newer one, and it must not delete a record
    // the newer visit's own attempt is still holding.
    await h.resolve(0, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    expect(coordinator.state()).toEqual({ kind: 'pending', captureId: 'capture-1' });
    expect(h.forgetIf).not.toHaveBeenCalled();

    // The old attempt failing terminally is dropped the same way.
    const h2 = harness();
    const coordinator2 = coordinatorOver(h2);
    coordinator2.begin(VISIT);
    coordinator2.begin(newer);
    await h2.resolve(0, { ok: false, reason: 'invitation-unavailable' });
    expect(coordinator2.state()).toEqual({ kind: 'pending', captureId: 'capture-1' });
    expect(h2.forgetIf).not.toHaveBeenCalled();

    // The newer attempt's own result still lands.
    await h2.resolve(1, { ok: true, eventId: newer.eventId, outcome: 'already-member' });
    expect(coordinator2.state()).toEqual({ kind: 'admitted', outcome: 'already-member' });
    expect(h2.forgetIf).toHaveBeenCalledTimes(1);
  });

  it('drops a result that lands after reset, and reset itself deletes nothing', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    coordinator.reset();
    expect(coordinator.state()).toEqual({ kind: 'clear' });
    await h.resolve(0, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    expect(coordinator.state()).toEqual({ kind: 'clear' });
    expect(h.forgetIf).not.toHaveBeenCalled();
  });

  it('drops a retry result that lands after a newer visit began', async () => {
    const h = harness();
    const coordinator = coordinatorOver(h);
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'unavailable' });
    coordinator.retry();
    coordinator.begin({ ...VISIT, uid: 'user-b' });
    await h.resolve(1, { ok: false, reason: 'invitation-unavailable' });
    expect(coordinator.state()).toEqual({ kind: 'pending', captureId: 'capture-1' });
    expect(h.forgetIf).not.toHaveBeenCalled();
  });
});

describe('subscription', () => {
  it('publishes every transition in order and stops after unsubscribe', async () => {
    const h = harness();
    const coordinator = createAdmissionCoordinator(h.deps);
    const seen: string[] = [];
    const stop = coordinator.subscribe((state) => seen.push(state.kind));
    coordinator.begin(VISIT);
    await h.resolve(0, { ok: false, reason: 'unavailable' });
    coordinator.retry();
    await h.resolve(1, { ok: true, eventId: 'summer-camp-2026', outcome: 'membership-created' });
    expect(seen).toEqual(['pending', 'retryable', 'pending', 'admitted']);
    stop();
    coordinator.reset();
    expect(seen).toEqual(['pending', 'retryable', 'pending', 'admitted']);
  });
});
