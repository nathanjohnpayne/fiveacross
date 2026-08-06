import { describe, it, expect, vi } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase/firestore';
import { boardConverter, eventConverter, itemConverter } from './converters';
import type { BoardDoc, EventDoc, ItemDoc, MomentDoc } from '../types';
import { THEMES } from '../theme/themes';
import { hasCanonicalMomentId } from '../hooks/useData';

// addItem writes through Firestore's addDoc; stub the write so we can assert the
// document SHAPE it stamps (the required Phase 1.5 `pool` field) without a live
// backend. Everything else in firebase/firestore stays real (converters and the
// moment filter never call it at runtime).
const { addDocMock } = vi.hoisted(() => ({
  addDocMock: vi.fn(async () => ({ id: 'new-item' })),
}));
vi.mock('../firebase', () => ({ db: {}, EVENT_ID: 'd15-test-event' }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    // The stub db ({}) is not a real Firestore, so short-circuit the ref
    // builders addItem calls before the write — we only assert the payload.
    collection: () => ({ __ref: 'items' }),
    addDoc: addDocMock,
  };
});

// Covers specs/d15-schema-contract.md: the Phase 1.5 domain type contract's
// read-side converter defaults (daily-cards-spec § "Data model" / "Migration")
// and the ThemeMeta.description presence guarantee (§ "Theme reference"). The
// passthrough/read converters only ever call snap.data()/snap.id, so a
// two-method stand-in exercises the read path without a live Firestore
// snapshot — the same seam w0-type-contract.test.ts uses.
const snapshotOf = (data: unknown, id = 'doc-id') =>
  ({ id, data: () => data }) as unknown as QueryDocumentSnapshot;

// A current-contract Item minus its `pool` — the legacy shape a Prompt seeded
// before Phase 1.5 persists (no pool key at all).
const legacyItem: Omit<ItemDoc, 'id' | 'pool'> = {
  text: 'Lost passport',
  createdBy: 'seed',
  createdAt: 0,
  isFreeSpace: false,
  status: 'active',
  reportCount: 0,
  spicy: false,
};

// A current-contract Event minus the two Phase 1.5 additions — the legacy shape
// an Event seeded before this ticket persists (no days/timezone keys).
const legacyEvent: Omit<EventDoc, 'days' | 'timezone'> = {
  name: 'Test Sailing',
  startsOn: '2026-07-15',
  endsOn: '2026-07-25',
  status: 'active',
  defaultTheme: 'neon-playground',
  claimMode: 'honor',
  admins: [],
  bannedUids: [],
  settings: { reportHideThreshold: 4 },
};

describe('itemConverter (Phase 1.5 pool default)', () => {
  it('defaults a missing pool (legacy Item doc, pre-Phase-1.5) to main', () => {
    const item = itemConverter.fromFirestore(snapshotOf(legacyItem, 'p1'));
    expect(item.pool).toBe('main');
    expect(item.id).toBe('p1'); // still pins the doc id like the pre-1.5 converter
  });

  it('preserves a present pool rather than overriding it', () => {
    for (const pool of ['main', 'easy', 'closing'] as const) {
      const item = itemConverter.fromFirestore(snapshotOf({ ...legacyItem, pool }));
      expect(item.pool).toBe(pool);
    }
  });
});

