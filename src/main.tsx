import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ThemeProvider } from './theme/ThemeContext';
import { todaysDayTheme, todaysDayIndex } from './theme/autoTheme';
import { defaultThemeForEdition } from './theme/themes';
import { useEventDoc, useMyPlayer } from './hooks/useData';
import { initPostHog, phIdentify, phReset, isLocalDevHost } from './posthog';
import { registerAnalyticsDimensions, registerDayIndexDimension } from './analytics';
import { isSyntheticProbe } from './synthetic-probe';
import type { ThemeId } from './types';
import App from './App';
import ConsentNotice from './components/ConsentNotice';
import ErrorBoundary from './components/ErrorBoundary';
import EventNotFound from './components/EventNotFound';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import { enforceBuildFloor } from './shellRecovery';
import { bootstrapEventResolution } from './data/hostnames';
import { shouldMountOnBootstrapFailure } from './eventResolution';
import { isSignInReachableOnHost } from './auth-domain';
import './theme/themes.css';
import './index.css';

/**
 * Initialize client-side PostHog once (alongside GA4). No-op without a key
 * (#96), skipped for the uptime synthetic (#142), and skipped on local-dev
 * hosts (#194) so dev sessions and Vite HMR errors never pollute production
 * analytics or session replays. All ph* calls guard on init, so skipping
 * this suppresses PostHog entirely for those loads.
 *
 * Called from `bootstrapEventResolution().then()`/`.catch()` below, NOT at
 * module scope (Phase 4b P1 on #556, PR #584) — module scope used to start
 * PostHog's own async ingest-host probe racing bootstrapEventResolution, so
 * a hostname-resolved build with a slow Firestore read could let PostHog
 * finish first and fire its automatic initial `$pageview` (and start
 * session replay) BEFORE `registerAnalyticsDimensions` had even been
 * called — not merely before it had "applied" to the SDK, but before the
 * dimensions existed anywhere in this app's memory at all. Every render
 * path already GATES on `bootstrapEventResolution` resolving first (see
 * that function's own doc below), so starting PostHog here costs no extra
 * time-to-first-paint; it only guarantees PostHog's own init — and
 * therefore its first capture — never begins until AFTER dimension
 * registration has run (when the resolution is a `kind: 'event'`) or, for
 * every other outcome, after there was a chance to register at all.
 */
function startPostHogAfterResolution(): void {
  if (!isSyntheticProbe() && !isLocalDevHost(window.location.hostname)) void initPostHog();
}

// The out-of-tree half of the #342 force-reload floor (src/shellRecovery.ts).
// Runs HERE, at module scope, and not inside `UpdatePrompt` like the friendly
// banner path, because its whole job is to reach clients whose React tree never
// renders — the 2026-07-24 blank-screen incident, where the in-tree floor check
// died with the crash it was supposed to rescue. Fire-and-forget: it resolves
// to a no-op for every current build (the floor ships inert), and it is bounded
// by a one-attempt-per-tab guard so a misconfigured floor cannot reload-loop.
// Skipped for the uptime synthetic (#142) so a probe run is never a reload.
if (!isSyntheticProbe()) void enforceBuildFloor(__BUILD_STAMP__);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

/**
 * Resolve the active theme from the signed-in player's saved preference, then the
 * event's admin-set default, and hand it to ThemeProvider so a player's
 * cross-device choice or the configured event default is actually applied. A
 * locally-saved theme and an explicit in-session pick still win (see ThemeProvider).
 * `player?.theme` is handed down as `playerTheme` (NOT folded into
 * `defaultTheme`) so ThemeProvider can tell "the Player's own cross-device
 * pick" apart from "the event's Auto fallback" — see ThemeContext's
 * `playerTheme` doc (Codex P2 on #232).
 */
