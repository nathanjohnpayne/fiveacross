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

    // A blob from a schema version this build does not read, and one that is
    // not JSON at all. Both are misses for listing purposes; whether they are
    // also RECLAIMED is a separate question the reclamation tests below cover.
    storage.setItem('gcb:event-draft:future', JSON.stringify({ ...draft(), v: 99 }));
    storage.setItem('gcb:event-draft:junk', 'not json');
    // Somebody else's key in the same origin.
    storage.setItem('gcb:card-snapshot:med-2026:uid:day-1', 'unrelated');

    const list = await store.list();
    expect(list.map((s) => s.draftId)).toEqual(['newer', 'older']);
    expect(list[0]).toEqual({ draftId: 'newer', name: 'Newer', step: 'squares', updatedAt: NOW + 60_000 });
  });

  it('never deletes anything while listing, readable or not', async () => {
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW);
    await store.save(draft({ draftId: 'live' }));
    storage.setItem('gcb:event-draft:retired', JSON.stringify({ ...draft(), v: 0 }));
    storage.setItem('gcb:event-draft:junk', 'not json');
    storage.setItem('gcb:card-snapshot:med-2026:uid:day-1', 'unrelated');

    expect((await store.list()).map((s) => s.draftId)).toEqual(['live']);

    // Listing is a READ. Reclamation was removed because mustPreserve() and
    // removeItem() are separate localStorage operations and another tab can
    // land a valid save between them, with no compare-and-delete primitive to
    // close the window (#787 Phase 4b). Wrongly keeping dead bytes costs
    // quota; wrongly deleting destroys an organizer's work.
    expect(storage.raw.has('gcb:event-draft:retired')).toBe(true);
    expect(storage.raw.has('gcb:event-draft:junk')).toBe(true);
    expect(storage.raw.has('gcb:event-draft:live')).toBe(true);
    expect(storage.raw.has('gcb:card-snapshot:med-2026:uid:day-1')).toBe(true);
  });

  it('never reclaims a draft written by a NEWER schema version', async () => {
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW);
    // The rollback case: a cached older bundle, or a reverted deployment,
    // enumerating a draft the organizer wrote in the newer build. It is
    // unreadable HERE but still live THERE, so deleting it to reclaim quota
    // would destroy work the organizer can otherwise still open (#787 review).
    storage.setItem('gcb:event-draft:newer', JSON.stringify({ ...draft(), v: DRAFT_SCHEMA_VERSION + 1 }));

    const list = await store.list();

    // Invisible to this build...
    expect(list.map((s) => s.draftId)).toEqual([]);
    expect(await store.load('newer')).toBeNull();
    // ...but still on the device, intact, for the build that can read it.
    expect(storage.raw.has('gcb:event-draft:newer')).toBe(true);
    expect(JSON.parse(storage.raw.get('gcb:event-draft:newer') as string).v).toBe(
      DRAFT_SCHEMA_VERSION + 1,
    );
  });

  it('leaves a garbage-version blob in place too, but hides it', async () => {
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW);
    storage.setItem('gcb:event-draft:bogus', JSON.stringify({ ...draft(), v: 'tomorrow' }));

    expect(await store.list()).toEqual([]);
    expect(storage.raw.has('gcb:event-draft:bogus')).toBe(true);
    // discard() remains the way to reclaim it — deletion happens only where
    // the organizer actually asked for it.
    await store.discard('bogus');
    expect(storage.raw.has('gcb:event-draft:bogus')).toBe(false);
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
      // `length` and `key()` throw too in a restricted Storage — a fake that
      // only throws on getItem would let the enumeration pass vacuously.
      get length(): number {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
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

describe('parseEventDraft — persisted value bounds (#787 review)', () => {
  const settings = (over: Partial<EventDraft['settings']>): EventDraft => ({
    ...draft(),
    settings: { ...draft().settings, ...over },
  });

  it('rejects a non-positive report-hide threshold', () => {
    // `isReportHidden` and the server auto-hide path both read a non-positive
    // threshold as "off", so accepting one launches an Event whose moderation
    // is silently disabled.
    expect(parseEventDraft(settings({ reportHideThreshold: 0 }))).toBeNull();
    expect(parseEventDraft(settings({ reportHideThreshold: -3 }))).toBeNull();
    expect(parseEventDraft(settings({ reportHideThreshold: 1 }))).not.toBeNull();
  });

  it('rejects ratios outside the inclusive 0–1 range', () => {
    // `dealBoard` clamps, so an out-of-range value is not a stronger
    // preference — it is a stored setting the organizer never receives.
    expect(parseEventDraft(settings({ spicyRatio: -0.1 }))).toBeNull();
    expect(parseEventDraft(settings({ spicyRatio: 1.5 }))).toBeNull();
    expect(parseEventDraft(settings({ easyMixRatio: -1 }))).toBeNull();
    expect(parseEventDraft(settings({ easyMixRatio: 2 }))).toBeNull();
    // The boundaries themselves are legitimate.
    expect(parseEventDraft(settings({ spicyRatio: 0, easyMixRatio: 1 }))).not.toBeNull();
  });

  it('rejects Prompt text outside the persisted 1–80 contract', () => {
    const withMain = (text: string): EventDraft => ({
      ...draft(),
      prompts: { ...draft().prompts, main: [{ text, spicy: false }] },
    });
    expect(parseEventDraft(withMain(''))).toBeNull();
    expect(parseEventDraft(withMain('   '))).toBeNull();
    expect(parseEventDraft(withMain('x'.repeat(81)))).toBeNull();
    expect(parseEventDraft(withMain('x'.repeat(80)))).not.toBeNull();
  });

  it('applies the same text bounds to curated Prompts', () => {
    const withEasy = (text: string): EventDraft => ({
      ...draft(),
      prompts: { ...draft().prompts, easy: [{ text }] },
    });
    expect(parseEventDraft(withEasy(''))).toBeNull();
    expect(parseEventDraft(withEasy('x'.repeat(81)))).toBeNull();
    expect(parseEventDraft(withEasy('Order a round'))).not.toBeNull();
  });

  it('treats a curated Prompt spicy:undefined exactly like an absent key', () => {
    // The round-trip invariant: `JSON.stringify` drops the undefined property,
    // so a key-presence rule would flip launch validity across one save/load.
    const explicitUndefined = {
      ...draft(),
      prompts: { ...draft().prompts, easy: [{ text: 'Sunset swim', spicy: undefined }] },
    };
    const absent = {
      ...draft(),
      prompts: { ...draft().prompts, easy: [{ text: 'Sunset swim' }] },
    };
    expect(parseEventDraft(explicitUndefined)).not.toBeNull();
    expect(parseEventDraft(absent)).not.toBeNull();
    // The round trip does not change the verdict.
    expect(parseEventDraft(JSON.parse(JSON.stringify(explicitUndefined)))).not.toBeNull();
    // A DEFINED spicy flag is still refused on both sides.
    const defined = {
      ...draft(),
      prompts: { ...draft().prompts, easy: [{ text: 'Sunset swim', spicy: true }] },
    };
    expect(parseEventDraft(defined)).toBeNull();
    expect(parseEventDraft(JSON.parse(JSON.stringify(defined)))).toBeNull();
  });
});

describe('parseEventDraft — round-3 hardening (#787 review)', () => {
  it('bounds Prompt text as STORED, not as trimmed', () => {
    // firestore.rules applies text.size() <= 80 to the persisted value, so 80
    // visible characters plus trailing whitespace is 82 on the wire.
    const withMain = (text: string): EventDraft => ({
      ...draft(),
      prompts: { ...draft().prompts, main: [{ text, spicy: false }] },
    });
    expect(parseEventDraft(withMain(`${'x'.repeat(80)}  `))).toBeNull();
    expect(parseEventDraft(withMain(`${'x'.repeat(78)}  `))).not.toBeNull();
  });

  it('rejects a sparse Prompt pool, whose holes every() would skip', () => {
    const sparse: { text: string; spicy: boolean }[] = [];
    sparse.length = 3;
    sparse[0] = { text: 'real', spicy: false };
    const blob = { ...draft(), prompts: { ...draft().prompts, main: sparse } };
    // `every` returns true over the holes, so only a density check catches it.
    expect(sparse.every((p) => typeof p?.text === 'string')).toBe(true);
    expect(parseEventDraft(blob)).toBeNull();
  });
});

describe('listing never destroys a concurrent save (#787 review)', () => {
  it('keeps a blob another tab wrote during the scan', async () => {
    // localStorage is shared across same-origin tabs: another tab can save a
    // valid draft into a key this pass already classified from its previous
    // contents. Rendering the resume list must not erase that save. Now
    // guaranteed structurally — list() deletes nothing at all — so this
    // stands as a regression guard against reintroducing reclamation.
    const storage = fakeStorage();
    const key = 'gcb:event-draft:racy';
    storage.setItem(key, 'not json yet');

    let reads = 0;
    const racy: Storage & { raw: Map<string, string> } = {
      ...storage,
      raw: storage.raw,
      get length() {
        return storage.raw.size;
      },
      key: (i: number) => [...storage.raw.keys()][i] ?? null,
      getItem: (k: string) => {
        reads++;
        // After the enumeration pass has read it once as garbage, the "other
        // tab" lands a perfectly valid draft in the same key.
        if (k === key && reads >= 2) {
          return JSON.stringify({ ...draft(), draftId: 'racy' });
        }
        return storage.raw.get(k) ?? null;
      },
      setItem: (k: string, v: string) => void storage.raw.set(k, v),
      removeItem: (k: string) => void storage.raw.delete(k),
      clear: () => storage.raw.clear(),
    };

    const store = createLocalDraftStore(racy, () => NOW);
    await store.list();

    expect(racy.raw.has(key)).toBe(true);
  });
});

describe('parseEventDraft — a blank Free Space override is refused (#787 review)', () => {
  it('rejects freeText that is present but blank', () => {
    const withFreeText = (freeText: string | undefined): unknown => ({
      ...draft(),
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: Date.parse('2026-08-07T13:00:00Z'),
          place: 'Point Reyes',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'main',
          tutorial: false,
          tonight: ['a', 'b'],
          ...(freeText === undefined ? {} : { freeText }),
        },
      ],
    });
    // Absent is "use the default"; a real string is an override...
    expect(parseEventDraft(withFreeText(undefined))).not.toBeNull();
    expect(parseEventDraft(withFreeText('You made it aboard'))).not.toBeNull();
    // ...but blank is neither, and would deal an empty centre Square.
    expect(parseEventDraft(withFreeText(''))).toBeNull();
    expect(parseEventDraft(withFreeText('   '))).toBeNull();
  });
});

