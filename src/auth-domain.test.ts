import { describe, expect, it } from 'vitest';
import { resolveAuthDomain, isAuthConfiguredForHost, isSignInReachableOnHost } from './auth-domain';

describe('resolveAuthDomain', () => {
  it.each(['gaycruisebingo.com', 'gaycruisebingo.vercel.app', 'gaycruisebingo.firebaseapp.com'])(
    'pins production host %s to its own first-party auth handler',
    (hostname) => {
      expect(resolveAuthDomain('misconfigured.example', hostname)).toBe(hostname);
    },
  );

  it('keeps the configured domain for web.app until sign-in hands the app to firebaseapp.com', () => {
    expect(resolveAuthDomain('gaycruisebingo.com', 'gaycruisebingo.web.app')).toBe('gaycruisebingo.com');
  });

  it('keeps the configured domain in local and preview environments', () => {
    expect(resolveAuthDomain('localhost', '127.0.0.1')).toBe('localhost');
  });

  it('pins the stable preview alias to its own handler so preview sign-in is same-origin (#453)', () => {
    const alias = 'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app';
    expect(resolveAuthDomain('gaycruisebingo.vercel.app', alias)).toBe(alias);
  });

  it.each([
    'gaycruisebingo-iy4xn21x8-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo-git-some-other-branch-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app.evil.example',
  ])('does not treat %s as first-party — the match is exact, never a pattern', (hostname) => {
    expect(resolveAuthDomain('gaycruisebingo.vercel.app', hostname)).toBe('gaycruisebingo.vercel.app');
  });
});

// #543 / ADR 0010: hostname resolution makes new origins mountable, so "the app
// runs here" stopped implying "sign-in works here".
describe('isAuthConfiguredForHost — can sign-in complete on this origin?', () => {
  const CONFIGURED = 'gaycruisebingo.com';

  it('is ready on a registered first-party host', () => {
    expect(isAuthConfiguredForHost(CONFIGURED, 'gaycruisebingo.com')).toBe(true);
    expect(isAuthConfiguredForHost(CONFIGURED, 'gaycruisebingo.vercel.app')).toBe(true);
  });

  it('is ready when the build pins authDomain to this very host', () => {
    // ADR 0010's same-origin escape hatch: an exact Firebase Hosting custom
    // domain. This is what a single-Edition Vacay build uses, so the check must
    // not dark it.
    expect(isAuthConfiguredForHost('bodega-bay.vacaybingo.com', 'bodega-bay.vacaybingo.com')).toBe(
      true,
    );
  });

  it('is NOT ready on an unconfigured wildcard host', () => {
    // The regression: a hostname-resolved Event mounting a Google button that
    // cannot return to this origin, on a host with no /__/auth/handler entry.
    expect(isAuthConfiguredForHost('fiveacross.firebaseapp.com', 'bodega-bay.vacaybingo.com')).toBe(
      false,
    );
    expect(isAuthConfiguredForHost(CONFIGURED, 'anything-else.example.com')).toBe(false);
  });

  it('agrees with resolveAuthDomain by construction', () => {
    for (const host of ['gaycruisebingo.com', 'x.vacaybingo.com', 'gaycruisebingo.web.app']) {
      expect(isAuthConfiguredForHost(CONFIGURED, host)).toBe(
        resolveAuthDomain(CONFIGURED, host) === host,
      );
    }
  });
});

// Codex P1, round 5 on #576: the pre-mount gate must not dark origins where
// sign-in COMPLETES via a documented path even though auth is not configured
// on the origin itself.
describe('isSignInReachableOnHost — may main.tsx mount the app here?', () => {
  const CONFIGURED = 'gaycruisebingo.com';

  it('is reachable everywhere isAuthConfiguredForHost already says so', () => {
    expect(isSignInReachableOnHost(CONFIGURED, 'gaycruisebingo.com')).toBe(true);
    expect(isSignInReachableOnHost(CONFIGURED, 'gaycruisebingo.vercel.app')).toBe(true);
    // ADR 0010's same-origin escape hatch (authDomain pinned to this host).
    expect(isSignInReachableOnHost('bodega-bay.vacaybingo.com', 'bodega-bay.vacaybingo.com')).toBe(
      true,
    );
  });

  it('mounts web.app so the AuthProvider handoff to firebaseapp.com can run', () => {
    // The ship-network fallback host: signed-out visits history-replace to
    // gaycruisebingo.firebaseapp.com BEFORE auth (specs/w1-auth-google.md), so
    // the gate must not report auth-unconfigured here.
    expect(isAuthConfiguredForHost(CONFIGURED, 'gaycruisebingo.web.app')).toBe(false);
    expect(isSignInReachableOnHost(CONFIGURED, 'gaycruisebingo.web.app')).toBe(true);
  });

  it('still blocks an unconfigured wildcard host', () => {
    expect(isSignInReachableOnHost(CONFIGURED, 'bodega-bay.vacaybingo.com')).toBe(false);
    expect(isSignInReachableOnHost(CONFIGURED, 'anything-else.example.com')).toBe(false);
  });
});
