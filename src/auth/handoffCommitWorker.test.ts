// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHandoffCommitWorkerController } from './handoffCommitWorker';
import type { HandoffWorkerMessage } from './handoffCommitProtocol';

const attempt = { transactionId: 'transaction', ownerNonce: 'owner' };

function setup() {
  const adapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue({ uid: 'user', refreshTokenDigest: 'digest' }),
    commit: vi.fn().mockResolvedValue(undefined),
  };
  const messages: HandoffWorkerMessage[] = [];
  const controller = createHandoffCommitWorkerController({
    adapter,
    post: (message) => messages.push(message),
  });
  return { adapter, messages, controller };
}

describe('handoff commit Worker controller', () => {
  it('prepares in isolation before allowing the persistent commit', async () => {
    const { adapter, messages, controller } = setup();

    await controller.receive({
      type: 'initialize',
      attempt,
      firebaseOptions: { apiKey: 'key', projectId: 'project' },
      tenantId: null,
      emulatorUrl: null,
    });
    await controller.receive({ type: 'prepare', attempt, customToken: 'custom-token' });

    expect(adapter.commit).not.toHaveBeenCalled();
    expect(messages).toEqual([
      { type: 'ready', attempt },
      {
        type: 'prepared',
        attempt,
        candidate: { uid: 'user', refreshTokenDigest: 'digest' },
      },
    ]);

    await controller.receive({ type: 'commit', attempt });
    expect(adapter.commit).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toEqual({ type: 'commit-settled', attempt, succeeded: true });
  });

  it('reports a mutate-then-reject commit without exposing the error', async () => {
    const { adapter, messages, controller } = setup();
    adapter.commit.mockRejectedValue(new Error('secret persistence detail'));

    await controller.receive({
      type: 'initialize',
      attempt,
      firebaseOptions: { apiKey: 'key' },
      tenantId: null,
      emulatorUrl: null,
    });
    await controller.receive({ type: 'prepare', attempt, customToken: 'custom-token' });
    await controller.receive({ type: 'commit', attempt });

    expect(messages.at(-1)).toEqual({ type: 'commit-settled', attempt, succeeded: false });
    expect(JSON.stringify(messages)).not.toContain('secret persistence detail');
  });

  it('fails closed on a message from another owner and never commits', async () => {
    const { adapter, messages, controller } = setup();
    await controller.receive({
      type: 'initialize',
      attempt,
      firebaseOptions: { apiKey: 'key' },
      tenantId: null,
      emulatorUrl: null,
    });
    await controller.receive({
      type: 'prepare',
      attempt: { ...attempt, ownerNonce: 'other-owner' },
      customToken: 'custom-token',
    });

    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({ type: 'failed', attempt, phase: 'protocol' });
  });

  it('does not run duplicate initialization while the first request is pending', async () => {
    const { adapter, messages, controller } = setup();
    let finishInitialize = () => {};
    adapter.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInitialize = resolve;
        }),
    );
    const initialize = {
      type: 'initialize' as const,
      attempt,
      firebaseOptions: { apiKey: 'key' },
      tenantId: null,
      emulatorUrl: null,
    };

    const first = controller.receive(initialize);
    await Promise.resolve();
    await controller.receive(initialize);
    finishInitialize();
    await first;

    expect(adapter.initialize).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ type: 'failed', attempt, phase: 'protocol' }]);
  });

  it('does not publish a stale commit settlement after a protocol failure', async () => {
    const { adapter, messages, controller } = setup();
    let finishCommit = () => {};
    adapter.commit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    await controller.receive({
      type: 'initialize',
      attempt,
      firebaseOptions: { apiKey: 'key' },
      tenantId: null,
      emulatorUrl: null,
    });
    await controller.receive({ type: 'prepare', attempt, customToken: 'custom-token' });

    const commit = controller.receive({ type: 'commit', attempt });
    await Promise.resolve();
    await controller.receive({ type: 'commit', attempt });
    finishCommit();
    await commit;

    expect(adapter.commit).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toEqual({ type: 'failed', attempt, phase: 'protocol' });
    expect(messages.filter((message) => message.type === 'commit-settled')).toHaveLength(0);
  });
});
