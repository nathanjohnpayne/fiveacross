import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import type { ItemDoc } from '../types';

// specs/d15-approvals.md, component layer (RTL-jsdom). Drives the REAL ItemPool
// with the data boundary (useData hooks + data/api writes) stubbed. Proves: a
// submission calls the (now-pending) addItem write; the "goes to admin review"
// caption renders alongside the existing pre-sail note (additive, not a
// replacement); and the submitter's own pending item — invisible via useItems,
// only reachable via useMyPendingItems — still renders in their list, tagged
// "pending review".

const H = vi.hoisted(() => ({
  user: { uid: 'u1' } as { uid: string } | null,
  items: [] as ItemDoc[],
  myPending: [] as ItemDoc[],
  myActive: [] as ItemDoc[],
  // Undefined by default (no schedule) — this file's existing assertions
  // predate #559 and don't exercise scheduled/approved/not-selected states.
  // Overridden per-test where the ticking-clock timer needs a real schedule.
  event: undefined as { days?: { index: number; unlockAt: number }[] } | undefined,
  addItem: vi.fn(),
  reportItem: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: H.user }) }));
vi.mock('../hooks/useData', () => ({
  // #264: day-meta honor reads — inert stubs (no pinned honors).
  useDayMeta: () => ({ data: null, loading: false, hasServerData: true }),
  useDayMetas: () => new Map(),
  useDayMetasStatus: () => ({ metas: new Map(), loaded: true }),
  useItems: () => ({ items: H.items, loading: false }),
  useMyPendingItems: () => ({ items: H.myPending, loading: false, hasServerData: true }),
  // #559 round 2 (Codex P2, PR #845): ItemPool's own unfiltered "my active
  // submissions" query — deliberately SEPARATE from `H.items` (the public
  // pool), mirroring `useMyActiveItems`'s own doc comment.
  useMyActiveItems: () => ({ items: H.myActive, loading: false, hasServerData: true }),
  // #559: ItemPool now reads the Day schedule for its submitter-state pills
  // AND its ticking-clock timer (round 4). `H.event` defaults to no
  // schedule; overridden per-test for the clamp regression below.
  useEventDoc: () => ({ data: H.event }),
}));
vi.mock('../data/api', () => ({
  addItem: (...a: unknown[]) => H.addItem(...a),
  reportItem: (...a: unknown[]) => H.reportItem(...a),
  checkItemRateLimit: () => true,
  itemRateLimitRemainingMs: () => 0,
}));
vi.mock('../analytics', () => ({ track: vi.fn() }));
// #610: ItemPool reads EVENT_ID for the explainer's event-keyed storage key.
vi.mock('../firebase', () => ({ EVENT_ID: 'ev-1' }));

import ItemPool, { APPROVAL_GRACE_MS, vacatedPendingIds } from './ItemPool';
import { UNSAVED_WORK_ATTRIBUTE } from '../swClientBridge';
import { track } from '../analytics';

const item = (id: string, over: Partial<ItemDoc> = {}): ItemDoc =>
  ({
    id,
    text: `prompt ${id}`,
    createdBy: 'u1',
    createdAt: 1,
    isFreeSpace: false,
    status: 'active',
    reportCount: 0,
    spicy: false,
    pool: 'main',
    ...over,
  }) as ItemDoc;

beforeEach(() => {
  vi.clearAllMocks();
  H.user = { uid: 'u1' };
  H.items = [];
  H.myPending = [];
  H.myActive = [];
  H.event = undefined;
});

