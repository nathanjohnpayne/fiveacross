import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  podiumEmailInputFor,
  podiumMomentPath,
  runPodiumEmailSweep,
  sendPodiumEmailForEvent,
  type PodiumEmailInput,
} from '../../functions/src/podiumEmail';
import type { DailyEmailFirestore } from '../../functions/src/dailyEmail';
import { shouldSendPodiumTo } from '../../functions/src/emailOptOut';
import {
  buildPodiumEmailModel,
  subjectSafeName,
} from '../../functions/src/podiumEmailContent';
import {
  renderPodiumEmailHtml,
  renderPodiumEmailText,
} from '../../functions/src/podiumEmailTemplate';
import type { EmailPayload } from '../../functions/src/email';

// --- ① The suppression rule, on its own -----------------------------------------

describe('shouldSendPodiumTo (#1192)', () => {
  it('sends to an opted-in participant who has not been sent it', () => {
    expect(shouldSendPodiumTo({ optedOut: false })).toBe(true);
  });

  it('refuses an opted-out participant', () => {
    expect(shouldSendPodiumTo({ optedOut: true })).toBe(false);
  });

  it('refuses a participant already sent it, whatever the timestamp', () => {
    expect(shouldSendPodiumTo({ optedOut: false, podiumEmailSentAt: 1 })).toBe(false);
    expect(shouldSendPodiumTo({ optedOut: false, podiumEmailSentAt: Date.now() })).toBe(false);
  });

  it('refuses a participant with no prefs doc — no unsubscribe, no email', () => {
    expect(shouldSendPodiumTo(null)).toBe(false);
  });

  it('is INDEPENDENT of the daily card’s marker, in both directions', () => {
    // The whole reason `podiumEmailSentAt` exists rather than reusing
    // `lastSentDayIndex`: the farewell Day's card send must not suppress the
    // winner mail, and the winner mail must not suppress a card.
    expect(shouldSendPodiumTo({ optedOut: false, lastSentDayIndex: 9 } as never)).toBe(true);
  });
});

// --- ③ The send, end to end -----------------------------------------------------

type Docs = Record<string, Record<string, unknown>>;

/** The same in-memory admin-SDK stand-in the daily-email suite uses — doc
 *  get/set/create and flat collection queries. */
function makeDb(seed: Docs): DailyEmailFirestore & { docs: Docs } {
  const docs: Docs = { ...seed };
  const snapshotOf = (path: string) => ({
    exists: docs[path] !== undefined,
    id: path.split('/').pop() ?? '',
    data: () => docs[path],
  });
  const docRef = (path: string) => ({
    path,
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      docs[path] = options?.merge ? { ...(docs[path] ?? {}), ...data } : { ...data };
      return undefined;
    },
    create: async (data: Record<string, unknown>) => {
      if (docs[path] !== undefined) throw new Error('ALREADY_EXISTS');
      docs[path] = { ...data };
      return undefined;
    },
  });
  const query = (path: string, filters: Array<[string, unknown]>, cap?: number) => ({
    where: (field: string, _op: string, value: unknown) =>
      query(path, [...filters, [field, value]], cap),
    limit: (count: number) => query(path, filters, count),
    get: async () => {
      const matched = Object.keys(docs)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map(snapshotOf)
        .filter((s) => filters.every(([field, value]) => (s.data() ?? {})[field] === value));
      return { docs: cap === undefined ? matched : matched.slice(0, cap) };
    },
  });
  const runTransaction = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> =>
    fn({
      // The Admin SDK's `Transaction.get` takes a DocumentReference OR a Query,
      // and the completion stamp reads the players collection inside the
      // transaction. A doc ref carries `path`; a query carries only `get`.
      get: async (ref: { path?: string; get?: () => Promise<unknown> }) =>
        typeof ref.path === 'string' ? snapshotOf(ref.path) : await ref.get!(),
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
        docs[ref.path] = options?.merge ? { ...(docs[ref.path] ?? {}), ...data } : { ...data };
      },
    } as never);
  return { doc: docRef, collection: (path: string) => query(path, []), runTransaction, docs };
}

const RANKED = [
  { uid: 'zac', displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124, firstBingoAt: 800 },
  { uid: 'logan', displayName: 'Logan Murdock', bingoCount: 14, squaresMarked: 117, firstBingoAt: 200 },
  { uid: 'nathan', displayName: 'Nathan Payne', bingoCount: 13, squaresMarked: 110, firstBingoAt: 900 },
];

const input = (over: Partial<PodiumEmailInput> = {}): PodiumEmailInput => ({
  event: { name: 'Atlantis Med—Trieste to Barcelona', settings: { dailyEmailEnabled: true } },
  podium: {
    champion: { uid: 'zac', displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124 },
    firstBingo: { uid: 'logan', displayName: 'Logan Murdock', at: 200 },
    dailyHonors: [{ dayIndex: 1, uid: 'logan', displayName: 'Logan Murdock', at: 200 }],
  },
  ranked: RANKED,
  mostLoved: {
    winners: [
      {
        proofId: 'p1',
        uid: 'ido',
        displayName: 'Ido Marcus',
        promptText: 'Mirror-hall selfie',
        dayIndex: 6,
        proofCreatedAt: 500,
      },
    ],
    winnerCount: 1,
    heartCount: 31,
    frozenAt: 2_000,
    computedAt: 2_050,
  },
  boardWasEmpty: false,
  closingDay: {
    themeId: 'so-long-farewell',
    dayNumber: 10,
    dayCount: 10,
    dateLabel: 'Friday, Jul 24',
    placeLabel: '🇪🇸 Barcelona',
  },
  honorDayLabels: { 1: 'Day 2 in 🇭🇷 Split' },
  photoDayLabel: 'Day 7 · 🇮🇹 Rome (Civitavecchia)',
  ...over,
});

const seed = (settings: Record<string, unknown> = { dailyEmailEnabled: true }): Docs => ({
  'events/med-2026': { name: 'Atlantis Med—Trieste to Barcelona', status: 'active', settings },
  // The award's hero Proof, live and Feed-visible. The pre-send guard re-verifies
  // it, so a fixture without it is asserting the photo was taken down.
  'events/med-2026/proofs/p1': {
    uid: 'ido',
    displayName: 'Ido Marcus',
    type: 'photo',
    status: 'active',
    reportCount: 0,
    createdAt: 500,
    itemText: 'Mirror-hall selfie',
    dayIndex: 6,
  },
  'hostnames/gaycruisebingo.com': {
    eventId: 'med-2026',
    canonicalHost: 'gaycruisebingo.com',
    edition: 'gcb',
    status: 'active',
    isCanonical: true,
  },
});

const baseDeps = () => ({
  from: 'Gay Cruise Bingo <bingo@example.com>',
  appBaseUrl: 'https://fallback.example.com',
  unsubscribeBaseUrl: 'https://fn.example.com/emailUnsubscribe',
  getEmailForUid: async (uid: string) => `${uid}@example.com`,
  mintToken: () => 'tok-fixed',
  pacingMs: 0,
  now: () => 3_000,
});

type Captured = EmailPayload & { idempotencyKey: string };

const run = async (
  docs: Docs,
  over: Record<string, unknown> = {},
  beat: Partial<PodiumEmailInput> = {},
) => {
  const sent: Captured[] = [];
  const db = makeDb(docs);
  const result = await sendPodiumEmailForEvent(db, 'med-2026', input(beat), {
    ...baseDeps(),
    send: async (args) => {
      sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
      return true;
    },
    ...over,
  });
  return { result, sent, db };
};

