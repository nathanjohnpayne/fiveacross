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

  it('pins the Five Across mirror to its own handler so the backup host signs in same-origin (#585)', () => {
    // The mirror is a fiveacross build, so its configured authDomain is a
    // fiveacross host — pinning must still win, because vercel.json proxies
    // /__/auth/* on this hostname to fiveacross.firebaseapp.com.
    expect(resolveAuthDomain('fiveacross.firebaseapp.com', 'fiveacross.vercel.app')).toBe(
      'fiveacross.vercel.app',
    );
  });

  it('pins the Vacay Bingo mirror to its own handler (#625)', () => {
    // Vacay is an Edition of the fiveacross project, so this host's configured
    // authDomain and proxy target are fiveacross's — the brand differs, the
    // Firebase project does not.
    expect(resolveAuthDomain('fiveacross.firebaseapp.com', 'vacaybingo.vercel.app')).toBe(
      'vacaybingo.vercel.app',
    );
  });

  it('does not redirect a mirror to its canonical custom domain (#625)', () => {
    // The serve-in-place rule: a mirror that hands off to vacaybingo.com is
    // useless in the one case it exists for. resolveAuthDomain must return the
    // mirror host itself, never the brand's canonical hostname.
    expect(resolveAuthDomain('vacaybingo.com', 'vacaybingo.vercel.app')).toBe(
      'vacaybingo.vercel.app',
    );
  });

  it.each(['fiveacross.app', 'bodega-bay.fiveacross.app'])(
    'pins Five Across host %s to its own first-party auth handler (#599/#600)',
    (hostname) => {
      // The shipped Bodega bundle bakes authDomain=bodega-bay.vacaybingo.com;
      // on the fiveacross.app hosts the allowlist is what keeps the OAuth
      // helper same-origin instead of resolving a foreign authDomain.
      expect(resolveAuthDomain('bodega-bay.vacaybingo.com', hostname)).toBe(hostname);
    },
  );

  it.each([
    'gaycruisebingo-iy4xn21x8-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo-git-some-other-branch-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app.evil.example',
    // The mirror's own near-misses: a per-deployment host on the mirror project
    // and a lookalike suffix. Neither is registered in either console.
    'fiveacross-iy4xn21x8-nathanjohnpaynes-projects.vercel.app',
    'fiveacross.vercel.app.evil.example',
    'vacaybingo-iy4xn21x8-nathanjohnpaynes-projects.vercel.app',
    'vacaybingo.vercel.app.evil.example',
    // Neither the brand's canonical domain nor a wildcard Event host under it is
    // first-party: those sign in via ADR 0010's escape hatch (authDomain pinned
    // by their own build), not via this list.
    'vacaybingo.com',
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
    // The Five Across backup host (#585) must mount and sign in, not render the
    // auth-unconfigured screen — that is the entire point of the mirror.
    expect(isSignInReachableOnHost('fiveacross.firebaseapp.com', 'fiveacross.vercel.app')).toBe(
      true,
    );
    // The Vacay Bingo backup host (#625), same reasoning.
    expect(isSignInReachableOnHost('fiveacross.firebaseapp.com', 'vacaybingo.vercel.app')).toBe(
      true,
    );
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

  it.each(['localhost', '127.0.0.1', '::1', '[::1]', 'dev.local'])(
    'mounts local/emulator origin %s regardless of the copied authDomain',
    (hostname) => {
      // The Playwright webServer serves 127.0.0.1 with the demo project's
      // firebaseapp.com authDomain; plain dev copies .env.local. Neither is a
      // production-origin misconfiguration, so the gate stays out of the way
      // and the emulator popup sign-in path stays reachable.
      expect(isSignInReachableOnHost('demo-gaycruisebingo.firebaseapp.com', hostname)).toBe(true);
      expect(isSignInReachableOnHost(CONFIGURED, hostname)).toBe(true);
    },
  );

  it('still blocks an unconfigured wildcard host', () => {
    expect(isSignInReachableOnHost(CONFIGURED, 'bodega-bay.vacaybingo.com')).toBe(false);
    expect(isSignInReachableOnHost(CONFIGURED, 'anything-else.example.com')).toBe(false);
  });

  it('mounts the fiveacross.app hosts even under the Bodega-baked authDomain (#600)', () => {
    // The live bundle on the fiveacross Hosting site bakes
    // authDomain=bodega-bay.vacaybingo.com; the allowlist entries are what let
    // the SAME bundle complete sign-in on the fiveacross.app hosts.
    expect(isSignInReachableOnHost('bodega-bay.vacaybingo.com', 'fiveacross.app')).toBe(true);
    expect(
      isSignInReachableOnHost('bodega-bay.vacaybingo.com', 'bodega-bay.fiveacross.app'),
    ).toBe(true);
  });

  it('still blocks a per-deployment host on the mirror project (#585)', () => {
    // Registering the mirror's production alias registers exactly one host. Its
    // own preview deployments remain unregisterable, so they keep rendering the
    // auth-unconfigured signpost rather than a dead-ending Google button.
    expect(
      isSignInReachableOnHost(
        'fiveacross.firebaseapp.com',
        'fiveacross-iy4xn21x8-nathanjohnpaynes-projects.vercel.app',
      ),
    ).toBe(false);
  });
});
