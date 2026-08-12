import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUTH_BOOTSTRAP_TIMEOUT_MS, AuthProvider, useAuth } from './AuthContext';

// Covers specs/x-offline-cold-boot.md — the connectivity/attestation state
// machine (#115). The cache lifts the 18+ gate PROVISIONALLY offline so the app
// cold-boots from the persistent cache without awaiting the network; the server
// read is AUTHORITATIVE when it arrives (online sessions stay gated until it
// settles, and it downgrades a stale cache lift); and the deferred deal fires on
// reconnect. Mocks the Firebase + data-layer boundary so the REAL AuthProvider
// runs under jsdom, with connectivity driven by hand.
const mocks = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  ensureUserProfile: vi.fn(),
  attestAdult: vi.fn(),
  // The SERVER-only authority read (#117 r6, getDocFromServer) and the cache-first
  // RENDER read (getDocFromCache) are DISTINCT spies here, so a test can prove deal
  // authority never comes from cache. `readAdultAttestation` is the OLD cache-capable
  // getDoc reader the fix moved OFF the authority path — modelled as a separate spy
  // so the round-6 test can pin that a cache-served stamp (this spy) does NOT
  // authorize a deal when the SERVER read disagrees (it fails on the pre-fix code,
  // which read authority from this cache-capable getDoc).
  readAdultAttestation: vi.fn(),
  readAdultAttestationFromServer: vi.fn(),
  readAdultAttestationFromCache: vi.fn(),
  hasCachedBoard: vi.fn(),
  hasCachedCard: vi.fn(),
  joinAndDeal: vi.fn(),
  track: vi.fn(),
  // Mutable so the reconnect handler / attest() read the signed-in User (Firebase
  // restores the persisted User offline).
  auth: { currentUser: null as unknown },
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: vi.fn().mockResolvedValue(null),
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: vi.fn(),
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
}));
vi.mock('../firebase', () => ({ auth: mocks.auth, googleProvider: {} }));
vi.mock('../data/api', () => ({
  ensureUserProfile: mocks.ensureUserProfile,
  attestAdult: mocks.attestAdult,
  readAdultAttestation: mocks.readAdultAttestation,
  readAdultAttestationFromServer: mocks.readAdultAttestationFromServer,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: mocks.hasCachedBoard,
  hasCachedCard: mocks.hasCachedCard,
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));
// AuthProvider renders <ConfirmWinMoments/> for a signed-in User (#116); it reads
// the Firestore `db` this suite deliberately does not wire, so stub it out — this
// suite is about the auth/attestation state machine, not the win-moment surface
// (mirrors the sibling AuthContext / auth-profile-race suites).
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
// The #479 retraction fall observer mounts beside it — same stub, same reason.
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
// It also mounts the pool-recovery watcher (#70), which reads the same unwired `db`;
// stub it too — this suite is the auth/attestation state machine, not the watcher (its
// own suite is src/components/w1-deal-auto-retry.test.tsx).
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));

const RETURNING_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };

// The auth-state callback AuthProvider registers; emitting a User through it
// simulates Firebase restoring the persisted account on a cold boot.
let emitAuth: (u: unknown) => unknown = () => {};

// Never settles — models a Firestore TRANSACTION offline: ensureUserProfile does
// not queue, so awaiting it on the render path is what stuck the old app on
// "Loading…" forever.
const NEVER = new Promise<void>(() => {});

function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => (settle = res));
  return { promise, settle };
}

// The two failure SHAPES the bootstrap has to tell apart. Firestore rejects with a
// `FirebaseError` carrying a `code`, and AuthContext classifies on that code — so
// these model the real thing rather than a bare `new Error(message)`, whose
// classification would fall through to the uncoded message regex instead.
const unreachable = () =>
  Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'unavailable' });
const permanent = () =>
  Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

// `loading` is App.tsx's Board gate (App renders "Loading…" while loading is true,
// the Board only once it is false), so a unit test can read it as the proxy for
// "would the Board render?". `board` renders only when the re-prompt gate is DOWN;
// when it is up, AuthProvider renders <SignIn/> in its place. signIn/attest are
// captured to drive the same-session optimistic-attest path (#112 Finding 3).
let ctxSignIn: (acknowledgedAdultContent: boolean) => Promise<void> = async () => {};
let ctxRetryDeal: () => void = () => {};
let ctxAttest: () => Promise<void> = async () => {};
function Probe() {
  const { user, loading, dealError, dealing, signIn, retryDeal, attest, canRenderEventContent } =
    useAuth();
  ctxSignIn = signIn;
  ctxRetryDeal = retryDeal;
  ctxAttest = attest;
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="uid">{user?.uid ?? 'none'}</span>
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      {dealError ? <p role="alert">{dealError}</p> : null}
      <span data-testid="board">board</span>
      <span data-testid="authority">{canRenderEventContent ? 'may-render' : 'withheld'}</span>
    </div>
  );
}

