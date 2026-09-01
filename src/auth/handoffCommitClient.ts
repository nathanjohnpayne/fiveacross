import type { FirebaseOptions } from 'firebase/app';
import type { HandoffAttemptIdentity } from './handoffAttemptFence';
import {
  parseHandoffWorkerMessage,
  sameHandoffAttempt,
  type HandoffPageMessage,
  type HandoffSessionCandidate,
  type HandoffWorkerMessage,
} from './handoffCommitProtocol';

export interface HandoffWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export function createHandoffCommitClient(input: {
  worker: HandoffWorkerLike;
  attempt: HandoffAttemptIdentity;
  firebaseOptions: FirebaseOptions;
  tenantId: string | null;
  emulatorUrl: string | null;
}) {
  let terminated = false;
  const pendingFailures = new Set<(error: Error) => void>();

  const waitFor = <Type extends HandoffWorkerMessage['type']>(
    expectedType: Type,
    signal: AbortSignal,
  ): Promise<Extract<HandoffWorkerMessage, { type: Type }>> =>
    new Promise((resolve, reject) => {
      if (terminated) {
        reject(new Error('handoff-worker-terminated'));
        return;
      }

      let settled = false;
      const cleanup = () => {
        input.worker.removeEventListener('message', onMessage);
        input.worker.removeEventListener('error', onError);
        input.worker.removeEventListener('messageerror', onError);
        signal.removeEventListener('abort', onAbort);
        pendingFailures.delete(fail);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new Error('handoff-timeout'));
      const onError: EventListener = () => fail(new Error('handoff-worker-failed'));
      const onMessage: EventListener = (event) => {
        if (terminated) return;
        const message = parseHandoffWorkerMessage((event as MessageEvent<unknown>).data);
        if (message === null || !sameHandoffAttempt(message.attempt, input.attempt)) {
          fail(new Error('handoff-worker-protocol'));
          return;
        }
        if (message.type === 'failed') {
          fail(new Error(`handoff-worker-${message.phase}`));
          return;
        }
        if (message.type !== expectedType) {
          fail(new Error('handoff-worker-protocol'));
          return;
        }
        settled = true;
        cleanup();
        resolve(message as Extract<HandoffWorkerMessage, { type: Type }>);
      };

      pendingFailures.add(fail);
      input.worker.addEventListener('message', onMessage);
      input.worker.addEventListener('error', onError);
      input.worker.addEventListener('messageerror', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });

  const post = (message: HandoffPageMessage) => {
    if (terminated) throw new Error('handoff-worker-terminated');
    input.worker.postMessage(message);
  };

  return {
    async initialize(signal: AbortSignal): Promise<void> {
      const ready = waitFor('ready', signal);
      try {
        post({
          type: 'initialize',
          attempt: input.attempt,
          firebaseOptions: input.firebaseOptions,
          tenantId: input.tenantId,
          emulatorUrl: input.emulatorUrl,
        });
      } catch {
        this.terminate();
      }
      await ready;
    },

    async prepare(customToken: string, signal: AbortSignal): Promise<HandoffSessionCandidate> {
      const prepared = waitFor('prepared', signal);
      try {
        post({ type: 'prepare', attempt: input.attempt, customToken });
      } catch {
        this.terminate();
      }
      return (await prepared).candidate;
    },

    async commit(signal: AbortSignal): Promise<boolean> {
      const settled = waitFor('commit-settled', signal);
      try {
        post({ type: 'commit', attempt: input.attempt });
      } catch {
        this.terminate();
      }
      return (await settled).succeeded;
    },

    terminate(): void {
      if (terminated) return;
      terminated = true;
      const error = new Error('handoff-worker-terminated');
      for (const fail of [...pendingFailures]) fail(error);
      input.worker.terminate();
    },
  };
}
