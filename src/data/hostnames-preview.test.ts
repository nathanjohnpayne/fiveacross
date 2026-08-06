import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Covers the sign-in postcard's LIVE preview channel (#647 follow-up — the
// production defect): the deployed Bodega build is ENV-PINNED, so
// `resolveEvent`'s env short-circuit reads no `hostnames/{host}` document and
// `resolution.preview` never exists there — the card silently failed to render
// in production with a valid slice seeded. The fix rides the one listener that
// already streams that document on every build shape (`watchAdultContent`):
// its snapshots install the coerced slice into the reactive store, and a
// proven servable mapping is cached whole so the NEXT boot paints the card at
// bootstrap. These tests drive that seam by hand, harness per
// adult-content-revalidation.test.tsx.

const mocks = vi.hoisted(() => ({ onSnapshot: vi.fn(), getDocFromServer: vi.fn() }));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: vi.fn(),
  getDocFromServer: mocks.getDocFromServer,
  onSnapshot: mocks.onSnapshot,
}));
vi.mock('../firebase', () => ({ db: {}, applyResolvedEventId: vi.fn() }));
vi.mock('./cardCache', () => ({ setCardCacheEventId: vi.fn() }));
vi.mock('../canonicalHost', () => ({ applyResolvedCanonicalHost: vi.fn() }));

import { bootstrapEventResolution, watchAdultContent } from './hostnames';
import { cacheKey, readCache } from '../eventResolution';
import {
  activeEventPreview,
  applyResolvedEventPreview,
  type EventPreview,
} from '../eventPreview';
import { resetAdultContentForTests } from '../adultContent';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';

const HOST = 'bodega-bay.vacaybingo.com';

const PREVIEW: EventPreview = {
  eventName: 'Weekend in Bodega Bay',
  dateRange: 'Aug 7–9',
  hostedBy: 'Kim',
  days: [{ date: '2999-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' }],
};

const DOC = {
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'vacay',
  status: 'active',
  adultContent: false,
  slug: 'bodega-bay',
  preview: PREVIEW,
};

const snap = (data: unknown, fromCache = false) => ({
  exists: () => data != null,
  data: () => data,
  metadata: { fromCache },
});

// This jsdom variant ships no `localStorage` global (src/test/setup.ts guards
// for exactly that), and the seam under test reads it through
// `safeLocalStorage()` — so install a Map-backed stand-in for the file and
// restore whatever was there afterwards, the same descriptor dance
// hostnames.test.ts uses for its unavailable-storage case.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** Drive the most recently opened listener's callbacks by hand. */
function listener() {
  const call = mocks.onSnapshot.mock.calls[mocks.onSnapshot.mock.calls.length - 1];
  return { next: call[1] as (s: unknown) => void, onError: call[2] as (e: unknown) => void };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.onSnapshot.mockReturnValue(vi.fn());
  resetAdultContentForTests();
  applyResolvedEventPreview(null);
  setActiveEdition(DEFAULT_EDITION);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  applyResolvedEventPreview(null);
  resetAdultContentForTests();
  localStorage.clear();
});

describe('watchAdultContent — the live preview channel (the env-pinned production case)', () => {
  it('installs the slice when the shared snapshot delivers it', () => {
    watchAdultContent(HOST);
    expect(activeEventPreview()).toBeNull();
    listener().next(snap(DOC));
    expect(activeEventPreview()).toEqual(PREVIEW);
  });

  it('supplies a card from a CACHED snapshot — stale display copy beats none', () => {
    watchAdultContent(HOST);
    listener().next(snap(DOC, true));
    expect(activeEventPreview()).toEqual(PREVIEW);
  });

  it('never CLEARS an installed card on unproven evidence, only on proven', () => {
    applyResolvedEventPreview(PREVIEW);
    watchAdultContent(HOST);
    // An older cache-served copy without the slice is not evidence of removal…
    listener().next(snap({ ...DOC, preview: undefined }, true));
    expect(activeEventPreview()).toEqual(PREVIEW);
    // …and neither is a cache-served miss of the whole document…
    listener().next(snap(null, true));
    expect(activeEventPreview()).toEqual(PREVIEW);
    // …but a server-backed copy without the slice is.
    listener().next(snap({ ...DOC, preview: undefined }));
    expect(activeEventPreview()).toBeNull();
  });

  it('clears the card on a PROVEN missing document — localhost/dev stays cardless', () => {
    applyResolvedEventPreview(PREVIEW);
    watchAdultContent(HOST);
    listener().next(snap(null));
    expect(activeEventPreview()).toBeNull();
  });

  it('caches a proven servable mapping whole, and only then', () => {
    watchAdultContent(HOST);
    // Cache-served: supplies the card but must not stamp the envelope.
    listener().next(snap(DOC, true));
    expect(localStorage.getItem(cacheKey(HOST))).toBeNull();
    // Server-backed: cached, with the slice surviving the envelope read.
    listener().next(snap(DOC));
    expect(readCache(localStorage, HOST)?.doc.preview).toEqual(PREVIEW);
    // An inactive mapping is never resurrected into the cache.
    localStorage.clear();
    listener().next(snap({ ...DOC, status: 'archived' }));
    expect(localStorage.getItem(cacheKey(HOST))).toBeNull();
  });

  it('keeps the displayed card through a listener error', () => {
    applyResolvedEventPreview(PREVIEW);
    watchAdultContent(HOST);
    listener().onError(new Error('unavailable'));
    expect(activeEventPreview()).toEqual(PREVIEW);
  });
});

describe('bootstrapEventResolution — the env-pinned boot paths', () => {
  it('paints from the cached envelope at boot on an env-pinned build', async () => {
    // A previous visit's watcher cached the mapping (the test above); this
    // boot must draw the card immediately, without any network resolution.
    watchAdultContent(HOST);
    listener().next(snap(DOC));
    applyResolvedEventPreview(null); // fresh session, same localStorage
    vi.stubEnv('VITE_EVENT_ID', 'bodega-bay-2026');
    const r = await bootstrapEventResolution(HOST);
    expect(r).toMatchObject({ kind: 'event', source: 'env' });
    expect(mocks.getDocFromServer).not.toHaveBeenCalled();
    expect(activeEventPreview()).toEqual(PREVIEW);
  });

  it('boots cardless — no errors — on an env-pinned build with nothing cached', async () => {
    vi.stubEnv('VITE_EVENT_ID', 'bodega-bay-2026');
    const r = await bootstrapEventResolution('localhost');
    expect(r).toMatchObject({ kind: 'event', source: 'env' });
    expect(activeEventPreview()).toBeNull();
  });

  it('keeps the hostname-resolved path unchanged: the network doc installs the slice', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    const r = await bootstrapEventResolution(HOST);
    expect(r).toMatchObject({ kind: 'event', source: 'network' });
    expect(activeEventPreview()).toEqual(PREVIEW);
  });
});
