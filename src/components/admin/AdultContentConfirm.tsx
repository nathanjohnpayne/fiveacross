import { useState, type ReactNode } from 'react';
import { adultContentRequired } from '../../adultContent';

/**
 * The confirm that stands between an admin action and an Event turning 18+
 * (#610, required by #608's acceptance: "the flip is never silent").
 *
 * WHY THIS EXISTS AT ALL. Before #608 the 18+ posture was a Gay Cruise Bingo
 * constant; tagging a Prompt 🔞 only changed how the deal sampled it. Now the
 * posture is a CONSEQUENCE of the pool, so the first active explicit Prompt asks
 * every Player in the Event — including the ones playing right now — to confirm
 * they are 18 or older. That is a consequential, irreversible action hiding
 * behind an unlabelled checkbox, and it should not happen without saying so.
 *
 * WHERE THE FLIP ACTUALLY IS, which the obvious implementation gets wrong. A
 * player checking 🔞 changes nothing: their submission lands `status: 'pending'`
 * (#210) and the derivation only counts `status: 'active'`. It is a REQUEST. The
 * Event flips when an admin makes it active — `approveItem`, `bulkApproveItems`,
 * or `adminAddItem`, which writes `active` directly — so the confirm belongs on
 * those three, not on the player's checkbox. The `forceAdult` override is a
 * fourth path to the same consequence and reuses the same component, driven by
 * its `reason` rather than by a near-copy.
 *
 * ONE COMPONENT, FOUR CALLERS. `useAdultContentFlipConfirm` is the whole
 * contract: hand it the action and whether that action would flip the Event, and
 * it either runs the action straight through or parks it behind this dialog.
 * Callers never branch on the posture themselves.
 *
 * NEVER FIRES ON AN EVENT ALREADY AT `adultContent: true`. Once the Event is
 * 18+, approving the second explicit Prompt changes nothing and a confirm is
 * pure noise — so the gate reads the RESOLVED posture (`adultContentRequired`),
 * not the tag alone.
 */
export type AdultFlipReason = 'approve' | 'bulk-approve' | 'add' | 'force';

/** The pending action, held while the dialog is up. */
interface PendingFlip {
  reason: AdultFlipReason;
  /** For `bulk-approve`: how many of the batch are explicit, and how many in all. */
  explicitCount?: number;
  totalCount?: number;
  run: () => Promise<unknown> | unknown;
}

function bodyFor(pending: PendingFlip): ReactNode {
  if (pending.reason === 'force') {
    return (
      <>
        Turning this on means every player is asked to confirm they’re 18 or older before they can
        keep playing — including the ones already playing right now.
      </>
    );
  }
  if (pending.reason === 'bulk-approve') {
    return (
      <>
        {pending.explicitCount} of the {pending.totalCount} prompts you’re approving{' '}
        {pending.explicitCount === 1 ? 'is' : 'are'} explicit. Approving means every player is asked
        to confirm they’re 18 or older before they can keep playing — including the ones already
        playing right now.
      </>
    );
  }
  return (
    <>
      This is the first explicit prompt in this Event. Approving it means every player is asked to
      confirm they’re 18 or older before they can keep playing — including the ones already playing
      right now.
    </>
  );
}

/** The action label — the confirm button names what it is about to do. */
function confirmLabelFor(reason: AdultFlipReason): string {
  if (reason === 'force') return 'Make this Event 18+';
  if (reason === 'add') return 'Add and make this Event 18+';
  return 'Approve and make this Event 18+';
}

/**
 * Wrap an admin action in the flip confirm.
 *
 * Returns `{ guard, dialog }`. `guard(wouldFlip, reason, run, counts?)` is what a
 * call site invokes instead of the bare write; `dialog` is rendered once,
 * anywhere in that component's tree.
 *
 * The action is DEFERRED, never partially applied: cancelling runs nothing at
 * all, which for a bulk approve means none of the batch — a half-applied batch
 * would flip the Event anyway and leave the admin unsure which half landed.
 */
export function useAdultContentFlipConfirm(): {
  guard: (
    wouldFlip: boolean,
    reason: AdultFlipReason,
    run: () => Promise<unknown> | unknown,
    counts?: { explicitCount: number; totalCount: number },
  ) => Promise<unknown>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingFlip | null>(null);

  const guard = (
    wouldFlip: boolean,
    reason: AdultFlipReason,
    run: () => Promise<unknown> | unknown,
    counts?: { explicitCount: number; totalCount: number },
  ): Promise<unknown> => {
    // Already 18+, or nothing explicit in this action → straight through. The
    // posture check is deliberately the RESOLVED one, so a second explicit
    // Prompt on an already-gated Event is silent.
    if (!wouldFlip || adultContentRequired()) return Promise.resolve(run());
    setPending({ reason, run, explicitCount: counts?.explicitCount, totalCount: counts?.totalCount });
    // Resolves immediately: the caller's AsyncButton must not sit in a pending
    // state for as long as the dialog is open — the dialog owns the action now.
    return Promise.resolve();
  };

  const dialog = pending ? (
    <AdultContentConfirmDialog
      pending={pending}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        // Await BEFORE dismissing, and let a rejection propagate: the dialog
        // owns the failure surface now (see its `failed` state), so tearing it
        // down first would drop the only report the admin can act on.
        await pending.run();
        setPending(null);
      }}
    />
  ) : null;

  return { guard, dialog };
}

/**
 * The dialog itself — destructive-action shape (`.warnbox`, as `ReshuffleSheet`
 * uses), not a dismissible toast. "This can't be undone" is literally true:
 * `hostnames/{host}.adultContent` is monotone by design, because retracting the
 * posture from players who already attested is meaningless.
 */
export function AdultContentConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingFlip;
  onCancel: () => void;
  /** Rejects if the write fails, so the dialog can hold its ground. */
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // A rejected write must not disappear along with the dialog (Codex P2 on
  // #615). `guard()` resolves the caller's AsyncButton the moment the dialog
  // opens, so its inline "Didn't work — try again" affordance is already spent by
  // the time the real write runs: if this closed on rejection, a rules denial or
  // a dropped connection would look exactly like a successful approval. So the
  // dialog STAYS OPEN on failure and says so, and the confirm button re-enables
  // for a retry.
  const [failed, setFailed] = useState(false);
  const title = 'This makes the whole Event 18+';
  return (
    // Backdrop guarded by `busy` like both buttons (the ReshuffleSheet
    // discipline): a stray tap must not tear the dialog down mid-write and leave
    // the admin unsure whether the approval landed.
    <div className="sheet-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title">{title}</div>
        <p>{bodyFor(pending)}</p>
        <div className="warnbox">
          <b>This can't be undone.</b>
        </div>
        {failed && (
          <p className="muted" role="alert">
            That didn&rsquo;t go through. Nothing changed &mdash; try again.
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed(false);
              void Promise.resolve(onConfirm())
                .catch(() => setFailed(true))
                .finally(() => setBusy(false));
            }}
          >
            {confirmLabelFor(pending.reason)}
          </button>
        </div>
      </div>
    </div>
  );
}
