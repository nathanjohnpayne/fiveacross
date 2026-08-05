import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SignIn, { DealError } from './SignIn';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

// Covers the Edition-branded sign-in gate (#543, ADR 0009 § Consequences).
//
// `src/editions.test.ts` proves the brand table resolves correctly; this proves
// the two screens that render before (and instead of) the Board actually READ
// it. Both facts are needed — the table could be right while the component
// still held the string.
//
// Only the auth boundary is mocked: the REAL SignIn renders.

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, signIn: vi.fn(), signInReady: true, attest: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  setActiveEdition(DEFAULT_EDITION);
});

describe('SignIn — the gate wears the resolved Edition', () => {
  it('shows the cruise brand on the legacy Edition', () => {
    render(<SignIn />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('GAY CRUISE BINGO');
    expect(screen.getByText(/Trieste → Barcelona/)).toBeTruthy();
  });

  it('shows the Vacay brand once the resolver installs that Edition', () => {
    setActiveEdition('vacay');
    render(<SignIn />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VACAY BINGO');
    // The regression: a Bodega guest saw another product's name and a cruise
    // that is not happening, on the first screen they ever load.
    expect(screen.queryByText(/Trieste → Barcelona/)).toBeNull();
    expect(screen.queryByText(/at sea/i)).toBeNull();
  });

  it('brands the deal-failure retry panel too — it reuses the same shell', () => {
    setActiveEdition('vacay');
    render(<DealError message="Could not deal your card." onRetry={vi.fn()} retrying={false} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VACAY BINGO');
    expect(screen.queryByText(/at sea/i)).toBeNull();
  });
});
