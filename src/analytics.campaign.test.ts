import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers specs/posthog-analytics.md § Campaign attribution (#632): the GA4 side
// of email campaign attribution. GA4 attributes a session from the campaign
// parameters on its FIRST hit's page_location, and #613 made every
// page_location explicit and path-only, so without this carry an email click
// (`/feed?utm_source=daily-email&...`) would always report as direct traffic.
// Only the allowlisted utm_* keys ride along, and only on the one initial
// page_view; every other key (invite codes, auth params) stays stripped.

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

describe('campaignQuery (#632)', () => {
  it('keeps only the allowlisted utm_* keys, in a fixed order, and drops everything else', async () => {
    const { campaignQuery } = await import('./analytics');
    expect(campaignQuery('?invite=SECRET&utm_campaign=c&utm_term=t&utm_medium=m&utm_source=s&utm_content=x&code=1')).toBe(
      '?utm_source=s&utm_medium=m&utm_campaign=c&utm_content=x&utm_term=t',
    );
  });

  it('returns an empty string when no campaign key is present or every value is blank', async () => {
    const { campaignQuery } = await import('./analytics');
    expect(campaignQuery('')).toBe('');
    expect(campaignQuery('?invite=SECRET')).toBe('');
    expect(campaignQuery('?utm_source=&utm_medium=')).toBe('');
  });

  it('never lets a campaign value smuggle another parameter in', async () => {
    const { campaignQuery } = await import('./analytics');
    const out = campaignQuery('?utm_source=a%26invite%3DSECRET');
    expect(new URLSearchParams(out).get('invite')).toBeNull();
    expect(new URLSearchParams(out).get('utm_source')).toBe('a&invite=SECRET');
  });
});

describe('emitInitialPageView carries the landing campaign (#632)', () => {
  it('adds the landing URL utm_* set to the initial page_view, and nothing else from the query', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => 'bodega-bay.fiveacross.app' }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const { emitInitialPageView } = await import('./analytics');
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: `https://bodega-bay.fiveacross.app/feed?${TAGS}`,
    });
  });

  it('reads the campaign at LOAD, so a route change before the page_view does not lose it', async () => {
    vi.doMock('./canonicalHost', () => ({ resolvedCanonicalHost: () => null }));
    window.history.replaceState({}, '', EMAIL_LANDING);
    const { emitInitialPageView } = await import('./analytics');
    // e.g. the Router normalizing the path while Event resolution was in flight
    window.history.replaceState({}, '', '/');
    await emitInitialPageView();
    expect(logEvent).toHaveBeenCalledWith({}, 'page_view', {
      page_location: `${window.location.origin}/?${TAGS}`,
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
