import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setActiveAdultContent } from '../adultContent';
import SignIn from './SignIn';
import AcceptableUse from './AcceptableUse';
import ItemPool from './ItemPool';

// Covers the 18+ posture's GATE half (#608): what the app actually renders once
// a posture has been installed. `src/adult-content.test.ts` covers the
// resolution half.
//
// The decision this pins: the adults-only posture follows the EVENT'S CONTENT,
// not its Edition. A `fiveacross` Event with explicit Prompts is 18+ in general
// vocabulary; a `gcb` Event with a tame pool is not 18+ at all. The two axes are
// independent, so every assertion here flips `adultContent` alone and leaves the
// Edition on its default.

vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));
vi.mock('../data/api', () => ({
  addItem: vi.fn(async () => {}),
  reportItem: vi.fn(async () => {}),
  checkItemRateLimit: () => true,
  itemRateLimitRemainingMs: () => 0,
}));
vi.mock('../hooks/useData', () => ({
  useItems: () => ({ items: [], loading: false }),
  useMyPendingItems: () => ({ items: [], hasServerData: true }),
  // #559 round 2: ItemPool's own unfiltered "my active submissions" query —
  // empty/no-op here, for the same reason as useMyPendingItems above.
  useMyActiveItems: () => ({ items: [], loading: false, hasServerData: true }),
  // #559: ItemPool now reads the Day schedule for its submitter-state pills.
  // No schedule here — a no-op for this file's adult-content-gate assertions.
  useEventDoc: () => ({ data: undefined }),
}));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, signIn: vi.fn(), signInReady: true, attest: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  setActiveAdultContent(true);
});

describe('SignIn — the acknowledgement is a consequence of the pool', () => {
  // The re-prompt entry point is unreachable on a non-adult Event (AuthProvider
  // gates `needsAttestation` on the same flag), so the signed-out gate is what
  // this component renders there. Both modes read `user` from context; the mock
  // supplies one, which is the re-prompt mode — so assert on the checkbox and
  // the button, which are shared.
  it('gates the button behind the checkbox when the Event holds adult content', () => {
    setActiveAdultContent(true);
    render(<SignIn />);
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button')).toHaveProperty('disabled', false);
  });

  it('shows no age claim at all, and enables the button on load, when it does not', () => {
    setActiveAdultContent(false);
    render(<SignIn />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/18 or older/i)).toBeNull();
    // Asking a wedding party to confirm they are 18 is not a harmless extra tap
    // — it mislabels the product.
    expect(screen.getByRole('button')).toHaveProperty('disabled', false);
  });

  it('keeps the Edition-free mount signal in both postures', () => {
    for (const posture of [true, false]) {
      setActiveAdultContent(posture);
      const { container } = render(<SignIn />);
      expect(container.querySelector('[data-testid="signin-gate"]'), String(posture)).not.toBeNull();
      cleanup();
    }
  });
});

describe('AcceptableUse — the 18+ claim is dropped, not softened', () => {
  it('makes the age claim when the Event holds adult content', () => {
    setActiveAdultContent(true);
    render(<AcceptableUse variant="row" />);
    expect(screen.getByText('18+ advisory & acceptable use')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/This is an 18\+ space/)).toBeTruthy();
    expect(screen.getByText(/you confirm/)).toBeTruthy();
  });

  it('switches to the community-guidelines register when it does not', () => {
    setActiveAdultContent(false);
    render(<AcceptableUse variant="row" />);
    expect(screen.getByText('Community guidelines')).toBeTruthy();
    expect(screen.queryByText('18+ advisory & acceptable use')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/This is an 18\+ space/)).toBeNull();
    expect(screen.getByText(/This is a shared space/)).toBeTruthy();
    // The rest of the sheet stands on its own — be kind, no harassment, how to
    // report. Only the age claim goes.
    expect(screen.getByText(/No harassment/)).toBeTruthy();
  });
});

describe('ItemPool — 🔞 is a category, not a warning label', () => {
  it('offers the tag when the Event holds adult content', () => {
    setActiveAdultContent(true);
    render(<ItemPool />);
    expect(screen.getByText(/Spicy/)).toBeTruthy();
  });

  it('hides it when there is nothing to categorise', () => {
    setActiveAdultContent(false);
    render(<ItemPool />);
    expect(screen.queryByText(/Spicy/)).toBeNull();
  });
});
