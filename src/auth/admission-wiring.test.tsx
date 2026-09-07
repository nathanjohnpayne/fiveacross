// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
// The mocked module instance: the connectivity handlers read `auth.currentUser`.
import { auth as mockedAuth } from '../firebase';
import type { PendingEventInvitationRecord } from '../pendingEventInvitation';
import type { RedeemEventInvitationResult } from '../data/eventInvitations';

// The ordering contract (specs/event-invitations.md § ordering) wired into
// AuthContext: sign-in, authority, Invitation redemption, THEN joinAndDeal.
// `admissionCoordinator.test.ts` proves the decision table; this suite proves
// the deal effect actually waits on it, that Retry reaches the coordinator,
// and that an account change retires a redemption still in flight.

const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  getRedirectResult: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  ensureUserProfile: vi.fn(),
  attestAdult: vi.fn(),
  readAdultAttestation: vi.fn(),
  readAdultAttestationFromCache: vi.fn(),
  hasCachedBoard: vi.fn(),
  hasCachedCard: vi.fn(),
  joinAndDeal: vi.fn(),
  track: vi.fn(),
  readPendingEventInvitation: vi.fn(),
  forgetPendingEventInvitationIf: vi.fn(),
  redeemEventInvitation: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: mocks.onAuthStateChanged,
  getRedirectResult: mocks.getRedirectResult,
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: mocks.signInWithRedirect,
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
}));
const eventScope = vi.hoisted(() => ({ eventId: 'event-a' }));
vi.mock('../firebase', () => ({
  auth: {},
  googleProvider: {},
  get EVENT_ID() {
    return eventScope.eventId;
  },
}));
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));
vi.mock('../data/api', () => ({
  ensureUserProfile: mocks.ensureUserProfile,
  attestAdult: mocks.attestAdult,
  readAdultAttestationFromServer: mocks.readAdultAttestation,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: mocks.hasCachedBoard,
  hasCachedCard: mocks.hasCachedCard,
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));
vi.mock('../pendingEventInvitation', () => ({
  readPendingEventInvitation: mocks.readPendingEventInvitation,
  forgetPendingEventInvitationIf: mocks.forgetPendingEventInvitationIf,
}));
vi.mock('../data/eventInvitations', () => ({
  redeemEventInvitation: mocks.redeemEventInvitation,
}));

const CODE = 'Q'.repeat(43);
const USER_A = { uid: 'sailor-a', displayName: 'Sailor A', photoURL: null };
const USER_B = { uid: 'sailor-b', displayName: 'Sailor B', photoURL: null };

function record(): PendingEventInvitationRecord {
  return {
    captureId: 'capture-1',
    captureOrdinal: 0,
    code: CODE,
    origin: window.location.origin,
    capturedAt: 1_000,
  };
}

let emitAuth: (u: unknown) => unknown = () => {};

function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => (settle = res));
  return { promise, settle };
}

function Harness() {
  const { admission, dealing, retryDeal } = useAuth();
  return (
    <div>
      <span data-testid="admission">{JSON.stringify(admission)}</span>
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      <button onClick={retryDeal}>retry deal</button>
    </div>
  );
}

function mount() {
  return render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
}

function goOffline() {
  vi.stubGlobal('navigator', { ...window.navigator, onLine: false });
  window.dispatchEvent(new Event('offline'));
}

function goOnline() {
  vi.stubGlobal('navigator', { ...window.navigator, onLine: true });
  window.dispatchEvent(new Event('online'));
}

async function signInUser(user: unknown = USER_A) {
  await act(async () => void (await emitAuth(user)));
}

function admissionKind(): string {
  return (JSON.parse(screen.getByTestId('admission').textContent ?? '{}') as { kind: string }).kind;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (mockedAuth as { currentUser?: unknown }).currentUser;
  eventScope.eventId = 'event-a';
  emitAuth = () => {};
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.readAdultAttestation.mockResolvedValue(1);
  mocks.hasCachedBoard.mockResolvedValue(false);
  mocks.hasCachedCard.mockResolvedValue(false);
  mocks.attestAdult.mockResolvedValue(undefined);
  mocks.getRedirectResult.mockResolvedValue(null);
  mocks.signOut.mockResolvedValue(undefined);
  mocks.joinAndDeal.mockResolvedValue(true);
  mocks.readPendingEventInvitation.mockReturnValue(null);
  mocks.forgetPendingEventInvitationIf.mockReturnValue(true);
});

