import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TallyCard as TallyCardData, TallyEntry } from '../types';

// ProofFeed imports the useData/firebase graph (real getAuth) + auth/proofs/
// analytics at module load; stub them so importing the component to render the
// isolated <TallyCard> never initializes Firebase or posthog.
vi.mock('../firebase', () => ({
  db: {},
  EVENT_ID: 'test-event',
  storage: {},
  auth: {},
  googleProvider: {},
  analytics: null,
}));

const H = vi.hoisted(() => ({ onSnapshot: vi.fn(), navigate: vi.fn() }));
H.onSnapshot.mockReturnValue(() => {});

vi.mock('firebase/firestore', () => {
  const makeRef = (kind: string, args: unknown[]) => {
    const ref: Record<string, unknown> = { kind, args };
    ref.withConverter = () => ref; // paths.ts chains .withConverter on refs
    return ref;
  };
  return {
    doc: (...args: unknown[]) => makeRef('doc', args),
    collection: (...args: unknown[]) => makeRef('collection', args),
    collectionGroup: (...args: unknown[]) => makeRef('collectionGroup', args),
    query: (...args: unknown[]) => ({ query: args }),
    where: (...args: unknown[]) => ({ where: args }),
    onSnapshot: H.onSnapshot,
  };
});
vi.mock('../data/proofs', () => ({ reportProof: vi.fn(), deleteProof: vi.fn() }));
// ProofFeed's ＋ Proof / 🙋 Got it too navigate to the Card tab (#261); the
// module mock keeps the default-export integration renders router-free.
vi.mock('react-router', () => ({ useNavigate: () => H.navigate }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'viewer' } }) }));
// #392: keep the real pure derivations (openDoubts/doubtStatusFor/isDoubtSatisfied)
// but stub the WRITE so the Feed's ask-for-proof affordance can be asserted without
// touching Firestore.
vi.mock('../data/doubts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/doubts')>();
  return { ...actual, raiseDoubt: vi.fn(() => Promise.resolve()) };
});

import ProofFeed, { TallyCard, tallyCardAction, tallyActionTarget, doubtsClearedByProof, viewerCellIndexForItem } from './ProofFeed';
import { raiseDoubt } from '../data/doubts';
import type { DoubtDoc } from '../types';
import { useOpenSquareIntent, __resetOpenSquareForTests } from '../hooks/useOpenSquare';
import { EVENT_ID } from '../firebase'; // the mock above: 'test-event'
import type { BoardDoc } from '../types';

// specs/d15-tally-cards.md — the Feed's Tally Card renderer + its per-viewer
// button gate (#216, daily-cards-spec § "Tally Cards"). The card shows the
// "first two + N" copy, the day chip, and an avatar stack; ＋ Proof / 🙋 Got it
// too render ONLY per the viewer's own marked/dealt state, never generically.

const marker = (uid: string, markedAt: number): TallyEntry => ({
  uid,
  displayName: uid,
  markedAt,
  dayIndex: 0,
  itemText: 'Balcony or porthole photo',
});

const card = (over: Partial<TallyCardData> = {}): TallyCardData => ({
  itemId: 'p1',
  dayIndex: 0,
  itemText: 'Balcony or porthole photo',
  count: 3,
  markers: [marker('alice', 1), marker('bob', 2), marker('carol', 3)],
  lastMarkedAt: 3,
  displayBump: 3,
  ...over,
});

