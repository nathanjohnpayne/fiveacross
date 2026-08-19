// The rendered not-found state (#545): "unknown, reserved, disabled, archived
// and domain-ineligible slugs fail closed with an Event-not-found response."
//
// A RENDERED state, never an inferred-active one. The application has its own
// `EventNotFound` screen for the case where the app booted and then failed to
// resolve; this is the case where the app must not boot at all, so the router
// has to draw the page itself.

import type { HostRejection } from './host';
import type { NotFoundReason } from './resolve';
import type { SlugRejection } from '../../src/slug';

export type FailClosedReason = HostRejection | NotFoundReason;

/**
 * Deliberately brand-neutral, and that is a constraint rather than laziness:
 * the router reaches this page precisely when it does not know which Event —
 * and therefore which Edition — the address belongs to, so any wordmark it drew
 * would be a guess. Showing a guest the wrong product's name on a dead address
 * is worse than showing them none.
 *
 * No external resource of any kind: no font, no script, no image, no
 * stylesheet. This page renders when the origin is not being contacted, so
 * anything it fetched would be a second way for it to fail. The hostname is
 * NOT reflected into the markup — there is nothing to escape, and therefore no
 * reflection sink to get wrong.
 */
const BODY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Address not in service</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #17171a; --muted: #5c5c66; }
@media (prefers-color-scheme: dark) { :root { --bg: #101014; --fg: #f4f4f6; --muted: #a0a0ad; } }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
main { max-width: 30rem; text-align: center; }
h1 { font-size: 1.35rem; margin: 0 0 0.75rem; letter-spacing: -0.01em; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>This address isn&rsquo;t in service</h1>
<p>Double-check the link you followed. If someone shared it with you, ask them for the current address.</p>
</main>
</body>
</html>
`;

/**
 * `404`, `no-store`, and `noindex`, each load-bearing.
 *
 * `404` because the address genuinely does not resolve, and a soft-200 would
 * teach crawlers and installed shells that it does. `no-store` because a host
 * provisioned one minute after a guest first tried it must work on their next
 * attempt — a cached not-found is a self-inflicted outage with a TTL, and this
 * is the same reason `resolve.ts` caches no negatives. `noindex` because a
 * wildcard namespace's unclaimed labels are infinite and none of them are
 * content.
 *
 * The reason rides in a header rather than on the page: an operator verifying a
 * cutover needs to tell `reserved-label` from `lookup-unavailable` at a glance,
 * and a guest needs neither. Every value is drawn from the closed unions above,
 * so nothing caller-controlled reaches the header.
 *
 * `detail` refines `invalid-slug` into the specific rule the label broke, as
 * `invalid-slug:too-short`. Qualified rather than replaced, so the class stays
 * greppable as a prefix while the rule is still named.
 */
export function notFoundResponse(
  reason: FailClosedReason,
  version: string,
  detail?: SlugRejection,
): Response {
  return new Response(BODY, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-event-router': version,
      'x-event-router-reason': detail === undefined ? reason : `${reason}:${detail}`,
    },
  });
}
