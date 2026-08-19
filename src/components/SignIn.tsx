import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAdultContent } from '../hooks/useAdultContent';
import { editionBrand } from '../editions';
import { resolveSignInStrategy } from '../auth/authMode';
import { consumeHandoffFailure, startAuthHandoff } from '../auth/handoffClient';
import EventPostcard from './EventPostcard';

// The wordmark, the signed-out line and the offline note come from the resolved
// EDITION (#543, src/editions.ts), not from constants. They cannot come from the
// Event doc: `events/{eventId}` requires `signedIn()`, so the only Edition signal
// that exists on the screen whose job is to get you signed in is the one
// `hostnames/{host}` supplied before mount. Hardcoding them was correct while one
// build served one hostname; once the resolver ships, a Bodega guest would have
// opened the app to another product's name and a cruise that is not happening
// (Codex on #576).
//
// One 18+ acknowledgement, two entry points (#23):
//   • signed OUT → the sign-in gate App renders on `!user`: the checkbox gates
//     Google sign-in, which PERSISTS the attestation after the popup
//     (AuthContext.signIn → attest).
//   • signed IN but un-attested → the re-prompt gate AuthProvider renders when a
//     SETTLED profile lacks `attestedAdultAt`: the checkbox records the persisted
//     self-attestation before the Board.
// Either way the checkbox now drives a PERSISTED write, not just ephemeral local
// state — an honor-system self-statement, never identity verification (ADR 0001).
//
// …and the checkbox itself is now CONDITIONAL (#608). The 18+ posture follows
// the Event's content, not its Edition: `hostnames/{host}.adultContent` is
// server-derived from whether the pool holds explicit Prompts, resolved pre-auth
// alongside the Edition, and fails closed to `true`. An Event with a tame pool
// shows no acknowledgement and no age claim, and its Continue button is enabled
// on load — asking a wedding party to confirm they are 18 is not a harmless
// extra tap, it mislabels the product. The re-prompt entry point cannot be
// reached at all in that posture (AuthProvider's `needsAttestation` gates on the
// same flag), so this component only ever renders `reprompt` with the box shown.
export default function SignIn() {
  const { user, signIn, signInReady, attest } = useAuth();
  const reprompt = user != null;
  const adult = useAdultContent();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const brand = editionBrand();
  // A handoff that failed BEFORE this tree existed (#549). `main.tsx` completes
  // the return leg pre-mount, so a failure there has nowhere to surface until
  // this screen renders — which it does, because a failed handoff leaves the
  // player signed out and lands them right here. Read once, at first render, so
  // a later re-render cannot resurrect a stale message.
  const [handoffFailed] = useState(() => consumeHandoffFailure() !== null);
  const [startFailed, setStartFailed] = useState(false);

  const go = async () => {
    setBusy(true);
    setStartFailed(false);
    try {
      if (reprompt) {
        await attest();
        return;
      }
      // Which route sign-in takes from this origin (#549, ADR 0010). Resolved at
      // TAP time, from the same function `main.tsx` gated the mount on, so the
      // button can never take a route the mount gate judged unusable.
      const strategy = resolveSignInStrategy({
        mode: import.meta.env.VITE_AUTH_MODE,
        configuredAuthDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        hostname: window.location.hostname,
        handoffOrigin: import.meta.env.VITE_AUTH_HANDOFF_ORIGIN,
        currentOrigin: window.location.origin,
        // Come back where they started, not to the root — the handoff is
        // invisible plumbing and should not also lose the player's place.
        returnPath: `${window.location.pathname}${window.location.search}`,
      });

      if (strategy.kind === 'handoff') {
        // Leaves this origin, so nothing after it runs on success and `busy`
        // stays true through the navigation — which is what we want: the button
        // must not re-arm while the browser is on its way out.
        //
        // KNOWN GAP, tracked as #895 (blocked by #836): the 18+ acknowledgement
        // collected here does not ride along. `AuthContext`'s acknowledgement
        // record is consumed by its `getRedirectResult` effect, and a handoff
        // return signs in with a custom token instead, so the record is
        // discarded unused. The consequence is one extra tap — a returning
        // player meets AuthProvider's existing 18+ re-prompt and attests there —
        // and that is the direction this has to fail in: fabricating a durable,
        // cross-Event `attestedAdultAt` for a box nobody saw would be the
        // genuinely bad outcome. Do not close it by relaxing the check; see #895
        // for why the evidence has to stay transaction-scoped.
        const started = await startAuthHandoff({
          authOrigin: strategy.authOrigin,
          targetOrigin: strategy.targetOrigin,
          returnPath: strategy.returnPath,
        });
        if (!started) {
          // Drain the module-level channel as well as showing the local message
          // (Phase 4b P2). `startAuthHandoff` records `start-failed` there too,
          // and an unconsumed entry outlives this screen: a later retry could
          // succeed, navigate, exchange, and then the NEXT SignIn mount — the
          // post-handoff 18+ re-prompt, or a later sign-out — would greet the
          // player with "That sign-in didn't finish" about a sign-in that did.
          consumeHandoffFailure();
          setStartFailed(true);
          setBusy(false);
        }
        return;
      }

      if (strategy.kind === 'unavailable') {
        // Unreachable in practice — `main.tsx` renders its own screen instead of
        // mounting the app at all. Handled anyway rather than falling through to
        // `signIn()`, because falling through IS the silent cross-mode fallback
        // ADR 0010 forbids.
        setStartFailed(true);
        setBusy(false);
        return;
      }

      // Pass the acknowledgement THIS render actually collected. Re-reading
      // the mutable posture inside AuthContext can turn a no-checkbox tap into
      // a fabricated cross-Event attestation if the Event flips 18+ between
      // the click and the auth transaction starting.
      await signIn(adult && ack);
    } catch {
      setBusy(false);
    }
  };

  return (
    // `data-testid` is the production synthetic's mount signal (#142,
    // tests/synthetic/app-mounts.spec.ts) — the one handle on this gate that is
    // NOT Edition copy. The synthetic used to wait for the `GAY CRUISE BINGO`
    // heading, which can never match on a Vacay host, so every Bodega deploy
    // failed the post-deploy check and told the operator to roll back a healthy
    // release. Keep this attribute: `signin-edition-brand.test.tsx` fails if it
    // goes, because the wordmark above is now free to change per Edition and
    // must never be load-bearing for uptime again.
    <div className="signin" data-testid="signin-gate">
      <h1>{brand.wordmark}</h1>
      {/* The platform endorsement line under the wordmark (#647, gcb from
          #688) — the Join frames' lockup carries it wherever the brand table
          does (every Edition of the platform; see `wordmarkByline`). It is a
          SIBLING of the h1, not inside it: the
          heading's textContent is asserted brand-for-brand by
          signin-edition-brand.test.tsx and must stay exactly the wordmark. */}
      {brand.wordmarkByline && <span className="brand-byline">{brand.wordmarkByline}</span>}
      <p className={brand.signinTaglineChip && !(reprompt && adult) ? 'signin-tagline-chip' : 'muted'}>
        {/* The re-prompt line makes an age claim of its own, so it is gated on
            the posture too — belt and braces. AuthProvider already refuses to
            mount the re-prompt on a non-adult Event, but a screen whose whole
            job is the 18+ acknowledgement should not be one caller's discipline
            away from asserting it on an Event that never asked. */}
        {reprompt && adult
          ? 'One quick thing before you get your card: confirm you’re 18 or older.'
          : /* The voice chip ("Take the detour. For the story.") REPLACES the
               plain tagline where the brand carries one — the wireframes' vacay
               Join frame draws the chip in the lockup and no tagline line. */
            (brand.signinTaglineChip ?? brand.tagline)}
      </p>
      {/* The Event-preview postcard (#647): between the lockup and the 18+ /
          CTA rows, exactly where the wireframes draw it, so the attestation —
          when the posture requires one — keeps its position under the card.
          Renders nothing when no pre-auth preview resolved. */}
      <EventPostcard />
      {adult && (
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            I'm 18 or older and I know exactly what I'm getting into. Keep it legal, no minors, and
            don't post people who didn't consent.
          </span>
        </label>
      )}
      <button
        className="btn primary block"
        disabled={(adult && !ack) || busy || (!reprompt && !signInReady)}
        onClick={go}
      >
        {busy
          ? reprompt
            ? 'Saving…'
            : 'Signing in…'
          : reprompt
            ? 'Enter the event'
            : 'Continue with Google'}
      </button>
      {/* The handoff's explicit failure surface (#549, ADR 0010: "failure states
          are explicit — no silent fallback"). Two causes, one message, because
          the player's next move is identical and the server deliberately refuses
          to say which of expired / already-used / unknown a code was. Below the
          button, so the retry it asks for is the thing directly above it. */}
      {(handoffFailed || startFailed) && (
        <p className="muted" role="alert" data-testid="signin-handoff-error">
          That sign-in didn't finish. Please tap Continue with Google to try again.
        </p>
      )}
      {/* The invitation copy block under the CTA (#647) — brand-carried, so
          only the Editions whose Join frame draws it render it (vacay). */}
      {brand.signinInviteNote && (
        <p className="muted signin-invite-note">{brand.signinInviteNote}</p>
      )}
      <p className="muted" style={{ fontSize: 11 }}>{brand.offlineNote}</p>
    </div>
  );
}

