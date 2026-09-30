/**
 * The central auth origin's only page (#549, ADR 0010).
 *
 * This is what `auth.fiveacross.app` serves. It is not part of the app: it
 * mounts INSTEAD of the app, before Event resolution runs, because the central
 * origin serves no Event and would otherwise resolve to the not-found screen. It
 * has one job — turn "somebody wants to sign in for that Event origin" into "the
 * browser is at that Event origin holding a handoff code" — and then it is gone.
 *
 * Dependency-free in the same way `EventNotFound` is: no AuthProvider, no
 * router, no theme, no Firestore. It talks to the `auth` singleton and one
 * callable directly. Anything else it imported would be a new way for the
 * sign-in origin itself to fail, and a failure here takes down sign-in for every
 * Event at once.
 *
 * ALWAYS REDIRECT, NEVER POPUP, and this page shares that rule with `AuthContext`
 * rather than carrying its own copy (#765): `AuthContext` redirects on every
 * surface whose OAuth handler is same-origin and keeps the popup only for a
 * cross-origin handler (local development, the Auth Emulator); the device
 * matrix that once protected live app state and installed-PWA windows (#395,
 * #347) is gone. This page has no state to lose: everything it needs is in its
 * own query string, which survives the round trip in the address bar, and its
 * OAuth helper is same-origin by construction (the host is in
 * `FIRST_PARTY_AUTH_HOSTS`), so it sits squarely inside the redirect branch.
 * There is no UA sniffing here and no second copy of that decision to drift.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { parseHandoffRequest, type HandoffRequest } from './handoffClient';
import { mintAuthHandoff } from './handoffExchange';

/**
 * How long the central-origin page may spend before it gives up, in ms (#899).
 *
 * The return leg already bounds its network work so captive and shipboard wifi
 * cannot hold the mount forever; this page had no such bound, so a
 * `getRedirectResult`, auth-state settlement, or `mintAuthHandoff` that never
 * settles left the player on "Signing you in…" indefinitely — the same failure,
 * on the origin whose failure takes sign-in down for every Event at once.
 *
 * Longer than the return leg's 15s because this page legitimately waits on a
 * full Google round trip before it can mint, and a premature failure here sends
 * the player back to an Event origin with nothing to show for it.
 */
export const HANDOFF_ORIGIN_TIMEOUT_MS = 30_000;

type Phase =
  /** Working out whether a session already exists here. */
  | 'checking'
  /** Leaving for Google, or coming back from it. */
  | 'authenticating'
  /**
   * A session already exists at this origin and NO Google round trip happened
   * in this flow: the page waits for the person at the keyboard to say which
   * account goes to the Event before anything is minted.
   */
  | 'confirm'
  /** Signed in; minting the code and bouncing. */
  | 'minting'
  /** Terminal. Nothing retries itself from here. */
  | 'failed';

/**
 * Why the bounce did not happen. Operator-facing, because a player never
 * navigates here by hand — they arrive from a Sign in tap on an Event origin, so
 * anything that goes wrong is a provisioning or configuration fault.
 */
type FailureKind = 'bad-request' | 'sign-in-failed' | 'mint-failed' | 'account-changed';

const COPY: Record<FailureKind, { headline: string; detail: string }> = {
  'bad-request': {
    headline: 'This sign-in link is incomplete',
    detail:
      'Go back to the event address you started from and tap Sign in again. If you typed this address directly, there is nothing to sign in to here.',
  },
  'sign-in-failed': {
    headline: "Google sign-in didn't finish",
    detail: 'Nothing was changed. Try again, or go back to the event address and start over.',
  },
  'mint-failed': {
    headline: "We couldn't return you to your event",
    detail:
      'You are signed in, but this event address is not one we can hand you back to. Check the link you were sent, or ask whoever set the event up.',
  },
  'account-changed': {
    headline: 'The signed-in account changed',
    detail:
      'Another tab signed in or out while this page was waiting, so nothing was sent. Go back to the event address and tap Sign in again.',
  },
};

/**
 * Module scope, NOT an inline default, and that matters more than it looks. An
 * inline arrow would be a fresh identity on every render, which would change the
 * `bounce` callback, which would change the effect's dependencies, which would
 * tear down an in-flight sign-in — and the once-guard would then refuse to
 * re-arm it, leaving the page spinning forever.
 */
function replaceLocation(url: string): void {
  window.location.replace(url);
}

