import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { setActiveAdultContent } from '../adultContent';

// Covers specs/w1-attestation.md — the 18+ re-prompt gate (#23). Mock the Firebase
// + data-layer boundary so the REAL AuthProvider + SignIn run under jsdom, and
// drive the auth callback by hand. AuthProvider renders the <SignIn/> re-prompt in
// place of its children when a SETTLED profile lacks the attestation.
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
  // Records a render of the confirm-path listener (#41) so a test can assert it
  // stays mounted behind the attestation gate (Codex #116 R3 finding 2).
  confirmMounted: vi.fn(),
  // Mutable Firebase auth double: attest() reads auth.currentUser.uid.
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
  // AuthProvider's authority read is server-only now (#117 r6); route the same spy
  // this suite already configures for the settled gate read to it.
  readAdultAttestationFromServer: mocks.readAdultAttestation,
  readAdultAttestationFromCache: mocks.readAdultAttestationFromCache,
  hasCachedBoard: vi.fn().mockResolvedValue(true),
  joinAndDeal: mocks.joinAndDeal,
}));
vi.mock('../analytics', () => ({ track: mocks.track }));
// The confirm-path listener (#41) mounts inside AuthProvider now; stub it to a
// mount-recording spy so its real Firestore subscriptions do not run here, and so
// the R3-finding-2 test can assert it survives the attestation gate.
vi.mock('./ConfirmWinMoments', () => ({
  default: () => {
    mocks.confirmMounted();
    return null;
  },
}));
// AuthProvider also mounts the pool-recovery watcher (#70), whose real pool
// subscription this suite does not wire; stub it — this suite is about the attestation
// gate, not the watcher (its own suite is ./w1-deal-auto-retry.test.tsx).
vi.mock('./PoolRecoveryWatcher', () => ({ default: () => null }));
// The #479 retraction fall observer mounts at the same shell spot; stub it for
// the same reason (its own suites are ./RetractWinMoments.test.tsx and the
// moments unit suite).
vi.mock('./RetractWinMoments', () => ({ default: () => null }));

const FAKE_USER = { uid: 'sailor-1', displayName: 'Sailor', photoURL: null };

// The auth-state callback AuthProvider registers; emitting a User simulates
// Firebase resolving a returning session / the Google popup.
let emitAuth: (u: unknown) => unknown = () => {};

// A promise whose settlement the test drives, to hold the profile bootstrap in
// flight so the "does not flash" window is observable.
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => (settle = res));
  return { promise, settle };
}

// The Board stand-in behind the gate; present only when the User is let through.
const BOARD = 'THE BINGO BOARD';
const mount = () =>
  render(
    <AuthProvider>
      <div>{BOARD}</div>
    </AuthProvider>,
  );

// Captures the context's signIn() so a test can await the FULL first-time
// continuation (popup → attest) deterministically — needed to reproduce the
// Finding-3 race where attest() lands optimistically before a later, still-stale
// auth-state callback read.
let ctxSignIn: () => Promise<void> = async () => {};
function CaptureContext() {
  ctxSignIn = useAuth().signIn;
  return null;
}
const mountWithCapture = () =>
  render(
    <AuthProvider>
      <CaptureContext />
      <div>{BOARD}</div>
    </AuthProvider>,
  );

// Surfaces the retryable error state for the bootstrap-failure tests (#112 round
// 2). dealError/dealing/retryDeal are the DealError panel's exact inputs — App
// renders that panel on the Card tab when dealError is set — so this probe
// mirrors the App-level contract without mounting the full App shell.
function ErrorProbe() {
  const { dealError, dealing, retryDeal } = useAuth();
  return (
    <div>
      {dealError ? <p role="alert">{dealError}</p> : null}
      <span data-testid="dealing">{dealing ? 'dealing' : 'idle'}</span>
      <button onClick={() => retryDeal()}>retry</button>
    </div>
  );
}
const mountWithProbe = () =>
  render(
    <AuthProvider>
      <ErrorProbe />
      <div>{BOARD}</div>
    </AuthProvider>,
  );

