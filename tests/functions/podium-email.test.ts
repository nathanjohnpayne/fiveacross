import { describe, it, expect, vi } from 'vitest';
import {
  podiumEmailInputFor,
  podiumMomentPath,
  runPodiumEmailSweep,
  sendPodiumEmailForEvent,
  type PodiumEmailInput,
} from '../../functions/src/podiumEmail';
import type { DailyEmailFirestore } from '../../functions/src/dailyEmail';
import { shouldSendPodiumTo } from '../../functions/src/emailOptOut';
import { buildPodiumEmailModel } from '../../functions/src/podiumEmailContent';
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
      get: async (ref: { path: string }) => snapshotOf(ref.path),
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
  ...over,
});

const seed = (settings: Record<string, unknown> = { dailyEmailEnabled: true }): Docs => ({
  'events/med-2026': { name: 'Atlantis Med—Trieste to Barcelona', status: 'active', settings },
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
const seedDue = (over: Record<string, unknown> = {}, momentOver?: Record<string, unknown>): Docs => ({
  ...seed(),
  'events/med-2026': {
    name: 'Atlantis Med—Trieste to Barcelona',
    status: 'active',
    settings: { dailyEmailEnabled: true },
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
