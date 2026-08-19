import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTH_BOOTSTRAP_TIMEOUT_MS,
  AuthProvider,
  DEAL_TIMEOUT_MS,
  PENDING_REDIRECT_ATTESTATION_KEY,
  REDIRECT_PENDING_KEY,
  SIGNIN_ADULT_ACK_KEY,
  WEB_APP_AUTH_SETTLE_TIMEOUT_MS,
  useAuth,
} from './AuthContext';
// The mocked module instance (vi.mock below) — the fallback-handler test writes
// a config slot onto it to observe the #340 authDomain override.
import { auth as mockedAuth } from '../firebase';

// Mock the Firebase boundary so the real AuthProvider runs under jsdom: the tests
// drive the auth callback by hand and stub the data-layer deal.
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
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: mocks.onAuthStateChanged,
  getRedirectResult: mocks.getRedirectResult,
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: mocks.signInWithRedirect,
  signOut: mocks.signOut,
  GoogleAuthProvider: class {},
}));
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {} }));
// AuthProvider now mounts the confirm-path listener (#41) beside the attestation
// gate; stub it — this suite exercises deal-error / stale-attempt hardening only.
vi.mock('../components/ConfirmWinMoments', () => ({ default: () => null }));
// The #479 retraction fall observer mounts beside it — same stub, same reason.
vi.mock('../components/RetractWinMoments', () => ({ default: () => null }));
// AuthProvider also mounts the pool-recovery watcher (#70) beside the gate; stub it —
// this suite exercises the deal-error/stale-attempt state machine, not the watcher (the
// watcher has its own suite in src/components/w1-deal-auto-retry.test.tsx).
vi.mock('../components/PoolRecoveryWatcher', () => ({ default: () => null }));
vi.mock('../data/api', () => ({
  ensureUserProfile: mocks.ensureUserProfile,
  attestAdult: mocks.attestAdult,
  // AuthContext's authority read is now server-only (getDocFromServer, #117 r6);
  // point it at the same spy this suite already configures for the settled read.
  readAdultAttestationFromServer: mocks.readAdultAttestation,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: mocks.hasCachedBoard,
  hasCachedCard: mocks.hasCachedCard,
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));

const FAKE_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };

// The auth-state callback AuthProvider registers; emitting a User through it
// simulates Firebase resolving the Google popup.
let emitAuth: (u: unknown) => unknown = () => {};

function Harness() {
  const { dealError, dealing, retryDeal, signIn } = useAuth();
  return (
    <div>
      {dealError ? <p role="alert">{dealError}</p> : null}
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      <button onClick={() => retryDeal()}>retry</button>
      <button onClick={() => void signIn(false)}>signin</button>
    </div>
  );
}

// A promise whose settlement the test drives, to hold a deal in flight (P2/P3).
function deferred<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((settle = res), (fail = rej)));
  return { promise, settle, fail };
}

// Builds a durable `${timestamp}:${token}` record (Phase 4b P1 round 3 on
// #836 — see AuthContext.tsx's `liveStampedToken`/`rawStampedToken`). Tests
// pass a fixed `token` (often 'tok-a' for "this attempt" vs 'tok-b' for "a
// different, unrelated same-origin tab's attempt") so cross-attempt
// correlation scenarios are deterministic rather than relying on two calls
// to `Date.now()` happening to differ.
function stamp(token: string, at: number = Date.now()): string {
  return `${at}:${token}`;
}

const mount = () =>
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
const signInUser = () => act(async () => void (await emitAuth(FAKE_USER)));

// This project's jsdom is configured with no `url`, so jsdom leaves
// `localStorage` UNSET — sessionStorage exists, localStorage does not (the same
// quirk `src/data/hostnames.test.ts` documents). The redirect acknowledgement
// record lives in localStorage precisely because it must survive the
// partitioning that drops sessionStorage (#346), so the suite supplies the
// browser API the environment omits rather than asserting around its absence.
if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  emitAuth = () => {};
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  // These deal/error tests are not about attestation — read the signed-in User as
  // already attested so the re-prompt gate (#23) never intercepts the Harness. The
  // cache-first read (#115) is a MISS here (jsdom has no persistent Firestore
  // cache), so the online server read below is what settles the gate — the online
  // path these tests exercise.
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.readAdultAttestation.mockResolvedValue(1);
  // Default: NO cached card on this device — so a connection-class deal failure
  // surfaces the retryable error (the first-timer case). The #403 swallow tests
  // override these to model a returning Player who already has a card.
  mocks.hasCachedBoard.mockResolvedValue(false);
  mocks.hasCachedCard.mockResolvedValue(false);
  mocks.attestAdult.mockResolvedValue(undefined);
  mocks.getRedirectResult.mockResolvedValue(null);
  mocks.signInWithPopup.mockResolvedValue({});
  mocks.signInWithRedirect.mockResolvedValue(undefined);
  mocks.signOut.mockResolvedValue(undefined);
});

