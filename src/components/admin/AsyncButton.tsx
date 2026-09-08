import { useState, type ReactNode } from 'react';

/**
 * A moderation action button with the reliability affordance the admin rows
 * lacked (#411, specs/admin-async-feedback.md): the button disables while its
 * async write is in flight, and a rejected write surfaces an inline failure
 * pill (role=alert) instead of vanishing into an unhandled rejection — in the
 * spirit of SchedulePanel's UnlockNowButton/ResnapshotButton, without touching
 * any write path. The button re-enables after a failure (tap again to retry;
 * the pill clears on the next attempt), and a success clears everything —
 * including the common case where the row unmounts because the subscription
 * removed it.
 *
 * `failureLabelFor` is the one way the pill says something OTHER than the
 * caller's fixed `failureLabel` (#134, Phase 4b P2 on PR #1157 run 4): a write
 * that refuses for a reason the Admin can act on — the moderation delete
 * refused because the Proof still backs a marked square on a CLOSING Event —
 * has to say what to do about it, and "Failed, try again" is exactly wrong
 * there, because trying again does the same thing. It is opt-in per call site
 * and consulted only on rejection; returning `undefined` (or omitting the prop)
 * falls back to `failureLabel`, so no other control's copy changes and a raw
 * Firestore error is never rendered by default.
 */
export default function AsyncButton({
  onAction,
  children,
  className = 'btn',
  title,
  ariaLabel,
  failureLabel = 'Failed—try again.',
  failureLabelFor,
  disabled = false,
}: {
  onAction: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
  failureLabel?: string;
  failureLabelFor?: (error: unknown) => string | undefined;
  /** A caller-owned precondition, ORed with the in-flight disable (#1151): the
   *  archive action stays unavailable until its inputs are server-confirmed, the
   *  claim queue is drained and the record fits. Held separately from `state` so
   *  neither can re-enable the button on the other's behalf — a failed write
   *  still offers a retry, but only while the precondition itself holds. */
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [label, setLabel] = useState<string | null>(null);
  const run = async () => {
    if (state === 'busy' || disabled) return;
    setState('busy');
    try {
      await onAction();
      setState('idle');
    } catch (error) {
      setLabel(failureLabelFor?.(error) ?? null);
      setState('error');
    }
  };
  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        aria-label={ariaLabel}
        disabled={state === 'busy' || disabled}
        onClick={() => void run()}
      >
        {children}
      </button>
      {state === 'error' && (
        <span className="pill pill-error" role="alert">
          {label ?? failureLabel}
        </span>
      )}
    </>
  );
}
