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

    // The one exception, and the reason this is not a blanket `false`: the
    // stable sign-in alias is fed by `git push --force origin HEAD:preview`
    // (docs/app/preview-deploys.md § Part 2). `preview` matches both rules,
    // and Vercel deploys when ANY matched rule is true.
    it('keeps the preview-branch flow alive', () => {
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
