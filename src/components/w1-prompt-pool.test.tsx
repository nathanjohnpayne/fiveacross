import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Covers specs/w1-prompt-pool.md — the strengthened pre-sail framing (ADR
// 0003) and the Phase 0 client-side rate-limit guard (ADR 0004 posture) on
// add/report. `checkItemRateLimit`/`ITEM_RATE_LIMIT_MS` are the REAL
// implementation from `../data/api` (only `addItem`/`reportItem` are
// stubbed below), so the throttle assertions exercise the actual guard, not
// a re-implementation of it in the test.

type AuthUser = { uid: string; displayName: string | null; photoURL: string | null } | null;
const authState = vi.hoisted(() => ({ current: { user: null as AuthUser, loading: false } }));
type PoolItem = { id: string; text: string };
const itemsState = vi.hoisted(() => ({
  current: { items: [] as PoolItem[], loading: false },
}));

const { addItemMock, reportItemMock } = vi.hoisted(() => ({
  addItemMock: vi.fn(async () => undefined),
  reportItemMock: vi.fn(async () => undefined),
}));

// api.ts's addItem/reportItem write to Firestore; stub only those two and
// keep everything else (including the real checkItemRateLimit + its shared
// module-scope timestamp map) so the throttle logic under test is real.
vi.mock('../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api')>();
  return { ...actual, addItem: addItemMock, reportItem: reportItemMock };
});
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event' }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => authState.current }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useItems: () => itemsState.current,
  // #210: ItemPool also reads the submitter's own pending items so a fresh
  // `status: 'pending'` add doesn't silently vanish — pinned in its own
  // suite (src/components/ItemPool.test.tsx). Empty here so it is a no-op
  // for every assertion in THIS file, which only exercises the pre-existing
  // active-pool + throttle behavior.
  useMyPendingItems: () => ({ items: [], loading: false }),
  // #559: ItemPool now reads the Day schedule for its submitter-state pills.
  // No schedule here — a no-op for this file's pre-existing add/throttle
  // assertions, which don't exercise the new states.
  useEventDoc: () => ({ data: undefined }),
}));

import ItemPool from './ItemPool';
import { ITEM_RATE_LIMIT_MS } from '../data/api';

function signIn(uid: string) {
  authState.current = { user: { uid, displayName: 'Sailor', photoURL: null }, loading: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.current = { user: null, loading: false };
  itemsState.current = { items: [], loading: false };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pre-sail framing (ADR 0003)', () => {
  it('messages adding a prompt as pre-sail, and mid-cruise adds as joining a FUTURE card, not the frozen one', () => {
    signIn('framing-uid');
    itemsState.current = { items: [{ id: 'i1', text: 'Prompt one' }], loading: false };

    render(<ItemPool />);

    expect(screen.getByText(/get your prompts in before we sail/i)).toBeInTheDocument();
    expect(screen.getByText(/joins the pool for a future card, not yours/i)).toBeInTheDocument();
    // The pool-density counter framing survives the copy strengthening.
    expect(screen.getByText(/1 in the pool/)).toBeInTheDocument();
  });
});

