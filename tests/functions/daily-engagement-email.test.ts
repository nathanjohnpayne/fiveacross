import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, defaultThemeForEdition } from '../../src/theme/themes';
import { EMAIL_THEME_TOKENS, emailThemeTokens, fallbackThemeForEdition } from '../../functions/src/dailyEmailTheme';
import {
  buildDailyEmailModel,
  registerFor,
  standingsThrough,
  formatDayDate,
  formatUnlockTime,
  type EmailDay,
  type EmailEvent,
  type EmailPlayer,
} from '../../functions/src/dailyEmailContent';
import { renderDailyEmailHtml, renderDailyEmailText, safeUrl } from '../../functions/src/dailyEmailTemplate';
import {
  dailyEmailEnabled,
  dueDayForDailyEmail,
  resolveEventOrigin,
  sanitizeEmailDayStats,
  sendDailyEmailForEvent,
  shouldSendTo,
  SEND_WINDOW_MS,
  type DailyEmailFirestore,
} from '../../functions/src/dailyEmail';
import type { EmailPayload } from '../../functions/src/email';

// Covers specs/daily-engagement-email.md, functions layer: the Day-Theme token
// mirror, the per-Edition content model, the email-safe template, and the
// scheduled send's due/suppression decisions. Every SDK dependency is injected
// (pure logic + DI), so no live Resend, Firestore or Auth is touched.

// --- Fixtures -------------------------------------------------------------------

const H8 = 8 * 60 * 60 * 1000;
/** 2026-07-18T06:00:00Z = 08:00 Europe/Rome, the Day-4 unlock. */
const DAY4_UNLOCK = Date.parse('2026-07-18T06:00:00Z');

const gcbDay4: EmailDay = {
  index: 3,
  date: '2026-07-18',
  port: 'Valletta',
  portEmoji: '🇲🇹',
  theme: 'sporty-splash',
  tonight: ['💦 Splash T-Dance', '🏋️ Get Sporty'],
  pool: 'main',
  tutorial: false,
  unlockAt: DAY4_UNLOCK,
};

const gcbEvent: EmailEvent = {
  name: 'Trieste → Barcelona',
  timezone: 'Europe/Rome',
  days: [
    { index: 0, unlockAt: DAY4_UNLOCK - 3 * 24 * 60 * 60 * 1000, theme: 'welcome-aboard' },
    { index: 1, unlockAt: DAY4_UNLOCK - 2 * 24 * 60 * 60 * 1000, theme: 'duty-free' },
    { index: 2, unlockAt: DAY4_UNLOCK - 24 * 60 * 60 * 1000, theme: 'glamiators' },
    gcbDay4,
  ],
  settings: { dailyEmailEnabled: true },
};

const roster: EmailPlayer[] = [
  {
    uid: 'jess',
    displayName: 'Jess',
    bingoCount: 4,
    squaresMarked: 41,
    firstBingoAt: 100,
    dayStats: {
      0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 100 },
      1: { bingoCount: 2, squaresMarked: 17, firstBingoAt: 400 },
      2: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 900 },
    },
  },
  {
    uid: 'marco',
    displayName: 'Marco',
    bingoCount: 3,
    squaresMarked: 38,
    firstBingoAt: 250,
    dayStats: {
      0: { bingoCount: 1, squaresMarked: 14, firstBingoAt: 250 },
      1: { bingoCount: 1, squaresMarked: 12, firstBingoAt: null },
      2: { bingoCount: 1, squaresMarked: 12, firstBingoAt: null },
    },
  },
  {
    uid: 'dan',
    displayName: 'Dan',
    bingoCount: 3,
    squaresMarked: 33,
    firstBingoAt: 700,
    dayStats: {
      0: { bingoCount: 1, squaresMarked: 11, firstBingoAt: 700 },
      1: { bingoCount: 1, squaresMarked: 11, firstBingoAt: null },
      2: { bingoCount: 1, squaresMarked: 11, firstBingoAt: null },
    },
  },
  {
    uid: 'theo',
    displayName: 'Theo Baptiste',
    bingoCount: 1,
    squaresMarked: 19,
    firstBingoAt: 5000,
    dayStats: {
      0: { bingoCount: 0, squaresMarked: 6, firstBingoAt: null },
      1: { bingoCount: 1, squaresMarked: 7, firstBingoAt: 5000 },
      2: { bingoCount: 0, squaresMarked: 6, firstBingoAt: null },
    },
  },
];

const build = (over: Partial<Parameters<typeof buildDailyEmailModel>[0]> = {}) =>
  buildDailyEmailModel({
    event: gcbEvent,
    day: gcbDay4,
    players: roster,
    recipient: { uid: 'theo', displayName: 'Theo Baptiste' },
    edition: 'gcb',
    feedUrl: 'https://gaycruisebingo.com/feed',
    unsubscribeUrl: 'https://example.com/u?e=med-2026&u=theo&t=abc',
    preferencesUrl: 'https://example.com/u?e=med-2026&u=theo&t=abc&a=preferences',
    ...over,
  });

// --- ① The Theme token mirror ---------------------------------------------------

