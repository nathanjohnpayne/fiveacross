import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUTH_BOOTSTRAP_TIMEOUT_MS, AuthProvider, useAuth } from './AuthContext';
import { resetPostUpdateDealGraceForTest, watchPostUpdateReload } from '../postUpdateDeal';

// Covers the #519 post-update deal grace: a service-worker update reload lands on a
// document whose auth/Firestore handshake is still in flight, the first deal fails
// transiently, and the player is handed the full-screen DealError seconds after being
// told the reload takes two seconds. These are RTL-jsdom integration tests against the
// REAL AuthProvider, because the property the issue asks for — "a player never sees
// DealError on the first render after a controller change" — is a property of the wired
// deal path, not of any one function: it holds only if `dealError` is never SET, which
// no post-hoc retry watcher could achieve.
//
// The reload loses a startup race that has TWO halves, and the Player cannot tell them
// apart: the profile/attestation bootstrap can fail before `runDeal` is ever entered,
// and it surfaces the same connection-worded DealError with the same instantly-
// succeeding Retry (Codex P2 on #719). Both halves are covered here, and so is the fact
// that they share ONE grace.

const CONN_ERR = 'network request failed'; // classified 'connection' → transient
const POOL_ERR = 'dealBoard needs at least 24 prompts, received 5.'; // isPoolShortfall
// A rules/schema failure: permanent, so it must surface on the first attempt whatever
// the grace says.
const permanentError = () =>
  Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

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
/** Same publish, but WITHOUT awaiting the fire-and-forget bootstrap — mirroring
 *  Firebase, which ignores the callback's return value. Required by the fake-timer
 *  cases below, where the bootstrap cannot settle until a timer is advanced. */
const signInUserDetached = () => act(async () => void emitAuth(FAKE_USER));

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

function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => (settle = res));
  return { promise, settle };
}

/** Stands in for what `main.tsx` does at module scope: arm the grace for this document
 *  from OUTSIDE the auth tree (Codex P2 on #719 — `ErrorBoundary` can unmount
 *  `AuthProvider` while `UpdatePrompt` lives on to offer the very update reload this
 *  has to survive). Each call is a new document; the previous one's listener goes with
 *  its document. */
let stopWatching: () => void = () => {};
function startDocument() {
  stopWatching();
  stopWatching = watchPostUpdateReload();
}

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  sawDealError = false;
  resetPostUpdateDealGraceForTest();
  installServiceWorkerContainer();
  startDocument();
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
  vi.useRealTimers();
  stopWatching();
  stopWatching = () => {};
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
    startDocument();
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

// The bootstrap half of the same race (Codex P2 on #719). `ensureUserProfile` and the
// server-only attestation read run BEFORE `runDeal` is entered and fail straight to
// `failDeal`, so a grace consulted only inside `runDeal` would leave #519's reported
// symptom — the connection-worded DealError seconds after the reload, cleared by a Retry
// that works first tap — fully intact on this path.
describe('post-update BOOTSTRAP grace (#519, Codex P2 on #719)', () => {
  it('never renders DealError when the bootstrap loses the race after a controller change', async () => {
    mocks.ensureUserProfile.mockRejectedValueOnce(new Error(CONN_ERR));
    mocks.joinAndDeal.mockResolvedValue(true);
    mount();
    await controllerChange();
    await signInUser();

    // The bootstrap repeated itself and then dealt — no error frame in between, which is
    // the property the deal-side tests above assert for their own half.
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(2);
    expect(sawDealError).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces the same bootstrap failure immediately when no controller change preceded it', async () => {
    mocks.ensureUserProfile.mockRejectedValueOnce(new Error(CONN_ERR));
    mount();
    await signInUser();

    // The control for the case above: unarmed, the bootstrap failure is the player's to
    // see on the first attempt, and no deal is authorized off a failed bootstrap.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(1);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('spends the ONE grace on whichever half fails first — the bootstrap leaves none for the deal', async () => {
    mocks.ensureUserProfile.mockRejectedValueOnce(new Error(CONN_ERR));
    mocks.joinAndDeal.mockRejectedValue(new Error(CONN_ERR));
    mount();
    await controllerChange();
    await signInUser();

    // Bootstrap: fails, claims the grace, repeats, succeeds. Deal: fails with the grace
    // already spent, so it surfaces rather than buying a second silent attempt.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(2);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('does not spend the grace on a bootstrap failure that is really offline', async () => {
    mocks.ensureUserProfile.mockImplementationOnce(() => {
      setNavigatorOnline(false);
      return Promise.reject(new Error(CONN_ERR));
    });
    mount();
    await controllerChange();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(1);
  });

  it('does not spend the grace on a PERMANENT bootstrap failure', async () => {
    // A rules/permission failure is not a startup race, and repeating it would only
    // delay the honest retry surface by another round-trip.
    mocks.ensureUserProfile.mockRejectedValueOnce(permanentError());
    mount();
    await controllerChange();
    await signInUser();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(1);
  });
});

