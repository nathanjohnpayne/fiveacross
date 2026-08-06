import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers the Firestore seam for hostname resolution (#543, ADR 0009). The pure
// decision table is tested in `src/eventResolution.test.ts`; what is left here
// is the part that talks to Firestore, and one property of it in particular:
// the read must reach the SERVER.

const mocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  getDocFromServer: vi.fn(),
  applyResolvedEventId: vi.fn(),
  setCardCacheEventId: vi.fn(),
  applyResolvedCanonicalHost: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: mocks.getDoc,
  getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('../firebase', () => ({ db: {}, applyResolvedEventId: mocks.applyResolvedEventId }));
vi.mock('./cardCache', () => ({ setCardCacheEventId: mocks.setCardCacheEventId }));
vi.mock('../canonicalHost', () => ({ applyResolvedCanonicalHost: mocks.applyResolvedCanonicalHost }));

import { fetchHostnameDoc, bootstrapEventResolution } from './hostnames';
import { activeEdition, setActiveEdition, DEFAULT_EDITION } from '../editions';
import { adultContentRequired, resetAdultContentForTests, setActiveAdultContent } from '../adultContent';

const snap = (data: unknown) => ({ exists: () => data != null, data: () => data });

const DOC = {
  eventId: 'bodega-bay-2026',
  canonicalHost: 'bodega-bay.vacaybingo.com',
  edition: 'vacay',
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
  setActiveEdition(DEFAULT_EDITION);
  // resetAdultContentForTests, not setActiveAdultContent(true): a live read
  // that returned `true` LATCHES the session (the monotone mirror), so
  // re-installing would not clear it and every later case would inherit the
  // gate from whichever test ran first.
  resetAdultContentForTests();
});

describe('fetchHostnameDoc — the read must reach the server', () => {
  it('uses getDocFromServer, NEVER the cache-capable getDoc', async () => {
    // The regression (Codex on #576): a plain `getDoc` may answer from
    // Firestore's own cache, so an offline client would read a stale mapping,
    // `resolveEvent` would take it as a successful revalidation, and the entry
    // would be restamped for another full TTL. A bound that renews itself on
    // every offline boot is not a bound.
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    await fetchHostnameDoc('bodega-bay.vacaybingo.com');
    expect(mocks.getDocFromServer).toHaveBeenCalledTimes(1);
    expect(mocks.getDoc).not.toHaveBeenCalled();
  });

  it('lowercases the hostname into the document path', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    await fetchHostnameDoc('Bodega-Bay.VacayBingo.com');
    expect(mocks.getDocFromServer.mock.calls[0][0]).toMatchObject({
      path: 'hostnames/bodega-bay.vacaybingo.com',
    });
  });

  it('reads a missing doc, a missing eventId and an unknown status all as null', async () => {
    for (const data of [null, { ...DOC, eventId: '' }, { ...DOC, status: 'weird' }, { ...DOC, status: undefined }]) {
      mocks.getDocFromServer.mockResolvedValue(snap(data));
      expect(await fetchHostnameDoc('h')).toBeNull();
    }
  });

  it('lets a server failure THROW, so the resolver can serve its stale entry', async () => {
    // Swallowing this into `null` would be wrong: null means "no mapping here"
    // and drops the cache, which is the opposite of what offline should do.
    mocks.getDocFromServer.mockRejectedValue(new Error('unavailable'));
    await expect(fetchHostnameDoc('h')).rejects.toThrow();
  });
});