describe('sendPodiumEmailForEvent (#1192)', () => {
  it('mails every opted-in participant exactly once', async () => {
    const { result, sent } = await run(seed());
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.drained).toBe(true);
    expect(sent.map((s) => s.to[0]).sort()).toEqual([
      'logan@example.com',
      'nathan@example.com',
      'zac@example.com',
    ]);
  });

  it('sends NOTHING on a repeated run — the acceptance criterion', async () => {
    const docs = seed();
    const first = await run(docs);
    expect(first.result.sent).toBe(3);
    // Same doc store, so every recipient now carries `podiumEmailSentAt`.
    const second = await sendPodiumEmailForEvent(first.db, 'med-2026', input(), {
      ...baseDeps(),
      send: async () => {
        throw new Error('a second run must not reach the transport');
      },
    });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.drained).toBe(true);
  });

  it('stamps podiumEmailSentAt, not lastSentDayIndex', async () => {
    const { db } = await run(seed());
    const prefs = db.docs['events/med-2026/emailPrefs/zac'];
    expect(prefs.podiumEmailSentAt).toBe(3_000);
    expect(prefs.lastSentDayIndex).toBeUndefined();
  });

  it('keys the transport per Event and recipient, with no Day in the key', async () => {
    const { sent } = await run(seed());
    expect(sent.map((s) => s.idempotencyKey).sort()).toEqual([
      'podium-email/med-2026/logan',
      'podium-email/med-2026/nathan',
      'podium-email/med-2026/zac',
    ]);
  });

  it('skips an opted-out participant and mails the rest', async () => {
    const docs = seed();
    docs['events/med-2026/emailPrefs/logan'] = { optedOut: true, token: 'tok-fixed' };
    const { result, sent } = await run(docs);
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(sent.some((s) => s.to[0] === 'logan@example.com')).toBe(false);
  });

  it('skips a participant with no verified address', async () => {
    const { result } = await run(seed(), {
      getEmailForUid: async (uid: string) => (uid === 'nathan' ? null : `${uid}@example.com`),
    });
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('mails nothing when the Event never enabled the daily email', async () => {
    const { result, sent } = await run(seed({ dailyEmailEnabled: false }), {}, {
      event: { name: 'Atlantis Med', settings: { dailyEmailEnabled: false } },
    });
    expect(result.reason).toBe('disabled');
    expect(sent).toEqual([]);
    // NOT drained: the toggle is reversible, so nothing durable may record this
    // Event as finished while it is merely switched off.
    expect(result.drained).toBe(false);
  });

  it('reports NOT drained when the transport refuses, so the next sweep retries', async () => {
    const { result, db } = await run(seed(), { send: async () => false });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.drained).toBe(false);
    // And nobody is marked, so the retry actually mails them.
    expect(db.docs['events/med-2026/emailPrefs/zac'].podiumEmailSentAt).toBeUndefined();
  });

  it('logs a recipient failure with a sanitized code, never the address', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run(seed(), {
        send: async () => {
          throw new Error('smtp exploded for zac@example.com');
        },
      });
      const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('@example.com');
      expect(logged).not.toContain('smtp exploded');
    } finally {
      spy.mockRestore();
    }
  });

  it('honours the recipient ceiling and reports NOT drained', async () => {
    const { result } = await run(seed(), { maxRecipients: 2 });
    expect(result.sent).toBe(2);
    expect(result.drained).toBe(false);
  });
});

describe('the drain verdict distinguishes permanent from transient (#1192, Codex P1)', () => {
  it('keeps the run UNDRAINED when an address lookup throws, and retries it', async () => {
    // An Auth outage must not look like "no address on file". Before the fix
    // both landed in `skipped`, which the verdict ignored — so a full outage
    // reported drained, stamped the marker, and nobody was ever mailed.
    const { result } = await run(seed(), {
      getEmailForUid: async () => {
        throw new Error('auth/internal-error');
      },
    });
    expect(result.sent).toBe(0);
    expect(result.blocked).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.drained).toBe(false);
  });

  it('keeps a participant with genuinely no address as a permanent skip', async () => {
    const { result } = await run(seed(), { getEmailForUid: async () => null });
    expect(result.skipped).toBe(3);
    expect(result.blocked).toBe(0);
    // Nothing is owed — no retry would find an address.
    expect(result.drained).toBe(true);
  });

  it('keeps the run UNDRAINED when the prefs doc cannot be read or minted', async () => {
    const docs = seed();
    const db = makeDb(docs);
    const broken = {
      ...db,
      doc: (path: string) =>
        path.includes('/emailPrefs/')
          ? {
              get: async () => {
                throw new Error('UNAVAILABLE');
              },
              set: async () => undefined,
              create: async () => {
                throw new Error('UNAVAILABLE');
              },
            }
          : db.doc(path),
    } as unknown as typeof db;
    const result = await sendPodiumEmailForEvent(broken, 'med-2026', input(), {
      ...baseDeps(),
      send: async () => {
        throw new Error('an undecidable recipient must not be mailed');
      },
    });
    expect(result.blocked).toBe(3);
    expect(result.drained).toBe(false);
  });
});

describe('the ⭐ line dates the honour by its own instant (#1192, Codex P2)', () => {
  it('names the QUALIFYING Day, not the holder’s earliest pinned honour', async () => {
    // The holder also took an earlier TUTORIAL Day. The Event-wide honour
    // excludes Tutorial Days, so that pin is ineligible for it — dating the
    // honour to Day 1 would name a morning that did not win it.
    const model = modelFor('gcb', {
      podium: {
        champion: PAYLOAD.champion,
        firstBingo: { uid: 'logan', displayName: 'Logan Murdock', at: 200 },
        dailyHonors: [
          { dayIndex: 0, uid: 'logan', displayName: 'Logan Murdock', at: 50 },
          { dayIndex: 1, uid: 'logan', displayName: 'Logan Murdock', at: 200 },
        ],
      },
      honorDayLabels: { 0: 'Day 1 in 🇮🇹 Trieste', 1: 'Day 2 in 🇭🇷 Split' },
    });
    expect(model.starLine).toContain('Day 2 in 🇭🇷 Split');
    expect(model.starLine).not.toContain('Trieste');
  });

  it('drops the Day qualifier rather than guessing when no honour matches', () => {
    const model = modelFor('gcb', {
      podium: { champion: PAYLOAD.champion, firstBingo: { uid: 'ghost', displayName: 'Ghost', at: 7 }, dailyHonors: [] },
    });
    expect(model.starLine).toBe('Ghost took the cruise-wide First to BINGO.');
  });
});

describe('the preheader promises only what the email carries (#1192, Codex P2)', () => {
  it('names both honours when both render', () => {
    expect(modelFor('gcb').preheader).toBe(
      'The podium is in—see who took the ⭐ and the Most-Loved Photo.',
    );
  });

  it('names only the ⭐ when there is no eligible photo', () => {
    expect(modelFor('gcb', { mostLoved: null }).preheader).toBe(
      'The podium is in—see who took the ⭐.',
    );
  });

  it('names only the photo when no bingo qualified for the ⭐', () => {
    const model = modelFor('gcb', {
      podium: { champion: PAYLOAD.champion, firstBingo: null, dailyHonors: [] },
    });
    expect(model.preheader).toBe('The podium is in—see who took the Most-Loved Photo.');
  });

  it('claims neither on an empty board, in the Edition’s own noun', () => {
    const bare = { podium: { champion: null, firstBingo: null, dailyHonors: [] }, mostLoved: null, ranked: [] };
    expect(modelFor('gcb', bare).preheader).toBe("The final standings are in—that's the cruise.");
    expect(modelFor('vacay', bare).preheader).toBe("The final standings are in—that's the trip.");
  });
});

// --- ③b The due check: the Moment is the source ---------------------------------

const PAYLOAD = {
  champion: { uid: 'zac', displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124 },
  firstBingo: { uid: 'logan', displayName: 'Logan Murdock', at: 200 },
  dailyHonors: [{ dayIndex: 1, uid: 'logan', displayName: 'Logan Murdock', at: 200 }],
};

/** An Event past its podium: roster, hostname, schedule and the posted Moment. */
/** A live, Feed-visible Proof for an award winner. The email re-joins the frozen
 *  winner against this at render time (the "hidden later" rule), so a fixture
 *  that omits it is asserting the photo was deleted. */
const visibleProof = (w: Record<string, unknown>): Record<string, unknown> => ({
  uid: w.uid,
  displayName: w.displayName,
  type: 'photo',
  status: 'active',
  reportCount: 0,
  createdAt: w.proofCreatedAt,
  itemText: w.promptText,
  dayIndex: w.dayIndex,
});

const seedDue = (over: Record<string, unknown> = {}, momentOver?: Record<string, unknown>): Docs => withWinnerProofs({
  ...seed(),
  'events/med-2026': {
    name: 'Atlantis Med—Trieste to Barcelona',
    status: 'active',
    settings: { dailyEmailEnabled: true },
    // The freeze stamp: its presence is what says the Most-Loved award has been
    // decided, because one transaction writes both.
    frozenAt: 5_000,
    days: [
      { index: 0, date: '2026-07-15', pool: 'embark', tutorial: true, place: 'Trieste', placeEmoji: '🇮🇹' },
      { index: 1, date: '2026-07-16', pool: 'main', tutorial: false, place: 'Split', placeEmoji: '🇭🇷' },
      { index: 2, date: '2026-07-24', pool: 'farewell', tutorial: true, place: 'Barcelona', placeEmoji: '🇪🇸', theme: 'so-long-farewell' },
    ],
    ...over,
  },
  'events/med-2026/players/zac': { displayName: 'Zacaria Arab', bingoCount: 16, squaresMarked: 124, firstBingoAt: 800 },
  'events/med-2026/players/logan': { displayName: 'Logan Murdock', bingoCount: 14, squaresMarked: 117, firstBingoAt: 200 },
  'events/med-2026/players/nathan': { displayName: 'Nathan Payne', bingoCount: 13, squaresMarked: 110, firstBingoAt: 900 },
  [podiumMomentPath('med-2026')]: {
    kind: 'podium',
    dayIndex: 2,
    podium: PAYLOAD,
    ...(momentOver ?? {}),
  },
});

