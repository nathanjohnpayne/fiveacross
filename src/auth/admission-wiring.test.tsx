// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
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
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {}, EVENT_ID: 'event-a' }));
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
  const { admission, dealing, retryAdmission, retryDeal } = useAuth();
  return (
    <div>
      <span data-testid="admission">{JSON.stringify(admission)}</span>
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      <button onClick={retryAdmission}>retry admission</button>
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

async function signInUser(user: unknown = USER_A) {
  await act(async () => void (await emitAuth(user)));
}

function admissionKind(): string {
  return (JSON.parse(screen.getByTestId('admission').textContent ?? '{}') as { kind: string }).kind;
}

beforeEach(() => {
  vi.clearAllMocks();
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

    await userEvent.click(screen.getByRole('button', { name: 'retry admission' }));

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
