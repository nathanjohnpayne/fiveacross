import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
  // #559: ItemPool now reads the Day schedule for its submitter-state pills.
  // No schedule here — this file's existing assertions predate #559 and
  // don't exercise scheduled/approved/not-selected states (own suite below).
  useEventDoc: () => ({ data: undefined }),
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

import ItemPool from './ItemPool';
import { UNSAVED_WORK_ATTRIBUTE } from '../swClientBridge';

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
