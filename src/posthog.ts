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

// Moved to its own dependency-free module (src/local-host.ts) so the pre-mount
// auth gate can share it without importing posthog-js; re-exported here for the
// existing import sites (main.tsx, tests).
export { isLocalDevHost } from './local-host';

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
  // Replay dimensions registered while init was still probing (#556), BEFORE
  // the identify below — `posthog.identify()` itself emits an `$identify` /
  // `$set` capture the moment it transitions the anonymous user (Codex P2 on
  // #556), so registering first means THAT capture carries brand/edition/
  // Event context too, not just the ones queued after it.
  if (pendingRegister !== null) {
    const props = pendingRegister;
    pendingRegister = null;
    try {
      posthog.register(props);
    } catch {
      /* no-op */
    }
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
  // Replay queued captures AFTER both of the above, so an `app_crash` from the
  // probe window is attributed to the signed-in player rather than orphaned
  // under the anonymous id (Phase 4b P2 on #513). Persisted entries come first
  // — they are from a PRIOR load (the crash that triggered a recovery reload),
  // so they are both older and the ones that matter most.
  const carriedNow = carried();
  // Replay the PERSISTED entries only once their deletion is confirmed (Phase
  // 4b P2 on #513). If the store would not let them go, replaying means
  // re-sending them on every future load with no way to stop; dropping them is
  // the lesser harm, on this module's standing rule that losing a telemetry
  // event beats corrupting the data. In-memory entries are unaffected — they
  // die with this page either way, so they can never double-send.
  const drained = clearPersistedCaptures();
  const queued = [...(drained ? carriedNow : []), ...pendingCaptures];
  carriedCaptures = [];
  pendingCaptures = [];
  for (const c of queued) phCapture(c.name, c.params, c.options);
}

export const posthogReady = (): boolean => ready;

/** Capture options for events emitted just before the page goes away. */
export type CaptureOptions = { transport?: 'XHR' | 'fetch' | 'sendBeacon'; send_instantly?: boolean };

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
export function phCapture(name: string, params?: Record<string, unknown>, options?: CaptureOptions): void {
  if (!ready) {
    // Queue instead of dropping (Phase 4b P2 on #513). `initPostHog` is
    // fire-and-forget and awaits ~1.5s of ingest-host probes, while main.tsx
    // renders synchronously right after — so a STARTUP crash, the exact case
    // `app_crash` exists to report, reliably lands in this window and used to
    // vanish through the `ready` gate before any transport option could help.
    // Same replay pattern as `pendingIdentifyUid` below. Bounded: a crash loop
    // must not grow this without limit, and the earliest events are the ones
    // worth keeping, so it drops newest-over-oldest once full.
    if (carried().length + pendingCaptures.length < MAX_PENDING_CAPTURES) {
      pendingCaptures.push({ name, params, options });
      // Also persist, because the queue's most important customer immediately
      // reloads the page (Codex P2 on #513): `componentDidCatch` starts
      // `resetShell()` right after queueing, and its same-origin probe can
      // finish well before the EXTERNAL PostHog ingest probes — especially when
      // a proxy is blocked, which is the shipboard case. Module memory would
      // die with that navigation, so the startup crash this queue exists to
      // rescue would still vanish. sessionStorage survives the reload.
      persistPendingCaptures();
    }
    return;
  }
  try {
    // Kept arity-exact for the common path: every existing caller passes no
    // options and must keep producing a two-argument `capture` call.
    if (options) posthog.capture(name, params, options);
    else posthog.capture(name, params);
  } catch {
    /* analytics must never throw into product code */
  }
}

/** Captures that arrived before init settled, replayed by `initPostHog`. */
type PendingCapture = { name: string; params?: Record<string, unknown>; options?: CaptureOptions };
const MAX_PENDING_CAPTURES = 20;
let pendingCaptures: PendingCapture[] = [];

/** Survives the recovery reload; drained by `initPostHog`. Session-scoped, so a
 *  queue that never drains dies with the tab rather than following the player. */
const PENDING_CAPTURES_KEY = 'gcb:ph-pending-captures';

