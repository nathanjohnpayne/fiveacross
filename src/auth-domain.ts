import { firebaseAuthOriginRedirectUrl } from './canonical-redirect';
import { isLocalDevHost } from './local-host';

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
  // The Five Across backup host (#585): the PRODUCTION alias of a second Vercel
  // project building this same repo with the `fiveacross` env. It exists because
  // a Five Across Event served only from Firebase Hosting has no reachable
  // fallback if a venue network blocks that host — the failure gcb already had,
  // and survived, on `gaycruisebingo.vercel.app` (ADR 0007, #599). Independent
  // CDN, independent certificate, independent hostname class.
  //
  // Its registrations live in the OTHER Firebase project: `fiveacross`'s
  // authorized domains and the `fiveacross` Google OAuth web client, not
  // gaycruisebingo's. `vercel.json`'s FIRST rewrite is host-conditional on this
  // exact hostname and proxies `/__/auth/*` to `fiveacross.firebaseapp.com`, so
  // pinning here is what keeps that helper same-origin — a plain `.com` build
  // would proxy to the wrong Firebase project.
  //
  // A production alias, not a branch URL, on purpose: the gcb project's preview
  // deployments sit behind Vercel Standard Protection (ADR 0007 § Consequences),
  // which would put a player-facing backup host behind a vercel.com login wall.
  // Console setup: docs/app/preview-deploys.md § The Five Across mirror.
  'fiveacross.vercel.app',
  // The Vacay Bingo backup host (#625): the third and last of the brand family's
  // mirrors, alongside `gaycruisebingo.vercel.app` and `fiveacross.vercel.app`.
  //
  // Vacay is an EDITION of the `fiveacross` Firebase project, not a project of
  // its own (ADR 0008 splits the data plane by cohort, not by brand), so this
  // host's registrations and its `/__/auth/*` proxy target are `fiveacross`'s —
  // identical to the entry above despite the different brand. Two separate
  // host-conditional rules in `vercel.json` rather than one `inc` list: `eq` is
  // the matcher already proven in production here, and a single list failing
  // would take out both mirrors at once.
  //
  // It SERVES the branded app in place and must never redirect to
  // `vacaybingo.com` — a mirror that bounces to the canonical host is worthless
  // in the one situation it exists for, which is the canonical host being
  // unreachable (#625).
  'vacaybingo.vercel.app',
]);

/** Keep production OAuth helper storage on the same origin as the app. */
export function resolveAuthDomain(configuredAuthDomain: string, hostname: string): string {
  return FIRST_PARTY_AUTH_HOSTS.has(hostname) ? hostname : configuredAuthDomain;
}

/**
 * Whether Google sign-in can actually COMPLETE on this origin (#543, ADR 0010).
 *
 * Hostname resolution is what makes this check necessary. Before it, one build
 * served one hostname and "the app runs here" implied "sign-in works here". It
 * no longer does. ADR 0010's central auth origin and handoff are not
 * implemented, so an origin whose `authDomain` is some OTHER host falls to the
 * cross-origin popup helper — which Safari's storage partitioning breaks on
 * mobile, and which in any case needs a `https://<host>/__/auth/handler` entry
 * on the Google OAuth web client that only a human can add in the console
 * (Codex P1 on #576).
 *
 * Ready means the OAuth helper is same-origin, which happens two ways:
 *
 *  - the host is a registered first-party host (the allowlist above), or
 *  - the build pins `authDomain` to this very host — ADR 0010's "same-origin
 *    escape hatch", which works for any hostname registered as an exact
 *    Firebase Hosting custom domain. A single-Edition build like Bodega uses
 *    exactly this, so the check does not dark it.
 *
 * Both collapse to the same question, which is why this is one line:
 * does `resolveAuthDomain` end up pointing at us?
 *
 * Anything else is an address the auth stack has never been configured for.
 * Saying so beats rendering a Google button that dead-ends: a broken sign-in on
 * a phone in a rental house is unrecoverable by the player and silent to us.
 */
export function isAuthConfiguredForHost(configuredAuthDomain: string, hostname: string): boolean {
  return resolveAuthDomain(configuredAuthDomain, hostname) === hostname;
}

/**
 * Whether mounting the app on this origin can lead to a COMPLETED sign-in —
 * the predicate behind main.tsx's pre-mount auth gate (Codex P1 on #576).
 *
 * `isAuthConfiguredForHost` alone is too strict for that gate, because "auth is
 * not configured HERE" does not always mean "sign-in dead-ends here":
 *
 *  - `gaycruisebingo.web.app` deliberately keeps the configured `.com`
 *    authDomain (see `resolveAuthDomain`), because `AuthProvider` history-
 *    replaces every signed-out web.app visit to `gaycruisebingo.firebaseapp.com`
 *    BEFORE any auth transaction starts (specs/w1-auth-google.md,
 *    src/canonical-redirect.ts). Blocking the mount there would strand the
 *    documented ship-network fallback host on an "auth unconfigured" screen —
 *    the app must mount so the handoff can run. `firebaseAuthOriginRedirectUrl`
 *    is the single source of truth for which hosts have that handoff, so this
 *    asks it rather than keeping a second list.
 *
 *  - Local and emulator origins (`localhost`, `127.0.0.1`, `::1`, `*.local`)
 *    are outside this gate's threat model entirely. The Playwright webServer
 *    serves `127.0.0.1` with the demo project's `firebaseapp.com` authDomain,
 *    and ordinary `npm run dev` copies whatever `.env.local` holds — both sign
 *    in fine (Auth Emulator popup / dev popup) and neither is a
 *    production-origin misconfiguration, which is the only thing this gate
 *    exists to report (Codex P2 round 5 on #576).
 */
export function isSignInReachableOnHost(configuredAuthDomain: string, hostname: string): boolean {
  if (isAuthConfiguredForHost(configuredAuthDomain, hostname)) return true;
  if (isLocalDevHost(hostname)) return true;
  // Only the hostname decides the handoff; path/search/hash merely shape the
  // target URL, which is discarded here.
  return firebaseAuthOriginRedirectUrl({ hostname, pathname: '/', search: '', hash: '' }) !== null;
}
