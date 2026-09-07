import { describe, it, expect } from 'vitest';
import {
  eventClosedToPlay,
  manualUnlockNow,
  resnapshotDayIfNoBoards,
  runFinaleBeats,
  runScheduledUnlock,
  stampDaySnapshot,
  UnlockPermissionError,
  type AdminFirestore,
  type DayLike,
  type EventLike,
} from '../../functions/src/unlockDay';

// specs/post-sailing-archive.md § "The quiesce protocol", server half (#134,
// Codex P2 on PR #1139).
//
// `firestore.rules` stops a PLAYER from marking a square on an archived Event.
// It stops none of these: every core below runs on the Admin SDK, which bypasses
// the rules entirely and writes gameplay state with full data-plane authority —
// Day snapshots, the finale freeze, the Most-Loved award, and the system `Moment`
// beats. So the freeze has to be restated here, or the estate has a whole tier
// of writers the archive does not bind:
//
//   - the quarter-hourly sweep SELECTS its Events once per run and then
//     processes them one at a time, so a run selected moments before the
//     archive still arrives on a frozen Event — and a Cloud Functions retry can
//     arrive minutes later;
//   - the selection query is `status == 'active'`, which does not exclude the
//     CLOSING state at all (that state is deliberately still `'active'`) — and
//     the closing window is precisely when the client is reading the roster it
//     is about to freeze;
//   - `unlockDayNow` is an ADMIN callable, and the rules bind admins to the
//     freeze for gameplay for the stated reason: an archive whose own organiser
//     can still open a Day is not a frozen record.
//
// Every case here is paired — the same call on an OPEN Event still does its job
// — so no assertion passes because the fixture was inert. Every Firestore seam
// is a fake; no live runtime, no emulator.

interface StoredMoment {
  id: string;
  [k: string]: unknown;
}

type Fake = AdminFirestore & {
  readEvent(): EventLike;
  moments(): StoredMoment[];
  /** Mutate the stored Event out-of-band — the seam that plays "the archive
   *  committed between this core's first read and its write". */
  archiveNow(patch?: Partial<EventLike>): void;
};

/** A minimal in-memory stand-in for the admin-SDK surface unlockDay.ts injects,
 *  with two extras this suite needs: an out-of-band Event mutator, and a hook
 *  that fires on the FIRST transactional read so a test can land the archive
 *  inside the very window the re-checks exist to cover. */
