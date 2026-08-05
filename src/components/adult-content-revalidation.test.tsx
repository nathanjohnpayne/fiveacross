import { render, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  adultContentRequired,
  adultContentSettledAdult,
  resetAdultContentForTests,
  setActiveAdultContent,
} from '../adultContent';
import { useAdultContent } from '../hooks/useAdultContent';

// Covers the posture staying CURRENT while a tab is open (Phase 4b P1).
//
// The gap this closes: `hostnames/{host}.adultContent` was resolved once, before
// React mounted, into a plain module variable. So a tab that was already open
// when an admin approved the first explicit Prompt never re-read the routing
// document and never re-rendered the gate — and a launch that landed inside the
// derivation's asynchronous window read the old `false` and stayed ungated for
// the whole session. #608's re-prompt path only works if something re-asks.

const mocks = vi.hoisted(() => ({ getDocFromServer: vi.fn() }));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: vi.fn(),
  getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('../firebase', () => ({ db: {}, applyResolvedEventId: vi.fn() }));
vi.mock('../data/cardCache', () => ({ setCardCacheEventId: vi.fn() }));
vi.mock('../canonicalHost', () => ({ applyResolvedCanonicalHost: vi.fn() }));

import { revalidateAdultContent } from '../data/hostnames';
import AdultContentWatcher, { ADULT_CONTENT_POLL_MS } from './AdultContentWatcher';

const snap = (data: unknown) => ({ exists: () => data != null, data: () => data });
const HOST = 'bodega-bay.fiveacross.app';

beforeEach(() => {
  vi.clearAllMocks();
  resetAdultContentForTests();
});
afterEach(() => {
  cleanup();
  resetAdultContentForTests();
});

describe('revalidateAdultContent — the revocation channel', () => {
  it('raises the gate when the routing document has been stamped', async () => {
    setActiveAdultContent(false, { proven: true });
    mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: true }));
    await revalidateAdultContent(HOST);
    expect(adultContentRequired()).toBe(true);
    // A live read, so the session latches: nothing can lower it again.
    expect(adultContentSettledAdult()).toBe(true);
  });

  it('lowers a PROVISIONAL gate once it can actually ask', async () => {
    // The gate startup resolution puts up when revalidation failed. It is a gate
    // until we can ask, not a gate forever.
    setActiveAdultContent(true, { proven: false });
    mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: false }));
    await revalidateAdultContent(HOST);
    expect(adultContentRequired()).toBe(false);
  });

  it('never lowers a gate a live read established', async () => {
    setActiveAdultContent(true, { proven: true });
    mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: false }));
    await revalidateAdultContent(HOST);
    expect(adultContentRequired()).toBe(true);
  });

  // The single-Event build case. A baked `VITE_ADULT_CONTENT=false` with no
  // routing document is an opt-out nothing can ever withdraw — so it is not one
  // this design can honour.
  it('gates a build whose origin has no routing document at all', async () => {
    setActiveAdultContent(false, { proven: false });
    mocks.getDocFromServer.mockResolvedValue(snap(null));
    await revalidateAdultContent(HOST);
    expect(adultContentRequired()).toBe(true);
  });

  it('leaves the posture alone when the read fails — silence is not proof', async () => {
    setActiveAdultContent(false, { proven: true });
    mocks.getDocFromServer.mockRejectedValue(new Error('offline'));
    await expect(revalidateAdultContent(HOST)).resolves.toBeUndefined();
    expect(adultContentRequired()).toBe(false);
  });

  it('stops reading once the answer can no longer change', async () => {
    setActiveAdultContent(true, { proven: true });
    await revalidateAdultContent(HOST);
    expect(mocks.getDocFromServer).not.toHaveBeenCalled();
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
  it('asks once on mount — the launch-inside-the-trigger-window case', async () => {
    setActiveAdultContent(false, { proven: true });
    mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: true }));
    render(<AdultContentWatcher />);
    await waitFor(() => expect(adultContentRequired()).toBe(true));
  });

  it('re-asks when the tab becomes visible and when the network returns', async () => {
    setActiveAdultContent(false, { proven: true });
    mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: false }));
    render(<AdultContentWatcher />);
    await waitFor(() => expect(mocks.getDocFromServer).toHaveBeenCalledTimes(1));
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(mocks.getDocFromServer).toHaveBeenCalledTimes(2));
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(mocks.getDocFromServer).toHaveBeenCalledTimes(3));
  });

  it('polls on the interval as a backstop', async () => {
    vi.useFakeTimers();
    try {
      setActiveAdultContent(false, { proven: true });
      mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: false }));
      render(<AdultContentWatcher />);
      const onMount = mocks.getDocFromServer.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(ADULT_CONTENT_POLL_MS + 1));
      expect(mocks.getDocFromServer.mock.calls.length).toBeGreaterThan(onMount);
    } finally {
      vi.useRealTimers();
    }
  });

  // Monotone: `true` from a live read is terminal, so the watcher tears its own
  // timer down rather than paying for a read per interval forever.
  it('stops polling once the posture has latched adult', async () => {
    vi.useFakeTimers();
    try {
      setActiveAdultContent(true, { proven: true });
      render(<AdultContentWatcher />);
      await act(async () => void vi.advanceTimersByTime(ADULT_CONTENT_POLL_MS * 3));
      expect(mocks.getDocFromServer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its timer and listeners on unmount', async () => {
    vi.useFakeTimers();
    try {
      setActiveAdultContent(false, { proven: true });
      mocks.getDocFromServer.mockResolvedValue(snap({ adultContent: false }));
      const { unmount } = render(<AdultContentWatcher />);
      unmount();
      const after = mocks.getDocFromServer.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(ADULT_CONTENT_POLL_MS * 2));
      act(() => void window.dispatchEvent(new Event('online')));
      expect(mocks.getDocFromServer.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
