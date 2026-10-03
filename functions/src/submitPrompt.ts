/** Server-authoritative Community Prompt intake (#1311, ADR 0017).
 * The dark callable is introduced before the separate client/Rules cutover.
 * Live pending rows, not a drifting counter, define capacity. A per-Player
 * fence serializes concurrent submissions without writing the shared Event.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { SubmitPromptRequest, SubmitPromptResponse, EventDoc } from '../../src/domainTypes';
import { defaultTargetDayIndex } from './communityPromptRouting.generated';
import { isActiveMembershipData, membershipPath } from './eventMembership.generated';
import { isFirestoreDocumentId } from './firestoreIds';
import { firestoreErrorCodeForLog } from './firestoreErrors';
import { eventClosedToPlay, isEventAdmin } from './unlockDay';

export const MAX_PENDING_PROMPTS = 10;
// Functions rootDir forbids a runtime import from src/data/eventLimits.ts.
// The admission tests pin this mirror to its canonical MAX_DAYS contract.
export const MAX_PROMPT_TARGET_DAYS = 20;
function supportedSubmissionTarget(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value < MAX_PROMPT_TARGET_DAYS;
}
export interface SubmitPromptDeps {
  db: Firestore;
  now: () => number;
  logger?: { error(message: string, context: Readonly<Record<string, unknown>>): void };
}

/** Fixed-shape input; captured UID is a required intent guard, never ownership.
 * Caller creation stamps, ownership and targets remain ignored. */
export function parseSubmitPromptRequest(raw: unknown): SubmitPromptRequest {
  const value = raw as Partial<SubmitPromptRequest> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isFirestoreDocumentId(value.expectedUid) || !isFirestoreDocumentId(value.eventId) || !isFirestoreDocumentId(value.itemId) ||
      typeof value.text !== 'string' || !value.text.trim() || value.text.trim().length > 80 ||
      typeof value.spicy !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Enter a Prompt of 1–80 characters.');
  }
  return { expectedUid: value.expectedUid, eventId: value.eventId, itemId: value.itemId, text: value.text.trim(), spicy: value.spicy };
}

export async function submitPromptCore(
  deps: SubmitPromptDeps, uid: string, input: SubmitPromptRequest,
): Promise<SubmitPromptResponse> {
  // Boundary validation also applies to direct core callers and the auth UID
  // before constructing Admin paths, preserving the canonical segment bound.
  input = parseSubmitPromptRequest(input);
  if (!isFirestoreDocumentId(uid)) throw new HttpsError('unauthenticated', 'Sign in before adding a Prompt.');
  // Bind the captured submitting account to the eventual Functions auth header.
  // A client precheck alone cannot fence SDK header resolution after a switch.
  if (input.expectedUid !== uid) throw new HttpsError('unauthenticated', 'Sign in with the account that started this Prompt.');
  const base = `events/${input.eventId}`;
  const eventRef = deps.db.doc(base);
  const itemRef = deps.db.doc(`${base}/items/${input.itemId}`);
  const fenceRef = deps.db.doc(`${base}/promptQuota/${uid}`);
  return deps.db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    const event = eventSnap.exists ? eventSnap.data() as EventDoc : undefined;
    if (!event) throw new HttpsError('permission-denied', 'This Event is unavailable.');
    // Preserve Decision D-A's transitional rostered-Admin admission bypass.
    // Remove in lockstep with Rules only after #805's live backfill acceptance.
    if (event.membershipEnforcement === 'enforced' && !isEventAdmin(event, uid)) {
      const member = await tx.get(deps.db.doc(membershipPath(input.eventId, uid)));
      if (!isActiveMembershipData(member.data())) {
        throw new HttpsError('permission-denied', 'Join this Event before adding a Prompt.');
      }
    }
    const existing = await tx.get(itemRef);
    if (existing.exists) {
      const row = existing.data();
      if (row?.createdBy !== uid) throw new HttpsError('already-exists', 'Choose a new submission ID.');
      if (row.targetDayIndex !== undefined && !supportedSubmissionTarget(row.targetDayIndex)) {
        throw new HttpsError('failed-precondition', 'Prompt submission needs an Admin check.');
      }
      // A lost response may be retried after approval/rejection or at capacity.
      // Never rewrite content, routing or status on the already-owned ID.
      return { id: input.itemId, ...(row.targetDayIndex === undefined ? {} : { targetDayIndex: row.targetDayIndex }) };
    }
    // Acknowledgment above makes no gameplay write: a committed request remains
    // retryable when the Event closes after its response was lost. New IDs stop.
    if (eventClosedToPlay(event)) throw new HttpsError('failed-precondition', 'This Event is closed.');
    const fence = await tx.get(fenceRef);
    const pending = await tx.get(deps.db.collection(`${base}/items`)
      .where('createdBy', '==', uid).where('status', '==', 'pending').limit(MAX_PENDING_PROMPTS));
    if (pending.size >= MAX_PENDING_PROMPTS) {
      throw new HttpsError('resource-exhausted', 'You have 10 Prompts waiting for review. Try again after some are reviewed.');
    }
    const createdAt = deps.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new HttpsError('internal', 'Prompt submission failed; try again with signal.');
    }
    const target = defaultTargetDayIndex(Array.isArray(event.days) ? event.days : [], createdAt);
    if (target !== null && !supportedSubmissionTarget(target)) {
      throw new HttpsError('failed-precondition', 'Prompt submission needs an Admin check.');
    }
    tx.create(itemRef, {
      text: input.text, createdBy: uid, createdAt, isFreeSpace: false,
      status: 'pending', reportCount: 0, spicy: input.spicy, pool: 'main',
      ...(target == null ? {} : { targetDayIndex: target }),
    });
    const sequence = fence.data()?.seq;
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER)) {
      throw new HttpsError('failed-precondition', 'Prompt submission needs an Admin check.');
    }
    tx.set(fenceRef, { seq: (sequence ?? 0) + 1 });
    return { id: input.itemId, ...(target == null ? {} : { targetDayIndex: target }) };
  });
}

export async function submitPromptCallable(
  request: CallableRequest<unknown>, requireAppCheck: boolean, deps: SubmitPromptDeps,
): Promise<SubmitPromptResponse> {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in before adding a Prompt.');
  if (requireAppCheck && !request.app) throw new HttpsError('failed-precondition', 'App Check is required.');
  const input = parseSubmitPromptRequest(request.data);
  try {
    return await submitPromptCore(deps, request.auth.uid, input);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const code = firestoreErrorCodeForLog(error);
    deps.logger?.error('submitPrompt failed', { code });
    throw new HttpsError(code === 'aborted' || code === 'ABORTED' || code === 10 || code === '10' ? 'aborted' : 'internal', 'Prompt submission failed; try again with signal.');
  }
}
