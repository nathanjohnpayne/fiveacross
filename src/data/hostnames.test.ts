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
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: mocks.getDoc,
  getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('../firebase', () => ({ db: {}, applyResolvedEventId: mocks.applyResolvedEventId }));
vi.mock('./cardCache', () => ({ setCardCacheEventId: mocks.setCardCacheEventId }));

import { fetchHostnameDoc, bootstrapEventResolution } from './hostnames';
import { activeEdition, setActiveEdition, DEFAULT_EDITION } from '../editions';

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
  });

  it('installs nothing when the hostname resolves to no Event', async () => {
    mocks.getDocFromServer.mockResolvedValue(snap(null));
    const r = await bootstrapEventResolution('nope.example.com');
    expect(r.kind).toBe('not-found');
    expect(mocks.applyResolvedEventId).not.toHaveBeenCalled();
    expect(activeEdition()).toBe(DEFAULT_EDITION);
  });

  it('resolves in an environment with NO localStorage at all', async () => {
    // This suite runs in the node project, where `localStorage` is undefined —
    // which makes it the free test for `safeLocalStorage`'s real case (private
    // mode, embedded webviews). An unavailable cache must cost a round trip,
    // never a boot. The cache-write path itself is covered against an injected
    // fake in src/eventResolution.test.ts.
    expect(typeof localStorage).toBe('undefined');
    mocks.getDocFromServer.mockResolvedValue(snap(DOC));
    await expect(bootstrapEventResolution('bodega-bay.vacaybingo.com')).resolves.toMatchObject({
      kind: 'event',
      source: 'network',
    });
  });
});
