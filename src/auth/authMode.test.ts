// Covers specs/auth-handoff-client.md § Mode selection and § Failure states.
//
// The decision table that gives `VITE_AUTH_MODE` its consumer (#549, ADR 0010).
// Every case here is a route a real deployment can take, and the two that matter
// most are the ones the ticket names: `handoff` must be the default, and
// `same_origin` on an unregistered host must fail LOUDLY rather than render the
// generic auth-unconfigured screen.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_MODE,
  parseAuthMode,
  parseAuthOrigin,
  resolveSignInStrategy,
  type SignInStrategyInput,
} from './authMode';

const CENTRAL = 'https://auth.fiveacross.app';

/** A wildcard Event host: serves an Event, registered nowhere in the auth stack. */
function wildcardHost(overrides: Partial<SignInStrategyInput> = {}): SignInStrategyInput {
  return {
    mode: undefined,
    configuredAuthDomain: 'bodega-bay.vacaybingo.com',
    hostname: 'summer-camp.fiveacross.app',
    handoffOrigin: CENTRAL,
    currentOrigin: 'https://summer-camp.fiveacross.app',
    returnPath: '/',
    ...overrides,
  };
}

describe('parseAuthMode', () => {
  it('defaults to handoff when unset or blank', () => {
    expect(DEFAULT_AUTH_MODE).toBe('handoff');
    expect(parseAuthMode(undefined)).toBe('handoff');
    expect(parseAuthMode('')).toBe('handoff');
    expect(parseAuthMode('   ')).toBe('handoff');
  });

  it('accepts both modes, tolerating surrounding whitespace', () => {
    expect(parseAuthMode('handoff')).toBe('handoff');
    expect(parseAuthMode('same_origin')).toBe('same_origin');
    expect(parseAuthMode('  same_origin  ')).toBe('same_origin');
  });

  // A misspelling is an operator instruction that must not be silently ignored:
  // the moment it is most likely typed is during an incident, which is exactly
  // when nobody is in a position to notice it did nothing.
  it.each(['sameorigin', 'same-origin', 'SAME_ORIGIN', 'Handoff', 'off', 'true'])(
    'rejects unrecognised value %s rather than defaulting',
    (raw) => {
      expect(parseAuthMode(raw)).toBeNull();
    },
  );
});

