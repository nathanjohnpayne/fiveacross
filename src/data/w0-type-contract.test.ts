import { describe, it, expect } from 'vitest';
import type { QueryDocumentSnapshot } from 'firebase/firestore';
import { migrateClaimMode, migrateDayFields, migratePool, eventConverter, itemConverter } from './converters';
import type {
  ClaimMode,
  DoubtDoc,
  EventDoc,
  MomentDoc,
  ProofDoc,
  TallyDoc,
  TallyEntry,
  UserDoc,
} from '../types';

// The passthrough converters only ever call snap.data(); a one-method stand-in
// exercises the read path without a live Firestore snapshot.
const snapshotOf = (data: unknown) => ({ data: () => data }) as unknown as QueryDocumentSnapshot;

// A current-contract Event minus its Claim Mode. Its `settings` shape (no
// blackoutEnabled) also pins ADR 0004's dead-config drop at compile time.
const baseEvent: Omit<EventDoc, 'claimMode'> = {
  name: 'Test Sailing',
  startsOn: '2026-01-01',
  endsOn: '2026-01-08',
  status: 'active',
  defaultTheme: 'neon-playground',
  admins: [],
  bannedUids: [],
  timezone: 'Europe/Rome',
  days: [],
  settings: { reportHideThreshold: 4 },
};

describe('migrateClaimMode (legacy Claim Mode read-migration)', () => {
  it('coerces a pre-rename persisted value to admin_confirmed', () => {
    expect(migrateClaimMode('verified')).toBe('admin_confirmed');
  });

  it('passes current Claim Modes through unchanged', () => {
    const modes: ClaimMode[] = ['honor', 'proof_required', 'admin_confirmed'];
    for (const mode of modes) expect(migrateClaimMode(mode)).toBe(mode);
  });

  it('never resolves to the legacy value and defaults unknown/missing to honor', () => {
    for (const raw of ['verified', 'honor', 'proof_required', 'admin_confirmed', 'bogus', undefined, null]) {
      expect(migrateClaimMode(raw)).not.toBe('verified');
    }
    expect(migrateClaimMode('bogus')).toBe('honor');
    expect(migrateClaimMode(undefined)).toBe('honor');
  });
});

