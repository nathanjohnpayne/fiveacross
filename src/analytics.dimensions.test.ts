import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers specs/posthog-analytics.md § Dimensions (#556, part of #532): the
// brand/edition/Event/Slug/Day dimensions registered ONCE rather than
// threaded through every `track()` call site.

const { setDefaultEventParameters, phRegister, logEvent } = vi.hoisted(() => ({
  setDefaultEventParameters: vi.fn(),
  phRegister: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('./firebase', () => ({ analytics: null, analyticsReady: Promise.resolve(null) }));
vi.mock('firebase/analytics', () => ({ logEvent, setDefaultEventParameters }));
vi.mock('./posthog', () => ({ phCapture: vi.fn(), phRegister }));
vi.mock('./editions', () => ({ activeEdition: () => 'gcb' }));

// `registerAnalyticsDimensions`/`registerDayIndexDimension` accumulate a
// module-level `ga4Dims` merge (Codex P2 on #556), so every test needs a
// FRESH module instance — otherwise one test's registration would leak into
// the next via that shared state, same discipline `posthog-analytics.test.ts`
// already uses for its own module state.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('BRAND_ID (#556)', () => {
  it('is the single Five Across Brand identity (CONTEXT.md § Brand)', async () => {
    const { BRAND_ID } = await import('./analytics');
    expect(BRAND_ID).toBe('five-across');
  });
});

describe('registerAnalyticsDimensions (#556)', () => {
  it('registers brand_id/edition_id/event_id/event_slug on BOTH sinks', async () => {
    const { registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: 'bodega-bay-2026', eventSlug: 'bodega-bay' });
    const expected = {
      brand_id: 'five-across',
      edition_id: 'gcb',
      event_id: 'bodega-bay-2026',
      event_slug: 'bodega-bay',
    };
    expect(setDefaultEventParameters).toHaveBeenCalledWith(expected);
    expect(phRegister).toHaveBeenCalledWith(expected);
  });

  it('falls back event_slug to the Event id when the Slug is unknown', async () => {
    // A single-Event build's Resolution never reads a hostnames/{host}
    // document, so it has no separate Slug — see Resolution.slug's own doc.
    const { registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null });
    expect(phRegister).toHaveBeenCalledWith(expect.objectContaining({ event_slug: 'med-2026' }));
  });

  it('still reaches PostHog even if GA4s setDefaultEventParameters throws', async () => {
    const { registerAnalyticsDimensions } = await import('./analytics');
    setDefaultEventParameters.mockImplementationOnce(() => {
      throw new Error('ga4 unavailable');
    });
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null });
    expect(phRegister).toHaveBeenCalled();
  });

  it('does NOT register page_location as a static default (Phase 4b P1 on PR #584)', async () => {
    // A BrowserRouter route change would leave a STATIC page_location frozen
    // at the boot pathname forever — track()'s currentPageLocation() covers
    // this instead (see the describe block below).
    const { registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: 'bodega-bay-2026', eventSlug: 'bodega-bay' });
    expect(setDefaultEventParameters).toHaveBeenCalledWith(
      expect.not.objectContaining({ page_location: expect.anything() }),
    );
    expect(phRegister).toHaveBeenCalledWith(expect.not.objectContaining({ page_location: expect.anything() }));
  });
});

describe('registerDayIndexDimension (#556)', () => {
  it('registers day_index on both sinks when the Day is known', async () => {
    const { registerDayIndexDimension } = await import('./analytics');
    registerDayIndexDimension(3);
    expect(setDefaultEventParameters).toHaveBeenCalledWith({ day_index: 3 });
    expect(phRegister).toHaveBeenCalledWith({ day_index: 3 });
  });

  it('is a no-op when the Day is not yet known (null) — never guesses', async () => {
    const { registerDayIndexDimension } = await import('./analytics');
    registerDayIndexDimension(null);
    expect(setDefaultEventParameters).not.toHaveBeenCalled();
    expect(phRegister).not.toHaveBeenCalled();
  });

  it('registers Day 0 (falsy but valid) — not treated as "unknown"', async () => {
    const { registerDayIndexDimension } = await import('./analytics');
    registerDayIndexDimension(0);
    expect(setDefaultEventParameters).toHaveBeenCalledWith({ day_index: 0 });
    expect(phRegister).toHaveBeenCalledWith({ day_index: 0 });
  });

  it('MERGES with, rather than replaces, the GA4 defaults already registered (Codex P2 on #556)', async () => {
    // The bug this guards: Firebase Analytics keeps exactly one pending
    // pre-init `defaultEventParametersForInit` slot, so calling
    // `setDefaultEventParameters` a second time before GA4 finishes loading
    // used to silently drop brand/edition/Event — the first GA4 events after
    // init would carry `day_index` alone.
    const { registerAnalyticsDimensions, registerDayIndexDimension } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: 'bodega-bay-2026', eventSlug: 'bodega-bay' });
    registerDayIndexDimension(2);
    expect(setDefaultEventParameters).toHaveBeenLastCalledWith({
      brand_id: 'five-across',
      edition_id: 'gcb',
      event_id: 'bodega-bay-2026',
      event_slug: 'bodega-bay',
      day_index: 2,
    });
    // PostHog's own `register()` already merges server-side, so phRegister
    // only needs to forward the INCREMENTAL props for this call.
    expect(phRegister).toHaveBeenLastCalledWith({ day_index: 2 });
  });
});