function makeDb(seed: {
  eventId: string;
  event: EventLike;
  items?: Array<Record<string, unknown>>;
  players?: Array<Record<string, unknown>>;
  boards?: Array<Record<string, unknown>>;
  /** Runs once, immediately before the transaction body's first read. */
  onTransaction?: (db: { archiveNow(patch?: Partial<EventLike>): void }) => void;
}): Fake {
  const eventPath = `events/${seed.eventId}`;
  const docs: Record<string, Record<string, unknown> | undefined> = {
    [eventPath]: { ...seed.event } as Record<string, unknown>,
  };
  const items = [...(seed.items ?? [])];
  const players = [...(seed.players ?? [])];
  const boards = [...(seed.boards ?? [])];
  const moments: StoredMoment[] = [];
  let transactionHookFired = false;

  const archiveNow = (patch: Partial<EventLike> = { status: 'archived' }) => {
    docs[eventPath] = { ...(docs[eventPath] ?? {}), ...patch } as Record<string, unknown>;
  };

  const snapshotOf = (path: string) => {
    const data = docs[path];
    return { exists: data !== undefined, id: path.split('/').pop() as string, data: () => data };
  };

  const docRef = (path: string) => ({
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>) => {
      docs[path] = { ...data };
      return undefined;
    },
  });

  const collectionRef = (path: string) => {
    const filters: Array<[string, unknown]> = [];
    const backing = (): Array<Record<string, unknown>> =>
      path.endsWith('/items')
        ? items
        : path.endsWith('/players')
          ? players
          : path.endsWith('/boards')
            ? boards
            : path.endsWith('/moments')
              ? (moments as Array<Record<string, unknown>>)
              : [];
    const api = {
      where(field: string, _op: string, value: unknown) {
        filters.push([field, value]);
        return api;
      },
      async get() {
        const rows = backing().filter((row) => filters.every(([f, v]) => row[f] === v));
        return {
          docs: rows.map((row) => ({
            exists: true,
            id: row.id as string,
            data: () => row,
          })),
        };
      },
      doc(id?: string) {
        if (path.endsWith('/moments')) {
          const mid = id ?? `m${moments.length + 1}`;
          return {
            get: async () => ({ exists: false, id: mid, data: () => undefined }),
            set: async (data: Record<string, unknown>) => {
              const at = moments.findIndex((m) => m.id === mid);
              if (at >= 0) moments[at] = { id: mid, ...data };
              else moments.push({ id: mid, ...data });
              return undefined;
            },
          };
        }
        return docRef(`${path}/${id}`);
      },
    };
    return api as unknown as ReturnType<AdminFirestore['collection']>;
  };

  return {
    doc: (path: string) => docRef(path),
    collection: collectionRef,
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        get: async (ref: { get(): Promise<unknown> }) => {
          if (!transactionHookFired) {
            transactionHookFired = true;
            seed.onTransaction?.({ archiveNow });
          }
          return ref.get();
        },
        update: (_ref: unknown, data: Record<string, unknown>) => {
          docs[eventPath] = { ...(docs[eventPath] ?? {}), ...data };
        },
      };
      return fn(tx);
    },
    readEvent: () => docs[eventPath] as unknown as EventLike,
    moments: () => moments,
    archiveNow,
  };
}

const ADMIN = 'admin-uid';
// The same anchors the scheduler suite uses: Day 9 opens, Day 10 (closing) is
// the freeze.
const D9_UNLOCK = Date.UTC(2026, 6, 24, 6, 0);
const D10_UNLOCK = Date.UTC(2026, 6, 25, 6, 0);
const LAST_CALL_AT = D9_UNLOCK + 13 * 60 * 60 * 1000;

function mainDays(): DayLike[] {
  return [
    { index: 8, pool: 'main', unlockAt: D9_UNLOCK },
    { index: 9, pool: 'farewell', unlockAt: D10_UNLOCK },
  ];
}

/** A Day due for its snapshot and not yet stamped — the only state the
 *  scheduler writes into, so the pairs below differ ONLY by the freeze. */
function dueDay(): DayLike[] {
  return [{ index: 0, pool: 'main', unlockAt: 100 }];
}

const POOL = [{ id: 'prompt-1', status: 'active', pool: 'main' }];
const NOW_AFTER_UNLOCK = { now: () => 1_000 };

describe('eventClosedToPlay — the Admin-SDK mirror of the rules predicate', () => {
  it('closes on the archive AND on the quiesce, and defaults open', () => {
    expect(eventClosedToPlay({ status: 'archived' })).toBe(true);
    expect(eventClosedToPlay({ archiving: true })).toBe(true);
    expect(eventClosedToPlay({ status: 'active' })).toBe(false);
    expect(eventClosedToPlay({ archiving: false })).toBe(false);
    // Absent means OPEN, exactly as it does in firestore.rules — every Event
    // document written before these fields were consumed carries neither.
    expect(eventClosedToPlay({})).toBe(false);
    expect(eventClosedToPlay(undefined)).toBe(false);
  });
});