/**
 * The provider "Use another account" sends the player to. `prompt:
 * select_account` makes Google show its account chooser even when one Google
 * session is live in the browser, which is the whole point of the button; the
 * shared `googleProvider` is left alone so no other sign-in changes behaviour.
 */
function accountChooserProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

/** The host a player is being returned to, as it reads in the address bar. */
function targetHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const PAGE_STYLE = {
  minHeight: '100dvh',
  display: 'grid',
  placeItems: 'center',
  padding: '2rem 1.5rem',
  // Literal colours for the same reason EventNotFound uses them: the theme
  // layer is part of the app this page deliberately does not mount.
  background: '#0b0f14',
  color: '#eef2f6',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  textAlign: 'center',
} as const;

const BUTTON_STYLE = {
  font: 'inherit',
  fontSize: '1rem',
  fontWeight: 600,
  padding: '0.85rem 1.25rem',
  borderRadius: '0.75rem',
  border: 'none',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
} as const;

export default function AuthHandoffOrigin({
  search = window.location.search,
  navigate = replaceLocation,
  timeoutMs = HANDOFF_ORIGIN_TIMEOUT_MS,
}: {
  search?: string;
  /** Injected for tests, matching `startAuthHandoff`'s seam. Always a `replace`. */
  navigate?: (url: string) => void;
  /** Overridable so tests do not have to wait out the real deadline. */
  timeoutMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** Who the existing session is, shown on the confirmation. */
  const [accountLabel, setAccountLabel] = useState<string>('');
  /**
   * The confirmation's two actions, published by the effect that owns the
   * flow's locals (see the StrictMode note below). `null` whenever the page is
   * not waiting on the player, so a stale click can do nothing.
   */
  const confirmActions = useRef<{ proceed: () => void; switchAccount: () => void } | null>(null);

  // Memoised for the same reason `navigate` is hoisted to module scope: a fresh
  // object each render would change the effect's dependencies, and this effect
  // owns an in-flight sign-in that must not be torn down and restarted by an
  // unrelated re-render.
  const request: HandoffRequest | null = useMemo(() => parseHandoffRequest(search), [search]);

  const fail = useCallback((kind: FailureKind) => {
    setFailure(kind);
    setPhase('failed');
  }, []);

  // EVERYTHING lives inside the effect, with plain locals instead of refs, and
  // that is the fix for a StrictMode hang rather than a style preference (Codex
  // P2, round 1). React 18 StrictMode runs setup, cleanup, then setup again in
  // development. Module-lifetime refs used as once-guards survive that cleanup,
  // so the second setup saw "already started, already minted" and returned
  // without doing anything — while the first setup's continuations had been
  // marked cancelled. The page then sat on "Signing you in…" forever, on the one
  // origin every Event depends on for sign-in, in exactly the environment it is
  // developed in. Effect-scoped locals are re-created by the second setup, so
  // the replay proceeds correctly; in production the effect runs once and the
  // cleanup only fires when the page is leaving anyway.
  useEffect(() => {
    if (request === null) {
      fail('bad-request');
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    // The observer acts at most once per setup. A flag rather than
    // unsubscribing from inside the callback, because `onAuthStateChanged` may
    // invoke its observer SYNCHRONOUSLY when the auth state is already known —
    // in which case the callback runs before the returned unsubscribe function
    // has been assigned, and reaching for it there is a temporal-dead-zone
    // throw.
    let handled = false;
    /**
     * The uid the player is being asked to confirm, once the confirmation is
     * on screen. Another same-origin tab can replace the shared Auth session
     * while the prompt waits, and the mint callable authenticates as whoever
     * is current when it runs — so the confirmed uid is re-checked here, and
     * sent to the server, which refuses to mint for any other uid.
     */
    let confirmedUid: string | null = null;
    let minted = false;
    let settled = false;

    // One terminal deadline for the whole page (#899). It covers every await
    // below — the redirect settle, the auth-state settle, and the mint — rather
    // than bounding each, because the player-facing question is simply whether
    // this page ever reaches an actionable state.
    //
    // TERMINAL MEANS TERMINAL (Phase 4b P1). Calling `fail()` alone was not
    // enough: the in-flight continuations were still live, so a
    // `getRedirectResult`, auth observer, or `mintAuthHandoff` that settled
    // afterwards could still navigate the browser away from the failure the
    // player was already looking at. Timing out therefore cancels the effect's
    // continuations and drops the auth subscription, exactly as unmounting does.
    /**
     * The ONE way this effect reaches a failure, and the only place that
     * decides what the player ends up reading (Phase 4b P2).
     *
     * Every failure has to be terminal, not just the deadline's. A
     * `fail('mint-failed')` that left the timer armed and the observer
     * subscribed meant the deadline fired thirty seconds later and REPLACED an
     * accurate "we couldn't return you to your event" with a generic sign-in
     * failure — the page actively getting less truthful the longer the player
     * looked at it. Routing every path through here means the first real
     * outcome wins and nothing can overwrite it.
     */
    // Declared before `terminate` closes over it. Runtime ordering happens to be
    // safe here — nothing calls `terminate` before the timer is armed — but a
    // closure reaching a `const` declared below it is exactly the
    // temporal-dead-zone shape that already produced one bug on this page, and
    // "safe because of call ordering" is not a property worth depending on.
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const terminate = (kind: FailureKind) => {
      if (cancelled || settled) return;
      settled = true;
      cancelled = true;
      clearTimeout(deadline);
      unsubscribe?.();
      fail(kind);
    };

    // Which failure the deadline reports depends on how far the page got
    // (Phase 4b P2). Once minting has started the player IS signed in at this
    // origin, so "Google sign-in didn't finish / nothing was changed" is simply
    // untrue — the accurate statement is that we could not return them.
    const arm = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => terminate(minted ? 'mint-failed' : 'sign-in-failed'), timeoutMs);
    };
    arm();

    const sendToGoogle = (provider = googleProvider) => {
      // The deadline stays ARMED across this call, deliberately (Phase 4b
      // P1). Disarming it here — before the navigation actually starts —
      // was the inverse of the bug above: a `signInWithRedirect` that hangs
      // on initiation would then spin forever with nothing left to catch
      // it. Leaving the timer running costs nothing on the happy path,
      // because a successful redirect unloads the page and takes the timer
      // with it; on a hung one it is the only thing that can still rescue
      // the player.
      setPhase('authenticating');
      void signInWithRedirect(auth, provider).catch(() => {
        terminate('sign-in-failed');
      });
    };

    const bounce = async (req: HandoffRequest, expectedUid: string) => {
      if (minted) return;
      minted = true;
      setPhase('minting');
      try {
        const handoffUrl = await mintAuthHandoff(req, { expectedUid });
        if (cancelled) return;
        // NAVIGATE FIRST, then mark settled (Phase 4b P2). Setting the guard
        // before attempting the navigation meant a `replace` that THREW — a
        // malformed URL, a restricted navigation — fell into the catch below,
        // where `terminate` returned immediately because `settled` was already
        // true. The page then sat on the minting spinner forever with the
        // deadline already cleared: no error, no timeout, no way out. The guard
        // is only correct once the navigation has actually been initiated.
        // VERBATIM, and `replace` rather than `assign`: the server built this
        // URL precisely so no client assembles a redirect target, and leaving
        // the central origin in history would put a spent handoff URL one Back
        // tap away.
        navigate(handoffUrl);
        settled = true;
        clearTimeout(deadline);
      } catch {
        terminate('mint-failed');
      }
    };

    // Settle the redirect return FIRST. A REJECTION here is TERMINAL, not an
    // ordinary first visit (Codex P2, round 1): an ordinary first visit resolves
    // `null`, so a rejection means Google returned an OAuth error or the player
    // cancelled. Swallowing it would leave the observer below seeing a
    // signed-out user and firing `signInWithRedirect` again — bouncing the
    // player back to Google in a loop instead of showing them the failure.
    void getRedirectResult(auth).then(
      (redirectResult) => {
        if (cancelled) return;
        // Whether THIS flow just came back from Google. A non-null result is the
        // credential of a sign-in the player completed seconds ago, for this
        // very request; `null` means the session below (if any) predates it.
        const cameBackFromGoogle = redirectResult != null;
        // Then ask the session itself rather than trusting the result above.
        unsubscribe = onAuthStateChanged(auth, (user) => {
          if (cancelled) return;
          if (handled) {
            // A LATER transition while the confirmation is still on screen: the
            // account the prompt names is no longer the one a mint would use.
            // Withdraw the prompt rather than let Continue act on a stale name.
            // (`switchAccount` clears the actions before it signs out, so its
            // own sign-out never lands here.)
            if (confirmActions.current !== null && user?.uid !== confirmedUid) {
              confirmActions.current = null;
              terminate('account-changed');
            }
            return;
          }
          handled = true;
          if (user !== null && cameBackFromGoogle) {
            void bounce(request, user.uid);
            return;
          }
          if (user !== null) {
            // A session that PREDATES this flow — a second Event, a reload, or
            // somebody else's sign-in on a shared device. Minting on it
            // silently would hand whoever opened this URL a code for that
            // account, and the `txn` is caller-chosen, so the page would be a
            // one-click way to sign a stranger's device in as the last person
            // who used it. The person at the keyboard confirms the account (or
            // switches) before anything is minted. The deadline is disarmed
            // while they read: it bounds this page's own work, not a human
            // decision, and re-arms the moment they choose.
            clearTimeout(deadline);
            confirmedUid = user.uid;
            setAccountLabel(user.email ?? user.displayName ?? 'your Google account');
            confirmActions.current = {
              proceed: () => {
                if (cancelled || minted) return;
                confirmActions.current = null;
                // Fail closed if the session moved since the prompt rendered;
                // the server repeats this check against the callable's own uid.
                if (auth.currentUser?.uid !== confirmedUid) {
                  terminate('account-changed');
                  return;
                }
                arm();
                void bounce(request, user.uid);
              },
              switchAccount: () => {
                if (cancelled || minted) return;
                confirmActions.current = null;
                arm();
                setPhase('authenticating');
                // Sign the central session OUT first, so the account that was
                // here cannot be minted for by anything that follows, then let
                // Google's chooser pick. The return leg lands back on this page
                // with a fresh redirect result and mints for the chosen account.
                void signOut(auth).then(
                  () => {
                    if (!cancelled) sendToGoogle(accountChooserProvider());
                  },
                  () => terminate('sign-in-failed'),
                );
              },
            };
            setPhase('confirm');
            return;
          }
          sendToGoogle();
        });
      },
      () => {
        terminate('sign-in-failed');
      },
    );

    return () => {
      cancelled = true;
      confirmActions.current = null;
      clearTimeout(deadline);
      unsubscribe?.();
    };
  }, [request, fail, navigate, timeoutMs]);

  if (phase === 'confirm' && request !== null) {
    const host = targetHost(request.targetOrigin);
    return (
      <main style={PAGE_STYLE}>
        <div style={{ maxWidth: '32rem' }}>
          <p style={{ fontSize: '2.5rem', margin: '0 0 0.75rem' }} aria-hidden="true">
            🔑
          </p>
          <h1 style={{ fontSize: '1.5rem', lineHeight: 1.25, margin: '0 0 0.75rem' }}>
            Continue to {host}?
          </h1>
          <p style={{ margin: '0 0 1.5rem', lineHeight: 1.55, color: '#a9b7c4' }}>
            You are signed in here as <strong style={{ color: '#eef2f6' }}>{accountLabel}</strong>.
          </p>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => confirmActions.current?.proceed()}
              style={{ ...BUTTON_STYLE, background: '#eef2f6', color: '#0b0f14' }}
            >
              Continue to {host} as {accountLabel}
            </button>
            <button
              type="button"
              onClick={() => confirmActions.current?.switchAccount()}
              style={{ ...BUTTON_STYLE, background: 'transparent', color: '#eef2f6', border: '1px solid #3a4652' }}
            >
              Use another account
            </button>
          </div>
        </div>
      </main>
    );
  }

  const body =
    phase === 'failed' && failure !== null
      ? COPY[failure]
      : { headline: 'Signing you in…', detail: 'One moment — we are taking you back to your event.' };

  return (
    <main style={PAGE_STYLE}>
      <div style={{ maxWidth: '32rem' }}>
        <p style={{ fontSize: '2.5rem', margin: '0 0 0.75rem' }} aria-hidden="true">
          {phase === 'failed' ? '🌫️' : '🔑'}
        </p>
        <h1 style={{ fontSize: '1.5rem', lineHeight: 1.25, margin: '0 0 0.75rem' }}>
          {body.headline}
        </h1>
        <p
          style={{ margin: 0, lineHeight: 1.55, color: '#a9b7c4' }}
          role={phase === 'failed' ? 'alert' : 'status'}
        >
          {body.detail}
        </p>
      </div>
    </main>
  );
}
