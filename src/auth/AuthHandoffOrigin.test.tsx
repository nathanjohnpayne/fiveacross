// Covers specs/auth-handoff-client.md § Leg 2—mint, at the central auth origin.
//
// The bounce page `auth.fiveacross.app` serves (#549). A failure here takes
// sign-in down for every Event at once, so the properties tested are the ones
// that would be silent: it must navigate to the SERVER's URL verbatim, it must
// not mint twice under StrictMode's double-invoked effects, and it must refuse a
// malformed request rather than redirect to Google and strand the player.
import { StrictMode, act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedirectResult: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  mintAuthHandoff: vi.fn(),
  providers: [] as Array<{ params: Record<string, string> }>,
  // The shared `auth` singleton the page reads `currentUser` off.
  auth: { currentUser: null as { uid: string } | null },
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: mocks.getRedirectResult,
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithRedirect: mocks.signInWithRedirect,
  signOut: mocks.signOut,
  GoogleAuthProvider: class {
    params: Record<string, string> = {};
    constructor() {
      mocks.providers.push(this);
    }
    setCustomParameters(p: Record<string, string>) {
      this.params = p;
    }
  },
}));
vi.mock('../firebase', () => ({ auth: mocks.auth, googleProvider: {} }));
vi.mock('./handoffExchange', () => ({ mintAuthHandoff: mocks.mintAuthHandoff }));

import AuthHandoffOrigin, { HANDOFF_ORIGIN_TIMEOUT_MS } from './AuthHandoffOrigin';

const TXN = 'T'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';
const SEARCH = `?target=${encodeURIComponent(ORIGIN)}&txn=${TXN}&return=/board`;

/**
 * This flow just came back from Google: `getRedirectResult` resolves the
 * credential of the sign-in the player completed for THIS request, so the page
 * mints without asking again.
 */
function returningFromGoogle() {
  mocks.getRedirectResult.mockResolvedValue({ user: { uid: 'u1' } });
}

/** Drive `onAuthStateChanged` to a settled answer, and hand back its unsubscribe. */
function withSession(user: { uid: string; email?: string } | null) {
  const unsubscribe = vi.fn();
  mocks.auth.currentUser = user;
  mocks.onAuthStateChanged.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    observer = cb;
    cb(user);
    return unsubscribe;
  });
  return unsubscribe;
}

/** The last observer the page subscribed, for driving a LATER auth transition. */
let observer: ((u: unknown) => void) | null = null;