describe('track() — page_location computed fresh at DISPATCH time (Phase 4b P1 on PR #584)', () => {
  // This suite needs `analytics` truthy (the GA4 gate in track()) and
  // control over the resolved canonical host, so it re-mocks both modules
  // locally rather than using the file-level `vi.mock` above (which pins
  // `analytics: null` for the rest of this file's tests).
  afterEach(() => {
    vi.doUnmock('./firebase');
    vi.doUnmock('./canonicalHost');
    window.history.replaceState({}, '', '/');
  });

  it('does not add page_location when no canonical host is resolved (single-Event build)', async () => {
    vi.doMock('./firebase', () => ({ analytics: {} }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    const { track } = await import('./analytics');
    track('login', { method: 'google' });
    expect(logEvent).toHaveBeenCalledWith({}, 'login', { method: 'google' });
  });

  it('adds a canonicalized page_location matching the CURRENT pathname when a canonical host is resolved', async () => {
    vi.doMock('./firebase', () => ({ analytics: {} }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.vacaybingo.com' }));
    window.history.replaceState({}, '', '/leaderboard');
    const { track } = await import('./analytics');
    track('share_click', { surface: 'leaderboard' });
    expect(logEvent).toHaveBeenCalledWith({}, 'share_click', {
      surface: 'leaderboard',
      page_location: 'https://bodega-bay.vacaybingo.com/leaderboard',
    });
  });

  it('reflects a BrowserRouter navigation on the VERY NEXT call — never freezes at the boot route', async () => {
    // The regression this guards: an earlier version registered
    // page_location ONCE (at dimension-registration time) as a static GA4
    // default, so every event tracked after a client-side route change kept
    // reporting the BOOT pathname.
    vi.doMock('./firebase', () => ({ analytics: {} }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.vacaybingo.com' }));
    const { track } = await import('./analytics');

    window.history.replaceState({}, '', '/feed');
    track('join_event');
    expect(logEvent).toHaveBeenLastCalledWith({}, 'join_event', {
      page_location: 'https://bodega-bay.vacaybingo.com/feed',
    });

    // A BrowserRouter push — no reload, no re-registration.
    window.history.pushState({}, '', '/leaderboard');
    track('share_click', { surface: 'leaderboard' });
    expect(logEvent).toHaveBeenLastCalledWith({}, 'share_click', {
      surface: 'leaderboard',
      page_location: 'https://bodega-bay.vacaybingo.com/leaderboard',
    });
  });
});

describe('emitInitialPageView (#611, retro Phase 4b P1 — replaces the automatic GA4 page_view firebase.ts now disables)', () => {
  afterEach(() => {
    vi.doUnmock('./firebase');
    vi.doUnmock('./canonicalHost');
    window.history.replaceState({}, '', '/');
  });

  it('does nothing when analyticsReady resolves to null (unsupported, no measurement id, or the synthetic probe)', async () => {
    vi.doMock('./firebase', () => ({ analytics: null, analyticsReady: Promise.resolve(null) }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    const { emitInitialPageView } = await import('./analytics');
    await emitInitialPageView();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('fires exactly ONE explicit page_view once analytics becomes ready, with no canonical host to override', async () => {
    vi.doMock('./firebase', () => ({ analytics: {}, analyticsReady: Promise.resolve({}) }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    const { emitInitialPageView } = await import('./analytics');
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', undefined);
  });

  it('fires the page_view with the canonicalized CURRENT page_location when a canonical host is resolved', async () => {
    window.history.replaceState({}, '', '/leaderboard');
    vi.doMock('./firebase', () => ({ analytics: {}, analyticsReady: Promise.resolve({}) }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.vacaybingo.com' }));
    const { emitInitialPageView } = await import('./analytics');
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: 'https://bodega-bay.vacaybingo.com/leaderboard',
    });
  });

  it('never throws into product code even if logEvent itself throws', async () => {
    vi.doMock('./firebase', () => ({ analytics: {}, analyticsReady: Promise.resolve({}) }));
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    logEvent.mockImplementationOnce(() => {
      throw new Error('ga4 unavailable');
    });
    const { emitInitialPageView } = await import('./analytics');
    await expect(emitInitialPageView()).resolves.toBeUndefined();
  });
});
