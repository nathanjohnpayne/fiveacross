/**
 * The two handoff legs that call Cloud Functions (#549, ADR 0010, server
 * contract in `specs/auth-handoff.md`).
 *
 * Split from `handoffClient.ts` so that importing the boundary primitives — the
 * fragment reader, the failure channel, the start leg — does not drag the
 * Firebase SDK along with them. `SignIn.tsx` needs those primitives and nothing
 * here; keeping the two apart is what lets it stay cheap to import and mockable
 * in tests that never boot Firebase.
 */
import { httpsCallable } from 'firebase/functions';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  initializeAuth,
  inMemoryPersistence,
  signInWithCustomToken,
  updateCurrentUser,
  type Auth,
} from 'firebase/auth';
import { app, auth, functions } from '../firebase';
import { attestAdult } from '../data/api';
import { recordHandoffFailure, type HandoffRequest } from './handoffClient';
import {
  createVerifier,
  forgetHandoffTransaction,
  readHandoffTransaction,
} from './handoffTransaction';

/**
 * How long the return leg may take before it gives up, in milliseconds.
 *
 * A BOUND, not a preference, and it protects against a blank screen rather than
 * a slow one. `main.tsx` awaits this before it renders anything, because the
 * session has to exist before `onAuthStateChanged` first settles — so an
 * exchange that never settles renders NOTHING AT ALL, which is the 2026-07-24
 * incident shape the whole bootstrap path is written to avoid. Captive and
 * shipboard wifi produce exactly that: `navigator.onLine` true and a request
 * that hangs forever.
 *
 * Fifteen seconds is generous against a slow phone on bad wifi and far inside
 * the patience of someone staring at a blank page. Timing out costs the player
 * one re-sign-in; not timing out costs them the app.
 */
export const HANDOFF_EXCHANGE_TIMEOUT_MS = 15_000;

function emulatorUrl({ protocol, host, port }: NonNullable<Auth['emulatorConfig']>): string {
  const authority = port === null ? host : `${host}:${port}`;
  return `${protocol}://${authority}`;
}

/**
 * A one-attempt Auth instance whose state can never enter origin-wide Firebase
 * persistence (#913).
 *
 * `signInWithCustomToken` updates and persists its Auth instance before its
 * promise resolves. Running an abandonable request against the main `auth`
 * therefore cannot be repaired safely after timeout: the late operation has
 * already overwritten any newer cross-tab session before a continuation can
 * inspect it. The request runs against an in-memory secondary app instead. Only
 * an in-bound credential is copied to the main Auth via `updateCurrentUser`.
 */
function isolatedHandoffAuth(): { auth: Auth; app: FirebaseApp } {
  const isolatedApp = initializeApp(app.options, `fa-handoff-${createVerifier()}`);
  try {
    const isolatedAuth = initializeAuth(isolatedApp, {
      persistence: inMemoryPersistence,
      popupRedirectResolver: undefined,
    });
    isolatedAuth.tenantId = auth.tenantId;

    // Keep the same compile-time emulator gate as `src/firebase.ts`. Production
    // builds fold this branch away, including the connector implementation and
    // emulator host strings; e2e builds must wire the secondary before sign-in.
    if (
      import.meta.env.MODE === 'e2e' &&
      import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-')
    ) {
      const emulator = auth.emulatorConfig;
      if (emulator !== null) {
        connectAuthEmulator(isolatedAuth, emulatorUrl(emulator), emulator.options);
      }
    }

    return { auth: isolatedAuth, app: isolatedApp };
  } catch (error) {
    void deleteApp(isolatedApp).catch(() => {});
    throw error;
  }
}

/**
 * `work`, or a rejection once `ms` has passed.
 *
 * A rejection rather than a resolved sentinel, so a timeout lands in the same
 * `catch` as every other failure and cannot be mistaken for a successful
 * exchange by a caller that forgot to check.
 */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handoff-timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