describe('TallyCard — Feed rendering (specs/d15-tally-cards.md)', () => {
  it('renders "first two + N" names, the Prompt text, and a day chip', () => {
    render(<TallyCard card={card()} action={null} days={undefined} />);
    // first two names + "+1" for the third marker
    expect(screen.getByText(/alice, bob \+1/)).toBeTruthy();
    expect(screen.getByText(/Balcony or porthole photo/)).toBeTruthy();
    expect(screen.getByText(/Day 1/)).toBeTruthy(); // 1-based day chip, theme-less fallback
  });

  it('drops the "+N" when only two markers, and shows one name for a single marker', () => {
    render(<TallyCard card={card({ count: 2, markers: [marker('alice', 1), marker('bob', 2)] })} action={null} days={undefined} />);
    expect(screen.getByText(/alice, bob/)).toBeTruthy();
    expect(screen.queryByText(/\+/)).toBeNull();
  });

  it('tapping the card body opens the who-list sheet', () => {
    const onOpenWhoList = vi.fn();
    render(<TallyCard card={card()} action={null} days={undefined} onOpenWhoList={onOpenWhoList} />);
    fireEvent.click(screen.getByTitle('See who marked this'));
    expect(onOpenWhoList).toHaveBeenCalledOnce();
  });

  it('renders ＋ Proof only for the proof action, wired to onAddProof', () => {
    const onAddProof = vi.fn();
    render(<TallyCard card={card()} action="proof" days={undefined} onAddProof={onAddProof} />);
    const btn = screen.getByTitle('Add a proof');
    fireEvent.click(btn);
    expect(onAddProof).toHaveBeenCalledWith('p1');
    expect(screen.queryByTitle(/Got it/)).toBeNull();
  });

  it('renders 🙋 Got it too only for the gotit action', () => {
    render(<TallyCard card={card()} action="gotit" days={undefined} />);
    expect(screen.getByText(/Got it too/)).toBeTruthy();
    expect(screen.queryByTitle('Add a proof')).toBeNull();
  });

  it('renders NO button for the informational (null) action', () => {
    render(<TallyCard card={card()} action={null} days={undefined} />);
    expect(screen.queryByTitle('Add a proof')).toBeNull();
    expect(screen.queryByText(/Got it too/)).toBeNull();
  });

  it('#366: the tappable card body carries an explicit color — the marker names never fall back to UA ButtonText', () => {
    render(<TallyCard card={card()} action={null} days={undefined} />);
    const body = screen.getByTitle('See who marked this') as HTMLButtonElement;
    // Inline `color: inherit` resolves to the surrounding ink (body sets
    // `color: var(--ink)`; no ancestor between overrides it), so the names in
    // the .name span render themed on every platform instead of near-black.
    expect(body.style.color).toBe('inherit');
  });

  it('#366: the global button reset in index.css also inherits color (jsdom never applies the stylesheet, so pin the rule itself)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf-8');
    const m = css.match(/(?:^|\n)button\s*\{([^}]*)\}/);
    if (!m) throw new Error('button reset rule not found in index.css');
    expect(m[1]).toMatch(/color:\s*inherit/);
  });
});

describe('tallyCardAction — per-viewer button gate (specs/d15-tally-cards.md)', () => {
  it('＋ Proof when the viewer has MARKED that Prompt', () => {
    expect(tallyCardAction('p1', new Set(['p1']), new Set())).toBe('proof');
  });

  it('🙋 Got it too when the Prompt is UNMARKED on the viewer’s own dealt card', () => {
    expect(tallyCardAction('p1', new Set(), new Set(['p1']))).toBe('gotit');
  });

  it('informational (null) when the Prompt is not on the viewer’s card at all', () => {
    expect(tallyCardAction('p1', new Set(['other']), new Set(['another']))).toBeNull();
  });

  it('＋ Proof wins if a Prompt is somehow both — a marked Prompt is never also unmarked', () => {
    expect(tallyCardAction('p1', new Set(['p1']), new Set(['p1']))).toBe('proof');
  });
});

// #216 gap closure — the LIVE `ProofFeed` default export now wires its
// Feed-level `TallyCard`'s `onOpenWhoList` to a read-only who-list sheet built
// straight off the tally doc's own `markers[]`. Drives the REAL `useFeed`
// (proofs/moments/tally streams stubbed via `onSnapshot`) rather than the
// isolated `<TallyCard>` above, so the wiring itself — not just the
// presentational component — is under test.
const emptyColSnap = { docs: [], metadata: { fromCache: false } };
const emptyDocSnap = { exists: () => false, data: () => undefined, metadata: { fromCache: false } };

function markerDoc(itemId: string, entry: TallyEntry) {
  return {
    data: () => entry,
    // The full ancestor chain useTallyCards guards on:
    // events/{EVENT_ID}/tally/{itemId}/markers/{uid} — including the event id
    // (a sibling event's markers are filtered out, never merged into a card).
    ref: { parent: { parent: { id: itemId, parent: { id: 'tally', parent: { id: EVENT_ID } } } } },
  };
}

// The signed-in viewer's own player row (#392): the Feed resolves it through
// `useMyPlayer` so a Doubt raised from the who-list sheet publishes a KNOWN
// accuser. A confirmed row with a display name → `identityKnown` true.
const viewerPlayerSnap = {
  exists: () => true,
  // The converter pins `uid = snap.id`; the identity gate (#398) requires the
  // loaded row to belong to the current viewer ('viewer'), so stamp it here.
  data: () => ({ uid: 'viewer', displayName: 'Vic Viewer' }),
  metadata: { fromCache: false },
};

