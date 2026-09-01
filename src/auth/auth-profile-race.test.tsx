import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

// Covers specs/auth-profile-race.md — the profileReady bootstrap-settled signal.
// Mock the Firebase boundary so the REAL AuthProvider runs under jsdom, and stub
// the data layer so ensureUserProfile's settle timing is test-controlled (#77).
const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  ensureUserProfile: vi.fn(),
  attestAdult: vi.fn(),
  readAdultAttestation: vi.fn(),
  readAdultAttestationFromCache: vi.fn(),
  joinAndDeal: vi.fn(),
  track: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: vi.fn().mockResolvedValue(null),
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: vi.fn(),
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
}));
vi.mock('../firebase', () => ({ auth: {}, EVENT_ID: 'test-event', googleProvider: {} }));
// AuthProvider now mounts the confirm-path listener (#41) beside the attestation
// gate; stub it — this suite exercises the profile-bootstrap signal, not the listener.
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
// The #479 retraction fall observer mounts beside it — same stub, same reason.
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
// It also mounts the pool-recovery watcher (#70) beside the gate; stub it too — this
// suite is not about the watcher (its own suite is src/components/w1-deal-auto-retry.test.tsx).
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));
vi.mock('../data/api', () => ({
  ensureUserProfile: mocks.ensureUserProfile,
  attestAdult: mocks.attestAdult,
  // AuthContext's authority read is server-only now (#117 r6); same spy.
  readAdultAttestationFromServer: mocks.readAdultAttestation,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: vi.fn().mockResolvedValue(true),
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));

const FAKE_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };
const OTHER_USER = { uid: 'sailor-2', displayName: 'Other', photoURL: null };

// The auth-state callback AuthProvider registers; emitting a User through it
// simulates Firebase resolving the Google popup / an account switch.
let emitAuth: (u: unknown) => unknown = () => {};

// A promise whose settlement the test drives, to hold ensureUserProfile's
// bootstrap in flight so profileReady's false→true transition is observable.
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => (settle = res));
  return { promise, settle };
}

// Surfaces the two context fields under test.
function Probe() {
  const { user, profileReady } = useAuth();
  return (
    <div>
      <span data-testid="ready">{profileReady ? 'ready' : 'pending'}</span>
      <span data-testid="uid">{user?.uid ?? 'none'}</span>
    </div>
  );
}

// A profile-writing consumer that gates its save on profileReady — the exact
// pattern the issue's fix enables: it cannot save before the bootstrap settles.
function GatedSaver({ onSave }: { onSave: () => void }) {
  const { user, profileReady } = useAuth();
  return (
    <button disabled={!user || !profileReady} onClick={onSave}>
      Save name
    </button>
  );
}

// Fire the auth callback and flush its synchronous state updates WITHOUT
// awaiting the callback (its ensureUserProfile is a deferred we settle later).
const signIn = (u: unknown) =>
  act(async () => {
    void emitAuth(u);
  });

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  // profileReady is the subject here, not attestation — read the User as already
  // attested so the #23 re-prompt gate never intercepts the Probe / GatedSaver.
  // The cache-first read (#115) misses under jsdom, so the online server read is
  // what settles the gate — keeping profileReady's settle timing tied to the
  // ensureUserProfile deferred these tests drive.
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.readAdultAttestation.mockResolvedValue(1);
  mocks.attestAdult.mockResolvedValue(undefined);
  mocks.joinAndDeal.mockResolvedValue(undefined);
  mocks.signInWithPopup.mockResolvedValue({});
  mocks.signOut.mockResolvedValue(undefined);
});

describe('AuthContext profileReady bootstrap-settled signal (#77)', () => {
  it('is false while ensureUserProfile is in flight and true once it settles', async () => {
    const boot = deferred<void>();
    mocks.ensureUserProfile.mockReturnValueOnce(boot.promise);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // Sign-in published the User; its ensureUserProfile bootstrap is still in flight.
    await signIn(FAKE_USER);
    expect(screen.getByTestId('uid')).toHaveTextContent('sailor-1');
    expect(screen.getByTestId('ready')).toHaveTextContent('pending');

    // The bootstrap settles → profileReady flips true.
    await act(async () => {
      boot.settle();
      await boot.promise;
    });
    expect(screen.getByTestId('ready')).toHaveTextContent('ready');
  });

  it('re-arms on an account switch and a retired bootstrap cannot settle the new account', async () => {
    const bootA = deferred<void>();
    const bootB = deferred<void>();
    mocks.ensureUserProfile.mockReturnValueOnce(bootA.promise).mockReturnValueOnce(bootB.promise);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // Account A signs in; its bootstrap is left in flight.
    await signIn(FAKE_USER);
    expect(screen.getByTestId('ready')).toHaveTextContent('pending');

    // Account B signs in before A's bootstrap settled — profileReady re-arms.
    await signIn(OTHER_USER);
    expect(screen.getByTestId('uid')).toHaveTextContent('sailor-2');
    expect(screen.getByTestId('ready')).toHaveTextContent('pending');

    // A's retired bootstrap resolves late — it must NOT flip profileReady true for B.
    await act(async () => {
      bootA.settle();
      await bootA.promise;
    });
    expect(screen.getByTestId('ready')).toHaveTextContent('pending');

    // B's own bootstrap settles — now profileReady is true, for B.
    await act(async () => {
      bootB.settle();
      await bootB.promise;
    });
    expect(screen.getByTestId('ready')).toHaveTextContent('ready');
    expect(screen.getByTestId('uid')).toHaveTextContent('sailor-2');
  });

  it('a consumer gated on profileReady cannot save before the bootstrap settles', async () => {
    const boot = deferred<void>();
    mocks.ensureUserProfile.mockReturnValueOnce(boot.promise);
    const onSave = vi.fn();
    render(
      <AuthProvider>
        <GatedSaver onSave={onSave} />
      </AuthProvider>,
    );

    await signIn(FAKE_USER);

    // Bootstrap in flight → the save is gated and cannot fire.
    const button = screen.getByRole('button', { name: 'Save name' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onSave).not.toHaveBeenCalled();

    // Bootstrap settled → the save is enabled and fires.
    await act(async () => {
      boot.settle();
      await boot.promise;
    });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
