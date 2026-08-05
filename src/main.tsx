import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ThemeProvider } from './theme/ThemeContext';
import { todaysDayTheme } from './theme/autoTheme';
import { defaultThemeForEdition } from './theme/themes';
import { useEventDoc, useMyPlayer } from './hooks/useData';
import { initPostHog, phIdentify, phReset, isLocalDevHost } from './posthog';
import { isSyntheticProbe } from './synthetic-probe';
import type { ThemeId } from './types';
import App from './App';
import ConsentNotice from './components/ConsentNotice';
import ErrorBoundary from './components/ErrorBoundary';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import { enforceBuildFloor } from './shellRecovery';
import './theme/themes.css';
import './index.css';

// Initialize client-side PostHog once (alongside GA4). No-op without a key (#96),
// skipped for the uptime synthetic (#142), and skipped on local-dev hosts (#194)
// so dev sessions and Vite HMR errors never pollute production analytics or
// session replays. All ph* calls guard on init, so skipping this suppresses
// PostHog entirely for those loads.
if (!isSyntheticProbe() && !isLocalDevHost(window.location.hostname)) void initPostHog();

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

createRoot(rootEl).render(
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
  </React.StrictMode>,
);
