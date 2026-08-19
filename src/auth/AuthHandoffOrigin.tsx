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
 * ALWAYS REDIRECT, NEVER POPUP, and this is the one place in the app where that
 * is unconditionally right. `AuthContext` picks between popup and redirect
 * because it is protecting live app state and an installed-PWA window that loses
 * its OAuth popup (#395, #347). This page has no state to lose: everything it
 * needs is in its own query string, which survives the round trip in the address
 * bar, and its OAuth helper is same-origin by construction (the host is in
 * `FIRST_PARTY_AUTH_HOSTS`, which is exactly the condition under which
 * `AuthContext` itself calls redirect stable). So there is no UA sniffing here
 * and no second copy of that decision to drift.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRedirectResult, onAuthStateChanged, signInWithRedirect } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { parseHandoffRequest, type HandoffRequest } from './handoffClient';
import { mintAuthHandoff } from './handoffExchange';

type Phase =
  /** Working out whether a session already exists here. */
  | 'checking'
  /** Leaving for Google, or coming back from it. */
  | 'authenticating'
  /** Signed in; minting the code and bouncing. */
  | 'minting'
  /** Terminal. Nothing retries itself from here. */
  | 'failed';

/**
 * Why the bounce did not happen. Operator-facing, because a player never
 * navigates here by hand — they arrive from a Sign in tap on an Event origin, so
 * anything that goes wrong is a provisioning or configuration fault.
 */
type FailureKind = 'bad-request' | 'sign-in-failed' | 'mint-failed';

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

export default function AuthHandoffOrigin({
  search = window.location.search,
  navigate = replaceLocation,
}: {
  search?: string;
  /** Injected for tests, matching `startAuthHandoff`'s seam. Always a `replace`. */
  navigate?: (url: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [failure, setFailure] = useState<FailureKind | null>(null);

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
    let minted = false;

    const bounce = async (req: HandoffRequest) => {
      if (minted) return;
      minted = true;
      setPhase('minting');
      try {
        const handoffUrl = await mintAuthHandoff(req);
        if (cancelled) return;
        // VERBATIM, and `replace` rather than `assign`: the server built this
        // URL precisely so no client assembles a redirect target, and leaving
        // the central origin in history would put a spent handoff URL one Back
        // tap away.
        navigate(handoffUrl);
      } catch {
        if (!cancelled) fail('mint-failed');
      }
    };

    // Settle the redirect return FIRST. A REJECTION here is TERMINAL, not an
    // ordinary first visit (Codex P2, round 1): an ordinary first visit resolves
    // `null`, so a rejection means Google returned an OAuth error or the player
    // cancelled. Swallowing it would leave the observer below seeing a
    // signed-out user and firing `signInWithRedirect` again — bouncing the
    // player back to Google in a loop instead of showing them the failure.
    void getRedirectResult(auth).then(
      () => {
        if (cancelled) return;
        // Then ask the session itself rather than trusting the result above: a
        // player who already has a session at this origin (a second Event, or a
        // reload) must mint straight away and never see Google at all.
        unsubscribe = onAuthStateChanged(auth, (user) => {
          if (cancelled || handled) return;
          handled = true;
          if (user !== null) {
            void bounce(request);
            return;
          }
          setPhase('authenticating');
          void signInWithRedirect(auth, googleProvider).catch(() => {
            if (!cancelled) fail('sign-in-failed');
          });
        });
      },
      () => {
        if (!cancelled) fail('sign-in-failed');
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [request, fail, navigate]);

  const body =
    phase === 'failed' && failure !== null
      ? COPY[failure]
      : { headline: 'Signing you in…', detail: 'One moment — we are taking you back to your event.' };

  return (
    <main
      style={{
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
      }}
    >
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
