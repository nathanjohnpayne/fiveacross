import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { FeedEntry } from '../hooks/useData';
import type { ProofDoc } from '../types';

// specs/feed-paging.md, component layer (RTL-jsdom). ProofFeed asks useFeed for
// a WINDOW (`pageCount * FEED_PAGE_SIZE`) and grows it (#441) — before this the
// Feed rendered a hard 60 and simply ended, stranding everything older. The
// mocked useFeed here is a real window over a fixture stream keyed on the `max`
// it is called with, so paging is observable end to end: click (or intersect)
// the sentinel, and the older entries appear.

const H = vi.hoisted(() => ({
  // The whole stream the mocked useFeed windows over.
  stream: [] as FeedEntry[],
  // Every `max` useFeed was called with, in order — the paging trace.
  maxCalls: [] as number[],
}));

vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'test-event', analytics: null }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'me' }, loading: false }) }));
vi.mock('../data/proofs', () => ({
  reportProof: vi.fn(() => Promise.resolve()),
  deleteProof: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useData', () => ({
  // The REAL windowing contract in miniature: at most `max` entries, plus
  // hasMore when the stream runs past the window (the `max + 1` probe).
  useFeed: (max = 60) => {
    H.maxCalls.push(max);
    return {
      entries: H.stream.slice(0, max),
      hasMore: H.stream.length > max,
      tallyCards: [],
      loading: false,
    };
  },
  useEventDoc: () => ({ data: { days: undefined, bannedUids: [], timezone: 'UTC' }, loading: false }),
  useMyDayBoards: () => new Map(),
  useAllDoubts: () => ({ doubts: [], loading: false, hasServerData: true }),
  useAllHearts: () => ({ hearts: [], loading: false, hasServerData: true }),
  useMyPlayer: () => ({ data: null, loading: false, hasServerData: true }),
}));

import ProofFeed, { FEED_PAGE_SIZE } from './ProofFeed';

const indexCss = readFileSync('src/index.css', 'utf8');

const proofEntry = (n: number): FeedEntry => ({
  feedKind: 'proof',
  createdAt: n,
  proof: {
    id: `p${n}`,
    uid: `u${n}`,
    displayName: `Player ${n}`,
    photoURL: null,
    type: 'text',
    cellIndex: 0,
    itemText: `prompt ${n}`,
    storagePath: null,
    mediaURL: null,
    thumbURL: null,
    text: `post ${n}`,
    createdAt: n,
    reportCount: 0,
    status: 'active',
    visionFlag: null,
  } as ProofDoc,
});

/** A newest-first stream of `count` proof entries — `post N` … `post 1`. */
const streamOf = (count: number): FeedEntry[] =>
  Array.from({ length: count }, (_, i) => proofEntry(count - i));

const moreButton = () => screen.queryByRole('button', { name: 'Load older posts' });
const renderedPosts = () => document.querySelectorAll('.proof').length;

beforeEach(() => {
  H.stream = [];
  H.maxCalls = [];
});

