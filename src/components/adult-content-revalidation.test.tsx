import { render, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  adultContentRequired,
  adultContentSettledAdult,
  resetAdultContentForTests,
  setActiveAdultContent,
} from '../adultContent';
import { useAdultContent } from '../hooks/useAdultContent';

// Covers the posture staying CURRENT while a tab is open (Phase 4b).
//
// The gap this closes: `hostnames/{host}.adultContent` was resolved once, before
// React mounted, into a plain module variable. So a tab already open when an
// admin approved the first explicit Prompt never re-read the routing document
// and never re-rendered the gate — and a launch landing inside the derivation's
// asynchronous window read the old `false` and stayed ungated for the whole
// session. #608's re-prompt path only works if something re-asks.
//
// Round 3 replaced the poll that did the re-asking with a document LISTENER, and
// these tests encode why the correction matters: a Player's Prompts arrive over
// their own live `items` listener the instant an admin approves, so a five-minute
// posture poll left a window in which explicit content reached the screen before
// the acknowledgement gating it.

const mocks = vi.hoisted(() => ({ onSnapshot: vi.fn() }));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: vi.fn(),
  getDocFromServer: vi.fn(),
  onSnapshot: mocks.onSnapshot,
}));
vi.mock('../firebase', () => ({ db: {}, applyResolvedEventId: vi.fn() }));
vi.mock('../data/cardCache', () => ({ setCardCacheEventId: vi.fn() }));
vi.mock('../canonicalHost', () => ({ applyResolvedCanonicalHost: vi.fn() }));

import { watchAdultContent } from '../data/hostnames';
import AdultContentWatcher from './AdultContentWatcher';

const HOST = 'bodega-bay.fiveacross.app';
const unsubscribe = vi.fn();

/** A Firestore document snapshot. `fromCache` is the whole point — it is what
 *  separates a claim from proof. */
const snap = (data: unknown, fromCache = false) => ({
  exists: () => data != null,
  data: () => data,
  metadata: { fromCache },
});

/** Drive the most recently opened listener's callbacks by hand. */
function listener() {
  const call = mocks.onSnapshot.mock.calls[mocks.onSnapshot.mock.calls.length - 1];
  return { next: call[1] as (s: unknown) => void, onError: call[2] as (e: unknown) => void };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onSnapshot.mockReturnValue(unsubscribe);
  resetAdultContentForTests();
});
afterEach(() => {
  cleanup();
  resetAdultContentForTests();
});

describe('watchAdultContent — a document listener, not a poll', () => {
  it('listens to the EXACT routing document, which is a `get`, not a `list`', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    expect(mocks.onSnapshot.mock.calls[0][0]).toMatchObject({ path: `hostnames/${HOST}` });
  });

  it('lowercases the hostname into the document path', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent('Bodega-Bay.FiveAcross.app');
    expect(mocks.onSnapshot.mock.calls[0][0]).toMatchObject({ path: `hostnames/${HOST}` });
  });

  it('raises the gate the moment the routing document is stamped', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: true })));
    expect(adultContentRequired()).toBe(true);
    // A server-backed snapshot, so the session latches.
    expect(adultContentSettledAdult()).toBe(true);
  });

  it('detaches once the answer can no longer change', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: true })));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('never opens a listener at all once the posture has latched', () => {
    setActiveAdultContent(true, { proven: true });
    watchAdultContent(HOST);
    expect(mocks.onSnapshot).not.toHaveBeenCalled();
  });

  it('lowers a PROVISIONAL gate once a server snapshot says otherwise', () => {
    setActiveAdultContent(true, { proven: false });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: false })));
    expect(adultContentRequired()).toBe(false);
  });

  // The provenance rule on the listener's own terms: a snapshot served from
  // Firestore's local cache is not evidence about the posture NOW.
  it('lets a CACHED snapshot raise the gate but never lower it', () => {
    setActiveAdultContent(true, { proven: false });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: false }, true)));
    expect(adultContentRequired(), 'a cached false proves nothing').toBe(true);

    resetAdultContentForTests();
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: true }, true)));
    expect(adultContentRequired(), 'a cached true still raises').toBe(true);
    expect(adultContentSettledAdult(), '…but does not latch').toBe(false);
  });

  // Phase 4b round 3. The previous cut preserved a proven `false` through a
  // failure. After the Event has transitioned that is the exact hazard: this one
  // read fails while every OTHER Firestore read happily delivers the newly
  // active explicit Prompt.
  it('GATES when the listener errors — a failure proves nothing', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    act(() => listener().onError(new Error('permission-denied')));
    expect(adultContentRequired()).toBe(true);
    // Provisional, so a later successful server snapshot lowers it again.
    expect(adultContentSettledAdult()).toBe(false);
    act(() => listener().next(snap({ adultContent: false })));
    expect(adultContentRequired()).toBe(false);
  });

  // The single-Event build case: a baked `VITE_ADULT_CONTENT=false` with no
  // routing document is an opt-out nothing can ever withdraw.
  it('gates an origin with no routing document at all', () => {
    setActiveAdultContent(false, { proven: false });
    watchAdultContent(HOST);
    act(() => listener().next(snap(null)));
    expect(adultContentRequired()).toBe(true);
  });

  it('treats a malformed value as gated, like every other reader', () => {
    setActiveAdultContent(false, { proven: true });
    watchAdultContent(HOST);
    act(() => listener().next(snap({ adultContent: 'false' })));
    expect(adultContentRequired()).toBe(true);
  });
});

describe('the gate re-renders when the Event turns adult mid-session', () => {
  function Probe() {
    return <span data-testid="posture">{useAdultContent() ? 'gated' : 'open'}</span>;
  }

  it('pushes a posture change into React, with no other state changing', () => {
    setActiveAdultContent(false, { proven: true });
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('posture').textContent).toBe('open');
    // Nothing else re-renders this tree — which is the whole point. Before the
    // store was reactive, a component reading the module variable would have
    // gone on rendering "open" for the rest of the session.
    act(() => setActiveAdultContent(true, { proven: true }));
    expect(getByTestId('posture').textContent).toBe('gated');
  });
});

describe('AdultContentWatcher', () => {
  it('opens the listener on mount', async () => {
    setActiveAdultContent(false, { proven: true });
    render(<AdultContentWatcher />);
    await waitFor(() => expect(mocks.onSnapshot).toHaveBeenCalledTimes(1));
  });

  it('gates the open tab when the routing document is stamped under it', async () => {
    setActiveAdultContent(false, { proven: true });
    render(<AdultContentWatcher />);
    await waitFor(() => expect(mocks.onSnapshot).toHaveBeenCalled());
    act(() => listener().next(snap({ adultContent: true })));
    expect(adultContentRequired()).toBe(true);
  });

  it('detaches on unmount', async () => {
    setActiveAdultContent(false, { proven: true });
    const { unmount } = render(<AdultContentWatcher />);
    await waitFor(() => expect(mocks.onSnapshot).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