// Held on the App "Loading…" gate ⇔ the Board would NOT render (App.tsx returns
// "Loading…" while `loading`). The offline-unknown state (finding B).
const boardHeld = () => screen.getByTestId('loading').textContent === 'loading';
const boardRendered = () => screen.getByTestId('loading').textContent === 'ready';
// App.tsx renders the DealError panel over the Board whenever dealError is set, so
// a stale error observed here means the Board would NOT render (round 4).
const dealErrorShown = () => screen.queryByRole('alert') !== null;
// `canRenderEventContent` is the App.tsx authority boundary (#521): App.tsx
// returns the full-screen DealError and withholds the whole Event — including
// any durable cached card — whenever this is false, regardless of dealError.
// `queryBy`, not `getBy`: when the re-prompt gate is UP, AuthProvider renders
// <SignIn/> in place of `children`, so the Probe is unmounted entirely — which is
// itself "the Event is not rendering", not a missing element.
const mayRenderEventContent = () => screen.queryByTestId('authority')?.textContent === 'may-render';
// `dealing` drives the DealError Retry button's disabled/"Dealing…" state — stuck
// true would leave Retry unusable through a supersede (round 5, finding B).
const dealingActive = () => screen.getByTestId('dealing').textContent === 'dealing';

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

// Simulate a mid-bootstrap connectivity LOSS: flip the probe and dispatch the
// browser 'offline' event AuthProvider listens on.
const goOffline = () =>
  act(async () => {
    setOnline(false);
    window.dispatchEvent(new Event('offline'));
  });

const mount = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

// Fire the auth callback and flush its SYNCHRONOUS publish WITHOUT awaiting the
// fire-and-forget bootstrap — mirroring Firebase, which ignores the callback's
// return value. Tests that need the bootstrap to have progressed use waitFor.
const coldBoot = (u: unknown) =>
  act(async () => {
    mocks.auth.currentUser = u;
    void emitAuth(u);
  });

// Simulate the network returning: flip the connectivity probe and dispatch the
// browser 'online' event AuthProvider listens on.
const reconnect = () =>
  act(async () => {
    setOnline(true);
    window.dispatchEvent(new Event('online'));
  });