// Retry surface shown when a signed-in Player's Board couldn't be dealt (see
// App.tsx / AuthContext): a Player-worded reason plus a Retry that re-invokes
// `joinAndDeal` in place, instead of dropping the Player onto a blank Board.
export function DealError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  // This panel owns the MANUAL Retry: the button re-invokes the deal, and the
  // /items Prompts tab stays reachable (the shell keeps rendering) so a Player or
  // Admin can add Prompts, then come back and retry. The AUTOMATIC pool-recovery
  // retry (#70) deliberately does NOT live here — a watcher on this panel would
  // unmount the moment the Player navigates to /items (the exact recovery path,
  // the PR #66 finding), so it lives at the app shell instead
  // (src/components/PoolRecoveryWatcher.tsx, mounted in AuthProvider). This panel
  // stays the manual fallback for the cases the shell watcher deliberately does
  // not cover (e.g. a first server snapshot that is already healthy is a baseline,
  // not a trigger — see specs/w1-deal-auto-retry.md).
  const brand = editionBrand();
  return (
    <div className="signin" role="alert">
      {/* Same Edition brand as the gate above (#543): this panel reuses the
          `.signin` shell, so a hardcoded wordmark here would put the wrong
          product name on a retry screen a Bodega player can actually reach. */}
      <h1>{brand.wordmark}</h1>
      <p className="muted">{message}</p>
      <button className="btn primary block" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Dealing…' : 'Retry'}
      </button>
      <p className="muted" style={{ fontSize: 11 }}>{brand.offlineNote}</p>
    </div>
  );
}
