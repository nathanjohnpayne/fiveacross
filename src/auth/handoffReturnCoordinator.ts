import type {
  HandoffAttemptIdentity,
  HandoffAttemptLease,
} from './handoffAttemptFence';
import type { HandoffSessionCandidate } from './handoffCommitProtocol';
import type { HandoffFailureReason } from './handoffClient';
import type { HandoffTransactionRecord } from './handoffTransaction';

export type HandoffReturnResult =
  | { kind: 'continue' }
  | { kind: 'recover' };

interface HandoffCommitClient {
  initialize(signal: AbortSignal): Promise<void>;
  prepare(customToken: string, signal: AbortSignal): Promise<HandoffSessionCandidate>;
  commit(signal: AbortSignal): Promise<boolean>;
  terminate(): void;
}

interface HandoffFence {
  register(identity: HandoffAttemptIdentity, signal?: AbortSignal): Promise<boolean>;
  withCurrentAttempt<T>(
    identity: HandoffAttemptIdentity,
    signal: AbortSignal | undefined,
    work: (lease: HandoffAttemptLease) => T | Promise<T>,
  ): Promise<{ kind: 'superseded' } | { kind: 'current'; value: T }>;
}

interface PageAuthObserver<UserType> {
  ready(signal: AbortSignal): Promise<void>;
  /** Installs its listener synchronously before returning this Promise. */
  observeExact(
    candidate: HandoffSessionCandidate,
    ownerNonce: string,
    signal: AbortSignal,
  ): Promise<UserType>;
}

export interface HandoffReturnDependencies<UserType> {
  capabilitiesAvailable(): boolean;
  readTransaction(now: number): HandoffTransactionRecord | null;
  forgetTransactionIf(transaction: HandoffTransactionRecord): boolean;
  transactionIdFor(verifier: string): Promise<string>;
  createOwnerNonce(): string;
  createWorker(identity: HandoffAttemptIdentity): HandoffCommitClient;
  fence: HandoffFence;
  exchange(input: {
    code: string;
    origin: string;
    transaction: HandoffTransactionRecord;
    signal: AbortSignal;
  }): Promise<string>;
  pageAuth: PageAuthObserver<UserType>;
  rememberAttestation(user: UserType): boolean;
  recordFailure(reason: HandoffFailureReason): void;
  onPageHide(handler: () => void): () => void;
  monotonicNow(): number;
}

