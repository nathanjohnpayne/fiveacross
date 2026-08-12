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
import { resolvedCanonicalHost } from './canonicalHost';

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
 * Brand-level ingest proxy on the canonical domain — the PRIMARY ingest host
 * (#612, executing the ingest half of the #599 domain pivot). Same
 * PostHog-managed Cloudflare proxy infrastructure as the other proxies (a
 * DNS-only CNAME to *.cf-prod-us-proxy.proxyhog.com), on the Brand's own
 * domain: ingestion is Brand-level, not Edition-selected (#578/#579), so every
 * Edition ships events to this one host and only the REPORTED hostname stays
 * Edition-scoped.
 */
export const POSTHOG_BRAND_PROXY_HOST = 'https://d.fiveacross.app';

/**
 * First-party gaycruisebingo reverse proxy (#149) — forwards both the
 * ingestion API and PostHog's static assets to the US region. Demoted from
 * default by #344 (shipboard SNI filter blocked the whole domain) and again
 * behind the Brand proxy by #612; kept in the chain as a live fallback.
 */
export const POSTHOG_PROXY_HOST = 'https://d.gaycruisebingo.com';

/**
 * Personal-domain reverse proxy — formerly the primary (#344), now the FIRST
 * FALLBACK behind the Brand proxy (#612). Same PostHog-managed Cloudflare
 * proxy infrastructure as the other proxies, but on a registered domain the
 * 2026-07-15 shipboard DPI filter does NOT block. Ordering rationale: the
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
 * The priority-ordered ingest chain (#344, reordered by #612): Brand proxy on
 * the canonical domain first, then the personal proxy, then the first-party
 * gaycruisebingo proxy (#149's default, demoted by #344), then direct PostHog
 * Cloud. Exported for tests and for the override policy below.
 *
 * ⚠️ The ordering lives HERE, in code — never via `VITE_POSTHOG_HOST`. Setting
 * that env var to point at a proxy host looks equivalent but silently DISABLES
 * this failover chain when the host is outside `envHostBypassesProbe`'s
 * allowed set (the #540/#578 launch-handoff finding, restated in #612): the
 * override becomes the unconditional winner and a blocked proxy then drops
 * every event for the whole session. Keep `VITE_POSTHOG_HOST` unset in every
 * build env; promote/demote hosts by editing this list.
 */
export const POSTHOG_INGEST_HOSTS = [
  POSTHOG_BRAND_PROXY_HOST,
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
 * Which ingestion host to init with, given the three proxy probes (#344,
 * #612). Pure so the priority policy is testable: first alive host in chain
 * order, and direct PostHog Cloud unconditionally last (never probed — see
 * its note).
 */
export function pickIngestHost(brandAlive: boolean, personalAlive: boolean, gcbProxyAlive: boolean): string {
  if (brandAlive) return POSTHOG_BRAND_PROXY_HOST;
  if (personalAlive) return POSTHOG_PERSONAL_PROXY_HOST;
  if (gcbProxyAlive) return POSTHOG_PROXY_HOST;
  return POSTHOG_DIRECT_HOST;
}

/**
 * True when this env override should skip the transport probes entirely. An
 * override that merely restates a PROXY chain member is NOT a bypass (Codex
 * P2 on #342): .env.example historically shipped VITE_POSTHOG_HOST=<gcb
 * proxy> (it now ships it blank, per #612), so treating a restated member as
 * an unconditional winner would silently disable the outage failover for
 * every deploy built from a copied example env. The DIRECT host is
 * different: restating it is the documented "skip the proxies, go straight to
 * PostHog Cloud" diagnostic bypass, so it wins unconditionally — as does any
 * host outside the chain.
 */
export function envHostBypassesProbe(envHost: string | undefined): boolean {
  const override = envHost?.trim().replace(/\/+$/, '');
  if (!override) return false;
  return (
    override !== POSTHOG_BRAND_PROXY_HOST &&
    override !== POSTHOG_PERSONAL_PROXY_HOST &&
    override !== POSTHOG_PROXY_HOST
  );
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

/**
 * Replace the origin of an origin+path string with the resolved canonical
 * hostname (#556, Codex round-2 P2: "PostHog's sanitized $current_url still
 * comes from window.location"). Layered ON TOP of `stripUrlSecrets`, never
 * folded into it, so `stripUrlSecrets` stays the pure "strip query/hash"
 * primitive its own tests pin. A no-op when no canonical host has been
 * resolved (a single-Event build has no separate Alias concept — its own
 * origin already IS canonical) or when the value has no origin to replace
 * (a relative path, already host-free).
 */
function canonicalizeOrigin(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const host = resolvedCanonicalHost();
  if (!host) return value;
  try {
    const u = new URL(value);
    return `https://${host}${u.pathname}`;
  } catch {
    return value; // relative — no origin to swap
  }
}

// Split in two (#556, Codex round-2 P2 follow-through): `$current_url` /
// `$pathname` / `$initial_current_url` are always THIS site's own URL, so
// canonicalizing their origin is correct. `$referrer` / `$initial_referrer`
// are frequently a genuinely EXTERNAL origin (google.com, a shared link on
// another platform) — canonicalizing those would silently overwrite real
// referrer data with our own hostname, corrupting it rather than protecting
// it. Referrer fields get query/hash stripped only, never an origin swap.
const SELF_URL_PROP_KEYS = ['$current_url', '$pathname', '$initial_current_url'];
const REFERRER_PROP_KEYS = ['$referrer', '$initial_referrer'];

/** Reduce any URL-bearing keys in a property bag to path-only, in place —
 *  the site's-own-URL keys also get their origin canonicalized (#556). */
function scrubUrlBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return;
  for (const key of SELF_URL_PROP_KEYS) {
    if (bag[key] != null) bag[key] = canonicalizeOrigin(stripUrlSecrets(bag[key]));
  }
  for (const key of REFERRER_PROP_KEYS) {
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
    // Meta event (type 4): data.href — always THIS page's own URL, so the
    // origin canonicalization (#556) applies here too, same as $current_url.
    if (type === 4 && typeof data.href === 'string') {
      data.href = canonicalizeOrigin(stripUrlSecrets(data.href)) as string;
    }
    // Custom event (type 5): data.payload.href
    if (type === 5) {
      const payload = (data as { payload?: Record<string, unknown> }).payload;
      if (payload && typeof payload.href === 'string') {
        payload.href = canonicalizeOrigin(stripUrlSecrets(payload.href)) as string;
      }
    }
  }
}

/**
 * The dimension keys #556 registers (`src/analytics.ts`'s
 * `registerAnalyticsDimensions` / `registerDayIndexDimension`) —
 * system-controlled: nothing legitimate ever sets these explicitly on an
 * event's own properties, so they always come from the CURRENT
 * `registeredDims`, never inherited from whatever the event itself carried
 * in (#611, retro Phase 4b P1 on PR #584). This INVERTS the general "event
 * wins" posture an ordinary per-call property would otherwise get: PostHog
 * PERSISTS `register()`'d super-properties to localStorage ACROSS SESSIONS
 * (and tabs), so the SDK's own automatic first capture inside
 * `posthog.init()` can embed the PRIOR session's
 * `event_id`/`edition_id`/`event_slug`/`day_index` directly into its
 * `properties` bag before `before_send` ever runs — exactly the shape
 * "event wins" was meant to defer to (a more-specific per-call value), and
 * exactly the shape that must NOT win here (a stale, cross-session leftover
 * masquerading as one). A key ABSENT from `registeredDims` (most commonly
 * `day_index` before the Event doc has loaded) is DELETED from the outgoing
 * event rather than left as whatever was inherited — an unknown dimension
 * must report as unknown, never as a stale guess.
 */
const CONTROLLED_DIMENSION_KEYS: readonly string[] = [
  'brand_id',
  'edition_id',
  'event_id',
  'event_slug',
  'day_index',
];

/**
 * `before_send` hook: reduce URL-bearing fields to path-only so query-string /
 * hash credentials (e.g. Firebase auth-handler OAuth params) are never stored,
 * even though replay content is otherwise unmasked. Covers the event `properties`
 * AND the person-property bags `$set` / `$set_once` — the latter carry
 * `$initial_current_url` / `$initial_referrer` on the first pageview and would
 * otherwise persist the full entry URL (Codex P1 on #195) — AND the rrweb Meta
 * (type 4) / Custom-event (type 5) hrefs inside `$snapshot` replay data (#197).
 *
 * ALSO applies `registeredDims` — the brand/edition/Event/Slug/Day dimensions
 * (#556) — to every outgoing event's `properties` (Phase 4b P1 on PR #584).
 * This is the mechanism that actually GUARANTEES every event carries them,
 * independent of exactly when `posthog.register()` applied relative to
 * `posthog.init()`'s own synchronous work: `before_send` is the single point
 * every captured event — autocaptured or explicit, the very first
 * `\$pageview` included — passes through right before it leaves the SDK, so
 * reading the already-populated module state here removes any dependency on
 * internal SDK ordering `phRegister`'s queue-and-replay alone could not
 * close. The five `CONTROLLED_DIMENSION_KEYS` always win from
 * `registeredDims` (see that constant's own doc for why — #611); any OTHER
 * registered default (none exist today) keeps the general "event wins" merge.
 */
export function sanitizeUrls(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  // The production entrypoint waits for Firebase's authoritative auth state
  // before letting the SDK send anything. If that startup identity cannot be
  // established, fail closed: posthog.init() may already have scheduled its
  // first pageview, but before_send is the final common gate for that event,
  // autocapture, explicit captures, and replay snapshots alike.
  if (identityGateRequired && !identityGateReady) return null;
  const incoming = event.properties;
  const hasStaleControlledKey = incoming != null && CONTROLLED_DIMENSION_KEYS.some((k) => k in incoming);
  if (Object.keys(registeredDims).length > 0 || hasStaleControlledKey) {
    const properties: Record<string, unknown> = { ...incoming };
    // Non-controlled dimensions (none exist today, kept for forward
    // compatibility) defer to whatever the event itself already set.
    for (const [key, value] of Object.entries(registeredDims)) {
      if (!CONTROLLED_DIMENSION_KEYS.includes(key) && !(key in properties)) properties[key] = value;
    }
    // The controlled keys always come from CURRENT registeredDims (#611) —
    // present here, override; absent here, delete rather than inherit.
    for (const key of CONTROLLED_DIMENSION_KEYS) {
      if (key in registeredDims) properties[key] = registeredDims[key];
      else delete properties[key];
    }
    event.properties = properties;
  }
  scrubUrlBag(event.properties);
  scrubUrlBag(event.$set);
  scrubUrlBag(event.$set_once);
  if (event.event === '$snapshot') scrubSnapshotUrls(event.properties?.$snapshot_data);
  return event;
}

let ready = false;
let initInFlight: Promise<void> | null = null;
let identityGateRequired = false;
let identityGateReady = false;

export type InitPostHogOptions = { waitForAuth?: boolean };

// The first resolved Firebase auth state is a startup BASELINE, not an
// ordinary point-in-time queue operation. It must apply before every capture
// that accumulated while auth was loading (including a recovery-reload crash),
// while later auth transitions remain in pendingOps' strict FIFO.
let initialAuthUid: string | null | undefined;
let lastObservedAuthUid: string | null | undefined;
let resolveInitialAuth: (() => void) | null = null;
const initialAuthReady = new Promise<void>((resolve) => {
  resolveInitialAuth = resolve;
});

// Moved to its own dependency-free module (src/local-host.ts) so the pre-mount
// auth gate can share it without importing posthog-js; re-exported here for the
// existing import sites (main.tsx, tests).
export { isLocalDevHost } from './local-host';

/**
 * Initialize once from the app entry (main.tsx). No-op without a key — mirrors
 * the GA4 guard in firebase.ts, so dev/test/CI without env vars stay silent. The
 * `phc_` project key is client-safe (public) by design.
 */
export function initPostHog(options: InitPostHogOptions = {}): Promise<void> {
  if (ready) return Promise.resolve();
  if (initInFlight) return initInFlight;
  const attempt = initializePostHog(options);
  initInFlight = attempt;
  const clearAttempt = (): void => {
    if (initInFlight === attempt) initInFlight = null;
  };
  void attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

async function initializePostHog(options: InitPostHogOptions): Promise<void> {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return;
  if (options.waitForAuth) {
    identityGateRequired = true;
    if (initialAuthUid === undefined) await initialAuthReady;
  }
  const envHost = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
  // Walk the ingest chain unless an env override forces a host genuinely
  // outside it (#342/#344): a blocked proxy (shipboard SNI filter) silently
  // drops every event, so ~1.5s of parallel probes at boot buys working
  // analytics for the whole session. All three proxies are probed
  // CONCURRENTLY — the wait is one probe budget, not chain-length × budget,
  // and a dead/unresolvable chain head costs nothing beyond its own failed
  // probe. `track()` calls in that window no-op via the existing `ready`
  // gate; the initial pageview is captured by posthog.init itself
  // afterwards, so nothing user-visible waits.
  let api_host: string;
  if (envHostBypassesProbe(envHost)) {
    api_host = envHost!.trim();
  } else {
    const [brandAlive, personalAlive, gcbProxyAlive] = await Promise.all([
      ingestHostAlive(POSTHOG_BRAND_PROXY_HOST),
      ingestHostAlive(POSTHOG_PERSONAL_PROXY_HOST),
      ingestHostAlive(POSTHOG_PROXY_HOST),
    ]);
    api_host = pickIngestHost(brandAlive, personalAlive, gcbProxyAlive);
  }
  try {
    posthog.init(key, { api_host, ...POSTHOG_INIT_OPTIONS });
  } catch {
    ready = false;
    return;
  }
  if (options.waitForAuth) {
    // `initialAuthUid` cannot still be undefined after initialAuthReady, but
    // fail closed if that invariant is ever broken rather than capture under
    // whatever User the SDK restored from local persistence.
    if (initialAuthUid === undefined || !applyInitialAuthState(initialAuthUid)) {
      ready = false;
      return;
    }
    identityGateReady = true;
  }
  ready = true;
  // Replay EVERYTHING that arrived while init was still probing — captures
  // and identity operations — as ONE queue, in ARRIVAL ORDER (#613, Phase 4b
  // round-2 P1; round 1 replayed the identity FIFO first and all captures
  // after, which re-attributed a capture queued between two identity
  // transitions to the LATER identity: identify(A), capture(oldUserAction),
  // reset, identify(B) recorded oldUserAction as B's). Identity ordering
  // within the queue is equally load-bearing (#613 round-1 P1):
  // `posthog.init()` loads whatever identity PostHog PERSISTED from a prior
  // session, so a fast sign-out → sign-in must reach the SDK as
  // reset-THEN-identify — replaying the identify alone would merge the NEW
  // account's uid onto the PRIOR user's persisted distinct_id (cross-user
  // attribution), and a silently dropped reset was exactly the #611
  // stale-identity leak. Dimension registration replays before the first
  // identify OR capture so the `$identify` capture the SDK emits — and every
  // replayed capture — carries brand/edition/Event context (Codex P2 on
  // #556); `applyReset` re-registers the full merged set itself, because
  // `posthog.reset()` clears register() state (see `registeredDims`).
  //
  // Ordering vs the SDK's own automatic first `$pageview` (#613, Phase 4b
  // P1): posthog-js does NOT capture it inside `init()` — the loaded step of
  // init (`kn()` in the 1.409.5 dist) SCHEDULES it one macrotask later via
  // `setTimeout(..., 1)`, and the capture computes `distinct_id` at capture
  // time. Production init itself waits for Firebase's first resolved auth
  // state, then applies that baseline SYNCHRONOUSLY after `posthog.init()`
  // returns (no awaits in between). The baseline therefore lands before the
  // SDK timer even with a direct-host override, without resetting a returning
  // User whose persisted PostHog uid already matches Firebase.
  const ops = pendingOps;
  pendingOps = [];
  const replayRegister = (): void => {
    if (pendingRegister === null) return;
    const props = pendingRegister;
    pendingRegister = null;
    try {
      posthog.register(props);
    } catch {
      /* no-op */
    }
  };
  // PRIOR-load persisted captures are older than this load's queue, but the
  // production auth baseline above still applies FIRST. Identity ops are not
  // persisted, so the SDK's restored identity is not reliable evidence of who
  // owned a capture that survived a recovery reload (a signed-out reset may
  // have died with the page). Fresh Firebase auth is authoritative and keeps
  // those captures from leaking to a stale prior User. Replayed only once
  // their deletion is confirmed (Phase 4b P2 on #513): if the store would
  // not let them go, replaying means re-sending them on every future load
  // with no way to stop; dropping them is the lesser harm, on this module's
  // standing rule that losing a telemetry event beats corrupting the data.
  // In-memory entries are unaffected — they die with this page either way,
  // so they can never double-send.
  const carriedNow = carried();
  const drained = clearPersistedCaptures();
  carriedCaptures = [];
  if (drained) {
    for (const c of carriedNow) phCapture(c.name, c.params, c.options);
  }
  for (const op of ops) {
    if (op.type === 'reset') {
      // A reset supersedes the incremental replay: `applyReset` re-registers
      // the FULL merged `registeredDims`, which already contains everything
      // `pendingRegister` held (`phRegister` merges into both).
      closeIdentityGate();
      if (!applyReset()) break;
      pendingRegister = null;
      openIdentityGate();
    } else {
      replayRegister();
      if (op.type === 'identify') {
        if (identifiedUid !== null && identifiedUid !== op.uid) {
          closeIdentityGate();
          if (!applyReset()) break;
          openIdentityGate();
        }
        openIdentityGate();
        if (!applyIdentify(op.uid)) {
          closeIdentityGate();
          break;
        }
      }
      else phCapture(op.name, op.params, op.options);
    }
  }
  replayRegister();
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
export function phCapture(name: string, params?: Record<string, unknown>, options?: CaptureOptions): boolean {
  if (!ready) {
    // A build without a PostHog key has no configured PostHog sink. Treat it
    // as acknowledged so callers that also support GA4 do not retain an
    // undrainable durability queue forever.
    if (!(import.meta.env.VITE_POSTHOG_KEY as string | undefined)) return true;
    // Queue instead of dropping (Phase 4b P2 on #513) — into the SAME ordered
    // queue as the identity ops (#613, Phase 4b round-2 P1), so replay keeps
    // each capture attributed to the identity state that held when it was
    // queued. `initPostHog` is fire-and-forget and awaits ~1.5s of
    // ingest-host probes, while main.tsx renders synchronously right after —
    // so a STARTUP crash, the exact case `app_crash` exists to report,
    // reliably lands in this window and used to vanish through the `ready`
    // gate before any transport option could help. Bounded (captures only —
    // identity ops are bounded by their own coalescing): a crash loop must
    // not grow this without limit, and the earliest events are the ones
    // worth keeping, so it drops newest-over-oldest once full.
    if (carried().length + queuedCaptures().length < MAX_PENDING_CAPTURES) {
      pendingOps.push({ type: 'capture', name, params, options });
      // Also persist, because the queue's most important customer immediately
      // reloads the page (Codex P2 on #513): `componentDidCatch` starts
      // `resetShell()` right after queueing, and its same-origin probe can
      // finish well before the EXTERNAL PostHog ingest probes — especially when
      // a proxy is blocked, which is the shipboard case. Module memory would
      // die with that navigation, so the startup crash this queue exists to
      // rescue would still vanish. sessionStorage survives the reload.
      return persistPendingCaptures();
    }
    return false;
  }
  try {
    // Kept arity-exact for the common path: every existing caller passes no
    // options and must keep producing a two-argument `capture` call.
    if (options) posthog.capture(name, params, options);
    else posthog.capture(name, params);
    return true;
  } catch {
    return false;
  }
}

/** A capture queued before init settled — also the persisted-blob entry shape
 *  (see `carried`), which is why it has no `type` discriminant of its own. */
type PendingCapture = { name: string; params?: Record<string, unknown>; options?: CaptureOptions };
const MAX_PENDING_CAPTURES = 20;

/**
 * EVERYTHING that arrived while the SDK was not ready — captures AND identity
 * operations (sign-out resets / sign-in identifies) — as ONE ordered queue,
 * replayed FIFO by `initPostHog` (#613, Phase 4b round-2 P1; unifies round
 * 1's separate identity FIFO with the #513 capture queue). One queue is what
 * makes attribution order-true: with separate queues, the sequence
 * identify(A), capture(oldUserAction), reset, identify(B) replayed both
 * identity transitions FIRST and then recorded oldUserAction as B's. Order
 * is equally load-bearing within the identity ops (#613 round-1 P1):
 * `posthog.init()` loads the PRIOR session's persisted identity, so a fast
 * sign-out → account-switch must reach the SDK as reset-then-identify —
 * replaying the identify alone would merge the new uid onto the previous
 * account's persisted distinct_id. Coalescing is minimal and identity-aware
 * (see `phIdentify`/`phReset`): only an identify repeating the queue's
 * current identity uid, or a reset directly repeating a reset, is dropped;
 * an A→B uid change enqueues the reset the transition implies. Identity ops
 * are never persisted across loads — a new load re-derives identity from
 * Firebase — so only the capture entries mirror to sessionStorage
 * (`persistPendingCaptures`).
 */
type PendingOp = { type: 'reset' } | { type: 'identify'; uid: string } | ({ type: 'capture' } & PendingCapture);
let pendingOps: PendingOp[] = [];

/** The capture entries of `pendingOps`, in order — this load's queued
 *  captures, in the persistable (type-less) shape. */
function queuedCaptures(): PendingCapture[] {
  return pendingOps
    .filter((op): op is { type: 'capture' } & PendingCapture => op.type === 'capture')
    .map(({ name, params, options }) => ({ name, params, options }));
}

/** Survives the recovery reload; drained by `initPostHog`. Session-scoped, so a
 *  queue that never drains dies with the tab rather than following the player. */
const PENDING_CAPTURES_KEY = 'gcb:ph-pending-captures';

/**
 * Entries queued by a PRIOR load, read from storage exactly once (Codex P2 on
 * #513). Keeping them in their own array is what makes each event have exactly
 * ONE representation: `pendingOps`'s capture entries are strictly this load's
 * queue, this is strictly the previous load's, and the persisted blob is
 * simply the two concatenated. Merging both into one array and also persisting
 * it — the previous shape — double-counted every event whenever init settled
 * without a navigation, since the in-memory copy and its own persisted mirror
 * were both replayed. `null` means "not read yet"; `[]` means "read, nothing
 * there". The first read always happens BEFORE this load persists anything
 * (the `phCapture` bound check calls `carried()` before the first persist), so
 * the cached value never includes this load's own entries.
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

/** Mirrors every queued CAPTURE — prior load's entries included, so a second
 *  load that queues its own pre-init event cannot overwrite the first one's.
 *  Identity ops are deliberately NOT persisted: a new load re-derives its
 *  identity from Firebase auth state, so replaying a stale reset/identify
 *  from a dead load could only fight the fresh one. */
function persistPendingCaptures(): boolean {
  try {
    const all = [...carried(), ...queuedCaptures()].slice(0, MAX_PENDING_CAPTURES);
    const encoded = JSON.stringify(all);
    sessionStorage?.setItem(PENDING_CAPTURES_KEY, encoded);
    return sessionStorage?.getItem(PENDING_CAPTURES_KEY) === encoded;
  } catch {
    return false;
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

/**
 * The uid most recently applied to the LIVE SDK via `identify()`, `null`
 * after a reset (or before any identify). Lets the ready path detect an
 * A→B uid change with no intervening sign-out (#613, Phase 4b round-2 P1):
 * Firebase can deliver one signed-in user directly after another without a
 * signed-out render between them, and identifying B while the SDK still
 * holds A's identity would MERGE the two accounts. Updated only inside
 * `applyIdentify`/`applyReset`, so replayed queue ops and direct ready-path
 * calls stay consistent.
 */
let identifiedUid: string | null = null;

/** The ready-path identify — shared by `phIdentify` and the queue replay. */
function applyIdentify(uid: string): boolean {
  try {
    posthog.identify(uid);
    identifiedUid = uid;
    return true;
  } catch {
    /* no-op */
    return false;
  }
}

/**
 * The ready-path reset — shared by `phReset` and the queue replay. Reapplies
 * the dimensions `reset()` just cleared (#556, Codex P2) — see
 * `registeredDims`'s own doc below for why this must not be skipped.
 */
function applyReset(): boolean {
  try {
    posthog.reset();
    identifiedUid = null;
  } catch {
    /* no-op */
    return false;
  }
  // Identity reset succeeded, so report success even if this best-effort
  // dimension re-register fails. before_send still supplies the controlled
  // dimensions, and treating a register failure as a reset failure would
  // cause a second reset that needlessly rotates the new anonymous session.
  try {
    if (Object.keys(registeredDims).length > 0) posthog.register(registeredDims);
  } catch {
    /* no-op */
  }
  return true;
}

type RestoredUserUid = { known: true; uid: string | null } | { known: false };

/** Read the SDK identity that init restored without guessing from distinct_id. */
function restoredUserUid(): RestoredUserUid {
  try {
    const value = posthog.get_property('$user_id');
    return { known: true, uid: typeof value === 'string' && value.length > 0 ? value : null };
  } catch {
    return { known: false };
  }
}

/**
 * Apply Firebase's authoritative first auth state before this load captures.
 * A matching returning User is identified in place (preserving PostHog's
 * session/replay); an anonymous visitor is stitched normally; only a signed-
 * out state or a DIFFERENT persisted User needs reset().
 */
function applyInitialAuthState(uid: string | null): boolean {
  if (uid === null) {
    if (!applyReset()) return false;
    openIdentityGate();
    return true;
  }
  const restored = restoredUserUid();
  if (!restored.known) return false;
  if (restored.uid !== null && restored.uid !== uid && !applyReset()) return false;
  // Reset/restored-user preconditions are now proven. Open the narrow send
  // path BEFORE identify(): posthog-js emits the `$identify` merge handshake
  // synchronously inside identify(), and dropping it would mutate local state
  // without ever stitching the anonymous history server-side.
  openIdentityGate();
  if (applyIdentify(uid)) return true;
  closeIdentityGate();
  return false;
}

function closeIdentityGate(): void {
  if (identityGateRequired) identityGateReady = false;
}

function openIdentityGate(): void {
  if (identityGateRequired) identityGateReady = true;
}

/**
 * The most recent IDENTITY op (reset/identify) in the pending queue, looking
 * past any captures queued after it — the identity state a newly queued op
 * would follow. Scanning past captures matters (#613, Phase 4b round-2 P1):
 * with [identify(A), capture] in the queue, a phIdentify(B) must still see
 * A as the current queued identity and insert the reset the A→B transition
 * implies; checking only the literal last element would miss it.
 */
function lastQueuedIdentityOp(): Exclude<PendingOp, { type: 'capture' }> | undefined {
  for (let i = pendingOps.length - 1; i >= 0; i--) {
    const op = pendingOps[i];
    if (op.type !== 'capture') return op;
  }
  return undefined;
}

/** Tie subsequent events to the signed-in User by uid (no PII properties). */
export function phIdentify(uid: string): boolean {
  if (!ready) {
    const last = lastQueuedIdentityOp();
    if (last?.type === 'identify') {
      // Identical uid: nothing new to say — the queue's identity state is
      // already this account (#613 round 2: ONLY identical uids coalesce).
      if (last.uid === uid) return true;
      // A→B with NO intervening sign-out: insert the reset the transition
      // implies (#613, Phase 4b round-2 P1). Replaying identify(B) directly
      // after identify(A) — or over A's identity as loaded by
      // `posthog.init()` — would merge the two accounts.
      pendingOps.push({ type: 'reset' }, { type: 'identify', uid });
      return true;
    }
    pendingOps.push({ type: 'identify', uid });
    return true;
  }
  // Same A→B protection on the ready path (#613, Phase 4b round-2 P1): an
  // in-session uid change without a sign-out resets first, so B's events
  // never merge onto A's identity.
  if (identifiedUid !== null && identifiedUid !== uid) {
    closeIdentityGate();
    if (!applyReset()) return false;
    openIdentityGate();
  }
  // identify() emits the `$identify` stitching handshake synchronously. This
  // must also open on a SAME-uid retry after a prior identify exception, not
  // only on the reset-following A→B path above.
  openIdentityGate();
  if (applyIdentify(uid)) return true;
  closeIdentityGate();
  return false;
}

/**
 * Feed the resolved Firebase auth state into PostHog. The first observation is
 * the startup baseline awaited by production init; later observations become
 * ordinary FIFO identity transitions. Repeated StrictMode effects coalesce.
 */
export function phSetAuthState(uid: string | null): void {
  const previous = lastObservedAuthUid;
  if (previous === uid && (!identityGateRequired || identityGateReady)) return;
  if (initialAuthUid === undefined && !ready) {
    initialAuthUid = uid;
    lastObservedAuthUid = uid;
    resolveInitialAuth?.();
    resolveInitialAuth = null;
    return;
  }
  if (uid === null) {
    if (phReset()) lastObservedAuthUid = uid;
    return;
  }
  if (previous !== undefined && previous !== null && previous !== uid && !phReset()) return;
  if (phIdentify(uid)) lastObservedAuthUid = uid;
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
export function phReset(): boolean {
  if (!ready) {
    // Queued IN ORDER, never dropped (#611 → #613, Phase 4b P1) — see
    // `pendingOps`'s own doc above: a silently dropped reset leaks a stale
    // persisted identity into the whole signed-out session, and a reset
    // discarded by a LATER identify merges the new account onto the prior
    // user's persisted distinct_id. Only a reset that would directly repeat
    // the queue's current identity state (last identity op already a reset)
    // coalesces away — captures queued between two resets keep their
    // position and attribute the same either way (post-reset anonymous).
    if (lastQueuedIdentityOp()?.type !== 'reset') {
      pendingOps.push({ type: 'reset' });
    }
    return true;
  }
  closeIdentityGate();
  if (!applyReset()) return false;
  openIdentityGate();
  return true;
}
