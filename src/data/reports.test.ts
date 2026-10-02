import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  uid: 'alice' as string | undefined,
  rows: new Map<string, Record<string, unknown>>(),
  writes: [] as Array<{ path: string; data: Record<string, unknown> }>,
  targetError: undefined as unknown,
  commitError: undefined as unknown,
}));
vi.mock('../firebase', () => ({ auth: { get currentUser() { return state.uid ? { uid: state.uid } : null; } }, db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  serverTimestamp: () => 'server-timestamp',
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    await fn({
    get: async (ref: { path: string }) => {
      if (ref.path === 'events/event/items/target' && state.targetError) throw state.targetError;
      return { exists: () => state.rows.has(ref.path), data: () => state.rows.get(ref.path) };
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => state.writes.push({ path: ref.path, data }),
    update: (ref: { path: string }, data: Record<string, unknown>) => state.writes.push({ path: ref.path, data }),
    });
    if (state.commitError) throw state.commitError;
  },
}));
import { reportContent, REPORT_RATE_LIMIT_MS } from './reports';

beforeEach(() => {
  state.uid = 'alice'; state.rows.clear(); state.writes.length = 0; state.targetError = undefined; state.commitError = undefined;
  state.rows.set('events/event/items/target', { createdAt: 100, reportCount: 3 });
});
describe('rules-paired report submission', () => {
  it('binds receipt, rate and counter to the initiating Event and live incarnation', async () => {
    await reportContent('items', 'target', 'event');
    expect(state.writes).toEqual([
      { path: 'events/event/items/target/reports/alice', data: { uid: 'alice', targetCreatedAt: 100, submittedAt: 'server-timestamp' } },
      { path: 'events/event/reportRateLimits/alice', data: { kind: 'items', targetId: 'target', submittedAt: 'server-timestamp' } },
      { path: 'events/event/items/target', data: { reportCount: 4 } },
    ]);
    expect(REPORT_RATE_LIMIT_MS).toBe(3_000);
  });
  it('acknowledges repeated submission without spending quota or incrementing twice', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    await reportContent('items', 'target', 'event');
    expect(state.writes).toEqual([]);
  });
  it('acknowledges an accepted retry after auto-hide removes target read access', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.targetError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event')).resolves.toBeUndefined();
    expect(state.writes).toEqual([]);
  });
  it('permits a new report for a recreated target, not its old receipt', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 99 });
    await reportContent('items', 'target', 'event');
    expect(state.writes[0].data.targetCreatedAt).toBe(100);
  });
  it('propagates first-submission denials and service failures even with an old receipt', async () => {
    state.targetError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event')).rejects.toEqual(state.targetError);
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 100 });
    state.targetError = { code: 'unavailable' };
    await expect(reportContent('items', 'target', 'event')).rejects.toEqual(state.targetError);
  });
  it('does not acknowledge a new-incarnation report denied at commit', async () => {
    state.rows.set('events/event/items/target/reports/alice', { targetCreatedAt: 99 });
    state.commitError = { code: 'permission-denied' };
    await expect(reportContent('items', 'target', 'event')).rejects.toEqual(state.commitError);
  });
  it('requires sign-in and refuses a deleted or malformed target', async () => {
    state.uid = undefined;
    await expect(reportContent('items', 'target', 'event')).rejects.toThrow('Sign in');
    state.uid = 'alice'; state.rows.clear();
    await expect(reportContent('items', 'target', 'event')).rejects.toThrow('no longer');
    state.rows.set('events/event/items/target', { createdAt: 'bad', reportCount: 0 });
    await expect(reportContent('items', 'target', 'event')).rejects.toThrow('cannot be reported');
  });
});
