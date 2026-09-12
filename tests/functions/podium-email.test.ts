import { describe, it, expect, vi } from 'vitest';
import {
  sendPodiumEmailForEvent,
  type PodiumEmailInput,
} from '../../functions/src/podiumEmail';
import type { DailyEmailFirestore } from '../../functions/src/dailyEmail';
import { shouldSendPodiumTo } from '../../functions/src/emailOptOut';
import { finaleActions, type FinaleTimes } from '../../functions/src/unlockDay';
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

// --- ② The beat's decision ------------------------------------------------------

describe('finaleActions — the winner-email arm (#1192)', () => {
  const times: FinaleTimes = {
    lastCallAt: 1_000,
    standingsFreezeAt: 2_000,
    lastCallDayIndex: 8,
    podiumDayIndex: 9,
  };
  const state = {
    frozenAt: null,
    lastCallPosted: false,
    podiumPosted: false,
    mostLovedComputed: false,
  };

  it('does not fire before the freeze', () => {
    expect(finaleActions(times, 1_999, state).sendPodiumEmail).toBe(false);
  });

  it('fires at the freeze instant', () => {
    expect(finaleActions(times, 2_000, state).sendPodiumEmail).toBe(true);
  });

  it('STAYS OWED after the podium Moment has landed', () => {
    // The decoupling that matters: an arm gated on `postPodium` would get one
    // attempt at a fan-out that legitimately needs several.
    const decision = finaleActions(times, 5_000, { ...state, podiumPosted: true, frozenAt: 2_000 });
    expect(decision.postPodium).toBe(false);
    expect(decision.sendPodiumEmail).toBe(true);
  });

  it('goes quiet once the fan-out is recorded as finished', () => {
    expect(
      finaleActions(times, 5_000, { ...state, podiumEmailDone: true }).sendPodiumEmail,
    ).toBe(false);
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