function ThemedApp() {
  const { user, loading } = useAuth();
  const { data: event } = useEventDoc(!!user);
  const { data: player } = useMyPlayer(user?.uid);
  // Edition default, not a hardcoded cruise Theme (#555). This line runs on the
  // signed-out shell too, where `useEventDoc(false)` means there is no Event doc
  // at all — so a Vacay build opened in Neon Playground and only changed skin
  // after sign-in, on the one pre-auth surface ADR 0009 says must be
  // Edition-correct (Codex on #577). `gcb` still resolves to neon-playground.
  const defaultTheme: ThemeId = event?.defaultTheme ?? defaultThemeForEdition();
  // `now` stands in for `Date.now()` in `todaysDayTheme` below, bumped by the
  // timer right after it — same pattern Board.tsx uses for its own unlock
  // rollover (Codex P2, PR #230). Without it, a Player who leaves the app
  // open across the next Day's `unlockAt` stays on the previous day's Auto
  // theme until an unrelated render (Codex P2 on #232).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const schedule = event?.days ?? [];
    const nextUnlock = schedule
      .map((d) => d.unlockAt)
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextUnlock == null) return;
    const timer = setTimeout(() => setNow(Date.now()), nextUnlock - Date.now());
    return () => clearTimeout(timer);
  }, [event?.days, now]);
  // Today's Day's theme (daily-cards-spec § "More menu" — Auto), resolved here
  // (Firestore-backed `event`) and handed down precomputed so ThemeContext
  // itself stays Firestore-free, mirroring `defaultTheme` above.
  const autoThemeId = todaysDayTheme(event, now);
  // The `day_index` analytics dimension (#556) — same Day-schedule
  // resolution as `autoThemeId` above, projected onto the index instead of
  // the theme. Registered (not threaded through every `track()` call) so
  // events with no Day context of their own — `login`, `share_click` — still
  // carry it, and re-registered whenever the resolved Day rolls over.
  const dayIndexDimension = todaysDayIndex(event, now);
  useEffect(() => {
    if (!isSyntheticProbe()) registerDayIndexDimension(dayIndexDimension);
  }, [dayIndexDimension]);
  // Tie PostHog events to the signed-in User by uid; clear on sign-out. (#96)
  // Kept here (not in AuthContext) so the analytics wiring stays out of the
  // protected src/auth/** path. Wait for auth to resolve (`!loading`) before
  // resetting: with autocaptured pageviews the initial `$pageview` fires at
  // init under an anonymous id, and an eager reset during Firebase's loading
  // state would orphan it under a discarded id instead of stitching it to the
  // signed-in user via identify. (Codex P2 on #195.)
  useEffect(() => {
    if (user?.uid) phIdentify(user.uid);
    else if (!loading) phReset();
  }, [user?.uid, loading]);
  // SPA pageviews are autocaptured by posthog-js (`capture_pageview:
  // 'history_change'`, see posthog.ts), so no manual pageview call is needed here.
  return (
    <ThemeProvider defaultTheme={defaultTheme} playerTheme={player?.theme ?? null} autoThemeId={autoThemeId}>
      <App />
    </ThemeProvider>
  );
}

const root = createRoot(rootEl);