const signIn = (u: unknown) => act(async () => void emitAuth(u));
const boardShown = () => screen.queryByText(BOARD) !== null;
const rePrompted = () =>
  screen.queryByRole('button', { name: /enter the event/i }) !== null;

beforeEach(() => {
  vi.clearAllMocks();
  emitAuth = () => {};
  ctxSignIn = async () => {};
  mocks.auth.currentUser = null;
  mocks.onAuthStateChanged.mockImplementation((_a: unknown, cb: (u: unknown) => unknown) => {
    emitAuth = cb;
    return () => {};
  });
  mocks.ensureUserProfile.mockResolvedValue(undefined);
  mocks.attestAdult.mockResolvedValue(undefined);
  // These suites run ONLINE (jsdom navigator.onLine is true), where the bootstrap
  // reads the server, not the cache (#115). The cache reader is stubbed as a MISS
  // so any offline-path call would simply fall through to the authoritative read.
  mocks.readAdultAttestationFromCache.mockRejectedValue(new Error('cache miss'));
  mocks.joinAndDeal.mockResolvedValue(undefined);
  mocks.signInWithPopup.mockResolvedValue({});
  mocks.signOut.mockResolvedValue(undefined);
});

describe('18+ attestation re-prompt gate (#23)', () => {
  it('re-prompts a signed-in User whose settled profile lacks attestedAdultAt', async () => {
    mocks.readAdultAttestation.mockResolvedValue(null); // settled: no stamp
    mount();
    await signIn(FAKE_USER);

    expect(rePrompted()).toBe(true);
    expect(boardShown()).toBe(false);
  });

  it('keeps the confirm-path listener MOUNTED behind the attestation gate (Codex #116 R3 finding 2)', async () => {
    // A returning player with a pending admin_confirmed Claim sits on the attestation
    // prompt. The listener must stay mounted BESIDE the gate — not inside the gated
    // children — so an admin confirming during this window is still observed. The
    // pre-fix mount lived in App (the gated children) and unmounted here.
    mocks.readAdultAttestation.mockResolvedValue(null); // settled: no stamp → gate up
    mount();
    await signIn(FAKE_USER);

    expect(rePrompted()).toBe(true); // the gate is up
    expect(boardShown()).toBe(false); // children (the Board) are NOT rendered
    expect(mocks.confirmMounted).toHaveBeenCalled(); // …yet the listener is mounted
  });

  it('lets an already-attested User pass straight through to the Board', async () => {
    mocks.readAdultAttestation.mockResolvedValue(1_720_000_000_000); // settled: attested
    mount();
    await signIn(FAKE_USER);

    expect(boardShown()).toBe(true);
    expect(rePrompted()).toBe(false);
  });

  it('does not flash the prompt while the profile bootstrap is still in flight', async () => {
    const boot = deferred<void>();
    mocks.ensureUserProfile.mockReturnValueOnce(boot.promise); // bootstrap unsettled
    mocks.readAdultAttestation.mockResolvedValue(null); // would gate — but only after settle
    mount();
    await signIn(FAKE_USER);

    // Bootstrap unsettled → attestation UNKNOWN (not absent) → NO re-prompt.
    expect(rePrompted()).toBe(false);
    expect(boardShown()).toBe(true);

    // Once it settles with no stamp, the gate appears — proving the pre-settle
    // absence was UNKNOWN, not a flashed re-prompt.
    await act(async () => {
      boot.settle();
      await boot.promise;
    });
    expect(rePrompted()).toBe(true);
    expect(boardShown()).toBe(false);
  });

  it('lifts the gate when the re-prompted User attests, deferring the deal until then', async () => {
    mocks.readAdultAttestation.mockResolvedValue(null);
    mocks.auth.currentUser = FAKE_USER; // the returning User is signed in
    mount();
    await signIn(FAKE_USER);
    expect(rePrompted()).toBe(true);
    // Finding 1 (the P1): behind the re-prompt the deal side effect must NOT run —
    // no event board/player row is created before the 18+ box is ticked. A genuine
    // unattested callback keeps the gate closed (Finding 3 negative control).
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // Tick the 18+ box and enter — attest() persists + optimistically lifts the gate.
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /enter the event/i }));

    expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER);
    expect(boardShown()).toBe(true);
    expect(rePrompted()).toBe(false);
    // Attesting fires the DEFERRED deal, exactly once.
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });
});

