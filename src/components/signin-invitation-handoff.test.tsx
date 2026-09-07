// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import SignIn from './SignIn';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// #804 (Codex P1 on #1131): production wildcard hosts sign in through the
// central-auth handoff, which never passes through AuthContext.signIn's
// durability check. A pending Invitation that only memory holds would be
// destroyed by the handoff's top-level navigation, and the returning visit
// would classify `clear` and deal without ever redeeming it. The tap must give
// the record a stored copy first, and stay on the document if it cannot.

const mocks = vi.hoisted(() => ({
  startAuthHandoff: vi.fn(),
  consumeHandoffFailure: vi.fn(),
  persistPendingEventInvitation: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    signIn: vi.fn(() => Promise.resolve()),
    signInReady: true,
    attest: vi.fn(),
  }),
}));
vi.mock('../auth/authMode', () => ({
  resolveSignInStrategy: () => ({
    kind: 'handoff',
    authOrigin: 'https://auth.fiveacross.app',
    targetOrigin: window.location.origin,
    returnPath: '/',
  }),
}));
vi.mock('../auth/handoffClient', () => ({
  startAuthHandoff: mocks.startAuthHandoff,
  consumeHandoffFailure: mocks.consumeHandoffFailure,
}));
vi.mock('../pendingEventInvitation', () => ({
  EVENT_INVITATION_FRAGMENT_KEY: 'fa_invite',
  persistPendingEventInvitation: mocks.persistPendingEventInvitation,
}));

const RECORD = {
  captureId: 'capture-1',
  captureOrdinal: 0,
  code: 'Q'.repeat(43),
  origin: window.location.origin,
  capturedAt: 1_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startAuthHandoff.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
});

async function tapContinue() {
  render(<SignIn />);
  // The default Edition gates the button on the 18+ box; tick it first.
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
}

describe('SignIn — the handoff keeps a memory-only Invitation (#804)', () => {
  it('starts the handoff once the record has a stored copy', async () => {
    mocks.persistPendingEventInvitation.mockReturnValue({ record: RECORD, durable: true });
    await tapContinue();
    expect(mocks.persistPendingEventInvitation).toHaveBeenCalledWith({
      origin: window.location.origin,
      now: expect.any(Number),
    });
    expect(mocks.startAuthHandoff).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('signin-invitation-unkept')).not.toBeInTheDocument();
  });

  it('starts the handoff when the origin holds no Invitation at all', async () => {
    mocks.persistPendingEventInvitation.mockReturnValue(null);
    await tapContinue();
    expect(mocks.startAuthHandoff).toHaveBeenCalledOnce();
  });

  it('stays on the document and says why when the stores still refuse the record', async () => {
    mocks.persistPendingEventInvitation.mockReturnValue({ record: RECORD, durable: false });
    await tapContinue();
    expect(mocks.startAuthHandoff).not.toHaveBeenCalled();
    expect(screen.getByTestId('signin-invitation-unkept')).toHaveTextContent(/keep your invitation/i);
    // The bearer never reaches the DOM.
    expect(document.body.textContent).not.toContain('Q'.repeat(43));
    // The button re-arms so the Player can retry after freeing storage.
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toHaveProperty('disabled', false);
  });
});
