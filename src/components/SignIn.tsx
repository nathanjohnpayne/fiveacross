import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAdultContent } from '../hooks/useAdultContent';
import { editionBrand } from '../editions';
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

  const go = async () => {
    setBusy(true);
    try {
      if (reprompt) await attest();
      // Pass the acknowledgement THIS render actually collected. Re-reading
      // the mutable posture inside AuthContext can turn a no-checkbox tap into
      // a fabricated cross-Event attestation if the Event flips 18+ between
      // the click and the auth transaction starting.
      else await signIn(adult && ack);
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