/** Seed a live Proof for every winner the fixture's award names, so the default
 *  case exercises a surviving photo. A test that wants the hidden-later path
 *  deletes the proof doc it cares about. */
function withWinnerProofs(docs: Docs): Docs {
  const award = docs['events/med-2026']?.mostLovedPhoto as
    | { winners?: Array<Record<string, unknown>> }
    | undefined;
  for (const w of award?.winners ?? []) {
    docs[`events/med-2026/proofs/${w.proofId as string}`] = visibleProof(w);
  }
  return docs;
}

describe('podiumEmailInputFor — the due check (#1192)', () => {
  it('is due once the podium Moment carries a payload', async () => {
    const got = await podiumEmailInputFor(makeDb(seedDue()), 'med-2026');
    expect(got.due).toBe(true);
  });

  it('takes the champion and ⭐ from the MOMENT, not from the live roster', async () => {
    // The property the whole shape exists for: a post-freeze edit to a
    // client-authoritative Player document cannot move the honours, because they
    // are read off the immutable Moment. Here the roster is rewritten to make
    // Nathan the runaway leader; the email still names the Moment's champion.
    const docs = seedDue();
    docs['events/med-2026/players/nathan'] = {
      displayName: 'Nathan Payne (edited)',
      bingoCount: 99,
      squaresMarked: 999,
      firstBingoAt: 1,
    };
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.podium.champion).toEqual(PAYLOAD.champion);
    expect(got.input.podium.firstBingo).toEqual(PAYLOAD.firstBingo);
    // …while the RANKING, which the Moment does not carry, does follow the
    // roster. That residual is stated in the spec rather than hidden.
    expect(got.input.ranked[0].uid).toBe('nathan');
  });

  it('withholds a currently-banned champion and ⭐ holder from the email', async () => {
    // The Moment keeps the unfiltered record — a ban is reversible and must not
    // erase finale data — but this email is a rendered view and hides the row.
    const docs = seedDue({ bannedUids: ['zac', 'logan'] });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.podium.champion).toBeNull();
    expect(got.input.podium.firstBingo).toBeNull();
    expect(got.input.podium.dailyHonors).toEqual([]);
    // And the banned players are not recipients either.
    expect(got.input.ranked.map((p) => p.uid)).toEqual(['nathan']);
  });

  it('labels the ⭐ Day and the closing Day from the schedule', async () => {
    const got = await podiumEmailInputFor(makeDb(seedDue()), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.honorDayLabels[1]).toBe('Day 2 in 🇭🇷 Split');
    expect(got.input.closingDay).toMatchObject({
      themeId: 'so-long-farewell',
      dayNumber: 3,
      dayCount: 3,
      dateLabel: 'Friday, Jul 24',
      placeLabel: '🇪🇸 Barcelona',
    });
  });

  it.each([
    ['no-podium', (d: Docs) => { delete d[podiumMomentPath('med-2026')]; }],
    ['already-sent', (d: Docs) => { d['events/med-2026'].podiumEmailAt = 1; }],
    ['archived', (d: Docs) => { d['events/med-2026'].status = 'archived'; }],
    ['disabled', (d: Docs) => { d['events/med-2026'].settings = { dailyEmailEnabled: false }; }],
  ])('is not due: %s', async (reason, mutate) => {
    const docs = seedDue();
    mutate(docs);
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    expect(got).toEqual({ due: false, reason });
  });

  it('is not due when the Moment landed without its payload', async () => {
    // The beat posts a minimal Moment when its content build fails, and does not
    // retry a landed Moment — so this is terminal, and silence is the answer.
    const docs = seedDue({}, { podium: undefined });
    delete (docs[podiumMomentPath('med-2026')] as Record<string, unknown>).podium;
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    expect(got).toEqual({ due: false, reason: 'no-payload' });
  });

  it('is not due for a CLOSING Event, whose status is still active', async () => {
    // The archive's quiesce deliberately leaves `status` alone, so the guard has
    // to read `archiving` too.
    const got = await podiumEmailInputFor(makeDb(seedDue({ archiving: true })), 'med-2026');
    expect(got).toEqual({ due: false, reason: 'archived' });
  });
});

describe('runPodiumEmailSweep (#1192)', () => {
  it('mails a due Event, stamps podiumEmailAt with a MERGE, and skips it next time', async () => {
    const db = makeDb(seedDue());
    const sent: Captured[] = [];
    const send = async (args: EmailPayload) => {
      sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
      return true;
    };
    await runPodiumEmailSweep(db, { ...baseDeps(), send });
    expect(sent).toHaveLength(3);

    // THE MERGE, which is the P1 this test exists for: the Event document must
    // still carry everything it had, not be replaced by { podiumEmailAt }.
    const event = db.docs['events/med-2026'];
    expect(event.podiumEmailAt).toBe(3_000);
    expect(event.status).toBe('active');
    expect(event.name).toBe('Atlantis Med—Trieste to Barcelona');
    expect(Array.isArray(event.days)).toBe(true);
    expect(event.settings).toEqual({ dailyEmailEnabled: true });

    // A second sweep finds the marker and never reaches the transport.
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async () => {
        throw new Error('a marked Event must not be re-swept');
      },
    });
    expect(sent).toHaveLength(3);
  });

  it('leaves podiumEmailAt absent when the transport fails, so the next sweep retries', async () => {
    const db = makeDb(seedDue());
    await runPodiumEmailSweep(db, { ...baseDeps(), send: async () => false });
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    expect(sent).toHaveLength(3);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });

  it('mails nothing for an Event with no podium Moment', async () => {
    const docs = seedDue();
    delete docs[podiumMomentPath('med-2026')];
    const db = makeDb(docs);
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async () => {
        throw new Error('an Event with no podium must not be mailed');
      },
    });
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });
});

// --- ③c Round-2 review fixes ----------------------------------------------------

describe('row 1 is the Moment’s champion, never the live roster’s head (Codex P2 r2)', () => {
  it('pins the champion first even when a Player edits themselves above them', async () => {
    // The exact failure the round-1 test had merely DEMONSTRATED: subject says
    // Zac, row 1 said Nathan. The subject and the first row must name one person.
    const docs = seedDue();
    docs['events/med-2026/players/nathan'] = {
      displayName: 'Nathan Payne',
      bingoCount: 99,
      squaresMarked: 999,
      firstBingoAt: 1,
    };
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    const model = buildPodiumEmailModel({
      eventName: 'E',
      podium: got.input.podium,
      mostLoved: got.input.mostLoved,
      ranked: got.input.ranked,
      boardWasEmpty: got.input.boardWasEmpty,
      closingDay: got.input.closingDay,
      honorDayLabels: got.input.honorDayLabels,
      recipient: { uid: 'nathan', displayName: 'Nathan Payne' },
      edition: 'gcb',
      feedUrl: 'https://x.test/feed',
      unsubscribeUrl: 'https://x.test/u',
      preferencesUrl: 'https://x.test/p',
    });
    expect(model.subject).toBe('Final standings 🏆—Zacaria Arab takes the cruise');
    expect(model.standingsRows[0]).toMatchObject({ uid: 'zac', rank: 1 });
    // The edited Player still appears — below the pinned champion, and exactly
    // once.
    expect(model.standingsRows.filter((r) => r.uid === 'zac')).toHaveLength(1);
    expect(model.standingsRows[1].uid).toBe('nathan');
    // And the reader's own placing indexes the SAME ordering.
    expect(model.youLine).toContain('#2');
  });
});

describe('a withheld champion is not an empty board (Codex + CodeRabbit P2 r2)', () => {
  it('still prints standings when the frozen champion is banned', async () => {
    const got = await podiumEmailInputFor(makeDb(seedDue({ bannedUids: ['zac'] })), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.podium.champion).toBeNull();
    // The board was NOT empty — the Moment had a champion before filtering.
    expect(got.input.boardWasEmpty).toBe(false);
    const model = buildPodiumEmailModel({
      eventName: 'E',
      podium: got.input.podium,
      mostLoved: got.input.mostLoved,
      ranked: got.input.ranked,
      boardWasEmpty: got.input.boardWasEmpty,
      closingDay: got.input.closingDay,
      honorDayLabels: got.input.honorDayLabels,
      recipient: { uid: 'nathan', displayName: 'Nathan Payne' },
      edition: 'gcb',
      feedUrl: 'https://x.test/feed',
      unsubscribeUrl: 'https://x.test/u',
      preferencesUrl: 'https://x.test/p',
    });
    expect(model.standingsEmptyLine).toBeNull();
    expect(model.standingsRows.length).toBeGreaterThan(0);
    // The contradiction this prevents: "nobody marked a square" beside a
    // non-zero personal result.
    expect(model.youLine).toContain('bingos');
  });
});

