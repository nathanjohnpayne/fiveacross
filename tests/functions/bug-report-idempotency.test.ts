import { describe, expect, it, vi } from 'vitest';
import {
  deriveBugReportId,
  deriveBugReportRequestHash,
  handleSubmitBugReport,
  submitValidatedBugReport,
  verifyBugReportRequestHash,
  type BugReportIntakeDependencies,
} from '../../functions/src/bugReports';
import { validateBugReportInput } from '../../functions/src/bugReportCore';

const base = () => validateBugReportInput({
  schemaVersion: 1,
  submissionId: 'submission_ABC-123',
  kind: 'abuse',
  description: 'Unicode 🛳️\n"quoted"\u0000',
  screenshotDataUrl: null,
  captureError: null,
  route: '/feed|x',
  eventId: 'med-2026',
  appVersion: 'abc123',
  browser: 'Browser/1',
  viewport: { width: 390, height: 844 },
  online: true,
});

describe('idempotent bug-report identities', () => {
  it('pins the domain-separated report id vector', () => {
    expect(deriveBugReportId('user-123', 'submission_ABC-123')).toBe(
      '9420c2c8ea097b5021d35c3b906af0695d6938598705de4eb4452a1bfeebc1e9',
    );
  });

  it('pins request-hash v1 framing, Unicode, delimiters, NULs, and null screenshot state', () => {
    expect(deriveBugReportRequestHash(base())).toEqual({
      version: 1,
      value: '63ed833eb6b0870ebb756860deb847f64ba67b055855bca78838e98ebcb7c04b',
    });
  });

  it('changes when screenshot evidence or any frozen semantic field changes', () => {
    const withoutScreenshot = base();
    const withScreenshot = { ...withoutScreenshot, screenshot: Buffer.from('same visible fields') };
    expect(deriveBugReportRequestHash(withScreenshot)).toEqual({
      version: 1,
      value: '3b2708596d6ebf44d356e215d6a98d307fadd507d36d28c601a744fa490369b5',
    });
    const original = deriveBugReportRequestHash(withoutScreenshot).value;
    const changed = [
      { ...withoutScreenshot, kind: 'bug' as const },
      { ...withoutScreenshot, description: 'different' },
      { ...withoutScreenshot, captureError: 'capture failed' },
      { ...withoutScreenshot, route: '/different' },
      { ...withoutScreenshot, eventId: 'other-event' },
      { ...withoutScreenshot, appVersion: 'newer' },
      { ...withoutScreenshot, browser: 'Other browser' },
      { ...withoutScreenshot, viewport: { ...withoutScreenshot.viewport, width: 391 } },
      { ...withoutScreenshot, viewport: { ...withoutScreenshot.viewport, height: 845 } },
      { ...withoutScreenshot, online: false },
      withScreenshot,
    ];
    for (const report of changed) expect(deriveBugReportRequestHash(report).value).not.toBe(original);
  });

  it('retains the version-1 verifier and fails closed on an unknown stored version', () => {
    const hash = deriveBugReportRequestHash(base());
    expect(verifyBugReportRequestHash(base(), 1, hash.value)).toBe(true);
    expect(verifyBugReportRequestHash(base(), 2, hash.value)).toBe(false);
  });
});

class MemoryIntake {
  readonly docs = new Map<string, Record<string, unknown>>();
  readonly objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  readonly saves: string[] = [];
  private autoId = 0;
  private transactionTail = Promise.resolve();

  private snapshot(path: string) {
    const value = this.docs.get(path);
    return { exists: value !== undefined, data: () => value };
  }