let replace: Mock<(url: string) => void>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRedirectResult.mockResolvedValue(null);
  mocks.signInWithRedirect.mockResolvedValue(undefined);
  mocks.signOut.mockResolvedValue(undefined);
  mocks.providers.length = 0;
  mocks.auth.currentUser = null;
  observer = null;
  replace = vi.fn<(url: string) => void>();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthHandoffOrigin', () => {
  it('mints immediately and bounces when the player has just come back from Google', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board#fa_handoff=${'C'.repeat(43)}`);

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    // Verbatim. The server returns a URL rather than a code precisely so that no
    // client assembles a redirect target; rebuilding it is what would
    // reintroduce the open redirect.
    expect(replace).toHaveBeenCalledWith(`${ORIGIN}/board#fa_handoff=${'C'.repeat(43)}`);
    expect(mocks.mintAuthHandoff).toHaveBeenCalledWith(
      { targetOrigin: ORIGIN, transactionId: TXN, returnPath: '/board' },
      // The server refuses to mint for any other uid than the one signed in here.
      { expectedUid: 'u1' },
    );
    // A player with a session must never be sent to Google again.
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to Google via a top-level redirect', async () => {
    withSession(null);

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalled());
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  // A plain re-render must not restart anything.
  it('mints once across a re-render', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/`);

    const { rerender } = render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    rerender(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(mocks.mintAuthHandoff).toHaveBeenCalledTimes(1);
  });

  // The REAL StrictMode lifecycle — setup, cleanup, setup — which a bare
  // `rerender` does not exercise (Codex P2, round 1). Module-lifetime once-guards
  // survive that cleanup, so the second setup used to return having done
  // nothing while the first setup's continuations were already cancelled,
  // leaving this page on "Signing you in…" forever in development. Under
  // StrictMode React also double-invokes the render body, so the mint may be
  // attempted twice; what must hold is that the page RESOLVES.
  it('still completes under a real StrictMode mount', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board`);

    render(
      <StrictMode>
        <AuthHandoffOrigin search={SEARCH} navigate={replace} />
      </StrictMode>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${ORIGIN}/board`));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still redirects a signed-out visitor under a real StrictMode mount', async () => {
    withSession(null);

    render(
      <StrictMode>
        <AuthHandoffOrigin search={SEARCH} navigate={replace} />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalled());
  });

  it('refuses a malformed request without touching Google or the server', async () => {
    withSession(null);

    render(<AuthHandoffOrigin search="?target=notaurl&txn=short" navigate={replace} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/sign-in link is incomplete/i)).toBeInTheDocument();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
  });

  it('reports a refused mint rather than stranding the player on a spinner', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockRejectedValue(new Error('invalid-argument'));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/couldn't return you to your event/i)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('reports a failed Google round trip', async () => {
    withSession(null);
    mocks.signInWithRedirect.mockRejectedValue(new Error('popup-blocked'));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/didn't finish/i)).toBeInTheDocument();
  });

  // A rejected `getRedirectResult` is TERMINAL, not an ordinary first visit
  // (Codex P2, round 1). An ordinary first visit resolves `null`; a rejection
  // means Google returned an OAuth error or the player cancelled. Swallowing it
  // left the observer seeing a signed-out user and firing another redirect —
  // bouncing the player back to Google in a loop instead of showing the failure.
  it('treats a rejected redirect result as terminal instead of looping to Google', async () => {
    withSession(null);
    mocks.getRedirectResult.mockRejectedValue(new Error('auth/user-cancelled'));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/didn't finish/i)).toBeInTheDocument();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

// Codex P2, Phase 4b. The return leg bounds its network work so captive and
// shipboard wifi cannot hold the mount forever; this page had no such bound, so
// an operation that never settled left the player on "Signing you in…"
// indefinitely — on the origin whose failure takes sign-in down for every Event.
describe('the central-origin page reaches a terminal state', () => {
  it('gives up when the redirect settle never resolves', async () => {
    mocks.getRedirectResult.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('gives up when the auth state never settles', async () => {
    mocks.onAuthStateChanged.mockImplementation(() => vi.fn());
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('gives up when the mint never returns', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not fire the deadline against a page that already bounced', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board`);
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={30} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${ORIGIN}/board`));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Phase 4b P1, the INVERSE bug: disarming the deadline before the navigation
  // actually starts meant a `signInWithRedirect` that hangs on initiation would
  // spin forever with nothing left to catch it. The timer therefore stays armed
  // across the call — harmless on the happy path, because a real redirect
  // unloads the page and takes the timer with it.
  it('still rescues a redirect that hangs on initiation', async () => {
    withSession(null);
    mocks.signInWithRedirect.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // Phase 4b P1: calling fail() alone left the continuations live, so a late
  // mint could navigate the browser away from the failure already on screen.
  it('a timed-out page cannot be navigated away by a late mint', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    let landMint: (v: string) => void = () => {};
    mocks.mintAuthHandoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          landMint = resolve;
        }),
    );

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    landMint(`${ORIGIN}/board`);
    await new Promise((r) => setTimeout(r, 40));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('allows a full Google round trip rather than failing eagerly', () => {
    expect(HANDOFF_ORIGIN_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });
});

// Phase 4b P2. A failure that left the timer armed meant the deadline fired
// later and REPLACED an accurate error with a generic one — the page getting
// less truthful the longer the player looked at it.
describe('the first real failure is the one that sticks', () => {
  it('keeps the mint-failure message instead of letting the deadline overwrite it', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockRejectedValue(new Error('invalid-argument'));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);

    expect(await screen.findByText(/couldn't return you to your event/i)).toBeInTheDocument();
    // Well past the deadline — the accurate message must survive it.
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText(/couldn't return you to your event/i)).toBeInTheDocument();
    expect(screen.queryByText(/didn't finish/i)).toBeNull();
  });

  it('keeps the redirect-failure message too', async () => {
    withSession(null);
    mocks.signInWithRedirect.mockRejectedValue(new Error('popup-blocked'));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);

    expect(await screen.findByText(/didn't finish/i)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

// Phase 4b P2. Setting the guard BEFORE attempting the navigation meant a
// `replace` that threw fell into the catch, where `terminate` returned
// immediately because `settled` was already true — leaving the page on the
// minting spinner forever with the deadline already cleared. No error, no
// timeout, no way out.
describe('a navigation that throws is still a failure', () => {
  it('shows the mint failure when replace() throws', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board`);
    const throwingNavigate = vi.fn(() => {
      throw new Error('navigation blocked');
    });

    render(<AuthHandoffOrigin search={SEARCH} navigate={throwingNavigate} timeoutMs={5_000} />);

    expect(await screen.findByText(/couldn't return you to your event/i)).toBeInTheDocument();
    expect(throwingNavigate).toHaveBeenCalled();
  });
});

