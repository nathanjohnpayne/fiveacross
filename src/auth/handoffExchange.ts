/**
 * The central-origin handoff mint callable (#549, ADR 0010).
 *
 * Return completion lives behind `handoffReturn.ts` and its disposable Worker.
 * Keeping this module mint-only prevents the page graph from regaining a
 * primary-Auth mutation path.
 */
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebaseCore';
import type { HandoffRequest } from './handoffClient';

/** Use the server-built return URL verbatim; the client never assembles it. */
/**
 * `expectedUid` is the account the player confirmed (or just signed in as). The
 * callable mints for whoever the call authenticates as, which another tab can
 * change while the page waits; the server refuses when the two differ, so the
 * code is only ever minted for the account the player saw.
 */
export async function mintAuthHandoff(
  request: HandoffRequest,
  options: { expectedUid?: string } = {},
): Promise<string> {
  const callable = httpsCallable<
    { targetOrigin: string; transactionId: string; returnPath: string; expectedUid?: string },
    { handoffUrl: string; targetOrigin: string; expiresAt: number }
  >(functions, 'mintAuthHandoff');
  const result = await callable({
    targetOrigin: request.targetOrigin,
    transactionId: request.transactionId,
    returnPath: request.returnPath,
    ...(options.expectedUid !== undefined ? { expectedUid: options.expectedUid } : {}),
  });
  return result.data.handoffUrl;
}