function captureOnNext(): {
  fire: (tally: unknown, proofs?: unknown, moments?: unknown, event?: unknown, player?: unknown, doubts?: unknown, notices?: unknown) => void;
  fireBoard: (dayIndex: number, board: BoardDoc | null) => void;
} {
  const captured: { proofs: ((s: unknown) => void) | null; moments: ((s: unknown) => void) | null; events: ((s: unknown) => void)[]; tally: ((s: unknown) => void) | null; doubtsAll: ((s: unknown) => void) | null; heartsAll: ((s: unknown) => void) | null; notices: ((s: unknown) => void) | null; player: ((s: unknown) => void) | null; boards: Record<number, (s: unknown) => void> } = {
    proofs: null,
    moments: null,
    heartsAll: null,
    notices: null,
    // EVERY event-doc subscription (#262: useAllDoubts' moderation read opens
    // a second one) — fire() feeds them all so none starves.
    events: [],
    tally: null,
    doubtsAll: null,
    // #392: the Feed also opens the viewer's own player row (useMyPlayer) to
    // resolve the Doubt accuser identity.
    player: null,
    boards: {},
  };
  H.onSnapshot.mockImplementation((target: unknown, optionsOrNext: unknown, maybeNext?: (s: unknown) => void) => {
    // useMyDayBoards (#261) subscribes WITHOUT an options arg; useDocSub passes
    // one. Normalize so both shapes capture their onNext.
    const onNext = (typeof optionsOrNext === 'function' ? optionsOrNext : maybeNext) as (s: unknown) => void;
    const kind = target && typeof target === 'object' ? (target as { kind?: string }).kind : undefined;
    const args = target && typeof target === 'object' ? ((target as { args?: unknown[] }).args ?? []) : [];
    if (target && typeof target === 'object' && 'query' in (target as object)) captured.proofs = onNext;
    else if (kind === 'doc' && args[3] === 'days') captured.boards[Number(args[4])] = onNext;
    // #392: the viewer's own player row — events/{eid}/players/{uid} — routed by
    // its own segment so it doesn't land in the shared event-doc bucket.
    else if (kind === 'doc' && args[3] === 'players') captured.player = onNext;
    else if (kind === 'doc') captured.events.push(onNext);
    else if (kind === 'collectionGroup') captured.tally = onNext;
    // #262: the Feed also opens the flat doubts subscription; route it by its
    // own path segment so it can't clobber the moments capture.
    else if (kind === 'collection' && args[3] === 'doubts') captured.doubtsAll = onNext;
    // specs/feed-hearts.md: the flat hearts stream — routed by segment for the
    // same clobber-proofing; this suite never fixtures hearts, so fire() feeds
    // it the empty snapshot.
    else if (kind === 'collection' && args[3] === 'hearts') captured.heartsAll = onNext;
    // specs/admin-messages.md: useFeed's fourth stream (useNotices) — the flat
    // `notices` collection, routed by segment so it can't clobber the moments slot.
    else if (kind === 'collection' && args[3] === 'notices') captured.notices = onNext;
    else captured.moments = onNext;
    return () => {};
  });
  return {
    fire: (tally, proofs = emptyColSnap, moments = emptyColSnap, event = emptyDocSnap, player = viewerPlayerSnap, doubts = emptyColSnap, notices = emptyColSnap) => {
      act(() => {
        captured.proofs?.(proofs);
        captured.moments?.(moments);
        captured.events.forEach((fn) => fn(event));
        captured.player?.(player);
        captured.tally?.(tally);
        captured.doubtsAll?.(doubts);
        captured.heartsAll?.(emptyColSnap);
        captured.notices?.(notices);
      });
    },
    fireBoard: (dayIndex: number, board: BoardDoc | null) => {
      act(() => {
        captured.boards[dayIndex]?.({
          exists: () => board != null,
          data: () => board ?? undefined,
          metadata: { fromCache: false },
        });
      });
    },
  };
}

