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

  // #676/#680: NO branch deploys any of the three projects except `preview`.
  // Three projects build from this one file, and the account-wide cap is 100
  // deployments per day — every branch push costs three of them, so an
  // accidental re-widening exhausts the quota and refuses deployments
  // team-wide for 24 hours, taking out the ship-network fallback exactly when
  // the primary host is unreachable. #680 is the day that happened.
  describe('manual mirror deploys (#676, widened in #680)', () => {
    const patterns = () => config.git?.deploymentEnabled as Record<string, boolean>;

    it('denies every branch by default', () => {
      expect(typeof patterns()).toBe('object');
      expect(patterns()['**']).toBe(false);
    });

    // `**`, NOT `*`. Vercel matches these with minimatch, where `*` does not
    // cross a `/` — and every working branch here is `claude/...`, so a `*`
    // rule silently misses all of them and leaves the quota burning (#680).
    it('uses the slash-crossing wildcard, not the single-segment one', () => {
      expect(Object.keys(patterns())).toContain('**');
      expect(Object.keys(patterns())).not.toContain('*');
    });

    // The historical Git preview exemption remains; its build now fails closed
    // until isolated test configuration is reviewed (#1420).
    it('retains the historical preview branch exemption', () => {
      expect(patterns().preview).toBe(true);
    });

    it('grants no other exception', () => {
      expect(Object.entries(patterns()).filter(([, v]) => v === true).map(([k]) => k)).toEqual(['preview']);
    });
  });
  const rewrites = config.rewrites ?? [];

  // #585 / #625: one vercel.json serves three Vercel projects (gcb production
  // plus the two Five Across-family mirrors), so the auth proxy picks a Firebase
  // project by request host. Order is load-bearing twice over: every
  // production host must have an exact conditional rule, and all of them
  // must precede the SPA catch-all. Previews have no production helper route.
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

  it('restricts the Gay Cruise Bingo helper to its exact production mirror', () => {
    expect(rewrites.filter((r) => r.source === '/__/auth/:path*' && r.has === undefined)).toEqual([]);
    expect(rewrites).toContainEqual({
      source: '/__/auth/:path*',
      has: [{ type: 'host', value: { eq: 'gaycruisebingo.vercel.app' } }],
      destination: 'https://gaycruisebingo.firebaseapp.com/__/auth/:path*',
    });
  });

  it.each([
    'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo-feature-nathanjohnpaynes-projects.vercel.app',
    'fiveacross-git-preview-nathanjohnpaynes-projects.vercel.app',
    'vacaybingo-git-preview-nathanjohnpaynes-projects.vercel.app',
    'gaycruisebingo.vercel.app.evil.example',
  ])('gives %s no production auth proxy', (host) => {
    const authRules = rewrites.filter((r) => r.source === '/__/auth/:path*');
    expect(authRules.every((r) => r.has?.length === 1 && r.has[0].type === 'host' &&
      typeof r.has[0].value === 'object' && r.has[0].value.eq !== host)).toBe(true);
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
