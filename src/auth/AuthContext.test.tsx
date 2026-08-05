import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AuthProvider,
  DEAL_TIMEOUT_MS,
  PENDING_REDIRECT_ATTESTATION_KEY,
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
      <button onClick={() => void signIn()}>signin</button>
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
    let signIn!: () => Promise<void>;
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
    await expect(signIn()).rejects.toBe(err);

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

    let signIn!: () => Promise<void>;
    function Capture() {
      ({ signIn } = useAuth());
      return null;
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );

    const first = signIn();
    const second = signIn();
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);

    popup.settle({});
    await Promise.all([first, second]);
  });

  it('persists the checked 18+ acknowledgement after returning from mobile redirect sign-in', async () => {
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    // What the redirect START writes when the box was shown and ticked (#608,
    // Phase 4b round 4). The return path reads THIS, never the posture as it
    // stands on return.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, String(Date.now()));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await waitFor(() => expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER));
    expect(mocks.attestAdult).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PENDING_REDIRECT_ATTESTATION_KEY)).toBeNull();
    // Consumed exactly once, so a later mount cannot re-attest off a stale record.
    expect(localStorage.getItem(SIGNIN_ADULT_ACK_KEY)).toBeNull();
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
    sessionStorage.setItem(PENDING_REDIRECT_ATTESTATION_KEY, '1');
    // An abandoned redirect from days ago must not authorize this sign-in.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, String(Date.now() - 24 * 60 * 60 * 1000));
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

  it('completes a redirect return whose app marker was lost: login and attestation still land (#346)', async () => {
    // No sessionStorage marker — Safari dropped it across the provider
    // round-trip — but Firebase still hands back the completed redirect.
    //
    // The acknowledgement record is in localStorage precisely so it SURVIVES
    // that drop (Phase 4b round 4): #346's guarantee is kept intact rather than
    // traded away for the fix above. Same partitioning that loses the marker
    // leaves this — which is also how Firebase restores the session at all.
    localStorage.setItem(SIGNIN_ADULT_ACK_KEY, String(Date.now()));
    mocks.getRedirectResult.mockResolvedValueOnce({ user: FAKE_USER });

    mount();

    await waitFor(() => expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER));
    expect(mocks.attestAdult).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('login', { method: 'google' });
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