describe('Day-Theme token mirror (parity with the app)', () => {
  const cssPath = fileURLToPath(new URL('../../src/theme/themes.css', import.meta.url));
  const css = readFileSync(cssPath, 'utf8');

  /** Every `[data-theme='id']` block's tokens, plus the `:root` twin that holds
   *  the default Theme's palette. */
  const cssTokens = (): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {};
    const read = (id: string, body: string) => {
      const t: Record<string, string> = {};
      for (const key of ['bg', 'panel', 'ink', 'dim', 'primary', 'secondary', 'accent']) {
        const m = new RegExp(`--${key}:\\s*([^;]+);`).exec(body);
        if (m) t[key] = m[1].trim();
      }
      out[id] = t;
    };
    const rootBlock = /:root,\s*\n\[data-theme='([^']+)'\]\s*\{([\s\S]*?)\n\}/.exec(css);
    if (rootBlock) read(rootBlock[1], rootBlock[2]);
    for (const m of css.matchAll(/\[data-theme='([^']+)'\]\s*\{([\s\S]*?)\n\}/g)) {
      if (!out[m[1]]) read(m[1], m[2]);
    }
    return out;
  };

  it('covers exactly the app Theme registry — no Theme added or dropped on one side', () => {
    expect(Object.keys(EMAIL_THEME_TOKENS).sort()).toEqual(THEMES.map((t) => t.id).sort());
  });

  it('carries each Theme label and emoji verbatim from src/theme/themes.ts', () => {
    for (const theme of THEMES) {
      const mirrored = EMAIL_THEME_TOKENS[theme.id];
      expect({ id: theme.id, label: mirrored.label, emoji: mirrored.emoji }).toEqual({
        id: theme.id,
        label: theme.label,
        emoji: theme.emoji,
      });
    }
  });

  it('carries each palette hex verbatim from src/theme/themes.css', () => {
    const fromCss = cssTokens();
    for (const theme of THEMES) {
      const mirrored = EMAIL_THEME_TOKENS[theme.id];
      const source = fromCss[theme.id];
      expect(source, `no themes.css block for ${theme.id}`).toBeTruthy();
      for (const key of ['bg', 'panel', 'ink', 'dim', 'primary', 'secondary', 'accent'] as const) {
        expect(`${theme.id}.${key}=${mirrored[key]}`).toBe(`${theme.id}.${key}=${source[key]}`);
      }
    }
  });

  it('mirrors only literal hex — a mail client resolves no CSS variable and no rgba()', () => {
    for (const tokens of Object.values(EMAIL_THEME_TOKENS)) {
      for (const key of ['bg', 'panel', 'ink', 'dim', 'primary', 'secondary', 'accent'] as const) {
        expect(tokens[key]).toMatch(/^#[0-9a-f]{3,8}$/i);
      }
    }
  });

  it('falls back to the default Theme for an unknown id, and does not treat an inherited key as a Theme', () => {
    expect(emailThemeTokens('sporty-splash').label).toBe('Sporty Splash');
    expect(emailThemeTokens('no-such-theme').label).toBe('Neon Playground');
    expect(emailThemeTokens(undefined).label).toBe('Neon Playground');
    // `Object.prototype` inheritance is the #597 class of bug: a bare index
    // read would answer truthy here and ship `constructor` as a "Theme".
    expect(emailThemeTokens('constructor').label).toBe('Neon Playground');
    expect(emailThemeTokens('toString').label).toBe('Neon Playground');
  });

  it('falls back to the EDITION default, so a degraded Day never wears another product’s skin', () => {
    // A Vacay Event whose Day lost its Theme must not open in Gay Cruise
    // Bingo's Neon Playground — the one-identity rule (Codex #623 P2).
    expect(emailThemeTokens('no-such-theme', 'vacay').label).toBe('The Birds Have Entered the Group Chat');
    expect(emailThemeTokens(undefined, 'fiveacross').label).toBe('Marquee');
    expect(emailThemeTokens('constructor', 'vacay').label).toBe('The Birds Have Entered the Group Chat');
    expect(emailThemeTokens(undefined, 'no-such-edition').label).toBe('Neon Playground');
  });

  it('mirrors the app’s per-Edition default Theme', () => {
    for (const edition of ['gcb', 'vacay', 'fiveacross']) {
      expect(`${edition}=${fallbackThemeForEdition(edition)}`).toBe(
        `${edition}=${defaultThemeForEdition(edition)}`,
      );
    }
  });
});

// --- ② Standings ----------------------------------------------------------------

