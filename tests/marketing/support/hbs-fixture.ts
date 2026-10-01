// HBS spring 2027 mockup fixture (plans/hbs-spring-2027.md,
// docs/app/marketing-screenshots.md § "The HBS weekly mockups").
//
// A MOCKUP of a proposed Event, not a seed of it. It seeds a self-contained
// demo Event into the Firestore emulator so the real app can be photographed
// wearing the plan's content: sixteen weekly Days, the week titles, the Themes,
// the free spaces and the "this week" lines, all verbatim from the plan.
//
// Selected by `HERO_EVENT=hbs` (the same way `HERO_EDITION` selects chrome); the
// default marketing run never reads it. Pair it with `HERO_EDITION=fiveacross`.
//
// What it is NOT:
//   - Not a pool. Only the 24 prompts of the one card on screen are seeded: the
//     plan's planned split of 12 easy, 6 themed (Week 12) and 6 evergreen, so
//     `dealBoard` deals exactly that composition. The real pools and the T3
//     themed reserve do not exist yet; the captions say so.
//   - Not weekly copy. The UI still says "Day 12", "today" and "Tonight",
//     because the cadence vocabulary is plan ticket T1.
//
// The same three safety rules as fixture.ts hold: invented display names, a
// general-audience pool (every prompt is `spicy: false`), and no photo proofs.
import { doc, setDoc } from 'firebase/firestore';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain-JS seed script, no type declarations.
import { seedItemDocId } from '../../../scripts/seed.mjs';
import { HERO_EVENT_ID, HERO_PROJECT_ID } from './fixture';

export const HBS_TIMEZONE = 'America/New_York';

/** The page's frozen clock: Wednesday of Week 12, 6:00 p.m. Eastern (EDT, UTC-4). */
export const HBS_NOW = Date.UTC(2027, 3, 21, 22, 0, 0);
/** The Day index on screen: Week 12, Marathon Week. */
export const HBS_TODAY_INDEX = 11;
export const HBS_FIXED_SEED = 1212;

const HOUR = 3_600_000;

type Week = {
  date: string;
  place: string;
  placeEmoji: string;
  theme: 'marquee' | 'confetti-hour' | 'afterglow';
  freeText: string;
  tonight: [string, string];
};

/** The plan's weekly calendar, verbatim. `place` carries the week title. */
export const WEEKS: ReadonlyArray<Week> = [
  { date: '2027-01-25', place: 'Syllabus Week', placeEmoji: '📚', theme: 'marquee', freeText: 'New term, same section', tonight: ['🪑 New seats', '☕ First coffee chats'] },
  { date: '2027-02-01', place: 'Snow Day Energy', placeEmoji: '❄️', theme: 'afterglow', freeText: 'Survived the walk to class', tonight: ['🧤 Layers on', '🏮 Lunar New Year (Sat)'] },
  { date: '2027-02-08', place: 'Hearts & Spreadsheets', placeEmoji: '💘', theme: 'confetti-hour', freeText: 'In love with Exhibit 4', tonight: ['🍫 Candy everywhere', '💌 Valentine’s Day (Sun)'] },
  { date: '2027-02-15', place: 'Coffee Chat Season', placeEmoji: '☕', theme: 'marquee', freeText: 'Networking counts as cardio', tonight: ['🎩 Presidents’ Day (Mon)', '💼 Recruiting mode'] },
  { date: '2027-02-22', place: 'Conference Circuit', placeEmoji: '🎤', theme: 'confetti-hour', freeText: 'Lanyard acquired', tonight: ['🎤 Student conferences', '🥂 Receptions'] },
  { date: '2027-03-01', place: 'Halfway There', placeEmoji: '📈', theme: 'afterglow', freeText: 'Halfway through the term', tonight: ['📈 Midpoint', '📚 Catch-up mode'] },
  { date: '2027-03-08', place: 'Out of Office', placeEmoji: '✈️', theme: 'marquee', freeText: 'OOO in 3, 2, 1…', tonight: ['✈️ Treks take off', '🌴 Break starts Sat'] },
  { date: '2027-03-22', place: 'Back from Break', placeEmoji: '🧳', theme: 'confetti-hour', freeText: 'Tan lines in Aldrich', tonight: ['🧳 Welcome back', '🌇 Light past 7 p.m.'] },
  { date: '2027-03-29', place: 'Bracket Season', placeEmoji: '🏀', theme: 'marquee', freeText: 'My bracket is busted', tonight: ['🃏 April Fools’ (Thu)', '🏀 Final Four weekend'] },
  { date: '2027-04-05', place: 'Opening Day', placeEmoji: '⚾', theme: 'confetti-hour', freeText: 'Take me out to Fenway', tonight: ['⚾ Baseball’s back', '🌤️ Patio weather'] },
  { date: '2027-04-12', place: 'Spring on the Charles', placeEmoji: '🌸', theme: 'afterglow', freeText: 'First day without a coat', tonight: ['🌸 Blossoms', '🚣 Crews on the river'] },
  { date: '2027-04-19', place: 'Marathon Week', placeEmoji: '🏃', theme: 'marquee', freeText: '26.2 cases', tonight: ['🏃 Marathon Monday', '🌍 Earth Day (Thu)'] },
  { date: '2027-04-26', place: 'EC Last Call', placeEmoji: '🎓', theme: 'confetti-hour', freeText: 'Standing ovation', tonight: ['👏 Last EC classes', '📝 EC exams wrap (Wed)'] },
  { date: '2027-05-03', place: 'Home Stretch', placeEmoji: '🏁', theme: 'afterglow', freeText: 'Running on cold brew', tonight: ['🏁 Two weeks to go', '💐 Mother’s Day (Sun)'] },
  { date: '2027-05-10', place: 'Final Cases', placeEmoji: '📝', theme: 'marquee', freeText: 'One more case', tonight: ['📝 Last full week', '📸 Section photos'] },
  { date: '2027-05-17', place: 'Victory Lap', placeEmoji: '🎉', theme: 'afterglow', freeText: 'Section forever', tonight: ['🏆 Podium reveal', '🎓 Last RC classes'] },
];

