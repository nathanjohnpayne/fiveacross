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
    // The tagline is deliberately itinerary-free (Nathan, 2026-08-07): the gcb
    // brand now serves more than the one sailing, and a baked "Trieste →
    // Barcelona · July 2026" reads as immediately wrong under any other
    // Event's postcard. Event specifics belong to Event data, not the brand.
    // #881 gave gcb its own Join-frame voice chip, ADDED above the plain
    // tagline (not replacing it — that is vacay's own chip behavior) — same
    // itinerary-free spirit, new copy.
    expect(screen.getByText('What happens at sea. Goes on the card.')).toBeTruthy();
    expect(screen.getByText('Sign in, get your card, mark it if you see it.')).toBeTruthy();
    expect(screen.queryByText(/Trieste → Barcelona/)).toBeNull();
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

  it('brands the deal-failure retry panel too — it reuses the same shell, with no offline-note claim about a card that was never dealt', () => {
    // Codex P2, PR #896 round 4: no card exists yet on this screen, so
    // brand.offlineNote's "your card keeps working offline" would be a false
    // claim here specifically — this panel carries no offline note at all.
    setActiveEdition('vacay');
    render(<DealError message="Could not deal your card." onRetry={vi.fn()} retrying={false} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VACAY BINGO');
    expect(screen.queryByText(/at sea/i)).toBeNull();
    expect(screen.queryByText(/keeps working offline/i)).toBeNull();
  });

  // The uptime synthetic (#142, tests/synthetic/app-mounts.spec.ts) waits for
  // this gate to prove the deployed app mounted. It used to wait for the
  // `GAY CRUISE BINGO` heading — which the test above makes per-Edition, so on a
  // Vacay host it could never match and every healthy Bodega deploy was reported
  // as a failed one, complete with rollback instructions. The mount signal is
  // now `data-testid="signin-gate"`, and the point of it is to be the one handle
  // on this screen that brand copy cannot move. Deleting or renaming it silently
  // re-arms that false outage on the next deploy, so it is asserted here.
  it('keeps the Edition-free mount signal the uptime synthetic waits for', () => {
    setActiveEdition('vacay');
    const { container } = render(<SignIn />);
    expect(container.querySelector('[data-testid="signin-gate"]')).not.toBeNull();
  });
});