describe('standingsThrough', () => {
  it('sums only the Days BEFORE the Day being mailed — today has just unlocked', () => {
    const ranked = standingsThrough(roster, 3);
    expect(ranked.map((p) => p.uid)).toEqual(['jess', 'marco', 'dan', 'theo']);
    expect(ranked[0]).toMatchObject({ bingoCount: 4, squaresMarked: 41 });
    // Day 2 excluded when mailing Day 3 (index 2).
    const throughDay2 = standingsThrough(roster, 2);
    expect(throughDay2[0]).toMatchObject({ uid: 'jess', bingoCount: 3, squaresMarked: 29 });
  });

  it('ranks by the shared comparator — bingos, then squares, then earliest first bingo', () => {
    // Marco and Dan tie on bingos; Marco leads on squares.
    const ranked = standingsThrough(roster, 3);
    expect(ranked[1].uid).toBe('marco');
    expect(ranked[2].uid).toBe('dan');
  });

  it('keeps a legacy roster row with no dayStats on its root aggregates', () => {
    const legacy: EmailPlayer = {
      uid: 'legacy',
      displayName: 'Legacy',
      bingoCount: 9,
      squaresMarked: 90,
      firstBingoAt: 1,
    };
    expect(standingsThrough([legacy], 3)[0]).toMatchObject({ bingoCount: 9, squaresMarked: 90 });
  });

  it('excludes Tutorial Days from the ⭐ and its tie-break, while still counting their score', () => {
    // ADR 0011 / `eventFirstBingoAt`: an embark-Day bingo is real score but must
    // not take the Event-wide honor, or the email and the in-app Leaderboard
    // name different people (Codex #623 P2).
    const tutorialWinner: EmailPlayer = {
      uid: 'early',
      displayName: 'Early',
      bingoCount: 1,
      squaresMarked: 10,
      firstBingoAt: 10,
      dayStats: { 0: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 10 } },
    };
    const realWinner: EmailPlayer = {
      uid: 'real',
      displayName: 'Real',
      bingoCount: 1,
      squaresMarked: 10,
      firstBingoAt: 900,
      dayStats: { 1: { bingoCount: 1, squaresMarked: 10, firstBingoAt: 900 } },
    };
    const players = [tutorialWinner, realWinner];
    // With Day 0 flagged tutorial, the tutorial bingo still counts for score…
    const withTutorial = standingsThrough(players, 2, new Set([0]));
    expect(withTutorial.find((p) => p.uid === 'early')).toMatchObject({ bingoCount: 1, squaresMarked: 10 });
    // …but carries no first-BINGO timestamp, so the ⭐ goes to the real winner.
    expect(withTutorial.find((p) => p.uid === 'early')?.firstBingoAt).toBeNull();
    expect(withTutorial.find((p) => p.uid === 'real')?.firstBingoAt).toBe(900);
    // Without the exclusion the tutorial timestamp wins — the old behaviour.
    expect(standingsThrough(players, 2).find((p) => p.uid === 'early')?.firstBingoAt).toBe(10);
  });

  it('carries the Event’s Tutorial Days through the model, so the rendered ⭐ agrees', () => {
    // Ada leads the standings and got the earliest bingo of all — but only on
    // the embark Day. Bo's is the earliest that counts.
    const players: EmailPlayer[] = [
      {
        uid: 'ada',
        displayName: 'Ada',
        bingoCount: 2,
        squaresMarked: 20,
        firstBingoAt: 10,
        dayStats: {
          0: { bingoCount: 1, squaresMarked: 12, firstBingoAt: 10 },
          1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: null },
        },
      },
      {
        uid: 'bo',
        displayName: 'Bo',
        bingoCount: 2,
        squaresMarked: 15,
        firstBingoAt: 500,
        dayStats: {
          0: { bingoCount: 1, squaresMarked: 7, firstBingoAt: null },
          1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: 500 },
        },
      },
    ];
    const days: EmailDay[] = [
      { index: 0, unlockAt: 1, tutorial: true },
      { index: 1, unlockAt: 2 },
      gcbDay4,
    ];
    const starOf = (event: EmailEvent) =>
      build({ event, players, recipient: { uid: 'ada', displayName: 'Ada' } }).standings.rows.find(
        (r) => r.starred,
      )?.displayName;
    // Ada still leads on score (the tutorial bingo counts) — but the ⭐ is Bo's.
    expect(starOf({ ...gcbEvent, days })).toBe('Bo');
    // Drop the tutorial flag and the honor follows the raw timestamp again,
    // which is exactly the disagreement ADR 0011 forbids.
    expect(starOf({ ...gcbEvent, days: days.map((d) => ({ ...d, tutorial: false })) })).toBe('Ada');
  });

  it('survives a malformed dayStats row rather than taking the whole send down', () => {
    // `players/{uid}` is self-writable (ADR 0001), so this shape is reachable
    // by any participant (Codex #623 P2).
    const hostile = [
      { uid: 'a', displayName: 'A', bingoCount: 0, squaresMarked: 0, firstBingoAt: null, dayStats: { 0: null } },
      { uid: 'b', displayName: 'B', bingoCount: 0, squaresMarked: 0, firstBingoAt: null, dayStats: { 0: { bingoCount: 'lots' } } },
      { uid: 'c', displayName: 'C', bingoCount: 0, squaresMarked: 0, firstBingoAt: null, dayStats: { junk: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1 } } },
    ] as unknown as EmailPlayer[];
    expect(() => standingsThrough(hostile, 3)).not.toThrow();
    expect(standingsThrough(hostile, 3).map((p) => p.bingoCount)).toEqual([0, 0, 0]);
  });

  it('sanitizes dayStats at the read boundary, dropping every malformed entry', () => {
    expect(sanitizeEmailDayStats({ 0: { bingoCount: 1, squaresMarked: 2, firstBingoAt: 3 } })).toEqual({
      0: { bingoCount: 1, squaresMarked: 2, firstBingoAt: 3 },
    });
    expect(sanitizeEmailDayStats({ 0: null })).toBeUndefined();
    expect(sanitizeEmailDayStats({ 0: { bingoCount: 'x', squaresMarked: 1 } })).toBeUndefined();
    expect(sanitizeEmailDayStats({ nope: { bingoCount: 1, squaresMarked: 1, firstBingoAt: 1 } })).toBeUndefined();
    expect(sanitizeEmailDayStats([1, 2])).toBeUndefined();
    expect(sanitizeEmailDayStats('nope')).toBeUndefined();
    // A partly-valid map keeps only its good entries.
    expect(sanitizeEmailDayStats({ 0: null, 1: { bingoCount: 1, squaresMarked: 1 } })).toEqual({
      1: { bingoCount: 1, squaresMarked: 1, firstBingoAt: null },
    });
  });

  it('reports an all-zero board as the empty state, not a podium of ties', () => {
    const fresh = roster.map((p) => ({ ...p, dayStats: { 0: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } }));
    const model = build({ players: fresh, day: { ...gcbDay4, index: 0 }, event: { ...gcbEvent, days: [{ ...gcbDay4, index: 0 }] } });
    expect(model.standings.rows).toEqual([]);
    expect(model.standings.emptyLine).toContain('No standings yet');
    expect(model.standings.youLine).toBeNull();
  });
});

