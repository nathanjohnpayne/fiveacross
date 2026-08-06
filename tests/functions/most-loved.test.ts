import { describe, it, expect } from 'vitest';
import {
  finaleTimes,
  finaleActions,
  runFinaleBeats,
  type AdminFirestore,
  type DayLike,
  type EventLike,
} from '../../functions/src/unlockDay';
import type { MostLovedPhotoAward } from '../../src/domainTypes';

// specs/most-loved-photo.md, beat layer (#534/#560): the third finale beat —
// compute + persist the Most-Loved Photo award at the standings freeze,
// alongside `frozenAt`, exactly once, against the SCHEDULED cutoff. Same DI'd
// in-memory Firestore fake posture as d15-scheduler-unlock.test.ts (extended
// with proofs + hearts backing); no live runtime. Runs via `npm run
// test:functions`. The expected `console.error` lines from the isolation case
// are the beat's own best-effort logging, not failures.

// --- In-memory Firestore fake (proofs/hearts-aware variant) ---------------------

interface StoredDoc {
  id: string;
  [k: string]: unknown;
}

function makeDb(seed: {
  eventId: string;
  event: EventLike;
  proofs?: StoredDoc[];
  hearts?: StoredDoc[];
  moments?: StoredDoc[];
  players?: Array<Record<string, unknown>>;
}): AdminFirestore & {
  readEvent(): EventLike & { mostLovedPhoto?: MostLovedPhotoAward };
  moments(): StoredDoc[];
  hearts: StoredDoc[];
  proofs: StoredDoc[];
} {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    [`events/${seed.eventId}`]: { ...seed.event } as Record<string, unknown>,
  };
  const players = [...(seed.players ?? [])];
  const proofs = [...(seed.proofs ?? [])];
  const hearts = [...(seed.hearts ?? [])];
  const moments = [...(seed.moments ?? [])];
  let momentSeq = moments.length;

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
      path.endsWith('/moments')
        ? (moments as Array<Record<string, unknown>>)
        : path.endsWith('/players')
          ? players
          : path.endsWith('/proofs')
            ? (proofs as Array<Record<string, unknown>>)
            : path.endsWith('/hearts')
              ? (hearts as Array<Record<string, unknown>>)
              : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
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
            createTime: (() => {
              const millis = Number(row.serverCreatedAt ?? row.createdAt);
              const seconds = Number(row.serverCreatedAtSeconds ?? Math.floor(millis / 1000));
              const nanoseconds = Number(
                row.serverCreatedAtNanoseconds ?? Math.round((millis - seconds * 1000) * 1_000_000),
              );
              return {
                // Matches Firestore Timestamp#toMillis: deliberately floored,
                // so the test below proves the production mapper uses the
                // seconds/nanoseconds fields instead for the cutoff predicate.
                toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1_000_000),
                seconds,
                nanoseconds,
              };
            })(),
          })),
        };
      },
      doc(id?: string) {
        if (path.endsWith('/moments')) {
          const mid = id ?? `m${++momentSeq}`;
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
    return api;
  };

  return {
    doc: (path: string) => docRef(path),
    collection: (path: string) => collectionRef(path),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
        update: (ref: { set(d: Record<string, unknown>): Promise<unknown> }, data: Record<string, unknown>) => {
          // merge onto the current doc (the surface only ever updates the event doc)
          const current = (docs[`events/${seed.eventId}`] ?? {}) as Record<string, unknown>;
          docs[`events/${seed.eventId}`] = { ...current, ...data };
          void ref;
        },
      };
      return fn(tx);
    },
    readEvent: () =>
      docs[`events/${seed.eventId}`] as unknown as EventLike & { mostLovedPhoto?: MostLovedPhotoAward },
    moments: () => moments,
    hearts,
    proofs,
  };
}

// Clock anchors (ms epoch); only the ordering matters.
const D9_UNLOCK = Date.UTC(2026, 7, 8, 15, 0);
const D10_UNLOCK = Date.UTC(2026, 7, 9, 18, 0); // the closing Day's unlockAt == the freeze cutoff

function mainDays(): DayLike[] {
  return [
    { index: 2, pool: 'main', unlockAt: D9_UNLOCK },
    { index: 3, pool: 'farewell', unlockAt: D10_UNLOCK },
  ];
}

function proof(id: string, over: Record<string, unknown> = {}): StoredDoc {
  return {
    id,
    uid: `owner-${id}`,
    displayName: `Owner ${id}`,
    type: 'photo',
    status: 'active',
    reportCount: 0,
    createdAt: D9_UNLOCK + 1000,
    itemText: `Prompt ${id}`,
    dayIndex: 2,
    ...over,
  };
}

function heart(uid: string, targetId: string, targetCreatedAt: number, over: Record<string, unknown> = {}): StoredDoc {
  return {
    id: `${uid}_proof_${targetId}`,
    uid,
    targetKind: 'proof',
    targetId,
    targetCreatedAt,
    createdAt: D10_UNLOCK - 60_000,
    ...over,
  };
}