describe('sparse and mislabelled blobs (#787 review)', () => {
  it('rejects a sparse Tonight array, which would serialize to nulls', () => {
    const tonight: string[] = [];
    tonight.length = 2;
    const blob = {
      ...draft(),
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: Date.parse('2026-08-07T13:00:00Z'),
          place: 'p',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'main',
          tutorial: false,
          tonight,
        },
      ],
    };
    // `every` skips the holes, so only a density check catches this.
    expect(tonight.every((t) => typeof t === 'string')).toBe(true);
    expect(parseEventDraft(blob)).toBeNull();
  });

  it('skips a draft whose key and embedded id disagree, without deleting it', async () => {
    // list() would advertise the embedded id, load() would miss on it, and
    // discard() could never reach the real key — a permanently stuck row.
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW);
    storage.setItem(
      'gcb:event-draft:wrong-key',
      JSON.stringify({ ...draft(), draftId: 'embedded-id' }),
    );

    expect(await store.list()).toEqual([]);
    // Valid work is never destroyed to tidy a listing.
    expect(storage.raw.has('gcb:event-draft:wrong-key')).toBe(true);
  });
});

describe('save never replaces a good draft with an unreadable one (#787 Phase 4b)', () => {
  it('refuses to write a snapshot that would not read back', async () => {
    // JSON.stringify turns a sparse array into explicit nulls, which
    // parseEventDraft rejects — so writing it would destroy the stored draft.
    const storage = fakeStorage();
    const store = createLocalDraftStore(storage, () => NOW);

    const good = draft({ draftId: 'd1', name: 'Good' });
    await store.save(good);
    expect(await store.load('d1')).not.toBeNull();

    const sparseTonight: string[] = [];
    sparseTonight.length = 2;
    const bad = {
      ...good,
      name: 'Sparse',
      days: [
        {
          index: 0,
          date: '2026-08-07',
          unlockAt: Date.parse('2026-08-07T13:00:00Z'),
          place: 'p',
          placeEmoji: '🌊',
          theme: 'the-birds',
          pool: 'main',
          tutorial: false,
          tonight: sparseTonight,
        },
      ],
    } as unknown as EventDraft;

    await store.save(bad);

    // The PREVIOUS draft is intact — the save did not destroy it.
    const loaded = await store.load('d1');
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Good');
  });

  it('still returns the stamped in-memory draft, so the wizard is unaffected', async () => {
    const store = createLocalDraftStore(fakeStorage(), () => NOW);
    const sparse: string[] = [];
    sparse.length = 2;
    const bad = { ...draft(), days: [{ ...draft().days[0], tonight: sparse }] } as unknown as EventDraft;
    await expect(store.save(bad)).resolves.toMatchObject({ v: DRAFT_SCHEMA_VERSION });
  });
});
