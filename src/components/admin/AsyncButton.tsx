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
 */
export default function AsyncButton({
  onAction,
  children,
  className = 'btn',
  title,
  ariaLabel,
  failureLabel = 'Failed—try again.',
  disabled = false,
}: {
  onAction: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
  failureLabel?: string;
  /** A caller-owned precondition, ORed with the in-flight disable (#134): the
   *  archive action stays unavailable until its inputs are server-confirmed and
   *  the claim queue is drained. Held separately from `state` so neither can
   *  re-enable the button on the other's behalf — a failed write still offers a
   *  retry, but only while the precondition itself holds. */
  disabled?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const run = async () => {
    if (state === 'busy' || disabled) return;
    setState('busy');
    try {
      await onAction();
      setState('idle');
    } catch {
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
          {failureLabel}
        </span>
      )}
    </>
  );
}