describe('a visit with no Invitation', () => {
  it('deals exactly as before, without consulting the callable', async () => {
    mount();
    await signInUser();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(mocks.readPendingEventInvitation).toHaveBeenCalledWith({
      origin: window.location.origin,
      now: expect.any(Number),
    });
    expect(mocks.redeemEventInvitation).not.toHaveBeenCalled();
    expect(admissionKind()).toBe('clear');
  });
});

describe('a visit carrying a pending Invitation', () => {
  it('holds joinAndDeal at zero calls until the redemption succeeds, then deals once', async () => {
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    const redemption = deferred<RedeemEventInvitationResult>();
    mocks.redeemEventInvitation.mockReturnValue(redemption.promise);

    mount();
    await signInUser();

    await waitFor(() => expect(mocks.redeemEventInvitation).toHaveBeenCalledOnce());
    expect(mocks.redeemEventInvitation).toHaveBeenCalledWith({ code: CODE, expectedEventId: 'event-a' });
    expect(admissionKind()).toBe('pending');
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    // The bearer is handed to the callable and reaches nothing rendered.
    expect(screen.getByTestId('admission').textContent).not.toContain(CODE);

    await act(async () => {
      redemption.settle({ ok: true, eventId: 'event-a', outcome: 'membership-created' });
      await redemption.promise;
    });

    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(admissionKind()).toBe('admitted');
    expect(mocks.forgetPendingEventInvitationIf).toHaveBeenCalledExactlyOnceWith(record());
  });

  it('never deals for a terminally invalid Invitation, and shares the one message', async () => {
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    mocks.redeemEventInvitation.mockResolvedValue({ ok: false, reason: 'invitation-unavailable' });

    mount();
    await signInUser();

    await waitFor(() => expect(admissionKind()).toBe('blocked'));
    expect(screen.getByTestId('admission').textContent).toContain(
      'This invitation is no longer valid. Ask the organizer for a new one.',
    );
    expect(mocks.forgetPendingEventInvitationIf).toHaveBeenCalledExactlyOnceWith(record());
    // Nothing else re-runs the deal effect into a deal: give any late effect a tick.
    await act(async () => void (await Promise.resolve()));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('offers Retry on a transient failure and deals once the retry succeeds', async () => {
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    mocks.redeemEventInvitation
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
      .mockResolvedValueOnce({ ok: true, eventId: 'event-a', outcome: 'already-member' });

    mount();
    await signInUser();

    await waitFor(() => expect(admissionKind()).toBe('retryable'));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(mocks.forgetPendingEventInvitationIf).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'retry deal' }));

    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(2);
    expect(admissionKind()).toBe('admitted');
  });

  it('routes a deal Retry into the admission retry rather than past it', async () => {
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    const second = deferred<RedeemEventInvitationResult>();
    mocks.redeemEventInvitation
      .mockResolvedValueOnce({ ok: false, reason: 'rate-limited' })
      .mockReturnValueOnce(second.promise);

    mount();
    await signInUser();
    await waitFor(() => expect(admissionKind()).toBe('retryable'));

    await userEvent.click(screen.getByRole('button', { name: 'retry deal' }));

    await waitFor(() => expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(2));
    expect(admissionKind()).toBe('pending');
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('classifies the invitation the moment the account is known, before authority settles', async () => {
    // Phase 4b P1 on #1131: a cached render permission must not release the
    // shell to a visit whose invitation was never checked. Hold the bootstrap
    // unsettled so `mayDeal` stays false, and the visit is already `held`.
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    const profile = deferred<void>();
    mocks.ensureUserProfile.mockReturnValue(profile.promise);

    mount();
    // Not awaited: the auth callback's promise awaits the (deliberately
    // unsettled) profile bootstrap. Classification happens synchronously
    // inside the callback, before any of that.
    await act(async () => {
      void emitAuth(USER_A);
    });

    expect(admissionKind()).toBe('held');
    expect(mocks.redeemEventInvitation).not.toHaveBeenCalled();
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(screen.getByTestId('admission').textContent).not.toContain(CODE);

    mocks.redeemEventInvitation.mockResolvedValue({
      ok: true,
      eventId: 'event-a',
      outcome: 'membership-created',
    });
    await act(async () => {
      profile.settle();
      await profile.promise;
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(admissionKind()).toBe('admitted');
  });

  it('does not restart redemption from Retry while authority is unresolved after a reconnect', async () => {
    // Phase 4b P1 on #1131: after a transient failure, going offline retires
    // authoritative attestation; on reconnect the fresh read is in flight and
    // Retry must go through that recovery, not straight back to the callable.
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    mocks.redeemEventInvitation.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });

    mount();
    await signInUser();
    await waitFor(() => expect(admissionKind()).toBe('retryable'));

    const reread = deferred<number | null>();
    mocks.readAdultAttestation.mockReturnValue(reread.promise);
    (mockedAuth as { currentUser?: typeof USER_A }).currentUser = USER_A;
    await act(async () => {
      goOffline();
    });
    await act(async () => {
      goOnline();
    });

    // The reconnect started a fresh authority read that has not settled.
    expect(mocks.readAdultAttestation).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: 'retry deal' }));
    await act(async () => void (await Promise.resolve()));
    // Authority is unresolved: no second redemption yet.
    expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(1);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // Authority lands; the visit is still retryable, and only an explicit
    // Retry under that authority restarts the redemption.
    mocks.redeemEventInvitation.mockResolvedValueOnce({
      ok: true,
      eventId: 'event-a',
      outcome: 'membership-created',
    });
    await act(async () => {
      reread.settle(1);
      await reread.promise;
    });
    await act(async () => void (await Promise.resolve()));
    expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(1);
    expect(admissionKind()).toBe('retryable');

    await userEvent.click(screen.getByRole('button', { name: 'retry deal' }));
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(2);
  });

  it('deals exactly once for the next Event after an admitted visit switches Events', async () => {
    // Phase 4b P2 on #1131: the Event switch resets `admitted` to `clear`;
    // the deal for Event B must fire once, not once per way that `clear`
    // reaches the effect.
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    mocks.redeemEventInvitation.mockResolvedValue({
      ok: true,
      eventId: 'event-a',
      outcome: 'membership-created',
    });

    const view = mount();
    await signInUser();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledOnce());
    expect(admissionKind()).toBe('admitted');

    mocks.readPendingEventInvitation.mockReturnValue(null);
    eventScope.eventId = 'event-b';
    await act(async () => {
      view.rerender(
        <AuthProvider>
          <Harness />
        </AuthProvider>,
      );
    });
    await act(async () => void (await Promise.resolve()));
    await act(async () => void (await Promise.resolve()));

    expect(admissionKind()).toBe('clear');
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);
    expect(mocks.joinAndDeal).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'sailor-a' }), 'event-b');
  });

  it('retires a redemption still in flight when the account changes, deleting nothing', async () => {
    mocks.readPendingEventInvitation.mockReturnValue({ record: record(), durable: true });
    const first = deferred<RedeemEventInvitationResult>();
    mocks.redeemEventInvitation.mockReturnValueOnce(first.promise);

    mount();
    await signInUser(USER_A);
    await waitFor(() => expect(mocks.redeemEventInvitation).toHaveBeenCalledOnce());

    // Sign out mid-redemption; the visit is over.
    await signInUser(null);
    expect(admissionKind()).toBe('clear');

    await act(async () => {
      first.settle({ ok: true, eventId: 'event-a', outcome: 'membership-created' });
      await first.promise;
    });
    expect(mocks.forgetPendingEventInvitationIf).not.toHaveBeenCalled();
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // The next account begins its own visit and redeems for itself.
    const second = deferred<RedeemEventInvitationResult>();
    mocks.redeemEventInvitation.mockReturnValueOnce(second.promise);
    await signInUser(USER_B);
    await waitFor(() => expect(mocks.redeemEventInvitation).toHaveBeenCalledTimes(2));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });
});
