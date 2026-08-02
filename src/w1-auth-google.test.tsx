import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers specs/w1-auth-google.md — the App-level surfacing of a swallowed
// join/deal failure and the DealError retry affordance.

// Drive App off a controllable auth value instead of the real Firebase-backed
// provider; `authState.value.dealError` is set per test.
const authState = vi.hoisted(() => ({
  value: { dealError: null as string | null, dealing: false, retryDeal: vi.fn() },
}));

vi.mock('./auth/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'sailor-1' }, loading: false, ...authState.value }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

// App imports the tab page components, which transitively pull in the real
// Firebase SDK; a stub firebase module keeps the SDK from initializing, and
// inert data hooks let the shell (Nav) and the /items page render under jsdom.
vi.mock('./firebase', () => ({
  auth: {}, googleProvider: {}, db: {}, storage: {}, analytics: null, app: {}, EVENT_ID: 'x',
}));
vi.mock('./hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs.
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useEventDoc: () => ({ data: null, loading: false }),
  useItems: () => ({ items: [], loading: false }),
  // The always-mounted ConfirmWinMoments (#41) subscribes to these; inert stubs
  // keep it a silent no-op under the App shell so this deal-error test stays focused.
  useBoard: () => ({ data: null, loading: false, hasServerData: false }),
  useMyDayBoards: () => new Map(),
  useMyPlayer: () => ({ data: null, loading: false, hasServerData: false }),
  useLeaderboard: () => ({ players: [], loading: false, hasServerData: false }),
  useMyClaims: () => ({ claims: [], loading: false, hasServerData: false }),
  // ProfileEditor now renders as the Nav header avatar (#143), so the App shell
  // pulls in useMyUser too; an inert stub keeps it out of this test's focus.
  useMyUser: () => ({ data: null, loading: false, hasServerData: false }),
  // More.tsx (#208) reads the Admin-row badge count on every mount, admin or
  // not; an inert stub keeps that badge subscription out of this test's focus.
  usePendingItemCount: () => ({ count: 0, loading: false }),
  // The Card-tab NoticeBanner (#439) now mounts above every card state, including
  // the DealError this test exercises; an empty stub keeps it a silent no-op.
  useNotices: () => ({ notices: [] }),
}));

import App from './App';
import { DealError } from './components/SignIn';

const POOL_MESSAGE =
  "We couldn't deal your card yet—the prompt pool is below the 24 a card needs. Ask an admin to add a few prompts, then retry.";

beforeEach(() => {
  vi.clearAllMocks();
  authState.value = { dealError: null, dealing: false, retryDeal: vi.fn() };
});

describe('App surfaces a failed deal on the Card tab, shell intact', () => {
  it('renders the retry surface as Card content inside the still-mounted shell — never a blank Board', async () => {
    authState.value.dealError = POOL_MESSAGE;
    const { container } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    // The Player sees a Player-worded reason on the Card tab (no blank Board)...
    expect(screen.getByRole('alert')).toHaveTextContent(/24 a card needs/);
    // ...inside the still-mounted app shell with Nav, not a full-screen takeover
    // that would hide the tabs (Codex P2: recovery lives on /items).
    expect(container.querySelector('.app')).not.toBeNull();
    expect(container.querySelector('.nav')).not.toBeNull();

    // Retry re-invokes the deal in place (no full reload).
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(authState.value.retryDeal).toHaveBeenCalledTimes(1);
  });

  it('keeps Nav and the other tabs reachable while the deal error is active', async () => {
    authState.value.dealError = POOL_MESSAGE;
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    // Phase 1.5 (#203) dropped the Prompts tab — recovery prompt-adding now
    // lives inside the More menu (#208). The shell stays navigable during the
    // error: the More tab is rendered by Nav and navigating there mounts the
    // More page (its sign-out affordance) while the Card error stays active.
    expect(screen.queryByRole('link', { name: 'Prompts' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'More' }));
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Back on Card, the retry surface is still up — never a blank Board.
    await userEvent.click(screen.getByRole('link', { name: 'Card' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/24 a card needs/);
  });
});

describe('DealError retry affordance', () => {
  it('re-invokes the deal when the Player taps Retry, and shows progress while dealing', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <DealError message="pool too small" onRetry={onRetry} retrying={false} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('pool too small');

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DealError message="pool too small" onRetry={onRetry} retrying={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveTextContent(/dealing/i);
  });
});
