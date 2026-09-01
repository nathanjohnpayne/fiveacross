import { type ReactElement } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import SignIn, { DealError } from './components/SignIn';
import CachedCardFallback from './components/CachedCardFallback';
import { loadCardSnapshot } from './data/cardCache';
import Nav from './components/Nav';
import SuggestPanelBridge from './components/SuggestPanelBridge';
import Board from './components/Board';
import NoticeBanner from './components/NoticeBanner';
import Leaderboard from './components/Leaderboard';
import ProofFeed from './components/ProofFeed';
import More from './components/More';
import { BugReportProvider } from './components/BugReport';
import PullToRefresh from './components/PullToRefresh';
import { TABS, FALLBACK_PATH, type TabId } from './components/tabs';
import LoadingState from './components/LoadingState';
import { editionBrand } from './editions';
import SetupWizard from './components/setup/SetupWizard';
import { EVENT_ID } from './firebase';

export default function App() {
  // One hard boundary for every Event-owned route and overlay. Listener hooks
  // still neutralize their first mismatched frame, while this keyed remount
  // clears local UI that is not itself a subscription: an open Feed who-list,
  // a half-composed Notice, paging windows, sheets, and retry controls. The
  // Auth/Theme providers live above App, so global identity and preferences
  // deliberately survive the same A → B transition.
  return <EventApp key={EVENT_ID} />;
}

