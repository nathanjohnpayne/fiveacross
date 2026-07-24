// Exact hostnames only — never a prefix or suffix match. Every entry here must
// ALSO be registered in Firebase Auth's authorized domains and as
// `https://<host>/__/auth/handler` on the Google OAuth web client, neither of
// which accepts a wildcard; a pattern here would silently pin `authDomain` to a
// host Google will reject.
const FIRST_PARTY_AUTH_HOSTS = new Set([
  'gaycruisebingo.com',
  'gaycruisebingo.vercel.app',
  'gaycruisebingo.firebaseapp.com',
  // The one non-production entry: the stable Vercel preview alias (ADR 0007).
  // Its branch URL always serves the latest deployment of the `preview` branch,
  // so a single registration covers any branch pushed there — per-deployment
  // preview hosts (`gaycruisebingo-<hash>-…`) can never be registered and stay
  // deliberately absent. `vercel.json`'s `/__/auth/:path*` rewrite already
  // applies to previews, so pinning this host keeps the helper same-origin and
  // the Safari storage-partitioning failure out of preview sign-in too.
  // Console setup: docs/app/preview-deploys.md.
  'gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app',
]);

/** Keep production OAuth helper storage on the same origin as the app. */
export function resolveAuthDomain(configuredAuthDomain: string, hostname: string): string {
  return FIRST_PARTY_AUTH_HOSTS.has(hostname) ? hostname : configuredAuthDomain;
}
