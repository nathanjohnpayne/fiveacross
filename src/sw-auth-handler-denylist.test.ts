import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAppShellClientUrl } from './sw-rescue';

// Covers specs/sw-auth-handler-denylist.md: the navigation fallback must exclude
// Firebase Hosting's reserved /__/* namespace, or the service worker serves the
// SPA shell into the Google sign-in popup (/__/auth/handler) and sign-in
// dead-ends for every SW-controlled signed-out client (#182). jsdom cannot run a
// service worker and the built sw.js only exists post-build, so this guards the
// source directly — the same pattern src/data/w4-bug-report-client.test.ts uses
// for firebase.json's cache headers.
//
// #514 moved the routing from vite.config.ts (`workbox.navigateFallback*`, the
// generateSW config) into the hand-written worker at src/sw.ts, so that is the
// file under guard now. The assertions are deliberately stricter than the
// originals: hand-rolling the worker means this protection is now ordinary code
// that a refactor could quietly drop, rather than a config key.

describe('service worker navigation fallback', () => {
  const sw = readFileSync('src/sw.ts', 'utf8');

  it('registers a NavigationRoute bound to the app shell', () => {
    expect(sw).toMatch(/new NavigationRoute\(/);
    expect(sw).toMatch(/createHandlerBoundToURL\(\s*'index\.html'\s*\)/);
  });

  it("excludes Firebase's reserved /__/* namespace from the fallback", () => {
    // The exact canonical pattern: /^\/__\//
    expect(sw).toContain('denylist: [/^\\/__\\//]');
  });

  it('keeps the denylist attached to the navigation route, not merely present', () => {
    // A denylist declared somewhere else in the file would satisfy a naive
    // substring check while protecting nothing.
    const navRoute = sw.slice(sw.indexOf('new NavigationRoute('));
    const routeBody = navRoute.slice(0, navRoute.indexOf('registerRoute(', 1));
    expect(routeBody).toContain('denylist: [/^\\/__\\//]');
  });

  it('applies the SAME exclusion when the #516 rescue enumerates windows', () => {
    // Serving the app shell into the popup is not the only way to dead-end
    // sign-in: the rescue can `navigate()` that window out of the OAuth flow,
    // and it reads an unregistered window as a condemned one. Both halves have
    // to agree on what the reserved namespace is, so the pattern is pinned in
    // both places and the behaviour is pinned here.
    const rescue = readFileSync('src/sw-rescue.ts', 'utf8');
    expect(rescue).toContain('/^\\/__\\//');
    expect(isAppShellClientUrl('https://gaycruisebingo.com/__/auth/handler')).toBe(false);
    expect(isAppShellClientUrl('https://gaycruisebingo.com/board')).toBe(true);
  });

  it('no longer configures the fallback through vite.config.ts', () => {
    // Guards against a half-finished revert leaving BOTH sources in play, where
    // the config key silently wins and the worker's own route looks authoritative.
    const viteConfig = readFileSync('vite.config.ts', 'utf8');
    expect(viteConfig).not.toMatch(/navigateFallback:/);
    expect(viteConfig).toMatch(/strategies:\s*'injectManifest'/);
  });
});