describe('eventConverter (Phase 1.5 days/timezone defaults)', () => {
  it('defaults a missing days/timezone (legacy Event doc) rather than throwing', () => {
    const event = eventConverter.fromFirestore(snapshotOf(legacyEvent));
    expect(event.days).toEqual([]);
    expect(event.timezone).toBe('Europe/Rome');
  });

  it('coerces a malformed days to [] and preserves a present schedule/zone', () => {
    const malformed = eventConverter.fromFirestore(
      snapshotOf({ ...legacyEvent, days: 'nope', timezone: 42 }),
    );
    expect(malformed.days).toEqual([]);
    expect(malformed.timezone).toBe('Europe/Rome');

    const day = {
      index: 0,
      date: '2026-07-16',
      place: 'Split',
      placeEmoji: '🇭🇷',
      theme: 'get-sporty' as const,
      pool: 'main' as const,
      tutorial: false,
      unlockAt: 0,
    };
    const present = eventConverter.fromFirestore(
      snapshotOf({ ...legacyEvent, days: [day], timezone: 'America/Los_Angeles' }),
    );
    expect(present.days).toEqual([day]);
    expect(present.timezone).toBe('America/Los_Angeles');
  });

  it('coerces an empty/whitespace/invalid timezone to Europe/Rome, preserves a real zone', () => {
    for (const bad of ['', '   ', 'Not/AZone', 'Mars/Olympus']) {
      const event = eventConverter.fromFirestore(snapshotOf({ ...legacyEvent, timezone: bad }));
      expect(event.timezone).toBe('Europe/Rome');
    }
    const good = eventConverter.fromFirestore(
      snapshotOf({ ...legacyEvent, timezone: 'Europe/London' }),
    );
    expect(good.timezone).toBe('Europe/London');
  });

  it('rejects offset ids and bare abbreviations (only canonical named IANA zones)', () => {
    // '+02:00'/'EST'/'Etc/GMT+5' are not real named zones — some runtimes'
    // Intl.DateTimeFormat accepts them, but the contract requires a canonical
    // zone, so they must coerce to Europe/Rome.
    for (const bad of ['+02:00', 'EST', 'Etc/GMT+5', '']) {
      const event = eventConverter.fromFirestore(snapshotOf({ ...legacyEvent, timezone: bad }));
      expect(event.timezone).toBe('Europe/Rome');
    }
    for (const good of ['Europe/Rome', 'America/New_York']) {
      const event = eventConverter.fromFirestore(snapshotOf({ ...legacyEvent, timezone: good }));
      expect(event.timezone).toBe(good);
    }
  });

  it('accepts valid IANA aliases by returning the runtime canonical zone', () => {
    const alias = 'Europe/Kyiv';
    const canonical = new Intl.DateTimeFormat('en-US', {
      timeZone: alias,
    }).resolvedOptions().timeZone;

    const event = eventConverter.fromFirestore(snapshotOf({ ...legacyEvent, timezone: alias }));

    expect(event.timezone).toBe(canonical);
    expect(event.timezone).not.toBe('Europe/Rome');
  });
});

describe('boardConverter (Phase 1.5 dayIndex default)', () => {
  // A current-contract Board minus its `dayIndex` — the legacy/current shape a
  // Board (one per Player per Event) persists before the day-scoped path (#204).
  const legacyBoard: Omit<BoardDoc, 'dayIndex'> = {
    uid: 'u1',
    seed: 123,
    createdAt: 0,
    cells: [],
  };

  it('defaults a missing dayIndex (legacy/current Board) to 0', () => {
    const board = boardConverter.fromFirestore(snapshotOf(legacyBoard));
    expect(board.dayIndex).toBe(0);
  });

  it('preserves a present dayIndex rather than overriding it', () => {
    const board = boardConverter.fromFirestore(snapshotOf({ ...legacyBoard, dayIndex: 3 }));
    expect(board.dayIndex).toBe(3);
  });
});

describe('hasCanonicalMomentId (Phase 1.5 finale beats render)', () => {
  const moment = (kind: MomentDoc['kind'], id: string, uid = 'u1'): MomentDoc => ({
    id,
    kind,
    uid,
    displayName: 'Pat',
    photoURL: null,
    createdAt: 0,
  });

  it('passes the two finale kinds when their singleton id === kind', () => {
    expect(hasCanonicalMomentId(moment('last_call', 'last_call'))).toBe(true);
    expect(hasCanonicalMomentId(moment('podium', 'podium'))).toBe(true);
  });

  it('rejects a finale moment whose id is not the canonical singleton id', () => {
    expect(hasCanonicalMomentId(moment('last_call', 'u1-last_call'))).toBe(false);
    expect(hasCanonicalMomentId(moment('podium', 'nope'))).toBe(false);
  });

  it('still gates the Phase 1 kinds unchanged', () => {
    expect(hasCanonicalMomentId(moment('first_bingo', 'first_bingo'))).toBe(true);
    expect(hasCanonicalMomentId(moment('bingo', 'u1-bingo'))).toBe(true);
    expect(hasCanonicalMomentId(moment('bingo', 'first_bingo'))).toBe(false);
  });
});

describe('addItem (Phase 1.5 pool stamp)', () => {
  it('stamps pool: main on the submitted prompt so the required field is honored', async () => {
    const { addItem } = await import('./api');
    addDocMock.mockClear();
    await addItem('player-uid', 'Cabin karaoke incident', true);
    expect(addDocMock).toHaveBeenCalledTimes(1);
    // status: 'pending' (not 'active') as of #210/specs/d15-approvals.md — the
    // approval-flow write itself is pinned in more depth over there
    // (src/data/api.test.ts); this suite only re-asserts the pool stamp still
    // rides along on the SAME write.
    expect(addDocMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pool: 'main', status: 'pending', spicy: true }),
    );
  });
});

describe('ThemeMeta.description (Phase 1.5 dress-code blurb)', () => {
  it('every THEMES entry carries a non-empty description', () => {
    expect(THEMES.length).toBeGreaterThan(0);
    for (const theme of THEMES) {
      expect(typeof theme.description).toBe('string');
      expect(theme.description.trim().length).toBeGreaterThan(0);
    }
  });
});