/**
 * The one card on screen: the plan's planned Week 12 split, hand-picked from the
 * plan's real pools. Easy squares carry `pool: 'embark'` (the persisted legacy
 * spelling of the easy pool), which is what makes `dealBoard` treat them as the
 * easy half of the mix.
 */
const EASY_HALF = [
  'Hear the opening cold call',
  'Hear someone say "stakeholders"',
  'See a 2×2 matrix go up on the board',
  'See a name card fall over',
  'See ten hands shoot up at once',
  'Grab a coffee in Spangler',
  'Walk past Baker Library\'s bell tower',
  'Spot a quarter-zip in the wild',
  'Watch the group chat light up the night before a case',
  'Hear "It depends"',
  'Hear a phone buzz in class',
  'Hear "At the end of the day…"',
];
const MARATHON_SQUARES = [
  'Hear the Boston Marathon come up',
  'Spot a Boston Marathon jacket',
  'Cheer on Marathon runners, in person or on TV',
  'Hear "It\'s a marathon, not a sprint"',
  'Hear about someone\'s training run',
  'Hear someone say "finish line"',
];
const EVERGREEN_SQUARES = [
  'Hear Porter\'s Five Forces come up',
  'Hear "Let\'s double-click on that"',
  'See a vote split almost exactly down the middle',
  'Study in the Baker Library reading room',
  'Spot a dog on campus',
  'Watch the sun set over the Charles',
];

/** Squares shown as already marked: a few from each family, no completed line. */
export const HBS_MARKED_TEXTS: ReadonlySet<string> = new Set([
  MARATHON_SQUARES[0],
  MARATHON_SQUARES[3],
  MARATHON_SQUARES[5],
  EASY_HALF[0],
  EASY_HALF[5],
  EASY_HALF[9],
  EVERGREEN_SQUARES[4],
]);

export const HBS_POOL: ReadonlyArray<{ text: string; pool: 'embark' | 'main' }> = [
  ...EASY_HALF.map((text) => ({ text, pool: 'embark' as const })),
  ...[...MARATHON_SQUARES, ...EVERGREEN_SQUARES].map((text) => ({ text, pool: 'main' as const })),
];

/** Invented weekly play for Weeks 1–11, one row per player: [squares, bingos]. */
const PLAY: Record<string, ReadonlyArray<readonly [number, number]>> = {
  'hero-p1': [[14, 1], [12, 1], [15, 2], [13, 1], [16, 1], [12, 0], [10, 1], [13, 1], [15, 2], [14, 1], [13, 1]],
  'hero-p2': [[12, 1], [13, 0], [11, 1], [14, 1], [12, 0], [13, 1], [9, 0], [11, 1], [12, 1], [13, 0], [12, 1]],
  'hero-p3': [[10, 0], [11, 1], [13, 0], [9, 1], [12, 1], [10, 0], [8, 1], [12, 0], [11, 1], [10, 1], [12, 0]],
  'hero-p4': [[9, 0], [8, 0], [10, 1], [9, 0], [7, 0], [8, 1], [6, 0], [9, 0], [8, 0], [9, 1], [8, 0]],
};
/** This week so far (Wednesday evening): [squares, bingos]. */
const THIS_WEEK: Record<string, readonly [number, number]> = {
  'hero-p1': [9, 1],
  'hero-p2': [7, 0],
  'hero-p3': [8, 1],
  'hero-p4': [5, 0],
};
export const HBS_PLAYERS = [
  { uid: 'hero-p1', displayName: 'Rae M.' },
  { uid: 'hero-p2', displayName: 'Devon K.' },
  { uid: 'hero-p3', displayName: 'Priya S.' },
  { uid: 'hero-p4', displayName: 'Tomas L.' },
] as const;

/** Instant of `hour:00` Eastern on an ISO date, probing the zone so DST is right. */
export function easternInstant(isoDate: string, hour: number): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const zoned = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: HBS_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .format(new Date(guess))
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z'),
  ).getTime();
  return guess + (guess - zoned);
}