// Phase 4b P2. Once minting has started the player IS signed in at this origin,
// so "Google sign-in didn't finish / nothing was changed" is simply untrue.
describe('the deadline reports the failure that actually happened', () => {
  it('says mint-failed when the hang is in minting, not sign-in', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockImplementation(() => new Promise(() => {}));

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={25} />);

    expect(await screen.findByText(/couldn't return you to your event/i)).toBeInTheDocument();
    expect(screen.queryByText(/didn't finish/i)).toBeNull();
  });

  it('still says sign-in-failed when the hang is before minting', async () => {
    mocks.getRedirectResult.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={25} />);
    expect(await screen.findByText(/didn't finish/i)).toBeInTheDocument();
  });
});

// A session that PREDATES this flow is never minted for silently. The `txn` in
// the URL is caller-chosen, so minting on page load would let whoever opened the
// URL receive a code for the account last signed in here — on a shared device,
// the previous person's. The page asks first; "Use another account" signs the
// central session out and sends the player through Google's account chooser.
describe('an existing session is confirmed before anything is minted', () => {
  it('shows the target host and the account, and mints nothing until Continue', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board`);

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    const proceed = await screen.findByRole('button', {
      name: 'Continue to summer-camp.fiveacross.app as first@example.com',
    });
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeInTheDocument();
    // Give any stray continuation a chance to run: still nothing minted.
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();

    fireEvent.click(proceed);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${ORIGIN}/board`));
    expect(mocks.mintAuthHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.mintAuthHandoff).toHaveBeenCalledWith(expect.anything(), { expectedUid: 'u1' });
  });

  // Codex P1 / CodeRabbit on #1350: another same-origin tab can replace the
  // shared session while the prompt waits, and the callable mints for whoever
  // is current when it runs. The confirmed uid is re-checked before minting.
  it('refuses Continue when the session changed after the prompt rendered', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    const proceed = await screen.findByRole('button', { name: /^Continue to/ });

    mocks.auth.currentUser = { uid: 'u2' }; // swapped by another tab, no event seen yet
    fireEvent.click(proceed);

    expect(await screen.findByText(/signed-in account changed/i)).toBeInTheDocument();
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('withdraws the prompt when a later auth transition names another account', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    await screen.findByRole('button', { name: /^Continue to/ });

    mocks.auth.currentUser = { uid: 'u2' };
    act(() => observer?.({ uid: 'u2', email: 'second@example.com' }));

    expect(await screen.findByText(/signed-in account changed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Continue to/ })).toBeNull();
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
  });

  it('ignores a later transition that keeps the same account', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    await screen.findByRole('button', { name: /^Continue to/ });
    act(() => observer?.({ uid: 'u1', email: 'first@example.com' }));
    expect(screen.getByRole('button', { name: /^Continue to/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Use another account" signs the central session out and opens Google’s account chooser', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));

    await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalled());
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInWithRedirect.mock.invocationCallOrder[0],
    );
    const provider = mocks.signInWithRedirect.mock.calls[0][1] as { params: Record<string, string> };
    expect(provider.params).toEqual({ prompt: 'select_account' });
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not time out while the player is reading the confirmation', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    await screen.findByRole('button', { name: 'Use another account' });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeInTheDocument();
  });

  it('re-arms the deadline once the player chooses, so a hung mint still reaches a failure', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    mocks.mintAuthHandoff.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Continue to/ }));
    expect(await screen.findByText(/couldn't return you to your event/i)).toBeInTheDocument();
  });

  it('reports a sign-out that fails instead of minting for the old account', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    mocks.signOut.mockRejectedValue(new Error('network'));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
  });
});

// Round 2 on #1350 (CodeRabbit / Codex): the AUTOMATIC mint after a Google
// round trip is bound to the redirect credential's account, not to whatever
// the shared session reports when the observer fires.
describe('the automatic mint is bound to the redirect credential', () => {
  it('mints with the redirect uid as expectedUid when the session agrees', async () => {
    returningFromGoogle();
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board`);
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(mocks.mintAuthHandoff).toHaveBeenCalledWith(expect.anything(), { expectedUid: 'u1' });
  });

  it('refuses when another tab switched the session between the redirect and the observer', async () => {
    returningFromGoogle(); // this flow signed in u1…
    withSession({ uid: 'u2', email: 'second@example.com' }); // …but the session now reports u2
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    expect(await screen.findByText(/signed-in account changed/i)).toBeInTheDocument();
    expect(mocks.mintAuthHandoff).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

// Codex on #1350: after "Use another account" the central session HAS been
// signed out, so a later failure must not say nothing changed.
describe('a failed account switch says the session was signed out', () => {
  it('reports switch-failed when the chooser redirect is refused after the sign-out', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    mocks.signInWithRedirect.mockRejectedValue(new Error('blocked'));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(await screen.findByText(/You were signed out here/i)).toBeInTheDocument();
  });

  it('reports switch-failed when the chooser redirect hangs past the deadline', async () => {
    withSession({ uid: 'u1', email: 'first@example.com' });
    mocks.signInWithRedirect.mockImplementation(() => new Promise(() => {}));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} timeoutMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(await screen.findByText(/You were signed out here/i)).toBeInTheDocument();
  });

  it('never claims nothing changed on an ordinary failed sign-in either', async () => {
    withSession(null);
    mocks.signInWithRedirect.mockRejectedValue(new Error('blocked'));
    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    expect(await screen.findByText(/didn't finish/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  });
});