describe('adding a Prompt', () => {
  it('calls addItem with the trimmed text and clears the input on success', async () => {
    const user = userEvent.setup();
    signIn('add-basic-uid');

    render(<ItemPool />);
    const input = screen.getByPlaceholderText(/add a prompt/i);
    await user.type(input, '  Cabin karaoke incident  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addItemMock).toHaveBeenCalledTimes(1));
    expect(addItemMock).toHaveBeenCalledWith('add-basic-uid', '  Cabin karaoke incident  ', false);
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('calls addItem with spicy: true when the 🔞 toggle is checked, and resets the toggle after a successful add', async () => {
    const user = userEvent.setup();
    signIn('add-spicy-uid');

    render(<ItemPool />);
    await user.type(screen.getByPlaceholderText(/add a prompt/i), 'Suite orgy');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addItemMock).toHaveBeenCalledTimes(1));
    expect(addItemMock).toHaveBeenCalledWith('add-spicy-uid', 'Suite orgy', true);
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('does nothing for blank/whitespace-only text (the Add button stays disabled)', async () => {
    const user = userEvent.setup();
    signIn('add-blank-uid');

    render(<ItemPool />);
    await user.type(screen.getByPlaceholderText(/add a prompt/i), '   ');

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(addItemMock).not.toHaveBeenCalled();
  });
});

describe('client-side rate limit on Add (Phase 0, presentational only)', () => {
  it('throttles a rapid second Add — addItem fires once, shows a message and disables Add, then recovers once the window passes', async () => {
    vi.useFakeTimers();
    signIn('add-throttle-uid');

    render(<ItemPool />);
    const input = screen.getByPlaceholderText(/add a prompt/i);
    const addButton = () => screen.getByRole('button', { name: 'Add' });

    fireEvent.change(input, { target: { value: 'First prompt' } });
    // Two rapid submits of the SAME pending add — `add()` records the
    // `addItem` CALL synchronously (before it awaits the write), so the
    // second click's synchronous prefix still sees the same non-blank `text`
    // state and reaches the real rate-limit check before either promise
    // settles — no `waitFor` needed for the call-count assertions below.
    fireEvent.click(addButton());
    fireEvent.click(addButton());
    // Let the first call's pending `addItem()` promise (a native microtask —
    // unaffected by the faked setTimeout/Date above) settle, so its
    // `track`/`setText('')` continuation runs inside `act` rather than
    // leaking into a later assertion or test.
    await act(async () => {
      await Promise.resolve();
    });

    expect(addItemMock).toHaveBeenCalledTimes(1);
    expect(addItemMock).toHaveBeenCalledWith('add-throttle-uid', 'First prompt', false);
    expect(screen.getByRole('alert')).toHaveTextContent(/slow down/i);
    expect(addButton()).toBeDisabled();

    // Still within the window: a further attempt — via Enter, since the
    // input itself is never disabled — is also suppressed.
    fireEvent.change(input, { target: { value: 'Second prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addItemMock).toHaveBeenCalledTimes(1);

    // The auto-clear timer fires once the window passes.
    act(() => {
      vi.advanceTimersByTime(ITEM_RATE_LIMIT_MS);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(addButton()).not.toBeDisabled();

    fireEvent.click(addButton());
    expect(addItemMock).toHaveBeenCalledTimes(2);
    expect(addItemMock).toHaveBeenLastCalledWith('add-throttle-uid', 'Second prompt', false);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('recovers at the REAL remaining time — not a re-armed full window — when a blocked retry lands mid-window, and keeps Enter in lockstep with the disabled button (Codex P2, PR #92)', async () => {
    vi.useFakeTimers();
    signIn('add-mismatch-uid');

    render(<ItemPool />);
    const input = screen.getByPlaceholderText(/add a prompt/i);
    const addButton = () => screen.getByRole('button', { name: 'Add' });

    // t=0: a first Add succeeds — this is the timestamp checkItemRateLimit's
    // 3s window is actually anchored to.
    fireEvent.change(input, { target: { value: 'First prompt' } });
    fireEvent.click(addButton());
    await act(async () => {
      await Promise.resolve();
    });
    expect(addItemMock).toHaveBeenCalledTimes(1);

    // t=2.9s: a retry lands INSIDE the window, with only ~100ms left on the
    // REAL (data-layer) guard. It must still be blocked...
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    fireEvent.change(input, { target: { value: 'Second prompt' } });
    fireEvent.click(addButton());
    expect(addItemMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/slow down/i);
    expect(addButton()).toBeDisabled();

    // ...and while the UI says throttled, Enter must NOT reach `add()` at
    // all — it is gated by the SAME `addThrottled` state as the button, so
    // no path can submit while the alert is showing.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addItemMock).toHaveBeenCalledTimes(1);

    // The control must NOT wait a full re-armed window from THIS blocked
    // retry (that would land at 2.9s + 3s = 5.9s): 99ms later (t=2.999s) it
    // is still disabled...
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(addButton()).toBeDisabled();
    expect(addItemMock).toHaveBeenCalledTimes(1);

    // ...but 1ms after that (t=3.0s — exactly when checkItemRateLimit itself
    // re-opens, 3s after the ORIGINAL success at t=0) it recovers.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(addButton()).not.toBeDisabled();

    // After expiry, Enter works again and reaches `add()`.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addItemMock).toHaveBeenCalledTimes(2);
    expect(addItemMock).toHaveBeenLastCalledWith('add-mismatch-uid', 'Second prompt', false);
    await act(async () => {
      await Promise.resolve();
    });
  });
});

describe('client-side rate limit on Report (Phase 0, presentational only)', () => {
  it('throttles a rapid second Report — even across two DIFFERENT prompts — then recovers once the window passes', async () => {
    vi.useFakeTimers();
    signIn('report-throttle-uid');
    itemsState.current = {
      items: [
        { id: 'i1', text: 'Prompt one' },
        { id: 'i2', text: 'Prompt two' },
      ],
      loading: false,
    };

    render(<ItemPool />);
    const reportButtons = () => screen.getAllByTitle('Report');

    // The limit is per-Player, not per-Prompt: reporting a SECOND, DIFFERENT
    // item right after the first still hits the same throttle bucket. Unlike
    // `add`, `report` has no `await` before its (fire-and-forget) write call,
    // so both clicks' effects are fully synchronous — no microtask flush
    // needed before asserting call counts.
    fireEvent.click(reportButtons()[0]);
    fireEvent.click(reportButtons()[1]);

    expect(reportItemMock).toHaveBeenCalledTimes(1);
    expect(reportItemMock).toHaveBeenCalledWith('i1');
    expect(screen.getByRole('alert')).toHaveTextContent(/slow down/i);
    expect(reportButtons()[0]).toBeDisabled();
    expect(reportButtons()[1]).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(ITEM_RATE_LIMIT_MS);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(reportButtons()[1]).not.toBeDisabled();

    fireEvent.click(reportButtons()[1]);
    expect(reportItemMock).toHaveBeenCalledTimes(2);
    expect(reportItemMock).toHaveBeenLastCalledWith('i2');
  });
});
