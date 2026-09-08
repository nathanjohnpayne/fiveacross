import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { saveCardSnapshot } from './data/cardCache';
import type { Cell } from './types';

// A mutable auth stub so each test drives {dealError, dealing} without a real
// AuthProvider. The default is a signed-in Player with no deal error.
const authState: { value: Record<string, unknown> } = { value: {} };
const eventScope = vi.hoisted(() => ({ eventId: 'event-a' }));
vi.mock('./firebase', () => ({
  get EVENT_ID() {
    return eventScope.eventId;
  },
}));
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
// #134: App reads the Event document to decide whether the Card tab still has a
// card to render. Stubbed to a mutable fixture — the routing decision is what is
// under test, not the subscription.
const eventDoc = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('./hooks/useData', () => ({
  useEventDoc: () => ({ data: eventDoc.value }),
}));
vi.mock('./components/Board', () => ({ default: () => <div data-testid="board" /> }));
vi.mock('./components/NoticeBanner', () => ({ default: () => null }));
vi.mock('./components/Leaderboard', () => ({ default: () => <div data-testid="ranks" /> }));
vi.mock('./components/ProofFeed', () => ({
  default: () => <input data-testid="feed" aria-label="Feed-local draft" defaultValue="" />,
}));
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

function renderApp(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  );
}

function GlobalShellProbe() {
  const [value, setValue] = useState('');
  return (
    <>
      <input aria-label="Global shell state" value={value} onChange={(event) => setValue(event.target.value)} />
      <App />
    </>
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
    eventScope.eventId = 'event-a';
    eventDoc.value = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the live Board when there is no deal error', () => {
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });

  it('remounts Event-local route state across A → B while preserving state owned above App', () => {
    const view = render(
      <MemoryRouter initialEntries={['/feed']}>
        <GlobalShellProbe />
      </MemoryRouter>,
    );
    const globalState = screen.getByLabelText('Global shell state');
    const eventADraft = screen.getByLabelText('Feed-local draft');
    fireEvent.change(globalState, { target: { value: 'Global state' } });
    fireEvent.change(eventADraft, { target: { value: 'Event A state' } });
    expect(globalState).toHaveValue('Global state');
    expect(eventADraft).toHaveValue('Event A state');

    eventScope.eventId = 'event-b';
    view.rerender(
      <MemoryRouter initialEntries={['/feed']}>
        <GlobalShellProbe />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Feed-local draft')).toHaveValue('');
    expect(screen.getByLabelText('Global shell state')).toHaveValue('Global state');
    expect(screen.getByTestId('nav')).toBeInTheDocument();
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

describe('App — a closed Event routes the visit to the archive (#134)', () => {
  // specs/post-sailing-archive.md § "The archived visit". Once the Event is shut
  // there is no card to play — `joinAndDeal` declines the join and `Board`'s own
  // Day-Card deal is a write the rules deny — so the Card tab routes to the
  // standings rather than mounting the Board. The redirect is what keeps the
  // Board, its listeners and its deal from mounting at all.
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    authState.value = {};
    eventScope.eventId = 'event-a';
    eventDoc.value = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the archive surface instead of the Board on an ARCHIVED Event', () => {
    eventDoc.value = { status: 'archived', archive: { standings: [] } };
    renderApp();
    expect(screen.getByTestId('ranks')).toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('routes a CLOSING Event the same way — shut to play, with no record yet', () => {
    // The quiesce denies every gameplay write while carrying no `archive`, so the
    // standings surface renders them LIVE and they simply cannot move. The Card
    // tab has nothing to offer either way.
    eventDoc.value = { status: 'active', archiving: true };
    renderApp();
    expect(screen.getByTestId('ranks')).toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('routes past a stale deal error rather than stranding the visit on Retry', () => {
    // The failure this fixes: a deal that ran while the Event was open leaves
    // `dealError` set, and App used to replace the Card tab with a retry surface
    // whose Retry repeated the write the freeze denies.
    eventDoc.value = { status: 'archived' };
    authState.value = { dealError: DEAL_ERROR, dealErrorReason: 'permanent', dealing: false };
    renderApp();
    expect(screen.getByTestId('ranks')).toBeInTheDocument();
    expect(screen.queryByText(DEAL_ERROR)).not.toBeInTheDocument();
  });

  it('leaves an OPEN Event on the Board — the control, so the routing is not vacuous', () => {
    eventDoc.value = { status: 'active' };
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });

  it('renders the Board while the Event document has not arrived, rather than waiting', () => {
    // A cold visit reads `null`, which is OPEN by the predicate's own default —
    // making every LIVE Event's Card tab wait on a round trip would cost far more
    // than one late redirect. The write half needs no such wait: `joinAndDeal`
    // asks the server itself.
    eventDoc.value = null;
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });
});