describe('ProofFeed (default export) — Feed-level who-list sheet (#216 acceptance: "Tap opens the who-list sheet")', () => {
  it('tapping a live Feed Tally Card opens a sheet listing its markers WITH an ask-for-proof affordance (#392)', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const entry: TallyEntry = {
      uid: 'alice',
      displayName: 'Alice Anchor',
      markedAt: 1000,
      dayIndex: 0,
      itemText: 'Balcony or porthole photo',
    };
    sub.fire({ docs: [markerDoc('p1', entry)], metadata: { fromCache: false } });

    const tallyCard = document.querySelector('.tally-card');
    expect(tallyCard).toBeTruthy();
    // No who-list sheet until the card is tapped.
    expect(screen.queryByText(/^Who got/)).toBeNull();

    fireEvent.click(tallyCard!.querySelector('.tally-card-body')!);

    // The sheet opens, names the SAME Prompt, and lists the marker.
    expect(screen.getByText(/Who got/)).toBeTruthy();
    const sheetRows = document.querySelectorAll('.sheet .list .row');
    expect(sheetRows).toHaveLength(1);
    expect(sheetRows[0].querySelector('.name')?.textContent).toBe('Alice Anchor');
    // #392: the marker (someone OTHER than the viewer) now carries the Doubt
    // affordance — "ask for proof" from the Feed, not only from the board square.
    // With a confirmed viewer identity it is enabled.
    const doubtBtn = sheetRows[0].querySelector<HTMLButtonElement>('.doubt-btn');
    expect(doubtBtn).toBeTruthy();
    expect(doubtBtn!.disabled).toBe(false);
    expect(doubtBtn!.textContent).toContain('Pics or it didn’t happen');

    // Close dismisses it.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/^Who got/)).toBeNull();
  });

  it('tapping the Doubt affordance raises a Doubt against that marker via raiseDoubt (#392)', async () => {
    H.onSnapshot.mockReset();
    vi.mocked(raiseDoubt).mockClear();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = { uid: 'alice', displayName: 'Alice Anchor', markedAt: 1000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    const bob: TallyEntry = { uid: 'bob', displayName: 'Bob Bosun', markedAt: 2000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    sub.fire({ docs: [markerDoc('p1', alice), markerDoc('p1', bob)], metadata: { fromCache: false } });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);

    const rows = [...document.querySelectorAll('.sheet .list .row')];
    expect(rows).toHaveLength(2);
    // Ask Bob for proof — wrapped so the raise's `.then(clear)` in-flight reset
    // settles inside act() rather than after the test.
    const bobRow = rows.find((r) => r.querySelector('.name')?.textContent === 'Bob Bosun')!;
    await act(async () => {
      fireEvent.click(bobRow.querySelector('.doubt-btn')!);
    });

    expect(raiseDoubt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(raiseDoubt).mock.calls[0][0]).toMatchObject({
      fromUid: 'viewer',
      fromDisplayName: 'Vic Viewer',
      targetUid: 'bob',
      targetDisplayName: 'Bob Bosun',
      itemId: 'p1',
      cellIndex: -1, // the viewer dealt no board carrying this Prompt — Feed context
    });
  });

  it('the viewer’s OWN marker row carries no Doubt affordance — no self-doubt (#392)', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const me: TallyEntry = { uid: 'viewer', displayName: 'Vic Viewer', markedAt: 1000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    const alice: TallyEntry = { uid: 'alice', displayName: 'Alice Anchor', markedAt: 2000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    sub.fire({ docs: [markerDoc('p1', me), markerDoc('p1', alice)], metadata: { fromCache: false } });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);

    const rows = [...document.querySelectorAll('.sheet .list .row')];
    const myRow = rows.find((r) => r.querySelector('.name')?.textContent === 'Vic Viewer')!;
    expect(myRow.querySelector('.doubt-btn')).toBeNull();
    expect(myRow.querySelector('.you-pill')).toBeTruthy();
    // Another marker still carries it.
    const aliceRow = rows.find((r) => r.querySelector('.name')?.textContent === 'Alice Anchor')!;
    expect(aliceRow.querySelector('.doubt-btn')).toBeTruthy();
  });

  it('a marker the viewer already doubted shows the OPEN state, not a second raise (#392)', () => {
    H.onSnapshot.mockReset();
    vi.mocked(raiseDoubt).mockClear();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = { uid: 'alice', displayName: 'Alice Anchor', markedAt: 1000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    const myDoubt: DoubtDoc = {
      id: 'viewer_alice_p1', itemId: 'p1', cellIndex: -1,
      fromUid: 'viewer', fromDisplayName: 'Vic Viewer',
      targetUid: 'alice', targetDisplayName: 'Alice Anchor', createdAt: 500,
    };
    sub.fire(
      { docs: [markerDoc('p1', alice)], metadata: { fromCache: false } },
      emptyColSnap, emptyColSnap, emptyDocSnap, viewerPlayerSnap,
      { docs: [{ data: () => myDoubt }], metadata: { fromCache: false, hasPendingWrites: false } },
    );
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);

    const aliceRow = document.querySelector('.sheet .list .row')!;
    // The once-only slot is spent → no raise affordance; the open state shows instead.
    expect(aliceRow.querySelector('.doubt-btn')).toBeNull();
    expect(aliceRow.querySelector('.doubt-open')?.textContent).toContain('Doubted');
    // The header's open-doubt half surfaces too.
    expect(screen.getByText(/open doubt/)).toBeTruthy();
  });

  it('the Doubt affordance stays DISABLED until the viewer’s identity is known (#392)', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = { uid: 'alice', displayName: 'Alice Anchor', markedAt: 1000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    // A cache-only "absent" player row with NO server confirmation → identity unknown.
    const unconfirmed = { exists: () => false, data: () => undefined, metadata: { fromCache: true } };
    sub.fire(
      { docs: [markerDoc('p1', alice)], metadata: { fromCache: false } },
      emptyColSnap, emptyColSnap, emptyDocSnap, unconfirmed,
    );
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);

    const btn = document.querySelector<HTMLButtonElement>('.sheet .doubt-btn')!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('the Doubt affordance stays DISABLED while the loaded player row belongs to a PREVIOUS account (#398 account-switch race)', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = { uid: 'alice', displayName: 'Alice Anchor', markedAt: 1000, dayIndex: 0, itemText: 'Balcony or porthole photo' };
    // Right after an account switch the viewer uid is already 'viewer', but
    // useMyPlayer still holds the PREVIOUS account's server-confirmed row — its
    // uid is 'olduser'. The identity gate must reject this stale row so a Doubt
    // can't publish under the wrong name until the current uid's row resolves.
    const staleRow = { exists: () => true, data: () => ({ uid: 'olduser', displayName: 'Old Account' }), metadata: { fromCache: false } };
    sub.fire(
      { docs: [markerDoc('p1', alice)], metadata: { fromCache: false } },
      emptyColSnap, emptyColSnap, emptyDocSnap, staleRow,
    );
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);

    const btn = document.querySelector<HTMLButtonElement>('.sheet .doubt-btn')!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('the open sheet re-derives its markers from the live tally (#333): arrivals appear, unmarks leave', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = {
      uid: 'alice',
      displayName: 'Alice Anchor',
      markedAt: 1000,
      dayIndex: 0,
      itemText: 'Balcony or porthole photo',
    };
    const bob: TallyEntry = {
      uid: 'bob',
      displayName: 'Bob Bosun',
      markedAt: 2000,
      dayIndex: 0,
      itemText: 'Balcony or porthole photo',
    };
    sub.fire({ docs: [markerDoc('p1', alice)], metadata: { fromCache: false } });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    expect(document.querySelectorAll('.sheet .list .row')).toHaveLength(1);

    // A new marker arrives while the sheet is open — the sheet shows the LIVE
    // list, not the tap-time snapshot.
    sub.fire({ docs: [markerDoc('p1', alice), markerDoc('p1', bob)], metadata: { fromCache: false } });
    let rows = document.querySelectorAll('.sheet .list .row');
    expect(rows).toHaveLength(2);
    expect([...rows].map((r) => r.querySelector('.name')?.textContent)).toContain('Bob Bosun');

    // A marker unmarks while the sheet is open — the stale row leaves.
    sub.fire({ docs: [markerDoc('p1', bob)], metadata: { fromCache: false } });
    rows = document.querySelectorAll('.sheet .list .row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.name')?.textContent).toBe('Bob Bosun');
    // The sheet itself stayed open throughout — same dialog, live content.
    expect(screen.getByText(/Who got/)).toBeTruthy();

    // The LAST marker unmarks and the feed goes empty (Codex P2 on #384): the
    // empty-feed early return must not unmount the open dialog — it stays up
    // on the tap-time snapshot fallback, alongside the empty-feed message.
    sub.fire({ docs: [], metadata: { fromCache: false } });
    expect(screen.getByText(/Who got/)).toBeTruthy();
    expect(screen.getByText(/Nothing in the feed yet/)).toBeTruthy();
  });

  it('keeps re-deriving when the 60-entry merge cap evicts the open card from the feed (#385)', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    const alice: TallyEntry = {
      uid: 'alice',
      displayName: 'Alice Anchor',
      markedAt: 1000,
      dayIndex: 0,
      itemText: 'Balcony or porthole photo',
    };
    const bob: TallyEntry = {
      uid: 'bob',
      displayName: 'Bob Bosun',
      markedAt: 2000,
      dayIndex: 0,
      itemText: 'Balcony or porthole photo',
    };
    sub.fire({ docs: [markerDoc('p1', alice)], metadata: { fromCache: false } });
    fireEvent.click(document.querySelector('.tally-card .tally-card-body')!);
    expect(document.querySelectorAll('.sheet .list .row')).toHaveLength(1);

    // 61 newer Proofs push the opened Tally Card out of the CAPPED entries
    // merge, while the same snapshot pass delivers a SECOND marker on the
    // tally. The card leaves the rendered feed — but the open sheet reads
    // the uncapped tallyCards stream, so the new marker still appears.
    const proofDocs = Array.from({ length: 61 }, (_, i) => ({
      id: `pr${i}`,
      data: () => ({
        uid: `u${i}`,
        displayName: `Prover ${i}`,
        photoURL: null,
        type: 'callout',
        cellIndex: 0,
        itemText: `Prompt ${i}`,
        text: 'seen it',
        createdAt: 5000 + i,
        reportCount: 0,
        status: 'active',
      }),
      ref: { parent: { parent: { id: 'proofs', parent: { id: EVENT_ID } } } },
    }));
    sub.fire(
      { docs: [markerDoc('p1', alice), markerDoc('p1', bob)], metadata: { fromCache: false } },
      { docs: proofDocs, metadata: { fromCache: false } },
    );
    expect(document.querySelector('.tally-card')).toBeNull(); // evicted from the capped merge
    const rows = document.querySelectorAll('.sheet .list .row');
    expect(rows).toHaveLength(2); // yet the sheet re-derived live
    expect([...rows].map((r) => r.querySelector('.name')?.textContent)).toContain('Bob Bosun');
  });
});