/**
 * LEG 2 — mint, at the central auth origin, for a caller that has just signed in.
 *
 * Returns the server-built `handoffUrl` verbatim. This function deliberately
 * does NOT navigate: the caller does, and it does so with exactly this string.
 * Rebuilding or appending to it is what would turn the return leg into an open
 * redirect, and the whole reason the server returns a URL rather than a code is
 * so no client ever assembles one.
 */
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

/**
 * LEG 3 — complete, back at the Event origin.
 *
 * Called pre-mount when the fragment carries a code. Every terminal path — the
 * successful one included — deletes the verifier, because a verifier that
 * outlives its transaction is a credential with nothing left to protect.
 *
 * Returns `true` when a session now exists. A `false` return has already
 * recorded a named failure for the UI to surface; it never retries and never
 * falls back to another sign-in mode, because the code is single-use and is
 * spent by the time anything here can fail.
 */
export async function completeAuthHandoff(input: {
  code: string;
  origin: string;
  now?: number;
  /** Overridable so tests do not have to wait out the real bound. */
  timeoutMs?: number;
}): Promise<boolean> {
  const transaction = readHandoffTransaction(input.now ?? Date.now());
  if (transaction === null) {
    forgetHandoffTransaction();
    recordHandoffFailure('transaction-missing');
    return false;
  }
  // The transaction records the origin sign-in began on. Arriving anywhere else
  // means this browser's stored verifier does not belong to this return — the
  // server would refuse the exchange anyway, so refusing here just skips a
  // round trip and keeps the verifier from being sent to the wrong place.
  if (transaction.targetOrigin !== input.origin) {
    forgetHandoffTransaction();
    recordHandoffFailure('origin-mismatch');
    return false;
  }

  const timeoutMs = input.timeoutMs ?? HANDOFF_EXCHANGE_TIMEOUT_MS;
  try {
    // `updateCurrentUser` queues behind primary Auth initialization. Settle that
    // queue under the deadline before any code is spent or isolated sign-in is
    // started; the later shared-auth commit is then short and deliberately not
    // raced, because returning failure while it continued would recreate the
    // late global mutation this isolation exists to prevent.
    await bounded(auth.authStateReady(), timeoutMs);
  } catch {
    forgetHandoffTransaction();
    recordHandoffFailure('sign-in-failed');
    return false;
  }

  let customToken: string;
  try {
    const callable = httpsCallable<
      { code: string; transactionVerifier: string; origin: string },
      { customToken: string }
    >(functions, 'exchangeAuthHandoff');
    const result = await bounded(
      callable({
        code: input.code,
        transactionVerifier: transaction.verifier,
        origin: input.origin,
      }),
      timeoutMs,
    );
    customToken = result.data.customToken;
  } catch {
    // The clearing lives in `finally` alone, not here as well: one unconditional
    // place to delete the verifier is easier to prove exhaustive than two that
    // have to agree.
    recordHandoffFailure('exchange-rejected');
    return false;
  } finally {
    // Before the sign-in below, not after: the verifier has done its only job
    // the moment the exchange returns, and the code it was paired with is spent
    // either way — success, rejection, and timeout alike.
    forgetHandoffTransaction();
  }

  let isolatedApp: FirebaseApp | null = null;
  try {
    const isolated = isolatedHandoffAuth();
    isolatedApp = isolated.app;
    const credential = await bounded(signInWithCustomToken(isolated.auth, customToken), timeoutMs);
    // This is the only shared-auth mutation. A credential that arrives after
    // the bound never reaches this line, even if another tab has since signed in.
    await updateCurrentUser(auth, credential.user);
    if (transaction.acknowledgedAdultContent) {
      try {
        await bounded(attestAdult(credential.user), timeoutMs);
      } catch {
        // Authentication already succeeded. A failed acknowledgement write
        // leaves the settled profile unstamped, so AuthProvider's existing
        // re-prompt safely collects it again instead of treating sign-in as
        // failed after the shared session was already committed.
      }
    }
    return true;
  } catch {
    recordHandoffFailure('sign-in-failed');
    return false;
  } finally {
    if (isolatedApp !== null) await deleteApp(isolatedApp).catch(() => {});
  }
}
