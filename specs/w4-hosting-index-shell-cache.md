---
spec_id: w4-hosting-index-shell-cache
status: accepted
tested: false
reason: Firebase Hosting config only, no runtime app surface; verified by live curl against the deployed domain (see PR description).
---

# Fix: `index.html` app-shell was never getting its `no-cache` header

`firebase.json`'s `headers` block had a rule targeting `"source": "/index.html"` to keep the SPA shell always-revalidated. But every real request hits `/` (or any client route), which the `"source": "**", "destination": "/index.html"` rewrite serves *as* `/index.html`—Firebase Hosting matches header rules against the pre-rewrite request path, not the rewritten destination, so the `/index.html`-scoped rule never actually applied to live traffic. The CDN fell back to a default `max-age=3600`, meaning the app shell (and any deploy of it) could be served stale to a browser or edge cache for up to an hour after a release.

The fix adds a catch-all `"source": "**"` rule setting `Cache-Control: no-cache`, placed *before* the existing asset- and icon-specific rules. Firebase Hosting applies later-declared rules with priority for a given header key when multiple rules match the same request, so the catch-all supplies the default (no-cache) while the more specific asset (`immutable`, one-year) and icon (`no-cache`) rules downstream still override it exactly as before—verified by diffing header behavior across a hashed JS asset, `sw.js`, and `/` pre- and post-fix.

No app-code or runtime surface is touched; this is a Firebase Hosting config-only change with no unit-test layer. Verification is manual: live `curl` against the deployed domain confirming hashed assets keep their immutable long-cache, `sw.js` keeps `no-cache`, and `/` (previously `max-age=3600`) now returns `no-cache` after deploy.

## Addendum: exclude `/s/**` from the catch-all

Header matching happens on the pre-rewrite path, same as the bug above—so the new catch-all `**` rule also matched `/s/**`, the crawler-facing share route rewritten to the `share` Cloud Function (`functions/src/index.ts`). That function set its own `Cache-Control: public, max-age=3600` for social-unfurl caching; the catch-all would have stamped `no-cache` over it instead. Added a `"source": "/s/**"` rule (declared after the catch-all, so it wins per Hosting's later-rule-wins precedence) restoring the function's intended 1-hour cache.

**Superseded by #39 (ADR 0005).** The `share` Cloud Function, the `/s/**` → `share` rewrite, and the `"source": "/s/**"` header exception this addendum describes are all removed. `/s/**` is no longer a distinct route—like every other path, it now falls through to the `**` → `/index.html` SPA rewrite and picks up the same `no-cache` catch-all header as the rest of the app shell, since there is no longer a function response to protect from it. This addendum is kept as the historical record of why the exception existed.