// --- #261: Feed Tally Card actions — target resolution + live wiring -------

const boardWith = (cells: { itemId: string; marked?: boolean; free?: boolean }[], dayIndex = 0): BoardDoc => ({
  uid: 'viewer',
  dayIndex,
  seed: 1,
  createdAt: 0,
  cells: cells.map((c, index) => ({
    index,
    itemId: c.free ? '' : c.itemId,
    text: c.itemId,
    spicy: false,
    free: !!c.free,
    marked: !!c.marked,
    markedAt: c.marked ? 1 : null,
  })),
});

describe('tallyActionTarget — where a Tally Card button lands (#261)', () => {
  it('resolves the Day carrying the Prompt, marked-ness included', () => {
    const boards = new Map([[1, boardWith([{ itemId: 'p1' }], 1)]]);
    expect(tallyActionTarget({ itemId: 'p1', dayIndex: 0 }, boards)).toEqual({ dayIndex: 1, itemId: 'p1', marked: false });
  });

  it('a marked hit anywhere beats an unmarked one (＋ Proof beats 🙋 Got it too)', () => {
    const boards = new Map([
      [0, boardWith([{ itemId: 'p1' }], 0)],
      [2, boardWith([{ itemId: 'p1', marked: true }], 2)],
    ]);
    expect(tallyActionTarget({ itemId: 'p1', dayIndex: 0 }, boards)).toEqual({ dayIndex: 2, itemId: 'p1', marked: true });
  });

  it("prefers the card's own Day among equal marked-ness, then the latest Day", () => {
    const boards = new Map([
      [0, boardWith([{ itemId: 'p1' }], 0)],
      [3, boardWith([{ itemId: 'p1' }], 3)],
    ]);
    expect(tallyActionTarget({ itemId: 'p1', dayIndex: 3 }, boards)?.dayIndex).toBe(3);
    expect(tallyActionTarget({ itemId: 'p1', dayIndex: 7 }, boards)?.dayIndex).toBe(3);
  });

  it('null when the Prompt is on none of the viewer cards (informational card)', () => {
    const boards = new Map([[0, boardWith([{ itemId: 'other' }, { itemId: '', free: true }], 0)]]);
    expect(tallyActionTarget({ itemId: 'p1', dayIndex: 0 }, boards)).toBeNull();
  });
});