describe('bootstrapEventResolution — installs everything the shell needs', () => {
  it('installs the Event id, the card-cache id AND the Edition', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    const r = await bootstrapEventResolution('bodega-bay.vacaybingo.com');
    expect(r).toMatchObject({ kind: 'event', eventId: 'bodega-bay-2026' });
    expect(mocks.applyResolvedEventId).toHaveBeenCalledWith('bodega-bay-2026');
    expect(mocks.setCardCacheEventId).toHaveBeenCalledWith('bodega-bay-2026');
    // Without this the sign-in gate renders the other Edition's wordmark.
    expect(activeEdition()).toBe('vacay');
    // …and the browser chrome around it (#586). A hostname-resolved build has
    // no single Edition to bake into index.html, so the tab keeps whatever the
    // bundle shipped with until this runs.
    expect(document.title).toBe('Vacay Bingo');
    // #556: analytics and share metadata must report THIS host, never a
    // raw window.location that could reflect a validated Alias.
    expect(mocks.applyResolvedCanonicalHost).toHaveBeenCalledWith('bodega-bay.vacaybingo.com');
  });

  // #608. The 18+ posture rides the SAME pre-auth read as the Edition, for the
  // same reason: the gate that must reflect it renders before there is a
  // signed-in user to read `events/{eventId}/items` with.
  it('installs the 18+ posture from the routing document', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap({ ...DOC, adultContent: false }));
    await bootstrapEventResolution('bodega-bay.vacaybingo.com');
    expect(adultContentRequired()).toBe(false);
  });

  it('gates the Event when the routing document predates the field', async () => {
    // Every hostname document written before #608 has no `adultContent`, and
    // must keep exactly today's gate rather than silently losing it. That is
    // what makes this ship with no backfill.
    setActiveAdultContent(false);
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    await bootstrapEventResolution('bodega-bay.vacaybingo.com');
    expect(adultContentRequired()).toBe(true);
  });

  it('gates the Event on a malformed value, rather than trusting it', async () => {
    for (const bad of ['false', 0, null, {}]) {
      setActiveAdultContent(false);
      mocks.getDocFromServer.mockResolvedValue(snap({ ...DOC, adultContent: bad }));
      await bootstrapEventResolution('bodega-bay.vacaybingo.com');
      expect(adultContentRequired(), String(bad)).toBe(true);
    }
  });

  it('installs nothing when the hostname resolves to no Event', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap(null));
    const r = await bootstrapEventResolution('nope.example.com');
    expect(r.kind).toBe('not-found');
    expect(mocks.applyResolvedEventId).not.toHaveBeenCalled();
    expect(activeEdition()).toBe(DEFAULT_EDITION);
    expect(mocks.applyResolvedCanonicalHost).not.toHaveBeenCalled();
  });

  it('resolves when localStorage is unavailable — private mode, embedded webviews', async () => {
    // FORCES the condition rather than asserting the ambient one. An earlier
    // version asserted `typeof localStorage === 'undefined'`, which happens to
    // hold here (this repo's jsdom project configures no `url`, so jsdom leaves
    // localStorage unset) but is a property of the test config, not of the code
    // under test — add a jsdom `url` and it breaks for an unrelated reason,
    // testing nothing (Codex on #576). Deleting it makes the branch run
    // deterministically whatever the environment does.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    try {
      mocks.getDocFromServer.mockResolvedValue(snap(DOC));
      await expect(bootstrapEventResolution('bodega-bay.vacaybingo.com')).resolves.toMatchObject({
        kind: 'event',
        source: 'network',
      });
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('keeps the VITE_EDITION seed on the env short-circuit (edition: null)', async () => {
    // A single-Event Vacay build (`VITE_EVENT_ID` + `VITE_EDITION=vacay`) never
    // reads a hostname document, so its resolution carries `edition: null` and
    // the seed editions.ts made from the env must survive (Codex on #576).
    vi.stubEnv('VITE_EVENT_ID', 'med-2026');
    try {
      setActiveEdition('vacay');
      const r = await bootstrapEventResolution('bodega-bay.vacaybingo.com');
      expect(r).toMatchObject({ kind: 'event', source: 'env' });
      expect(mocks.getDocFromServer).not.toHaveBeenCalled();
      expect(activeEdition()).toBe('vacay');
      // No hostname document was read, so there is no separate canonical
      // host to install — the analytics consumers' own window.location
      // fallback already IS canonical for a single-Event build (#556;
      // share links carry the entry origin regardless, #607).
      expect(mocks.applyResolvedCanonicalHost).toHaveBeenCalledWith(null);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resets a blank lookup Edition to the default — the lookup owns the brand', async () => {
    // The other absence: the lookup RAN and the routing doc names no edition
    // (coerced to ''). A stray VITE_EDITION baked into a hostname-resolved
    // build must not outrank the mapping, so `setActiveEdition('')` falls back
    // to the default Edition (Codex P3 round 6 on #576).
    setActiveEdition('vacay');
    mocks.getDocFromServer.mockResolvedValue(snap({ ...DOC, edition: '' }));
    await bootstrapEventResolution('bodega-bay.vacaybingo.com');
    expect(activeEdition()).toBe(DEFAULT_EDITION);
  });
});
