import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { editionBrand } from '../editions';

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
export default function SignIn() {
  const { user, signIn, signInReady, attest } = useAuth();
  const reprompt = user != null;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const brand = editionBrand();

  const go = async () => {
    setBusy(true);
    try {
      if (reprompt) await attest();
      else await signIn();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <h1>{brand.wordmark}</h1>
      <p className="muted">
        {reprompt
          ? 'One quick thing before you get your card: confirm you’re 18 or older.'
          : brand.tagline}
      </p>
      <label className="ack">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I'm 18 or older and I know exactly what I'm getting into. Keep it legal, no minors, and
          don't post people who didn't consent.
        </span>
      </label>
      <button className="btn primary block" disabled={!ack || busy || (!reprompt && !signInReady)} onClick={go}>
        {busy
          ? reprompt
            ? 'Saving…'
            : 'Signing in…'
          : reprompt
            ? 'Enter the event'
            : 'Continue with Google'}
      </button>
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