/** Every Day unlocks Monday 7:00 a.m. Eastern (the plan's cadence). */
export const unlockAt = (dayIndex: number): number => easternInstant(WEEKS[dayIndex].date, 7);

/** The Event's Day schedule, as the app (and the email templates) read it. */
export function hbsDays() {
  return WEEKS.map((w, index) => ({
    index,
    date: w.date,
    place: w.place,
    placeEmoji: w.placeEmoji,
    theme: w.theme,
    tonight: w.tonight,
    pool: index === WEEKS.length - 1 ? 'farewell' : 'main',
    tutorial: false,
    scoring: index === WEEKS.length - 1 ? 'ceremonial' : 'competitive',
    unlockAt: unlockAt(index),
    freeText: w.freeText,
    ...(index === HBS_TODAY_INDEX
      ? { snapshotItemIds: HBS_POOL.map((it) => seedItemDocId(it.text)).sort() }
      : {}),
  }));
}

/** The roster as the leaderboard and the email read it. */
export function hbsRoster() {
  return HBS_PLAYERS.map((p) => {
    const dayStats: Record<number, { bingoCount: number; squaresMarked: number; firstBingoAt: number | null }> = {};
    PLAY[p.uid].forEach(([squaresMarked, bingoCount], i) => {
      dayStats[i] = {
        bingoCount,
        squaresMarked,
        // A day and a half to five days after the unlock, varied by week and player
        // so no two read as the same minute.
        firstBingoAt: bingoCount > 0 ? unlockAt(i) + (36 + ((i * 17 + p.uid.charCodeAt(p.uid.length - 1) * 11) % 84)) * HOUR : null,
      };
    });
    const [thisSquares, thisBingos] = THIS_WEEK[p.uid];
    dayStats[HBS_TODAY_INDEX] = {
      bingoCount: thisBingos,
      squaresMarked: thisSquares,
      firstBingoAt: thisBingos > 0 ? unlockAt(HBS_TODAY_INDEX) + 26 * HOUR : null,
    };
    const rows = Object.values(dayStats);
    const firsts = rows.map((r) => r.firstBingoAt).filter((t): t is number => t != null);
    return {
      uid: p.uid,
      displayName: p.displayName,
      bingoCount: rows.reduce((n, r) => n + r.bingoCount, 0),
      squaresMarked: rows.reduce((n, r) => n + r.squaresMarked, 0),
      firstBingoAt: firsts.length ? Math.min(...firsts) : null,
      dayStats,
    };
  });
}

const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));

export async function seedHbsEvent(): Promise<RulesTestEnvironment> {
  const testEnv = await initializeTestEnvironment({
    projectId: HERO_PROJECT_ID,
    firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync(RULES_PATH, 'utf8') },
  });
  try {
    await testEnv.clearFirestore();
    const days = hbsDays();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const it of HBS_POOL) {
        await setDoc(doc(db, 'events', HERO_EVENT_ID, 'items', seedItemDocId(it.text)), {
          text: it.text,
          createdBy: 'seed',
          createdAt: HBS_NOW - 200 * HOUR,
          isFreeSpace: false,
          status: 'active',
          reportCount: 0,
          spicy: false,
          pool: it.pool,
        });
      }
      await setDoc(doc(db, 'events', HERO_EVENT_ID), {
        name: 'HBS Spring 2027',
        startsOn: '2027-01-25',
        endsOn: '2027-05-19',
        sailStart: '2027-01-25',
        sailEnd: '2027-05-19',
        status: 'active',
        defaultTheme: 'marquee',
        claimMode: 'honor',
        settings: { reportHideThreshold: 4, spicyRatio: 0, easyMixRatio: 0.5, dailyEmailEnabled: true },
        timezone: HBS_TIMEZONE,
        standingsFreezeAt: unlockAt(WEEKS.length - 1),
        days: days.map((d) => ({ ...d, port: d.place, portEmoji: d.placeEmoji })),
      });
      for (const p of hbsRoster()) {
        await setDoc(doc(db, 'events', HERO_EVENT_ID, 'players', p.uid), {
          ...p,
          photoURL: null,
          joinedAt: HBS_NOW - 80 * 24 * HOUR,
        });
      }
      await setDoc(
        doc(db, 'events', HERO_EVENT_ID, 'days', String(HBS_TODAY_INDEX), 'meta', String(HBS_TODAY_INDEX)),
        { firstBingo: { uid: 'hero-p1', displayName: 'Rae M.', at: unlockAt(HBS_TODAY_INDEX) + 26 * HOUR } },
      );
      // The world-readable routing document: without it the single-Event build
      // fails closed to the 18+ gate (see docs/app/marketing-screenshots.md).
      await setDoc(doc(db, 'hostnames', '127.0.0.1'), {
        eventId: HERO_EVENT_ID,
        canonicalHost: '127.0.0.1',
        edition: 'fiveacross',
        status: 'active',
        adultContent: false,
      });
    });
  } catch (error) {
    await testEnv.cleanup().catch(() => {});
    throw error;
  }
  return testEnv;
}
