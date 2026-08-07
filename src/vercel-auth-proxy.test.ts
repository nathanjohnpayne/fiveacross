import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface HostCondition {
  type?: string;
  value?: string | { eq?: string };
}

interface VercelConfig {
  rewrites?: Array<{ source?: string; destination?: string; has?: HostCondition[] }>;
  git?: { deploymentEnabled?: boolean | Record<string, boolean> };
}

// Every brand mirror that proxies its auth helper to the `fiveacross` Firebase
// project. Vacay is an Edition of that project rather than a project of its own
// (ADR 0008), so #625's host has the same destination as #585's despite the
// different brand.
const FIVEACROSS_MIRROR_HOSTS = ['fiveacross.vercel.app', 'vacaybingo.vercel.app'];

describe('Vercel Firebase Auth proxy', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as VercelConfig;

  // #676: mirror currency is manual. A merge to `main` must deploy NOTHING —
  // three projects build from this one file, so an accidental re-enable is
  // three production builds per merge against an account-wide cap whose
  // exhaustion refuses deployments team-wide for 24 hours, taking out the
  // ship-network fallback exactly when the primary host is unreachable.
  describe('manual mirror deploys (#676)', () => {
    it('disables Git-triggered deployment of main', () => {
      const enabled = config.git?.deploymentEnabled;
      expect(typeof enabled).toBe('object');
      expect((enabled as Record<string, boolean>).main).toBe(false);
    });

    // Scoped to `main` ON PURPOSE, not a blanket `false`: the stable preview
    // alias is fed by `git push --force origin HEAD:preview`
    // (docs/app/preview-deploys.md § Part 2), which a blanket disable would
    // silently kill along with the production builds it is aimed at.
    it('leaves every other branch alone, so the preview flow survives', () => {
      const enabled = config.git?.deploymentEnabled as Record<string, boolean>;
      expect(Object.keys(enabled)).toEqual(['main']);
    });
  });
  const rewrites = config.rewrites ?? [];

  // #585 / #625: one vercel.json serves three Vercel projects (gcb production
  // plus the two Five Across-family mirrors), so the auth proxy picks a Firebase
  // project by request host. Order is load-bearing twice over: every
  // host-conditional rule must precede the unconditional gcb rule, and all of
  // them must precede the SPA catch-all.
  it.each(FIVEACROSS_MIRROR_HOSTS)('proxies %s to the fiveacross helper namespace', (host) => {
    expect(rewrites).toContainEqual({
      source: '/__/auth/:path*',
      has: [{ type: 'host', value: { eq: host } }],
      destination: 'https://fiveacross.firebaseapp.com/__/auth/:path*',
    });
  });

  it.each(FIVEACROSS_MIRROR_HOSTS)('matches %s exactly, never as a substring', (host) => {
    // A bare string `value` is a REGEX to Vercel, and an unanchored one — it
    // would match `<host>.evil.example` and any host merely containing the
    // alias. The `eq` condition object is the exact-match form, and exact
    // matching is the same invariant FIRST_PARTY_AUTH_HOSTS keeps in
    // src/auth-domain.ts: both consoles register one literal host.
    const rule = rewrites.find(
      (r) =>
        typeof r.has?.[0]?.value === 'object' && (r.has[0].value as { eq?: string }).eq === host,
    );
    expect(rule).toBeDefined();
    expect(rule?.has?.[0]?.type).toBe('host');
  });

  it('keeps exactly one unconditional Gay Cruise Bingo fallthrough', () => {
    // More than one and a host with no conditional rule would silently take
    // whichever happened to come first.
    const unconditional = rewrites.filter(
      (r) => r.source === '/__/auth/:path*' && r.has === undefined,
    );
    expect(unconditional).toEqual([
      {
        source: '/__/auth/:path*',
        destination: 'https://gaycruisebingo.firebaseapp.com/__/auth/:path*',
      },
    ]);
  });

  it('orders every host-conditional rule ahead of the unconditional one', () => {
    const fallthrough = rewrites.findIndex(
      (r) => r.source === '/__/auth/:path*' && r.has === undefined,
    );
    const conditional = rewrites.flatMap((r, i) =>
      r.source === '/__/auth/:path*' && r.has !== undefined ? [i] : [],
    );
    expect(conditional.length).toBe(FIVEACROSS_MIRROR_HOSTS.length);
    for (const index of conditional) expect(index).toBeLessThan(fallthrough);
  });

  it('serves client-side routes without shadowing the auth proxy', () => {
    expect(rewrites.at(-1)).toEqual({
      source: '/(.*)',
      destination: '/index.html',
    });
  });

  it('gives every auth-helper rule priority over the SPA fallback', () => {
    const catchAll = rewrites.findIndex((rule) => rule.source === '/(.*)');
    const authRules = rewrites.flatMap((rule, index) =>
      rule.source === '/__/auth/:path*' ? [index] : [],
    );
    expect(authRules.length).toBeGreaterThan(0);
    for (const index of authRules) expect(index).toBeLessThan(catchAll);
  });
});
