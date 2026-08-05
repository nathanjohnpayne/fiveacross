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
  reason: 'missing' | 'inactive' | 'unreachable';
}) {
  const headline =
    reason === 'inactive' ? 'This game has wrapped up' : "There's no game at this address";

  const detail =
    reason === 'inactive'
      ? 'The event at this address has finished or been archived. If you think it should still be running, check with whoever invited you.'
      : reason === 'unreachable'
        ? "We couldn't reach the server to look this address up. Check your connection and try again — if you were playing earlier, your card is still safe."
        : 'Double-check the link you were sent. Addresses are case-insensitive but otherwise exact.';

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
        <p style={{ margin: 0, fontSize: '0.8125rem', color: '#6f7f8d' }}>
          <code>{hostname}</code>
        </p>
      </div>
    </main>
  );
}