describe('stampDaySnapshot — no Day opens on a frozen Event', () => {
  it('stamps a due Day while the Event is open (the control)', async () => {
    const db = makeDb({ eventId: 'e', event: { days: dueDay() }, items: POOL });
    expect(await stampDaySnapshot(db, 'e', 0, NOW_AFTER_UNLOCK)).toBe('stamped');
    expect(db.readEvent().days?.[0].snapshotItemIds).toEqual(['prompt-1']);
  });

  it('refuses on an archived Event, and writes nothing', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), status: 'archived' },
      items: POOL,
    });
    expect(await stampDaySnapshot(db, 'e', 0, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
  });

  it('refuses during the quiesce too — that window is the whole point', async () => {
    // `archiving: true` leaves `status: 'active'`, so the sweep's own selection
    // query does NOT filter this Event out. Dealing a Day here would deal cards
    // into the exact window the client is snapshotting the roster from.
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), status: 'active', archiving: true },
      items: POOL,
    });
    expect(await stampDaySnapshot(db, 'e', 0, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
  });

  it('re-checks inside the transaction when the archive lands mid-flight', async () => {
    // The pre-read sees an OPEN Event; the archive commits before the
    // transaction's own read. Without the re-check this run stamps a Day onto a
    // record the rules have already made permanent.
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay() },
      items: POOL,
      onTransaction: (d) => d.archiveNow(),
    });
    expect(await stampDaySnapshot(db, 'e', 0, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
  });
});

describe('manualUnlockNow — being an Admin is not an exemption', () => {
  it('unlocks for an admin while the Event is open (the control)', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), admins: [ADMIN] },
      items: POOL,
    });
    expect(await manualUnlockNow(db, ADMIN, 'e', 0, NOW_AFTER_UNLOCK)).toBe('stamped');
  });

  it('refuses an admin unlock on an archived Event', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), admins: [ADMIN], status: 'archived' },
      items: POOL,
    });
    expect(await manualUnlockNow(db, ADMIN, 'e', 0, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
  });

  it('refuses an admin unlock during the quiesce', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), admins: [ADMIN], archiving: true },
      items: POOL,
    });
    expect(await manualUnlockNow(db, ADMIN, 'e', 0, NOW_AFTER_UNLOCK)).toBe('archived');
  });

  it('still denies a NON-admin first — the freeze does not soften the permission gate', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), admins: [ADMIN], status: 'archived' },
      items: POOL,
    });
    await expect(manualUnlockNow(db, 'stranger', 'e', 0, NOW_AFTER_UNLOCK)).rejects.toBeInstanceOf(
      UnlockPermissionError,
    );
  });
});

describe('resnapshotDayIfNoBoards — the one overwrite path stops at the freeze', () => {
  const recoverableDays = (): DayLike[] => [
    { index: 3, pool: 'main', unlockAt: 100, snapshotItemIds: ['old'] },
  ];

  it('re-stamps for an admin while the Event is open (the control)', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: recoverableDays(), admins: [ADMIN] },
      items: POOL,
    });
    expect(await resnapshotDayIfNoBoards(db, ADMIN, 'e', 3, NOW_AFTER_UNLOCK)).toBe(
      'resnapshotted',
    );
    expect(db.readEvent().days?.[0].snapshotItemIds).toEqual(['prompt-1']);
  });

  it('refuses on an archived Event, leaving the existing snapshot alone', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: recoverableDays(), admins: [ADMIN], status: 'archived' },
      items: POOL,
    });
    expect(await resnapshotDayIfNoBoards(db, ADMIN, 'e', 3, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toEqual(['old']);
  });

  it('re-checks inside the transaction when the archive lands mid-flight', async () => {
    // This core reads the whole active pool between its guard and its write, so
    // the window is wide — and it is the ONE path in the repo that overwrites an
    // existing snapshot rather than preserving it.
    const db = makeDb({
      eventId: 'e',
      event: { days: recoverableDays(), admins: [ADMIN] },
      items: POOL,
      onTransaction: (d) => d.archiveNow({ archiving: true }),
    });
    expect(await resnapshotDayIfNoBoards(db, ADMIN, 'e', 3, NOW_AFTER_UNLOCK)).toBe('archived');
    expect(db.readEvent().days?.[0].snapshotItemIds).toEqual(['old']);
  });
});