describe('ProofFeed paging — the Feed no longer just ends (#441)', () => {
  it('asks for ONE page on first paint, and page one is still 60 entries', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    expect(H.maxCalls[0]).toBe(FEED_PAGE_SIZE);
    expect(renderedPosts()).toBe(FEED_PAGE_SIZE);
    // The oldest entry is past the window — the regression this fixes.
    expect(screen.queryByText(/“post 1”/)).toBeNull();
  });

  it('offers a "Load older posts" control while entries remain past the window', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    expect(moreButton()).not.toBeNull();
    expect(document.querySelector('.feed-more')).not.toBeNull();
  });

  it('clicking it widens the window by a page and renders the older entries', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    fireEvent.click(moreButton()!);
    expect(H.maxCalls[H.maxCalls.length - 1]).toBe(FEED_PAGE_SIZE * 2);
    expect(renderedPosts()).toBe(FEED_PAGE_SIZE + 5);
    // The formerly stranded oldest post is now on screen…
    expect(screen.getByText(/“post 1”/)).toBeInTheDocument();
    // …and the newest is still at the top: paging APPENDS, never reorders.
    expect(document.querySelectorAll('.proof')[0]).toHaveTextContent(`post ${FEED_PAGE_SIZE + 5}`);
  });

  it('drops the control once the stream is exhausted', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    fireEvent.click(moreButton()!);
    expect(moreButton()).toBeNull();
  });

  it('shows no control at all when the whole stream already fits', () => {
    H.stream = streamOf(3);
    render(<ProofFeed />);
    expect(moreButton()).toBeNull();
    expect(document.querySelector('.feed-more')).toBeNull();
  });

  it('keeps the empty state (and no control) on an empty Feed', () => {
    render(<ProofFeed />);
    expect(screen.getByText(/Nothing in the feed yet/)).toBeInTheDocument();
    expect(moreButton()).toBeNull();
  });
});

describe('ProofFeed paging — the scroll trigger', () => {
  // jsdom has no IntersectionObserver; install a controllable stub so the
  // observe/disconnect contract and the auto-load path are both drivable.
  type Observed = { node: Element; fire: (isIntersecting: boolean) => void; disconnect: () => void };
  let observed: Observed[] = [];
  let disconnects = 0;
  let lastOptions: IntersectionObserverInit | undefined;

  beforeEach(() => {
    observed = [];
    disconnects = 0;
    lastOptions = undefined;
    class StubIO {
      constructor(
        private cb: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        lastOptions = options;
      }
      observe(node: Element) {
        observed.push({
          node,
          fire: (isIntersecting: boolean) =>
            this.cb(
              [{ isIntersecting, target: node } as unknown as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
          disconnect: () => this.disconnect(),
        });
      }
      disconnect() {
        disconnects += 1;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', StubIO);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes the sentinel and loads the next page when it scrolls into view — no click', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    expect(observed).toHaveLength(1);
    expect(observed[0].node).toBe(document.querySelector('.feed-more'));
    // Pre-loads ahead of the fold rather than exactly at it.
    expect(lastOptions?.rootMargin).toBe('400px 0px');

    act(() => observed[0].fire(true));
    expect(H.maxCalls[H.maxCalls.length - 1]).toBe(FEED_PAGE_SIZE * 2);
    expect(screen.getByText(/“post 1”/)).toBeInTheDocument();
  });

  it('a non-intersecting record (the sentinel scrolling back out) loads nothing', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    render(<ProofFeed />);
    const before = H.maxCalls.length;
    act(() => observed[0].fire(false));
    expect(H.maxCalls.length).toBe(before);
    expect(renderedPosts()).toBe(FEED_PAGE_SIZE);
  });

  it('creates ONE observer per sentinel, not one per render — a re-created observer would run away', () => {
    // Every render re-firing `isIntersecting` would page through the whole
    // stream in a burst, which is exactly what the stable callback ref buys.
    H.stream = streamOf(FEED_PAGE_SIZE * 3);
    const { rerender } = render(<ProofFeed />);
    rerender(<ProofFeed />);
    rerender(<ProofFeed />);
    expect(observed).toHaveLength(1);
    expect(renderedPosts()).toBe(FEED_PAGE_SIZE);
  });

  it('disconnects the observer when the sentinel goes away', () => {
    H.stream = streamOf(FEED_PAGE_SIZE + 5);
    const { unmount } = render(<ProofFeed />);
    expect(disconnects).toBe(0);
    unmount();
    expect(disconnects).toBeGreaterThan(0);
  });
});

describe('specs/feed-paging.md — the CSS pin', () => {
  it('index.css styles the paging footer', () => {
    expect(indexCss).toContain('.feed-more {');
    expect(indexCss).toContain('.feed-more-btn {');
  });
});
