// The client admission coordinator (#804, epic #801).
//
// `specs/event-invitations.md` § ordering fixes the order a signed-in visit
// must follow: sign-in, then profile and 18+ authority, then Invitation
// redemption, then `joinAndDeal`. This module owns the third step and the
// guard on the fourth: while a redemption is pending, retryable, or terminally
// blocked, `joinAndDeal` stays at ZERO calls. `AuthContext` folds
// `mayDealUnderAdmission` into its deal gate; nothing here touches Firestore
// or the deal itself.
//
// It is deliberately pure. The capture seam (`pendingEventInvitation.ts`),
// the callable seam (`data/eventInvitations.ts`) and the clock all arrive as
// dependencies, so the whole decision table — including the stale-visit
// guards — is exercised with fakes.
//
// The bearer never leaves this module. Public state carries the capture's
// opaque `captureId` and nothing else about the record, so React state, the
// rendered DOM, error text and analytics can never observe the code.

import type { PendingEventInvitationRecord } from '../pendingEventInvitation';
import type {
  RedeemEventInvitationFailureReason,
  RedeemEventInvitationOutcome,
  RedeemEventInvitationResult,
} from '../data/eventInvitations';

/** The one message a terminally invalid invitation shares (spec § ordering). */
export const INVITATION_NO_LONGER_VALID_MESSAGE =
  'This invitation is no longer valid. Ask the organizer for a new one.';

/** A transient reason keeps the bounded pending record and offers Retry. */
export type AdmissionRetryableReason = Exclude<
  RedeemEventInvitationFailureReason,
  'invitation-unavailable'
>;

export type AdmissionState =
  /** No usable invitation for this origin: the deal proceeds exactly as today. */
  | { kind: 'clear' }
  /**
   * A usable invitation exists for this origin but redemption has not started,
   * because the visit is not yet authoritative or not online. The shell stays
   * gated: an unchecked invitation is not `clear`, and a cached render
   * permission must not release Event content past it.
   */
  | { kind: 'held'; captureId: string }
  /** A redemption is in flight for the current visit. */
  | { kind: 'pending'; captureId: string }
  /** The callable failed transiently; the record is retained and Retry is offered. */
  | { kind: 'retryable'; captureId: string; reason: AdmissionRetryableReason }
  /**
   * The invitation is unknown, consumed, expired, revoked, or lost a
   * concurrent redemption. Its record has been compare-deleted and the deal
   * does not fire for this visit.
   */
  | { kind: 'blocked'; message: string }
  /** Redemption succeeded (or the caller already held membership). */
  | { kind: 'admitted'; outcome: RedeemEventInvitationOutcome };

/** The subject of one admission attempt. Any change is a new visit. */
export interface AdmissionVisit {
  eventId: string;
  uid: string;
  origin: string;
}

export interface AdmissionCoordinatorDependencies {
  /** `readPendingEventInvitation` for this origin, or a fake. */
  readPending(input: { origin: string; now: number }): { record: PendingEventInvitationRecord } | null;
  /** `forgetPendingEventInvitationIf`: compare-delete exactly this record. */
  forgetIf(record: PendingEventInvitationRecord): boolean;
  /** `redeemEventInvitation`, already bounded by the caller if it wants a timeout. */
  redeem(input: { code: string; expectedEventId: string }): Promise<RedeemEventInvitationResult>;
  now(): number;
}

export interface AdmissionCoordinator {
  /** The current state; `clear` until the first `begin`. */
  state(): AdmissionState;
  /**
   * Classify a visit WITHOUT redeeming: `clear` when the origin holds no
   * usable invitation, `held` when it does. Synchronous and network-free, so
   * it can run the moment an account is known — before authority, before
   * connectivity — and the first render already carries the right gate.
   * Supersedes any earlier visit like `begin` does.
   */
  classify(visit: AdmissionVisit): AdmissionState;
  /**
   * Start (or restart) admission for a visit. Supersedes any earlier visit:
   * results still in flight for an older visit are dropped without touching
   * storage or state. Returns the state reached synchronously.
   */
  begin(visit: AdmissionVisit): AdmissionState;
  /** Re-attempt a `retryable` visit. A no-op in every other state. */
  retry(): AdmissionState;
  /** Forget the visit (sign-out, Event switch). Never deletes a record. */
  reset(): void;
  subscribe(listener: (state: AdmissionState) => void): () => void;
}

/** Whether `joinAndDeal` may run under this admission state. */
export function mayDealUnderAdmission(state: AdmissionState): boolean {
  return state.kind === 'clear' || state.kind === 'admitted';
}

