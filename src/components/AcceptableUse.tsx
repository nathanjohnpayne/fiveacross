import { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useAdultContent } from '../hooks/useAdultContent';
import { editionBrand } from '../editions';

/** Elements the Tab-trap below will cycle between while the dialog is open. */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Acceptable Use / Community Guidelines — the 18+ posture, community
 * expectations, and how to report a Prompt or Proof, shown in an in-app modal.
 * Behind auth BY DESIGN (ADR 0005 — no public unauthenticated pages): it
 * self-gates on the signed-in User and renders NOTHING signed out, and is not
 * added to the frozen tab route table.
 *
 * `variant`: `'floating'` (default) is the original fixed bottom-left chip
 * (w3-security-hardening.md) — kept intact for that spec's own coverage.
 * `'row'` is a plain full-width menu row with the same trigger+sheet, used
 * ONLY by `More.tsx` (#208, daily-cards-spec § "More menu" § Support): the
 * live app mounts `variant="row"` exclusively now (from More, itself
 * reachable on every signed-in route as a frozen tab), so only one
 * Guidelines affordance is ever on screen at a time.
 */
/** 'Attested Jul 2' — the viewer's own 18+ self-attestation date (#270). */
function attestedLabel(at: number | undefined | null): string | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const d = new Date(at);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `Attested ${m} ${d.getDate()}`;
}

export default function AcceptableUse({
  variant = 'floating',
  attestedAdultAt,
}: {
  variant?: 'floating' | 'row';
  attestedAdultAt?: number | null;
}) {
  const { user } = useAuth();
  // Two independent axes (#608): the REGISTER comes from the Edition (cruise /
  // trip / general), the 18+ CLAIM from the Event's own content. A `fiveacross`
  // Event with explicit Prompts is 18+ in general vocabulary; a `gcb` Event with
  // a tame pool is not 18+ at all. Neither derives the other.
  const brand = editionBrand();
  const adult = useAdultContent();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const close = () => setOpen(false);

  // Modal focus management (keyboard/screen-reader users): move focus into the
  // dialog on open, trap Tab/Shift+Tab within it while open, close on Escape,
  // and restore focus to the trigger on close (any of the three paths below).
  // Without this, the background stays fully tabbable behind the
  // visually-covering backdrop.
  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // The title also holds focus (tabIndex=-1, the initial landing spot) but
      // is deliberately excluded from FOCUSABLE_SELECTOR — treat it as
      // preceding `first` so Shift+Tab from it still wraps to the end.
      if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  // ADR 0005: no public unauthenticated surface — nothing renders signed out.
  if (!user) return null;
  const attested = attestedLabel(attestedAdultAt);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={variant === 'row' ? 'more-row' : 'btn guidelines-trigger'}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {/* Lucide shield-alert (#270, daily-cards-spec § "Iconography — Lucide"
            › More menu), replacing the hand-inlined "18+" SVG. `.guidelines-icon`
            (not a trigger-scoped selector) so sizing/fill survive `variant="row"`. */}
        <ShieldAlert className="guidelines-icon" aria-hidden="true" focusable="false" />
        {variant === 'row' ? (
          <span className="more-row-text">
            <span className="more-row-title">
              {adult ? '18+ advisory & acceptable use' : 'Community guidelines'}
            </span>
            <span className="more-row-sub">
              {adult && attested ? `${attested} · honor system, be kind` : 'Honor system, be kind'}
            </span>
          </span>
        ) : (
          <span>Guidelines</span>
        )}
      </button>

      {open && (
        <div className="sheet-backdrop" onClick={close}>
          <div
            ref={dialogRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Community guidelines"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title" ref={titleRef} tabIndex={-1}>
              Community guidelines
            </div>

            {/* The 18+ CLAIM is dropped entirely when the Event's pool carries no
                adult content (#608) — not softened, dropped. A claim nobody was
                asked to make has no business on the page, and the rest of this
                sheet (be kind, no harassment, how to report) stands on its own
                as community guidance. The Edition still supplies the register. */}
            {adult ? (
              <p>
                <b>This is an 18+ space</b> for {brand.guidelinesScope}. By playing you confirm
                you are 18 or over. It stays behind sign-in—there are no public pages.
              </p>
            ) : (
              <p>
                <b>This is a shared space</b> for {brand.guidelinesScope}. It stays behind
                sign-in—there are no public pages.
              </p>
            )}
            <p className="muted">Keep it fun and keep it kind:</p>
            <ul>
              <li>Mark honestly—the Feed is the group&rsquo;s shared memory, not a leaderboard to game.</li>
              <li>Proofs and callouts are playful. No harassment, no outing anyone, nothing non-consensual.</li>
              <li>No illegal content and nothing you would not want {brand.lexicon.crowd} to see.</li>
            </ul>
            <p>
              <b>How to report a Prompt or Proof:</b> tap <b>Report</b> on any Prompt in the pool or any
              Proof in the Feed to flag it for an Admin&rsquo;s review—reporting doesn&rsquo;t hide
              anything automatically, but Admins can hide or remove anything reported or otherwise out
              of line.
            </p>

            <div className="sheet-actions">
              <button className="btn primary" onClick={close}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