describe('the Most-Loved award is validated and ban-filtered (Codex + CodeRabbit r2)', () => {
  const award = (over: Record<string, unknown> = {}) => ({
    winners: [
      { proofId: 'p1', uid: 'ido', displayName: 'Ido Marcus', promptText: 'Mirror-hall selfie', dayIndex: 6, proofCreatedAt: 500 },
      { proofId: 'p2', uid: 'sam', displayName: 'Sam', promptText: 'Deck sunrise', dayIndex: 5, proofCreatedAt: 600 },
    ],
    winnerCount: 2,
    heartCount: 31,
    frozenAt: 1,
    computedAt: 2,
    ...over,
  });

  it('drops a banned winner and promotes the next visible co-winner', async () => {
    const docs = seedDue({ mostLovedPhoto: award(), bannedUids: ['ido'] });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winners.map((w) => w.uid)).toEqual(['sam']);
    // The tie tail counts only Players the reader could see.
    expect(got.input.mostLoved?.winnerCount).toBe(1);
  });

  it('omits the award entirely when every winner is banned', async () => {
    const docs = seedDue({ mostLovedPhoto: award(), bannedUids: ['ido', 'sam'] });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved).toBeNull();
  });

  it.each([
    ['no winners array', { winners: undefined }],
    ['a non-numeric heartCount', { heartCount: 'lots' }],
    ['a winner missing promptText', { winners: [{ proofId: 'p', uid: 'x', displayName: 'X' }] }],
  ])('normalises a malformed award to null rather than throwing: %s', async (_name, over) => {
    const docs = seedDue({ mostLovedPhoto: award(over) });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved).toBeNull();
  });

  it('does not throw for the whole send when the stored award is garbage', async () => {
    const docs = seedDue({ mostLovedPhoto: { nonsense: true } });
    const db = makeDb(docs);
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    // Before the fix this threw inside the per-recipient catch for EVERY
    // recipient, so the Event never drained and the crash repeated every sweep.
    expect(sent).toHaveLength(3);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });
});

describe('delivery-time and roster safety (Codex P2 r2)', () => {
  it('does not begin delivery for an Event archived during preparation', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    // The archive lands between the due check and the send.
    db.docs['events/med-2026'].archiving = true;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        throw new Error('an archived Event must not be mailed');
      },
    });
    expect(result.reason).toBe('archived');
    expect(result.sent).toBe(0);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('withholds the marker when a Player joins mid-send, so the next sweep mails them', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    let n = 0;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        // A late joiner appears while the fan-out is still running.
        if (++n === 1) {
          db.docs['events/med-2026/players/late'] = {
            displayName: 'Late Joiner',
            bingoCount: 0,
            squaresMarked: 3,
            firstBingoAt: null,
          };
        }
        return true;
      },
    });
    expect(result.sent).toBe(3);
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();

    // The next sweep mails only the new member — everyone else is skipped by
    // their own marker.
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    expect(sent.map((s) => s.to[0])).toEqual(['late@example.com']);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });

  it('records an undeliverable recipient durably, so the lookup is not repeated', async () => {
    const db = makeDb(seed());
    let lookups = 0;
    const deps = {
      ...baseDeps(),
      getEmailForUid: async (uid: string) => {
        lookups++;
        return uid === 'zac' ? null : `${uid}@example.com`;
      },
      send: async () => true,
    };
    await sendPodiumEmailForEvent(db, 'med-2026', input(), deps);
    expect(db.docs['events/med-2026/emailPrefs/zac'].podiumEmailSkippedAt).toBe(3_000);
    const first = lookups;
    await sendPodiumEmailForEvent(db, 'med-2026', input(), deps);
    // The second run costs no further Auth lookups at all: everyone is now
    // resolved, by a sent marker or a skipped one.
    expect(lookups).toBe(first);
  });

  it('keeps the run open when the sent-marker write fails', async () => {
    const db = makeDb(seed());
    const broken = {
      ...db,
      doc: (path: string) =>
        path.includes('/emailPrefs/')
          ? { ...db.doc(path), set: async () => { throw new Error('UNAVAILABLE'); } }
          : db.doc(path),
    } as unknown as typeof db;
    const result = await sendPodiumEmailForEvent(broken, 'med-2026', input(), {
      ...baseDeps(),
      send: async () => true,
    });
    // Mail went out, but nothing recorded it — so the Event must NOT drain, or a
    // retry beyond Resend's 24h dedup window would deliver a second copy.
    expect(result.sent).toBe(3);
    expect(result.blocked).toBe(3);
    expect(result.drained).toBe(false);
  });
});

describe('the fan-out marker lands on an Event that has banned players', () => {
  it('stamps podiumEmailAt when a ban is the only difference from the raw roster', async () => {
    // The growth guard compares what this run WALKED against what the roster
    // holds now. The walked list is ban-filtered, so the comparison has to be
    // too — otherwise every Event with a single banned player reports "grew"
    // forever, never stamps the marker, and is re-read by every future sweep.
    const db = makeDb(seedDue({ bannedUids: ['zac'] }));
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    // The banned player is not mailed…
    expect(sent.map((s) => s.to[0]).sort()).toEqual(['logan@example.com', 'nathan@example.com']);
    // …and the Event is nonetheless finished.
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });
});

describe('the ranking uses the RESOLVED freeze, like the Moment does', () => {
  it('applies the ceremonial-Day fallback when no freeze is configured', async () => {
    // `standingsFreezeAtFor` resolves the configured field FIRST and falls back
    // to the first ceremonial Day's unlock — which is every Event written before
    // that field existed, including both live ones. Reading the raw field left
    // the cutoff null for them, so post-freeze marks counted toward ranks 2-3
    // while the Moment's champion excluded them.
    const docs = seedDue();
    // No `standingsFreezeAt` on the Event; Day index 2 is the ceremonial close,
    // unlocking at 5_000. A bingo recorded AFTER it must not rank.
    (docs['events/med-2026'].days as Array<Record<string, unknown>>)[2].unlockAt = 5_000;
    docs['events/med-2026/players/nathan'] = {
      displayName: 'Nathan Payne',
      bingoCount: 13,
      squaresMarked: 110,
      // Post-freeze instant: excluded from the ranking tie-break by the cutoff.
      firstBingoAt: 9_000,
    };
    docs['events/med-2026/players/logan'] = {
      displayName: 'Logan Murdock',
      bingoCount: 13,
      squaresMarked: 110,
      // NULL, not an early timestamp (CodeRabbit, round 5). With `200` here the
      // assertion held with or WITHOUT the cutoff — `compareFinalePlayers` sorts
      // finite instants ascending, so 200 beats 9_000 either way, and the test
      // proved nothing about the fix it was written for. With `null` (which the
      // comparator reads as `Infinity`) the two rows tie only once the cutoff
      // has cleared Nathan's post-freeze instant, and `seedDue` inserts Logan
      // first, so the stable sort preserves this order ONLY when the cutoff ran.
      firstBingoAt: null,
    };
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    const order = got.input.ranked.map((p) => p.uid);
    expect(order.indexOf('logan')).toBeLessThan(order.indexOf('nathan'));
  });
});