describe('viewerCellIndexForItem — the doubter’s own square for a Feed Doubt (#392)', () => {
  it('returns the cellIndex of the Prompt on the viewer’s board', () => {
    const boards = new Map([[0, boardWith([{ itemId: 'other' }, { itemId: 'p1' }], 0)]]);
    expect(viewerCellIndexForItem(boards, 'p1')).toBe(1);
  });

  it('returns -1 when the Prompt is on none of the viewer’s dealt cards (raised from the Feed)', () => {
    const boards = new Map([[0, boardWith([{ itemId: 'other' }, { itemId: '', free: true }], 0)]]);
    expect(viewerCellIndexForItem(boards, 'p1')).toBe(-1);
  });

  it('returns -1 for an empty board set (no cards dealt yet)', () => {
    expect(viewerCellIndexForItem(new Map(), 'p1')).toBe(-1);
  });
});

describe('ProofFeed — Tally Card actions wired to the Board sheet (#261)', () => {
  const dayFixture = (index: number) => ({
    index,
    date: `2026-07-${15 + index}`,
    place: `Port ${index}`,
    placeEmoji: '🇭🇷',
    theme: 'get-sporty',
    pool: 'main',
    tutorial: false,
    unlockAt: 0,
  });
  const eventSnap = {
    exists: () => true,
    data: () => ({ days: [dayFixture(0)] }),
    metadata: { fromCache: false },
  };
  const IntentProbe = () => {
    const intent = useOpenSquareIntent();
    return <div data-testid="intent">{intent ? `${intent.dayIndex}:${intent.itemId}` : ''}</div>;
  };
  const markers = { docs: [markerDoc('p1', { uid: 'alice', displayName: 'Alice', markedAt: 1, dayIndex: 0, itemText: 'Balcony or porthole photo' })], metadata: { fromCache: false } };

  it('🙋 Got it too renders for an unmarked Prompt on the viewer card; tap records the intent and navigates to the Card tab', () => {
    __resetOpenSquareForTests();
    H.navigate.mockReset();
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(
      <>
        <ProofFeed />
        <IntentProbe />
      </>,
    );
    sub.fire(markers, emptyColSnap, emptyColSnap, eventSnap);
    sub.fireBoard(0, boardWith([{ itemId: 'p1' }], 0));

    const btn = screen.getByText(/Got it too/);
    fireEvent.click(btn);
    expect(H.navigate).toHaveBeenCalledWith('/');
    expect(screen.getByTestId('intent').textContent).toBe('0:p1');
  });

  it('＋ Proof renders for a marked Prompt; an off-card Prompt stays informational', () => {
    __resetOpenSquareForTests();
    H.navigate.mockReset();
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(markers, emptyColSnap, emptyColSnap, eventSnap);

    // Board arrives with the Prompt already marked → ＋ Proof.
    sub.fireBoard(0, boardWith([{ itemId: 'p1', marked: true }], 0));
    expect(screen.getByTitle('Add a proof')).toBeTruthy();
    expect(screen.queryByText(/Got it too/)).toBeNull();

    // Board swaps to one without the Prompt → no button at all.
    sub.fireBoard(0, boardWith([{ itemId: 'other' }], 0));
    expect(screen.queryByTitle('Add a proof')).toBeNull();
    expect(screen.queryByText(/Got it too/)).toBeNull();
  });
});

