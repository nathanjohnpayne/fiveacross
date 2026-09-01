import { httpsCallable } from 'firebase/functions';
import { app, firebaseEmulatorsEnabled, functions } from '../firebaseCore';
import { rememberHandoffAttestation } from './handoffAttestation';
import {
  createHandoffAttemptFence,
  type HandoffAttemptIdentity,
} from './handoffAttemptFence';
import {
  createBrowserHandoffLockRunner,
  createIndexedDbHandoffFenceStore,
} from './handoffBrowserPrimitives';
import { createHandoffCommitClient } from './handoffCommitClient';
import { recordHandoffFailure } from './handoffClient';
import { createProductionHandoffPageAuthObserver } from './handoffPageAuthObserver';
import {
  completeHandoffReturnWithDependencies,
  type HandoffReturnResult,
} from './handoffReturnCoordinator';
import {
  forgetHandoffTransactionIf,
  readHandoffTransaction,
  transactionIdFor,
} from './handoffTransaction';

/** One cumulative bound across capability proof, exchange, commit and adoption. */
export const HANDOFF_EXCHANGE_TIMEOUT_MS = 15_000;

function platformCanSuperviseCommit(): boolean {
  return (
    typeof globalThis.Worker === 'function' &&
    typeof globalThis.indexedDB !== 'undefined' &&
    typeof globalThis.navigator?.locks?.request === 'function' &&
    typeof globalThis.crypto?.getRandomValues === 'function' &&
    typeof globalThis.crypto?.subtle?.digest === 'function'
  );
}

function ownerNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function productionLockRunner() {
  return createBrowserHandoffLockRunner({
    request: async <T>(
      name: string,
      options: { mode: 'exclusive'; signal?: AbortSignal },
      work: () => T | Promise<T>,
    ): Promise<T> => globalThis.navigator.locks.request(name, options, async () => work()),
  });
}

function authEmulatorUrl(): string | null {
  return firebaseEmulatorsEnabled() ? 'http://127.0.0.1:9099' : null;
}

function workerForAttempt(identity: HandoffAttemptIdentity) {
  const worker = new Worker(new URL('./handoffCommit.worker.ts', import.meta.url), {
    type: 'module',
    name: 'fiveacross-auth-handoff-commit',
  });
  return createHandoffCommitClient({
    worker,
    attempt: identity,
    firebaseOptions: app.options,
    tenantId: null,
    emulatorUrl: authEmulatorUrl(),
  });
}

/** Complete one captured return before the application/Auth graph is imported. */
export function completeHandoffReturn(input: {
  code: string;
  origin: string;
  now?: number;
  timeoutMs?: number;
}): Promise<HandoffReturnResult> {
  const indexedDbFactory = globalThis.indexedDB;
  const fence =
    indexedDbFactory === undefined
      ? {
          register: async () => {
            throw new Error('handoff-indexeddb-unavailable');
          },
          withCurrentAttempt: async () => {
            throw new Error('handoff-indexeddb-unavailable');
          },
        }
      : createHandoffAttemptFence({
          store: createIndexedDbHandoffFenceStore(indexedDbFactory),
          locks: productionLockRunner(),
        });
  const pageAuth = createProductionHandoffPageAuthObserver();
  return completeHandoffReturnWithDependencies(
    {
      code: input.code,
      origin: input.origin,
      now: input.now,
      timeoutMs: input.timeoutMs ?? HANDOFF_EXCHANGE_TIMEOUT_MS,
    },
    {
      capabilitiesAvailable: platformCanSuperviseCommit,
      readTransaction: readHandoffTransaction,
      forgetTransactionIf: forgetHandoffTransactionIf,
      transactionIdFor,
      createOwnerNonce: ownerNonce,
      createWorker: workerForAttempt,
      fence,
      exchange: async ({ code, origin, transaction }) => {
        const callable = httpsCallable<
          { code: string; transactionVerifier: string; origin: string },
          { customToken: string }
        >(functions, 'exchangeAuthHandoff');
        const result = await callable({
          code,
          transactionVerifier: transaction.verifier,
          origin,
        });
        if (typeof result.data.customToken !== 'string' || result.data.customToken.length === 0) {
          throw new Error('handoff-custom-token-missing');
        }
        return result.data.customToken;
      },
      pageAuth,
      rememberAttestation: rememberHandoffAttestation,
      recordFailure: recordHandoffFailure,
      onPageHide: (handler) => {
        window.addEventListener('pagehide', handler, { once: true });
        return () => window.removeEventListener('pagehide', handler);
      },
      monotonicNow: () => performance.now(),
    },
  );
}
