/**
 * True for local-development / loopback hosts. Two policies key off this:
 * PostHog init is skipped on these (see the gate in main.tsx) so dev sessions
 * and Vite HMR errors — e.g. the #194 `ReferenceError: ProfileEditor is not
 * defined` fast-refresh artifact captured from `localhost:5173` — never reach
 * production analytics or session replays; and the pre-mount auth gate exempts
 * them (src/auth-domain.ts) so local dev and the e2e Auth-Emulator popup path
 * stay mountable regardless of the copied `VITE_FIREBASE_AUTH_DOMAIN` (Codex
 * P2 round 5 on #576). Pure (host in, bool out) so the policy is unit-testable
 * without stubbing `window.location`. Lives in its own dependency-free module
 * so `auth-domain.ts` can use it without dragging posthog-js into its import
 * graph; `posthog.ts` re-exports it for its existing callers.
 */
export function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local')
  );
}
