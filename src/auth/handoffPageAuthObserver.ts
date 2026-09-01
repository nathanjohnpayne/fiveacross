import { fingerprintHandoffSession } from './handoffSessionFingerprint';
import type { HandoffSessionCandidate } from './handoffCommitProtocol';

export interface HandoffPageUser {
  uid: string;
  refreshToken: string;
}

interface PageAuthLike<UserType extends HandoffPageUser> {
  currentUser: UserType | null;
  authStateReady(): Promise<void>;
}

interface LoadedPageAuth<UserType extends HandoffPageUser> {
  auth: PageAuthLike<UserType>;
  subscribe(
    auth: PageAuthLike<UserType>,
    next: (user: UserType | null) => void,
    error?: () => void,
  ): () => void;
}

type SessionFingerprint = (input: {
  ownerNonce: string;
  uid: string;
  refreshToken: string;
}) => Promise<string>;

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('handoff-timeout'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('handoff-timeout'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) reject(new Error('handoff-timeout'));
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

export function createHandoffPageAuthObserver<UserType extends HandoffPageUser>(
  load: () => Promise<LoadedPageAuth<UserType>>,
  fingerprint: SessionFingerprint = fingerprintHandoffSession,
) {
  let loaded: LoadedPageAuth<UserType> | null = null;

  return {
    async ready(signal: AbortSignal): Promise<void> {
      const next = await withAbort(load(), signal);
      await withAbort(next.auth.authStateReady(), signal);
      loaded = next;
    },

    observeExact(
      candidate: HandoffSessionCandidate,
      ownerNonce: string,
      signal: AbortSignal,
    ): Promise<UserType> {
      if (loaded === null) throw new Error('handoff-page-auth-not-ready');
      if (signal.aborted) throw new Error('handoff-timeout');
      const current = loaded;
      let resolveExact = (_user: UserType) => {};
      let rejectExact = (_error: Error) => {};
      const exact = new Promise<UserType>((resolve, reject) => {
        resolveExact = resolve;
        rejectExact = reject;
      });
      let settled = false;
      let observationGeneration = 0;
      let lastObservedIdentity = '';
      let unsubscribe = () => {};
      let poll: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        unsubscribe();
        if (poll !== null) clearInterval(poll);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectExact(error);
      };
      const onAbort = () => fail(new Error('handoff-timeout'));
      const next = (user: UserType | null) => {
        if (settled || user === null || user.uid !== candidate.uid || !user.refreshToken) return;
        const observedIdentity = `${user.uid.length}:${user.uid}${user.refreshToken.length}:${user.refreshToken}`;
        if (observedIdentity === lastObservedIdentity) return;
        lastObservedIdentity = observedIdentity;
        const generation = ++observationGeneration;
        const refreshToken = user.refreshToken;
        void fingerprint({ ownerNonce, uid: user.uid, refreshToken }).then(
          (digest) => {
            if (settled || generation !== observationGeneration) return;
            // Fingerprinting is asynchronous. Recheck that the page still
            // owns the credential whose token was hashed before accepting it.
            const stillCurrent = current.auth.currentUser;
            if (
              digest !== candidate.refreshTokenDigest ||
              stillCurrent?.uid !== user.uid ||
              stillCurrent.refreshToken !== refreshToken
            ) {
              // The same exact credential may become current again after a
              // racing session made this asynchronous hash stale. Allow the
              // next event/poll to prove it afresh.
              if (generation === observationGeneration) lastObservedIdentity = '';
              return;
            }
            settled = true;
            cleanup();
            resolveExact(user);
          },
          () => fail(new Error('handoff-page-auth-fingerprint-failed')),
        );
      };

      signal.addEventListener('abort', onAbort, { once: true });
      try {
        unsubscribe = current.subscribe(current.auth, next, () =>
          fail(new Error('handoff-page-auth-observer-failed')),
        );
      } catch {
        cleanup();
        throw new Error('handoff-page-auth-observer-failed');
      }
      // The pinned SDK's same-uid storage path can replace a refresh token
      // without emitting an auth-state event, and its id-token listener may
      // also stay quiet when the access token itself is unchanged. Observe
      // the public in-memory User as the narrow fallback.
      next(current.auth.currentUser);
      poll = setInterval(() => next(current.auth.currentUser), 100);
      if (signal.aborted) onAbort();
      return exact;
    },
  };
}

/** Load primary Auth only when the coordinator crosses this explicit seam. */
export function createProductionHandoffPageAuthObserver() {
  return createHandoffPageAuthObserver(async () => {
    const [{ auth }, { onIdTokenChanged }] = await Promise.all([
      import('../firebaseAuth'),
      import('firebase/auth'),
    ]);
    return {
      auth,
      subscribe: (_auth: typeof auth, next: Parameters<typeof onIdTokenChanged>[1], error?: () => void) =>
        onIdTokenChanged(auth, next, error),
    };
  });
}