// --- ③ Edition registers --------------------------------------------------------

describe('Edition registers (#608 lexicon)', () => {
  it('gives each Edition its own occasion noun and photos nudge', () => {
    expect(registerFor('gcb').occasion).toBe('cruise');
    expect(registerFor('vacay').occasion).toBe('trip');
    expect(registerFor('fiveacross').occasion).toBe('event');
    expect(registerFor('gcb').photosLead).toContain('rumor');
    expect(registerFor('vacay').photosRest).toContain('group chat');
  });

  it('carries the endorsement line on Vacay only (the one-identity rule)', () => {
    expect(registerFor('vacay').brandLine).toBe('Vacay Bingo · by Five Across');
    expect(registerFor('gcb').brandLine).toBe('Gay Cruise Bingo');
    expect(registerFor('fiveacross').brandLine).toBe('Five Across');
  });

  it('degrades an unknown or inherited Edition key to the legacy Edition', () => {
    expect(registerFor('nope').brandLine).toBe('Gay Cruise Bingo');
    expect(registerFor(null).brandLine).toBe('Gay Cruise Bingo');
    expect(registerFor('constructor').brandLine).toBe('Gay Cruise Bingo');
  });
});

// --- ④ The assembled model ------------------------------------------------------

describe('buildDailyEmailModel', () => {
  it('renders the mid-cruise Day 4 case from the wireframe (#fx-email-gcb)', () => {
    const model = build();
    expect(model.themeHeadline).toBe('💦 Sporty Splash');
    expect(model.contextLine).toBe('Day 4 of 4 · Saturday, Jul 18 · 🇲🇹 Valletta');
    expect(model.standings.heading).toBe('Standings · through Day 3');
    expect(model.standings.rows.map((r) => r.displayName)).toEqual(['Jess', 'Marco', 'Dan']);
    expect(model.standings.rows[0].starred).toBe(true); // ⭐ earliest first BINGO
    expect(model.standings.rows[1].starred).toBe(false);
    expect(model.nudgeLine).toContain('Morning, Theo.');
    expect(model.nudgeLine).toContain('The boat docks in Valletta today');
    expect(model.tonightLine).toBe('💦 Splash T-Dance · 🏋️ Get Sporty');
    expect(model.awardLead).toBe('most-loved photo of the cruise');
    expect(model.ctaLabel).toBe('Open the Feed');
    expect(model.footerWhyLine).toContain('Trieste → Barcelona');
  });

  it('personalizes exactly one line — the recipient rank — and nothing else', () => {
    const theo = build();
    const dan = build({ recipient: { uid: 'dan', displayName: 'Dan' } });
    expect(theo.standings.youLine).toContain("You're #4");
    expect(dan.standings.youLine).toContain("You're #3");
    // Everything outside the greeting and the rank line is byte-identical.
    expect({ ...theo, standings: { ...theo.standings, youLine: null }, nudgeLine: '' }).toEqual({
      ...dan,
      standings: { ...dan.standings, youLine: null },
      nudgeLine: '',
    });
  });

  it('uses a precomputed standings slice when the sender passes one, and matches the computed answer', () => {
    // The cost lever the sender pulls: the snapshot is identical for every
    // recipient, so it is computed once per send rather than once per email.
    const ranked = standingsThrough(roster, gcbDay4.index);
    expect(build({ ranked })).toEqual(build());
  });

  it('does not claim the occasion "starts today" on a LATER empty Day', () => {
    const dead = roster.map((p) => ({ ...p, dayStats: { 0: { bingoCount: 0, squaresMarked: 0, firstBingoAt: null } } }));
    const day1 = build({ players: dead, day: { ...gcbDay4, index: 0 }, event: { ...gcbEvent, days: [{ ...gcbDay4, index: 0 }] } });
    expect(day1.standings.emptyLine).toContain('the cruise starts today');
    // Day 4 with an empty board is a different fact — the honors are open, but
    // the cruise plainly did not start today (Codex #623 P2).
    const day4 = build({ players: dead });
    expect(day4.standings.emptyLine).not.toContain('starts today');
    expect(day4.standings.emptyLine).toContain('wide open');
    expect(day4.standings.emptyLine).toContain('⭐ cruise-wide honor');
  });

  it('omits the rank line for an address that is not on the roster', () => {
    expect(build({ recipient: { uid: 'ghost', displayName: 'Ghost' } }).standings.youLine).toBeNull();
  });

  it('renders the Bodega Day 1 empty state in the trip register (#fx-email-vacay)', () => {
    const day1: EmailDay = {
      index: 0,
      date: '2026-08-07',
      port: 'Bodega Bay',
      theme: 'the-birds',
      tonight: ['🍷 Deck wine', '🎬 The Birds on the living-room wall'],
      unlockAt: Date.parse('2026-08-07T15:00:00Z'),
    };
    const model = buildDailyEmailModel({
      event: {
        name: 'Weekend in Bodega Bay',
        timezone: 'America/Los_Angeles',
        days: [day1, { index: 1, unlockAt: day1.unlockAt + 86400000 }, { index: 2, unlockAt: day1.unlockAt + 172800000 }],
        settings: { dailyEmailEnabled: true },
      },
      day: day1,
      players: [{ uid: 'maya', displayName: 'Maya', bingoCount: 0, squaresMarked: 0, firstBingoAt: null }],
      recipient: { uid: 'maya', displayName: 'Maya' },
      edition: 'vacay',
      feedUrl: 'https://bodega-bay.fiveacross.app/feed',
      unsubscribeUrl: 'https://example.com/u',
      preferencesUrl: 'https://example.com/u?a=preferences',
    });
    expect(model.themeHeadline).toBe('🐦 The Birds Have Entered the Group Chat');
    expect(model.contextLine).toBe('Day 1 of 3 · Friday, Aug 7 · Bodega Bay');
    expect(model.standings.heading).toBe('Standings · Day 1');
    expect(model.standings.emptyLine).toContain('the trip starts today');
    expect(model.standings.emptyLine).toContain('⭐ trip-wide honor');
    expect(model.nudgeLine).toContain('The group lands in Bodega Bay today');
    expect(model.nudgeLine).toContain('8:00 a.m.'); // 15:00Z is 08:00 Pacific
    expect(model.awardLead).toBe('most-loved photo of the trip');
    expect(model.subject).toBe('Day 1 · The Birds Have Entered the Group Chat 🐦 — your card is live');
  });

  it('drops the Place from the context line and the morning line when a Day names none', () => {
    const atSea = { ...gcbDay4, port: '', portEmoji: '' };
    const model = build({ day: atSea });
    expect(model.contextLine).toBe('Day 4 of 4 · Saturday, Jul 18');
    expect(model.nudgeLine).toContain('A day at sea today');
  });

  it('formats the unlock time in the EVENT timezone, and survives a bogus one', () => {
    expect(formatUnlockTime(DAY4_UNLOCK, 'Europe/Rome')).toBe('8:00 a.m.');
    expect(formatUnlockTime(DAY4_UNLOCK, 'Not/AZone')).toBe('6:00 a.m.'); // falls back to UTC
  });

  it('renders the Day date as the calendar label it already is, with no second offset applied', () => {
    // `DayDef.date` is ALREADY the Event's local date. Re-applying a zone shifts
    // it past ±12h: `Pacific/Kiritimati` is UTC+14, where noon UTC is the next
    // day (Codex #623 P2). The weekday must be the one on the Event's calendar.
    expect(formatDayDate('2026-07-18')).toBe('Saturday, Jul 18');
    expect(formatDayDate(undefined)).toBe('');
    expect(formatDayDate('not-a-date')).toBe('');
    const farEast: EmailDay = { ...gcbDay4, date: '2026-07-18', unlockAt: Date.parse('2026-07-17T18:00:00Z') };
    const model = build({ day: farEast, event: { ...gcbEvent, timezone: 'Pacific/Kiritimati' } });
    expect(model.contextLine).toContain('Saturday, Jul 18');
  });
});