describe('doubtsClearedByProof — the wireframes\' "👀 cleared N doubts" pill (#262)', () => {
  const mapping = new Map([['item-1', 'Lost passport']]);
  const doubt = (over: Record<string, unknown>) => ({
    id: 'd', itemId: 'item-1', cellIndex: 0, fromUid: 'f', fromDisplayName: 'F',
    targetUid: 'bob', targetDisplayName: 'Bob', createdAt: 1000, ...over,
  }) as import('../types').DoubtDoc;
  const proof = { id: 'p-late', uid: 'bob', itemText: 'Lost passport', createdAt: 2000 };

  it('counts only doubts against the prover, on the same Prompt, satisfied by THIS proof', () => {
    const doubts = [
      doubt({ id: 'd1' }), // cleared
      doubt({ id: 'd2', createdAt: 1500 }), // cleared
      doubt({ id: 'd3', targetUid: 'carol' }), // wrong target
      doubt({ id: 'd4', itemId: 'other-item' }), // wrong prompt
    ];
    expect(doubtsClearedByProof(proof, doubts, mapping)).toBe(2);
  });

  it('zero when nothing matches (no pill renders)', () => {
    expect(doubtsClearedByProof(proof, [], mapping)).toBe(0);
  });

  it('a once-only Doubt belongs to the EARLIEST satisfying proof — later proofs on the same Prompt do not re-count it (Codex P2, round 2)', () => {
    const doubts = [doubt({ id: 'd1' })];
    const earliest = { id: 'p-early', uid: 'bob', itemText: 'Lost passport', createdAt: 1500 };
    const stream = [earliest, proof];
    // The earliest satisfying proof wears the pill…
    expect(doubtsClearedByProof(earliest, doubts, mapping, stream)).toBe(1);
    // …and the later proof does NOT re-claim the already-answered Doubt.
    expect(doubtsClearedByProof(proof, doubts, mapping, stream)).toBe(0);
    // A same-timestamp tie breaks deterministically by id (ascending).
    const twin = { id: 'p-a', uid: 'bob', itemText: 'Lost passport', createdAt: 2000 };
    expect(doubtsClearedByProof(twin, doubts, mapping, [twin, proof])).toBe(1);
    expect(doubtsClearedByProof(proof, doubts, mapping, [twin, proof])).toBe(0);
  });

  it('a proof that predates the Doubt never steals it from the real answer', () => {
    const doubts = [doubt({ id: 'd1', createdAt: 1000 })];
    // 200s before the doubt — outside the satisfaction skew, so NOT satisfying.
    const before = { id: 'p-before', uid: 'bob', itemText: 'Lost passport', createdAt: 800000 - 999999 };
    expect(doubtsClearedByProof(proof, doubts, mapping, [before, proof])).toBe(1);
  });
});