describe('parseAuthOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(parseAuthOrigin(CENTRAL)).toBe(CENTRAL);
    expect(parseAuthOrigin('  https://auth.fiveacross.app  ')).toBe(CENTRAL);
  });

  it('accepts loopback over http so the flow can be stood up against emulators', () => {
    expect(parseAuthOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(parseAuthOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(parseAuthOrigin('http://[::1]:5173')).toBe('http://[::1]:5173');
  });

  it('rejects a non-default port on a production auth origin', () => {
    expect(parseAuthOrigin('https://auth.fiveacross.app:8443')).toBeNull();
  });

  // One comparison against `URL.origin` rejects every decoration at once,
  // because `.origin` IS the normalisation — there is no list to keep current.
  it.each([
    ['a trailing slash', 'https://auth.fiveacross.app/'],
    ['a path', 'https://auth.fiveacross.app/auth'],
    ['a query', 'https://auth.fiveacross.app?a=1'],
    ['a fragment', 'https://auth.fiveacross.app#x'],
    ['credentials', 'https://user:pw@auth.fiveacross.app'],
    ['plain http on a public host', 'http://auth.fiveacross.app'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['a bare hostname', 'auth.fiveacross.app'],
    ['nonsense', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, raw) => {
    expect(parseAuthOrigin(raw)).toBeNull();
  });
});

describe('resolveSignInStrategy — registered and local hosts keep the direct path', () => {
  // The ordering guarantee: `isSignInReachableOnHost` is asked FIRST, so nothing
  // below depends on the mode at all. These are the hosts that already work, and
  // #549 must not change any of them.
  it.each([
    ['a first-party host', 'gaycruisebingo.com', 'gaycruisebingo.com'],
    ['the Five Across canonical domain', 'bodega-bay.vacaybingo.com', 'fiveacross.app'],
    ['the Bodega Event host', 'bodega-bay.vacaybingo.com', 'bodega-bay.fiveacross.app'],
    ['the central auth origin itself', 'bodega-bay.vacaybingo.com', 'auth.fiveacross.app'],
    ['a build that bakes authDomain to itself', 'weddings.example.com', 'weddings.example.com'],
    ['the e2e loopback host', 'demo-gcb.firebaseapp.com', '127.0.0.1'],
    ['localhost', 'demo-gcb.firebaseapp.com', 'localhost'],
    // web.app keeps its own documented redirect to firebaseapp.com, so the new
    // handoff must not intercept it.
    ['the web.app fallback host', 'gaycruisebingo.com', 'gaycruisebingo.web.app'],
  ])('%s signs in directly', (_label, configuredAuthDomain, hostname) => {
    for (const mode of [undefined, 'handoff', 'same_origin']) {
      expect(
        resolveSignInStrategy(wildcardHost({ mode, configuredAuthDomain, hostname })).kind,
      ).toBe('direct');
    }
  });

  it('signs in directly even with no handoff origin configured at all', () => {
    // gaycruisebingo's shape: one registered origin, never mints a handoff.
    expect(
      resolveSignInStrategy(
        wildcardHost({
          configuredAuthDomain: 'gaycruisebingo.com',
          hostname: 'gaycruisebingo.com',
          handoffOrigin: undefined,
        }),
      ).kind,
    ).toBe('direct');
  });
});

describe('resolveSignInStrategy — handoff is the default on a wildcard Event host', () => {
  it('routes an unregistered Event host through the central origin when unset', () => {
    expect(resolveSignInStrategy(wildcardHost())).toEqual({
      kind: 'handoff',
      authOrigin: CENTRAL,
      targetOrigin: 'https://summer-camp.fiveacross.app',
      returnPath: '/',
    });
  });

  it('routes the same way when handoff is named explicitly', () => {
    expect(resolveSignInStrategy(wildcardHost({ mode: 'handoff' })).kind).toBe('handoff');
  });

  // ADR 0010 as amended 2026-08-05: there is NO canonicalisation step. The
  // validated target origin is the serving host sign-in began on, and the
  // handoff returns the player to that same entry origin — never to some
  // canonical alias of it.
  it('targets the serving origin itself, not the configured authDomain', () => {
    const strategy = resolveSignInStrategy(
      wildcardHost({
        hostname: 'summer-camp.fiveacross.app',
        currentOrigin: 'https://summer-camp.fiveacross.app',
        configuredAuthDomain: 'bodega-bay.vacaybingo.com',
      }),
    );
    expect(strategy).toMatchObject({
      kind: 'handoff',
      targetOrigin: 'https://summer-camp.fiveacross.app',
    });
  });

  it('carries the deep link through so the player lands back where they were', () => {
    expect(
      resolveSignInStrategy(wildcardHost({ returnPath: '/board?day=3' })),
    ).toMatchObject({ kind: 'handoff', returnPath: '/board?day=3' });
  });
});

describe('resolveSignInStrategy — the escape hatch fails loudly, never silently', () => {
  // The ticket's headline acceptance criterion: selecting `same_origin` on an
  // unregistered host must fail LOUDLY rather than render the generic
  // auth-unconfigured screen — and must never quietly take the handoff instead.
  it('refuses same_origin on an unregistered host, by name', () => {
    expect(resolveSignInStrategy(wildcardHost({ mode: 'same_origin' }))).toEqual({
      kind: 'unavailable',
      reason: 'same-origin-host-unregistered',
    });
  });

  it('refuses same_origin even when a perfectly good handoff origin is configured', () => {
    // The whole point of "no silent fallback": a usable handoff sitting right
    // there must not rescue a mode that was deliberately selected.
    expect(
      resolveSignInStrategy(wildcardHost({ mode: 'same_origin', handoffOrigin: CENTRAL })).kind,
    ).toBe('unavailable');
  });

  it('refuses an unrecognised mode rather than falling back to the default', () => {
    expect(resolveSignInStrategy(wildcardHost({ mode: 'sameorigin' }))).toEqual({
      kind: 'unavailable',
      reason: 'auth-mode-invalid',
    });
  });

  it.each([undefined, '', '   '])(
    'refuses handoff with no central origin configured (%p)',
    (handoffOrigin) => {
      expect(resolveSignInStrategy(wildcardHost({ handoffOrigin }))).toEqual({
        kind: 'unavailable',
        reason: 'handoff-origin-unconfigured',
      });
    },
  );

  it.each(['auth.fiveacross.app', 'https://auth.fiveacross.app/x', 'http://evil.test'])(
    'refuses a malformed central origin (%s)',
    (handoffOrigin) => {
      expect(resolveSignInStrategy(wildcardHost({ handoffOrigin }))).toEqual({
        kind: 'unavailable',
        reason: 'handoff-origin-invalid',
      });
    },
  );

  // A build whose handoff origin is the origin it is already serving would
  // bounce the player off themselves forever.
  it('refuses a central origin equal to the origin being served', () => {
    expect(
      resolveSignInStrategy(
        wildcardHost({
          handoffOrigin: 'https://summer-camp.fiveacross.app',
          currentOrigin: 'https://summer-camp.fiveacross.app',
        }),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'handoff-origin-invalid' });
  });

  it('never returns direct for a host that cannot sign in directly', () => {
    // Guards the one collapse that would reintroduce the dead-end Google button:
    // an unregistered host must never be told to sign in same-origin.
    for (const mode of [undefined, 'handoff', 'same_origin', 'bogus']) {
      expect(resolveSignInStrategy(wildcardHost({ mode })).kind).not.toBe('direct');
    }
  });
});