// --- ⑤ The template -------------------------------------------------------------

describe('renderDailyEmailHtml (email-safe constraints)', () => {
  const html = renderDailyEmailHtml(build());

  it('is a 600px single-column table layout with no flexbox or grid', () => {
    expect(html).toContain('width="600"');
    expect(html).toContain('max-width:100%');
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });

  it('paints in literal hex only — never a CSS variable', () => {
    expect(html).not.toContain('var(--');
    expect(html).toContain('#33c6ff'); // sporty-splash --primary
    expect(html).toContain('#0a1c26'); // sporty-splash --panel
  });

  it('gives every module an explicit background AND ink so dark-mode inversion has nothing unmanaged to grab', () => {
    // Each content module declares both, and the document declares its schemes.
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('name="supported-color-schemes"');
    const modules = html.match(/background-color:#[0-9a-f]{6};color:#[0-9a-f]{6};/gi) ?? [];
    expect(modules.length).toBeGreaterThanOrEqual(3); // standings, nudge, photos
    expect(html).not.toMatch(/<td(?![^>]*bgcolor)[^>]*style="[^"]*color:#[0-9a-f]{6}[^"]*"[^>]*>\s*<div style="font-family:[^"]*font-size:15px/);
  });

  it('declares the display stack so it survives the Bebas Neue fallback', () => {
    expect(html).toContain("'Bebas Neue','Arial Narrow',Arial");
  });

  it('builds a bulletproof CTA — a padded bordered cell plus the Outlook VML fill, never an image', () => {
    expect(html).toContain('v:roundrect');
    expect(html).toContain('<!--[if mso]>');
    expect(html).toContain('Open the Feed');
    expect(html).not.toContain('<img');
  });

  it('hides the preheader in the body and pads it so the header copy cannot leak in beside it', () => {
    expect(html).toMatch(/display:none;font-size:1px/);
    expect(html).toContain('Day 4: Sporty Splash—standings through Day 3 inside.');
    expect(html).toContain('&#8203;');
  });

  it('carries the visible unsubscribe and preferences links', () => {
    expect(html).toContain('>Unsubscribe</a>');
    expect(html).toContain('>Email preferences</a>');
  });

  it('escapes Firestore-sourced copy rather than interpolating it raw', () => {
    const hostile = renderDailyEmailHtml(
      build({
        players: [{ uid: 'x', displayName: '<script>alert(1)</script>', bingoCount: 2, squaresMarked: 9, firstBingoAt: 1 }],
        recipient: { uid: 'x', displayName: '<script>alert(1)</script>' },
      }),
    );
    expect(hostile).not.toContain('<script>alert(1)</script>');
    expect(hostile).toContain('&lt;script&gt;');
  });

  it('renders the light Theme too — the case dark-mode inversion is most likely to wreck', () => {
    const light = renderDailyEmailHtml(build({ day: { ...gcbDay4, theme: 'fog-froth-farewells' } }));
    expect(light).toContain('#efece4'); // --bg, a LIGHT ground
    expect(light).toContain('#33302b'); // --ink, dark text on it
    expect(light).not.toContain('var(--');
  });

  it('refuses a non-https link rather than emitting it', () => {
    expect(safeUrl('https://example.com/feed')).toBe('https://example.com/feed');
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('http://example.com')).toBe('#');
    expect(safeUrl('not a url')).toBe('#');
    expect(renderDailyEmailHtml(build({ feedUrl: 'javascript:alert(1)' }))).not.toContain('javascript:');
  });
});

