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
    // Nothing is owed, so the beat should stop asking rather than retry forever.
    expect(result.drained).toBe(true);
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
