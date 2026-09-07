import { describe, it, expect } from 'vitest';
import { firebaseAuthOriginRedirectUrl } from './canonical-redirect';
import * as canonicalRedirect from './canonical-redirect';

describe('firebaseAuthOriginRedirectUrl', () => {
  it('hands gaycruisebingo.web.app to firebaseapp.com, preserving path/query/hash', () => {
    expect(
      firebaseAuthOriginRedirectUrl({
        hostname: 'gaycruisebingo.web.app',
        pathname: '/card',
        search: '?e=med-2026',
        hash: '#top',
      }),
    ).toBe('https://gaycruisebingo.firebaseapp.com/card?e=med-2026#top');
  });

  it('carries a pending Invitation in the fragment, replacing whatever hash the page had', () => {
    expect(
      firebaseAuthOriginRedirectUrl(
        { hostname: 'gaycruisebingo.web.app', pathname: '/card', search: '?e=med-2026', hash: '#top' },
        { invitationCode: 'Q'.repeat(43) },
      ),
    ).toBe(`https://gaycruisebingo.firebaseapp.com/card?e=med-2026#fa_invite=${'Q'.repeat(43)}`);
    expect(
      firebaseAuthOriginRedirectUrl(
        { hostname: 'gaycruisebingo.web.app', pathname: '/', search: '', hash: '' },
        { invitationCode: null },
      ),
    ).toBe('https://gaycruisebingo.firebaseapp.com/');
  });

  it('does not redirect firebaseapp.com, which is the stable Firebase auth origin', () => {
    expect(
      firebaseAuthOriginRedirectUrl({
        hostname: 'gaycruisebingo.firebaseapp.com',
        pathname: '/',
        search: '',
        hash: '',
      }),
    ).toBeNull();
  });

  it('returns null on the canonical host so there is no redirect loop', () => {
    expect(
      firebaseAuthOriginRedirectUrl({
        hostname: 'gaycruisebingo.com',
        pathname: '/card',
        search: '?e=med-2026',
        hash: '',
      }),
    ).toBeNull();
  });

  it('returns null on localhost, preview channels, and other non-alias hosts (never fires in dev/e2e)', () => {
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      'gaycruisebingo--pr-42-ab12cd.web.app', // Firebase preview channel — must not be hijacked to prod
    ]) {
      expect(
        firebaseAuthOriginRedirectUrl({
          hostname,
          pathname: '/',
          search: '',
          hash: '',
        }),
      ).toBeNull();
    }
  });

  it('keeps the #345-removed auth-origin exports removed (#348)', () => {
    // PR #345 deleted the mutable-auth-domain machinery: canonicalRedirectUrl,
    // canonicalOriginAlive, and FALLBACK_AUTH_DOMAIN. No in-repo consumer
    // remains, but the names were part of this module's surface long enough
    // that a stale downstream import (or a revert-merge resurrecting the old
    // probe-and-mutate flow) is plausible. This guard makes any reintroduction
    // an explicit, reviewed decision instead of a silent API regression — if
    // one of these names comes back on purpose, delete it from this list in
    // the same PR and say why.
    const removedExports = ['canonicalRedirectUrl', 'canonicalOriginAlive', 'FALLBACK_AUTH_DOMAIN'];
    for (const name of removedExports) {
      expect(name in canonicalRedirect, `export "${name}" was removed in #345 and must stay removed`).toBe(false);
    }
  });
});
