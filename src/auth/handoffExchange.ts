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
export async function mintAuthHandoff(request: HandoffRequest): Promise<string> {
  const callable = httpsCallable<
    { targetOrigin: string; transactionId: string; returnPath: string },
    { handoffUrl: string; targetOrigin: string; expiresAt: number }
  >(functions, 'mintAuthHandoff');
  const result = await callable({
    targetOrigin: request.targetOrigin,
    transactionId: request.transactionId,
    returnPath: request.returnPath,
  });
  return result.data.handoffUrl;
}
