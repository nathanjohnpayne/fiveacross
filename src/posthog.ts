// Client-side PostHog (product analytics) — runs ALONGSIDE GA4 (#96).
//
// Full capture is ENABLED (this reverses the prior privacy lockdown, at the
// owner's request). PostHog now autocaptures clicks, SPA pageviews + pageleaves,
// heatmaps, and records sessions — on top of the explicit named events that flow
// through analytics.ts's `track()`. Identity is still by uid only (no PII person
// properties).
//
// This is a noindex, 18+ app whose play surface is public to any logged-in
// Player. Session replay + autocapture record everything (including Proof media,
// typed inputs, and display names) UNMASKED, by owner decision: the owner is the
// sole PostHog viewer and uses replays to find UX issues, so content masking is
// deliberately not applied. The one exception is URL hygiene — captured URLs are
// reduced to path-only (see `sanitizeUrls`) so query-string credentials (e.g.
// Firebase auth-handler OAuth params) never land in analytics, matching the app's
// long-standing path-only pageview stance. This reverses the #96 privacy lockdown
// at the owner's request; ConsentNotice.tsx discloses that session replay is used.
import posthog, { type PostHogConfig, type CaptureResult } from 'posthog-js';
import { probeTimeoutSignal } from './canonical-redirect';

/** Init options — exported so the capture policy is unit-testable. */
export const POSTHOG_INIT_OPTIONS: Partial<PostHogConfig> = {
  autocapture: true,
  // 'history_change' captures the initial load AND SPA route changes (react-router
  // drives navigation through the History API), so no manual pageview call is needed.
  capture_pageview: 'history_change',
  capture_pageleave: true,
  disable_session_recording: false,
  // PostHog masks all inputs in replays by default; the owner wants fully
  // unmasked replays (see the header note), so opt out explicitly — otherwise
  // typed text like the callout-Proof <textarea> stays hidden, defeating the
  // UX-debugging purpose. (Codex P3 on #195.)
  session_recording: { maskAllInputs: false },
  // Content is unmasked, but URLs are not: strip query/hash from URL properties
  // so query-string secrets (auth tokens, emails) are never stored. (Codex P1 on #195.)
  before_send: sanitizeUrls,
  person_profiles: 'identified_only',
  // Events POST first-party through our reverse proxy (see `api_host` below,
  // #149); `ui_host` keeps the PostHog toolbar and "view in PostHog" links
  // pointed at the real US app rather than the proxy domain. Region-fixed, so
  // it lives here in the static (testable) options rather than being env-driven.
  ui_host: 'https://us.posthog.com',
};

/**
 * Default ingestion host. Our first-party reverse proxy (#149) forwards both the
 * ingestion API and PostHog's static assets to the US region, so shipping through
 * it keeps analytics on our own domain (fewer ad-blocker drops, no third-party
 * host). `VITE_POSTHOG_HOST` still supports a direct-US non-production bypass;
 * this US deployment deliberately keeps `ui_host` region-fixed above.
 */
export const POSTHOG_PROXY_HOST = 'https://d.gaycruisebingo.com';

/**
 * Personal-domain reverse proxy — the PRIMARY ingest host (#344). Same
 * PostHog-managed Cloudflare proxy infrastructure as the gaycruisebingo proxy
 * (both CNAME to *.cf-prod-us-proxy.proxyhog.com), but on a registered domain
 * the 2026-07-15 shipboard DPI filter does NOT block. Ordering rationale: the
 * filter killed the ENTIRE gaycruisebingo.com domain by SNI — subdomains
 * included — so a same-domain proxy fails exactly when the app's audience (the
 * ship) needs it; the personal domain keeps proxy-grade ad-blocker resistance
 * without sharing that fate. Deliberate loose coupling to the owner's personal
 * domain, accepted by owner decision (#344).
 */
export const POSTHOG_PERSONAL_PROXY_HOST = 'https://d.nathanpayne.com';

/**
 * Direct PostHog Cloud US ingestion — the LAST-RESORT host (#342). Never
 * probed: when both proxies are down, events are best-effort against the
 * backend itself (more ad-blocker-visible, but delivery beats silence — the
 * #342 incident had events dying silently in posthog-js's retry queue).
 */
export const POSTHOG_DIRECT_HOST = 'https://us.i.posthog.com';

/**
 * The priority-ordered ingest chain (#344): personal proxy, then the
 * first-party gaycruisebingo proxy (#149's default, demoted by #344), then
 * direct PostHog Cloud. Exported for tests and for the override policy below.
 */
export const POSTHOG_INGEST_HOSTS = [
  POSTHOG_PERSONAL_PROXY_HOST,
  POSTHOG_PROXY_HOST,
  POSTHOG_DIRECT_HOST,
] as const;