describe('eventConverter (migration applied on read)', () => {
  it('reads a persisted Event with the legacy claimMode as admin_confirmed', () => {
    const event = eventConverter.fromFirestore(snapshotOf({ ...baseEvent, claimMode: 'verified' }));
    expect(event.claimMode).toBe('admin_confirmed');
  });

  it('preserves every other field while migrating claimMode', () => {
    const event = eventConverter.fromFirestore(snapshotOf({ ...baseEvent, claimMode: 'verified' }));
    expect(event.name).toBe('Test Sailing');
    expect(event.settings.reportHideThreshold).toBe(4);
  });

  it('re-serializing a migrated Event never re-introduces the legacy value', () => {
    const event = eventConverter.fromFirestore(snapshotOf({ ...baseEvent, claimMode: 'verified' }));
    const written = eventConverter.toFirestore(event) as { claimMode: ClaimMode };
    expect(written.claimMode).toBe('admin_confirmed');
  });

  it('defaults a missing bannedUids (legacy event doc, pre-#113) to []', () => {
    // Event docs seeded before the ban surface landed carry no bannedUids; the
    // converter fills it with [] so consumers never branch on undefined.
    const legacy = { ...baseEvent, claimMode: 'honor' as const };
    delete (legacy as { bannedUids?: string[] }).bannedUids;
    const event = eventConverter.fromFirestore(snapshotOf(legacy));
    expect(event.bannedUids).toEqual([]);
  });

  it('preserves a present bannedUids roster and coerces a malformed value to []', () => {
    const banned = eventConverter.fromFirestore(
      snapshotOf({ ...baseEvent, claimMode: 'honor', bannedUids: ['bob'] }),
    );
    expect(banned.bannedUids).toEqual(['bob']);
    const malformed = eventConverter.fromFirestore(
      snapshotOf({ ...baseEvent, claimMode: 'honor', bannedUids: 'bob' }),
    );
    expect(malformed.bannedUids).toEqual([]);
  });

  // --- #566 neutral field names: sailStart/sailEnd → startsOn/endsOn, and
  // per-Day port/portEmoji → place/placeEmoji, coerced on READ (the
  // migrateClaimMode pattern) so the live pre-rename GCB doc keeps working
  // with no data migration while the Bodega doc — seeded with the neutral
  // names from day one — reads directly.
  it('reads a pre-rename Event window (sailStart/sailEnd) as startsOn/endsOn', () => {
    const legacy = {
      ...baseEvent,
      claimMode: 'honor',
      sailStart: '2026-07-15',
      sailEnd: '2026-07-24',
    } as Record<string, unknown>;
    delete legacy.startsOn;
    delete legacy.endsOn;
    const event = eventConverter.fromFirestore(snapshotOf(legacy));
    expect(event.startsOn).toBe('2026-07-15');
    expect(event.endsOn).toBe('2026-07-24');
  });

  it('prefers the neutral window names when a doc carries both (a post-rename reseed merge)', () => {
    const both = {
      ...baseEvent,
      claimMode: 'honor',
      startsOn: '2026-08-07',
      endsOn: '2026-08-09',
      sailStart: '2026-07-15',
      sailEnd: '2026-07-24',
    };
    const event = eventConverter.fromFirestore(snapshotOf(both));
    expect(event.startsOn).toBe('2026-08-07');
    expect(event.endsOn).toBe('2026-08-09');
  });

  it('resolves an Event carrying neither window shape to empty strings (formatters degrade to no range)', () => {
    const bare = { ...baseEvent, claimMode: 'honor' } as Record<string, unknown>;
    delete bare.startsOn;
    delete bare.endsOn;
    const event = eventConverter.fromFirestore(snapshotOf(bare));
    expect(event.startsOn).toBe('');
    expect(event.endsOn).toBe('');
  });

  it('reads pre-rename Day fields (port/portEmoji) as place/placeEmoji across days[]', () => {
    const legacyDay = {
      index: 0,
      date: '2026-07-16',
      port: 'Split',
      portEmoji: '🇭🇷',
      theme: 'get-sporty',
      tonight: ['a', 'b'],
      pool: 'main',
      tutorial: false,
      unlockAt: 1,
    };
    const event = eventConverter.fromFirestore(
      snapshotOf({ ...baseEvent, claimMode: 'honor', days: [legacyDay] }),
    );
    expect(event.days[0].place).toBe('Split');
    expect(event.days[0].placeEmoji).toBe('🇭🇷');
    // The legacy keys are stripped from the coerced object, so a consumer that
    // serializes a converter-read Day never re-emits both shapes.
    expect(event.days[0]).not.toHaveProperty('port');
    expect(event.days[0]).not.toHaveProperty('portEmoji');
    // Everything else passes through untouched.
    expect(event.days[0].theme).toBe('get-sporty');
    expect(event.days[0].unlockAt).toBe(1);
  });
});

describe('migrateDayFields (#566 legacy Day field read-migration)', () => {
  it('preserves the legacy emoji when a dual-written Day carries the live correction', () => {
    const day = migrateDayFields({ place: 'Bodega Bay', placeEmoji: '🐦', port: 'Split', portEmoji: '🇭🇷' });
    expect(day.place).toBe('Bodega Bay');
    expect(day.placeEmoji).toBe('🇭🇷');
  });

  it('passes a neutral-named Day through, coercing the legacy pool value (#565)', () => {
    const day = migrateDayFields({ index: 3, place: 'The drive home', placeEmoji: '🌫️', pool: 'farewell' });
    expect(day.place).toBe('The drive home');
    expect(day.placeEmoji).toBe('🌫️');
    expect(day.index).toBe(3);
    expect(day.pool).toBe('closing');
  });

  it('defaults a Day with neither shape (malformed/minimal fixture) to empty strings', () => {
    const day = migrateDayFields({ index: 1 });
    expect(day.place).toBe('');
    expect(day.placeEmoji).toBe('');
  });
});