describe('AuthContext deal-error hardening', () => {
  it('surfaces the pool-below-24 failure and Retry re-invokes joinAndDeal, clearing it', async () => {
    mocks.joinAndDeal
      .mockRejectedValueOnce(new Error('dealBoard needs at least 24 prompts, received 5.'))
      .mockResolvedValueOnce(true); // retry deals a NEW board → join_event fires (round 8)
    mount();
    await signInUser();

    // The once-swallowed error is now Player-worded, pool-below-24 copy.
    expect(await screen.findByRole('alert')).toHaveTextContent(/24 a card needs/);
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);

    // Retry re-deals in place (no reload); the second deal succeeds → the error
    // clears and join_event fires.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2);
    expect(mocks.track).toHaveBeenCalledWith('join_event');
  });

  it('surfaces a non-guard deal failure with connection-worded fallback copy when there is NO cached card (first-timer)', async () => {
    // #403: the connection error is only fatal for the Card tab when the Player
    // has no card to fall back on — the default here (hasCachedCard → false).
    // A returning Player with a cached card takes the swallow path instead (below).
    mocks.joinAndDeal.mockRejectedValue(new Error('network request failed'));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
  });

  it('SWALLOWS a transient deal failure when a cached card exists — the Player keeps their card, no error panel (#403)', async () => {
    // A returning Player: the deal re-fires on load and fails on a transient blip,
    // but a legacy/day board is in the persistent cache — so the DealError panel
    // must NOT replace it. hasCachedCard resolves true; no alert is ever shown.
    mocks.hasCachedCard.mockResolvedValue(true);
    mocks.joinAndDeal.mockRejectedValue(new Error('network request failed'));
    mount();
    await signInUser();

    await waitFor(() => expect(screen.getByTestId('dealing')).toHaveTextContent('idle'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.hasCachedCard).toHaveBeenCalledWith(FAKE_USER.uid);
  });

  it('does NOT swallow when only a player row is cached but no card is (Codex #408 P2)', async () => {
    // hasCachedCard is deliberately stronger than a cached join row: a player row
    // can be cached (Leaderboard / another tab) with no board here. With no cached
    // CARD, a transient failure must surface the retry — not strand the Player on
    // Board's indefinite "Dealing…" with the retry gone.
    mocks.hasCachedCard.mockResolvedValue(false);
    mocks.joinAndDeal.mockRejectedValue(new Error('network request failed'));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
  });

  it('SURFACES a PERMANENT (permission-denied) deal failure even when a card is cached (Codex #408 P2)', async () => {
    // The swallow is for TRANSIENT connection problems only. A rules/schema
    // misconfiguration (permission-denied) must not be hidden behind the cached
    // Board forever — it surfaces the retry/error so the failure is visible.
    mocks.hasCachedCard.mockResolvedValue(true);
    mocks.joinAndDeal.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
    // A permanent failure never consults the cache — it surfaces straight away.
    expect(mocks.hasCachedCard).not.toHaveBeenCalled();
  });

  it('SURFACES a data-loss failure even when a card is cached (CodeRabbit #408 — expanded permanent set)', async () => {
    mocks.hasCachedCard.mockResolvedValue(true);
    mocks.joinAndDeal.mockRejectedValue(Object.assign(new Error('data loss'), { code: 'data-loss' }));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
    expect(mocks.hasCachedCard).not.toHaveBeenCalled();
  });

  it('SURFACES an unknown coded deal failure even when a card is cached (CodeRabbit #408 default deny)', async () => {
    mocks.hasCachedCard.mockResolvedValue(true);
    mocks.joinAndDeal.mockRejectedValue(Object.assign(new Error('unexpected Firestore code'), { code: 'unknown-new-code' }));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
    expect(mocks.hasCachedCard).not.toHaveBeenCalled();
  });

  it('SURFACES an uncoded non-network exception even when a card is cached (CodeRabbit #408 default deny)', async () => {
    mocks.hasCachedCard.mockResolvedValue(true);
    mocks.joinAndDeal.mockRejectedValue(new Error('TypeError: cannot read property of undefined'));
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
    expect(mocks.hasCachedCard).not.toHaveBeenCalled();
  });

  it('keeps the card after a SETTLED deal, then a later re-deal blip is swallowed via the cached card (#403)', async () => {
    // First deal settles and writes a card, which the persistent cache now holds
    // (hasCachedCard → true). A later re-deal that fails on a blip is swallowed
    // against that cached card, so the error panel never appears.
    mocks.joinAndDeal.mockResolvedValueOnce(true).mockRejectedValue(new Error('network request failed'));
    mocks.hasCachedCard.mockResolvedValue(true); // the just-dealt card is in cache
    mount();
    await signInUser();
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Re-run the deal in place (Retry drives runDeal when online + authoritative);
    // the second call rejects but is swallowed against the cached card.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a new no-card account after an account switch still sees the retry (Codex #408 P2)', async () => {
    // Account A deals successfully. Account B signs in on the same device with NO
    // cached card (hasCachedCard → false) and its deal fails transiently. Because
    // the fallback is a per-account cached-card probe (no AuthProvider-lifetime
    // latch), B surfaces the retry rather than inheriting A's success.
    mocks.joinAndDeal.mockResolvedValueOnce(true).mockRejectedValue(new Error('network request failed'));
    mount();
    await signInUser(); // account A deals
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => void (await emitAuth({ uid: 'sailor-2', displayName: 'Other', photoURL: null })));
    // Account B has no cached card and its deal fails → the retry surface shows.
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
  });

  it('bounds a HUNG deal with DEAL_TIMEOUT_MS and surfaces the retryable error for a first-timer (#403)', async () => {
    vi.useFakeTimers();
    // try/finally so a failed assertion still restores real timers (a leaked fake
    // clock would hang every later test); and assert synchronously — `findBy*`
    // polls on real timers and would hang while the fake clock is installed.
    try {
      // The deal never settles (captive-wifi hang) and there is no cached card.
      mocks.joinAndDeal.mockReturnValue(new Promise<boolean>(() => {}));
      mount();
      await act(async () => void (await emitAuth(FAKE_USER)));

      // Before the bound elapses: no error panel (the deal is still in flight).
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // The bound elapses → the deal rejects → the first-timer sees the retry surface.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEAL_TIMEOUT_MS);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/connection/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the stale error when a TIMED-OUT deal later succeeds, so the late card is not hidden (Codex #408 P2)', async () => {
    vi.useFakeTimers();
    try {
      // A first-timer's deal exceeds the bound (error surfaces), then the original
      // joinAndDeal — which withTimeout could not cancel — eventually succeeds. The
      // late-success net must clear the stale error so the now-written card shows.
      const deal = deferred<boolean>();
      mocks.joinAndDeal.mockReturnValue(deal.promise);
      mount();
      await act(async () => void (await emitAuth(FAKE_USER)));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEAL_TIMEOUT_MS);
      });
      expect(screen.getByRole('alert')).toBeInTheDocument(); // timed out → retry surface

      await act(async () => {
        deal.settle(true); // the underlying deal finally lands
        await Promise.resolve();
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // late success clears it
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires track('login', { method: 'google' }) on Google sign-in", async () => {
    mocks.joinAndDeal.mockResolvedValue(undefined);
    mount();
    await userEvent.click(screen.getByText('signin'));
    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);
  });

  it("fires track('login_failed', …) with a safe code and rethrows when the popup rejects (#163)", async () => {
    const err = Object.assign(new Error('Unable to process request due to missing initial state.'), {
      code: 'auth/missing-initial-state',
    });
    mocks.signInWithPopup.mockRejectedValueOnce(err);

    // Capture signIn directly so we can assert its rejection contract, rather
    // than routing through the Harness button (which discards the promise).
    let signIn!: (acknowledgedAdultContent: boolean) => Promise<void>;
    function Capture() {
      ({ signIn } = useAuth());
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    // Rethrow contract: signIn surfaces the original error to its caller.
    await expect(signIn(false)).rejects.toBe(err);

    // The failure event carries only allowlisted, PII-free fields.
    expect(mocks.track).toHaveBeenCalledWith('login_failed', {
      method: 'google',
      code: 'auth/missing-initial-state',
    });
    // The success path did not run: no login event, no attestation.
    expect(mocks.track).not.toHaveBeenCalledWith('login', { method: 'google' });
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  it('uses one top-level redirect instead of a popup on iOS Safari', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      onLine: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    const authMock = mockedAuth as { config?: { authDomain?: string } };
    authMock.config = { authDomain: window.location.hostname };
    // A previous abandoned attempt must not authorize this no-checkbox one.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, String(Date.now()));

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(mocks.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithRedirect).toHaveBeenCalledWith(mockedAuth, expect.anything());
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY)).not.toBeNull();
    expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBeNull();

    delete authMock.config;
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps popup sign-in in an installed iOS PWA with a stable app window', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      onLine: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
    });
    const authMock = mockedAuth as { config?: { authDomain?: string } };
    authMock.config = { authDomain: window.location.hostname };

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();

    delete authMock.config;
    vi.unstubAllGlobals();
  });

  it('routes the iPadOS desktop-UA masquerade (MacIntel + touch points) to redirect sign-in (#347)', async () => {
    // iPadOS Safari reports a Mac platform/UA; maxTouchPoints > 1 is the
    // accepted discriminator (real Macs report 0). See prefersRedirectSignIn.
    vi.stubGlobal('navigator', {
      ...window.navigator,
      onLine: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    const authMock = mockedAuth as { config?: { authDomain?: string } };
    authMock.config = { authDomain: window.location.hostname };

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(mocks.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();

    delete authMock.config;
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps popup sign-in on a real Mac (MacIntel, no touch points) (#347)', async () => {
    // The documented tradeoff boundary: only a TOUCH-reporting MacIntel matches
    // the masquerade clause — a conventional Mac stays on the popup path.
    vi.stubGlobal('navigator', {
      ...window.navigator,
      onLine: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    const authMock = mockedAuth as { config?: { authDomain?: string } };
    authMock.config = { authDomain: window.location.hostname };

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();

    delete authMock.config;
    vi.unstubAllGlobals();
  });

  it('uses one top-level redirect instead of a popup in an installed desktop PWA (#395)', async () => {
    // The same real Mac as above (MacIntel, no touch points → prefersRedirectSignIn
    // is false), but INSTALLED as a Chrome/Edge desktop app: it runs in a
    // standalone window (display-mode: standalone) with no address bar, where the
    // OAuth popup is silently blocked and never appears. isStandaloneApp() is the
    // only differing input from the browser-tab case, and it flips the flow to the
    // same same-origin redirect the mobile tab uses.
    vi.stubGlobal('navigator', {
      ...window.navigator,
      onLine: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const authMock = mockedAuth as { config?: { authDomain?: string } };
    authMock.config = { authDomain: window.location.hostname };

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(mocks.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithRedirect).toHaveBeenCalledWith(mockedAuth, expect.anything());
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY)).not.toBeNull();

    delete authMock.config;
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('coalesces repeated sign-in calls into one Firebase auth transaction', async () => {
    const popup = deferred<Record<string, never>>();
    mocks.signInWithPopup.mockReturnValueOnce(popup.promise);

    let signIn!: (acknowledgedAdultContent: boolean) => Promise<void>;
    function Capture() {
      ({ signIn } = useAuth());
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    const first = signIn(false);
    const second = signIn(false);
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);

    popup.settle({});
    await Promise.all([first, second]);
  });

  it('persists only the popup acknowledgement the sign-in screen actually collected', async () => {
    const authMock = mockedAuth as { currentUser?: typeof FAKE_USER };
    authMock.currentUser = FAKE_USER;
    let signIn!: (acknowledgedAdultContent: boolean) => Promise<void>;
    function Capture() {
      ({ signIn } = useAuth());
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    // A no-checkbox tap remains un-attested even if the Event posture changes
    // before this callback runs; the mutable posture is not proof of consent.
    await act(async () => void (await signIn(false)));
    expect(mocks.attestAdult).not.toHaveBeenCalled();

    await act(async () => void (await signIn(true)));
    expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER);
    delete authMock.currentUser;
  });

  it('persists the checked 18+ acknowledgement after returning from mobile redirect sign-in', async () => {
    // All three records carry the SAME attempt token (Phase 4b P1 round 3 on
    // #836): the marker (session-scoped) and the pending record (durable)
    // are what `signIn()` actually writes together at redirect start, and
    // the acknowledgement record must correlate with both for the
    // attestation to be trusted.
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
    localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
    // What the redirect START writes when the box was shown and ticked (#608,
    // Phase 4b round 4). The return path reads THIS, never the posture as it
    // stands on return.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await waitFor(() => expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER));
    expect(mocks.attestAdult).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY)).toBeNull();
    // Consumed exactly once, so a later mount cannot re-attest off a stale record.
    expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBeNull();
    expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBeNull();
  });

  // THE ROUND-4 P1. An Event that turns adult while the player is away at Google
  // must not have their return silently stamp a durable, cross-Event
  // `attestedAdultAt` for a checkbox that was never on screen — which would also
  // walk them straight through the gate it had just raised.
  it('does NOT attest on a redirect return when no acknowledgement was collected', async () => {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    // No ack record: the gate showed no checkbox when this redirect started.
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.attestAdult).not.toHaveBeenCalled();
    // The sign-in itself still completes — only the fabricated attestation is
    // withheld, and the post-auth re-prompt collects it properly.
    expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' });
  });

  it('ignores an EXPIRED acknowledgement record', async () => {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
    localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
    // An abandoned redirect from days ago must not authorize this sign-in.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a', Date.now() - 24 * 60 * 60 * 1000));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  // Codex P2 round 7 on #836: same clock-skew guard as the pending record's
  // regression test — a future-dated ack record must not read as live.
  it('treats a future-dated acknowledgement record as expired, not live', async () => {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
    localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a', Date.now() + 60 * 60 * 1000));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  it('emits nothing for a null redirect result on an ordinary mount (#346)', async () => {
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    // The result IS consulted every mount (the marker-loss fallback needs it),
    // but a null result — every ordinary mount — stays out of analytics.
    expect(mocks.getRedirectResult).toHaveBeenCalledTimes(1);
    expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
    expect(mocks.track).not.toHaveBeenCalledWith('login_failed', expect.anything());
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  // Phase 4b P1 round 3 on #836 — narrows this test's original #346
  // guarantee, per the external security review: the acknowledgement record
  // living in localStorage survives the marker drop, but on its own it is
  // an ORIGIN-WIDE singleton with no attempt identifier, so a different
  // same-origin tab's own redirect could overwrite it with a DIFFERENT
  // attempt's token. Verifying it is THIS attempt's own acknowledgement
  // requires the session-storage token specifically — the one piece of
  // state no other tab can ever have written — which is exactly what is
  // lost here. So `login` still lands (Firebase-verified, low-stakes), but
  // the attestation does NOT: it cannot be confirmed as belonging to this
  // return rather than a different tab's, and the existing re-prompt
  // collects it instead. This is a deliberate, reviewed narrowing of the
  // original #765 decision text (which asked for both to land here) — see
  // the PR body and specs/w1-auth-google.md for the reasoning.
  it('completes a redirect return whose app marker was lost: login lands, attestation is withheld (#346, narrowed by Phase 4b P1 round 3)', async () => {
    // No sessionStorage marker — Safari dropped it across the provider
    // round-trip — but Firebase still hands back the completed redirect.
    localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  it('keeps a marker-less redirect rejection out of analytics: no phantom login_failed (#346)', async () => {
    mocks.getRedirectResult.mockRejectedValueOnce(
      Object.assign(new Error('missing initial state'), { code: 'auth/missing-initial-state' }),
    );

    mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.track).not.toHaveBeenCalledWith('login_failed', expect.anything());
  });

  it('reports login_failed when an app-owned redirect return rejects (marker present)', async () => {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    mocks.getRedirectResult.mockRejectedValueOnce(
      Object.assign(new Error('network down'), { code: 'auth/network-request-failed' }),
    );

    mount();

    await waitFor(() =>
      expect(mocks.track).toHaveBeenCalledWith('login_failed', {
        method: 'google',
        code: 'auth/network-request-failed',
      }),
    );
    expect(sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY)).toBeNull();
  });

  // The PR1 hardening (#765 decision): a durable localStorage pending record,
  // the signal that survives the SAME partitioning that can drop
  // PENDING_REDIRECT_ATTESTATION_KEY's sessionStorage marker AND leave
  // getRedirectResult resolving null on a return Firebase otherwise completed.
  describe('durable redirect-pending completion (signal b, #346 hardening)', () => {
    // Phase 4b P1 round 2 on #836 (corrects this test's original premise): the
    // session-storage marker being present does NOT make signal (b)
    // trustworthy for attestation — it proves this tab once started a
    // redirect, never that THIS specific published User is what that
    // attempt produced. Signal (b) never persists an attestation, marker or
    // no marker; only `getRedirectResult` itself (Firebase-verified,
    // attempt-scoped) may.
    it('fires login via signal (b) but never attests, even with the marker present', async () => {
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve(); // let the getRedirectResult effect consume the records first
      });
      await signInUser(); // onAuthStateChanged publishes the returning User

      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.attestAdult).not.toHaveBeenCalled();
      expect(mocks.track).toHaveBeenCalledTimes(1);
      // Never Firebase-verified, so the durable records are left standing —
      // not cleared — exactly as the marker-absent case, even though the
      // marker was present this time.
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).not.toBeNull();
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).not.toBeNull();
    });

    // Phase 4b P1 on #836: the durable record is ORIGIN-WIDE localStorage, so
    // on its own it proves only that SOME same-origin tab started a
    // redirect — not that THIS onAuthStateChanged publication is that same
    // attempt returning (Firebase Auth persistence is shared across every
    // open tab on the origin). `login` still fires (low-stakes, matches the
    // existing marker-less-rejection precedent) but the attestation — the
    // honor-system self-statement — must NOT be persisted onto whichever
    // account happens to be currently signed in; that would let an unrelated
    // tab's sign-in inherit and fabricate this tab's collected checkbox.
    it('does NOT persist the attestation via signal (b) when the marker is absent (not Firebase-verified)', async () => {
      // No sessionStorage marker — lost, as in #346, OR this could be an
      // entirely different, unrelated same-origin tab; the two are
      // indistinguishable from here, so both are treated the same way.
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();

      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.track).toHaveBeenCalledTimes(1);
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    // Phase 4b P1 on #836: an unconfirmed signal-(b) completion must not
    // destroy the durable records either — the legitimate originating tab's
    // own return (which may still be in flight) needs them to complete WITH
    // full confirmation later. Left standing, they simply expire on their
    // own TTL if truly abandoned.
    it('leaves the durable records standing after an unconfirmed signal (b) completion', async () => {
      const pendingRecord = stamp('tok-a');
      const ackRecord = stamp('tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, pendingRecord);
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, ackRecord);
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));

      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBe(pendingRecord);
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBe(ackRecord);
    });

    // Phase 4b P1 on #836: signal (b) is scoped to the mount's OWN first-ever
    // auth-state settle, closing the far more likely shape of a cross-tab
    // collision — a stale record surviving into an ALREADY-SETTLED, already-
    // running tab's LATER, unrelated auth event.
    it('does not fire login via signal (b) once this mount has already had its first auth settle', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      // First settle: signed out (an ordinary mount that never had a User).
      await act(async () => void (await emitAuth(null)));
      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());

      // A LATER auth event on this same, already-settled mount — an
      // unrelated same-origin tab's own sign-in, or a genuine late arrival —
      // must not retroactively complete a redirect via signal (b) now.
      await signInUser();
      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    it('fires login exactly once and attests exactly once when both signals arrive for the same return', async () => {
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

      mount();
      await waitFor(() => expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER));
      // onAuthStateChanged also publishes the same User, as it does for a real
      // completed redirect — the shared outcome state must make this a no-op.
      await signInUser();

      expect(mocks.attestAdult).toHaveBeenCalledTimes(1);
      expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' });
      expect(mocks.track.mock.calls.filter(([event]) => event === 'login')).toHaveLength(1);
    });

    it('lets a Firebase-verified result finish attestation after signal (b) already logged in', async () => {
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      const redirect = deferred<{ user: typeof FAKE_USER }>();
      mocks.getRedirectResult.mockReturnValueOnce(redirect.promise);

      mount();
      // Signal (b) wins the analytics race, but it is not safe to attest or
      // consume the records until Firebase later verifies this tab's result.
      await signInUser();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.attestAdult).not.toHaveBeenCalled();

      await act(async () => {
        redirect.settle({ user: FAKE_USER });
        await Promise.resolve();
      });

      await waitFor(() => expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER));
      expect(mocks.track.mock.calls.filter(([event]) => event === 'login')).toHaveLength(1);
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBeNull();
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBeNull();
    });

    it('treats an EXPIRED pending record as absent: neither login nor attestation fire from signal (b)', async () => {
      // An abandoned redirect from days ago must not "complete" an unrelated
      // later sign-in the moment onAuthStateChanged happens to publish a User —
      // which is what an ordinary cached-session restore does on every reload.
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a', Date.now() - 24 * 60 * 60 * 1000));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();

      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    it('an ordinary cached-session restore with no pending record never fires login from onAuthStateChanged', async () => {
      // No REDIRECT_PENDING_KEY at all — the everyday case of a returning
      // Player whose session Firebase simply restores on load, no redirect
      // involved. onAuthStateChanged publishing a User here must stay silent.
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();

      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    it('fires login with no attestation when the pending record is live but no acknowledgement was collected', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      // No SIGNIN_ADULT_ACK_KEY: the gate showed no checkbox when this redirect
      // started (e.g. a tame-pool Event, #608).
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();

      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    // Codex P2 on #836: the durable record must NOT be cleared merely
    // because a mount read it — only a terminal outcome (a completed
    // redirect, or a genuine getRedirectResult rejection) may clear it. A
    // mount that reads a live record but reaches neither (e.g. it reloads
    // before onAuthStateChanged ever publishes a user) must leave the record
    // standing for the next mount to pick up — that reload-survival is the
    // entire reason the record exists.
    it('leaves a live pending record standing when a mount reads it but neither completion signal fires', async () => {
      const record = stamp('tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, record);
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // No signInUser() — onAuthStateChanged never publishes a user in this
      // mount, simulating a reload/crash before Firebase's own restore lands.
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBe(record);
    });

    // Codex P2 round 6 on #836: `pending` must be re-validated LIVE when
    // signal (b) actually fires, not trusted from a mount-time snapshot — a
    // long-lived mount (or a delayed, unrelated auth change) could otherwise
    // complete a redirect the TTL was meant to have abandoned by then.
    it('does not complete via signal (b) once the pending record has since expired, even though it was live at mount', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // By the time onAuthStateChanged actually fires, the record has since
      // expired — overwrite it with an already-stale timestamp to simulate
      // that without needing real elapsed time. peekRedirectPending() reads
      // storage fresh on every call, so this only stays blocked if the check
      // is live rather than a cached mount-time boolean.
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a', Date.now() - 24 * 60 * 60 * 1000));
      await signInUser();

      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    // Codex P2 round 7 on #836: an upper-bound-only TTL check (`age <=
    // TTL_MS`) is trivially satisfied by a NEGATIVE age — a future-dated
    // timestamp from a backward wall-clock adjustment or a corrupted value —
    // which would read as live indefinitely instead of expiring on schedule.
    it('treats a future-dated pending record as expired, not live', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a', Date.now() + 60 * 60 * 1000));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await signInUser();

      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    it('clears the pending record once the redirect actually completes (signal a)', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

      mount();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBeNull();
    });

    it('clears the durable records on a CONFIRMED (marker-present) getRedirectResult rejection', async () => {
      // The marker present is what makes this rejection DEFINITIVE — the
      // app knows for certain this getRedirectResult() belongs to its own
      // attempt (matching token), so clearing is safe (nothing left to recover).
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockRejectedValueOnce(
        Object.assign(new Error('network down'), { code: 'auth/network-request-failed' }),
      );

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBeNull();
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBeNull();
    });

    // Codex P2 on the merged HEAD (#836): a marker-less rejection is
    // INCONCLUSIVE, not confirmed — it must not clear the durable records,
    // or a mount that reloads/crashes before signal (b) gets its chance
    // would leave the NEXT mount with nothing to recover the redirect from.
    it('leaves the durable records standing on an INCONCLUSIVE (marker-less) getRedirectResult rejection', async () => {
      const pendingRecord = stamp('tok-a');
      const ackRecord = stamp('tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, pendingRecord);
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, ackRecord);
      mocks.getRedirectResult.mockRejectedValueOnce(
        Object.assign(new Error('missing initial state'), { code: 'auth/missing-initial-state' }),
      );

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBe(pendingRecord);
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBe(ackRecord);
    });

    // Codex P2 round 2 on #836: the failure path and signal (b) must not both
    // report an outcome for the same attempt — whichever lands first wins.
    it('does not fire login via signal (b) once a genuine rejection already claimed failure for the same attempt', async () => {
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockRejectedValueOnce(
        Object.assign(new Error('network down'), { code: 'auth/network-request-failed' }),
      );

      mount();
      await waitFor(() =>
        expect(mocks.track).toHaveBeenCalledWith('login_failed', {
          method: 'google',
          code: 'auth/network-request-failed',
        }),
      );

      // Signal (b) tries to complete AFTER the failure already claimed this
      // attempt — must be a no-op: a single attempt can never report both
      // login_failed and login.
      await signInUser();
      expect(mocks.track).not.toHaveBeenCalledWith('login', { method: 'google' });
    });

    it('does not report login_failed once signal (b) already claimed success for the same attempt', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      const redirect = deferred<null>();
      mocks.getRedirectResult.mockReturnValueOnce(redirect.promise);

      mount();
      // Signal (b) completes FIRST — onAuthStateChanged publishes the
      // restored user before this mount's getRedirectResult even settles.
      await signInUser();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));

      // The redirect's OWN getRedirectResult() now rejects, after signal (b)
      // already won — must be a no-op.
      await act(async () => {
        redirect.fail(Object.assign(new Error('missing initial state'), { code: 'auth/missing-initial-state' }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.track).not.toHaveBeenCalledWith('login_failed', expect.anything());
    });

    // Codex P2 on the merged HEAD (#836): the marker is lost (#346's own
    // trigger case) so the failure path never latches — by design, since the
    // marker-absent rejection is exactly the "Safari lost the receipt" case
    // signal (b) exists to rescue, and latching here would block that rescue.
    // This proves the rescue still lands: exactly one login via signal (b),
    // no login_failed (marker absent, as always). The attestation does NOT
    // persist here (Phase 4b P1 on #836, superseding this test's original
    // expectation): the SAME marker absence that makes the rejection
    // inconclusive also means this completion is same-tab UNCONFIRMED, and
    // an unconfirmed signal-(b) firing must not persist an acknowledgement
    // that might belong to a different, unrelated same-origin tab's account.
    it('still fires login cleanly via signal (b) after a marker-less getRedirectResult rejection, without attesting', async () => {
      // No sessionStorage marker — lost, as in #346.
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockRejectedValueOnce(
        Object.assign(new Error('missing initial state'), { code: 'auth/missing-initial-state' }),
      );

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Marker-less rejection: no login_failed, exactly as an ordinary
      // marker-less rejection already stays out of analytics.
      expect(mocks.track).not.toHaveBeenCalledWith('login_failed', expect.anything());

      // Signal (b) still completes the redirect Firebase's own
      // getRedirectResult() failed to identify.
      await signInUser();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.attestAdult).not.toHaveBeenCalled();
      expect(mocks.track.mock.calls.filter(([event]) => event === 'login')).toHaveLength(1);
      expect(mocks.track).not.toHaveBeenCalledWith('login_failed', expect.anything());
    });

    // Codex P2 round 2 on #836: the SAME premature-clearing bug fixed for the
    // pending record above, but for the collected-acknowledgement record.
    it('leaves a live acknowledgement record standing when a mount reads it but neither completion signal fires', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      const ackRecord = stamp('tok-a');
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, ackRecord);
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // No signInUser() — simulating a reload before onAuthStateChanged fires.
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBe(ackRecord);
    });

    // Phase 4b P1 round 3 on #836, finding 1: `verifiedByFirebase` correctly
    // correlates `u` to THIS tab's own redirect, but the acknowledgement
    // record is a SEPARATE origin-wide singleton with no attempt identifier
    // of its own — a different same-origin tab starting its own redirect
    // (whether or not it ticked the box) overwrites it. Even a fully
    // Firebase-verified completion must not attest using an acknowledgement
    // record that no longer carries THIS attempt's own token.
    it('does NOT attest when the acknowledgement record belongs to a DIFFERENT attempt (cross-tab clobbering)', async () => {
      sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, 'tok-a');
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      // A DIFFERENT tab's own redirect attempt overwrote the shared
      // acknowledgement record with ITS OWN token after this tab started.
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, stamp('tok-b'));
      mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

      mount();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });

    // Phase 4b P1 round 3 on #836, finding 2: an unverified signal-(b)
    // completion deliberately retains the pending record so a later
    // verified result can still consume it — but a per-mount latch alone
    // cannot stop a SECOND reload, within the TTL, from finding that same
    // live record plus the (now genuinely) signed-in user and logging
    // `login` again. The durable `hasLoggedRedirectLogin` check must hold
    // ACROSS mounts, not just within one.
    it('does not re-log login on a second mount for the same still-pending attempt (exactly-once across reloads)', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-a'));
      mocks.getRedirectResult.mockResolvedValueOnce(null);

      const first = mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));
      expect(mocks.track.mock.calls.filter(([event]) => event === 'login')).toHaveLength(1);
      first.unmount();

      // A second mount — simulating a reload — with the SAME durable record
      // still live (an unverified completion never clears it) and Firebase
      // now genuinely restoring the already-signed-in session.
      mocks.track.mockClear();
      mocks.getRedirectResult.mockResolvedValueOnce(null);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      await signInUser();
      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.track).not.toHaveBeenCalledWith('login', expect.anything());
    });

    // Phase 4b P1 round 3 on #836, finding 3: an unconditional delete could
    // remove records belonging to a NEWER redirect. If this mount's own
    // (older) attempt only verifies LATE, after a different tab has already
    // overwritten the shared singleton keys with its own newer attempt, the
    // late verification must not clear that newer attempt's records —
    // compare-and-delete only removes what still matches the token THIS
    // mount is tracking.
    it('does not clear a NEWER attempt\'s records when an older mount\'s verified result settles late', async () => {
      localStorage.setItem(REDIRECT_PENDING_KEY, stamp('tok-old'));
      const redirect = deferred<{ user: typeof FAKE_USER }>();
      mocks.getRedirectResult.mockReturnValueOnce(redirect.promise);

      mount(); // establishes this mount's own pending token ('tok-old') at mount

      // A DIFFERENT tab starts its own, newer redirect, overwriting the
      // shared singleton keys with its own attempt.
      const newerPending = stamp('tok-new');
      const newerAck = stamp('tok-new');
      localStorage.setItem(REDIRECT_PENDING_KEY, newerPending);
      localStorage.setItem(SIGNIN_ADULT_ACK_KEY, newerAck);

      // This mount's OWN (older) redirect now verifies, late.
      await act(async () => {
        redirect.settle({ user: FAKE_USER });
        await Promise.resolve();
      });
      await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' }));

      // The newer attempt's records must survive untouched.
      expect(localStorage.getItem(REDIRECT_PENDING_KEY)).toBe(newerPending);
      expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBe(newerAck);
      expect(mocks.attestAdult).not.toHaveBeenCalled();
    });
  });

  it('hands a signed-out web.app boot to firebaseapp.com before rendering a second sign-in screen', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });
    mount();
    await act(async () => void (await emitAuth(null)));

    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalledWith('login', { method: 'google' });

    vi.unstubAllGlobals();
  });

  it('bounds a stalled online web.app auth bootstrap and hands off automatically', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    expect(replace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never times out an offline web.app boot into a cross-origin handoff', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('navigator', { ...window.navigator, onLine: false });
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).not.toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancels the armed settle timer when the browser goes offline mid-window (#356)', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount(); // online signed-out boot: the 3s bound arms
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS / 2);

    // Mid-window offline transition. This pins the effect-CLEANUP path — the
    // spec's "an offline transition cancels the timer" — as distinct from both
    // booting offline (the timer never arms) and the fire-time isOnline()
    // re-check: navigator.onLine stays true here (only the event fires), so if
    // the cleanup failed to clear the pending timeout, the callback would pass
    // its live probe and navigate, failing this test.
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).not.toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('suppresses the timeout handoff when Firebase restores the current User first', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });
    const authMock = mockedAuth as { currentUser?: unknown };
    authMock.currentUser = FAKE_USER;

    mount();
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).not.toHaveBeenCalled();

    delete authMock.currentUser;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancels the pending handoff when auth publishes a User before the timeout', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    await act(async () => void (await emitAuth(FAKE_USER)));
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).not.toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands off web.app on a mid-session sign-out, not only on first load (#353)', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    await act(async () => void (await emitAuth(FAKE_USER)));
    expect(replace).not.toHaveBeenCalled(); // signed-in cached sessions stay put

    // An explicit sign-out lands on the canonical origin: any sign-in tap from
    // web.app would hand off anyway, so staying would only add a second
    // acknowledgement screen before the same navigation.
    await act(async () => void (await emitAuth(null)));
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');

    vi.unstubAllGlobals();
  });

  it('hands off a mid-session sign-out to the CURRENT route, not the mount-time one (#376)', async () => {
    const replace = vi.fn();
    const location = {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    };
    vi.stubGlobal('location', location);

    mount();
    await act(async () => void (await emitAuth(FAKE_USER)));

    // The signed-in session navigates before signing out; the handoff target
    // must be computed from the live location at navigation time, so the
    // canonical origin receives the route the Player was actually on.
    location.pathname = '/more';
    location.search = '?tab=stats';

    await act(async () => void (await emitAuth(null)));
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/more?tab=stats');

    vi.unstubAllGlobals();
  });

  it('routes a web.app sign-in tap through the shared handoff and starts no auth transaction there', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    await userEvent.click(screen.getByText('signin'));

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('never re-navigates web.app: a sign-in tap after the handoff started is a deduped no-op (#354)', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    await act(async () => void (await emitAuth(null)));
    expect(replace).toHaveBeenCalledOnce(); // the auth-settled handoff

    // The tap path shares the chokepoint's started-once dedupe: no second
    // replace() while the first navigation is still committing, and no auth
    // transaction ever starts on web.app.
    await userEvent.click(screen.getByText('signin'));
    expect(replace).toHaveBeenCalledOnce();
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('suppresses the settle-timeout handoff while an app-owned redirect return is pending, then re-arms (#357)', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    const redirect = deferred<null>();
    mocks.getRedirectResult.mockReturnValueOnce(redirect.promise);
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    // The 3s bound elapses while the app-owned return is mid-completion: the
    // handoff must not interrupt it with a cross-origin navigation.
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).not.toHaveBeenCalled();

    // The return settles signed-out — the bound re-arms and the handoff fires,
    // so the suppression is a deferral, not a lost stall bound.
    await act(async () => {
      redirect.settle(null);
      await Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands off a signed-out settle that was suppressed mid-redirect once the return completes (#357)', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    const redirect = deferred<null>();
    mocks.getRedirectResult.mockReturnValueOnce(redirect.promise);
    const replace = vi.fn();
    vi.stubGlobal('location', {
      hostname: 'gaycruisebingo.web.app',
      pathname: '/card',
      search: '',
      hash: '',
      replace,
    });

    mount();
    // Auth settles signed-out WHILE the app-owned return is still completing:
    // the immediate handoff is suppressed (SignIn may render), no navigation.
    await act(async () => void (await emitAuth(null)));
    expect(replace).not.toHaveBeenCalled();

    // Once the return settles signed-out, the re-armed bound must still move
    // the already-settled signed-out session — it must not sit on web.app
    // indefinitely just because auth settled before the redirect result did.
    await act(async () => {
      redirect.settle(null);
      await Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(WEB_APP_AUTH_SETTLE_TIMEOUT_MS);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('https://gaycruisebingo.firebaseapp.com/card');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe('AuthContext stale-attempt + retry hardening', () => {
  it('drops a stale deal rejection from a signed-out account after a new account has dealt (P2)', async () => {
    const stale = deferred<void>();
    mocks.joinAndDeal.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(undefined);
    mount();
    await act(async () => void (await emitAuth(FAKE_USER))); // account A: deal left in flight
    await act(async () => void (await emitAuth(null))); // player signs out
    await act(
      async () =>
        void (await emitAuth({
          uid: 'sailor-2',
          displayName: 'Other',
          photoURL: null,
        })),
    ); // account B deals
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Account A's late rejection must be ignored, not clobber account B's board.
    await act(async () => {
      stale.fail(new Error('network request failed'));
      await stale.promise.catch(() => {});
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the retry surface mounted until the retry settles, never flashing a blank board (P3)', async () => {
    const retry = deferred<void>();
    mocks.joinAndDeal
      .mockRejectedValueOnce(new Error('network request failed')) // initial deal fails
      .mockReturnValueOnce(retry.promise); // retry stays in flight
    mount();
    await signInUser();
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);

    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(2));
    // Mid-retry: the error surface stays mounted (dealing), never a blank board.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('dealing')).toHaveTextContent('dealing');

    await act(async () => {
      retry.settle();
      await retry.promise;
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // clears only on settle
  });
});

describe('AuthContext late-authority generation guards (Codex P2 on #761 / #762)', () => {
  // Captures the live context value on every render, the same pattern the
  // sign-in tests above use for `signIn` — but for state (dealError,
  // dealErrorReason, attest), not just callbacks.
  function CaptureAuth({ onRender }: { onRender: (ctx: ReturnType<typeof useAuth>) => void }) {
    const ctx = useAuth();
    onRender(ctx);
    // A marker element (not `null`) so tests that need to prove this subtree
    // was swapped for the SignIn re-prompt (`needsAttestation` flipping true)
    // — and, more importantly, that it STAYS swapped rather than remounting —
    // can assert on its presence/absence directly, without racing a captured
    // `ctx` closure against the same render pass that replaces it.
    return <span data-testid="capture-live" />;
  }

  it('does not let a late authoritative settle erase a NEWER deal failure that started after it began (#761)', async () => {
    vi.useFakeTimers();
    const authMock = mockedAuth as { currentUser?: typeof FAKE_USER };
    authMock.currentUser = FAKE_USER;
    try {
      // The server-only authority read hangs past AUTH_BOOTSTRAP_TIMEOUT_MS — the
      // bootstrap times out (a 'connection'-worded failure), but the underlying
      // read is still running in the background.
      const authorityRead = deferred<number | null>();
      mocks.readAdultAttestation.mockReturnValue(authorityRead.promise);

      let ctx!: ReturnType<typeof useAuth>;
      render(
        <AuthProvider>
          <CaptureAuth onRender={(c) => (ctx = c)} />
        </AuthProvider>,
      );

      // NOT awaited: the auth callback RETURNS bootstrapUser's own promise
      // (unlike `signInUser`'s usual quick-resolving read), and this test's
      // authority read is deliberately hung until the timer below advances —
      // awaiting it here would deadlock before any timer ever fires.
      act(() => {
        void emitAuth(FAKE_USER);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
      });
      expect(ctx.dealError).toMatch(/connection/i);

      // A same-session attest commits WHILE the original read is still pending:
      // it grants authority and the `mayDeal` effect fires a FRESH deal, which
      // fails with a different, more specific (pool-shortfall) error.
      mocks.joinAndDeal.mockRejectedValueOnce(new Error('the active pool is below the 24 prompts a card needs'));
      await act(async () => {
        await ctx.attest();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1);
      expect(ctx.dealErrorReason).toBe('pool-shortfall');

      // THE FIX UNDER TEST: the ORIGINAL slow authority read finally lands late
      // — it must not erase the fresher pool-shortfall error with its own
      // unconditional clear (Codex P2 on #761).
      await act(async () => {
        authorityRead.settle(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('pool-shortfall');
      expect(ctx.dealError).toBeTruthy();
    } finally {
      vi.useRealTimers();
      delete authMock.currentUser;
    }
  });

  it('corrects a provisional connection-classed lift when the late authority read actually rejects PERMANENTLY (#762)', async () => {
    vi.useFakeTimers();
    const authMock = mockedAuth as { currentUser?: typeof FAKE_USER };
    authMock.currentUser = FAKE_USER;
    try {
      // A cache HIT is what the in-time 'connection' failure arm provisionally
      // lifts `attested` from (#521) — the bet that the timeout is transient.
      mocks.readAdultAttestationFromCache.mockResolvedValue(1);
      const authorityRead = deferred<number | null>();
      mocks.readAdultAttestation.mockReturnValue(authorityRead.promise);

      let ctx!: ReturnType<typeof useAuth>;
      render(
        <AuthProvider>
          <CaptureAuth onRender={(c) => (ctx = c)} />
        </AuthProvider>,
      );

      // NOT awaited — see the #761 test above: bootstrapUser's own returned
      // promise won't settle until the timer below advances.
      act(() => {
        void emitAuth(FAKE_USER);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
        // Let the fire-and-forget cache-lift promise settle.
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('connection');
      // The provisional lift stood: cached-stamp proof rendered Event content
      // even though authority was never established.
      expect(ctx.canRenderEventContent).toBe(true);

      // An OPTIMISTIC same-session attest (UI-only — the write never commits,
      // `attestAdult` hangs forever) keeps `attested` true across the
      // correction below. Without this, the fix's own `setAttested(false)`
      // (correctly revoking the WRONG lift) flips `needsAttestation` true,
      // which swaps AuthProvider's `children` for the SignIn re-prompt —
      // unmounting the very component this test reads state through, before
      // it can ever render with the corrected value. #761's generation guard
      // already covers that revoke path; this test isolates #762's actual
      // claim — that a late PERMANENT rejection corrects `dealErrorReason` at
      // all, which a mounted-throughout consumer can observe directly.
      mocks.attestAdult.mockReturnValue(new Promise<void>(() => {}));
      act(() => {
        void ctx.attest();
      });

      // THE FIX UNDER TEST: the underlying read that timed out now rejects LATE
      // with a PERMANENT cause. That must correct `dealErrorReason` — the
      // in-time timeout wrongly classified it 'connection' (Codex P2 on #762).
      const permanentErr = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      await act(async () => {
        authorityRead.fail(permanentErr);
        await authorityRead.promise.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('permanent');
    } finally {
      vi.useRealTimers();
      delete authMock.currentUser;
    }
  });

  it('does not let a delayed cache-lift resolve AFTER the permanent correction re-lift attested (Codex P2 round 2 on #762)', async () => {
    vi.useFakeTimers();
    try {
      // Both reads are deferred so the test controls their relative order:
      // the authority read rejects PERMANENTLY while the cache read is still
      // pending — the exact race Codex flagged in the first round of #762's
      // fix (the fire-and-forget cache-lift promise only checked
      // `authorityApplied`, which the correction did not set).
      const cacheRead = deferred<number | null>();
      mocks.readAdultAttestationFromCache.mockReturnValue(cacheRead.promise);
      const authorityRead = deferred<number | null>();
      mocks.readAdultAttestation.mockReturnValue(authorityRead.promise);

      let ctx!: ReturnType<typeof useAuth>;
      render(
        <AuthProvider>
          <CaptureAuth onRender={(c) => (ctx = c)} />
        </AuthProvider>,
      );

      act(() => {
        void emitAuth(FAKE_USER);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
      });
      expect(ctx.dealErrorReason).toBe('connection');
      expect(screen.getByTestId('capture-live')).toBeInTheDocument();

      // THE FIX UNDER TEST: the underlying read rejects PERMANENTLY while the
      // cache read is STILL pending (unresolved). The correction revokes the
      // provisional lift — `attestedUidsRef` is empty here, so `attested`
      // downgrades to UNKNOWN (`undefined`), never a definite `false` (Codex
      // P2 round 3: a rejection is not proof the profile lacks a stamp, so it
      // must not flip `needsAttestation` and swap the just-published
      // permanent DealError for the SignIn re-prompt — specs/w1-attestation.md
      // § Failure state).
      const permanentErr = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      await act(async () => {
        authorityRead.fail(permanentErr);
        await authorityRead.promise.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('permanent');
      expect(ctx.needsAttestation).toBe(false); // UNKNOWN, never a definite false-&-reprompt
      expect(ctx.canRenderEventContent).toBe(false);

      // THE REGRESSION UNDER TEST: the cache read finally resolves with a
      // stamp, well after the correction. Without a dedicated
      // `provisionalLiftRetired` latch (Codex P2 rounds 2 and 3 on #762), the
      // fire-and-forget cache-lift promise would still see it unset and
      // silently re-lift `attested` back to true, undoing the correction and
      // masking the permanent failure behind Event content again.
      await act(async () => {
        cacheRead.settle(1);
        await cacheRead.promise.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('permanent');
      expect(ctx.needsAttestation).toBe(false); // UNKNOWN, never a definite false-&-reprompt
      expect(ctx.canRenderEventContent).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('corrects a provisional lift STANDING FROM AN EARLIER bootstrap when a later retry read rejects PERMANENTLY (Codex P2 round 2 on #762)', async () => {
    vi.useFakeTimers();
    try {
      // The INITIAL bootstrap's own read never settles at all — it is
      // abandoned once the retry below starts a fresh one, exactly like a
      // captive-wifi read that outlives its own timeout.
      mocks.readAdultAttestation.mockReturnValueOnce(new Promise<number | null>(() => {}));
      // A cache HIT provisionally lifts `attested` on the initial bootstrap's
      // in-time 'connection' timeout (#521).
      mocks.readAdultAttestationFromCache.mockResolvedValue(1);

      let ctx!: ReturnType<typeof useAuth>;
      render(
        <AuthProvider>
          <CaptureAuth onRender={(c) => (ctx = c)} />
        </AuthProvider>,
      );

      act(() => {
        void emitAuth(FAKE_USER);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('connection');
      // The provisional lift stood: proof-of-18+ from cache rendered Event
      // content even though authority was never established.
      expect(ctx.canRenderEventContent).toBe(true);
      expect(screen.getByTestId('capture-live')).toBeInTheDocument();

      // The Player taps Retry. `retryBootstrap` does NOT reset `attested` at
      // its own start, so the lift above is still standing when this begins.
      const retryRead = deferred<number | null>();
      mocks.readAdultAttestation.mockReturnValue(retryRead.promise);
      act(() => {
        void ctx.retryDeal();
      });

      // The retry's OWN read also times out in-time — a second 'connection'
      // failure, same classification, `attested` untouched either way.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
      });
      expect(ctx.dealErrorReason).toBe('connection');
      expect(screen.getByTestId('capture-live')).toBeInTheDocument();

      // THE FIX UNDER TEST: the RETRY's underlying read rejects LATE with a
      // PERMANENT cause. Before this fix, `retryBootstrap` wired no
      // `onLateError` at all, so this rejection was silently discarded —
      // leaving the STANDING lift from the initial bootstrap up indefinitely
      // (Codex P2 round 2 on #762). It must now correct `dealErrorReason` and
      // revoke that lift — downgrading `attested` to UNKNOWN, never a
      // definite `false` (Codex P2 round 3: a rejection is not proof the
      // profile lacks a stamp, so this must surface the retryable DealError,
      // never the SignIn re-prompt — specs/w1-attestation.md § Failure state).
      const permanentErr = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      await act(async () => {
        retryRead.fail(permanentErr);
        await retryRead.promise.catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(ctx.dealErrorReason).toBe('permanent');
      expect(ctx.needsAttestation).toBe(false); // UNKNOWN, never a definite false-&-reprompt
      expect(ctx.canRenderEventContent).toBe(false);
      // The correction never re-prompts on an UNKNOWN attestation: this
      // subtree stays mounted, showing the retryable error, not SignIn.
      expect(screen.getByTestId('capture-live')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
