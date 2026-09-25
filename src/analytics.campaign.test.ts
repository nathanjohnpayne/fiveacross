import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers specs/posthog-analytics.md § Campaign attribution (#632): the GA4 side
// of email campaign attribution. GA4 attributes a session from the campaign
// parameters on its FIRST hit's page_location, and #613 made every
// page_location explicit and path-only, so without this carry an email click
// (`/feed?utm_source=daily-email&...`) would always report as direct traffic.
// Only a utm_* set this Event's own emails could have produced rides along,
// and only on the one initial page_view; every other key (invite codes, auth
// params) and every foreign or free-text value stays stripped.

const { setDefaultEventParameters, logEvent } = vi.hoisted(() => ({
  setDefaultEventParameters: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('firebase/analytics', () => ({ logEvent, setDefaultEventParameters }));
vi.mock('./posthog', () => ({ phCapture: vi.fn(), phRegister: vi.fn() }));
vi.mock('./editions', () => ({ activeEdition: () => 'vacay' }));

const EMAIL_LANDING =
  '/feed?invite=SECRET&utm_campaign=bodega-bay-2026-day-3&utm_medium=email&utm_source=daily-email&code=abc#frag';
const TAGS = 'utm_source=daily-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-3';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('./firebase', () => ({ analytics: {}, analyticsReady: Promise.resolve({}) }));
});

afterEach(() => {
  vi.doUnmock('./firebase');
  vi.doUnmock('./canonicalHost');
  window.history.replaceState({}, '', '/');
});

const EVENT_ID = 'bodega-bay-2026';

describe('campaignQuery (#632)', () => {
  it('keeps only the email utm_* set, in a fixed order, and drops everything else', async () => {
    const { campaignQuery } = await import('./analytics');
    expect(
      campaignQuery(
        '?invite=SECRET&utm_campaign=bodega-bay-2026-day-3&utm_term=t&utm_medium=email&utm_source=daily-email&utm_content=x&code=1',
        EVENT_ID,
      ),
    ).toBe(`?${TAGS}`);
    expect(campaignQuery('?utm_source=podium-email&utm_medium=email&utm_campaign=bodega-bay-2026-podium', EVENT_ID)).toBe(
      '?utm_source=podium-email&utm_medium=email&utm_campaign=bodega-bay-2026-podium',
    );
    expect(campaignQuery('?utm_source=daily-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-0', EVENT_ID)).toBe(
      '?utm_source=daily-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-0',
    );
  });

  it('returns an empty string when no campaign key is present, a value is blank, or no Event id resolved', async () => {
    const { campaignQuery } = await import('./analytics');
    expect(campaignQuery('', EVENT_ID)).toBe('');
    expect(campaignQuery('?invite=SECRET', EVENT_ID)).toBe('');
    expect(campaignQuery('?utm_source=&utm_medium=', EVENT_ID)).toBe('');
    expect(campaignQuery('?utm_source=daily-email&utm_medium=email&utm_campaign=', EVENT_ID)).toBe('');
    expect(campaignQuery(`?${TAGS}`, null)).toBe('');
    expect(campaignQuery(`?${TAGS}`, '')).toBe('');
  });

  it('drops the whole set unless it is exactly what this Event’s emails produce (no free text or PII reaches GA4)', async () => {
    const { campaignQuery } = await import('./analytics');
    const base = { utm_source: 'daily-email', utm_medium: 'email', utm_campaign: 'bodega-bay-2026-day-3' };
    const withValue = (key: string, value: string) =>
      `?${new URLSearchParams({ ...base, [key]: value }).toString()}`;
    expect(campaignQuery(withValue('utm_campaign', 'alice@example.com'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-3 alice'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-alice'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-1234'), EVENT_ID)).toBe('');
    // Outside the supported Day range (0–9, `supportedDayIndex`) or not canonical decimal.
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-10'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-999'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-03'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-day-9'), EVENT_ID)).toBe(
      '?utm_source=daily-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-9',
    );
    // Identifier-shaped free text that is not THIS Event's id.
    expect(
      campaignQuery('?utm_source=podium-email&utm_medium=email&utm_campaign=alice-smith-podium', EVENT_ID),
    ).toBe('');
    expect(campaignQuery(withValue('utm_campaign', 'med-2026-day-3'), EVENT_ID)).toBe('');
    // Mismatched source/suffix pairs.
    expect(campaignQuery(withValue('utm_campaign', 'bodega-bay-2026-podium'), EVENT_ID)).toBe('');
    expect(
      campaignQuery('?utm_source=podium-email&utm_medium=email&utm_campaign=bodega-bay-2026-day-3', EVENT_ID),
    ).toBe('');
    expect(campaignQuery(withValue('utm_source', 'newsletter'), EVENT_ID)).toBe('');
    expect(campaignQuery(withValue('utm_medium', 'social'), EVENT_ID)).toBe('');
    expect(campaignQuery('?utm_source=daily-email&utm_medium=email', EVENT_ID)).toBe('');
  });

  it('never lets a campaign value smuggle another parameter in', async () => {
    const { campaignQuery } = await import('./analytics');
    expect(
      campaignQuery(
        '?utm_source=podium-email&utm_medium=email&utm_campaign=bodega-bay-2026-podium%26invite%3DSECRET',
        EVENT_ID,
      ),
    ).toBe('');
  });
});

describe('emitInitialPageView carries the landing campaign (#632)', () => {
  it('adds the landing URL utm_* set to the initial page_view, and nothing else from the query', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.fiveacross.app' }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const { emitInitialPageView, registerAnalyticsDimensions } = await import('./analytics');
    registerAnalyticsDimensions({ eventId: EVENT_ID, eventSlug: 'bodega-bay' });
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: `https://bodega-bay.fiveacross.app/feed?${TAGS}`,
    });
  });

  it('reads the campaign at LOAD, so a route change before the page_view does not lose it', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const { emitInitialPageView, registerAnalyticsDimensions } = await import('./analytics');
    // e.g. the Router normalizing the path while Event resolution was in flight
    window.history.replaceState({}, '', '/');
    registerAnalyticsDimensions({ eventId: EVENT_ID, eventSlug: null });
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: `${window.location.origin}/?${TAGS}`,
    });
  });

  it('stays path-only when the campaign names another Event, or no Event id was registered', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const first = await import('./analytics');
    first.registerAnalyticsDimensions({ eventId: 'med-2026', eventSlug: null });
    await first.emitInitialPageView();
    expect(logEvent).toHaveBeenLastCalledWith({}, 'page_view', {
      page_location: `${window.location.origin}/feed`,
    });

    vi.resetModules();
    const second = await import('./analytics');
    await second.emitInitialPageView();
    expect(logEvent).toHaveBeenLastCalledWith({}, 'page_view', {
      page_location: `${window.location.origin}/feed`,
    });
  });

  it('stays path-only when the landing URL carries no campaign', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    window.history.replaceState({}, '', '/enter?code=SECRET');
    const { emitInitialPageView } = await import('./analytics');
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: `${window.location.origin}/enter`,
    });
  });

  it('never adds the campaign to track() events — they keep the path-only page_location', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.fiveacross.app' }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const { track } = await import('./analytics');
    track('share_click', { surface: 'farewell' });
    expect(logEvent).toHaveBeenCalledWith({}, 'share_click', {
      surface: 'farewell',
      page_location: 'https://bodega-bay.fiveacross.app/feed',
    });
  });
});