// Finding 1 (P1): the attestation gate must gate the deal SIDE EFFECT, not just
// the UI — joinAndDeal cannot create the board/player row until attestation is
// settled true. Finding 3 (P2): the optimistic attested=true is sticky per uid,
// so a stale auth-state callback read cannot downgrade a just-attested User back
// to a re-prompt, and the deferred deal still fires on that optimistic path.
describe('attestation gates the deal side effect + sticky optimistic attest (#23, Findings 1 & 3)', () => {
  it('deals exactly once for an already-attested returning User', async () => {
    mocks.readAdultAttestation.mockResolvedValue(1_720_000_000_000); // settled: attested
    mount();
    await signIn(FAKE_USER);

    expect(boardShown()).toBe(true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });

  it('keeps a just-attested first-time User attested through a stale callback read, dealing once', async () => {
    // First-time flow: the sign-in continuation calls attest() optimistically, then
    // the auth-state callback lands with a read that PREDATES the attest write's
    // visibility (null). The per-uid sticky marker must keep the User attested (no
    // downgrade, no re-prompt), and the deferred deal fires once (Finding 3 ∘ 1).
    mocks.readAdultAttestation.mockResolvedValue(null); // stale: attest txn not visible to the read
    mocks.auth.currentUser = FAKE_USER;
    mountWithCapture();

    // 1. Continuation: popup resolves → signIn calls attest() → attested flips true
    //    and the uid is marked sticky. The User is not published yet, so no deal.
    await act(async () => {
      await ctxSignIn();
    });
    expect(mocks.attestAdult).toHaveBeenCalledWith(FAKE_USER);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // 2. The auth-state callback lands with the still-stale (null) read.
    await signIn(FAKE_USER);
    expect(rePrompted()).toBe(false);
    expect(boardShown()).toBe(true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });
});

// Codex round 2 on PR #112 (3548428646): with the deal gated on attested === true
// (Finding 1), a THROWN ensureUserProfile/readAdultAttestation left the
// attestation UNKNOWN forever — no deal, no re-prompt, no error: the Board's
// endless "Dealing your card…". A failed bootstrap is now an explicit ERROR
// terminal state on the retryable dealError surface (#61 precedent), whose Retry
// re-attempts the bootstrap — never joinAndDeal while the attestation is
// unsettled. Genuine in-flight loading is unchanged (the "does not flash" test).
describe('a FAILED attestation bootstrap is a retryable error, never a silent stall (#112 round 2)', () => {
  it('surfaces a thrown bootstrap read as the retryable deal error — no deal, no re-prompt, no spinner', async () => {
    mocks.readAdultAttestation.mockRejectedValue(new Error('network request failed'));
    mountWithProbe();
    await signIn(FAKE_USER);

    // The honest terminal state: the Player-worded retry surface — not the
    // indefinite dealing state, and never a re-prompt for an UNKNOWN attestation.
    expect(screen.getByRole('alert')).toHaveTextContent(/connection/i);
    expect(rePrompted()).toBe(false);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();
    expect(screen.getByTestId('dealing')).toHaveTextContent('idle');
  });

  it('Retry re-runs the bootstrap: repeat failure keeps the error; success settles attested and deals once', async () => {
    mocks.readAdultAttestation
      .mockRejectedValueOnce(new Error('network request failed')) // initial bootstrap fails
      .mockRejectedValueOnce(new Error('network request failed')) // first Retry fails too
      .mockResolvedValue(1_720_000_000_000); // second Retry settles: attested
    mountWithProbe();
    await signIn(FAKE_USER);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // A Retry that fails again keeps the honest error+retry surface.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(mocks.readAdultAttestation).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent(/connection/i);
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // A Retry that succeeds settles the attestation; the deferred deal fires
    // exactly once via the attested gate and its settle clears the error.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(boardShown()).toBe(true);
    expect(rePrompted()).toBe(false);
  });

  it('a Retry that settles UNATTESTED hands over to the re-prompt gate, then attesting deals once', async () => {
    mocks.readAdultAttestation
      .mockRejectedValueOnce(new Error('network request failed')) // initial bootstrap fails
      .mockResolvedValue(null); // Retry settles: DEFINITELY no stamp
    mocks.auth.currentUser = FAKE_USER;
    mountWithProbe();
    await signIn(FAKE_USER);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // The retry read is definite: unattested → the full-screen re-prompt takes
    // over (the stale deal error is dropped with it); still no deal.
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(rePrompted()).toBe(true));
    expect(mocks.joinAndDeal).not.toHaveBeenCalled();

    // Attesting from the re-prompt lifts the gate and fires the deferred deal once.
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /enter the event/i }));
    expect(boardShown()).toBe(true);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
  });
});

