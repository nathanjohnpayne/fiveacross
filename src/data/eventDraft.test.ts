import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../types';
import {
  DRAFT_SCHEMA_VERSION,
  createEventDraft,
  createLocalDraftStore,
  parseEventDraft,
} from './eventDraft';

/** A standalone in-memory `Storage`, so a round-trip needs no jsdom global and
 *  one test cannot see another's keys. */
function fakeStorage(): Storage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get length() {
      return raw.size;
    },
    key: (i: number) => [...raw.keys()][i] ?? null,
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => void raw.set(k, v),
    removeItem: (k: string) => void raw.delete(k),
    clear: () => raw.clear(),
  };
}

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function draft(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...createEventDraft({ now: NOW, draftId: 'draft-1', timezone: 'America/Los_Angeles' }),
    ...over,
  };
}

describe('createEventDraft', () => {
  it('opens on Step 1 at the current schema version with no occasion chosen', () => {
    const d = createEventDraft({ now: NOW, draftId: 'd1', timezone: 'Europe/Rome' });
    expect(d.v).toBe(DRAFT_SCHEMA_VERSION);
    expect(d.step).toBe('occasion');
    expect(d.occasion).toBeNull();
    expect(d.createdAt).toBe(NOW);
    expect(d.updatedAt).toBe(NOW);
  });

  it('holds no slug, event id or hostname — only a candidate', () => {
    const d = createEventDraft({ now: NOW });
    expect(d.slugCandidate).toBe('');
    expect(d).not.toHaveProperty('slug');
    expect(d).not.toHaveProperty('eventId');
    expect(d).not.toHaveProperty('hostname');
  });

  it('seeds the timezone as a suggestion rather than leaving it blank', () => {
    expect(createEventDraft({ now: NOW, timezone: 'America/Los_Angeles' }).timezone).toBe(
      'America/Los_Angeles',
    );
    // Unsupplied, it falls back to the device zone (or '' where Intl says
    // nothing) — a value to edit, never an answered question.
    expect(typeof createEventDraft({ now: NOW }).timezone).toBe('string');
  });

  it('mints a distinct id per draft', () => {
    expect(createEventDraft().draftId).not.toBe(createEventDraft().draftId);
  });

  it('states every Event setting rather than relying on absent-means-default', () => {
    const s = createEventDraft({ now: NOW }).settings;
    // `dailyEmailEnabled` in particular: it reads false unless explicitly
    // true and has no Admin control, so the wizard is the only place it can
    // ever be set.
    expect(s.dailyEmailEnabled).toBe(false);
    expect(s.forceAdult).toBe(false);
    expect(s.photoProofSource).toBe('camera_or_library');
    expect(s.stripPhotoExif).toBe(true);
    expect(s.visionGate).toBe(true);
  });
});

