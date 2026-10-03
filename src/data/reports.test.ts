import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  uid: 'alice' as string | undefined,
  rows: new Map<string, Record<string, unknown>>(),
  writes: [] as Array<{ path: string; data: Record<string, unknown> }>,
  targetError: undefined as unknown,
  commitError: undefined as unknown,
  reads: [] as string[],
  transactionCalls: 0,
  readGate: undefined as { path: string; ready: Promise<void> } | undefined,
  attemptGate: undefined as Promise<void> | undefined,
  retryUid: undefined as string | undefined,
  completionUid: undefined as string | undefined,
  receiptError: undefined as unknown,
  resumedReceiptError: undefined as unknown,
}));
vi.mock('../firebase', () => ({ auth: { get currentUser() { return state.uid ? { uid: state.uid } : null; } }, db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  serverTimestamp: () => 'server-timestamp',
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    state.transactionCalls += 1;
    if (state.attemptGate) await state.attemptGate;
    const tx = {
    get: async (ref: { path: string }) => {
      state.reads.push(ref.path);
      if (state.readGate?.path === ref.path) await state.readGate.ready;
      if (ref.path.endsWith('/reports/alice') && state.receiptError) throw state.receiptError;
      if (ref.path === 'events/event/items/target' && state.targetError) throw state.targetError;
      return { exists: () => state.rows.has(ref.path), data: () => state.rows.get(ref.path) };
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => state.writes.push({ path: ref.path, data }),
    update: (ref: { path: string }, data: Record<string, unknown>) => state.writes.push({ path: ref.path, data }),
    };
    try {
      await fn(tx);
    } catch (error) {
      if (!state.resumedReceiptError) throw error;
      // Inject callback re-entry to prove the witness is attempt-local. This
      // seam does not claim the native SDK retries a permission-denied error.
      state.receiptError = state.resumedReceiptError;
      await fn(tx);
    }
    if (state.retryUid) { state.uid = state.retryUid; await fn(tx); }
    if (state.completionUid) state.uid = state.completionUid;
    if (state.commitError) throw state.commitError;
  },
}));
import { reportContent, REPORT_RATE_LIMIT_MS } from './reports';

beforeEach(() => {
  state.uid = 'alice'; state.rows.clear(); state.writes.length = 0; state.targetError = undefined; state.commitError = undefined;
  state.reads.length = 0; state.transactionCalls = 0; state.readGate = undefined; state.attemptGate = undefined; state.retryUid = undefined; state.completionUid = undefined; state.receiptError = undefined; state.resumedReceiptError = undefined;
  state.rows.set('events/event/items/target', { createdAt: 100, reportCount: 3 });
});
describe('rules-paired report submission', () => {
  it('binds receipt, rate and counter to the initiating Event and live incarnation', async () => {
    await reportContent('items', 'target', 'event', undefined, 'alice');
    expect(state.writes).toEqual([
      { path: 'events/event/items/target/reports/alice', data: { uid: 'alice', targetCreatedAt: 100, submittedAt: 'server-timestamp' } },
      { path: 'events/event/reportRateLimits/alice', data: { kind: 'items', targetId: 'target', submittedAt: 'server-timestamp' } },
      { path: 'events/event/items/target', data: { reportCount: 4 } },
    ]);
    expect(REPORT_RATE_LIMIT_MS).toBe(3_000);
  });
  it('acknowledges repeated submission without spending quota or incrementing twice', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    await reportContent('items', 'target', 'event', undefined, 'alice');
    expect(state.writes).toEqual([]);
  });
  it('acknowledges an accepted retry after auto-hide removes target read access', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.targetError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event', 100, 'alice')).resolves.toBeUndefined();
    expect(state.writes).toEqual([]);
  });
  it('refuses stale or unbound receipts after a recreated target becomes unreadable', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 99 });
    state.targetError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event', 100, 'alice')).rejects.toEqual(state.targetError);
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toEqual(state.targetError);
    expect(state.writes).toEqual([]);
  });
  it('does not report content recreated after the displayed incarnation', async () => {
    await expect(reportContent('items', 'target', 'event', 99, 'alice')).rejects.toThrow('has changed');
    expect(state.writes).toEqual([]);
  });
  it('permits a new report for a recreated target, not its old receipt', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 99 });
    await reportContent('items', 'target', 'event', undefined, 'alice');
    expect(state.writes[0].data.targetCreatedAt).toBe(100);
  });
  it('propagates first-submission denials and service failures even with an old receipt', async () => {
    state.targetError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toEqual(state.targetError);
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.targetError = { code: 'unavailable' };
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toEqual(state.targetError);
  });
  it('does not acknowledge a new-incarnation report denied at commit', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 99 });
    state.commitError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toEqual(state.commitError);
  });
  it('requires sign-in and refuses a deleted or malformed target', async () => {
    state.uid = undefined;
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toThrow('Sign in');
    state.uid = 'alice'; state.rows.clear();
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toThrow('no longer');
    state.rows.set('events/event/items/target', { createdAt: 'bad', reportCount: 0 });
    await expect(reportContent('items', 'target', 'event', undefined, 'alice')).rejects.toThrow('cannot be reported');
  });
});

