import { describe, it, expect, afterEach } from 'vitest';
import * as canonicalHost from './canonicalHost';
import { applyResolvedCanonicalHost, resolvedCanonicalHost, shareOrigin } from './canonicalHost';

// Covers specs/posthog-analytics.md § Canonical hostname — #556 as amended by
// #607: the resolved canonical hostname is the ANALYTICS dimension (one
// canonical host per Event, so cross-host traffic aggregates), while share
// links carry the ENTRY-POINT origin, so a recipient lands on the same
// branded host the sharer was standing on (#599 amended multi-domain policy).

describe('resolvedCanonicalHost (#556)', () => {
  afterEach(() => {
    // Module state — reset after every test so one test's resolved host
    // never leaks into the next (this file's own null-default case included).
    applyResolvedCanonicalHost(null);
  });

  it('is null before resolution has run', () => {
    expect(resolvedCanonicalHost()).toBeNull();
  });

  it('reports the resolved canonical hostname once installed', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    expect(resolvedCanonicalHost()).toBe('bodega-bay.vacaybingo.com');
  });

  it('is null again once the resolved host is cleared', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    applyResolvedCanonicalHost(null);
    expect(resolvedCanonicalHost()).toBeNull();
  });
});

describe('shareOrigin (#607)', () => {
  afterEach(() => {
    applyResolvedCanonicalHost(null);
  });

  it('is the entry-point origin before resolution has run', () => {
    expect(shareOrigin()).toBe(window.location.origin);
  });

  it('STAYS the entry-point origin when a canonical host is resolved — share links never rewrite to the analytics-canonical host', () => {
    applyResolvedCanonicalHost('bodega-bay.vacaybingo.com');
    expect(shareOrigin()).toBe(window.location.origin);
    expect(shareOrigin()).not.toBe('https://bodega-bay.vacaybingo.com');
  });

  it('keeps the #607-removed canonicalOrigin export removed', () => {
    // #607 split the share identity off the analytics-canonical host;
    // `canonicalOrigin()` was the rewrite primitive every share surface
    // consumed, and its return would put a share back under another
    // Edition's brand. If it comes back on purpose, delete this guard in
    // the same PR and say why — a revert-merge resurrecting it must be an
    // explicit, reviewed decision, not a silent regression.
    expect('canonicalOrigin' in canonicalHost).toBe(false);
  });
});