describe('round-3 findings (Codex P2)', () => {
  it('does not complete an EMPTY fan-out that gained a member mid-flight', async () => {
    // `firestore.rules` permits `players/{uid}` creation until archival, so the
    // zero-recipient fast path must verify membership like every other path —
    // otherwise a participant joining right after the due check is locked out
    // permanently by an `already-sent` answer on every later sweep.
    const db = makeDb(seedDue({ bannedUids: ['zac', 'logan', 'nathan'] }));
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.ranked).toHaveLength(0);
    // Somebody joins between the due check and the send.
    db.docs['events/med-2026/players/late'] = {
      displayName: 'Late Joiner',
      bingoCount: 0,
      squaresMarked: 1,
      firstBingoAt: null,
    };
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.reason).toBe('no-roster');
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();

    // …and the next sweep mails exactly the new member.
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    expect(sent.map((s) => s.to[0])).toEqual(['late@example.com']);
  });

  it('still completes an empty fan-out when nobody joins', async () => {
    const db = makeDb(seedDue({ bannedUids: ['zac', 'logan', 'nathan'] }));
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.drained).toBe(true);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });

  it('re-applies the admin toggle at delivery, not only the archive state', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    // The owner turns the email off while the send is being prepared.
    db.docs['events/med-2026'].settings = { dailyEmailEnabled: false };
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        throw new Error('a disabled Event must not be mailed');
      },
    });
    expect(result.reason).toBe('disabled');
    expect(result.sent).toBe(0);
    // NOT drained and NOT stamped: the toggle is reversible, so a marker here
    // would deny the Event its last email forever if the owner turned it back
    // on. Leaving the question open costs one document read per sweep.
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('mails the Event if the owner turns the email back on', async () => {
    const db = makeDb(seedDue({ settings: { dailyEmailEnabled: false } }));
    // Off at first: not due, and nothing is recorded that would prevent a later
    // send.
    expect(await podiumEmailInputFor(db, 'med-2026')).toEqual({ due: false, reason: 'disabled' });
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
    db.docs['events/med-2026'].settings = { dailyEmailEnabled: true };
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    expect(sent).toHaveLength(3);
  });

  it('stops claiming an exact tie size when the winner list was truncated', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      proofId: `p${i}`,
      uid: `u${i}`,
      displayName: `P${i}`,
      promptText: 'Shot',
      dayIndex: 1,
      proofCreatedAt: 100 + i,
    }));
    // A tie of 150 whose persisted prefix holds 100, with one banned INSIDE the
    // prefix. The 50 beyond it may hold more banned Players that cannot be seen
    // here, so no derived number is trustworthy.
    const docs = seedDue({
      mostLovedPhoto: { winners: many, winnerCount: 150, heartCount: 9, frozenAt: 1, computedAt: 2 },
      bannedUids: ['u0'],
    });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winnerCountExact).toBe(false);
    const model = modelFor('gcb', { mostLoved: got.input.mostLoved });
    expect(model.mostLovedLine).toContain('Shared with others on the same count.');
    expect(model.mostLovedLine).not.toMatch(/Shared with \d+ other/);
  });

  it('still states an exact tie size when nothing was truncated', async () => {
    const docs = seedDue({
      mostLovedPhoto: {
        winners: [
          { proofId: 'a', uid: 'ido', displayName: 'Ido', promptText: 'One', dayIndex: 1, proofCreatedAt: 1 },
          { proofId: 'b', uid: 'sam', displayName: 'Sam', promptText: 'Two', dayIndex: 1, proofCreatedAt: 2 },
          { proofId: 'c', uid: 'kai', displayName: 'Kai', promptText: 'Three', dayIndex: 1, proofCreatedAt: 3 },
        ],
        winnerCount: 3,
        heartCount: 9,
        frozenAt: 1,
        computedAt: 2,
      },
      bannedUids: ['sam'],
    });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winnerCountExact).toBe(true);
    const model = modelFor('gcb', { mostLoved: got.input.mostLoved });
    expect(model.mostLovedLine).toContain('Shared with 1 other photo on the same count.');
  });
});

describe('the sweep selects only active Events (Codex + CodeRabbit r2)', () => {
  it('never reads an archived Event’s Moment or roster', async () => {
    const docs = { ...seedDue(), 'events/old-2024': { status: 'archived', name: 'Old' } };
    const db = makeDb(docs);
    const read: string[] = [];
    const traced = {
      ...db,
      doc: (path: string) => {
        read.push(path);
        return db.doc(path);
      },
    } as unknown as typeof db;
    await runPodiumEmailSweep(traced, { ...baseDeps(), send: async () => true });
    expect(read.some((p) => p.startsWith('events/old-2024'))).toBe(false);
  });
});

describe('the token back-fill preserves every send marker (CodeRabbit r2, review body)', () => {
  it('does not re-mail a token-less participant who already received the winner email', async () => {
    const docs = seed();
    // A legacy doc: already mailed the winner email, but carrying no token, so
    // `ensureEmailPrefs` takes the back-fill transaction rather than returning
    // the stored prefs directly.
    docs['events/med-2026/emailPrefs/zac'] = { optedOut: false, token: '', podiumEmailSentAt: 111 };
    const { result, sent, db } = await run(docs);
    expect(sent.some((s) => s.to[0] === 'zac@example.com')).toBe(false);
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    // …and the back-fill still did its job. Asserting the DOCUMENT exists would
    // prove nothing — the test seeds it — so assert the values the back-fill is
    // responsible for: a token was minted and persisted, and the marker it had
    // to carry through survived the write untouched.
    //
    // Read from `db.docs`, NOT the seed object: `makeDb` copies its input, so
    // the outer `docs` is a snapshot of the fixture and never sees a write. That
    // is what let the original `toBeDefined()` assertion look meaningful.
    const backfilled = db.docs['events/med-2026/emailPrefs/zac'];
    expect(typeof backfilled.token).toBe('string');
    expect(backfilled.token).not.toBe('');
    expect(backfilled.podiumEmailSentAt).toBe(111);
  });

  it('preserves a token-less participant’s undeliverable marker too', async () => {
    const docs = seed();
    docs['events/med-2026/emailPrefs/logan'] = { optedOut: false, token: '', podiumEmailSkippedAt: 222 };
    const { sent } = await run(docs);
    expect(sent.some((s) => s.to[0] === 'logan@example.com')).toBe(false);
  });

  it('still mails a token-less participant carrying no podium marker', async () => {
    const docs = seed();
    docs['events/med-2026/emailPrefs/zac'] = { optedOut: false, token: '', lastSentDayIndex: 9 };
    const { sent } = await run(docs);
    // The daily card's marker must not suppress this send — the two are
    // independent, which is why they are separate fields.
    expect(sent.some((s) => s.to[0] === 'zac@example.com')).toBe(true);
  });
});

describe('the rendered copy matches the wireframe frame it is drawn from', () => {
  // `specs/daily-engagement-email.md`: where the spec and the frames disagree
  // about what the email looks like, the FRAMES win. These pin the two module
  // sentences against `#fx-email-finale-gcb` so a paraphrase cannot creep back
  // in — which is exactly what happened to the Most-Loved line, whose first
  // implementation dropped the photo's Day entirely.
  const frame = readFileSync(
    fileURLToPath(new URL('../../plans/daily-cards-wireframes.html', import.meta.url)),
    'utf8',
  );

  it('renders the ⭐ sentence the frame shows', () => {
    const model = modelFor('gcb');
    expect(model.starLine).toBe(
      'Logan Murdock took the cruise-wide First to BINGO—Day 2 in 🇭🇷 Split.',
    );
    expect(frame).toContain(
      '<b>Logan Murdock</b> took the cruise-wide First to BINGO—Day 2 in 🇭🇷 Split.',
    );
  });

  it('renders the Most-Loved sentence the frame shows, dated', () => {
    const model = modelFor('gcb');
    expect(model.mostLovedLine).toBe(
      'Ido Marcus—"Mirror-hall selfie," Day 7 · 🇮🇹 Rome (Civitavecchia). ❤ 31, frozen at the Standings Freeze.',
    );
    expect(frame).toContain(
      '📷 <b>Ido Marcus</b>—"Mirror-hall selfie," Day 7 · 🇮🇹 Rome (Civitavecchia). <b>❤ 31</b>, frozen at the Standings Freeze.',
    );
  });

  it('drops the date rather than inventing one when the photo names no Day', () => {
    const model = modelFor('gcb', { photoDayLabel: undefined });
    expect(model.mostLovedLine).toBe(
      'Ido Marcus—"Mirror-hall selfie," ❤ 31, frozen at the Standings Freeze.',
    );
  });
});

