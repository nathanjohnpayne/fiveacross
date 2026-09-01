import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeHandoffReturnWithDependencies,
  type HandoffReturnDependencies,
} from './handoffReturnCoordinator';
import type { HandoffTransactionRecord } from './handoffTransaction';

const transaction: HandoffTransactionRecord = {
  verifier: 'V'.repeat(43),
  targetOrigin: 'https://summer-camp.fiveacross.app',
  returnPath: '/board',
  acknowledgedAdultContent: true,
  createdAt: 1,
};

function setup() {
  const events: string[] = [];
  const user = { uid: 'user', refreshToken: 'refresh-token' };
  let pageHide: (() => void) | null = null;
  const worker = {
    initialize: vi.fn(async () => void events.push('worker-ready')),
    prepare: vi.fn(async () => {
      events.push('worker-prepared');
      return { uid: 'user', refreshTokenDigest: 'digest' };
    }),
    commit: vi.fn(async () => {
      events.push('worker-commit');
      return true;
    }),
    terminate: vi.fn(() => void events.push('worker-terminate')),
  };
  const dependencies: HandoffReturnDependencies<typeof user> = {
    capabilitiesAvailable: () => true,
    readTransaction: () => transaction,
    forgetTransactionIf: vi.fn(() => true),
    transactionIdFor: vi.fn(async () => 'transaction-id'),
    createOwnerNonce: () => 'owner',
    createWorker: vi.fn(() => worker),
    fence: {
      register: vi.fn(async () => true),
      withCurrentAttempt: vi.fn(async (_identity, _signal, work) => {
        events.push('lock-acquired');
        try {
          const value = await work({
            clear: async () => {
              events.push('fence-cleared');
              return true;
            },
          });
          return { kind: 'current' as const, value };
        } finally {
          events.push('lock-released');
        }
      }),
    },
    exchange: vi.fn(async () => {
      events.push('exchanged');
      return 'custom-token';
    }),
    pageAuth: {
      ready: vi.fn(async () => void events.push('page-auth-ready')),
      observeExact: vi.fn(async () => {
        events.push('page-auth-exact');
        return user;
      }),
    },
    rememberAttestation: vi.fn(() => {
      events.push('attestation-staged');
      return true;
    }),
    recordFailure: vi.fn(),
    onPageHide: (handler) => {
      pageHide = handler;
      return () => {
        pageHide = null;
      };
    },
    monotonicNow: () => performance.now(),
  };
  return { dependencies, events, pageHide: () => pageHide?.(), user, worker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('handoff return coordinator', () => {
  it('holds the page lock through exact adoption and terminates before releasing it', async () => {
    const { dependencies, events, worker, user } = setup();

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });

    expect(dependencies.pageAuth.observeExact).toHaveBeenCalledWith(
      { uid: 'user', refreshTokenDigest: 'digest' },
      'owner',
      expect.any(AbortSignal),
    );
    expect(dependencies.rememberAttestation).toHaveBeenCalledWith(user);
    expect(events).toEqual([
      'worker-ready',
      'exchanged',
      'worker-prepared',
      'lock-acquired',
      'page-auth-ready',
      'page-auth-exact',
      'worker-commit',
      'attestation-staged',
      'fence-cleared',
      'worker-terminate',
      'lock-released',
    ]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(dependencies.forgetTransactionIf).toHaveBeenCalledOnce();
    expect(dependencies.forgetTransactionIf).toHaveBeenCalledWith(transaction);
  });

  it('names a missing transaction without constructing a Worker', async () => {
    const { dependencies } = setup();
    dependencies.readTransaction = () => null;

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });

    expect(dependencies.recordFailure).toHaveBeenCalledWith('transaction-missing');
    expect(dependencies.forgetTransactionIf).not.toHaveBeenCalled();
    expect(dependencies.createWorker).not.toHaveBeenCalled();
  });

  it('compare-deletes an origin-mismatched transaction before continuing', async () => {
    const { dependencies } = setup();

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: 'https://other.example', timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });

    expect(dependencies.recordFailure).toHaveBeenCalledWith('origin-mismatch');
    expect(dependencies.forgetTransactionIf).toHaveBeenCalledOnce();
    expect(dependencies.forgetTransactionIf).toHaveBeenCalledWith(transaction);
    expect(dependencies.createWorker).not.toHaveBeenCalled();
  });

  it('fails before exchange when a required browser capability is absent', async () => {
    const { dependencies } = setup();
    dependencies.capabilitiesAvailable = () => false;

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });

    expect(dependencies.createWorker).not.toHaveBeenCalled();
    expect(dependencies.exchange).not.toHaveBeenCalled();
    expect(dependencies.recordFailure).toHaveBeenCalledWith('sign-in-failed');
  });

  it('recovers when the Worker commit is reported but page Auth never adopts it', async () => {
    vi.useFakeTimers();
    const { dependencies, events, worker } = setup();
    dependencies.pageAuth.observeExact = vi.fn(() => new Promise<never>(() => {}));

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toEqual({ kind: 'recover' });
    expect(worker.commit).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(dependencies.rememberAttestation).not.toHaveBeenCalled();
    expect(dependencies.fence.withCurrentAttempt).toHaveBeenCalledOnce();
    expect(events.slice(-3)).toEqual(['worker-terminate', 'fence-cleared', 'lock-released']);
  });

  it('recovers instead of mounting when page Auth readiness hangs before commit', async () => {
    vi.useFakeTimers();
    const { dependencies, worker } = setup();
    dependencies.pageAuth.ready = vi.fn(() => new Promise<never>(() => {}));

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toEqual({ kind: 'recover' });
    expect(worker.commit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not let a superseded prepared attempt reach persistent Auth', async () => {
    const { dependencies, worker } = setup();
    dependencies.fence.withCurrentAttempt = vi.fn(async () => ({ kind: 'superseded' as const }));

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });

    expect(worker.commit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(dependencies.recordFailure).toHaveBeenCalledWith('sign-in-failed');
  });

  it('does not start the persistent commit when a fulfillment lands at the exact deadline', async () => {
    let elapsed = 0;
    const { dependencies, worker } = setup();
    dependencies.monotonicNow = () => elapsed;
    worker.prepare.mockImplementation(async () => {
      elapsed = 10;
      return { uid: 'user', refreshTokenDigest: 'digest' };
    });

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });
    expect(worker.commit).not.toHaveBeenCalled();
  });

  it('terminates the disposable Worker immediately on pagehide', async () => {
    vi.useFakeTimers();
    const { dependencies, pageHide, worker } = setup();
    dependencies.pageAuth.observeExact = vi.fn(() => new Promise<never>(() => {}));

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(0);
    pageHide();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    await expect(completion).resolves.toEqual({ kind: 'recover' });
  });

  it('does not install page observation after the monotonic deadline is exhausted', async () => {
    let elapsed = 0;
    const { dependencies } = setup();
    dependencies.monotonicNow = () => elapsed;
    dependencies.pageAuth.ready = vi.fn(async () => {
      elapsed = 10;
    });

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'recover' });
    expect(dependencies.pageAuth.observeExact).not.toHaveBeenCalled();
  });

  it('accepts exact page adoption even when Worker commit reports a persistence rejection', async () => {
    const { dependencies, worker } = setup();
    worker.commit.mockResolvedValue(false);

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.pageAuth.observeExact).toHaveBeenCalledOnce();
  });

  it('does not stage adult acknowledgement when this transaction did not collect it', async () => {
    const { dependencies } = setup();
    dependencies.readTransaction = () => ({
      ...transaction,
      acknowledgedAdultContent: false,
    });

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.rememberAttestation).not.toHaveBeenCalled();
  });

  it('keeps an exact sign-in successful when the convenience marker throws', async () => {
    const { dependencies } = setup();
    dependencies.rememberAttestation = vi.fn(() => {
      throw new Error('session storage unavailable');
    });

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.rememberAttestation).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'Worker initialization',
      (dependencies: HandoffReturnDependencies<unknown>, worker: ReturnType<typeof setup>['worker']) => {
        worker.initialize.mockImplementation(() => new Promise<never>(() => {}));
      },
    ],
    [
      'fence registration',
      (dependencies: HandoffReturnDependencies<unknown>) => {
        dependencies.fence.register = vi.fn(() => new Promise<never>(() => {}));
      },
    ],
    [
      'exchange',
      (dependencies: HandoffReturnDependencies<unknown>) => {
        dependencies.exchange = vi.fn(() => new Promise<never>(() => {}));
      },
    ],
    [
      'isolated preparation',
      (_dependencies: HandoffReturnDependencies<unknown>, worker: ReturnType<typeof setup>['worker']) => {
        worker.prepare.mockImplementation(() => new Promise<never>(() => {}));
      },
    ],
  ])('bounds a never-settling %s on the safe side', async (_label, arrange) => {
    vi.useFakeTimers();
    const { dependencies, worker } = setup();
    arrange(dependencies as HandoffReturnDependencies<unknown>, worker);

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.pageAuth.ready).not.toHaveBeenCalled();
    expect(worker.commit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(dependencies.forgetTransactionIf).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'Worker readiness',
      (dependencies: HandoffReturnDependencies<unknown>, worker: ReturnType<typeof setup>['worker']) => {
        worker.initialize.mockRejectedValue(new Error('worker unavailable'));
      },
      'sign-in-failed',
    ],
    [
      'fence registration',
      (dependencies: HandoffReturnDependencies<unknown>) => {
        dependencies.fence.register = vi.fn().mockRejectedValue(new Error('readback failed'));
      },
      'sign-in-failed',
    ],
    [
      'exchange',
      (dependencies: HandoffReturnDependencies<unknown>) => {
        dependencies.exchange = vi.fn().mockRejectedValue(new Error('permission-denied'));
      },
      'exchange-rejected',
    ],
    [
      'preparation',
      (_dependencies: HandoffReturnDependencies<unknown>, worker: ReturnType<typeof setup>['worker']) => {
        worker.prepare.mockRejectedValue(new Error('custom token rejected'));
      },
      'sign-in-failed',
    ],
  ])('keeps a %s rejection on the safe signed-out side', async (label, arrange, reason) => {
    const { dependencies, worker } = setup();
    arrange(dependencies as HandoffReturnDependencies<unknown>, worker);

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.pageAuth.ready).not.toHaveBeenCalled();
    expect(worker.commit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(dependencies.recordFailure).toHaveBeenCalledWith(reason);
    if (label === 'fence registration') {
      expect(dependencies.fence.withCurrentAttempt).toHaveBeenCalledOnce();
    }
  });

  it('continues safely when the final lock cannot be acquired before the deadline', async () => {
    vi.useFakeTimers();
    const { dependencies, worker } = setup();
    dependencies.fence.withCurrentAttempt = vi.fn(() => new Promise<never>(() => {}));

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toEqual({ kind: 'continue' });
    expect(dependencies.pageAuth.ready).not.toHaveBeenCalled();
    expect(worker.commit).not.toHaveBeenCalled();
  });

  it('recovers when commit settlement and exact page adoption both hang', async () => {
    vi.useFakeTimers();
    const { dependencies, worker } = setup();
    worker.commit.mockImplementation(() => new Promise<never>(() => {}));
    dependencies.pageAuth.observeExact = vi.fn(() => new Promise<never>(() => {}));

    const completion = completeHandoffReturnWithDependencies(
      { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 10 },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toEqual({ kind: 'recover' });
    expect(worker.commit).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('recovers without committing when exact observation cannot be installed', async () => {
    const { dependencies, worker } = setup();
    dependencies.pageAuth.observeExact = vi.fn(() => {
      throw new Error('observer unavailable');
    });

    await expect(
      completeHandoffReturnWithDependencies(
        { code: 'C'.repeat(43), origin: transaction.targetOrigin, timeoutMs: 100 },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'recover' });
    expect(worker.commit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
