import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SignIn from './SignIn';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// #1123: Back from Google restores the sign-in screen from the bfcache with
// `busy` still true and a redirect promise that never settles. The screen must
// re-arm on the persisted `pageshow` that IS that restore, and must not re-arm
// on an ordinary (non-persisted) one, which fires on every normal load.
//
// Only the auth boundary is mocked: the REAL SignIn renders, and the mocked
// `signIn` reproduces the production shape by never resolving.

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    signIn: vi.fn(() => new Promise<void>(() => {})),
    signInReady: true,
    attest: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
});

const pageshow = (persisted: boolean) =>
  act(() => {
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
  });

describe('SignIn — bfcache Back-navigation recovery (#1123)', () => {
  it('re-arms the button on a persisted pageshow, but not on an ordinary one', async () => {
    render(<SignIn />);
    // The default Edition gates the button on the 18+ box; tick it first.
    await userEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveProperty('disabled', true);

    pageshow(false);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveProperty('disabled', true);

    pageshow(true);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toHaveProperty('disabled', false);
  });
});
