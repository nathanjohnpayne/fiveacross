// Covers specs/auth-handoff-client.md § Leg 2—mint, at the central auth origin.
//
// The bounce page `auth.fiveacross.app` serves (#549). A failure here takes
// sign-in down for every Event at once, so the properties tested are the ones
// that would be silent: it must navigate to the SERVER's URL verbatim, it must
// not mint twice under StrictMode's double-invoked effects, and it must refuse a
// malformed request rather than redirect to Google and strand the player.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedirectResult: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithRedirect: vi.fn(),
  mintAuthHandoff: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  getRedirectResult: mocks.getRedirectResult,
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithRedirect: mocks.signInWithRedirect,
}));
vi.mock('../firebase', () => ({ auth: {}, googleProvider: {} }));
vi.mock('./handoffExchange', () => ({ mintAuthHandoff: mocks.mintAuthHandoff }));

import AuthHandoffOrigin from './AuthHandoffOrigin';

const TXN = 'T'.repeat(43);
const ORIGIN = 'https://summer-camp.fiveacross.app';
const SEARCH = `?target=${encodeURIComponent(ORIGIN)}&txn=${TXN}&return=/board`;

/** Drive `onAuthStateChanged` to a settled answer, and hand back its unsubscribe. */
function withSession(user: { uid: string } | null) {
  const unsubscribe = vi.fn();
  mocks.onAuthStateChanged.mockImplementation((_auth: unknown, cb: (u: unknown) => void) => {
    cb(user);
    return unsubscribe;
  });
  return unsubscribe;
}

let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRedirectResult.mockResolvedValue(null);
  mocks.signInWithRedirect.mockResolvedValue(undefined);
  replace = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthHandoffOrigin', () => {
  it('mints immediately and bounces when a session already exists here', async () => {
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/board#fa_handoff=${'C'.repeat(43)}`);

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    // Verbatim. The server returns a URL rather than a code precisely so that no
    // client assembles a redirect target; rebuilding it is what would
    // reintroduce the open redirect.
    expect(replace).toHaveBeenCalledWith(`${ORIGIN}/board#fa_handoff=${'C'.repeat(43)}`);
    expect(mocks.mintAuthHandoff).toHaveBeenCalledWith({
      targetOrigin: ORIGIN,
      transactionId: TXN,
      returnPath: '/board',
    });
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

  // StrictMode double-invokes effects in development, and both legs navigate the
  // browser — an unguarded page fires two redirects and mints a second code
  // nobody ever redeems.
  it('mints once even when the effect runs twice', async () => {
    withSession({ uid: 'u1' });
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/`);

    const { rerender } = render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);
    rerender(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(mocks.mintAuthHandoff).toHaveBeenCalledTimes(1);
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

  // A rejected `getRedirectResult` is an ordinary first visit, not an error:
  // swallowing it is what lets the session check below still run.
  it('still checks the session when the redirect result rejects', async () => {
    withSession({ uid: 'u1' });
    mocks.getRedirectResult.mockRejectedValue(new Error('no pending redirect'));
    mocks.mintAuthHandoff.mockResolvedValue(`${ORIGIN}/`);

    render(<AuthHandoffOrigin search={SEARCH} navigate={replace} />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${ORIGIN}/`));
  });
});