describe('finaleActions — the computeMostLoved beat decision (#560)', () => {
  const t = finaleTimes(mainDays())!;
  const base = { lastCallPosted: true, podiumPosted: true, mostLovedComputed: false };

  it('fires at/after the farewell unlock only while the award is not yet persisted', () => {
    expect(finaleActions(t, t.farewellUnlockAt, base).computeMostLoved).toBe(true);
    expect(finaleActions(t, t.farewellUnlockAt - 1, base).computeMostLoved).toBe(false);
    expect(
      finaleActions(t, t.farewellUnlockAt, { ...base, mostLovedComputed: true }).computeMostLoved,
    ).toBe(false);
  });

  it('is COUPLED to the freeze flip: an already-frozen Event never reconstructs an award from later moderation state', () => {
    const d = finaleActions(t, t.farewellUnlockAt + 60_000, {
      frozenAt: t.farewellUnlockAt,
      lastCallPosted: true,
      podiumPosted: true,
      mostLovedComputed: false,
    });
    expect(d.freeze).toBe(false); // already frozen — never re-freeze
    expect(d.computeMostLoved).toBe(false); // historical eligibility was not snapshotted
  });
});

describe('runFinaleBeats — the Most-Loved award beat through the write path (#560)', () => {
  it('(a) before the farewell unlock it writes nothing', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1')],
      hearts: [heart('fan-1', 'p1', D9_UNLOCK + 1000)],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK - 1 });
    expect(db.readEvent().frozenAt).toBeUndefined();
    expect(db.readEvent().mostLovedPhoto).toBeUndefined();
  });

  it('(b) at the freeze, ONE late run stamps frozenAt AND the award in the same sweep, cutoff = the SCHEDULED instant', async () => {
    const runClock = D10_UNLOCK + 7 * 60_000; // the */15 tick lands late
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1', { createdAt: D9_UNLOCK + 1000 }), proof('p2', { createdAt: D9_UNLOCK + 2000 })],
      hearts: [
        heart('fan-1', 'p1', D9_UNLOCK + 1000),
        heart('fan-2', 'p1', D9_UNLOCK + 1000),
        heart('fan-1', 'p2', D9_UNLOCK + 2000),
      ],
    });
    await runFinaleBeats(db, 'e1', { now: () => runClock });
    // The one sweep froze AND persisted the award ("alongside frozenAt").
    expect(db.readEvent().frozenAt).toBe(D10_UNLOCK);
    expect(db.readEvent().mostLovedPhoto).toEqual({
      winners: [
        {
          proofId: 'p1',
          uid: 'owner-p1',
          displayName: 'Owner p1',
          promptText: 'Prompt p1',
          dayIndex: 2,
          proofCreatedAt: D9_UNLOCK + 1000,
        },
      ],
      winnerCount: 1,
      heartCount: 2,
      // The SCHEDULED freeze instant, never the run clock (Codex #228 rule).
      frozenAt: D10_UNLOCK,
      computedAt: runClock,
    });
  });

  it('(c) retry idempotence: a second run never rewrites, even when hearts moved in between', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1'), proof('p2', { createdAt: D9_UNLOCK + 2000 })],
      hearts: [heart('fan-1', 'p1', D9_UNLOCK + 1000)],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK });
    const first = JSON.parse(JSON.stringify(db.readEvent().mostLovedPhoto)) as MostLovedPhotoAward;
    expect(first.winners.map((w) => w.proofId)).toEqual(['p1']);

    // Hearts mutate between runs: p2 overtakes p1 — and it must not matter.
    db.hearts.push(
      heart('fan-2', 'p2', D9_UNLOCK + 2000, { createdAt: D10_UNLOCK - 30_000 }),
      heart('fan-3', 'p2', D9_UNLOCK + 2000, { createdAt: D10_UNLOCK - 20_000 }),
    );
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 15 * 60_000 });
    expect(db.readEvent().mostLovedPhoto).toEqual(first); // byte-identical — the frozen result NEVER recomputes
  });

  it('(d) zero eligible hearts persists the EXPLICIT no-award record, and a later heart cannot mint a late award', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1')],
      hearts: [],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK });
    expect(db.readEvent().mostLovedPhoto).toEqual({
      winners: [],
      winnerCount: 0,
      heartCount: 0,
      frozenAt: D10_UNLOCK,
      computedAt: D10_UNLOCK,
    });

    // A heart arrives after the compute — even BACKDATED inside the window, the
    // absent-field guard (not the cutoff) is what keeps the record frozen.
    db.hearts.push(heart('fan-1', 'p1', D9_UNLOCK + 1000, { createdAt: D10_UNLOCK - 60_000 }));
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 15 * 60_000 });
    expect(db.readEvent().mostLovedPhoto).toEqual({
      winners: [],
      winnerCount: 0,
      heartCount: 0,
      frozenAt: D10_UNLOCK,
      computedAt: D10_UNLOCK,
    });
  });

  it('(e) hearts after the scheduled cutoff are excluded; a heart AT the cutoff counts', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1'), proof('p2', { createdAt: D9_UNLOCK + 2000 })],
      hearts: [
        // Landed after the scheduled freeze but before the late run — excluded.
        heart('fan-1', 'p1', D9_UNLOCK + 1000, { createdAt: D10_UNLOCK + 1 }),
        // Exactly at the cutoff — counts (<= boundary).
        heart('fan-2', 'p2', D9_UNLOCK + 2000, { createdAt: D10_UNLOCK }),
      ],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 10 * 60_000 });
    const award = db.readEvent().mostLovedPhoto!;
    expect(award.winners.map((w) => w.proofId)).toEqual(['p2']);
    expect(award.heartCount).toBe(1);
  });

  it('(f) excludes a post-freeze heart that backdates its client timestamp into the allowed clock-skew window', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1'), proof('p2', { createdAt: D9_UNLOCK + 2000 })],
      hearts: [
        // The Firestore rules permit `createdAt` up to 24h behind request time
        // for clock drift. It therefore cannot define a hard server-side
        // standings boundary; the snapshot's server createTime can.
        heart('fan-1', 'p1', D9_UNLOCK + 1000, {
          createdAt: D10_UNLOCK - 1,
          serverCreatedAt: D10_UNLOCK + 1,
        }),
        heart('fan-2', 'p2', D9_UNLOCK + 2000, { serverCreatedAt: D10_UNLOCK }),
      ],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 10 * 60_000 });
    const award = db.readEvent().mostLovedPhoto!;
    expect(award.winners.map((w) => w.proofId)).toEqual(['p2']);
    expect(award.heartCount).toBe(1);
  });

  it('(f2) excludes a Heart one nanosecond after the cutoff, despite Timestamp#toMillis rounding it down', async () => {
    const cutoffSeconds = Math.floor(D10_UNLOCK / 1000);
    const cutoffNanoseconds = (D10_UNLOCK - cutoffSeconds * 1000) * 1_000_000;
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1'), proof('p2', { createdAt: D9_UNLOCK + 2000 })],
      hearts: [
        heart('fan-1', 'p1', D9_UNLOCK + 1000, {
          createdAt: D10_UNLOCK - 1,
          serverCreatedAtSeconds: cutoffSeconds,
          serverCreatedAtNanoseconds: cutoffNanoseconds + 1,
        }),
        heart('fan-2', 'p2', D9_UNLOCK + 2000, {
          serverCreatedAtSeconds: cutoffSeconds,
          serverCreatedAtNanoseconds: cutoffNanoseconds,
        }),
      ],
    });

    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 10 * 60_000 });
    const award = db.readEvent().mostLovedPhoto!;
    expect(award.winners.map((w) => w.proofId)).toEqual(['p2']);
    expect(award.heartCount).toBe(1);
  });

  it('(g) an award-snapshot read failure keeps the freeze coupled to the award, while the podium still lands', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays() },
      proofs: [proof('p1')],
      hearts: [heart('fan-1', 'p1', D9_UNLOCK + 1000)],
    });
    const failing = {
      ...db,
      collection: (path: string) => {
        if (path.endsWith('/proofs')) throw new Error('unavailable');
        return db.collection(path);
      },
    } as typeof db;

    await runFinaleBeats(failing, 'e1', { now: () => D10_UNLOCK });
    // The atomic freeze cannot leave a retry to rebuild the award from later
    // proof visibility, moderation settings, or ban-roster state.
    expect(db.readEvent().frozenAt).toBeUndefined();
    expect(db.moments().filter((m) => m.kind === 'podium')).toHaveLength(1); // podium too
    expect(db.readEvent().mostLovedPhoto).toBeUndefined();

    // The next healthy tick retries the complete freeze snapshot.
    const retryClock = D10_UNLOCK + 15 * 60_000;
    await runFinaleBeats(db, 'e1', { now: () => retryClock });
    const award = db.readEvent().mostLovedPhoto!;
    expect(award.winners.map((w) => w.proofId)).toEqual(['p1']);
    expect(db.readEvent().frozenAt).toBe(D10_UNLOCK);
    expect(award.frozenAt).toBe(D10_UNLOCK); // still the scheduled cutoff, not the retry clock
    expect(award.computedAt).toBe(retryClock);
  });

  it('(h) the persisted award survives later proof-moderation and ban-roster changes', async () => {
    const db = makeDb({
      eventId: 'e1',
      event: { days: mainDays(), settings: { reportHideThreshold: 5 } },
      proofs: [proof('p1')],
      hearts: [heart('fan-1', 'p1', D9_UNLOCK + 1000)],
    });
    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK });
    const first = JSON.parse(JSON.stringify(db.readEvent().mostLovedPhoto)) as MostLovedPhotoAward;

    // These are the mutable values that used to alter a delayed award retry.
    db.proofs[0].status = 'hidden';
    db.hearts[0].uid = 'banned-fan';
    (db.readEvent().settings as { reportHideThreshold?: number }).reportHideThreshold = 1;
    db.readEvent().bannedUids = ['owner-p1', 'banned-fan'];

    await runFinaleBeats(db, 'e1', { now: () => D10_UNLOCK + 15 * 60_000 });
    expect(db.readEvent().mostLovedPhoto).toEqual(first);
  });
});