/**
 * Structural equality, so a consumer mirroring the state into React can keep
 * the previous object when nothing changed. `begin` on a visit with no
 * Invitation publishes `clear` over `clear`; a mirror that treated that as a
 * change would re-run the deal effect and deal twice.
 */
export function sameAdmissionState(a: AdmissionState, b: AdmissionState): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'clear':
      return true;
    case 'held':
    case 'pending':
      return a.captureId === (b as typeof a).captureId;
    case 'retryable':
      return a.captureId === (b as typeof a).captureId && a.reason === (b as typeof a).reason;
    case 'blocked':
      return a.message === (b as typeof a).message;
    case 'admitted':
      return a.outcome === (b as typeof a).outcome;
  }
}

export function createAdmissionCoordinator(
  deps: AdmissionCoordinatorDependencies,
): AdmissionCoordinator {
  let generation = 0;
  let current: { visit: AdmissionVisit; record: PendingEventInvitationRecord } | null = null;
  let state: AdmissionState = { kind: 'clear' };
  const listeners = new Set<(state: AdmissionState) => void>();

  function publish(next: AdmissionState): AdmissionState {
    state = next;
    for (const listener of listeners) listener(next);
    return next;
  }

  function settle(
    attempt: number,
    visit: AdmissionVisit,
    record: PendingEventInvitationRecord,
    result: RedeemEventInvitationResult,
  ): void {
    // The generation is the whole guard: a result for an older visit — a
    // different Event, a different account, or simply an earlier attempt —
    // must neither delete a record a newer visit may still need nor admit the
    // newer visit on the older one's evidence. It is dropped entirely.
    if (attempt !== generation) return;

    if (result.ok) {
      // The seam already refuses a response naming another Event; the check
      // here is what keeps that a property of the coordinator rather than of
      // one transport's validation. A cross-Event success admits nobody.
      if (result.eventId !== visit.eventId) {
        publish({ kind: 'retryable', captureId: record.captureId, reason: 'unavailable' });
        return;
      }
      // Consumed: only THIS record goes, never a newer capture written while
      // the redemption was in flight.
      deps.forgetIf(record);
      current = null;
      publish({ kind: 'admitted', outcome: result.outcome });
      return;
    }

    if (result.reason === 'invitation-unavailable') {
      // Unknown, consumed, expired, revoked, cross-Event, or a concurrent
      // loser — the callable collapses them deliberately, and each one means
      // the record can never succeed. Compare-delete it and stop here: the
      // deal does not fire for this visit.
      deps.forgetIf(record);
      current = null;
      publish({ kind: 'blocked', message: INVITATION_NO_LONGER_VALID_MESSAGE });
      return;
    }

    // Transient: keep the bounded record and offer Retry.
    publish({ kind: 'retryable', captureId: record.captureId, reason: result.reason });
  }

  function start(visit: AdmissionVisit, record: PendingEventInvitationRecord): AdmissionState {
    const attempt = ++generation;
    current = { visit, record };
    const next = publish({ kind: 'pending', captureId: record.captureId });
    deps.redeem({ code: record.code, expectedEventId: visit.eventId }).then(
      (result) => settle(attempt, visit, record, result),
      // The seam maps every failure to a result; a rejection here is a
      // programming error in a fake or a future seam. Treat it as transient
      // rather than as admission, and never as a reason to delete anything.
      () => settle(attempt, visit, record, { ok: false, reason: 'unavailable' }),
    );
    return next;
  }

  return {
    state: () => state,

    classify(visit) {
      generation += 1;
      current = null;
      const pending = deps.readPending({ origin: visit.origin, now: deps.now() });
      if (pending === null) return publish({ kind: 'clear' });
      return publish({ kind: 'held', captureId: pending.record.captureId });
    },

    begin(visit) {
      generation += 1;
      current = null;
      const pending = deps.readPending({ origin: visit.origin, now: deps.now() });
      if (pending === null) return publish({ kind: 'clear' });
      return start(visit, pending.record);
    },

    retry() {
      if (state.kind !== 'retryable' || current === null) return state;
      const { visit } = current;
      // Re-read rather than reuse: a newer capture for this origin — another
      // link opened while the first attempt was failing — supersedes the one
      // this attempt was holding, and a record that expired in the meantime
      // is gone. Either way the visit is the same, so no generation bump is
      // needed for the guard; `start` takes one anyway.
      const pending = deps.readPending({ origin: visit.origin, now: deps.now() });
      if (pending === null) {
        generation += 1;
        current = null;
        return publish({ kind: 'clear' });
      }
      return start(visit, pending.record);
    },

    reset() {
      generation += 1;
      current = null;
      publish({ kind: 'clear' });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