// #608 — the gate stops being a constant and becomes a consequence of the
// Event's content. Everything above still describes an Event whose pool holds
// explicit Prompts (`adultContent: true`, the fail-closed default this suite
// runs under); this block flips the posture and asserts the OTHER branch.
//
// The trap these pin: `attested` settles a permanent `false` on an Event that
// never asks for an attestation, so a naive `needsAttestation && adultContent`
// change would suppress the re-prompt AND strand the Player un-dealt behind the
// gate the deal effect keys on.
describe('the 18+ gate follows the EVENT, not the Edition (#608)', () => {
  beforeEach(() => setActiveAdultContent(false));
  afterEach(() => setActiveAdultContent(true));

  it('never re-prompts an un-attested Player on an Event with no adult content', async () => {
    mocks.readAdultAttestation.mockResolvedValue(null); // definitely no stamp
    mocks.auth.currentUser = FAKE_USER;
    mount();
    await signIn(FAKE_USER);
    await waitFor(() => expect(boardShown()).toBe(true));
    expect(rePrompted()).toBe(false);
  });

  it('still DEALS them — the gate is lifted, not merely hidden', async () => {
    // The regression this exists for: `attested` is permanently `false` here, so
    // a deal effect that keeps gating on it would leave every Player on a blank
    // Board forever. The equivalent authority signal is the settled profile
    // bootstrap, which still runs `ensureUserProfile` before any deal.
    mocks.readAdultAttestation.mockResolvedValue(null);
    mocks.auth.currentUser = FAKE_USER;
    mount();
    await signIn(FAKE_USER);
    await waitFor(() => expect(mocks.joinAndDeal).toHaveBeenCalledTimes(1));
    expect(mocks.ensureUserProfile).toHaveBeenCalled();
  });

  it('writes no attestation stamp, because none was ever collected', async () => {
    // `attestedAdultAt` is a CROSS-EVENT record on the global users/{uid} doc.
    // Stamping it from an Event that showed no checkbox would fabricate a
    // self-attestation the Player never made and carry it everywhere else.
    mocks.readAdultAttestation.mockResolvedValue(null);
    mocks.auth.currentUser = FAKE_USER;
    mountWithCapture();
    await signIn(FAKE_USER);
    await act(async () => void (await ctxSignIn()));
    expect(mocks.attestAdult).not.toHaveBeenCalled();
  });

  it('re-gates every un-attested Player the moment the Event turns 18+', async () => {
    // The retroactive path, and the whole reason the posture rides the pre-auth
    // routing document: an admin approves the first explicit Prompt, the
    // derivation flips `hostnames/{host}.adultContent`, the next resolution
    // installs `true`, and the EXISTING re-prompt does the rest — no new
    // surface, no new state machine.
    mocks.readAdultAttestation.mockResolvedValue(null);
    mocks.auth.currentUser = FAKE_USER;
    const { unmount } = mount();
    await signIn(FAKE_USER);
    await waitFor(() => expect(boardShown()).toBe(true));
    unmount();

    setActiveAdultContent(true);
    mount();
    await signIn(FAKE_USER);
    await waitFor(() => expect(rePrompted()).toBe(true));
    expect(boardShown()).toBe(false);
  });
});
