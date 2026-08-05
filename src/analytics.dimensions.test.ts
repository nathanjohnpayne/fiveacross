import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers specs/posthog-analytics.md § Dimensions (#556, part of #532): the
// brand/edition/Event/Slug/Day dimensions registered ONCE rather than
// threaded through every `track()` call site.

const { setDefaultEventParameters, phRegister } = vi.hoisted(() => ({
  setDefaultEventParameters: vi.fn(),
  phRegister: vi.fn(),
}));

vi.mock('./firebase', () => ({ analytics: null }));
vi.mock('firebase/analytics', () => ({ logEvent: vi.fn(), setDefaultEventParameters }));
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
    registerAnalyticsDimensions({ eventId: 'bodega-bay-2026', eventSlug: 'bodega-bay', canonicalHost: null });
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
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null, canonicalHost: null });
    expect(phRegister).toHaveBeenCalledWith(expect.objectContaining({ event_slug: 'med-2026' }));
  });

  it('still reaches PostHog even if GA4s setDefaultEventParameters throws', async () => {
    const { registerAnalyticsDimensions } = await import('./analytics');
    setDefaultEventParameters.mockImplementationOnce(() => {
      throw new Error('ga4 unavailable');
    });
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null, canonicalHost: null });
    expect(phRegister).toHaveBeenCalled();
  });

  it('does not override page_location when no canonical host is resolved (single-Event build)', async () => {
    const { registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null, canonicalHost: null });
    expect(setDefaultEventParameters).toHaveBeenCalledTimes(1);
    expect(setDefaultEventParameters).toHaveBeenLastCalledWith(expect.not.objectContaining({ page_location: expect.anything() }));
  });

  it('overrides GA4 page_location to the canonical origin when a canonical host is resolved (Codex round 2 on #556)', async () => {
    // GA4's automatic + explicit page_location otherwise mirrors
    // window.location.href, which could carry a validated Alias's hostname
    // before its edge redirect.
    const { registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({
      eventId: 'bodega-bay-2026',
      eventSlug: 'bodega-bay',
      canonicalHost: 'bodega-bay.vacaybingo.com',
    });
    expect(setDefaultEventParameters).toHaveBeenLastCalledWith({
      brand_id: 'five-across',
      edition_id: 'gcb',
      event_id: 'bodega-bay-2026',
      event_slug: 'bodega-bay',
      page_location: `https://bodega-bay.vacaybingo.com${window.location.pathname}`,
    });
    // GA4-only — PostHog's equivalent is fixed in posthog.ts's before_send
    // hook instead, so phRegister must NOT receive page_location.
    expect(phRegister).toHaveBeenCalledWith(
      expect.not.objectContaining({ page_location: expect.anything() }),
    );
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
    registerAnalyticsDimensions({ eventId: 'bodega-bay-2026', eventSlug: 'bodega-bay', canonicalHost: null });
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
