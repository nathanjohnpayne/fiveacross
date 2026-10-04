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
  reason:
    | 'missing'
    | 'inactive'
    | 'unreachable'
    | 'auth-unconfigured'
    // The ways the sign-in ROUTE itself is misconfigured (#549, ADR 0010).
    // Separate reasons rather than folded into `auth-unconfigured`, because that
    // screen means "nobody finished provisioning this address" while these
    // mean "this build was told to sign in a way that cannot work here" — a
    // different person fixes each, and only one of them is fixed in a console.
    | 'auth-same-origin-unavailable'
    | 'auth-mode-invalid'
    | 'auth-handoff-misconfigured';
}) {
  const headline =
    reason === 'inactive'
      ? 'This game has wrapped up'
      : reason === 'auth-unconfigured' ||
          reason === 'auth-same-origin-unavailable' ||
          reason === 'auth-mode-invalid' ||
          reason === 'auth-handoff-misconfigured'
        ? 'This address is not open yet'
        : "There's no game at this address";

  const detail =
    reason === 'inactive'
      ? 'The event at this address has finished or been archived. If you think it should still be running, check with whoever invited you.'
      : reason === 'unreachable'
        ? "We couldn't reach the server to look this address up. Check your connection and try again—if you were playing earlier, your card is still safe."
        : reason === 'auth-unconfigured'
          ? // Deliberately not a sign-in screen: the button would open a Google
            // flow that cannot return here (ADR 0010). Better to name the state
            // than to let a player discover it halfway through signing in.
            'The game is here, but sign-in has not been switched on for this address yet. Whoever set the event up needs to finish one step—this is not something you can fix from your phone.'
          : // Both #549 arms keep the same player-facing shape as the one above
            // — a player can act on none of the three — and differ only in the
            // sentence an operator reads, which is the whole reason they are
            // separate reasons rather than one.
            reason === 'auth-same-origin-unavailable'
            ? 'The game is here, but sign-in is set to a mode this address cannot use. Whoever set the event up needs to change one setting—this is not something you can fix from your phone.'
            : reason === 'auth-mode-invalid'
              ? 'The game is here, but its sign-in mode is not recognised. Whoever set the event up needs to correct one setting—this is not something you can fix from your phone.'
              : reason === 'auth-handoff-misconfigured'
                ? 'The game is here, but sign-in has not been finished for this address. Whoever set the event up needs to correct one setting—this is not something you can fix from your phone.'
                : 'Double-check the link you were sent. Addresses are case-insensitive but otherwise exact.';

  // Preview hosts have no production Auth trust (#1420). This developer note
  // names the isolated-project blocker; it never suggests registering a preview
  // on production or force-pushing code to gain production sign-in.
  const previewHint =
    reason === 'auth-unconfigured' && hostname.endsWith('.vercel.app')
      ? 'Developer note: preview hosts have no production sign-in trust. Previews need an approved isolated test Firebase Auth/data configuration before they can be enabled (docs/app/preview-deploys.md, #1420).'
      : reason === 'auth-same-origin-unavailable'
        ? 'Developer note: this build sets VITE_AUTH_MODE=same_origin, which only works where the OAuth helper is already same-origin—this hostname is not in FIRST_PARTY_AUTH_HOSTS (src/auth-domain.ts) and the build does not bake VITE_FIREBASE_AUTH_DOMAIN equal to it. Clear VITE_AUTH_MODE to use the handoff, or register this host (ADR 0010).'
        : reason === 'auth-mode-invalid'
          ? 'Developer note: this build has an unrecognised VITE_AUTH_MODE. Set it to handoff or same_origin, or clear it to use the handoff default, then rebuild (ADR 0010, specs/auth-handoff-client.md).'
          : reason === 'auth-handoff-misconfigured'
            ? 'Developer note: sign-in is in handoff mode but this build has no usable VITE_AUTH_HANDOFF_ORIGIN—it is unset, malformed, or equal to this origin. Set it to the central auth origin (https://auth.fiveacross.app) in the target env file and rebuild (ADR 0010, specs/auth-handoff-client.md).'
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