function EventApp() {
  const { user, loading, dealError, dealErrorReason, dealing, retryDeal, canRenderEventContent } = useAuth();
  // The tab-switch transition's key (specs/motion-polish.md): the TOP-LEVEL
  // route segment only, so `.route-view` replays its entrance when the tab
  // changes but sub-navigation inside a tab (More → admin → section) never
  // re-animates the page it is already on.
  const location = useLocation();
  const section = location.pathname.split('/')[1] || 'card';

  // The one pre-auth label the Edition owns (#608): this renders before the
  // Event doc exists, so the resolved Edition is the only vocabulary available.
  if (loading) return <LoadingState label={editionBrand().passCheckLabel} />;
  if (!user) return <SignIn />;
  // `canRenderEventContent` is the authority boundary, not merely a condition
  // on the cached-card fallback. A failed server attestation read leaves the
  // signed-in shell otherwise usable, including Feed/More routes; rendering it
  // here would expose Event content while the 18+ posture is known but the
  // Player's acknowledgement is not. During a reconnect/posture transition,
  // keep the whole shell on Loading until authority settles. A settled failure
  // keeps the existing retry surface, now globally rather than only on Card.
  if (canRenderEventContent === false) {
    return dealError ? (
      <DealError message={dealError} onRetry={retryDeal} retrying={dealing} />
    ) : (
      <LoadingState label={editionBrand().passCheckLabel} />
    );
  }

  // Frozen route -> page-component mapping, one entry per stable mount
  // point in `./components/tabs`. `Record<TabId, ReactElement>` makes the
  // mapping exhaustive at compile time: adding a tab to `TABS` without a
  // matching page here fails `npm run typecheck`. Wave-1+ tickets change
  // what THEIR tab renders inside their own component file, not this map.
  //
  // Card is this ticket's exception: the client-driven deal (ADR 0001) used to
  // fail into a swallowed `.catch`, leaving a blank Board. A failure — most
  // often the ADR-0003/0004 pool-below-24 guard — now renders the retry surface
  // AS the Card tab's content, scoped there so the shell, Nav, and every other
  // route stay mounted while the error is up (Codex P2). `AuthContext` owns the
  // deal + error state.
  //
  // #434: on a CONNECTION-class deal failure, PREFER this device's latest durable
  // card snapshot over the full-screen reload screen. A Player who was already
  // dealt in still sees their card (read-only, refreshing in the background via
  // Retry) instead of a dead-end — the exact "it should be cached and load in the
  // background" ask. `loadCardSnapshot` is a synchronous localStorage read (no
  // network), scoped to this event + uid; Board writes the snapshot whenever it
  // paints a real card.
  //
  // Gated on `dealErrorReason === 'connection'` and AuthContext's explicit render
  // authorization so the fallback NEVER hides an actionable error and never uses a
  // saved card as proof-of-18+. A pool-shortfall keeps its own DealError ("ask an
  // admin to add prompts", which PoolRecoveryWatcher also auto-recovers on the
  // reason). This mirrors the #403 swallow, which excludes pool-shortfall for the
  // same reason. The full DealError also stays for a genuine first-timer with
  // nothing cached.
  //
  // Phase 1.5 (#203): Prompts (ItemPool) and Admin are no longer routed,
  // tab-driven pages — they mount inside the More tab's menu (#208), not the
  // route table. The set is Card · Feed · Ranks · More.
  const cachedCard =
    dealError && dealErrorReason === 'connection' && canRenderEventContent ? loadCardSnapshot(user.uid) : null;
  const pages: Record<TabId, ReactElement> = {
    // A pinned admin Notice shows once as a dismissible banner above WHATEVER the
    // Card tab renders (specs/admin-messages.md): the live Board, the durable
    // cached-card fallback, OR the DealError retry surface (Codex P2, PR #440) — a
    // pinned Notice already in Firestore's offline cache must reach every signed-in
    // Player, including the ones hitting a startup problem, which is exactly who an
    // urgent admin message is for. The banner self-gates to nothing when none is
    // pinned or this device already dismissed it, so each card state is otherwise
    // unchanged. Mounted once, outside the deal-state conditional.
    card: (
      <>
        <NoticeBanner />
        {dealError ? (
          cachedCard ? (
            <CachedCardFallback snapshot={cachedCard} onRetry={retryDeal} retrying={dealing} />
          ) : (
            <DealError message={dealError} onRetry={retryDeal} retrying={dealing} />
          )
        ) : (
          <Board />
        )}
      </>
    ),
    feed: <ProofFeed />,
    ranks: <Leaderboard />,
    more: <More />,
  };

  return (
    <div className="app">
      {/* The confirm-path Moment emitter (#41) is mounted in AuthProvider so it
          survives the attestation gate (Codex #116 R3 finding 2), not here. */}
      {/* BugReportProvider hosts the report sheet + pick-a-screen bar at the
          shell so the flow survives tab navigation; More's Support row is just
          the launcher (#324, specs/w4-bug-report-inbox.md). Inside `.app` so
          the surface stays under captureAppSurface()'s own exclusion marker. */}
      <BugReportProvider>
        {/* Shell chrome (specs/pull-to-refresh.md): one gesture surface for
            every tab — pull from the very top of any page to reload
            (reconnects wedged listeners, picks up a fresh deploy). */}
        <PullToRefresh />
        <Nav />
        {/* Card/Feed → More "Suggest a square" navigation bridge (#559) — see
            SuggestPanelBridge.tsx for why it's mounted here rather than
            inside Board.tsx. Renders nothing. */}
        <SuggestPanelBridge />
        {/* Keyed per top-level section so switching tabs replays the page-in
            rise (index.css `.route-view`); the wrapper is a plain block, so
            layout inside is unchanged. */}
        <div className="route-view" key={section}>
        <Routes>
          {/* The More tab alone mounts with a splat (specs/admin-console-ia.md):
              the admin console lives at REAL sub-routes (/more/admin[/section])
              rendered by More itself, so the browser/PWA back button walks
              admin detail → hub → More. The TAB SET is unchanged — this is
              sub-navigation inside the frozen `more` mount point, not a new
              tab (./components/tabs stays the one source of truth). */}
          {TABS.map((tab) => (
            <Route key={tab.id} path={tab.id === 'more' ? `${tab.path}/*` : tab.path} element={pages[tab.id]} />
          ))}
          {/* The organizer setup wizard (#788, specs/event-setup-wizard.md): a
              plain sibling route, NOT a tab — `./components/tabs` stays frozen
              and the wizard's own sub-navigation (draft id + step) is parsed
              inside SetupWizard itself, mirroring the More/admin `path="*"`
              splat pattern above. Where the wizard is ultimately reachable
              from is #766's call; this route only makes it mountable. Must
              stay before the catch-all below. */}
          <Route path="/setup/*" element={<SetupWizard />} />
          <Route path="*" element={<Navigate to={FALLBACK_PATH} replace />} />
        </Routes>
        </div>
      </BugReportProvider>
    </div>
  );
}
