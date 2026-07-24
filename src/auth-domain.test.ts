import { describe, expect, it } from 'vitest';
import { resolveAuthDomain } from './auth-domain';

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
