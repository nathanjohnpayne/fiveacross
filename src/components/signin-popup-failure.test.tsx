// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import SignIn from './SignIn';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// #1134 (Phase 4b P2 on #1131): a memory-only Invitation signs in through the
// popup, and a popup the browser blocks rejects `signIn`. The handler used to
// clear `busy` and nothing else, so the player came back to an enabled button
// with no word on why. The failure has to be visible, and it has to be static
// copy: the Firebase error never reaches the DOM.

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    signIn: mocks.signIn,
    signInReady: true,
    attest: vi.fn(),
  }),
}));

const ERROR_TEXT = 'Firebase: Error (auth/popup-blocked).';

beforeEach(() => {
  vi.clearAllMocks();
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

describe('SignIn — a direct sign-in that rejects (#1134)', () => {
  it('says the sign-in did not finish and re-arms the button', async () => {
    mocks.signIn.mockRejectedValue(new Error(ERROR_TEXT));
    await tapContinue();
    const alert = await screen.findByTestId('signin-handoff-error');
    expect(alert).toHaveTextContent(/didn't finish/i);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toHaveProperty('disabled', false);
  });

  it('never renders the error itself', async () => {
    mocks.signIn.mockRejectedValue(new Error(ERROR_TEXT));
    await tapContinue();
    await screen.findByTestId('signin-handoff-error');
    expect(document.body.textContent).not.toContain('popup-blocked');
    expect(document.body.textContent).not.toContain('Firebase');
  });

  it('shows nothing when the sign-in settles', async () => {
    mocks.signIn.mockResolvedValue(undefined);
    await tapContinue();
    expect(mocks.signIn).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('signin-handoff-error')).not.toBeInTheDocument();
  });
});
