// Covers specs/auth-handoff-client.md § Mode selection — the half of it the
// Sign in button owns (#549).
//
// `authMode.test.ts` proves the strategy table resolves correctly. This proves
// the BUTTON actually reads it. Both facts are needed and neither implies the
// other: the table could be right while the tap still called `signIn()` and
// opened a Google flow that cannot return to this origin — which is the exact
// dead end ADR 0010 exists to remove, and the exact thing a strategy unit test
// cannot see.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  attest: vi.fn(),
  resolveSignInStrategy: vi.fn(),
  startAuthHandoff: vi.fn(),
  consumeHandoffFailure: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, signIn: mocks.signIn, signInReady: true, attest: mocks.attest }),
}));
vi.mock('../auth/authMode', () => ({ resolveSignInStrategy: mocks.resolveSignInStrategy }));
// An Event with no adult content, so the 18+ checkbox is absent and the button
// is enabled on load. This test is about which ROUTE the tap takes; the
// acknowledgement gate is #608's and is covered by its own tests.
vi.mock('../hooks/useAdultContent', () => ({ useAdultContent: () => false }));
vi.mock('../auth/handoffClient', () => ({
  startAuthHandoff: mocks.startAuthHandoff,
  consumeHandoffFailure: mocks.consumeHandoffFailure,
}));

import SignIn from './SignIn';

const HANDOFF = {
  kind: 'handoff' as const,
  authOrigin: 'https://auth.fiveacross.app',
  targetOrigin: 'https://summer-camp.fiveacross.app',
  returnPath: '/board',
};

function tap() {
  fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeHandoffFailure.mockReturnValue(null);
  mocks.startAuthHandoff.mockResolvedValue(true);
  mocks.resolveSignInStrategy.mockReturnValue({ kind: 'direct' });
});

afterEach(cleanup);

describe('SignIn — which route the tap takes', () => {
  it('uses the existing direct path where sign-in already works', async () => {
    render(<SignIn />);
    tap();
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalled());
    expect(mocks.startAuthHandoff).not.toHaveBeenCalled();
  });

  it('starts the handoff on an origin that needs it, instead of a dead-end Google flow', async () => {
    mocks.resolveSignInStrategy.mockReturnValue(HANDOFF);
    render(<SignIn />);
    tap();
    await waitFor(() => expect(mocks.startAuthHandoff).toHaveBeenCalled());
    expect(mocks.startAuthHandoff).toHaveBeenCalledWith({
      authOrigin: HANDOFF.authOrigin,
      targetOrigin: HANDOFF.targetOrigin,
      returnPath: HANDOFF.returnPath,
    });
    // The one collapse that would defeat the whole feature.
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('asks for the current location back, so the handoff does not lose the player place', () => {
    mocks.resolveSignInStrategy.mockReturnValue(HANDOFF);
    render(<SignIn />);
    tap();
    expect(mocks.resolveSignInStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ returnPath: expect.stringMatching(/^\//) }),
    );
  });

  // Falling through to `signIn()` here IS the silent cross-mode fallback ADR
  // 0010 forbids — the mount gate normally prevents this state, so the button
  // handling it anyway is defence in depth rather than a reachable path.
  it('never falls back to direct sign-in when the route is unavailable', async () => {
    mocks.resolveSignInStrategy.mockReturnValue({
      kind: 'unavailable',
      reason: 'same-origin-host-unregistered',
    });
    render(<SignIn />);
    tap();
    expect(await screen.findByTestId('signin-handoff-error')).toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.startAuthHandoff).not.toHaveBeenCalled();
  });

  it('surfaces a handoff that could not start, and re-arms the button', async () => {
    mocks.resolveSignInStrategy.mockReturnValue(HANDOFF);
    mocks.startAuthHandoff.mockResolvedValue(false);
    render(<SignIn />);
    tap();
    expect(await screen.findByTestId('signin-handoff-error')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue with google/i })).not.toBeDisabled(),
    );
  });

  // The pre-mount return leg fails before this tree exists, so the message has
  // to come from the read-once channel rather than from anything on screen.
  it('reports a return leg that failed before the app mounted', () => {
    mocks.consumeHandoffFailure.mockReturnValue({ reason: 'exchange-rejected' });
    render(<SignIn />);
    expect(screen.getByTestId('signin-handoff-error')).toBeInTheDocument();
  });

  it('shows nothing when the last load was an ordinary one', () => {
    render(<SignIn />);
    expect(screen.queryByTestId('signin-handoff-error')).toBeNull();
  });
});
