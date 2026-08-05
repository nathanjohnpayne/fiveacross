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

import { BRAND_ID, registerAnalyticsDimensions, registerDayIndexDimension } from './analytics';

beforeEach(() => vi.clearAllMocks());

describe('BRAND_ID (#556)', () => {
  it('is the single Five Across Brand identity (CONTEXT.md § Brand)', () => {
    expect(BRAND_ID).toBe('five-across');
  });
});

describe('registerAnalyticsDimensions (#556)', () => {
  it('registers brand_id/edition_id/event_id/event_slug on BOTH sinks', () => {
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

  it('falls back event_slug to the Event id when the Slug is unknown', () => {
    // A single-Event build's Resolution never reads a hostnames/{host}
    // document, so it has no separate Slug — see Resolution.slug's own doc.
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null });
    expect(phRegister).toHaveBeenCalledWith(expect.objectContaining({ event_slug: 'med-2026' }));
  });

  it('still reaches PostHog even if GA4s setDefaultEventParameters throws', () => {
    setDefaultEventParameters.mockImplementationOnce(() => {
      throw new Error('ga4 unavailable');
    });
    registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null });
    expect(phRegister).toHaveBeenCalled();
  });
});

describe('registerDayIndexDimension (#556)', () => {
  it('registers day_index on both sinks when the Day is known', () => {
    registerDayIndexDimension(3);
    expect(setDefaultEventParameters).toHaveBeenCalledWith({ day_index: 3 });
    expect(phRegister).toHaveBeenCalledWith({ day_index: 3 });
  });

  it('is a no-op when the Day is not yet known (null) — never guesses', () => {
    registerDayIndexDimension(null);
    expect(setDefaultEventParameters).not.toHaveBeenCalled();
    expect(phRegister).not.toHaveBeenCalled();
  });

  it('registers Day 0 (falsy but valid) — not treated as "unknown"', () => {
    registerDayIndexDimension(0);
    expect(setDefaultEventParameters).toHaveBeenCalledWith({ day_index: 0 });
    expect(phRegister).toHaveBeenCalledWith({ day_index: 0 });
  });
});