describe('migratePool (#565 legacy pool value read-migration)', () => {
  it('coerces the pre-rename persisted values to the canonical vocabulary', () => {
    expect(migratePool('embark')).toBe('easy');
    expect(migratePool('farewell')).toBe('closing');
  });

  it('passes canonical values through unchanged', () => {
    for (const pool of ['main', 'easy', 'closing'] as const) expect(migratePool(pool)).toBe(pool);
  });

  it('defaults unknown/missing values to main — the pre-Phase-1.5 items default', () => {
    expect(migratePool(undefined)).toBe('main');
    expect(migratePool(null)).toBe('main');
    expect(migratePool('bogus')).toBe('main');
  });
});

describe('itemConverter (pool migration applied on read)', () => {
  it('reads a legacy-persisted item pool as the canonical value, and defaults a missing pool to main', () => {
    const read = (data: Record<string, unknown>) =>
      itemConverter.fromFirestore({ data: () => data, id: 'item-1' } as unknown as Parameters<
        typeof itemConverter.fromFirestore
      >[0]);
    expect(read({ text: 't', pool: 'embark' }).pool).toBe('easy');
    expect(read({ text: 't', pool: 'farewell' }).pool).toBe('closing');
    expect(read({ text: 't', pool: 'easy' }).pool).toBe('easy');
    expect(read({ text: 't' }).pool).toBe('main');
  });
});

describe('ProofDoc status contract', () => {
  it("covers the 'pending' state attachProof writes under admin_confirmed Claim Mode", () => {
    // Compile-time pin: a Proof created under admin_confirmed starts 'pending'
    // (data/proofs attachProof, admin-only readable per firestore.rules), so the
    // ProofDoc.status union must include it — narrowing it back breaks this literal.
    const pendingProof: ProofDoc = {
      id: 'pr1',
      uid: 'u1',
      displayName: 'Ada',
      photoURL: null,
      type: 'photo',
      cellIndex: 3,
      itemText: 'Sang at the piano bar',
      createdAt: 1,
      reportCount: 0,
      status: 'pending',
    };
    expect(pendingProof.status).toBe('pending');
  });
});

describe('social type contract (imported unchanged by Wave-2 tickets)', () => {
  it('TallyEntry + TallyDoc model an attributed per-Prompt marker list plus count', () => {
    const entry: TallyEntry = { uid: 'u1', displayName: 'Ada', markedAt: 1 };
    const tally: TallyDoc = { itemId: 'p1', count: 1, markers: [entry] };
    expect(tally.markers).toHaveLength(tally.count);
    expect(tally.markers[0].displayName).toBe('Ada');
  });

  it('DoubtDoc models an ask-for-proof carrying open/answered state', () => {
    const doubt: DoubtDoc = {
      id: 'd1',
      itemId: 'p1',
      cellIndex: 3,
      fromUid: 'u2',
      fromDisplayName: 'Bo',
      targetUid: 'u1',
      targetDisplayName: 'Ada',
      createdAt: 2,
    };
    expect(doubt.satisfiedAt ?? null).toBeNull();
    expect(doubt.targetUid).toBe('u1');
  });

  it('MomentDoc carries a kind but no attached evidence', () => {
    const moment: MomentDoc = {
      id: 'm1',
      kind: 'bingo',
      uid: 'u1',
      displayName: 'Ada',
      photoURL: null,
      createdAt: 3,
    };
    expect(moment.kind).toBe('bingo');
    expect('mediaURL' in moment).toBe(false);
  });

  it('UserDoc carries the optional 18+ attestation timestamp', () => {
    const user: UserDoc = { displayName: 'Ada', photoURL: null, createdAt: 1, attestedAdultAt: 42 };
    expect(user.attestedAdultAt).toBe(42);
  });
});
