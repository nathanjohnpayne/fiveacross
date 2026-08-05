import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface HostCondition {
  type?: string;
  value?: string | { eq?: string };
}

interface VercelConfig {
  rewrites?: Array<{ source?: string; destination?: string; has?: HostCondition[] }>;
}

describe('Vercel Firebase Auth proxy', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as VercelConfig;

  // #585: one vercel.json serves two Vercel projects (gcb production + the Five
  // Across mirror), so the auth proxy has to pick a Firebase project by request
  // host. Order is load-bearing twice over: the mirror's host-conditional rule
  // must precede the unconditional gcb rule, and both must precede the SPA
  // catch-all.
  it('proxies the Five Across mirror host to the fiveacross helper namespace', () => {
    expect(config.rewrites?.[0]).toEqual({
      source: '/__/auth/:path*',
      has: [{ type: 'host', value: { eq: 'fiveacross.vercel.app' } }],
      destination: 'https://fiveacross.firebaseapp.com/__/auth/:path*',
    });
  });

  it('matches the mirror host exactly, never as a substring', () => {
    // A bare string `value` is a REGEX to Vercel, and an unanchored one — it
    // would match `fiveacross.vercel.app.evil.example` and any host merely
    // containing the alias. The `eq` condition object is the exact-match form,
    // and exact matching is the same invariant FIRST_PARTY_AUTH_HOSTS keeps in
    // src/auth-domain.ts: both consoles register one literal host.
    const condition = config.rewrites?.[0]?.has?.[0];
    expect(condition?.type).toBe('host');
    expect(typeof condition?.value).toBe('object');
    expect((condition?.value as { eq?: string }).eq).toBe('fiveacross.vercel.app');
  });

  it('transparently proxies the complete Firebase Auth helper namespace', () => {
    expect(config.rewrites?.[1]).toEqual({
      source: '/__/auth/:path*',
      destination: 'https://gaycruisebingo.firebaseapp.com/__/auth/:path*',
    });
  });

  it('serves client-side routes without shadowing the auth proxy', () => {
    expect(config.rewrites?.[2]).toEqual({
      source: '/(.*)',
      destination: '/index.html',
    });
  });

  it('gives every auth-helper rule priority over the SPA fallback', () => {
    const catchAll = config.rewrites?.findIndex((rule) => rule.source === '/(.*)') ?? -1;
    const authRules =
      config.rewrites?.flatMap((rule, index) =>
        rule.source === '/__/auth/:path*' ? [index] : [],
      ) ?? [];
    expect(authRules.length).toBeGreaterThan(0);
    for (const index of authRules) expect(index).toBeLessThan(catchAll);
  });
});