describe('runScheduledUnlock — the sweep skips a frozen Event entirely', () => {
  it('stamps a due Day on an open Event (the control)', async () => {
    const db = makeDb({ eventId: 'e', event: { days: dueDay() }, items: POOL });
    expect(await runScheduledUnlock(db, 'e', NOW_AFTER_UNLOCK)).toEqual({ stamped: 1 });
  });

  it('stamps nothing and posts nothing once the Event is archived', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), status: 'archived' },
      items: POOL,
    });
    expect(await runScheduledUnlock(db, 'e', NOW_AFTER_UNLOCK)).toEqual({ stamped: 0 });
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
    expect(db.moments()).toEqual([]);
  });

  it('stamps nothing during the quiesce, which its own selection query does not filter out', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: dueDay(), status: 'active', archiving: true },
      items: POOL,
    });
    expect(await runScheduledUnlock(db, 'e', NOW_AFTER_UNLOCK)).toEqual({ stamped: 0 });
    expect(db.readEvent().days?.[0].snapshotItemIds).toBeUndefined();
  });
});

describe('runFinaleBeats — no finale state lands on a frozen Event', () => {
  const roster = () => [
    { id: 'jess', uid: 'jess', displayName: 'Jess', bingoCount: 3, squaresMarked: 40, firstBingoAt: 10 },
    { id: 'rex', uid: 'rex', displayName: 'Rex', bingoCount: 1, squaresMarked: 44, firstBingoAt: 20 },
  ];

  it('posts the last-call Moment on an open Event (the control)', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome' },
      players: roster(),
    });
    await runFinaleBeats(db, 'e', { now: () => LAST_CALL_AT });
    expect(db.moments().map((m) => m.kind)).toEqual(['last_call']);
  });

  it('posts no system Moment on an archived Event', async () => {
    // A Moment posted after the freeze appends to a Feed the archive has already
    // preserved — the one thing an archived Feed promises it will not do.
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome', status: 'archived' },
      players: roster(),
    });
    await runFinaleBeats(db, 'e', { now: () => LAST_CALL_AT });
    expect(db.moments()).toEqual([]);
  });

  it('posts no system Moment during the quiesce', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome', archiving: true },
      players: roster(),
    });
    await runFinaleBeats(db, 'e', { now: () => LAST_CALL_AT });
    expect(db.moments()).toEqual([]);
  });

  it('withholds the Moment when the archive lands during the content build', async () => {
    // This beat is retried until the Moment actually lands, and the content
    // build between the guard and the write reads a whole roster — so the
    // freshest possible re-read immediately before the `set` is the tightest
    // guard a non-transactional write can have.
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome' },
      players: roster(),
    });
    const beats = runFinaleBeats(db, 'e', { now: () => LAST_CALL_AT });
    db.archiveNow();
    await beats;
    expect(db.moments()).toEqual([]);
  });

  it('freezes the standings on an open Event (the control)', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome' },
      players: roster(),
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK });
    expect(db.readEvent().frozenAt).toBe(D10_UNLOCK);
    expect(db.readEvent().mostLovedPhoto).toBeDefined();
  });

  it('stamps no frozenAt and computes no award on an archived Event', async () => {
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome', status: 'archived' },
      players: roster(),
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK });
    expect(db.readEvent().frozenAt).toBeUndefined();
    expect(db.readEvent().mostLovedPhoto).toBeUndefined();
  });

  it('re-checks the freeze inside its own transaction when the archive lands mid-flight', async () => {
    // The award transaction reads every Proof and every Heart before it writes,
    // so its window is the widest in the finale. Without the in-transaction
    // re-check it would rebuild an ostensibly frozen award from moderation state
    // the archive has already moved past.
    const db = makeDb({
      eventId: 'e',
      event: { days: mainDays(), timezone: 'Europe/Rome' },
      players: roster(),
      onTransaction: (d) => d.archiveNow(),
    });
    await runFinaleBeats(db, 'e', { now: () => D10_UNLOCK });
    expect(db.readEvent().frozenAt).toBeUndefined();
    expect(db.readEvent().mostLovedPhoto).toBeUndefined();
  });
});
