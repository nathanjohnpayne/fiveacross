import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { resetPostUpdateDealGraceForTest } from '../postUpdateDeal';

// Covers the #519 post-update deal grace: a service-worker update reload lands on a
// document whose auth/Firestore handshake is still in flight, the first deal fails
// transiently, and the player is handed the full-screen DealError seconds after being
// told the reload takes two seconds. These are RTL-jsdom integration tests against the
// REAL AuthProvider, because the property the issue asks for — "a player never sees
// DealError on the first render after a controller change" — is a property of the wired
// deal path, not of any one function: it holds only if `dealError` is never SET, which
// no post-hoc retry watcher could achieve.

const CONN_ERR = 'network request failed'; // classified 'connection' → transient
const POOL_ERR = 'dealBoard needs at least 24 prompts, received 5.'; // isPoolShortfall

const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  ensureUserProfile: vi.fn(),
  attestAdult: vi.fn(),
  readAdultAttestation: vi.fn(),
  readAdultAttestationFromCache: vi.fn(),
  hasCachedBoard: vi.fn(),
  hasCachedCard: vi.fn(),
  joinAndDeal: vi.fn(),
  track: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: vi.fn().mockResolvedValue(null),
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
  GoogleAuthProvider: class {},
}));
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {} }));
// The shell watchers AuthProvider mounts beside the tree are irrelevant here; stubbing
// PoolRecoveryWatcher also keeps this suite off the live pool subscription (#70 owns it).
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

const FAKE_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };

let emitAuth: (u: unknown) => unknown = () => {};
// Latched during RENDER, so a DealError that appeared for a single committed frame and
// was then retried away still fails the assertion — "never sees it" means never, not
// "not by the time the test looked".
let sawDealError = false;

function Harness() {
  const { dealError, dealing } = useAuth();
  if (dealError) sawDealError = true;
  return (
    <div>
      {dealError ? <p role="alert">{dealError}</p> : null}
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
    </div>
  );
}

const mount = () => render(<AuthProvider><Harness /></AuthProvider>);
const signInUser = () => act(async () => void (await emitAuth(FAKE_USER)));

/** The `navigator.serviceWorker` stand-in: a bare EventTarget is enough, because the
 *  grace only ever listens for `controllerchange` on the container. */
let swContainer: EventTarget;
function installServiceWorkerContainer() {
  swContainer = new EventTarget();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: swContainer });
}
/** The update taking effect: the new worker claims the page. In production workbox
 *  reloads on this same event — the reload the grace has to survive. */
const controllerChange = () => act(() => void swContainer.dispatchEvent(new Event('controllerchange')));

function setNavigatorOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: v });
}

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  sawDealError = false;
  resetPostUpdateDealGraceForTest();
  installServiceWorkerContainer();
  setNavigatorOnline(true);
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  // Signed in and server-attested, so the deal is authorized to fire (#117).
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.readAdultAttestation.mockResolvedValue(1);
  mocks.hasCachedBoard.mockResolvedValue(false);
  // No cached card: the #403 swallow is what covers a RETURNING player, so the grace is
  // only ever load-bearing for someone with nothing to fall back on. Every case here is
  // that player — otherwise the assertions would be proving #403, not #519.
  mocks.hasCachedCard.mockResolvedValue(false);
});

afterEach(() => {
  setNavigatorOnline(true);
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('post-update deal grace (#519)', () => {
  it('never renders DealError on the first deal after a controller change — it re-deals silently', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(CONN_ERR)).mockResolvedValueOnce(true);
    mount();
    await controllerChange();
    await signInUser();

    // The failed deal was retried in place and the second attempt dealt the board.
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('dealing')).toHaveTextContent('idle'));
    expect(sawDealError).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces the same failure immediately when no controller change preceded it', async () => {
    mocks.joinAndDeal.mockRejectedValue(new Error(CONN_ERR));
    mount();
    await signInUser();

    // No grace was ever armed, so the very first failure is the player's to see —
    // this is the control that proves the case above is the grace and not a blanket
    // "retry every transient deal failure once".
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('carries the arming across the reload the controller change triggers', async () => {
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(CONN_ERR)).mockResolvedValueOnce(true);
    // Document 1: the banner's Reload activates the worker and workbox reloads.
    const first = mount();
    await controllerChange();
    first.unmount();
    // Document 2 is a fresh module registry — sessionStorage is the only thing that
    // crosses, which is exactly what the marker is for.
    resetPostUpdateDealGraceForTest();
    mount();
    await signInUser();

    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    expect(sawDealError).toBe(false);
    // The marker is read-and-cleared, so a THIRD document does not inherit the grace.
    expect(sessionStorage.getItem('gcb:post-update-reload')).toBeNull();
  });

  it('spends the grace exactly once — a second failure surfaces instead of looping', async () => {
    mocks.joinAndDeal.mockRejectedValue(new Error(CONN_ERR));
    mount();
    await controllerChange();
    await signInUser();

    // Attempt 1 fails and is graced; attempt 2 fails with the grace spent, so the
    // error surfaces and no third attempt is made.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('dealing')).toHaveTextContent('idle'));
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);
  });

  it('does not spend the grace on an offline failure — the retry surface comes up straight away', async () => {
    // Online at mount (so the deal fires), offline by the time it fails: the state a
    // player on a dead connection is actually in. A genuine offline failure must not
    // buy a second doomed attempt before the player is told.
    mocks.joinAndDeal.mockImplementationOnce(() => {
      setNavigatorOnline(false);
      return Promise.reject(new Error(CONN_ERR));
    });
    mount();
    await controllerChange();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('leaves the grace armed for a pool-shortfall failure, which has its own recovery', async () => {
    // A thin pool is not a startup race: it surfaces its own copy and is recovered by
    // the #70 pool watcher. Re-dealing against it would just fail again, so the grace
    // must still be there for a later transient failure.
    mocks.joinAndDeal.mockRejectedValueOnce(new Error(POOL_ERR)).mockResolvedValueOnce(true);
    mount();
    await controllerChange();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/24 a card needs/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });
});