  private ref(path: string) {
    return {
      id: path.split('/').at(-1)!,
      get: async () => this.snapshot(path),
      create: async (data: Record<string, unknown>) => {
        if (this.docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
        this.docs.set(path, data);
      },
      delete: async () => { this.docs.delete(path); },
      path,
    };
  }

  readonly db = {
    doc: (path: string) => this.ref(path),
    collection: (path: string) => ({
      doc: (id?: string) => this.ref(`${path}/${id ?? `auto-${++this.autoId}`}`),
    }),
    runTransaction: async <T,>(work: (transaction: {
      get: (ref: { path: string }) => Promise<ReturnType<MemoryIntake['snapshot']>>;
      create: (ref: { path: string }, data: Record<string, unknown>) => void;
      set: (ref: { path: string }, data: Record<string, unknown>) => void;
      update: (ref: { path: string }, data: Record<string, unknown>) => void;
    }) => Promise<T>): Promise<T> => {
      const prior = this.transactionTail;
      let release!: () => void;
      this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      const writes = new Map<string, Record<string, unknown>>();
      try {
        const result = await work({
          get: async (ref) => this.snapshot(ref.path),
          create: (ref, data) => {
            if (this.docs.has(ref.path) || writes.has(ref.path)) {
              throw Object.assign(new Error('already exists'), { code: 6 });
            }
            writes.set(ref.path, data);
          },
          set: (ref, data) => { writes.set(ref.path, data); },
          update: (ref, data) => {
            const current = writes.get(ref.path) ?? this.docs.get(ref.path);
            if (!current) throw new Error(`missing ${ref.path}`);
            writes.set(ref.path, { ...current, ...data });
          },
        });
        for (const [path, value] of writes) this.docs.set(path, value);
        return result;
      } finally {
        release();
      }
    },
  };

  file(path: string) {
    return {
      save: async (bytes: Buffer, options: { metadata?: { metadata?: Record<string, string> } }) => {
        if (this.objects.has(path)) throw Object.assign(new Error('conditionNotMet'), { code: 412 });
        this.saves.push(path);
        this.objects.set(path, { bytes, metadata: options.metadata?.metadata ?? {} });
      },
      getMetadata: async () => {
        const object = this.objects.get(path);
        if (!object) throw Object.assign(new Error('not found'), { code: 404 });
        return [{ metadata: object.metadata }];
      },
      delete: async () => { this.objects.delete(path); },
    };
  }
}

function dependencies(memory: MemoryIntake, overrides: Partial<BugReportIntakeDependencies> = {}) {
  let uuid = 0;
  return {
    db: memory.db,
    file: (path: string) => memory.file(path),
    nowMs: () => 1_000,
    randomUUID: () => `lease-${++uuid}`,
    timestamp: (ms: number) => ms,
    serverTimestamp: () => 1_000,
    sleep: async () => undefined,
    resolveEscalation: vi.fn(async () => ({ member: true, eventActive: true })),
    ...overrides,
  } as unknown as BugReportIntakeDependencies;
}

describe('idempotent bug-report intake orchestration', () => {
  it('atomically finalizes an UNKNOWN abuse lookup with one bound escalation task', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory, {
      resolveEscalation: vi.fn(async () => ({ member: null, eventActive: null })),
    });
    const report = base();
    const reportId = deriveBugReportId('user-123', report.submissionId!);

    await expect(submitValidatedBugReport('user-123', report, deps)).resolves.toEqual({
      reportId,
      escalationEligible: false,
    });

    const stored = memory.docs.get(`bugReports/${reportId}`);
    expect(stored).toMatchObject({
      intakeState: 'complete',
      escalationLookupFailed: true,
      reporterHash: 'fcdec6df4d44dbc637c7',
    });
    expect(stored).not.toHaveProperty('reporterUid');
    expect(memory.docs.get(`bugReportEscalations/${reportId}`)).toEqual({
      state: 'pending',
      eventId: 'med-2026',
      reporterUid: 'user-123',
      reporterHash: 'fcdec6df4d44dbc637c7',
      createdAt: 1_000,
      nextAttemptAt: 1_000,
      attemptCount: 0,
      deadlineAt: 604_801_000,
      expiresAt: 691_201_000,
    });

    memory.docs.set(`bugReportEscalations/${reportId}`, {
      state: 'terminal', outcome: 'queued', resolvedAt: 2_000, expiresAt: 3_000,
    });
    const retry = await submitValidatedBugReport('user-123', report, deps);
    expect(deps.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveProperty('reporterUid');
    expect(memory.docs.get(`bugReportEscalations/${reportId}`)).toEqual({
      state: 'terminal', outcome: 'queued', resolvedAt: 2_000, expiresAt: 3_000,
    });
  });

  it('atomically creates the same bound task for legacy UNKNOWN intake', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory, {
      resolveEscalation: vi.fn(async () => ({ member: null, eventActive: null })),
    });
    const report = { ...base(), submissionId: null };

    const receipt = await submitValidatedBugReport('user-123', report, deps);

    expect(memory.docs.get(`bugReports/${receipt.reportId}`)).toMatchObject({
      escalationLookupFailed: true,
      reporterHash: 'fcdec6df4d44dbc637c7',
    });
    expect(memory.docs.get(`bugReportEscalations/${receipt.reportId}`)).toMatchObject({
      state: 'pending',
      eventId: 'med-2026',
      reporterUid: 'user-123',
      reporterHash: 'fcdec6df4d44dbc637c7',
      attemptCount: 0,
    });
    expect(receipt).not.toHaveProperty('reporterUid');
  });

  it('does not create delayed work when intake gets a known answer', async () => {
    for (const answer of [
      { member: true, eventActive: true },
      { member: false, eventActive: true },
      { member: true, eventActive: false },
    ]) {
      const memory = new MemoryIntake();
      const deps = dependencies(memory, { resolveEscalation: vi.fn(async () => answer) });
      await submitValidatedBugReport('user-123', base(), deps);
      expect([...memory.docs.keys()].filter((path) => path.startsWith('bugReportEscalations/'))).toEqual([]);
    }
  });

  it('does not partially finalize when its deterministic escalation task collides', async () => {
    const memory = new MemoryIntake();
    const report = base();
    const reportId = deriveBugReportId('user-123', report.submissionId!);
    memory.docs.set(`bugReportEscalations/${reportId}`, { state: 'unexpected' });
    const deps = dependencies(memory, {
      resolveEscalation: vi.fn(async () => ({ member: null, eventActive: null })),
    });

    await expect(submitValidatedBugReport('user-123', report, deps)).rejects.toThrow('already exists');
    expect(memory.docs.get(`bugReports/${reportId}`)).toMatchObject({
      intakeState: 'pending',
      leaseExpiresAt: 1_000,
    });
    expect(memory.docs.get(`bugReportEscalations/${reportId}`)).toEqual({ state: 'unexpected' });
  });

  it('validates before touching a reservation or rolling rate state', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory);
    await expect(handleSubmitBugReport({ auth: { uid: 'user-123' }, data: { schemaVersion: 1 } } as never, false, deps))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    expect(memory.docs.size).toBe(0);
  });

  it('returns stored success on a sequential retry without charging, looking up, or uploading twice', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory);
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const first = await submitValidatedBugReport('user-123', report, deps);
    const retry = await submitValidatedBugReport('user-123', report, deps);
    expect(retry).toEqual(first);
    expect(memory.docs.get('bugReportRateLimits/fcdec6df4d44dbc637c7')?.submissionMs).toEqual([1_000]);
    expect(deps.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(memory.saves).toHaveLength(1);
    expect([...memory.docs.keys()].filter((path) => path.startsWith('bugReports/'))).toHaveLength(1);
  });

  it('makes a live concurrent retry a follower and returns the owner receipt', async () => {
    const memory = new MemoryIntake();
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let firstPoll = true;
    const deps = dependencies(memory, {
      resolveEscalation: vi.fn(async () => { await lookupGate; return { member: true, eventActive: true }; }),
      sleep: async () => { if (firstPoll) { firstPoll = false; releaseLookup(); } await Promise.resolve(); },
    });
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const [owner, follower] = await Promise.all([
      submitValidatedBugReport('user-123', report, deps),
      submitValidatedBugReport('user-123', report, deps),
    ]);
    expect(follower).toEqual(owner);
    expect(memory.docs.get('bugReportRateLimits/fcdec6df4d44dbc637c7')?.submissionMs).toEqual([1_000]);
    expect(deps.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(memory.saves).toHaveLength(1);
  });

  it('rejects an interleaved mismatched retry before it can combine metadata with owner evidence', async () => {
    const memory = new MemoryIntake();
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const deps = dependencies(memory, {
      resolveEscalation: vi.fn(async () => { await lookupGate; return { member: true, eventActive: true }; }),
    });
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const owner = submitValidatedBugReport('user-123', report, deps);
    await vi.waitFor(() => expect(deps.resolveEscalation).toHaveBeenCalledTimes(1));
    await expect(submitValidatedBugReport('user-123', { ...report, description: 'different' }, deps))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    releaseLookup();
    await owner;
    expect(deps.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(memory.saves).toHaveLength(1);
  });

  it('takes over an expired lease and reuses matching create-only screenshot evidence', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory);
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const reportId = deriveBugReportId('user-123', report.submissionId!);
    const hash = deriveBugReportRequestHash(report);
    const reporterHash = 'fcdec6df4d44dbc637c7';
    memory.docs.set(`bugReports/${reportId}`, {
      submissionId: report.submissionId,
      reporterHash,
      requestHashVersion: hash.version,
      requestHash: hash.value,
      intakeState: 'pending',
      intakeStartedAt: 900,
      leaseId: 'expired-owner',
      leaseExpiresAt: 1_000,
    });
    const storagePath = `bug-reports/${reporterHash}/${reportId}/screenshot.png`;
    memory.objects.set(storagePath, {
      bytes: Buffer.from('evidence'),
      metadata: { requestHashVersion: '1', requestHash: hash.value },
    });
    await expect(submitValidatedBugReport('user-123', report, deps)).resolves.toEqual({
      reportId,
      escalationEligible: true,
    });
    expect(memory.saves).toEqual([]);
    expect(memory.docs.get(`bugReports/${reportId}`)?.intakeState).toBe('complete');
    expect(memory.docs.has(`bugReportRateLimits/${reporterHash}`)).toBe(false);
  });

  it('fails closed without deleting create-only evidence whose metadata does not match', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory);
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const reportId = deriveBugReportId('user-123', report.submissionId!);
    const hash = deriveBugReportRequestHash(report);
    const reporterHash = 'fcdec6df4d44dbc637c7';
    memory.docs.set(`bugReports/${reportId}`, {
      submissionId: report.submissionId,
      reporterHash,
      requestHashVersion: hash.version,
      requestHash: hash.value,
      intakeState: 'pending',
      intakeStartedAt: 900,
      leaseId: 'expired-owner',
      leaseExpiresAt: 1_000,
    });
    const storagePath = `bug-reports/${reporterHash}/${reportId}/screenshot.png`;
    memory.objects.set(storagePath, {
      bytes: Buffer.from('different evidence'),
      metadata: { requestHashVersion: '1', requestHash: 'b'.repeat(64) },
    });
    await expect(submitValidatedBugReport('user-123', report, deps)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(memory.objects.get(storagePath)?.bytes.toString()).toBe('different evidence');
    expect(memory.docs.get(`bugReports/${reportId}`)?.intakeState).toBe('pending');
  });

  it('releases only its proven lease after an owner failure so a retry can recover immediately', async () => {
    const memory = new MemoryIntake();
    const failing = dependencies(memory, {
      resolveEscalation: vi.fn(async () => { throw new Error('lookup outage'); }),
    });
    const report = base();
    const reportId = deriveBugReportId('user-123', report.submissionId!);
    await expect(submitValidatedBugReport('user-123', report, failing)).rejects.toThrow('lookup outage');
    expect(memory.docs.get(`bugReports/${reportId}`)?.leaseExpiresAt).toBe(1_000);

    const recovery = dependencies(memory);
    await expect(submitValidatedBugReport('user-123', report, recovery)).resolves.toMatchObject({ reportId });
    expect(memory.docs.get(`bugReports/${reportId}`)?.intakeState).toBe('complete');
  });

  it('preserves deterministic evidence across a crash before finalization and reuses it on retry', async () => {
    const memory = new MemoryIntake();
    const underlying = memory.db.runTransaction;
    let transaction = 0;
    const crashing = dependencies(memory, {
      db: {
        ...memory.db,
        runTransaction: async (work: never) => {
          transaction += 1;
          if (transaction === 2) throw new Error('finalize unavailable');
          return await underlying(work);
        },
      } as never,
    });
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    await expect(submitValidatedBugReport('user-123', report, crashing)).rejects.toThrow('finalize unavailable');
    expect(memory.objects.size).toBe(1);
    expect(memory.saves).toHaveLength(1);

    await expect(submitValidatedBugReport('user-123', report, dependencies(memory))).resolves.toMatchObject({
      reportId: deriveBugReportId('user-123', report.submissionId!),
    });
    expect(memory.objects.size).toBe(1);
    expect(memory.saves).toHaveLength(1);
  });

  it('continues as owner when the initial claim commits but its response is lost', async () => {
    const memory = new MemoryIntake();
    const underlying = memory.db.runTransaction;
    let transaction = 0;
    const ambiguous = dependencies(memory, {
      db: {
        ...memory.db,
        runTransaction: async (work: never) => {
          transaction += 1;
          const result = await underlying(work);
          if (transaction === 1) throw new Error('claim response lost');
          return result;
        },
      } as never,
    });
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    await expect(submitValidatedBugReport('user-123', report, ambiguous)).resolves.toEqual({
      reportId: deriveBugReportId('user-123', report.submissionId!),
      escalationEligible: true,
    });
    expect(memory.docs.get('bugReportRateLimits/fcdec6df4d44dbc637c7')?.submissionMs).toEqual([1_000]);
    expect(ambiguous.resolveEscalation).toHaveBeenCalledTimes(1);
    expect(memory.saves).toHaveLength(1);
  });

  it('reads back success when finalization commits but its response is lost', async () => {
    const memory = new MemoryIntake();
    const underlying = memory.db.runTransaction;
    let transaction = 0;
    const ambiguous = dependencies(memory, {
      db: {
        ...memory.db,
        runTransaction: async (work: never) => {
          transaction += 1;
          const result = await underlying(work);
          if (transaction === 2) throw new Error('response lost');
          return result;
        },
      } as never,
    });
    const report = base();
    await expect(submitValidatedBugReport('user-123', report, ambiguous)).resolves.toEqual({
      reportId: deriveBugReportId('user-123', report.submissionId!),
      escalationEligible: true,
    });
  });

  it('fails closed when an ALREADY_EXISTS readback is missing or malformed', async () => {
    const report = base();
    for (const existing of [undefined, { intakeState: 'pending' }]) {
      const memory = new MemoryIntake();
      const reportId = deriveBugReportId('user-123', report.submissionId!);
      if (existing) memory.docs.set(`bugReports/${reportId}`, existing);
      const deps = dependencies(memory, {
        db: {
          ...memory.db,
          runTransaction: async () => { throw Object.assign(new Error('already exists'), { code: 6 }); },
        } as never,
      });
      await expect(submitValidatedBugReport('user-123', report, deps)).rejects.toMatchObject({
        code: existing ? 'failed-precondition' : 'unavailable',
      });
    }
  });

  it('bounds an ALREADY_EXISTS follower wait without escalation, upload, or another charge', async () => {
    const memory = new MemoryIntake();
    const report = { ...base(), screenshot: Buffer.from('evidence') };
    const reportId = deriveBugReportId('user-123', report.submissionId!);
    const hash = deriveBugReportRequestHash(report);
    memory.docs.set(`bugReports/${reportId}`, {
      submissionId: report.submissionId,
      reporterHash: 'fcdec6df4d44dbc637c7',
      requestHashVersion: hash.version,
      requestHash: hash.value,
      intakeState: 'pending',
      intakeStartedAt: 900,
      leaseId: 'other-owner',
      leaseExpiresAt: 2_000,
    });
    const sleep = vi.fn(async () => undefined);
    const deps = dependencies(memory, {
      db: {
        ...memory.db,
        runTransaction: async () => { throw Object.assign(new Error('already exists'), { code: 6 }); },
      } as never,
      sleep,
    });
    await expect(submitValidatedBugReport('user-123', report, deps)).rejects.toMatchObject({ code: 'unavailable' });
    expect(sleep).toHaveBeenCalledTimes(50);
    expect(deps.resolveEscalation).not.toHaveBeenCalled();
    expect(memory.saves).toEqual([]);
    expect(memory.docs.has('bugReportRateLimits/fcdec6df4d44dbc637c7')).toBe(false);
  });

  it('preserves legacy absent-token creation and per-invocation rate charging', async () => {
    const memory = new MemoryIntake();
    const deps = dependencies(memory);
    const legacy = { ...base(), submissionId: null, kind: 'bug' as const };
    const first = await submitValidatedBugReport('user-123', legacy, deps);
    const second = await submitValidatedBugReport('user-123', legacy, deps);
    expect(second.reportId).not.toBe(first.reportId);
    expect([...memory.docs.keys()].filter((path) => path.startsWith('bugReports/'))).toHaveLength(2);
    expect(memory.docs.get('bugReportRateLimits/fcdec6df4d44dbc637c7')?.submissionMs).toEqual([1_000, 1_000]);
  });
});