const appTree = (
  <React.StrictMode>
    {/* Mounted outside the auth-gated tree (stable, non-frozen mount point —
        see #17) so the 18+ analytics disclosure shows even on the signed-out
        SignIn screen, since GA4's automatic events can fire before sign-in. */}
    <ConsentNotice />
    {/* Same stable mount point (#17, #30): offers installation even on the
        signed-out SignIn screen, since a Player may install before ever
        signing in. */}
    <InstallPrompt />
    {/* Same stable mount point again: a new deploy must be able to prompt a
        reload on every screen, signed-out SignIn included (#178). */}
    <UpdatePrompt />
    {/* Wraps ONLY the auth-gated tree, and sits BELOW the three toasts above on
        purpose (src/components/ErrorBoundary.tsx): a crash in the app must not
        be able to unmount `UpdatePrompt`, because that component is the only
        caller of `updateServiceWorker(true)` — i.e. the only in-app way a
        client ever moves off a broken build. Without the boundary React tears
        down the entire root, siblings included, and the client is stranded on
        the shell that just crashed (the 2026-07-24 blank-screen incident). */}
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <ThemedApp />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

/**
 * Resolve which Event this hostname serves BEFORE mounting (#543, ADR 0009).
 *
 * Gating the mount is the point: every Firestore path derives from `EVENT_ID`,
 * so mounting first and resolving later would start listeners against the wrong
 * Event and then swap it underneath them. On a single-Event build this
 * short-circuits to the env value without any network read, so the legacy
 * deployment pays nothing for this.
 *
 * The `.catch` is a hard blank-screen guard, not defensive habit.
 * `bootstrapEventResolution` is written never to throw and never to hang — the
 * fetch is timeout-raced and every branch returns a value — but this is the one
 * code path where an unexpected throw would render NOTHING at all, which is the
 * 2026-07-24 incident exactly. What it renders instead splits on the build
 * mode (`shouldMountOnBootstrapFailure`, Phase 4b P1 on #576): an env-pinned
 * build mounts, because its baked `EVENT_ID` is the correct Event and a blank
 * page on a phone in a rental house is not recoverable; a hostname-resolved
 * build fails CLOSED to the "unreachable" screen, because its pre-resolution
 * `EVENT_ID` is the legacy fallback and mounting would serve the legacy Event
 * on an arbitrary hostname with the auth-reachability gate skipped.
 */
void bootstrapEventResolution()
  .then((resolution) => {
    // Register the brand/edition/Event analytics dimensions (#556) as soon as
    // they are known, regardless of which branch below ends up rendering —
    // even the not-found and auth-blocked screens below fire GA4's automatic
    // events, so those screens should carry Event context too, same as
    // ConsentNotice's disclosure obligation a few lines down. Skipped for the
    // uptime synthetic (#142), matching `initPostHog`'s own guard above.
    if (resolution.kind === 'event' && !isSyntheticProbe()) {
      registerAnalyticsDimensions({ eventId: resolution.eventId, eventSlug: resolution.slug });
    }
    // Only NOW does PostHog itself start (#556, Phase 4b P1) — see
    // `startPostHogAfterResolution`'s own doc for why this ordering is
    // load-bearing, not incidental.
    startPostHogAfterResolution();
    // An Event can resolve on an origin the AUTH stack has never been
    // configured for — hostname resolution is exactly what made that possible
    // (ADR 0010 § not-yet-implemented; Codex P1 on #576). Mounting the app there
    // would render a Google button that cannot return to this origin, so it is
    // reported as a state rather than discovered mid-sign-in. "Reachable" is
    // deliberately wider than "configured": `gaycruisebingo.web.app` mounts so
    // AuthProvider's documented handoff to `firebaseapp.com` can run
    // (src/auth-domain.ts, Codex P1 round 5 on #576).
    const authBlocked =
      resolution.kind === 'event' &&
      !isSignInReachableOnHost(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, window.location.hostname);
    if (authBlocked) {
      root.render(
        <React.StrictMode>
          <EventNotFound hostname={window.location.hostname} reason="auth-unconfigured" />
          <ConsentNotice />
        </React.StrictMode>,
      );
      return;
    }
    root.render(
      resolution.kind === 'not-found' ? (
        <React.StrictMode>
          <EventNotFound hostname={resolution.hostname} reason={resolution.reason} />
          {/* The 18+ analytics disclosure has to survive this branch too. GA4
              loads on `firebase.ts` import, and `startPostHogAfterResolution()`
              a few lines above already ran for this outcome too, so collection
              has ALREADY started by the time we decide NOT to mount the app —
              and this is exactly the branch a first-time visitor to an unknown
              wildcard host lands on (Codex on #576). Safe to put beside the
              deliberately dependency-free not-found screen: `ConsentNotice`
              imports `useState` and nothing else — no auth, no Firestore, no
              router, no theme — so it cannot become a new way for the
              fallback itself to fail. */}
          <ConsentNotice />
        </React.StrictMode>
      ) : (
        appTree
      ),
    );
  })
  .catch(() => {
    // The resolution promise itself rejected — no dimensions could have been
    // registered either way, but PostHog still needs to run for whichever
    // screen renders below (same disclosure obligation as the other
    // branches).
    startPostHogAfterResolution();
    if (shouldMountOnBootstrapFailure(import.meta.env.VITE_EVENT_ID || null)) {
      root.render(appTree);
      return;
    }
    root.render(
      <React.StrictMode>
        <EventNotFound hostname={window.location.hostname} reason="unreachable" />
        {/* Same disclosure obligation as the not-found branch above: analytics
            started via the `startPostHogAfterResolution()` call above before
            this decision was made. */}
        <ConsentNotice />
      </React.StrictMode>,
    );
  });