describe('renderDailyEmailText (the plain-text mirror)', () => {
  it('carries the same modules in the same order', () => {
    const text = renderDailyEmailText(build());
    const order = [
      'Sporty Splash',
      'STANDINGS · THROUGH DAY 3',
      '1. Jess',
      "You're #4",
      'TODAY',
      'Morning, Theo.',
      'PHOTOS',
      'most-loved photo of the cruise',
      'Open the Feed: https://gaycruisebingo.com/feed',
      'Unsubscribe: https://example.com/u',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = text.indexOf(needle);
      expect(`${needle} present`).toBe(at >= 0 ? `${needle} present` : `${needle} MISSING`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('renders the empty standings state as prose, not an empty list', () => {
    const day1 = { ...gcbDay4, index: 0 };
    const text = renderDailyEmailText(
      build({
        day: day1,
        event: { ...gcbEvent, days: [day1] },
        players: [{ uid: 'theo', displayName: 'Theo', bingoCount: 0, squaresMarked: 0, firstBingoAt: null }],
      }),
    );
    expect(text).toContain('No standings yet');
  });
});

// --- ⑥ The scheduled decisions --------------------------------------------------

describe('dailyEmailEnabled (the Event-level admin toggle)', () => {
  it('is OFF unless explicitly true', () => {
    expect(dailyEmailEnabled({ settings: { dailyEmailEnabled: true } })).toBe(true);
    expect(dailyEmailEnabled({ settings: { dailyEmailEnabled: false } })).toBe(false);
    expect(dailyEmailEnabled({ settings: {} })).toBe(false);
    expect(dailyEmailEnabled({})).toBe(false);
    expect(dailyEmailEnabled(undefined)).toBe(false);
  });
});

describe('dueDayForDailyEmail', () => {
  const days: EmailDay[] = [
    { index: 0, unlockAt: 1_000_000 },
    { index: 1, unlockAt: 1_000_000 + 86_400_000 },
  ];

  it('fires at the Day unlock and stays due for the send window', () => {
    expect(dueDayForDailyEmail(days, 1_000_000)?.index).toBe(0);
    expect(dueDayForDailyEmail(days, 1_000_000 + SEND_WINDOW_MS - 1)?.index).toBe(0);
  });

  it('does not fire before unlock, and never back-fills a Day already played', () => {
    expect(dueDayForDailyEmail(days, 999_999)).toBeNull();
    expect(dueDayForDailyEmail(days, 1_000_000 + SEND_WINDOW_MS)).toBeNull();
    expect(dueDayForDailyEmail(days, 1_000_000 + H8)).toBeNull();
  });

  it('ignores the unlockAt:0 "live pre-event" sentinel instead of mailing it forever (#289)', () => {
    expect(dueDayForDailyEmail([{ index: 0, unlockAt: 0 }], 5_000_000)).toBeNull();
    expect(dueDayForDailyEmail([{ index: 0, unlockAt: -1 }], 5_000_000)).toBeNull();
  });

  it('handles an absent or malformed schedule without throwing', () => {
    expect(dueDayForDailyEmail(undefined, 1)).toBeNull();
    expect(dueDayForDailyEmail([], 1)).toBeNull();
    expect(dueDayForDailyEmail([{ index: 0, unlockAt: Number.NaN }], 1)).toBeNull();
  });

  it('prefers the latest due Day when a schedule somehow overlaps', () => {
    const overlapping: EmailDay[] = [
      { index: 0, unlockAt: 1_000_000 },
      { index: 1, unlockAt: 1_000_100 },
    ];
    expect(dueDayForDailyEmail(overlapping, 1_000_200)?.index).toBe(1);
  });
});

describe('shouldSendTo (suppression)', () => {
  it('suppresses an opt-out, a repeat for the same Day, and a participant with no prefs doc', () => {
    expect(shouldSendTo({ optedOut: false }, 3)).toBe(true);
    expect(shouldSendTo({ optedOut: true }, 3)).toBe(false);
    expect(shouldSendTo({ optedOut: false, lastSentDayIndex: 3 }, 3)).toBe(false);
    expect(shouldSendTo({ optedOut: false, lastSentDayIndex: 4 }, 3)).toBe(false);
    expect(shouldSendTo({ optedOut: false, lastSentDayIndex: 2 }, 3)).toBe(true);
    expect(shouldSendTo(null, 3)).toBe(false);
  });
});

// --- ⑦ The send, end to end -----------------------------------------------------

type Docs = Record<string, Record<string, unknown>>;

/** A minimal in-memory stand-in for the admin-SDK surface `dailyEmail.ts`
 *  injects — doc get/set (with merge), and flat collection queries. */
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
    // Admin-SDK `create` semantics: refuses when the document already exists.
    create: async (data: Record<string, unknown>) => {
      if (docs[path] !== undefined) throw new Error('ALREADY_EXISTS');
      docs[path] = { ...data };
      return undefined;
    },
  });
  const query = (path: string, filters: Array<[string, unknown]>) => ({
    where: (field: string, _op: string, value: unknown) => query(path, [...filters, [field, value]]),
    get: async () => ({
      docs: Object.keys(docs)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map(snapshotOf)
        .filter((s) => filters.every(([field, value]) => (s.data() ?? {})[field] === value)),
    }),
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

const seedEvent = (settings: Record<string, unknown> = { dailyEmailEnabled: true }): Docs => ({
  'events/med-2026': {
    name: 'Trieste → Barcelona',
    status: 'active',
    timezone: 'Europe/Rome',
    days: gcbEvent.days,
    settings,
  },
  'events/med-2026/players/theo': { displayName: 'Theo', bingoCount: 1, squaresMarked: 19, firstBingoAt: 5000 },
  'events/med-2026/players/jess': { displayName: 'Jess', bingoCount: 4, squaresMarked: 41, firstBingoAt: 100 },
  'hostnames/gaycruisebingo.com': {
    eventId: 'med-2026',
    canonicalHost: 'gaycruisebingo.com',
    edition: 'gcb',
    status: 'active',
    isCanonical: true,
  },
});

/** The injected environment every send test shares: a fixed clock inside the
 *  Day-4 window, a fixed token, and no pacing. */
const baseDeps = () => ({
  now: () => DAY4_UNLOCK + 60_000,
  from: 'Gay Cruise Bingo <bingo@example.com>',
  appBaseUrl: 'https://fallback.example.com',
  unsubscribeBaseUrl: 'https://fn.example.com/emailUnsubscribe',
  getEmailForUid: async (uid: string) => `${uid}@example.com`,
  mintToken: () => 'tok-fixed',
  pacingMs: 0,
});

type CapturedSend = EmailPayload & { idempotencyKey: string };

describe('sendDailyEmailForEvent', () => {
  const run = async (docs: Docs, over: Record<string, unknown> = {}) => {
    const sent: CapturedSend[] = [];
    const db = makeDb(docs);
    const result = await sendDailyEmailForEvent(db, 'med-2026', {
      ...baseDeps(),
      send: async (args) => {
        sent.push({
          from: args.from ?? '',
          to: args.to,
          subject: args.subject,
          html: args.html,
          text: args.text,
          headers: args.headers,
          idempotencyKey: args.idempotencyKey,
        });
        return true;
      },
      ...over,
    });
    return { result, sent, db };
  };

  it('sends one themed email per participant, with RFC 8058 headers and a per-recipient idempotency key', async () => {
    const { result, sent } = await run(seedEvent());
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['jess@example.com', 'theo@example.com']);
    expect(sent[0].subject).toContain('Day 4 · Sporty Splash 💦');
    expect(sent[0].headers?.['List-Unsubscribe']).toBe(
      '<https://fn.example.com/emailUnsubscribe?e=med-2026&u=theo&t=tok-fixed&a=unsubscribe>',
    );
    expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent.map((m) => m.idempotencyKey).sort()).toEqual([
      'daily-email/med-2026/3/jess',
      'daily-email/med-2026/3/theo',
    ]);
    // The Feed CTA deep-links the Event's CANONICAL host, not the fallback.
    expect(sent[0].text).toContain('Open the Feed: https://gaycruisebingo.com/feed');
  });

  it('sends nothing when the Event-level admin toggle is off (the shipped default)', async () => {
    expect((await run(seedEvent({}))).result).toMatchObject({ sent: 0, reason: 'disabled' });
    expect((await run(seedEvent({ dailyEmailEnabled: false }))).result).toMatchObject({ reason: 'disabled' });
  });

  it('sends nothing outside the due window, and nothing for a missing Event', async () => {
    expect((await run(seedEvent(), { now: () => DAY4_UNLOCK - 1 })).result).toMatchObject({ reason: 'not-due' });
    expect((await run(seedEvent(), { now: () => DAY4_UNLOCK + SEND_WINDOW_MS })).result).toMatchObject({
      reason: 'not-due',
    });
    const empty = makeDb({});
    expect(
      await sendDailyEmailForEvent(empty, 'nope', { ...baseDeps(), send: async () => true }),
    ).toMatchObject({ reason: 'no-event' });
  });

  it('is idempotent — a second sweep inside the same window sends nothing', async () => {
    const docs = seedEvent();
    const first = await run(docs);
    expect(first.result.sent).toBe(2);
    const second = await run(first.db.docs);
    expect(second.result).toMatchObject({ sent: 0, skipped: 2 });
  });

  it('suppresses an opted-out participant BEFORE looking their address up', async () => {
    const docs = seedEvent();
    docs['events/med-2026/emailPrefs/theo'] = { optedOut: true, token: 'tok-fixed' };
    const looked: string[] = [];
    const { result, sent } = await run(docs, {
      getEmailForUid: async (uid: string) => {
        looked.push(uid);
        return `${uid}@example.com`;
      },
    });
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(sent.map((m) => m.to[0])).toEqual(['jess@example.com']);
    expect(looked).toEqual(['jess']); // theo's address was never resolved
  });

  it('skips a participant with no verified email rather than failing the run', async () => {
    const { result, sent } = await run(seedEvent(), {
      getEmailForUid: async (uid: string) => (uid === 'theo' ? null : `${uid}@example.com`),
    });
    expect(result).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('counts a transport failure without marking the Day sent, so the next sweep retries', async () => {
    const docs = seedEvent();
    const db = makeDb(docs);
    const result = await sendDailyEmailForEvent(db, 'med-2026', {
      ...baseDeps(),
      send: async () => false,
    });
    expect(result).toMatchObject({ sent: 0, failed: 2 });
    expect(db.docs['events/med-2026/emailPrefs/theo']).not.toHaveProperty('lastSentDayIndex');
  });

  it('excludes banned participants from both the roster and the standings', async () => {
    const docs = seedEvent();
    (docs['events/med-2026'] as Record<string, unknown>).bannedUids = ['jess'];
    const { result, sent } = await run(docs);
    expect(result.sent).toBe(1);
    expect(sent[0].to).toEqual(['theo@example.com']);
    expect(sent[0].html).not.toContain('Jess');
  });

  it('honours the recipient cap as a runaway guard', async () => {
    const { result } = await run(seedEvent(), { maxRecipients: 1 });
    expect(result.sent).toBe(1);
  });
});

describe('resolveEventOrigin', () => {
  it('prefers the canonical active hostname (#599)', async () => {
    const db = makeDb({
      'hostnames/alias.example.com': { eventId: 'e1', canonicalHost: 'alias.example.com', edition: 'gcb', status: 'active' },
      'hostnames/canon.example.com': {
        eventId: 'e1',
        canonicalHost: 'canon.example.com',
        edition: 'vacay',
        status: 'active',
        isCanonical: true,
      },
    });
    expect(await resolveEventOrigin(db, 'e1', 'https://fallback')).toEqual({
      origin: 'https://canon.example.com',
      edition: 'vacay',
    });
  });

  it('ignores non-active mappings and falls back when the Event has none', async () => {
    const db = makeDb({
      'hostnames/old.example.com': { eventId: 'e1', canonicalHost: 'old.example.com', status: 'archived', isCanonical: true },
    });
    expect(await resolveEventOrigin(db, 'e1', 'https://fallback')).toEqual({
      origin: 'https://fallback',
      edition: null,
    });
    expect(await resolveEventOrigin(makeDb({}), 'e1', 'https://fallback')).toEqual({
      origin: 'https://fallback',
      edition: null,
    });
  });
});