describe('round-4 findings (Codex P2, CodeRabbit P1)', () => {
  it('does not stamp completion for an empty roster on a DISABLED Event', async () => {
    // CodeRabbit P1: the empty-roster branch ran before the fresh Event read, so
    // it could write `podiumEmailAt` while the owner had just switched the email
    // off. Re-enabling then answers `already-sent` forever.
    const db = makeDb(seedDue({ bannedUids: ['zac', 'logan', 'nathan'] }));
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    db.docs['events/med-2026'].settings = { dailyEmailEnabled: false };
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.reason).toBe('disabled');
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('does not stamp completion for an empty roster on an ARCHIVING Event', async () => {
    const db = makeDb(seedDue({ bannedUids: ['zac', 'logan', 'nathan'] }));
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    db.docs['events/med-2026'].archiving = true;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.reason).toBe('archived');
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('aborts when a ban lands between the due check and delivery', async () => {
    // Every ban-filtered thing the snapshot carries — recipients, honours, the
    // award — was filtered against the roster the due check read.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    db.docs['events/med-2026'].bannedUids = ['logan'];
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        throw new Error('a stale ban-filtered snapshot must not be delivered');
      },
    });
    expect(result.reason).toBe('bans-changed');
    expect(result.drained).toBe(false);

    // The next sweep rebuilds a correctly filtered snapshot and mails the rest.
    const sent: Captured[] = [];
    await runPodiumEmailSweep(db, {
      ...baseDeps(),
      send: async (args) => {
        sent.push({ ...args, from: args.from ?? '', idempotencyKey: args.idempotencyKey ?? '' });
        return true;
      },
    });
    expect(sent.map((s) => s.to[0]).sort()).toEqual(['nathan@example.com', 'zac@example.com']);
  });

  it('detects a delete-and-join swap that leaves the roster COUNT unchanged', async () => {
    // A count comparison cannot see this: one examined Player leaves, one
    // unexamined Player arrives, and the total is identical.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    let n = 0;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        if (++n === 1) {
          delete db.docs['events/med-2026/players/nathan'];
          db.docs['events/med-2026/players/swap'] = {
            displayName: 'Swapped In',
            bingoCount: 0,
            squaresMarked: 2,
            firstBingoAt: null,
          };
        }
        return true;
      },
    });
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('treats a truncated tie as inexact even when the ban is only BEYOND the prefix', async () => {
    // Round 3's test asked whether a ban was found INSIDE the prefix, which is
    // the case that does not need the guard. Here every prefix entry is visible
    // and the banned uid lies in the hidden remainder.
    const many = Array.from({ length: 100 }, (_, i) => ({
      proofId: `p${i}`,
      uid: `u${i}`,
      displayName: `P${i}`,
      promptText: 'Shot',
      dayIndex: 1,
      proofCreatedAt: 100 + i,
    }));
    const docs = seedDue({
      mostLovedPhoto: { winners: many, winnerCount: 150, heartCount: 9, frozenAt: 1, computedAt: 2 },
      bannedUids: ['hidden-winner-beyond-the-prefix'],
    });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winners).toHaveLength(100);
    expect(got.input.mostLoved?.winnerCountExact).toBe(false);
  });

  it('will not count a truncated tie even when NO ban roster is in play', async () => {
    // Round 4's rule excused this case, because bans were then the only filter.
    // The live-visibility join added in round 5 applies to every winner
    // regardless, and the winners beyond the persisted prefix cannot be joined
    // because they were never stored — so a hidden photo out there is as
    // invisible to us as a banned owner was.
    const many = Array.from({ length: 100 }, (_, i) => ({
      proofId: `p${i}`,
      uid: `u${i}`,
      displayName: `P${i}`,
      promptText: 'Shot',
      dayIndex: 1,
      proofCreatedAt: 100 + i,
    }));
    const docs = seedDue({
      mostLovedPhoto: { winners: many, winnerCount: 150, heartCount: 9, frozenAt: 1, computedAt: 2 },
    });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winnerCountExact).toBe(false);
    // The count reflects what was actually verified, not the stored cardinality.
    expect(got.input.mostLoved?.winnerCount).toBe(100);
  });
});

describe('round-5 findings (Codex P2, CodeRabbit)', () => {
  const award = () => ({
    winners: [
      { proofId: 'p1', uid: 'ido', displayName: 'Ido Marcus', promptText: 'Mirror-hall selfie', dayIndex: 6, proofCreatedAt: 500 },
      { proofId: 'p2', uid: 'sam', displayName: 'Sam', promptText: 'Deck sunrise', dayIndex: 5, proofCreatedAt: 600 },
    ],
    winnerCount: 2,
    heartCount: 31,
    frozenAt: 1,
    computedAt: 2,
  });

  it('waits for the freeze stamp rather than treating an absent award as "no award"', async () => {
    // `runFinaleBeats` posts the podium Moment independently of the freeze, so a
    // failed freeze transaction leaves a posted podium beside an Event with no
    // `mostLovedPhoto`. Mailing then would permanently omit an award the next
    // unlock retry is about to persist.
    const docs = seedDue();
    delete docs['events/med-2026'].frozenAt;
    expect(await podiumEmailInputFor(makeDb(docs), 'med-2026')).toEqual({
      due: false,
      reason: 'not-frozen',
    });
  });

  it('is due once the freeze stamp lands, with an explicit no-award record', async () => {
    // `{ winners: [], heartCount: 0 }` is "computed, none" — distinct from
    // absence — so this must send, with no award module.
    const docs = seedDue({ mostLovedPhoto: { winners: [], heartCount: 0, frozenAt: 1, computedAt: 2 } });
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved).toBeNull();
  });

  it('drops a winner whose photo was deleted after the freeze', async () => {
    const docs = seedDue({ mostLovedPhoto: award() });
    delete docs['events/med-2026/proofs/p1'];
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    // Sam, the next surviving winner, becomes the hero.
    expect(got.input.mostLoved?.winners[0].uid).toBe('sam');
  });

  it.each([
    ['hidden', { status: 'hidden' }],
    ['report-hidden', { reportCount: 3 }],
    ['a different incarnation', { createdAt: 999 }],
    ['no longer a photo', { type: 'text' }],
  ])('drops a winner whose live proof is %s', async (_name, mutation) => {
    const docs = seedDue({ mostLovedPhoto: award(), settings: { dailyEmailEnabled: true, reportHideThreshold: 3 } });
    Object.assign(docs['events/med-2026/proofs/p1'], mutation);
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winners[0].uid).toBe('sam');
  });

  it('omits the module when NO winner survives the visibility join', async () => {
    const docs = seedDue({ mostLovedPhoto: award() });
    delete docs['events/med-2026/proofs/p1'];
    delete docs['events/med-2026/proofs/p2'];
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved).toBeNull();
    // …and the send still completes; a suppressed photo is not a failure.
    const model = modelFor('gcb', { mostLoved: got.input.mostLoved });
    expect(model.mostLovedLine).toBeNull();
  });

  it('reads one proof per persisted winner, and exactly one when there is no tie', async () => {
    const solo = {
      winners: [
        { proofId: 'only', uid: 'ido', displayName: 'Ido Marcus', promptText: 'Solo', dayIndex: 6, proofCreatedAt: 500 },
      ],
      winnerCount: 1,
      heartCount: 31,
      frozenAt: 1,
      computedAt: 2,
    };
    const soloDb = makeDb(seedDue({ mostLovedPhoto: solo }));
    const soloReads: string[] = [];
    const tracedSolo = {
      ...soloDb,
      doc: (path: string) => {
        if (path.includes('/proofs/')) soloReads.push(path);
        return soloDb.doc(path);
      },
    } as unknown as typeof soloDb;
    await podiumEmailInputFor(tracedSolo, 'med-2026');
    // The overwhelmingly common case — no tie — still costs a single read.
    expect(soloReads).toEqual(['events/med-2026/proofs/only']);

    const docs = seedDue({ mostLovedPhoto: award() });
    const db = makeDb(docs);
    const read: string[] = [];
    const traced = {
      ...db,
      doc: (path: string) => {
        if (path.includes('/proofs/')) read.push(path);
        return db.doc(path);
      },
    } as unknown as typeof db;
    await podiumEmailInputFor(traced, 'med-2026');
    // A real tie costs one read per persisted winner — bounded by the tie, paid
    // once per Event lifetime, and the price of not claiming a co-winner whose
    // photo has been taken down.
    expect(read).toEqual(['events/med-2026/proofs/p1', 'events/med-2026/proofs/p2']);
  });
});

