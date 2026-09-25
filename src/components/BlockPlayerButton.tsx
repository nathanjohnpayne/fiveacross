import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UserX } from 'lucide-react';
import { blockPlayer } from '../data/blocks';
import { trackIfCurrentEvent } from '../eventScopedAnalytics';
import { EVENT_ID } from '../firebase';
import { editionBrand } from '../editions';

/** Where a block was started, the one param `block_player` carries. */
export type BlockSurface = 'proof_card' | 'feed_wholist' | 'board_wholist';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** How long a confirmed block watches the host who-list for its trigger to leave. */
const HOST_FOCUS_WATCH_MS = 5000;

/** The first control in `root` that can actually take focus: a disabled one
 *  (another row's Doubt button while its request is pending) or one inside an
 *  aria-hidden or inert subtree ignores focus(), dropping focus to <body>. */
function firstEnabledControl(root: Element): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (el.matches(':disabled') || el.closest('[aria-hidden="true"], [inert]')) continue;
    return el;
  }
  return null;
}

/**
 * The block entry point (#689, specs/player-blocking.md § Block and unblock
 * controls): a compact icon button on another Player's Proof card and on each
 * other Player's who-list row, opening a confirm sheet. The caller renders it
 * only for a signed-in viewer and never on the viewer's own content, and never
 * on a Moment (the owner's decision: MomentCard carries no per-Moment control).
 *
 * The sheet is portalled to `document.body` because the who-list rows it sits
 * in are already inside a sheet whose entrance animation carries a transform,
 * which would otherwise re-anchor this sheet's fixed backdrop to that sheet.
 * Its keyboard handling runs in the CAPTURE phase and stops there, so Escape
 * and the Tab trap act on this sheet alone and never also close the who-list
 * underneath. Its backdrop click stops propagating for the same reason: React
 * bubbles a portalled event through the component tree, into the host
 * who-list's own backdrop, which would otherwise close too.
 *
 * Both the trigger and the portalled sheet carry `ph-no-capture` (as the
 * Blocked players panel does), so PostHog autocapture and session replay never
 * record whom a Player blocked; the `block_player` event carries no identity.
 *
 * Confirming commits `blockPlayer`'s batch and closes at once. The batch is
 * optimistic and durable (ADR 0006): the counterpart hides immediately, even
 * offline, which usually unmounts this button with the card or row it sat on.
 * So an online rules rejection is logged and self-corrects as the listener
 * rolls the optimistic pair back (the Hearts and Marks posture), and
 * `block_player` fires only once the batch persists, under the Event it was
 * acted in. A synchronous refusal (a missing or reserved uid) keeps the sheet
 * open with an error.
 */
export default function BlockPlayerButton({
  meUid,
  targetUid,
  targetName,
  surface,
  block = blockPlayer,
}: {
  meUid: string;
  targetUid: string;
  targetName: string;
  surface: BlockSurface;
  /** Injected by tests; defaults to the real write path. */
  block?: typeof blockPlayer;
}) {
  const [open, setOpen] = useState(false);
  const name = targetName.trim() || 'this player';
  return (
    <>
      <button
        type="button"
        className="iconbtn block-trigger ph-no-capture"
        title={`Block ${name}`}
        aria-label={`Block ${name}`}
        onClick={() => setOpen(true)}
      >
        <UserX className="block-trigger-icon" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <BlockConfirmSheet
            name={name}
            onCancel={() => setOpen(false)}
            onConfirm={() => {
              const actedEventId = EVENT_ID;
              // Throws synchronously only on a refused uid; the sheet shows it.
              const write = block({ me: meUid, target: targetUid, eventId: actedEventId });
              setOpen(false);
              write.then(
                () => {
                  trackIfCurrentEvent(actedEventId, 'block_player', { surface });
                },
                (err: unknown) => {
                  console.error('[blocks] block rejected; the listener will re-sync', err);
                },
              );
            }}
          />,
          document.body,
        )}
    </>
  );
}

function BlockConfirmSheet({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const occasion = editionBrand().lexicon.occasion;
  // Read through a ref so a host re-render (a who-list snapshot) never re-runs
  // the effect below, which would pull focus back to the title mid-sheet.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  // Set once Block commits, so closing after a confirm (not a cancel) is what
  // arms the host-sheet focus fallback in the effect's cleanup.
  const confirmedRef = useRef(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // The sheet a who-list trigger sat in, if any: where focus falls back to when
    // the optimistic block unmounts the trigger's row. The Feed who-list is a
    // `role="dialog"`; the Board's TallySheet is a bare `.sheet`, so match both.
    const hostSheet = previouslyFocused?.closest<HTMLElement>('[role="dialog"], .sheet') ?? null;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      event.stopPropagation();
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = dialogRef.current?.contains(document.activeElement) ?? false;
      if (event.shiftKey && (!inside || document.activeElement === first || document.activeElement === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
      // A confirmed block hides the counterpart, which unmounts the trigger (its
      // Proof card or who-list row) once the pair listener renders the optimistic
      // write: in this commit, or in a later one after the sheet has closed. So
      // watch the host who-list sheet until the trigger detaches, then land focus
      // on that sheet if it is still open, so keyboard focus never drops to <body>
      // behind a live dialog. Only a confirmed block watches, and for at most
      // HOST_FOCUS_WATCH_MS: a rejected write rolls back and may leave the row.
      if (!confirmedRef.current || !previouslyFocused || !hostSheet) return;
      let observer: MutationObserver | null = null;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        observer?.disconnect();
        observer = null;
        clearTimeout(expiry);
      };
      const settle = () => {
        if (!observer) return;
        if (!hostSheet.isConnected) return stop();
        if (previouslyFocused.isConnected) return;
        stop();
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        let target =
          hostSheet.querySelector<HTMLElement>('.sheet-title[tabindex]') ??
          firstEnabledControl(hostSheet);
        if (!target) {
          // Nothing enabled left to focus (the Board title carries no tabindex):
          // make the title a programmatic focus target rather than lose focus to
          // the page.
          target = hostSheet.querySelector<HTMLElement>('.sheet-title');
          target?.setAttribute('tabindex', '-1');
        }
        target?.focus();
      };
      observer = new MutationObserver(settle);
      observer.observe(hostSheet, { childList: true, subtree: true });
      expiry = setTimeout(stop, HOST_FOCUS_WATCH_MS);
      setTimeout(settle, 0);
    };
  }, []);

  return (
    <div
      className="sheet-backdrop ph-no-capture"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="sheet block-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="block-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title" id="block-sheet-title" ref={titleRef} tabIndex={-1}>
          Block {name}?
        </div>
        <p>
          You&rsquo;ll stop seeing each other&rsquo;s proofs, marks, hearts, doubts and moments for this {occasion}.
          Scores and standings don&rsquo;t change.
        </p>
        <p className="muted">
          They won&rsquo;t get a notification, but their app will stop showing you, so they may be able to tell.
          You can unblock any time from More.
        </p>
        {error && (
          <p className="block-error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn primary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              try {
                confirmedRef.current = true;
                onConfirm();
              } catch (err) {
                confirmedRef.current = false;
                console.error('[blocks] block refused', err);
                setError(`Couldn’t block ${name}. Try again.`);
              }
            }}
          >
            Block
          </button>
        </div>
      </div>
    </div>
  );
}
