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
}: {
  onAction: () => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
  failureLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const run = async () => {
    if (state === 'busy') return;
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
        disabled={state === 'busy'}
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
