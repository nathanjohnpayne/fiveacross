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
const authMocks = vi.hoisted(() => ({ retryDeal: vi.fn() }));
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
    retryDeal: authMocks.retryDeal,
    admission: { kind: 'clear' },
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
// `enabled` is recorded, not ignored: whether App opens the Event LISTENER at
// all is itself under test (Phase 4b P1 on PR #1157), and `useEventDoc(false)`
// subscribes to nothing.
const eventDoc = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
  enabled: [] as unknown[],
  // The server-answered latch `useDocSub` exposes; the closed-Event redirect
  // waits for it (Codex P2, PR #1157). Defaults to true so every other case
  // reads as a server-backed snapshot.
  hasServerData: true,
  // Per-snapshot cache flag; the redirect needs the CURRENT snapshot to be the
  // server's, not only the latch (Codex P2, PR #1157 round 8).
  fromCache: false,
}));
vi.mock('./hooks/useData', () => ({
  useEventDoc: (enabled?: unknown) => {
    eventDoc.enabled.push(enabled);
    return { data: eventDoc.value, hasServerData: eventDoc.hasServerData, fromCache: eventDoc.fromCache };
  },
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
    eventDoc.enabled = [];
    authMocks.retryDeal.mockClear();
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

  // Invitation admission (#804) gates the WHOLE shell between authority and the
  // dealt Board: no Board, no nav, for a visit that is not (yet) a member.
  it.each(['held', 'pending'] as const)('withholds the routed shell while an Invitation is %s', (kind) => {
    authState.value = { admission: { kind, captureId: 'c' } };
    renderApp();
    expect(screen.getByText(/Checking your cruise pass/)).toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('keeps a failed bootstrap\u2019s Retry surface reachable while an Invitation is held', () => {
    authState.value = {
      admission: { kind: 'held', captureId: 'c' },
      dealError: DEAL_ERROR,
      dealErrorReason: 'connection',
      dealing: false,
    };
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent(DEAL_ERROR);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(authMocks.retryDeal).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
  });

  it('offers Retry for a transient redemption failure, routed through the deal retry', () => {
    authState.value = { admission: { kind: 'retryable', captureId: 'c', reason: 'unavailable' } };
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent(/check your invitation/i);
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(authMocks.retryDeal).toHaveBeenCalledOnce();
  });

  it('shows the one terminal message for an invalid Invitation, with no Retry and no Board', () => {
    const message = 'This invitation is no longer valid. Ask the organizer for a new one.';
    authState.value = { admission: { kind: 'blocked', message } };
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
  });

  // The Event LISTENER, not merely the rendered shell (Phase 4b P1 on PR #1157).
  // `EventApp` stays mounted through every one of these states, and the
  // `useEventDoc` call runs BEFORE the guards above can return — a hook cannot
  // be skipped by a branch taken after it. Gated on `!!user` alone it opened a
  // subscription for a visit the Invitation redemption had refused, and the
  // Event read rule is signed-in-only, so the whole document reached the
  // browser. Asserted on the `enabled` argument because that is what decides
  // whether `useDocSub` is handed a ref or a null.
  it.each([
    ['held', { kind: 'held', captureId: 'c' }],
    ['pending', { kind: 'pending', captureId: 'c' }],
    ['retryable', { kind: 'retryable', captureId: 'c', reason: 'unavailable' }],
    ['blocked', { kind: 'blocked', message: 'This invitation is no longer valid.' }],
  ] as const)('opens NO Event listener while an Invitation is %s', (_kind, admission) => {
    authState.value = { admission };
    renderApp();
    expect(eventDoc.enabled.length).toBeGreaterThan(0);
    expect(eventDoc.enabled.every((on) => on === false)).toBe(true);
  });

  it('opens the Event listener once admission is clear — the control', () => {
    // Without this the assertion above would pass on an App that never
    // subscribes at all.
    renderApp();
    expect(eventDoc.enabled.length).toBeGreaterThan(0);
    expect(eventDoc.enabled.every((on) => on === true)).toBe(true);
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

describe('App — a closed Event routes the visit to the standings (#134)', () => {
  // specs/post-sailing-archive.md § "The enforcement". Once the Event is shut
  // there is no card to play — `joinAndDeal` declines the join and `Board`'s own
  // Day-Card deal is a write the rules deny — so the Card tab routes to the
  // standings rather than mounting the Board. The redirect is what keeps the
  // Board, its listeners and its deal from mounting at all.
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    authState.value = {};
    eventScope.eventId = 'event-a';
    eventDoc.value = null;
    eventDoc.enabled = [];
    eventDoc.hasServerData = true;
    eventDoc.fromCache = false;
    authMocks.retryDeal.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the standings instead of the Board on an ARCHIVED Event', () => {
    eventDoc.value = { status: 'archived', archivedAt: 1_700_000_000_000 };
    renderApp();
    expect(screen.getByTestId('ranks')).toBeInTheDocument();
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('keeps the Board when the CURRENT snapshot is cached, even after the server once answered', () => {
    // Codex P2, PR #1157 round 8. `hasServerData` is a lifetime latch: a device
    // that once saw the quiesce, then went offline while another Admin reopened
    // play, must not be redirected off its Card by the cached closed value.
    eventDoc.hasServerData = true;
    eventDoc.fromCache = true;
    eventDoc.value = { status: 'active', archiving: true };
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.queryByTestId('ranks')).not.toBeInTheDocument();
  });

  it('keeps the Board until the closed state is SERVER-BACKED — a cached quiesce cannot redirect', () => {
    // Codex P2, PR #1157 round 6. This browser can hold `archiving: true` from
    // before another Admin reopened play; the replace navigation is a URL
    // change the later open snapshot cannot undo, so it waits for the server.
    eventDoc.hasServerData = false;
    eventDoc.value = { status: 'active', archiving: true };
    renderApp();
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.queryByTestId('ranks')).not.toBeInTheDocument();
    eventDoc.hasServerData = true;
  });

  it('routes a CLOSING Event the same way — shut to play, and reversible', () => {
    // The quiesce denies every gameplay write, so the standings the Leaderboard
    // renders simply cannot move. The Card tab has nothing to offer either way.
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