/**
 * Whether `host` answers (#342): the same cheap no-cors/no-store transport
 * probe used by the other resilient transports — an opaque response proves
 * TCP+TLS+HTTP completed; rejection (reset / filtered SNI / no DNS) or timeout
 * means events would die.
 */
export async function ingestHostAlive(
  host: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<boolean> {
  const { signal, cleanup } = probeTimeoutSignal(timeoutMs);
  try {
    await fetchImpl(`${host}/?alive=${Date.now()}`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    cleanup();
  }
}

/**
 * Which ingestion host to init with, given the two proxy probes (#344). Pure
 * so the priority policy is testable: first alive host in chain order, and
 * direct PostHog Cloud unconditionally last (never probed — see its note).
 */
export function pickIngestHost(personalAlive: boolean, gcbProxyAlive: boolean): string {
  if (personalAlive) return POSTHOG_PERSONAL_PROXY_HOST;
  if (gcbProxyAlive) return POSTHOG_PROXY_HOST;
  return POSTHOG_DIRECT_HOST;
}

/**
 * True when this env override should skip the transport probes entirely. An
 * override that merely restates a PROXY chain member is NOT a bypass (Codex
 * P2 on #342): .env.example ships VITE_POSTHOG_HOST=<gcb proxy>, so treating
 * it as an unconditional winner would silently disable the outage failover
 * for every deploy built from a copied example env. The DIRECT host is
 * different: restating it is the documented "skip the proxies, go straight to
 * PostHog Cloud" diagnostic bypass, so it wins unconditionally — as does any
 * host outside the chain.
 */
export function envHostBypassesProbe(envHost: string | undefined): boolean {
  const override = envHost?.trim().replace(/\/+$/, '');
  if (!override) return false;
  return override !== POSTHOG_PERSONAL_PROXY_HOST && override !== POSTHOG_PROXY_HOST;
}

/**
 * Strip the query string and hash from a URL string, keeping origin + path.
 * Non-string / non-URL values pass through unchanged.
 */
export function stripUrlSecrets(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const u = new URL(value);
    return u.origin + u.pathname;
  } catch {
    // Relative or malformed URL — drop everything from the first ? or #.
    return value.split(/[?#]/)[0];
  }
}

const URL_PROP_KEYS = [
  '$current_url',
  '$pathname',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
];

/** Reduce any URL-bearing keys in a property bag to path-only, in place. */
function scrubUrlBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return;
  for (const key of URL_PROP_KEYS) {
    if (bag[key] != null) bag[key] = stripUrlSecrets(bag[key]);
  }
}

/**
 * Session-replay snapshots ($snapshot events) carry the page URL separately from
 * $current_url and drive the URL shown in the replay timeline, so scrubbing only
 * $current_url leaves the replay URL bar with the full query/hash. Walk the rrweb
 * events and reduce those hrefs to path-only too. Two carriers:
 *   - Meta events (type 4): `data.href` (initial page metadata).
 *   - Custom events (type 5): `data.payload.href` — PostHog's pageview / URL-change
 *     markers, emitted on initial load and SPA navigations under
 *     `capture_pageview: 'history_change'`.
 * No-op when the payload is compressed/opaque (not a plain array), the safe
 * fallback. (#197)
 */
function scrubSnapshotUrls(snapshotData: unknown): void {
  // posthog-js sends `$snapshot_data` as a plain array of rrweb events, or (in
  // some shapes) an object wrapping that array under `.data`.
  const events = Array.isArray(snapshotData)
    ? snapshotData
    : Array.isArray((snapshotData as { data?: unknown } | null)?.data)
      ? (snapshotData as { data: unknown[] }).data
      : null;
  if (!events) return;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const { type, data } = ev as { type?: unknown; data?: Record<string, unknown> };
    if (!data || typeof data !== 'object') continue;
    // Meta event (type 4): data.href
    if (type === 4 && typeof data.href === 'string') {
      data.href = stripUrlSecrets(data.href) as string;
    }
    // Custom event (type 5): data.payload.href
    if (type === 5) {
      const payload = (data as { payload?: Record<string, unknown> }).payload;
      if (payload && typeof payload.href === 'string') {
        payload.href = stripUrlSecrets(payload.href) as string;
      }
    }
  }
}

/**
 * `before_send` hook: reduce URL-bearing fields to path-only so query-string /
 * hash credentials (e.g. Firebase auth-handler OAuth params) are never stored,
 * even though replay content is otherwise unmasked. Covers the event `properties`
 * AND the person-property bags `$set` / `$set_once` — the latter carry
 * `$initial_current_url` / `$initial_referrer` on the first pageview and would
 * otherwise persist the full entry URL (Codex P1 on #195) — AND the rrweb Meta
 * (type 4) / Custom-event (type 5) hrefs inside `$snapshot` replay data (#197).
 */
export function sanitizeUrls(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  scrubUrlBag(event.properties);
  scrubUrlBag(event.$set);
  scrubUrlBag(event.$set_once);
  if (event.event === '$snapshot') scrubSnapshotUrls(event.properties?.$snapshot_data);
  return event;
}

let ready = false;

/**
 * True for local-development / loopback hosts. PostHog init is skipped on these
 * (see the gate in main.tsx) so dev sessions and Vite HMR errors — e.g. the #194
 * `ReferenceError: ProfileEditor is not defined` fast-refresh artifact captured
 * from `localhost:5173` — never reach production analytics or session replays.
 * Pure (host in, bool out) so the policy is unit-testable without stubbing
 * `window.location`.
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

/**
 * Initialize once from the app entry (main.tsx). No-op without a key — mirrors
 * the GA4 guard in firebase.ts, so dev/test/CI without env vars stay silent. The
 * `phc_` project key is client-safe (public) by design.
 */
export async function initPostHog(): Promise<void> {
  if (ready) return;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return;
  const envHost = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
  // Walk the ingest chain unless an env override forces a host genuinely
  // outside it (#342/#344): a blocked proxy (shipboard SNI filter) silently
  // drops every event, so ~1.5s of parallel probes at boot buys working
  // analytics for the whole session. Both proxies are probed CONCURRENTLY —
  // the wait is one probe budget, not chain-length × budget. `track()` calls
  // in that window no-op via the existing `ready` gate; the initial pageview
  // is captured by posthog.init itself afterwards, so nothing user-visible
  // waits.
  let api_host: string;
  if (envHostBypassesProbe(envHost)) {
    api_host = envHost!.trim();
  } else {
    const [personalAlive, gcbProxyAlive] = await Promise.all([
      ingestHostAlive(POSTHOG_PERSONAL_PROXY_HOST),
      ingestHostAlive(POSTHOG_PROXY_HOST),
    ]);
    api_host = pickIngestHost(personalAlive, gcbProxyAlive);
  }
  try {
    posthog.init(key, { api_host, ...POSTHOG_INIT_OPTIONS });
    ready = true;
  } catch {
    ready = false;
    return;
  }
  // Replay an identity that arrived while init was still probing (Codex P2 on
  // #342): Firebase restores a cached signed-in user fast on reload, and a
  // phIdentify() landing in the probe window used to no-op via the `ready`
  // gate — leaving the whole session anonymous in analytics. Apply the last
  // one now that the SDK is live.
  if (pendingIdentifyUid !== null) {
    const uid = pendingIdentifyUid;
    pendingIdentifyUid = null;
    phIdentify(uid);
  }
}

export const posthogReady = (): boolean => ready;

/**
 * Capture an explicit event. Called by analytics.ts `track()` alongside GA4.
 *
 * `options` exists for events emitted immediately before the page goes away
 * (CodeRabbit on #513). The default transport batches, so a capture followed by
 * a reload — `app_crash`, whose whole job is to be visible AFTER the crash that
 * produced it — can be dropped before it ever leaves the tab. Callers in that
 * position pass `{ transport: 'sendBeacon', send_instantly: true }`, which
 * survives the page context being destroyed.
 */
export function phCapture(
  name: string,
  params?: Record<string, unknown>,
  options?: { transport?: 'XHR' | 'fetch' | 'sendBeacon'; send_instantly?: boolean },
): void {
  if (!ready) return;
  try {
    // Kept arity-exact for the common path: every existing caller passes no
    // options and must keep producing a two-argument `capture` call.
    if (options) posthog.capture(name, params, options);
    else posthog.capture(name, params);
  } catch {
    /* analytics must never throw into product code */
  }
}

// The most recent identify that arrived before init settled (#342) — replayed
// by initPostHog once the SDK is live, cleared by phReset so a sign-out during
// the probe window never resurrects the identity afterwards.
let pendingIdentifyUid: string | null = null;

/** Tie subsequent events to the signed-in User by uid (no PII properties). */
export function phIdentify(uid: string): void {
  if (!ready) {
    pendingIdentifyUid = uid;
    return;
  }
  try {
    posthog.identify(uid);
  } catch {
    /* no-op */
  }
}

/** Clear the identity association on sign-out. */
export function phReset(): void {
  pendingIdentifyUid = null;
  if (!ready) return;
  try {
    posthog.reset();
  } catch {
    /* no-op */
  }
}