/**
 * Entries queued by a PRIOR load, read from storage exactly once (Codex P2 on
 * #513). Keeping them in their own array is what makes each event have exactly
 * ONE representation: `pendingCaptures` is strictly this load's queue, this is
 * strictly the previous load's, and the persisted blob is simply the two
 * concatenated. Merging both into one array and also persisting it — the
 * previous shape — double-counted every event whenever init settled without a
 * navigation, since the in-memory copy and its own persisted mirror were both
 * replayed. `null` means "not read yet"; `[]` means "read, nothing there".
 */
let carriedCaptures: PendingCapture[] | null = null;

// Every storage touch is swallowed: analytics must never throw into product
// code, and a lost telemetry event is always preferable to a broken app.
function carried(): PendingCapture[] {
  if (carriedCaptures !== null) return carriedCaptures;
  try {
    const raw = sessionStorage?.getItem(PENDING_CAPTURES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    carriedCaptures = Array.isArray(parsed)
      ? parsed.filter((c): c is PendingCapture => !!c && typeof (c as PendingCapture).name === 'string')
      : [];
  } catch {
    carriedCaptures = [];
  }
  return carriedCaptures;
}

/** Mirrors the whole queue — prior load's entries included, so a second load
 *  that queues its own pre-init event cannot overwrite the first one's. */
function persistPendingCaptures(): void {
  try {
    const all = [...carried(), ...pendingCaptures].slice(0, MAX_PENDING_CAPTURES);
    sessionStorage?.setItem(PENDING_CAPTURES_KEY, JSON.stringify(all));
  } catch {
    /* quota/policy/absent — the in-memory queue still covers the no-reload case */
  }
}

/**
 * Deletes the persisted queue and reports whether the deletion is CONFIRMED
 * GONE (Phase 4b P2 on #513) — the same read-back discipline the shell-reset
 * latch uses, for the same reason. A readable-but-nonmutating store can accept
 * `removeItem` and leave the blob intact; the "exactly once" contract would
 * then be violated on every subsequent load, forever, since each one would
 * re-read and re-send the same crash reports.
 */
function clearPersistedCaptures(): boolean {
  try {
    sessionStorage?.removeItem(PENDING_CAPTURES_KEY);
    return sessionStorage?.getItem(PENDING_CAPTURES_KEY) == null;
  } catch {
    return false;
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

// Dimensions registered before init settled (#556) — merged (not replaced)
// as calls arrive, so a call BEFORE `ready` (brand/edition/Event at startup)
// and one AFTER (day_index once the Event doc has loaded) both survive to
// the single replay in `initPostHog`. `null` means "nothing queued yet",
// distinct from `{}` (a call that queued zero keys — never happens today,
// kept distinct anyway so a future no-op call cannot look like "unset").
let pendingRegister: Record<string, unknown> | null = null;

// The full MERGED set of super-properties registered so far this load
// (#556, Codex P2) — distinct from `pendingRegister` above, which is only
// the not-yet-applied portion. Kept so `phReset` can reapply it: PostHog's
// `reset()` clears its persisted `register()` state along with the
// identity, and without a copy here a second Player signing in on the same
// tab (no full page reload) would send every subsequent capture with no
// brand/edition/Event/Day context at all, silently, until something called
// `phRegister` again.
let registeredDims: Record<string, unknown> = {};

/**
 * Register PostHog super-properties: attached to every capture from THIS
 * point forward, including autocaptured pageviews and events already queued
 * by `phCapture`'s own pre-init buffer — the GA4-side equivalent is
 * `setDefaultEventParameters` (src/analytics.ts's `registerAnalyticsDimensions`
 * / `registerDayIndexDimension`, #556). Queues-and-merges before init settles,
 * mirroring `phIdentify`'s replay so brand/edition/Event context is never
 * dropped on the startup race.
 */
export function phRegister(props: Record<string, unknown>): void {
  registeredDims = { ...registeredDims, ...props };
  if (!ready) {
    pendingRegister = { ...(pendingRegister ?? {}), ...props };
    return;
  }
  try {
    posthog.register(props);
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
    // Reapply the dimensions `reset()` just cleared (#556, Codex P2) — see
    // `registeredDims`'s own doc above for why this must not be skipped.
    if (Object.keys(registeredDims).length > 0) posthog.register(registeredDims);
  } catch {
    /* no-op */
  }
}
