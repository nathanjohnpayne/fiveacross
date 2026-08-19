import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { saveCardSnapshot } from './data/cardCache';
import type { Cell } from './types';

// A mutable auth stub so each test drives {dealError, dealing} without a real
// AuthProvider. The default is a signed-in Player with no deal error.
const authState: { value: Record<string, unknown> } = { value: {} };
vi.mock('./auth/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'sailor-1' },
    loading: false,
    dealError: null,
    dealErrorReason: null,
    canRenderEventContent: true,
    dealing: false,
    retryDeal: () => {},
    ...authState.value,
  }),
}));

// The Card/Feed/Ranks/More pages pull in Firebase-backed trees; stub them so App
// renders its ROUTING (the #434 deal-error decision) in isolation. SignIn stays
// real so the genuine DealError panel renders; CachedCardFallback + cardCache
// stay real so the durable-cache path is exercised end to end.
vi.mock('./components/Board', () => ({ default: () => <div data-testid="board" /> }));
vi.mock('./components/NoticeBanner', () => ({ default: () => null }));
vi.mock('./components/Leaderboard', () => ({ default: () => <div data-testid="ranks" /> }));
vi.mock('./components/ProofFeed', () => ({ default: () => <div data-testid="feed" /> }));
vi.mock('./components/More', () => ({ default: () => <div data-testid="more" /> }));
vi.mock('./components/Nav', () => ({ default: () => <nav data-testid="nav" /> }));
vi.mock('./components/PullToRefresh', () => ({ default: () => null }));
vi.mock('./components/BugReport', () => ({
  BugReportProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// The `/setup/*` route's real SetupWizard is left unmocked (its own route
// decision is worth testing in isolation), but its Basics step (#790) pulls
// in `./data/hostnames` for the live address check, and that module's
// top-level `import '../firebase'` calls `getAuth(app)` at MODULE LOAD
// TIME — which throws `auth/invalid-api-key` in this env-var-free test run,
// same as every other Firebase-backed tree stubbed above. Stubbed to its one
// export the step actually calls. Resolves 'available': StepBasics's
// background re-check of an already-committed candidate downgrades it on
// anything else, and this suite runs in REAL time (no faked debounce), so a
// less generous stub would risk a flaky downgrade mid-test.
vi.mock('./data/hostnames', () => ({
  checkSlugAvailability: vi.fn(() => Promise.resolve('available')),
  // `StepBasics` calls this one, not `checkSlugAvailability` (CodeRabbit
  // Major, PR #911). Omitting it left `undefined` to be invoked inside the
  // debounced callback — harmless today only because no test here advances
  // past the 400ms debounce and unmount clears the timer first, which is a
  // timing accident rather than a contract. Mocking what the component
  // actually calls removes the dependence on that accident.
  checkEventAddressAvailability: vi.fn((slug: string, alternateApex: string | null) =>
    Promise.resolve(
      [`${slug}.fiveacross.app`, ...(alternateApex === null ? [] : [`${slug}.${alternateApex}`])].map(
        (hostname) => ({ hostname, status: 'available' as const }),
      ),
    ),
  ),
}));

// eslint-disable-next-line import/first -- App must be imported AFTER the mocks above register.
import App from './App';

function cells(): Cell[] {
  return Array.from({ length: 25 }, (_, i) => ({
    index: i,
    itemId: i === 12 ? null : `item-${i}`,
    text: i === 12 ? 'Free' : `Prompt ${i}`,
    free: i === 12,
    marked: i === 12,
    markedAt: i === 12 ? 1 : null,
  }));
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
}

const DEAL_ERROR = 'We could not deal your bingo card.';
const POOL_ERROR = 'The prompt pool is below 24. Ask an admin to add prompts.';

// jsdom here leaves `window.localStorage` unset (see src/hooks/useTextSize.test.ts).
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

describe('App — Card route deal-error routing (#434)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    authState.value = {};
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the live Board when there is no deal error', () => {
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });

  it('shows the durable cached card (not the reload screen) on a CONNECTION-class failure with a snapshot', () => {
    saveCardSnapshot({ uid: 'sailor-1', dayIndex: 0, cells: cells(), bingoCount: 1, day: null });
    authState.value = { dealError: DEAL_ERROR, dealErrorReason: 'connection', dealing: false };
    renderApp();
    expect(screen.getByText(/Showing your saved card/)).toBeInTheDocument();
    expect(screen.queryByText(DEAL_ERROR)).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('falls back to the full reload screen when a connection failure has nothing cached', () => {
    authState.value = { dealError: DEAL_ERROR, dealErrorReason: 'connection', dealing: false };
    renderApp();
    expect(screen.getByText(DEAL_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('withholds the routed shell while attestation authority is still settling', () => {
    authState.value = { canRenderEventContent: false, dealError: null };
    renderApp();
    expect(screen.getByText(/Checking your cruise pass/)).toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('keeps the reload screen when attestation proof is not established', () => {
    saveCardSnapshot({ uid: 'sailor-1', dayIndex: 0, cells: cells(), bingoCount: 1, day: null });
    authState.value = {
      dealError: DEAL_ERROR,
      dealErrorReason: 'connection',
      canRenderEventContent: false,
      dealing: false,
    };
    renderApp();
    expect(screen.getByText(DEAL_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('keeps a PERMANENT failure on the error surface even when a snapshot exists', () => {
    // permission-denied / schema / unknown-coded failures cannot be fixed by
    // reconnecting, so they must never be masked behind a cached card + Retry
    // (Codex #438). AuthContext classifies them as dealErrorReason 'permanent'.
    saveCardSnapshot({ uid: 'sailor-1', dayIndex: 0, cells: cells(), bingoCount: 1, day: null });
    authState.value = { dealError: DEAL_ERROR, dealErrorReason: 'permanent', dealing: false };
    renderApp();
    expect(screen.getByText(DEAL_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
  });

  it('keeps the actionable pool-shortfall error visible even when a snapshot exists', () => {
    // A pool-shortfall is NOT a connection failure: reconnecting cannot fix it,
    // and its DealError carries the "ask an admin" guidance. The cached card must
    // not mask it (Codex P2, #438).
    saveCardSnapshot({ uid: 'sailor-1', dayIndex: 0, cells: cells(), bingoCount: 1, day: null });
    authState.value = { dealError: POOL_ERROR, dealErrorReason: 'pool-shortfall', dealing: false };
    renderApp();
    expect(screen.getByText(POOL_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
  });

  it('does not surface another account cached card on a deal failure', () => {
    saveCardSnapshot({ uid: 'someone-else', dayIndex: 0, cells: cells(), bingoCount: 1, day: null });
    authState.value = { dealError: DEAL_ERROR, dealErrorReason: 'connection', dealing: false };
    renderApp();
    // sailor-1 has nothing cached -> the reload screen, never someone-else's card.
    expect(screen.getByText(DEAL_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Showing your saved card/)).not.toBeInTheDocument();
  });
});