describe('ItemPool submission (specs/d15-approvals.md)', () => {
  it('calls addItem (which now lands status: "pending" — pinned at the data layer)', () => {
    render(<ItemPool />);
    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'A new prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(H.addItem).toHaveBeenCalledWith('u1', 'A new prompt', false);
  });

  // #559, Codex P2, PR #845 round 6: catalog-membership tests alone don't
  // prove a call site actually FIRES an event with sane params — this pins
  // the real `add()` handler's `prompt_suggestion_submitted` emission, no
  // Prompt text in the payload, `hasTargetDay` reflecting the write's own
  // (mocked, here undefined-resolving) result rather than a guess.
  it('fires prompt_suggestion_submitted with no Prompt text, alongside the existing add_item', async () => {
    render(<ItemPool />);
    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'A new prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(track).toHaveBeenCalledWith('add_item'));
    expect(track).toHaveBeenCalledWith('prompt_suggestion_submitted', { hasTargetDay: false });
    for (const call of (track as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('A new prompt');
    }
  });

  it('a half-typed suggestion holds back the automatic post-deploy reload', async () => {
    // Codex P2 round 5, PR #720. The player-facing member of the same class as
    // Admin → Messages: the draft lives only in React state, and the add bar is
    // neither a modal nor the claim sheet, so `midInteraction`
    // (src/swClientBridge.ts) had nothing to defer on and a deploy ate it.
    render(<ItemPool />);
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;
    expect(document.querySelector(marker)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), { target: { value: 'Half typed' } });
    expect(document.querySelector(marker)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(document.querySelector(marker)).toBeNull());
  });

  it('renders the "goes to admin review" caption alongside the existing pre-sail note', () => {
    render(<ItemPool />);
    expect(screen.getByText(/admin review/i)).toBeInTheDocument();
    expect(screen.getByText(/once your card is dealt it's frozen/i)).toBeInTheDocument();
  });

  // Post-review #750/#755/#758 on PR #720: the marker used raw non-emptiness
  // while Add's own `disabled` predicate uses `text.trim()`, so whitespace-only
  // text marked the add bar as unsaved work even though Add stayed disabled and
  // could never clear it — pinning the tab to a condemned build forever.
  it('does not mark the add bar for whitespace-only text, which Add can never clear', () => {
    render(<ItemPool />);
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;
    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), { target: { value: '   ' } });
    expect(document.querySelector(marker)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });
});

describe("A submitter's own pending item (specs/d15-approvals.md)", () => {
  it('renders in their list, tagged "pending review" — invisible via useItems alone', () => {
    H.items = [item('active-1', { text: 'Already live prompt' })];
    H.myPending = [item('pending-1', { text: 'My awaiting prompt', status: 'pending' })];
    render(<ItemPool />);

    expect(screen.getByText('Already live prompt')).toBeInTheDocument();
    const pendingRow = screen.getByText('My awaiting prompt').closest('.row') as HTMLElement;
    expect(within(pendingRow).getByText(/pending review/i)).toBeInTheDocument();
  });

  it('does not silently vanish after Add: an empty active pool still surfaces the pending row', () => {
    H.items = [];
    H.myPending = [item('pending-1', { text: 'Just submitted', status: 'pending' })];
    render(<ItemPool />);
    expect(screen.getByText('Just submitted')).toBeInTheDocument();
  });

  // #559, Codex P2 on PR #845: once a locally-tracked submission is approved,
  // it lands in BOTH `useItems`' active pool AND the local tracker's own
  // resolved status list — rendering `items` unfiltered duplicated the row.
  // This jsdom project ships no localStorage of its own (same stub every
  // other localStorage-dependent test in this file / CoachOverlay.test /
  // reshuffle-intro.test uses) — stubbed and torn down within the test since
  // no other test in this describe block needs it.
  it('never renders an approved own-submission twice — once as a plain pool row and once with its status pill', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage);
    try {
      const mine = item('mine-1', { status: 'active', text: 'My approved prompt' });
      // Present in BOTH the public pool AND the submitter-scoped active
      // query (#559 round 2) — exactly the normal case for an approved
      // submission that hasn't been presentationally hidden.
      H.items = [mine];
      H.myActive = [mine];
      localStorage.setItem(
        'gcb.mySuggestions.ev-1.u1',
        JSON.stringify([{ id: 'mine-1', text: 'My approved prompt', submittedAt: 1 }]),
      );
      render(<ItemPool />);
      expect(screen.getAllByText('My approved prompt')).toHaveLength(1);
      const row = screen.getByText('My approved prompt').closest('.row') as HTMLElement;
      expect(row.querySelector('.pill')?.textContent).toMatch(/approved/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // #559, Codex P2, PR #845 rounds 8 + 9: `useMyPendingItems`/`useMyActiveItems`
  // are independent listeners, so an admin's approval can land the
  // pending-removal snapshot before the active-addition snapshot — for a
  // submission this device has NEVER before seen active (round 7's
  // `lastKnownStatus` cache still unset), that overlap used to read
  // "not selected" the instant the pending listener fired. `APPROVAL_GRACE_MS`
  // covers it with a REAL timer (round 9 — a plain ref-diff, the round-8 cut,
  // relied on some LATER unrelated render to notice the window had passed,
  // which a genuinely rejected submission — no active arrival ever coming —
  // might never get), and genuinely ages out to `not_selected` once that
  // timer fires with nothing having resolved — pinning both halves against
  // ItemPool's real render cycle, not just the pure `deriveMySubmissions`
  // unit above.
  describe('the pending→active approval-race grace window (#559, Codex P2, PR #845 rounds 8 + 9)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function seedTrackedMine() {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      } as unknown as Storage);
      localStorage.setItem(
        'gcb.mySuggestions.ev-1.u1',
        JSON.stringify([{ id: 'mine-1', text: 'About to be approved', submittedAt: 1 }]),
      );
    }

    it('keeps reporting "pending" through the grace window, then ages out to "not selected" once it elapses with no active arrival', async () => {
      seedTrackedMine();
      try {
        H.myPending = [item('mine-1', { text: 'About to be approved', status: 'pending' })];
        const { rerender } = render(<ItemPool />);
        expect(screen.getByText('About to be approved').closest('.row')).toHaveTextContent(/pending review/i);

        // The pending listener's removal snapshot lands; the active
        // listener's addition has NOT arrived (and, in this test, never
        // will) — a genuine rejection.
        H.myPending = [];
        await act(async () => rerender(<ItemPool />));
        expect(screen.getByText('About to be approved').closest('.row')).toHaveTextContent(/pending review/i);

        // Still within the window, and still nothing active — stays graced.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS - 1);
        });
        expect(screen.getByText('About to be approved').closest('.row')).toHaveTextContent(/pending review/i);

        // The window elapses with no active arrival — the timer itself (not
        // some unrelated render) is what resolves this to "not selected".
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(screen.getByText('About to be approved').closest('.row')).toHaveTextContent(/not selected/i);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('resolves EARLY, before the grace window elapses, the moment the active listener catches up', async () => {
      seedTrackedMine();
      try {
        H.myPending = [item('mine-1', { text: 'About to be approved', status: 'pending' })];
        const { rerender } = render(<ItemPool />);
        H.myPending = [];
        await act(async () => rerender(<ItemPool />));
        expect(screen.getByText('About to be approved').closest('.row')).toHaveTextContent(/pending review/i);

        // Still well within the window when the active listener's own
        // snapshot lands — resolves immediately, not on the timer. No Day
        // schedule is configured here (H.event is undefined by default), so
        // an untargeted active row derives to 'approved' — the point under
        // test is EARLY resolution to the live document's real status, not
        // the specific status itself (that split is `submitterStatus`'s own
        // contract, covered elsewhere).
        H.myActive = [item('mine-1', { text: 'About to be approved', status: 'active' })];
        await act(async () => rerender(<ItemPool />));
        let row = screen.getByText('About to be approved').closest('.row') as HTMLElement;
        expect(row).toHaveTextContent(/approved/i);
        expect(row).not.toHaveTextContent(/pending review/i);

        // Advancing the rest of the way past the (already-cleared) window is
        // a no-op — the early resolution stands.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS);
        });
        row = screen.getByText('About to be approved').closest('.row') as HTMLElement;
        expect(row).toHaveTextContent(/approved/i);
        expect(row).not.toHaveTextContent(/pending review/i);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // #559, Codex P1, PR #845 round 4: an unclamped `setTimeout(..., nextUnlock
  // - Date.now())` overflows the 32-bit signed int delay browsers accept once
  // the next unlock is more than ~24.9 days out — which they clamp to ~0ms,
  // firing near-instantly, recomputing the SAME far-off target, and re-arming
  // an equally near-instant timer forever. This pins the fix: the delay
  // handed to `setTimeout` never exceeds the clamp, even for a schedule whose
  // next unlock is 30 days away.
  it('clamps its ticking-clock timer to the 32-bit setTimeout max for a Day more than ~24.9 days out', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      H.event = { days: [{ index: 0, unlockAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }] };
      render(<ItemPool />);
      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((d): d is number => typeof d === 'number');
      expect(delays.length).toBeGreaterThan(0);
      for (const d of delays) {
        expect(d).toBeLessThanOrEqual(2_147_483_647);
      }
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

// #610 — the PLAYER half: a first-time 🔞 tick gets an explainer, once per
// Event, never a gate. (The consequential-action confirm lives on the ADMIN
// flip — `admin/adult-content-confirm.test.tsx` — because a player's tick
// lands `pending` and changes nothing about the Event's posture.)
describe('the first-time 🔞 explainer (#610)', () => {
  const SEEN_KEY = 'gcb.seen.explicitTag.ev-1';
  const tickSpicy = () => fireEvent.click(screen.getByRole('checkbox'));
  const explainer = () => screen.queryByRole('dialog', { name: /What the 🔞 tag does/ });

  // The CoachOverlay.test/reshuffle-intro.test storage-stub harness — this
  // jsdom project ships no localStorage of its own.
  function createStorageStub(): Storage {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
  }

  let storage: Storage;
  beforeEach(() => {
    storage = createStorageStub();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows on the first tick in this Event — and the tick itself still lands', () => {
    render(<ItemPool />);
    expect(explainer()).not.toBeInTheDocument();
    tickSpicy();
    expect(explainer()).toBeInTheDocument();
    // An explainer, not a confirm: the checkbox is already checked underneath.
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('marks the Event-keyed storage on "Got it", and the next tick is silent', () => {
    render(<ItemPool />);
    tickSpicy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(explainer()).not.toBeInTheDocument();
    expect(storage.getItem(SEEN_KEY)).not.toBeNull();
    // Untick, tick again: seen means seen.
    tickSpicy();
    tickSpicy();
    expect(explainer()).not.toBeInTheDocument();
  });

  it('stays silent when this Event has already been seen (fresh mount)', () => {
    storage.setItem(SEEN_KEY, String(Date.now()));
    render(<ItemPool />);
    tickSpicy();
    expect(explainer()).not.toBeInTheDocument();
  });

  it('re-shows for a DIFFERENT Event: the key is event-scoped', () => {
    storage.setItem('gcb.seen.explicitTag.some-other-event', String(Date.now()));
    render(<ItemPool />);
    tickSpicy();
    expect(explainer()).toBeInTheDocument();
  });

  it('never opens on an untick', () => {
    render(<ItemPool />);
    tickSpicy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    tickSpicy(); // untick — checkbox back to false
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(explainer()).not.toBeInTheDocument();
  });

  it('shows (not suppresses) when localStorage is unavailable — fail open', () => {
    // The reshuffle-intro suite's unavailable-storage shape: every access throws
    // (private mode / storage disabled), and the try/catch falls OPEN.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    } as unknown as Storage);
    render(<ItemPool />);
    tickSpicy();
    expect(explainer()).toBeInTheDocument();
    // Dismissal survives the failed persist (markSeen is a no-op) …
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(explainer()).not.toBeInTheDocument();
    // … and with nothing persisted, the next first tick shows it again.
    tickSpicy();
    tickSpicy();
    expect(explainer()).toBeInTheDocument();
  });

  it('submits with spicy: true after the explainer was dismissed', () => {
    render(<ItemPool />);
    tickSpicy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'A spicy prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(H.addItem).toHaveBeenCalledWith('u1', 'A spicy prompt', true);
  });
});

// #862: the grace-window computation, pulled out as a pure function so it is
// directly unit-testable without exercising React's render/effect ordering.
describe('vacatedPendingIds (#862)', () => {
  it('reports an id that left pending with no active arrival yet', () => {
    expect(vacatedPendingIds(new Set(['a', 'b']), new Set(['b']), new Set())).toEqual(['a']);
  });

  it('does not report an id that resolved straight into active', () => {
    expect(vacatedPendingIds(new Set(['a']), new Set(), new Set(['a']))).toEqual([]);
  });

  it('does not report an id still present in pending', () => {
    expect(vacatedPendingIds(new Set(['a']), new Set(['a']), new Set())).toEqual([]);
  });

  it('does not report an id that was never in the previous pending set', () => {
    expect(vacatedPendingIds(new Set(), new Set(), new Set())).toEqual([]);
  });

  it('reports every id that vacated, when more than one does at once', () => {
    expect(vacatedPendingIds(new Set(['a', 'b', 'c']), new Set(), new Set(['c']))).toEqual(['a', 'b']);
  });
});

// #861: `add`'s async continuation captures the submitting uid up front, and
// the Firestore write + localStorage persist stay correctly attributed to it
// regardless of what happens to auth afterward — but the SHARED `tracked`
// React state update must be skipped once a DIFFERENT account is current by
// the time the write resolves, or the old account's own-submission row leaks
// onto the new account's screen.
describe('add() stays correctly attributed across an auth change mid-write (#861)', () => {
  function createStorageStub(): Storage {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
  }

  let storage: Storage;
  beforeEach(() => {
    storage = createStorageStub();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never splices the OLD account\'s submission into the NEW account\'s on-screen tracked list, even under the most adversarial timing this harness can construct (Codex + CodeRabbit, PR #890 round 1)', async () => {
    // NOTE on what this test can and cannot prove: `rerender()` and
    // `resolveAdd()` are issued back-to-back with no `await` between them,
    // inside one `act()` call — the most adversarial ordering this harness
    // can construct. Empirically (round 2 investigation), React Testing
    // Library does not actually commit the `rerender()` before this
    // continuation's microtask runs in that exact shape, so this specific
    // construction cannot, on its own, prove `uidRef` was already updated
    // by the time the guard below reads it. What it DOES prove is the
    // on-screen OUTCOME under that same adversarial ordering: this
    // component carries a SECOND, independent safety net — the account-
    // switch effect a few lines above, which unconditionally reloads
    // `tracked` from u2's OWN localStorage the instant `uid` changes — so
    // even if this specific guard's timing were imperfect, u1's row could
    // not survive rendering under u2. The two OTHER tests below (form reset
    // and analytics suppression, which have no such second safety net) use
    // two separately-settled `act()` calls instead, which this
    // investigation confirmed DOES let the ref update land before the
    // continuation checks it — the achievable, and realistic, guarantee.
    let resolveAdd: (r: { id: string; targetDayIndex?: number }) => void = () => {};
    H.addItem.mockReturnValue(
      new Promise<{ id: string; targetDayIndex?: number }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    H.user = { uid: 'u1' };
    const { rerender } = render(<ItemPool />);

    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'Submitted by u1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // Still pending — `addItem` has not resolved yet.
    expect(H.addItem).toHaveBeenCalledWith('u1', 'Submitted by u1', false);

    H.user = { uid: 'u2' };
    await act(async () => {
      rerender(<ItemPool />);
      resolveAdd({ id: 'new-item-1' });
    });

    // u1's submission must never appear in u2's on-screen list...
    expect(screen.queryByText('Submitted by u1')).not.toBeInTheDocument();
    // ...but the write itself is unaffected by the guard — only the shared
    // React state update is skipped — so it is still correctly persisted
    // under u1's OWN localStorage key.
    const stored: Array<{ id: string }> = JSON.parse(storage.getItem('gcb.mySuggestions.ev-1.u1') ?? '[]');
    expect(stored.map((s) => s.id)).toContain('new-item-1');
  });

  it('also guards the text/spicy form reset, so an old account\'s completion cannot clear a new account\'s in-progress draft (CodeRabbit, PR #890 round 1)', async () => {
    let resolveAdd: (r: { id: string; targetDayIndex?: number }) => void = () => {};
    H.addItem.mockReturnValue(
      new Promise<{ id: string; targetDayIndex?: number }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    H.user = { uid: 'u1' };
    const { rerender } = render(<ItemPool />);

    const input = screen.getByPlaceholderText('Add a prompt…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Submitted by u1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    H.user = { uid: 'u2' };
    await act(async () => rerender(<ItemPool />));

    // The NEW account starts typing their own submission before u1's write
    // resolves.
    fireEvent.change(input, { target: { value: 'u2 is mid-draft' } });

    await act(async () => {
      resolveAdd({ id: 'new-item-1' });
    });

    // u1's stale completion must not have wiped u2's in-progress text.
    expect(input.value).toBe('u2 is mid-draft');
  });

  it('clears the compose box and spicy flag on the account switch ITSELF, even if the new account never types anything — so a stale draft can never be silently seen or submitted by them (Codex P1, PR #890 round 2)', async () => {
    let resolveAdd: (r: { id: string; targetDayIndex?: number }) => void = () => {};
    H.addItem.mockReturnValue(
      new Promise<{ id: string; targetDayIndex?: number }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    H.user = { uid: 'u1' };
    const { rerender } = render(<ItemPool />);

    const input = screen.getByPlaceholderText('Add a prompt…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Submitted by u1' } });
    fireEvent.click(screen.getByRole('checkbox')); // u1 tags it spicy
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // u2 signs in — and does NOT type anything before u1's write resolves.
    H.user = { uid: 'u2' };
    await act(async () => rerender(<ItemPool />));

    // The switch itself must have already cleared the box — not waiting on
    // u1's write to resolve (which, per the guard, will now SKIP clearing
    // it, since it is no longer u1's turn). Without this, u2 would see
    // u1's leftover text and spicy tag and could submit it unedited.
    expect(input.value).toBe('');
    expect(screen.getByRole('checkbox')).not.toBeChecked();

    await act(async () => {
      resolveAdd({ id: 'new-item-1' });
    });
    expect(input.value).toBe('');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it("suppresses the submission's analytics events when auth changed before the write resolved, rather than attributing u1's submission to u2 (Codex P2, PR #890 round 2)", async () => {
    let resolveAdd: (r: { id: string; targetDayIndex?: number }) => void = () => {};
    H.addItem.mockReturnValue(
      new Promise<{ id: string; targetDayIndex?: number }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    H.user = { uid: 'u1' };
    const { rerender } = render(<ItemPool />);

    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'Submitted by u1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    H.user = { uid: 'u2' };
    await act(async () => rerender(<ItemPool />));
    await act(async () => {
      resolveAdd({ id: 'new-item-1' });
    });

    expect(track).not.toHaveBeenCalledWith('add_item');
    expect(track).not.toHaveBeenCalledWith('prompt_suggestion_submitted', expect.anything());
  });

  it('still fires the submission analytics normally when auth did NOT change', async () => {
    let resolveAdd: (r: { id: string; targetDayIndex?: number }) => void = () => {};
    H.addItem.mockReturnValue(
      new Promise<{ id: string; targetDayIndex?: number }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    H.user = { uid: 'u1' };
    render(<ItemPool />);

    fireEvent.change(screen.getByPlaceholderText('Add a prompt…'), {
      target: { value: 'Submitted by u1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await act(async () => {
      resolveAdd({ id: 'new-item-1' });
    });

    expect(track).toHaveBeenCalledWith('add_item');
    expect(track).toHaveBeenCalledWith('prompt_suggestion_submitted', expect.objectContaining({ hasTargetDay: false }));
  });
});
