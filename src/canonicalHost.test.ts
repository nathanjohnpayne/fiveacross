import { describe, it, expect, afterEach } from 'vitest';
import { applyResolvedCanonicalHost, canonicalOrigin } from './canonicalHost';

// Covers specs/posthog-analytics.md § Dimensions and share metadata (#556):
// analytics and share metadata must report the Event's canonical hostname,
// never a raw `window.location` that could reflect a validated Alias.

describe('canonicalOrigin (#556)', () => {
  afterEach(() => {
    // Module state — reset after every test so one test's resolved host
    // never leaks into the next (this file's own null-default case included).
    applyResolvedCanonicalHost(null);
  });

  it('falls back to window.location.origin before resolution has run', () => {
    expect(canonicalOrigin()).toBe(window.location.origin);
  });

  it('reports the resolved canonical hostname once installed', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    expect(canonicalOrigin()).toBe('https://bodega-bay.vacaybingo.com');
  });

  it('falls back again once the resolved host is cleared (null)', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    applyResolvedCanonicalHost(null);
    expect(canonicalOrigin()).toBe(window.location.origin);
  });
});
