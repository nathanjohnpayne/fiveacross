import { describe, expect, it } from 'vitest';

import {
  applyBodegaPreviewProvisioning,
  BODEGA_EVENT_ID,
  BODEGA_EVENT_PREVIEW,
  BODEGA_PREVIEW_HOSTS,
  formatBodegaPreviewPlan,
  planBodegaPreviewProvisioning,
} from '../../scripts/provision-bodega-preview.mjs';

// The provisioner is a deliberately narrow Admin-SDK write: it must cover all
// hosts Bodega serves, never create routing records, and refuse any host that
// no longer belongs to the active Event. Its planning boundary stays pure so
// these guarantees do not depend on production credentials (#647).

type TestRow = { host: string; data: Record<string, unknown> | null };

const active = (preview?: unknown): Record<string, unknown> => ({
  eventId: BODEGA_EVENT_ID,
  status: 'active',
  ...(preview === undefined ? {} : { preview }),
});

const liveRows = (preview?: unknown): TestRow[] =>
  BODEGA_PREVIEW_HOSTS.map((host: string) => ({ host, data: active(preview) }));

describe('Bodega postcard provisioner', () => {
  it('atomically publishes each preview with a full public replacement while retaining canonical extras', async () => {
    const canonical = Object.fromEntries(liveRows().map(row => [`hostnames/${row.host}`, { ...row.data, pathNamespace: null, internalNote: 'private' }]));
    const stored: Record<string, Record<string, unknown>> = { ...canonical };
    const db = {
      doc: (path: string) => path,
      async runTransaction<T>(work: (transaction: {
        get(ref: unknown): Promise<{ exists: boolean; data(): Record<string, unknown> }>;
        update(ref: unknown, data: Record<string, unknown>): unknown;
        set(ref: unknown, data: Record<string, unknown>): unknown;
      }) => Promise<T>): Promise<T> {
        const writes: Array<[string, Record<string, unknown>, boolean]> = [];
        const result = await work({
          get: async ref => { expect(writes).toHaveLength(0); return { exists: String(ref) in stored, data: () => stored[String(ref)]! }; },
          update: (ref, data) => { writes.push([String(ref), data, false]); },
          set: (ref, data) => { writes.push([String(ref), data, true]); },
        });
        for (const [path, value, replace] of writes) stored[path] = replace ? value : { ...stored[path], ...value };
        return result;
      },
    };
    await applyBodegaPreviewProvisioning(db);
    for (const host of BODEGA_PREVIEW_HOSTS) {
      expect(stored[`hostnames/${host}`]).toMatchObject({ pathNamespace: null, internalNote: 'private', preview: BODEGA_EVENT_PREVIEW });
      expect(stored[`publicHostnames/${host}`]).toEqual({ eventId: BODEGA_EVENT_ID, status: 'active', preview: BODEGA_EVENT_PREVIEW });
    }
  });

  it('plans the same public preview for every live serving host', () => {
    const plan = planBodegaPreviewProvisioning(liveRows());
    expect(plan.updates).toEqual(BODEGA_PREVIEW_HOSTS);
    expect(plan.alreadyCorrect).toEqual([]);
    expect(BODEGA_EVENT_PREVIEW).toEqual({
      eventName: 'Weekend in Bodega Bay',
      dateRange: 'Aug 7–9',
      hostedBy: 'Kim',
      days: [
        { date: '2026-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' },
        { date: '2026-08-08', title: 'Side Quests' },
        { date: '2026-08-09', title: 'Fog, Froth & Farewells' },
      ],
    });
  });

  it('is idempotent when every host already has the exact preview', () => {
    const plan = planBodegaPreviewProvisioning(liveRows(BODEGA_EVENT_PREVIEW));
    expect(plan.updates).toEqual([]);
    expect(plan.alreadyCorrect).toEqual(BODEGA_PREVIEW_HOSTS);
    expect(formatBodegaPreviewPlan(plan)).toContain('already correct');
  });

  it.each([
    { privateEmail: 'private@example.test' },
    { preview: { eventName: 'Public', memberEmails: ['private@example.test'] } },
  ])('retains private canonical metadata while planning the public preview (%j)', extra => {
    const rows = liveRows();
    rows[0] = { ...rows[0]!, data: { ...rows[0]!.data!, ...extra } };
    expect(planBodegaPreviewProvisioning(rows).updates).toEqual(BODEGA_PREVIEW_HOSTS);
    expect(rows[0]!.data).toMatchObject(extra);
  });

  it('refuses a missing host rather than partially changing routing', () => {
    expect(() => planBodegaPreviewProvisioning(liveRows().slice(1))).toThrow('is missing');
  });

  it('refuses a repointed host rather than partially changing routing', () => {
    const rows = liveRows();
    rows[0] = { ...rows[0]!, data: { ...rows[0]!.data!, eventId: 'somewhere-else' } };
    expect(() => planBodegaPreviewProvisioning(rows)).toThrow('expected bodega-bay-2026');
  });

  it('refuses an inactive host rather than partially changing routing', () => {
    const rows = liveRows();
    rows[0] = { ...rows[0]!, data: { ...rows[0]!.data!, status: 'archived' } };
    expect(() => planBodegaPreviewProvisioning(rows)).toThrow('only an active serving host');
  });
});