class SafeHandoffFailure extends Error {
  constructor(readonly reason: HandoffFailureReason) {
    super(reason);
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('handoff-timeout'));
  return new Promise<T>((resolve, reject) => {
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

function requireBeforeDeadline(deadlineAt: number, monotonicNow: () => number): void {
  if (monotonicNow() >= deadlineAt) throw new Error('handoff-timeout');
}

async function withinDeadline<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  monotonicNow: () => number,
): Promise<T> {
  requireBeforeDeadline(deadlineAt, monotonicNow);
  const value = await abortable(start(), signal);
  // A promise reaction can win the task-queue race with a timer callback that
  // is already due. The monotonic boundary, not callback order, decides.
  requireBeforeDeadline(deadlineAt, monotonicNow);
  return value;
}

/**
 * Testable state machine behind the pre-app handoff return.
 *
 * Safe failures happen before this document's primary Auth is imported and may
 * continue signed out. Once page Auth is touched, every uncertain outcome is a
 * recovery-only result: the caller must not import the application graph.
 */
export async function completeHandoffReturnWithDependencies<UserType>(
  input: { code: string; origin: string; timeoutMs: number; now?: number },
  dependencies: HandoffReturnDependencies<UserType>,
): Promise<HandoffReturnResult> {
  const transaction = dependencies.readTransaction(input.now ?? Date.now());
  if (transaction === null) {
    dependencies.recordFailure('transaction-missing');
    return { kind: 'continue' };
  }
  let transactionCleanupAttempted = false;
  const forgetOwnedTransaction = () => {
    if (transactionCleanupAttempted) return;
    transactionCleanupAttempted = true;
    dependencies.forgetTransactionIf(transaction);
  };
  if (transaction.targetOrigin !== input.origin) {
    forgetOwnedTransaction();
    dependencies.recordFailure('origin-mismatch');
    return { kind: 'continue' };
  }
  if (!dependencies.capabilitiesAvailable()) {
    forgetOwnedTransaction();
    dependencies.recordFailure('sign-in-failed');
    return { kind: 'continue' };
  }

  const abortController = new AbortController();
  const deadlineAt = dependencies.monotonicNow() + input.timeoutMs;
  const deadline = setTimeout(
    () => abortController.abort(),
    Math.max(0, deadlineAt - dependencies.monotonicNow()),
  );
  const signal = abortController.signal;
  let worker: HandoffCommitClient | null = null;
  let workerTerminated = false;
  let pageAuthTouched = false;
  let commitStarted = false;
  let identity: HandoffAttemptIdentity | null = null;
  let fenceRegistrationAttempted = false;
  let fenceCleared = false;

  const terminateWorker = () => {
    if (worker === null || workerTerminated) return;
    workerTerminated = true;
    worker.terminate();
  };
  const removePageHide = dependencies.onPageHide(() => {
    terminateWorker();
    abortController.abort();
  });

  try {
    identity = {
      transactionId: await withinDeadline(
        () => dependencies.transactionIdFor(transaction.verifier),
        signal,
        deadlineAt,
        dependencies.monotonicNow,
      ),
      ownerNonce: dependencies.createOwnerNonce(),
    };
    worker = dependencies.createWorker(identity);
    await withinDeadline(
      () => worker!.initialize(signal),
      signal,
      deadlineAt,
      dependencies.monotonicNow,
    );
    fenceRegistrationAttempted = true;
    if (!(await withinDeadline(
      () => dependencies.fence.register(identity!, signal),
      signal,
      deadlineAt,
      dependencies.monotonicNow,
    ))) {
      throw new SafeHandoffFailure('sign-in-failed');
    }
    let customToken: string;
    try {
      customToken = await withinDeadline(
        () => dependencies.exchange({ code: input.code, origin: input.origin, transaction, signal }),
        signal,
        deadlineAt,
        dependencies.monotonicNow,
      );
    } catch {
      throw new SafeHandoffFailure('exchange-rejected');
    } finally {
      // The code is one-use and the verifier has completed its only job whether
      // exchange resolves, rejects, or times out. Ownership prevents an older
      // return from unconditionally clearing a replacement record.
      forgetOwnedTransaction();
    }

    const candidate = await withinDeadline(
      () => worker!.prepare(customToken, signal),
      signal,
      deadlineAt,
      dependencies.monotonicNow,
    );
    const fenced = await withinDeadline(
      () => dependencies.fence.withCurrentAttempt(identity!, signal, async (lease) => {
        pageAuthTouched = true;
        let clearedInsideLease = false;
        try {
          await withinDeadline(
            () => dependencies.pageAuth.ready(signal),
            signal,
            deadlineAt,
            dependencies.monotonicNow,
          );
          // The production adapter installs the observer synchronously here,
          // before the commit message can cross into the Worker.
          requireBeforeDeadline(deadlineAt, dependencies.monotonicNow);
          const observation = dependencies.pageAuth.observeExact(
            candidate,
            identity!.ownerNonce,
            signal,
          );
          const exactUser = withinDeadline(
            () => observation,
            signal,
            deadlineAt,
            dependencies.monotonicNow,
          );
          requireBeforeDeadline(deadlineAt, dependencies.monotonicNow);
          commitStarted = true;
          // Exact page adoption is the proof of success. Still observe the
          // Worker's post-commit channel so malformed output and Worker errors
          // are consumed rather than becoming invisible or unhandled; a
          // mutate-then-reject settlement may nevertheless be followed by an
          // exact durable page observation.
          void worker!.commit(signal).catch(() => false);
          const user = await exactUser;
          if (transaction.acknowledgedAdultContent) {
            try {
              dependencies.rememberAttestation(user);
            } catch {
              // Authentication is already exact. Losing the convenience marker
              // falls back to the ordinary settled-profile re-prompt.
            }
          }
          if (!(await lease.clear())) throw new Error('handoff-fence-clear-failed');
          clearedInsideLease = true;
          fenceCleared = true;
          return user;
        } finally {
          // Load-bearing ordering: a timed-out mutating Worker is gone before
          // the page returns from this lock callback and releases the lock.
          terminateWorker();
          if (!clearedInsideLease) {
            try {
              fenceCleared = await lease.clear();
            } catch {
              // Best effort only: the recovery screen remains fail-closed, and
              // a later attempt overwrites a stale owned record under this lock.
            }
          }
        }
      }),
      signal,
      deadlineAt,
      dependencies.monotonicNow,
    );

    if (fenced.kind === 'superseded') {
      throw new SafeHandoffFailure('sign-in-failed');
    }
    return { kind: 'continue' };
  } catch (error) {
    terminateWorker();
    forgetOwnedTransaction();
    if (!pageAuthTouched && fenceRegistrationAttempted && !fenceCleared && identity !== null) {
      const cleanup = dependencies.fence
        .withCurrentAttempt(identity, undefined, async (lease) => {
          fenceCleared = await lease.clear();
          return fenceCleared;
        })
        .catch(() => ({ kind: 'superseded' as const }));
      if (!signal.aborted && dependencies.monotonicNow() < deadlineAt) {
        try {
          await withinDeadline(() => cleanup, signal, deadlineAt, dependencies.monotonicNow);
        } catch {
          // The already-started compare-delete remains best-effort and is
          // ownership checked; do not extend the cumulative user-visible bound.
        }
      } else {
        void cleanup;
      }
    }
    if (pageAuthTouched || commitStarted) return { kind: 'recover' };
    const reason = error instanceof SafeHandoffFailure ? error.reason : 'sign-in-failed';
    dependencies.recordFailure(reason);
    return { kind: 'continue' };
  } finally {
    // Cancels every listener/poll even when the monotonic boundary was reached
    // before the timer callback itself ran.
    abortController.abort();
    clearTimeout(deadline);
    removePageHide();
    terminateWorker();
  }
}