// Where the #519 grace repeat meets the #521 provisional cache lift. Both live in
// `bootstrapUser`'s online branch and both fire on the same transient authority
// failure, so their ORDER is a behavioural choice, not an accident of the merge.
describe('the #519 grace repeat and the #521 cache lift (ordering)', () => {
  it('repeats the authority read BEFORE lifting the render gate from cache — a repeat that succeeds never consults the cache and never sets an error', async () => {
    // If the lift ran first, the Player would get a connection-worded DealError and
    // a cache-painted card for the instant it takes the repeat to land, and the
    // repeat would then clear both: a visible flicker on the happy path, and the
    // exact error frame the #519 grace exists to skip. Repeating first also means
    // the session settles on REAL authority (`attestedAuthoritative`), which the
    // provisional lift by construction can never grant — so the deal fires.
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // a stamp IS cached
    mocks.ensureUserProfile.mockRejectedValueOnce(new Error(CONN_ERR));
    mocks.joinAndDeal.mockResolvedValue(true);
    mount();
    await controllerChange();
    await signInUser();

    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(mocks.ensureUserProfile).toHaveBeenCalledTimes(2);
    // The cache was never reached: the repeat landed first and settled authority.
    expect(mocks.readAdultAttestationFromCache).not.toHaveBeenCalled();
    expect(sawDealError).toBe(false);
  });

  it('does not surface the repeat’s failure over an authority read that landed late while it was in flight', async () => {
    // The interaction the grace repeat newly makes reachable: the FIRST read's
    // answer is orphaned by the timeout but not cancelled, so it can land during
    // the repeat. Authority is terminal for the attempt — once it has applied a
    // definite server answer (and cleared the error, and licensed the deal), the
    // repeat's own timeout must not paint a DealError back over it.
    vi.useFakeTimers();
    const first = deferred<number | null>();
    const repeat = deferred<number | null>();
    mocks.readAdultAttestation.mockReturnValueOnce(first.promise).mockReturnValueOnce(repeat.promise);
    mocks.joinAndDeal.mockResolvedValue(true);
    mount();
    await controllerChange();
    await signInUserDetached();

    // The first read times out; the grace claims and starts the repeat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });
    expect(mocks.readAdultAttestation).toHaveBeenCalledTimes(2);

    // The ORPHANED first read now lands, confirming the stamp: authority granted,
    // the deferred deal fires.
    await act(async () => {
      first.settle(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // …and only THEN does the repeat time out. It must be a no-op.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });
    expect(sawDealError).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    repeat.settle(null); // drain the orphan so no unhandled promise leaks
  });
});

const readRepoFile = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('where the #519 watcher is mounted (Codex P2 on #719)', () => {
  it('arms the grace at module scope in main.tsx, outside the crashable auth tree', () => {
    // `ErrorBoundary` wraps ONLY `AuthProvider` on purpose (src/main.tsx, src/components/
    // ErrorBoundary.tsx): a crash must not take `UpdatePrompt` down with it, because that
    // component is the only in-app caller of `updateServiceWorker(true)` — the only way a
    // client moves off a broken build. So a player CAN take the update with the auth tree
    // unmounted, and a watcher living in that tree would already be gone: no marker
    // written, no grace in the incoming document, the recovery reload uncovered. This is a
    // static scan because the failure is structural — no render can exhibit a listener
    // that was never registered.
    const main = readRepoFile('../main.tsx');
    expect(main).toMatch(/^watchPostUpdateReload\(\);$/m);
    expect(main.indexOf('watchPostUpdateReload();')).toBeLessThan(main.indexOf('<ErrorBoundary>'));
    expect(readRepoFile('./AuthContext.tsx')).not.toMatch(/watchPostUpdateReload/);
  });
});