function deferred() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

describe('report intent belongs to the account displayed by the control', () => {
  it('refuses a stale rendered account after deferred authentication changes before invocation', async () => {
    const control = deferred();
    const request = (async () => {
      await control.ready;
      await reportContent('items', 'target', 'event', 100, 'alice');
    })();
    const rejected = expect(request).rejects.toThrow('Sign in');
    state.uid = 'bob';
    control.release();
    await rejected;
    expect(state.transactionCalls).toBe(0);
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it('rechecks captured account at a delayed native transaction attempt', async () => {
    const attempt = deferred();
    state.attemptGate = attempt.ready;
    const request = reportContent('items', 'target', 'event', 100, 'alice');
    const rejected = expect(request).rejects.toThrow('Sign in');
    state.uid = 'bob';
    attempt.release();
    await rejected;
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it('does not proceed from an old receipt read to target reads or writes after an account switch', async () => {
    const receipt = deferred();
    state.readGate = { path: 'events/event/items/target/reports/alice', ready: receipt.ready };
    const request = reportContent('items', 'target', 'event', 100, 'alice');
    const rejected = expect(request).rejects.toThrow('Sign in');
    state.uid = 'bob';
    receipt.release();
    await rejected;
    expect(state.reads).toEqual(['events/event/items/target/reports/alice']);
    expect(state.writes).toEqual([]);
  });

  it.each(['readable duplicate', 'hidden duplicate'])('refuses an old-account %s acknowledgment after a deferred target read', async mode => {
    const target = deferred();
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    if (mode === 'hidden duplicate') state.targetError = { code: 'permission-denied' };
    state.readGate = { path: 'events/event/items/target', ready: target.ready };
    const request = reportContent('items', 'target', 'event', 100, 'alice');
    const rejected = expect(request).rejects.toThrow('Sign in');
    // Let the transaction reach the target read while Alice is still current.
    await Promise.resolve();
    state.uid = 'bob';
    target.release();
    await rejected;
    expect(state.reads).toContain('events/event/items/target');
    expect(state.writes).toEqual([]);
  });

  it('rejects a new native retry under another account before reading its receipt', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.retryUid = 'bob';
    await expect(reportContent('items', 'target', 'event', 100, 'alice')).rejects.toThrow('Sign in');
    expect(state.reads).toEqual(['events/event/items/target/reports/alice', 'events/event/items/target']);
    expect(state.writes).toEqual([]);
  });

  it('clears a prior hidden-target witness before an injected resumed callback fails its receipt read', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.targetError = { code: 'permission-denied' };
    state.resumedReceiptError = { code: 'permission-denied', message: 'receipt admission revoked' };
    await expect(reportContent('items', 'target', 'event', 100, 'alice')).rejects.toEqual(state.resumedReceiptError);
    expect(state.writes).toEqual([]);
  });

  it('does not acknowledge completion to another account, without claiming an earlier commit was canceled', async () => {
    state.completionUid = 'bob';
    await expect(reportContent('items', 'target', 'event', 100, 'alice')).rejects.toThrow('Sign in');
    // The callback already submitted Alice-bound writes; current-account failure
    // controls acknowledgment, not rollback of previously authorized server work.
    expect(state.writes[0].path).toBe('events/event/items/target/reports/alice');
    expect(state.writes[0].data.uid).toBe('alice');
    expect(state.writes).toHaveLength(3);
  });
});
