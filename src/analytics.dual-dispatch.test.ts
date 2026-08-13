import { describe, it, expect, vi, beforeEach } from 'vitest';

// GA4 present + mocked; PostHog dispatch mocked. Proves track() fans out to both.
vi.mock('./firebase', () => ({ analytics: {}, analyticsReady: Promise.resolve({}) }));
vi.mock('firebase/analytics', () => ({ logEvent: vi.fn() }));
vi.mock('./posthog', () => ({ phCapture: vi.fn() }));

import { track } from './analytics';
import { logEvent } from 'firebase/analytics';
import { phCapture } from './posthog';

describe('track() dual-dispatches to GA4 and PostHog (#96)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires the same event name + params to both sinks', () => {
    track('bingo', { lines: 2 });
    // GA4 additionally always carries an explicit scrubbed page_location
    // (#613, Phase 4b P1 — see currentPageLocation in analytics.ts); PostHog
    // gets its URL properties from its own autocapture + before_send layer.
    expect(logEvent).toHaveBeenCalledWith({}, 'bingo', {
      lines: 2,
      page_location: `${window.location.origin}${window.location.pathname}`,
    });
    expect(phCapture).toHaveBeenCalledWith('bingo', { lines: 2 });
  });

  it('still reaches PostHog even if the GA4 sink throws', () => {
    vi.mocked(logEvent).mockImplementationOnce(() => {
      throw new Error('ga4 unavailable');
    });
    track('login', { method: 'google' });
    expect(phCapture).toHaveBeenCalledWith('login', { method: 'google' });
  });
});