describe('parseEventDraft', () => {
  it('accepts a draft round-tripped through JSON', () => {
    const d = draft({ name: 'Weekend in Point Reyes' });
    expect(parseEventDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('reads a version-drifted blob as a miss, never as a mis-shaped draft', () => {
    const stale = { ...draft(), v: DRAFT_SCHEMA_VERSION + 1 };
    expect(parseEventDraft(stale)).toBeNull();
    expect(parseEventDraft({ ...draft(), v: DRAFT_SCHEMA_VERSION - 1 })).toBeNull();
  });

  it('rejects a blob that carries a claimed slug, event id or hostname', () => {
    expect(parseEventDraft({ ...draft(), slug: 'point-reyes' })).toBeNull();
    expect(parseEventDraft({ ...draft(), eventId: 'point-reyes-2026' })).toBeNull();
    expect(parseEventDraft({ ...draft(), hostname: 'point-reyes.fiveacross.app' })).toBeNull();
  });

  it('rejects a spicy flag on a curated-pool Prompt', () => {
    const bad = {
      ...draft(),
      prompts: { main: [], easy: [{ text: 'nope', spicy: true }], closing: [] },
    };
    expect(parseEventDraft(bad)).toBeNull();
  });

  it('accepts spicy on a main-pool Prompt', () => {
    const ok = {
      ...draft(),
      prompts: { main: [{ text: 'yes', spicy: true }], easy: [{ text: 'calm' }], closing: [] },
    };
    expect(parseEventDraft(ok)).not.toBeNull();
  });

  it('rejects a malformed Day, a bad step and a missing settings block', () => {
    expect(parseEventDraft({ ...draft(), days: [{ index: 0 }] })).toBeNull();
    expect(parseEventDraft({ ...draft(), step: 'nowhere' })).toBeNull();
    expect(parseEventDraft({ ...draft(), settings: {} })).toBeNull();
    expect(parseEventDraft(null)).toBeNull();
    expect(parseEventDraft('a string')).toBeNull();
  });

  it('accepts a Day carrying the open-immediately sentinel — the store stores it, validation judges it', () => {
    const d = {
      ...draft(),
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: 0,
          place: 'Point Reyes',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'easy',
          tutorial: false,
          tonight: ['a', 'b'],
        },
      ],
    };
    expect(parseEventDraft(d)?.days[0].unlockAt).toBe(0);
  });
});

describe('createLocalDraftStore — create, resume, discard', () => {
  it('resumes a saved draft at the same step with no field loss', async () => {
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW + 60_000);
    const saved = await store.save(draft({ step: 'look', name: 'Weekend in Point Reyes' }));

    const resumed = await store.load('draft-1');
    expect(resumed).toEqual(saved);
    expect(resumed?.step).toBe('look');
    expect(resumed?.name).toBe('Weekend in Point Reyes');
    expect(resumed).not.toHaveProperty('slug');
  });

  it('stamps updatedAt on save and leaves createdAt alone', async () => {
    const store = createLocalDraftStore(fakeStorage(), () => NOW + 60_000);
    const saved = await store.save(draft());
    expect(saved.createdAt).toBe(NOW);
    expect(saved.updatedAt).toBe(NOW + 60_000);
  });

  it('lists drafts most recently updated first, and skips unreadable blobs', async () => {
    const storage = fakeStorage();
    let clock = NOW;
    const store = createLocalDraftStore(storage, () => clock);

    await store.save(draft({ draftId: 'older', name: 'Older' }));
    clock = NOW + 60_000;
    await store.save(draft({ draftId: 'newer', name: 'Newer', step: 'squares' }));

    // A blob from a future schema version, and one that is not JSON at all.
    storage.setItem(`gcb:event-draft:v${DRAFT_SCHEMA_VERSION}:future`, JSON.stringify({ ...draft(), v: 99 }));
    storage.setItem(`gcb:event-draft:v${DRAFT_SCHEMA_VERSION}:junk`, 'not json');
    // Somebody else's key in the same origin.
    storage.setItem('gcb:card-snapshot:med-2026:uid:day-1', 'unrelated');

    const list = await store.list();
    expect(list.map((s) => s.draftId)).toEqual(['newer', 'older']);
    expect(list[0]).toEqual({ draftId: 'newer', name: 'Newer', step: 'squares', updatedAt: NOW + 60_000 });
  });

  it('discards one draft and leaves the rest, and discarding twice is not an error', async () => {
    const store = createLocalDraftStore(fakeStorage(), () => NOW);
    await store.save(draft({ draftId: 'a' }));
    await store.save(draft({ draftId: 'b' }));

    await store.discard('a');
    expect(await store.load('a')).toBeNull();
    expect(await store.load('b')).not.toBeNull();

    await expect(store.discard('a')).resolves.toBeUndefined();
  });

  it('reads a miss for an unknown or empty draft id', async () => {
    const store = createLocalDraftStore(fakeStorage(), () => NOW);
    expect(await store.load('nope')).toBeNull();
    expect(await store.load('')).toBeNull();
  });

  it('degrades to no persistence when the store throws, instead of crashing', async () => {
    const hostile: Storage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      clear: () => {},
    };
    const store = createLocalDraftStore(hostile, () => NOW);
    await expect(store.save(draft())).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(await store.load('draft-1')).toBeNull();
    expect(await store.list()).toEqual([]);
    await expect(store.discard('draft-1')).resolves.toBeUndefined();
  });

  it('re-stamps the schema version on save, so a hand-edited blob cannot persist a stale one', async () => {
    const store = createLocalDraftStore(fakeStorage(), () => NOW);
    const saved = await store.save({ ...draft(), v: 99 });
    expect(saved.v).toBe(DRAFT_SCHEMA_VERSION);
  });
});