describe('completion is verified and stamped atomically (Codex P2 r5)', () => {
  it('does not stamp when a Player is created inside the verification window', async () => {
    // The two-step version read the roster and THEN wrote the marker, so a row
    // created between them was stranded: the marker landed and every later
    // sweep answered `already-sent`. The transaction closes that window by
    // reading the collection inside it — here the joiner appears before the
    // read, which is the state the old ordering could not have seen.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    db.docs['events/med-2026/players/late'] = {
      displayName: 'Late Joiner',
      bingoCount: 0,
      squaresMarked: 1,
      firstBingoAt: null,
    };
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('reads the players collection INSIDE the transaction, not before it', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    // Building the query ref is not a read — `tx.get` is. So the assertion is
    // that the players query is GOT inside the transaction, not that
    // `db.collection` is called there.
    let rosterGotInsideTx = false;
    const traced = {
      ...db,
      runTransaction: async <T,>(fn: (tx: never) => Promise<T>): Promise<T> =>
        db.runTransaction((async (tx: {
          get: (ref: unknown) => Promise<unknown>;
          set: (...args: unknown[]) => void;
        }) => {
          const wrapped = {
            ...tx,
            get: async (ref: { path?: string }) => {
              if (typeof ref.path !== 'string') rosterGotInsideTx = true;
              return tx.get(ref);
            },
          };
          return fn(wrapped as never);
        }) as never),
    } as unknown as typeof db;
    await sendPodiumEmailForEvent(traced, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(rosterGotInsideTx).toBe(true);
  });

  it('writes the marker with a MERGE inside the transaction', async () => {
    const db = makeDb(seedDue());
    await runPodiumEmailSweep(db, { ...baseDeps(), send: async () => true });
    const event = db.docs['events/med-2026'];
    expect(event.podiumEmailAt).toBe(3_000);
    // Everything else survives the transactional write.
    expect(event.status).toBe('active');
    expect(event.frozenAt).toBe(5_000);
    expect(Array.isArray(event.days)).toBe(true);
  });
});

describe('round-6 findings (Codex P2)', () => {
  it('aborts when the Event is archived while the sender is being resolved', async () => {
    // `resolveEventOrigin` and `resolveEmailFrom` are remote, so guards placed
    // ahead of them left the very window they closed reopened.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    // The mutation must land DURING the function's own preparation, not while
    // this deps object is being built (CodeRabbit, round 7): an IIFE here runs
    // before `sendPodiumEmailForEvent` is even called, so the FIRST guard would
    // satisfy the assertion and the test would pass with the second guard
    // deleted. Hooking the hostnames read — which `resolveEventOrigin` performs
    // between the two guards — puts it in the real window.
    let firstGuardSawOpenEvent = false;
    const traced = {
      ...db,
      collection: (path: string) => {
        if (path === 'hostnames') {
          // Reaching here at all proves the first guard passed on an open Event.
          firstGuardSawOpenEvent = true;
          db.docs['events/med-2026'].archiving = true;
        }
        return db.collection(path);
      },
    } as unknown as typeof db;
    const result = await sendPodiumEmailForEvent(traced, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        throw new Error('an Event archived during preparation must not be mailed');
      },
    });
    expect(firstGuardSawOpenEvent).toBe(true);
    expect(result.reason).toBe('archived');
  });

  it('refuses to resurrect an Event deleted during the fan-out', async () => {
    // A merge-style `set` CREATES a missing document, so this would have left a
    // zombie Event containing only `podiumEmailAt` — its subcollections survive
    // deletion, so it would look half-real.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    let n = 0;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        if (++n === 3) delete db.docs['events/med-2026'];
        return true;
      },
    });
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026']).toBeUndefined();
  });

  it('bounds the transactional roster read at the ceiling', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    let limited: number | null = null;
    const traced = {
      ...db,
      collection: (path: string) => {
        const q = db.collection(path);
        return path.endsWith('/players')
          ? { ...q, limit: (n: number) => { limited = n; return q.limit(n); } }
          : q;
      },
    } as unknown as typeof db;
    await sendPodiumEmailForEvent(traced, 'med-2026', got.input, {
      ...baseDeps(),
      maxRecipients: 5,
      send: async () => true,
    });
    // Ceiling plus one, so an overflowing roster still reads as "someone I did
    // not examine" rather than silently fitting.
    expect(limited).toBe(6);
  });

  it('states no tie size when a co-winner’s photo was taken down', async () => {
    // Round 5 validated only the hero and kept counting the tail, so the email
    // could claim a co-winner whose photo had been removed.
    const docs = seedDue({
      mostLovedPhoto: {
        winners: [
          { proofId: 'p1', uid: 'ido', displayName: 'Ido', promptText: 'One', dayIndex: 1, proofCreatedAt: 1 },
          { proofId: 'p2', uid: 'sam', displayName: 'Sam', promptText: 'Two', dayIndex: 1, proofCreatedAt: 2 },
          { proofId: 'p3', uid: 'kai', displayName: 'Kai', promptText: 'Three', dayIndex: 1, proofCreatedAt: 3 },
        ],
        winnerCount: 3,
        heartCount: 9,
        frozenAt: 1,
        computedAt: 2,
      },
    });
    delete docs['events/med-2026/proofs/p3'];
    const got = await podiumEmailInputFor(makeDb(docs), 'med-2026');
    if (!got.due) throw new Error('expected due');
    // The hero survives, and the count reflects only what was verified.
    expect(got.input.mostLoved?.winners.map((w) => w.uid)).toEqual(['ido', 'sam']);
    expect(got.input.mostLoved?.winnerCount).toBe(2);
    const model = modelFor('gcb', { mostLoved: got.input.mostLoved });
    expect(model.mostLovedLine).toContain('Shared with 1 other photo on the same count.');
  });

  it('renders no placing line when the frozen board was empty', () => {
    // `boardWasEmpty` comes from the Moment while the placing line is read off
    // the live roster, so a post-freeze self-edit would otherwise produce "nobody
    // marked a square" above "you finished #2 with 14 squares".
    const model = modelFor('gcb', { boardWasEmpty: true });
    expect(model.standingsRows).toEqual([]);
    expect(model.youLine).toBeNull();
  });

  it.each([
    ['an unchanged but malformed roster', [123], [123]],
    ['a duplicate replacing a real unban', ['x', 'y'], ['x', 'x']],
  ])('compares ban rosters symmetrically: %s', (_name, before, after) => {
    const db = makeDb(seedDue({ bannedUids: after }));
    return (async () => {
      const got = await podiumEmailInputFor(db, 'med-2026');
      if (!got.due) throw new Error('expected due');
      const result = await sendPodiumEmailForEvent(
        db,
        'med-2026',
        { ...got.input, bannedUids: before as unknown as string[] },
        { ...baseDeps(), send: async () => true },
      );
      // `[123]` vs `[123]`: identical, so the send proceeds rather than
      // returning `bans-changed` on every sweep forever.
      // `['x','y']` vs `['x','x']`: a real unban, so it must be caught.
      const expected = JSON.stringify(before) === JSON.stringify(after) ? undefined : 'bans-changed';
      expect(result.reason).toBe(expected);
    })();
  });
});

describe('round-7 finding (Codex P2)', () => {
  it('refuses completion when the bounded page overflows, even if bans mask it', async () => {
    // The trap: ban filtering can shrink a `cap + 1` page back to `cap`, so the
    // send loop's `capHit` never trips (it counts EXAMINED players, already
    // filtered) and the transaction's filtered view of a truncated page looks
    // complete. Stamping then strands every visible Player past the page.
    const docs = seedDue({ bannedUids: ['b1'] });
    docs['events/med-2026/players/b1'] = { displayName: 'Banned', bingoCount: 0, squaresMarked: 0, firstBingoAt: null };
    for (let i = 0; i < 4; i++) {
      docs[`events/med-2026/players/extra${i}`] = {
        displayName: `Extra ${i}`,
        bingoCount: 0,
        squaresMarked: i,
        firstBingoAt: null,
      };
    }
    // Raw roster is 8 (3 seeded + 1 banned + 4 extra); the ceiling is 3, so the
    // page is 4 rows of which one is banned — three visible, at the cap.
    const db = makeDb(docs);
    const got = await podiumEmailInputFor(db, 'med-2026', undefined, 3);
    if (!got.due) throw new Error('expected due');
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      maxRecipients: 3,
      send: async () => true,
    });
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('still completes a roster that sits exactly AT the ceiling', async () => {
    // The boundary must not refuse a legitimate full roster: three visible
    // players against a ceiling of three is complete, not overflowing.
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026', undefined, 3);
    if (!got.due) throw new Error('expected due');
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      maxRecipients: 3,
      send: async () => true,
    });
    expect(result.sent).toBe(3);
    expect(result.drained).toBe(true);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });
});

describe('the completion transaction is the last word (CodeRabbit P1 r7)', () => {
  // `freshEventGuard` can pass and the Event can change before the marker
  // commits — and that write is irreversible in effect, since re-enabling or
  // unbanning afterwards cannot reopen a closed fan-out. So every mutable
  // condition is re-applied on the transactional snapshot.
  const mutateInsideTx = (db: ReturnType<typeof makeDb>, mutation: Record<string, unknown>) =>
    ({
      ...db,
      runTransaction: async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
        Object.assign(db.docs['events/med-2026'], mutation);
        return db.runTransaction(fn);
      },
    }) as unknown as typeof db;

  it.each([
    ['archived', { status: 'archived' }],
    ['closing', { archiving: true }],
    ['disabled', { settings: { dailyEmailEnabled: false } }],
    ['re-banned', { bannedUids: ['logan'] }],
  ])('does not stamp when the Event became %s before the commit', async (_name, mutation) => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    const result = await sendPodiumEmailForEvent(mutateInsideTx(db, mutation), 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('still stamps when nothing changed', async () => {
    const db = makeDb(seedDue());
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => true,
    });
    expect(result.drained).toBe(true);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBe(3_000);
  });
});

