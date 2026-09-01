import { describe, expect, it, vi } from 'vitest';
import { createHandoffCommitClient, type HandoffWorkerLike } from './handoffCommitClient';

const attempt = { transactionId: 'transaction', ownerNonce: 'owner' };

function fakeWorker() {
  const listeners = new Map<string, Set<EventListener>>();
  const posted: unknown[] = [];
  const worker: HandoffWorkerLike = {
    postMessage: (message) => posted.push(message),
    terminate: vi.fn(),
    addEventListener: (type, listener) => {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener as EventListener);
      listeners.set(type, current);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener as EventListener),
  };
  const emit = (message: unknown, type = 'message') => {
    const event = type === 'message' ? new MessageEvent(type, { data: message }) : new Event(type);
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { emit, posted, worker };
}

describe('page-side handoff Worker client', () => {
  it('correlates each phase to the exact attempt', async () => {
    const { emit, posted, worker } = fakeWorker();
    const client = createHandoffCommitClient({
      worker,
      attempt,
      firebaseOptions: { apiKey: 'api-key' },
      tenantId: null,
      emulatorUrl: null,
    });
    const signal = new AbortController().signal;

    const initialized = client.initialize(signal);
    emit({ type: 'ready', attempt });
    await initialized;

    const prepared = client.prepare('custom-token', signal);
    emit({
      type: 'prepared',
      attempt,
      candidate: { uid: 'user', refreshTokenDigest: 'digest' },
    });
    await expect(prepared).resolves.toEqual({ uid: 'user', refreshTokenDigest: 'digest' });

    const committed = client.commit(signal);
    expect(posted.map((message) => (message as { type: string }).type)).toEqual([
      'initialize',
      'prepare',
      'commit',
    ]);
    emit({ type: 'commit-settled', attempt, succeeded: false });
    await expect(committed).resolves.toBe(false);
  });

  it('rejects malformed Worker output and ignores messages after termination', async () => {
    const { emit, worker } = fakeWorker();
    const client = createHandoffCommitClient({
      worker,
      attempt,
      firebaseOptions: { apiKey: 'api-key' },
      tenantId: null,
      emulatorUrl: null,
    });
    const pending = client.initialize(new AbortController().signal);
    emit({ type: 'ready', attempt: { ...attempt, ownerNonce: 'other' } });
    await expect(pending).rejects.toThrow('handoff-worker-protocol');

    client.terminate();
    emit({ type: 'ready', attempt });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['malformed-message', 'error', 'messageerror'])(
    'fails a pending commit on %s without accepting a late settlement',
    async (failure) => {
      const { emit, worker } = fakeWorker();
      const client = createHandoffCommitClient({
        worker,
        attempt,
        firebaseOptions: { apiKey: 'api-key' },
        tenantId: null,
        emulatorUrl: null,
      });
      const signal = new AbortController().signal;
      const initialized = client.initialize(signal);
      emit({ type: 'ready', attempt });
      await initialized;
      const prepared = client.prepare('custom-token', signal);
      emit({
        type: 'prepared',
        attempt,
        candidate: { uid: 'user', refreshTokenDigest: 'digest' },
      });
      await prepared;

      const committed = client.commit(signal);
      if (failure === 'malformed-message') emit({ type: 'commit-settled', attempt });
      else emit(null, failure);
      await expect(committed).rejects.toThrow(/handoff-worker-(protocol|failed)/);

      emit({ type: 'commit-settled', attempt, succeeded: true });
      client.terminate();
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
});