const rePromptShown = () => screen.queryByText(/One quick thing/i) !== null;

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  ctxSignIn = async () => {};
  ctxAttest = async () => {};
  mocks.auth.currentUser = null;
  setOnline(true);
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  mocks.readAdultAttestationFromServer.mockResolvedValue(1);
  // Default the OLD cache-capable reader to the SAME value so it never TypeErrors
  // if the pre-fix code path is exercised in a stash comparison; the round-6 test
  // sets it distinctly to model getDoc serving a stale cached stamp.
  mocks.readAdultAttestation.mockResolvedValue(1);
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.hasCachedBoard.mockResolvedValue(false); // default: no local board (first-time)
  mocks.hasCachedCard.mockResolvedValue(false); // default: no cached card either (#403)
  mocks.attestAdult.mockResolvedValue(undefined);
  mocks.joinAndDeal.mockResolvedValue(undefined);
  mocks.signInWithPopup.mockResolvedValue({});
  mocks.signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe('offline cold boot (#115)', () => {
  it('releases an ONLINE bootstrap that never settles to a retryable error instead of loading forever', async () => {
    vi.useFakeTimers();
    setOnline(true);
    mocks.ensureUserProfile.mockReturnValue(NEVER);

    mount();
    await coldBoot(RETURNING_USER);

    expect(boardHeld()).toBe(true);
    expect(dealErrorShown()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });

    expect(boardRendered()).toBe(true);
    expect(dealErrorShown()).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent(/check your connection and retry/i);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('publishes the User and settles loading:false without awaiting the network transaction', async () => {
    // Offline: ensureUserProfile (a transaction) would never resolve; the cached
    // stamp settles the returning User attested.
    setOnline(false);
    mocks.ensureUserProfile.mockReturnValue(NEVER);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);

    mount();
    await coldBoot(RETURNING_USER);

    // The shell renders NOW, from the cache — not stuck on "Loading…".
    expect(screen.getByTestId('loading')).toHaveTextContent('ready');
    expect(screen.getByTestId('uid')).toHaveTextContent('sailor-1');
    expect(screen.getByTestId('board')).toBeInTheDocument();
    // The transaction was never even reached offline — it is deferred, not awaited.
    expect(mocks.ensureUserProfile).not.toHaveBeenCalled();
    // A deal is a network-bound create path; it must not fire offline.
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(rePromptShown()).toBe(false);
  });

  it('finding B: an ONLINE un-attested session stays gated on Loading until the server read settles, THEN re-prompts', async () => {
    // Online: the authoritative read is held in flight.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    const read = deferred<number | null>();
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);

    // While the read is in flight the app is GATED: App would show "Loading…",
    // NOT the Board (loading still true), and no re-prompt has flashed.
    expect(screen.getByTestId('loading')).toHaveTextContent('loading');
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // The server says NO stamp → the gate resolves to a re-prompt, loading released.
    await act(async () => {
      read.settle(null);
      await read.promise;
    });
    // The re-prompt appearing (needsAttestation requires profileReady) implies the
    // gate settled and loading was released; the Probe is now unmounted behind it.
    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('finding B (offline half): a cache-attested returning User renders the cached Board immediately offline', async () => {
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // cached: attested
    mocks.ensureUserProfile.mockReturnValue(NEVER);

    mount();
    await coldBoot(RETURNING_USER);

    // Rendered immediately from cache — loading released, no gate, no deal offline.
    await waitFor(() => expect(screen.getByTestId('board')).toBeInTheDocument());
    expect(screen.getByTestId('loading')).toHaveTextContent('ready');
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('finding C + round-2 P1: no deal fires on the PROVISIONAL cache attestation during the reconnect window; deals exactly once after the authoritative read CONFIRMS', async () => {
    // Offline cold boot: attested from cache, but this is a FRESH Event so
    // joinAndDeal has real work (boards are per-Event). The authoritative read is
    // HELD in flight across the reconnect so the online-flip deal effect runs
    // while `attested` is still the provisional cache value — the exact window the
    // round-2 P1 closes. On the buggy code the deal fires here (only online was
    // gated); with the authority gate it must not.
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled(); // offline never deals
    expect(rePromptShown()).toBe(false);

    // Reconnect: `online` flips true but the authoritative read is STILL pending —
    // the deal must NOT fire on the provisional attestation.
    await reconnect();
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // The authoritative read CONFIRMS the stamp → the deferred deal fires once.
    await act(async () => {
      read.settle(1);
      await read.promise;
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });

  it('finding D + round-2 P1: a HELD authoritative read that returns NO stamp downgrades the stale cache lift to a re-prompt, and never deals — not even in the reconnect window', async () => {
    // Offline: a STALE cached stamp provisionally lifts the gate. The server row
    // now has NO stamp (owner deleted/recreated it). The read is held in flight so
    // the online-flip effect runs on the provisional value: no deal must fire
    // (round-2 P1), and the settled null must downgrade to a re-prompt.
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);
    expect(rePromptShown()).toBe(false); // provisionally attested offline

    await reconnect();
    // In the window before the authoritative read settles, NO durable rows are
    // created for this (server-)un-attested User.
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    await act(async () => {
      read.settle(null);
      await read.promise;
    });
    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('#112 preserved: a same-session optimistic attest stays sticky even when the server read returns no stamp', async () => {
    // A first-time sign-in this session records the uid in attestedUidsRef and
    // flips attested true optimistically; a later auth callback whose server read
    // does not yet see the write must NOT downgrade it.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(null); // stale: attest txn not visible yet

    mount();
    mocks.auth.currentUser = RETURNING_USER;
    await act(async () => {
      await ctxSignIn(true); // signInWithPopup → attest(): sticky + optimistic true
    });
    await coldBoot(RETURNING_USER);

    // The stale server null does NOT re-prompt — the same-session attest is sticky.
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalled());
    expect(rePromptShown()).toBe(false);
  });

  it('finding B: offline cold boot with NO cached attestation does NOT render the Board — it HOLDS (never fail-open), then reconnect settles a definite re-prompt with no deal', async () => {
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockReturnValue(NEVER);

    mount();
    await coldBoot(RETURNING_USER);

    // No proof of 18+ (cache miss) → the Board is HELD behind the App Loading gate,
    // NOT rendered; and it never assumes attested — no deal, no re-prompt offline.
    expect(boardHeld()).toBe(true);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(rePromptShown()).toBe(false);

    // Reconnect with a server that reports a genuinely UN-attested profile: the
    // gate HOLDS as a definite re-prompt, never a fail-open deal, loading released.
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(null);
    await reconnect();

    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('finding A (round 4): an OFFLINE retry settles CACHE-FIRST without awaiting the transaction bootstrap (no hang), never deals; an ONLINE retry runs the full bootstrap + deal', async () => {
    // Offline cold boot, cache-attested. ensureUserProfile is a NEVER promise —
    // the offline Firestore transaction that does not queue. If the retry routed
    // into retryBootstrap it would await this and HANG in "Dealing…"; the fix
    // routes it to the cache-first path, which never touches the transaction.
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockReturnValue(NEVER);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);

    mount();
    await coldBoot(RETURNING_USER);
    expect(boardRendered()).toBe(true); // cache-attested → Board renders offline
    expect(mocks.ensureUserProfile).not.toHaveBeenCalled(); // offline never awaits the txn

    await act(async () => {
      ctxRetryDeal();
    });
    // OFFLINE retry → cache-first: NO transaction awaited, NO deal, still rendered
    // (retryable) — never a hang.
    expect(mocks.ensureUserProfile).not.toHaveBeenCalled();
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(boardRendered()).toBe(true);

    // Reconnect ONLINE: now the full transaction bootstrap runs and the deal fires
    // once; and an ONLINE retry re-deals in place.
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    await reconnect();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(mocks.ensureUserProfile).toHaveBeenCalled(); // online path runs the txn
    await act(async () => {
      ctxRetryDeal();
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
  });

  it('finding B (round 4): an online deal error, then going OFFLINE with a cached attestation, CLEARS the stale error and renders the cached Board (not the error panel)', async () => {
    // Online: the bootstrap succeeds but the DEAL fails → dealError is set, so
    // App.tsx would render the DealError panel over the Board.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    mocks.joinAndDeal.mockRejectedValue(new Error('network request failed'));

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(dealErrorShown()).toBe(true)); // online deal failed → error panel

    // Go OFFLINE with a cached attestation: the cache-first success proves 18+ and
    // must CLEAR the stale dealError so the cached Board renders, not the panel.
    await goOffline();
    await waitFor(() => expect(dealErrorShown()).toBe(false));
    expect(boardRendered()).toBe(true);
  });

  it('finding C: an ONLINE bootstrap that loses connectivity mid-flight is SUPERSEDED — loading releases via the cache path (not stranded), and the late online resolution cannot clobber it', async () => {
    // Online boot with the authoritative bootstrap held in flight, so loading is
    // gated. The User has a cached stamp, so the offline takeover can render.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    const ensure = deferred<void>();
    mocks.ensureUserProfile.mockReturnValue(ensure.promise); // in flight → loading gated
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);

    mount();
    await coldBoot(RETURNING_USER);
    expect(boardHeld()).toBe(true); // gated on Loading while the online read is in flight

    // Connectivity drops mid-bootstrap: the offline handler supersedes the pending
    // online attempt and releases loading via the cache-first path (cache-attested
    // → Board), rather than stranding on the transaction that may never settle.
    await goOffline();
    await waitFor(() => expect(boardRendered()).toBe(true));
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled(); // offline never deals

    // The superseded ONLINE bootstrap resolves LATE — it must not clobber the
    // newer offline state (no re-prompt, no downgrade, still rendered).
    await act(async () => {
      ensure.settle();
      await ensure.promise;
    });
    expect(boardRendered()).toBe(true);
    expect(rePromptShown()).toBe(false);

    // Reconnect settles authoritatively (server confirms) and the deal fires once.
    await reconnect();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });

  it('finding A (round 5): a PRE-offline authoritative read does not license a reconnect deal — the deal waits for the FRESH read; a server-NULL downgrades with NO rows created', async () => {
    // Online: authoritatively attested, but the deal FAILS so no board exists and
    // attestedAuthoritative is true. This is the state that, on the buggy code,
    // deals again on reconnect on the stale authority.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1); // server: attested (authoritative)
    mocks.joinAndDeal.mockRejectedValueOnce(new Error('network request failed')); // deal fails, no board

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1)); // online deal fired + failed

    // Dead zone: the users/{uid} stamp is deleted server-side while offline.
    await goOffline();

    // Reconnect with the FRESH read HELD in flight so the reconnect window is
    // observable; joinAndDeal would now "succeed" (create rows) if it fired.
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);
    mocks.joinAndDeal.mockResolvedValue(undefined);
    await reconnect();
    // The pre-offline authority must NOT license a deal in the reconnect window.
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // The fresh read returns NO stamp → downgrade to re-prompt, still no new deal
    // (no board/player rows created for the server-downgraded User).
    await act(async () => {
      read.settle(null);
      await read.promise;
    });
    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('finding A (round 5): a same-session optimistic attest keeps authority across the offline transition and DEALS on reconnect', async () => {
    // Sign in this session (attest → sticky + authoritative), no board yet.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    mocks.joinAndDeal.mockRejectedValueOnce(new Error('network request failed')); // first deal fails, no board

    mount();
    mocks.auth.currentUser = RETURNING_USER;
    await act(async () => {
      await ctxSignIn(true); // attest(): attestedUidsRef + authoritative
    });
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));

    // Offline then reconnect: the SAME-SESSION attest is durable authority, so the
    // deal fires again on reconnect (its second call succeeds, creating the board).
    mocks.joinAndDeal.mockResolvedValue(undefined);
    await goOffline();
    await reconnect();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    expect(rePromptShown()).toBe(false);
  });

  it('finding B (round 5): a retry invalidated by a mid-flight connectivity drop does not strand dealing — Retry stays usable', async () => {
    // Online bootstrap FAILS → dealError set, attestation UNKNOWN, so retryDeal
    // routes to retryBootstrap (the transaction path), which sets dealing true.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockRejectedValueOnce(new Error('network request failed'));
    mocks.readAdultAttestationFromServer.mockResolvedValue(null);

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(dealErrorShown()).toBe(true));
    expect(dealingActive()).toBe(false);

    // Tap Retry — retryBootstrap sets dealing true and holds on ensureUserProfile.
    const ensure = deferred<void>();
    mocks.ensureUserProfile.mockReturnValue(ensure.promise);
    await act(async () => {
      ctxRetryDeal();
    });
    expect(dealingActive()).toBe(true); // retry in flight

    // Connectivity drops mid-retry: the offline supersede (bumps profileAttemptRef)
    // must CLEAR dealing so the Retry button is not stuck disabled in "Dealing…".
    await goOffline();
    expect(dealingActive()).toBe(false);

    // The invalidated retry's LATE resolution must not un-clear or clobber dealing.
    await act(async () => {
      ensure.settle();
      await ensure.promise;
    });
    expect(dealingActive()).toBe(false);
  });

  it('finding A (round 6): deal AUTHORITY is SERVER-only — a cache-served stamp does NOT authorize a deal when the SERVER row has none (re-prompt, no rows); a genuine server stamp deals once', async () => {
    // Offline cold boot with a CACHED stamp → provisional render (no deal offline).
    setOnline(false);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // cache render: attested
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    // The OLD cache-capable getDoc WOULD serve this stale cached stamp as authority…
    mocks.readAdultAttestation.mockResolvedValue(1);
    // …but the SERVER row's stamp was removed while offline — server truth is NULL.
    mocks.readAdultAttestationFromServer.mockResolvedValue(null);

    mount();
    await coldBoot(RETURNING_USER);
    expect(boardRendered()).toBe(true); // provisional cache render
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // Reconnect: authority is SERVER-only, so the server-null downgrades to a
    // re-prompt and NO deal/rows are created — even though the cache still has a
    // stamp (the pre-fix code, which read authority from the cache-capable getDoc,
    // deals here).
    await reconnect();
    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('finding A (round 6): a server-UNREACHABLE authority read (throw) does not authorize a deal; a genuine server stamp deals once', async () => {
    // Online, but the server authority read THROWS (flaky: navigator online, no
    // route). getDocFromServer rejects → authority NOT established → no deal.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestation.mockResolvedValue(1); // a cache-served getDoc would attest…
    mocks.readAdultAttestationFromServer.mockRejectedValueOnce(new Error('server unreachable'));

    mount();
    await coldBoot(RETURNING_USER);
    // The throw is a bootstrap failure → no authority, no deal (deferred/retryable).
    await waitFor(() => expect(dealErrorShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // A later reconnect where the server actually returns a stamp → deals once.
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    await reconnect();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(rePromptShown()).toBe(false);
  });

  it('finding B (round 6): going offline while a deal is in flight retires it — a stale late REJECTION does NOT set dealError over the rendered cached Board', async () => {
    // Online, authoritative, cache-attested; the deal is HELD in flight.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    let rejectDeal!: (e: unknown) => void;
    const dealPromise = new Promise<void>((_res, rej) => (rejectDeal = rej));
    mocks.joinAndDeal.mockReturnValue(dealPromise); // deal in flight, will reject late

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(dealErrorShown()).toBe(false);

    // Connectivity drops mid-deal: the offline handler RETIRES the in-flight deal
    // (bumps dealAttemptRef) and the cache-first path renders the cached Board.
    await goOffline();
    await waitFor(() => expect(boardRendered()).toBe(true));

    // The stale in-flight deal now REJECTS (late) — its catch must return early on
    // the dealAttempt mismatch and NOT set dealError over the rendered cached Board
    // (the pre-fix code, which did not bump dealAttemptRef, sets the error panel).
    await act(async () => {
      rejectDeal(new Error('network request failed'));
      await dealPromise.catch(() => {});
    });
    expect(dealErrorShown()).toBe(false);
    expect(boardRendered()).toBe(true);
  });

  it('finding A (round 8): an attest whose write REJECTS grants no authority AND is not stranded — the re-prompt returns for an in-session retry; a subsequent COMMITTED attest deals once (no #112 flicker on success)', async () => {
    // Online signed-in User whose SERVER row has no stamp; the read is HELD so the
    // app is gated (Probe stays rendered → ctxAttest capturable).
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const serverRead = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(serverRead.promise);
    mocks.auth.currentUser = RETURNING_USER;

    mount();
    await coldBoot(RETURNING_USER);

    // The User attests, but the attestAdult WRITE REJECTS (permission / failed txn).
    mocks.attestAdult.mockRejectedValueOnce(new Error('permission denied'));
    await act(async () => {
      await ctxAttest();
    });
    // Deal authority is NOT granted (the write never committed) → NO deal, NO rows.
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // The held server read settles NULL. The failed attest rolled the optimistic
    // lift back (round 8 finding A), so the re-prompt RETURNS — the User is NOT
    // stranded attested-but-unauthorized on "Dealing…" — and still no deal.
    await act(async () => {
      serverRead.settle(null);
      await serverRead.promise;
    });
    await waitFor(() => expect(rePromptShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // The User re-attests in session and the write COMMITS → durable authority →
    // the deal fires exactly once (the round-5 committed-attest-deals case).
    mocks.attestAdult.mockResolvedValueOnce(undefined);
    await act(async () => {
      await ctxAttest();
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(rePromptShown()).toBe(false);
  });

  it('finding B (round 8): a reconnect that re-runs the deal for an already-boarded Player records NO join_event (existing-board no-op); an actual first join records exactly one', async () => {
    // Genuinely-new attested User, online → the FIRST deal creates a NEW board.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    mocks.joinAndDeal.mockResolvedValueOnce(true); // first call: dealt a NEW board (a join)

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(mocks.track).toHaveBeenCalledWith('join_event'); // exactly one real join
    expect(mocks.track.mock.calls.filter(([e]) => e === 'join_event')).toHaveLength(1);

    // A ship-wifi flap: offline then online. The deal effect re-fires, but the
    // board already exists so joinAndDeal no-ops (returns false) — and NO further
    // join_event is recorded (the reconnect is not a join).
    mocks.joinAndDeal.mockResolvedValue(false); // existing board → no-op
    await goOffline();
    await reconnect();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    // Still exactly ONE join_event — the reconnect no-op recorded nothing.
    expect(mocks.track.mock.calls.filter(([e]) => e === 'join_event')).toHaveLength(1);
  });

  it('online: a genuinely-new attested User still deals', async () => {
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1); // server: attested

    mount();
    await coldBoot(RETURNING_USER);

    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(rePromptShown()).toBe(false);
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });

  it('finding A (round 9): an optimistic-only attest + online server-read FAILURE gives a BOARDLESS User a Retry (not stuck on Dealing), and Retry recovers', async () => {
    // First-time User clicks 18+ (optimistic, write still PENDING so not committed),
    // then the auth callback's SERVER read REJECTS (ship/captive wifi), no board.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockRejectedValue(new Error('server unreachable'));
    mocks.hasCachedBoard.mockResolvedValue(false); // boardless (first-time)
    mocks.attestAdult.mockReturnValue(NEVER); // optimistic-only: never commits
    mocks.auth.currentUser = RETURNING_USER;

    mount();
    await act(async () => {
      void ctxAttest(); // optimistic sticky set; attestAdult pending (uncommitted)
    });
    await coldBoot(RETURNING_USER);

    // Boardless + optimistic-only + server-read failure → a retryable error, NOT a
    // silent Board with a gated-off deal that strands the User on "Dealing…".
    await waitFor(() => expect(dealErrorShown()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // Retry recovers: the server read now returns a stamp → authority → deal once.
    mocks.readAdultAttestationFromServer.mockResolvedValue(1);
    await act(async () => {
      ctxRetryDeal();
    });
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });

  it('finding A (round 9): a returning User WITH a cached board renders on an optimistic-only server-read failure (no error, no deal)', async () => {
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockRejectedValue(new Error('server unreachable'));
    mocks.hasCachedBoard.mockResolvedValue(true); // returning, has a board
    mocks.attestAdult.mockReturnValue(NEVER);
    mocks.auth.currentUser = RETURNING_USER;

    mount();
    await act(async () => {
      void ctxAttest();
    });
    await coldBoot(RETURNING_USER);

    // A boarded User renders their cached Board (no deal needed) — no error panel.
    await waitFor(() => expect(boardRendered()).toBe(true));
    expect(dealErrorShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('finding B (round 9): a redundant attest that REJECTS does NOT downgrade a server-CONFIRMED returning User (no re-prompt)', async () => {
    // Returning User with a valid SERVER stamp signs in; the bootstrap CONFIRMS the
    // stamp (attestedAuthoritative true). signIn's redundant attest() then REJECTS
    // (network drop). The confirmed attestation must survive — no re-prompt.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockResolvedValue(1); // server: confirmed attested
    mocks.hasCachedBoard.mockResolvedValue(true);
    mocks.auth.currentUser = RETURNING_USER;

    mount();
    await coldBoot(RETURNING_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalled()); // authority → deal
    expect(rePromptShown()).toBe(false);

    // The redundant attest REJECTS AFTER the server confirmed the stamp.
    mocks.attestAdult.mockRejectedValueOnce(new Error('network drop'));
    await act(async () => {
      await ctxAttest();
    });

    // The server-confirmed User is NOT rolled back to a re-prompt.
    expect(rePromptShown()).toBe(false);
  });

  it('#521: an ONLINE bootstrap whose authority reads both FAIL (navigator.onLine lied — captive/ship-Wi-Fi) falls back to the cached attestation so the durable card can paint, but grants no deal authority', async () => {
    // navigator.onLine says true, but the authority read never lands — the
    // effectively-offline-with-a-lying-probe case. Neither committedSticky nor
    // optimisticSticky applies (no in-session attest), so the pre-fix code left
    // `attested` UNKNOWN forever and App withheld the whole Event, including the
    // #434 durable card this device already holds. The cache fallback (#521)
    // proves 18+ from the SAME cached stamp the OFFLINE branch trusts.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // cached: proof of 18+
    mocks.ensureUserProfile.mockRejectedValue(unreachable());
    mocks.readAdultAttestationFromServer.mockRejectedValue(unreachable());

    mount();
    await coldBoot(RETURNING_USER);

    // The failed bootstrap still surfaces the retryable error…
    await waitFor(() => expect(dealErrorShown()).toBe(true));
    // …but the cache-first fallback lifts the render gate PROVISIONALLY, so the
    // durable card can paint instead of the full-screen DealError.
    await waitFor(() => expect(mayRenderEventContent()).toBe(true));
    // Render-only: no re-prompt (attested is not `false`) and no deal (authority
    // was never established — attestedAuthoritative stays false).
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('#521: the same double-failure with a cache MISS never lifts the render gate — the age gate does not fail open', async () => {
    // Identical failure shape, but this device has no cached attestation at all
    // (e.g. a brand-new device on the ship's captive Wi-Fi). This is the
    // important case: it proves the #521 fallback cannot be used to bypass 18+
    // verification — a miss leaves `canRenderEventContent` false, exactly like
    // before the fix.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
    mocks.ensureUserProfile.mockRejectedValue(unreachable());
    mocks.readAdultAttestationFromServer.mockRejectedValue(unreachable());

    mount();
    await coldBoot(RETURNING_USER);

    await waitFor(() => expect(dealErrorShown()).toBe(true));
    // Wait for the fallback's cache read to actually resolve (a miss) before
    // asserting the negative — otherwise a passing assertion could just mean the
    // fire-and-forget read hadn't settled yet.
    await waitFor(() =>
      expect(mocks.readAdultAttestationFromCache).toHaveBeenCalledWith(RETURNING_USER.uid),
    );
    expect(mayRenderEventContent()).toBe(false);
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('#521 (Codex P2): a PERMANENT authority failure does NOT lift the render gate from cache — the Event stays withheld behind the retry surface', async () => {
    // Same cached stamp, same "the authority read failed" shape — but the failure
    // is `permission-denied`, which reconnecting cannot fix. The #521 fallback
    // exists for the captive-Wi-Fi/effectively-offline case only; lifting here
    // would mount Nav/Feed/Ranks/More over a rules/schema fault while App's own
    // #434 cached-card gate (`dealErrorReason === 'connection'`) still refuses to
    // paint the card the lift was for. Both decisions read the SAME classifier, so
    // they cannot disagree.
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // cached: proof of 18+
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    mocks.readAdultAttestationFromServer.mockRejectedValue(permanent());

    mount();
    await coldBoot(RETURNING_USER);

    await waitFor(() => expect(dealErrorShown()).toBe(true));
    // The permanent-class failure never even consults the cache…
    expect(mocks.readAdultAttestationFromCache).not.toHaveBeenCalled();
    // …so the whole Event stays withheld: App renders the full-screen DealError.
    expect(mayRenderEventContent()).toBe(false);
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('#521 (Codex P2): a LATE authoritative NULL that lands after AUTH_BOOTSTRAP_TIMEOUT_MS downgrades the provisional cache lift to the re-prompt', async () => {
    // `withTimeout` rejects the race but cannot cancel the read. The provisional
    // cache lift keeps the Event rendering, and no connectivity event ever fires
    // while navigator.onLine stays true — so a DISCARDED late server-NULL would
    // leave the stale lift standing forever. The late result must still settle.
    vi.useFakeTimers();
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1); // cached: proof of 18+
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });

    // The timeout surfaced the retryable error and the cache lifted the gate.
    expect(dealErrorShown()).toBe(true);
    expect(mayRenderEventContent()).toBe(true);
    expect(rePromptShown()).toBe(false);

    // …and NOW the orphaned server read lands, definitively unstamped.
    await act(async () => {
      read.settle(null);
    });

    // The authority wins: gate closed, stale error cleared, re-prompt shown, and
    // still no rows created for a User the server has not confirmed.
    expect(mayRenderEventContent()).toBe(false);
    expect(rePromptShown()).toBe(true);
    expect(dealErrorShown()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });

  it('#521 (Codex P2): a LATE authoritative STAMP that lands after the timeout clears the stale error and deals — no manual Retry needed', async () => {
    // The mirror case: the same orphaned read comes back CONFIRMING the stamp.
    // Routing it through the same settle recovers the session in place, the way
    // runDeal's late-success net already does for a timed-out deal.
    vi.useFakeTimers();
    setOnline(true);
    mocks.readAdultAttestationFromCache.mockResolvedValue(1);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });
    expect(dealErrorShown()).toBe(true);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    await act(async () => {
      read.settle(1);
    });

    expect(dealErrorShown()).toBe(false);
    expect(mayRenderEventContent()).toBe(true);
    expect(rePromptShown()).toBe(false);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
  });

  it('#521 (Codex P2): a cache read that resolves AFTER a late authoritative NULL cannot re-lift the gate the downgrade closed', async () => {
    // The one-level-down version of the same bug: the provisional lift is
    // fire-and-forget, so its `.then` can land after the authoritative settle.
    // Authority is terminal for the attempt — a slow cache stamp must not undo it.
    vi.useFakeTimers();
    setOnline(true);
    const cache = deferred<number | null>();
    mocks.readAdultAttestationFromCache.mockReturnValue(cache.promise);
    mocks.ensureUserProfile.mockResolvedValue(undefined);
    const read = deferred<number | null>();
    mocks.readAdultAttestationFromServer.mockReturnValue(read.promise);

    mount();
    await coldBoot(RETURNING_USER);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    });
    // The lift was requested but its cache read is still in flight.
    expect(mocks.readAdultAttestationFromCache).toHaveBeenCalledWith(RETURNING_USER.uid);
    expect(mayRenderEventContent()).toBe(false);

    // Authority lands FIRST, definitively unstamped → re-prompt.
    await act(async () => {
      read.settle(null);
    });
    expect(rePromptShown()).toBe(true);

    // …and only then does the cache come back with a stamp. It must be ignored.
    await act(async () => {
      cache.settle(1);
    });
    expect(rePromptShown()).toBe(true);
    expect(mayRenderEventContent()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
  });
});