describe('round-8 findings (Codex P2)', () => {
  it('aborts when the award photo is taken down while the sender resolves', async () => {
    // The visibility join runs during due-input assembly and the remote setup
    // awaits after it, so closing that window for the Event's fields while
    // leaving it open for the award was inconsistent.
    const db = makeDb(
      seedDue({
        mostLovedPhoto: {
          winners: [
            { proofId: 'p1', uid: 'ido', displayName: 'Ido Marcus', promptText: 'Mirror-hall selfie', dayIndex: 6, proofCreatedAt: 500 },
          ],
          winnerCount: 1,
          heartCount: 31,
          frozenAt: 1,
          computedAt: 2,
        },
      }),
    );
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    expect(got.input.mostLoved?.winners[0].uid).toBe('ido');
    let firstGuardPassed = false;
    const traced = {
      ...db,
      collection: (path: string) => {
        if (path === 'hostnames') {
          firstGuardPassed = true;
          // A moderator hides the winning photo mid-preparation.
          db.docs['events/med-2026/proofs/p1'].status = 'hidden';
        }
        return db.collection(path);
      },
    } as unknown as typeof db;
    const result = await sendPodiumEmailForEvent(traced, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        throw new Error('a removed award photo must not be broadcast');
      },
    });
    expect(firstGuardPassed).toBe(true);
    expect(result.reason).toBe('award-changed');
  });

  it('stops the paced fan-out when archival lands mid-delivery', async () => {
    const docs = seedDue();
    for (let i = 0; i < 60; i++) {
      docs[`events/med-2026/players/p${i}`] = {
        displayName: `Player ${i}`,
        bingoCount: 0,
        squaresMarked: i,
        firstBingoAt: null,
      };
    }
    const db = makeDb(docs);
    const got = await podiumEmailInputFor(db, 'med-2026');
    if (!got.due) throw new Error('expected due');
    let n = 0;
    const result = await sendPodiumEmailForEvent(db, 'med-2026', got.input, {
      ...baseDeps(),
      send: async () => {
        // The admin begins archiving partway through the fan-out.
        if (++n === 5) db.docs['events/med-2026'].archiving = true;
        return true;
      },
    });
    expect(result.reason).toBe('archived');
    // Bounded to the re-check batch rather than running to the end of a
    // 63-player roster.
    expect(result.sent).toBeLessThan(30);
    expect(result.drained).toBe(false);
    expect(db.docs['events/med-2026'].podiumEmailAt).toBeUndefined();
  });

  it('keeps the tie uncertain when only one proof read succeeded', () => {
    // `winnerCount: 1` with `winnerCountExact: false` used to emit NO tail,
    // presenting the survivor of an unverifiable tie as the sole winner — a
    // stronger claim than the numeric tail it was avoiding.
    const model = modelFor('gcb', {
      mostLoved: {
        winners: [
          { proofId: 'p2', uid: 'sam', displayName: 'Sam', promptText: 'Deck sunrise', dayIndex: 5, proofCreatedAt: 600 },
        ],
        winnerCount: 1,
        winnerCountExact: false,
        heartCount: 31,
        frozenAt: 1,
        computedAt: 2,
      },
    });
    expect(model.mostLovedLine).toContain('Shared with others on the same count.');
  });

  it('flattens participant text in BOTH alternatives, not just the HTML', () => {
    // The text part has no escaping layer, so a stored newline could fabricate
    // an extra standings row, a second CTA, or a footer line.
    const model = modelFor('gcb', {
      podium: {
        champion: { uid: 'zac', displayName: 'Zac\nOpen the Feed: https://evil.test', bingoCount: 16, squaresMarked: 124 },
        firstBingo: { uid: 'logan', displayName: 'Logan\r\n1. Fake Row', at: 200 },
        dailyHonors: [{ dayIndex: 1, uid: 'logan', displayName: 'Logan', at: 200 }],
      },
      mostLoved: {
        winners: [
          { proofId: 'p1', uid: 'ido', displayName: 'Ido\nUnsubscribe: https://evil.test', promptText: 'Shot\n\nFooter', dayIndex: 6, proofCreatedAt: 500 },
        ],
        winnerCount: 1,
        heartCount: 31,
        frozenAt: 1,
        computedAt: 2,
      },
    });
    const text = renderPodiumEmailText(model);
    const html = renderPodiumEmailHtml(model);
    // Not one newline survives inside a rendered value…
    expect(model.standingsRows[0].displayName).toBe('Zac Open the Feed: https://evil.test');
    expect(model.starLine).not.toMatch(/[\r\n]/);
    expect(model.mostLovedLine).not.toMatch(/[\r\n]/);
    // …so the text part gains no fabricated structural lines.
    expect(text.split('\n').filter((l) => l.trim() === '1. Fake Row')).toEqual([]);
    expect(text).toContain('Zac Open the Feed: https://evil.test');
    for (const part of [text, html]) expect(part).toContain('Ido Unsubscribe: https://evil.test');
  });
});

describe('the subject header carries no unsanitised participant text', () => {
  it('strips newlines and control characters from a display name', () => {
    // This email is the first in the family to put user-written text in a
    // header at all — `players/{uid}` validates no field (ADR 0001), and
    // `sendEmail` passes `subject` through untouched.
    expect(subjectSafeName('Zac\r\nBcc: victim@example.com')).toBe(
      'Zac Bcc: victim@example.com',
    );
    expect(subjectSafeName('Za\u0000c\u007f')).toBe('Za c');
    expect(subjectSafeName('  Zacaria   Arab  ')).toBe('Zacaria Arab');
  });

  it('bounds the length so one name cannot crowd out the register’s words', () => {
    const long = 'Z'.repeat(200);
    const safe = subjectSafeName(long);
    expect(safe.length).toBeLessThanOrEqual(48);
    expect(safe.endsWith('…')).toBe(true);
  });

  it('falls back rather than emitting an empty name', () => {
    expect(subjectSafeName('   ')).toBe('The winner');
    expect(subjectSafeName('\n\t')).toBe('The winner');
  });

  it('produces a single-line subject for a hostile display name', () => {
    const model = modelFor('gcb', {
      podium: {
        champion: {
          uid: 'zac',
          displayName: 'Zac\nSubject: You have won a prize',
          bingoCount: 16,
          squaresMarked: 124,
        },
        firstBingo: null,
        dailyHonors: [],
      },
    });
    expect(model.subject).not.toMatch(/[\r\n]/);
    expect(model.subject).toBe(
      'Final standings 🏆—Zac Subject: You have won a prize takes the cruise',
    );
  });

  it('leaves an ordinary name untouched', () => {
    expect(modelFor('gcb').subject).toBe('Final standings 🏆—Zacaria Arab takes the cruise');
  });
});

// --- ④ Both registers render ----------------------------------------------------

/** The model as a real send would build it, for one Edition. */
const modelFor = (edition: string, over: Record<string, unknown> = {}) => {
  const beat = input();
  return buildPodiumEmailModel({
    eventName: 'Atlantis Med—Trieste to Barcelona',
    podium: beat.podium,
    mostLoved: beat.mostLoved,
    ranked: beat.ranked,
    closingDay: beat.closingDay,
    honorDayLabels: beat.honorDayLabels,
    photoDayLabel: beat.photoDayLabel,
    boardWasEmpty: false,
    recipient: { uid: 'nathan', displayName: 'Nathan Payne' },
    edition,
    feedUrl: 'https://gaycruisebingo.com/feed',
    unsubscribeUrl: 'https://fn.example.com/emailUnsubscribe?e=med-2026',
    preferencesUrl: 'https://fn.example.com/emailUnsubscribe?e=med-2026&p=1',
    ...over,
  });
};

describe('winner-announcement email — both Edition registers (#1192)', () => {
  it.each([
    ['gcb', 'Zacaria Arab takes the cruise', 'cruise-wide', "That's the cruise."],
    ['fiveacross', 'Zacaria Arab takes it', 'event-wide', "That's the event."],
    ['vacay', 'Zacaria Arab takes the trip', 'trip-wide', "That's the trip."],
  ])('renders the %s register end to end', (edition, subjectTail, wide, signOff) => {
    const model = modelFor(edition);
    expect(model.subject).toBe(`Final standings 🏆—${subjectTail}`);
    expect(model.starLine).toContain(wide);
    expect(model.signOffLine).toContain(signOff);

    const html = renderPodiumEmailHtml(model);
    const text = renderPodiumEmailText(model);
    // Both parts of one multipart/alternative message state the same result.
    for (const part of [html, text]) {
      expect(part).toContain('Zacaria Arab');
      expect(part).toContain('Logan Murdock');
      expect(part).toContain('Ido Marcus');
    }
    // No webfont, no image, no external stylesheet — the email-safe constraints.
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).toContain('Open the Feed');
  });

  it('omits the ⭐ and award modules entirely when the Event has neither', () => {
    const model = modelFor('gcb', {
      podium: { champion: null, firstBingo: null, dailyHonors: [] },
      mostLoved: null,
      ranked: [],
    });
    expect(model.starLine).toBeNull();
    expect(model.mostLovedLine).toBeNull();
    const html = renderPodiumEmailHtml(model);
    expect(html).not.toContain('First to BINGO');
    expect(html).not.toContain('Most-loved');
  });
});
