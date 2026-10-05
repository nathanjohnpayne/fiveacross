import { describe, expect, it, vi } from 'vitest';
import { completeLegacyCacheRecovery, type LegacyRecoveryOperations } from './privateCacheRecovery';

function fixture() {
  let uid: string | null = 'alice';
  let online = true;
  const order: string[] = [];
  const operations: LegacyRecoveryOperations = {
    currentUid: () => uid, online: () => online,
    proveServerAccess: vi.fn(async () => { order.push('server'); }),
    drainActiveUser: vi.fn(async () => { order.push('drain'); }),
    terminate: vi.fn(async () => { order.push('terminate'); }),
    clear: vi.fn(async () => { order.push('clear'); }),
    recordCompletion: vi.fn(() => { order.push('record'); }),
  };
  return { operations, order, setUid: (value: string | null) => { uid = value; }, setOnline: (value: boolean) => { online = value; } };
}
const attended = { allAccountsRecovered: true, otherTabsClosed: true };
describe('attended legacy private-cache recovery (#1411)', () => {
  it.each([[false, true], [true, false], [false, false]])('never clears without both confirmations (%s,%s)', async (accounts, tabs) => {
    const f = fixture();
    await expect(completeLegacyCacheRecovery({ allAccountsRecovered: accounts, otherTabsClosed: tabs }, f.operations)).rejects.toThrow();
    expect(f.order).toEqual([]);
  });
  it.each(['signed-out', 'offline'])('refuses %s before touching the cache', async condition => {
    const f = fixture();
    if (condition === 'signed-out') f.setUid(null); else f.setOnline(false);
    await expect(completeLegacyCacheRecovery(attended, f.operations)).rejects.toThrow();
    expect(f.order).toEqual([]);
  });
  it('proves server access and drains before supported termination/clear, then records completion', async () => {
    const f = fixture();
    await completeLegacyCacheRecovery(attended, f.operations);
    expect(f.order).toEqual(['server', 'drain', 'terminate', 'clear', 'record']);
  });
  it.each(['proveServerAccess', 'drainActiveUser', 'terminate', 'clear'] as const)('fails closed when %s fails', async stage => {
    const f = fixture();
    vi.mocked(f.operations[stage]).mockRejectedValueOnce(new Error('failure'));
    await expect(completeLegacyCacheRecovery(attended, f.operations)).rejects.toThrow();
    expect(f.operations.recordCompletion).not.toHaveBeenCalled();
    if (stage !== 'clear') expect(f.operations.clear).not.toHaveBeenCalled();
  });
  it.each(['proveServerAccess', 'drainActiveUser', 'terminate', 'clear'] as const)('never unlocks after an account change during %s', async stage => {
    const f = fixture();
    vi.mocked(f.operations[stage]).mockImplementationOnce(async () => { f.setUid('bob'); });
    await expect(completeLegacyCacheRecovery(attended, f.operations)).rejects.toThrow();
    expect(f.operations.recordCompletion).not.toHaveBeenCalled();
    if (stage !== 'clear') expect(f.operations.clear).not.toHaveBeenCalled();
  });
  it('bounds a stalled drain and never clears when that late drain eventually settles', async () => {
    const f = fixture();
    let finish = () => {};
    vi.mocked(f.operations.drainActiveUser).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await expect(completeLegacyCacheRecovery(attended, f.operations, 5)).rejects.toThrow('timed out');
    finish(); await Promise.resolve();
    expect(f.operations.clear).not.toHaveBeenCalled();
    expect(f.operations.recordCompletion).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('does not release a timed-out clear until actual %s settlement', async outcome => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let resolveClear = () => {};
      let rejectClear = (_error: Error) => {};
      vi.mocked(f.operations.clear).mockReturnValue(new Promise<void>((resolve, reject) => {
        resolveClear = resolve; rejectClear = reject;
      }));
      let settled = false;
      const recovery = completeLegacyCacheRecovery(attended, f.operations, 5)
        .then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'refused'; });
      await vi.advanceTimersByTimeAsync(6);
      expect(f.operations.clear).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(f.operations.recordCompletion).not.toHaveBeenCalled();
      if (outcome === 'resolve') resolveClear(); else rejectClear(new Error('late refusal'));
      await expect(recovery).resolves.toBe('refused');
      expect(f.operations.recordCompletion).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('does not report completion when its durable marker cannot be stored', async () => {
    const f = fixture();
    vi.mocked(f.operations.recordCompletion).mockImplementationOnce(() => { throw new Error('storage denied'); });
    await expect(completeLegacyCacheRecovery(attended, f.operations)).rejects.toThrow('storage denied');
    expect(f.operations.clear).toHaveBeenCalledOnce();
  });
});