// specs/admin-messages.md (#455) — an in-place copy correction is VISIBLE on the
// player-facing Feed card, never silent. The rules let an admin fix a typo without
// letting anyone rewrite a delivered Notice; `editedAt` is how a reader can tell.
describe('ProofFeed — a corrected Notice is marked "edited" (#455)', () => {
  const noticeDoc = (over: Record<string, unknown> = {}) => ({
    data: () => ({
      id: 'n1',
      title: 'Final stretch 🏁',
      body: 'happened—if',
      uid: 'admin-uid',
      displayName: 'Nathan',
      createdAt: 5000,
      dayIndex: 0,
      pinned: true,
      ...over,
    }),
  });
  const noticesSnap = (over?: Record<string, unknown>) => ({
    docs: [noticeDoc(over)],
    metadata: { fromCache: false },
  });
  const eventSnap = {
    exists: () => true,
    data: () => ({ days: [{ index: 0, date: '2026-07-15', place: 'Sea', theme: 't', pool: 'main', tutorial: false, unlockAt: 0 }] }),
    metadata: { fromCache: false },
  };

  it('renders "edited" once the Notice carries editedAt', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(emptyColSnap, emptyColSnap, emptyColSnap, eventSnap, viewerPlayerSnap, emptyColSnap, noticesSnap({ editedAt: 6000 }));

    expect(screen.getByText('Final stretch 🏁')).toBeInTheDocument();
    expect(screen.getByText(/edited/)).toBeInTheDocument();
  });

  it('an unedited Notice renders exactly as before — no "edited" marker', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);
    sub.fire(emptyColSnap, emptyColSnap, emptyColSnap, eventSnap, viewerPlayerSnap, emptyColSnap, noticesSnap());

    expect(screen.getByText('Final stretch 🏁')).toBeInTheDocument();
    expect(screen.queryByText(/edited/)).toBeNull();
  });
});

// #534/#561 (specs/feed-hearts.md § Most-Loved Photo) — the Feed's standing
// Hearts invitation: a quiet muted strip at the TOP of the list while Hearts
// still count toward the freeze, gone the moment the standings freeze. No
// streaks, no badge counts, no dismiss state, no notification hook.
describe('ProofFeed — the Hearts cue (#534/#561)', () => {
  const cueEntry: TallyEntry = {
    uid: 'alice',
    displayName: 'Alice Anchor',
    markedAt: 1000,
    dayIndex: 0,
    itemText: 'Balcony or porthole photo',
  };
  const tallySnap = { docs: [markerDoc('p1', cueEntry)], metadata: { fromCache: false } };

  it('renders the cue as the FIRST child of the Feed list before the freeze', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);
    const unfrozenEvent = {
      exists: () => true,
      data: () => ({ days: [] }),
      metadata: { fromCache: false },
    };
    sub.fire(tallySnap, emptyColSnap, emptyColSnap, unfrozenEvent);

    const list = document.querySelector('.list')!;
    const cue = list.firstElementChild!;
    expect(cue.className).toBe('feed-heart-cue');
    expect(cue.textContent).toBe('Heart the moments you want to remember');
  });

  it('withholds the cue until the Event snapshot is available', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);

    sub.fire(tallySnap);

    expect(document.querySelector('.tally-card')).toBeTruthy();
    expect(document.querySelector('.feed-heart-cue')).toBeNull();
  });

  it('leaves with the freeze: no cue once the standings are frozen', () => {
    H.onSnapshot.mockReset();
    const sub = captureOnNext();
    render(<ProofFeed />);
    const frozenEvent = {
      exists: () => true,
      data: () => ({ frozenAt: 123 }),
      metadata: { fromCache: false },
    };
    sub.fire(tallySnap, emptyColSnap, emptyColSnap, frozenEvent);

    // The Feed itself still renders; only the cue is gone.
    expect(document.querySelector('.tally-card')).toBeTruthy();
    expect(document.querySelector('.feed-heart-cue')).toBeNull();
  });
});
