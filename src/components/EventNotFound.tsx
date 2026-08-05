/**
 * Shown when a hostname resolves to no servable Event (ADR 0009, #543).
 *
 * Deliberately dependency-free: no auth, no Firestore, no router, no theme
 * context. It renders when we have decided NOT to mount the app, so anything it
 * imported would be a way for this screen — the fallback — to fail too.
 *
 * The copy is edition-neutral on purpose. At this point resolution failed, so
 * we do not know which Edition this address belongs to and must not guess at
 * branding we cannot substantiate.
 */
export default function EventNotFound({
  hostname,
  reason,
}: {
  hostname: string;
  reason: 'missing' | 'inactive' | 'unreachable' | 'auth-unconfigured';
}) {
  const headline =
    reason === 'inactive'
      ? 'This game has wrapped up'
      : reason === 'auth-unconfigured'
        ? 'This address is not open yet'
        : "There's no game at this address";

  const detail =
    reason === 'inactive'
      ? 'The event at this address has finished or been archived. If you think it should still be running, check with whoever invited you.'
      : reason === 'unreachable'
        ? "We couldn't reach the server to look this address up. Check your connection and try again — if you were playing earlier, your card is still safe."
        : reason === 'auth-unconfigured'
          ? // Deliberately not a sign-in screen: the button would open a Google
            // flow that cannot return here (ADR 0010). Better to name the state
            // than to let a player discover it halfway through signing in.
            'The game is here, but sign-in has not been switched on for this address yet. Whoever set the event up needs to finish one step — this is not something you can fix from your phone.'
          : 'Double-check the link you were sent. Addresses are case-insensitive but otherwise exact.';

  // #585: on a `*.vercel.app` host this screen has a different audience. Every
  // registered Vercel host — `gaycruisebingo.vercel.app`, the stable preview
  // alias, the Five Across mirror — is in `FIRST_PARTY_AUTH_HOSTS`, so a
  // `.vercel.app` origin that reaches `auth-unconfigured` is by construction a
  // per-deployment preview host, and the person looking at it is a developer
  // who pushed a branch. Naming the supported path here is what stops the
  // screenshot round trip that filed this ticket. Suffix match, not the exact
  // matching the auth allowlist demands: this only chooses which sentence to
  // print, and choosing it for a lookalike host costs nothing.
  //
  // The alias is spelled out rather than left to the doc reference (Codex P3 on
  // #585): this screen is most often met as a phone screenshot, and a URL you
  // can read off the image is the difference between acting on it and asking
  // about it. Duplicating the literal costs a stale string if the alias ever
  // changes — cheap, and `src/auth-domain.ts` is where that change would have
  // to start anyway.
  const previewHint =
    reason === 'auth-unconfigured' && hostname.endsWith('.vercel.app')
      ? 'Developer note: per-deployment preview hosts can never sign in — Firebase and Google both match hostnames exactly, and neither accepts a wildcard. Push the branch with `git push --force origin HEAD:preview` and reopen it on the stable alias, gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app (docs/app/preview-deploys.md).'
      : null;

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem 1.5rem',
        // Literal colours, not theme tokens: the theme layer is part of the app
        // we have chosen not to mount.
        background: '#0b0f14',
        color: '#eef2f6',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: '32rem' }}>
        <p style={{ fontSize: '2.5rem', margin: '0 0 0.75rem' }} aria-hidden="true">
          🌫️
        </p>
        <h1 style={{ fontSize: '1.5rem', lineHeight: 1.25, margin: '0 0 0.75rem' }}>{headline}</h1>
        <p style={{ margin: '0 0 1.25rem', lineHeight: 1.55, color: '#a9b7c4' }}>{detail}</p>
        {previewHint && (
          <p
            style={{
              margin: '0 0 1.25rem',
              fontSize: '0.875rem',
              lineHeight: 1.5,
              color: '#8d9dab',
            }}
          >
            {previewHint}
          </p>
        )}
        <p style={{ margin: 0, fontSize: '0.8125rem', color: '#6f7f8d' }}>
          <code>{hostname}</code>
        </p>
      </div>
    </main>
  );
}
