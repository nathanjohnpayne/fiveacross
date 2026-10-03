import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { parseSubmitPromptRequest, submitPromptCallable, MAX_PENDING_PROMPTS, MAX_PROMPT_TARGET_DAYS } from '../../functions/src/submitPrompt';
import { MAX_DAYS } from '../../src/data/eventLimits';

const good = { expectedUid: 'player', eventId: 'event', itemId: 'item', text: '  Dance  ', spicy: false };
const request = (data: unknown = good, uid?: string, app?: object) => ({ data, ...(uid ? { auth: { uid } } : {}), ...(app ? { app } : {}) }) as CallableRequest<unknown>;

// specs/community-prompt-admission.md: reject before any Admin SDK path/query.
describe('submitPrompt callable boundary', () => {
  const failDb = () => {
    const doc = vi.fn(() => { throw new Error('SDK detail must stay private'); });
    return { db: { doc } as unknown as Firestore, doc, now: () => 123 };
  };
  it('uses the owner-approved fixed pending cap', () => expect(MAX_PENDING_PROMPTS).toBe(10));
  it('keeps the separately built admission target ceiling at the canonical Event bound', () => {
    expect(MAX_PROMPT_TARGET_DAYS).toBe(MAX_DAYS);
  });
  it('trims text and ignores forged server-owned fields', () => {
    expect(parseSubmitPromptRequest({ ...good, createdAt: 0, createdBy: 'other', targetDayIndex: 99, status: 'active' }))
      .toEqual({ ...good, text: 'Dance' });
  });
  it.each([null, [], { ...good, expectedUid: undefined }, { ...good, text: '' }, { ...good, text: 'x'.repeat(81) }, { ...good, spicy: 'yes' },
    ...['', '/', '.', '..', '__reserved__', 'é'.repeat(751)].flatMap(id => [{ ...good, eventId: id }, { ...good, itemId: id }, { ...good, expectedUid: id }])])('rejects malformed payload before SDK use: %j', async (data) => {
    const deps = failDb();
    await expect(submitPromptCallable(request(data, 'player'), false, deps)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(deps.doc).not.toHaveBeenCalled();
  });
  it('refuses a changed authenticated account before any Admin path or transaction', async () => {
    const deps = failDb();
    await expect(submitPromptCallable(request(good, 'other'), false, deps)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(deps.doc).not.toHaveBeenCalled();
  });
  it('requires auth before any Firestore access', async () => {
    const deps = failDb(); await expect(submitPromptCallable(request(), false, deps)).rejects.toMatchObject({ code: 'unauthenticated' }); expect(deps.doc).not.toHaveBeenCalled();
  });
  it('requires App Check only when configured', async () => {
    const deps = failDb(); await expect(submitPromptCallable(request(good, 'player'), true, deps)).rejects.toMatchObject({ code: 'failed-precondition' }); expect(deps.doc).not.toHaveBeenCalled();
    await expect(submitPromptCallable(request(good, 'player', {}), true, deps)).rejects.toMatchObject({ code: 'internal', message: 'Prompt submission failed; try again with signal.' });
  });
  it('logs bounded SDK codes without reflecting SDK errors or user text', async () => {
    const logger = { error: vi.fn() }; const deps = failDb();
    await expect(submitPromptCallable(request(good, 'player'), false, { ...deps, logger })).rejects.toMatchObject({ code: 'internal', message: 'Prompt submission failed; try again with signal.' });
    expect(logger.error).toHaveBeenCalledWith('submitPrompt failed', { code: 'unknown' });
  });
  it('returns fixed signal-required retry guidance for an invalid server clock without writes', async () => {
    const query = { where: vi.fn(), limit: vi.fn() };
    query.where.mockReturnValue(query); query.limit.mockReturnValue(query);
    const get = vi.fn().mockResolvedValueOnce({ exists: true, data: () => ({}) })
      .mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce({ data: () => undefined })
      .mockResolvedValueOnce({ size: 0 });
    const create = vi.fn(); const set = vi.fn();
    const deps = { db: { doc: vi.fn(path => ({ path })), collection: vi.fn(() => query),
      runTransaction: vi.fn(fn => fn({ get, create, set })) } as unknown as Firestore, now: () => Number.NaN };
    await expect(submitPromptCallable(request(good, 'player'), false, deps)).rejects.toMatchObject({
      code: 'internal', message: 'Prompt submission failed; try again with signal.',
    });
    expect(create).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

});
