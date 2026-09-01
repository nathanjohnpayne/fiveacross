import type { FirebaseOptions } from 'firebase/app';
import {
  sameHandoffAttempt,
  type HandoffPageMessage,
  type HandoffSessionCandidate,
  type HandoffWorkerMessage,
} from './handoffCommitProtocol';
import type { HandoffAttemptIdentity } from './handoffAttemptFence';

export interface HandoffCommitWorkerAdapter {
  initialize(input: {
    attempt: HandoffAttemptIdentity;
    firebaseOptions: FirebaseOptions;
    tenantId: string | null;
    emulatorUrl: string | null;
  }): Promise<void>;
  prepare(input: {
    attempt: HandoffAttemptIdentity;
    customToken: string;
  }): Promise<HandoffSessionCandidate>;
  commit(): Promise<void>;
}

export function createHandoffCommitWorkerController(input: {
  adapter: HandoffCommitWorkerAdapter;
  post: (message: HandoffWorkerMessage) => void;
}) {
  let phase:
    | 'new'
    | 'initializing'
    | 'ready'
    | 'preparing'
    | 'prepared'
    | 'committing'
    | 'settled'
    | 'failed' = 'new';
  let attempt: HandoffAttemptIdentity | null = null;

  const failProtocol = () => {
    if (attempt === null || phase === 'failed') return;
    phase = 'failed';
    input.post({ type: 'failed', attempt, phase: 'protocol' });
  };

  return {
    async receive(message: HandoffPageMessage): Promise<void> {
      if (message.type === 'initialize') {
        if (phase !== 'new') return failProtocol();
        attempt = message.attempt;
        phase = 'initializing';
        try {
          await input.adapter.initialize(message);
          if (phase !== 'initializing') return;
          phase = 'ready';
          input.post({ type: 'ready', attempt });
        } catch {
          if (phase !== 'initializing') return;
          phase = 'failed';
          input.post({ type: 'failed', attempt, phase: 'initialize' });
        }
        return;
      }

      if (attempt === null || !sameHandoffAttempt(message.attempt, attempt)) {
        return failProtocol();
      }

      if (message.type === 'prepare') {
        if (phase !== 'ready') return failProtocol();
        phase = 'preparing';
        try {
          const candidate = await input.adapter.prepare(message);
          if (phase !== 'preparing') return;
          phase = 'prepared';
          input.post({ type: 'prepared', attempt, candidate });
        } catch {
          if (phase !== 'preparing') return;
          phase = 'failed';
          input.post({ type: 'failed', attempt, phase: 'prepare' });
        }
        return;
      }

      if (phase !== 'prepared') return failProtocol();
      phase = 'committing';
      try {
        await input.adapter.commit();
        if (phase !== 'committing') return;
        phase = 'settled';
        input.post({ type: 'commit-settled', attempt, succeeded: true });
      } catch {
        if (phase !== 'committing') return;
        phase = 'settled';
        input.post({ type: 'commit-settled', attempt, succeeded: false });
      }
    },
  };
}
