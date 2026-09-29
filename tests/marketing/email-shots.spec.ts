// Marketing mockups of the two player emails (docs/app/marketing-screenshots.md).
// Not a test: it renders the REAL templates — the same `build*Model` and
// `render*Html` the Functions send — over invented data, and photographs the
// HTML. Writes PNGs to artifacts/marketing/.
//
// It needs no emulator and no app build, but it runs under the marketing config
// beside the app capture, so `scripts/marketing-shots.sh --grep email` is the
// way to run it alone.
//
// The Event is the Bodega Bay seed — general-audience throughout, the same
// posture fixture.ts takes — and the roster is fixture.ts's invented names, so
// nothing here came from a real Event.
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PLAYER_NAMES } from './support/fixture';
import {
  buildDailyEmailModel,
  formatDayDate,
  placeLabel,
  standingsThrough,
  type EmailDay,
  type EmailEvent,
  type EmailPlayer,
} from '../../functions/src/dailyEmailContent';
import { renderDailyEmailHtml } from '../../functions/src/dailyEmailTemplate';
import { buildPodiumEmailModel } from '../../functions/src/podiumEmailContent';
import { renderPodiumEmailHtml } from '../../functions/src/podiumEmailTemplate';
import { buildPodiumPayload, tutorialDayIndexes, ceremonialDayIndexes } from '../../functions/src/finaleContent';
// @ts-expect-error — plain-JS seed data, no type declarations.
import { EVENT_SEED as BODEGA_SEED } from '../../scripts/seed-data/bodega-bay-2026.mjs';

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'marketing');
/** Email clients render a ~600px column; this leaves the template its margins. */
const EMAIL_VIEWPORT = { width: 640, height: 900 };
const FEED_URL = 'https://bodega-bay.fiveacross.app/feed';
const UNSUBSCRIBE_URL = 'https://example.com/unsubscribe';
const PREFERENCES_URL = 'https://example.com/unsubscribe?a=preferences';

const event: EmailEvent = {
  name: BODEGA_SEED.name,
  timezone: BODEGA_SEED.timezone,
  standingsFreezeAt: BODEGA_SEED.standingsFreezeAt,
  days: BODEGA_SEED.days as EmailDay[],
};
const days = event.days!;

// Invented play, consistent across both emails: per-Day stats sum to the
// totals, and `firstBingoAt` is the earliest per-Day bingo. The ceremonial
// closing Day (index 3) carries no play, so the finale ranks the same rows.
const [rae, devon, priya, tomas] = PLAYER_NAMES;
const at = (dayIndex: number, hour: number) => (days[dayIndex].unlockAt || days[1].unlockAt - 86_400_000) + hour * 3_600_000;
const roster: EmailPlayer[] = [
  {
    uid: 'hero-p1', displayName: rae, bingoCount: 2, squaresMarked: 19, firstBingoAt: at(0, 5),
    dayStats: {
      0: { bingoCount: 1, squaresMarked: 11, firstBingoAt: at(0, 5) },
      1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: at(1, 7) },
    },
  },
  {
    uid: 'hero-p2', displayName: devon, bingoCount: 1, squaresMarked: 17, firstBingoAt: at(1, 3),
    dayStats: {
      0: { bingoCount: 0, squaresMarked: 9, firstBingoAt: null },
      1: { bingoCount: 1, squaresMarked: 8, firstBingoAt: at(1, 3) },
    },
  },
  {
    uid: 'hero-p3', displayName: priya, bingoCount: 1, squaresMarked: 15, firstBingoAt: at(2, 2),
    dayStats: {
      0: { bingoCount: 0, squaresMarked: 8, firstBingoAt: null },
      1: { bingoCount: 0, squaresMarked: 4, firstBingoAt: null },
      2: { bingoCount: 1, squaresMarked: 3, firstBingoAt: at(2, 2) },
    },
  },
  {
    uid: 'hero-p4', displayName: tomas, bingoCount: 0, squaresMarked: 10, firstBingoAt: null,
    dayStats: {
      0: { bingoCount: 0, squaresMarked: 6, firstBingoAt: null },
      1: { bingoCount: 0, squaresMarked: 4, firstBingoAt: null },
    },
  },
];
/** Who reads each email — not the leader, so the "You're #N" line has work to do. */
const reader = { uid: 'hero-p2', displayName: devon };

async function shootHtml(page: import('@playwright/test').Page, html: string, name: string): Promise<void> {
  await page.setViewportSize(EMAIL_VIEWPORT);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT_DIR, `email-${name}.png`), fullPage: true, animations: 'disabled' });
}

test('capture email mockups', async ({ page }) => {
  mkdirSync(OUT_DIR, { recursive: true });

  // The Day 2 morning card: standings through Day 1, sent at Day 2's unlock.
  const day = days[1];
  const tutorial = tutorialDayIndexes(days);
  const ceremonial = ceremonialDayIndexes(days);
  const daily = buildDailyEmailModel({
    event,
    day,
    players: roster,
    ranked: standingsThrough(roster, day.index, tutorial, ceremonial),
    recipient: reader,
    edition: 'vacay',
    feedUrl: FEED_URL,
    unsubscribeUrl: UNSUBSCRIBE_URL,
    preferencesUrl: PREFERENCES_URL,
  });
  await shootHtml(page, renderDailyEmailHtml(daily), 'daily-card');

  // The winner announcement, from the payload the finale itself would build.
  // Each Day's pinned First to BINGO, as the scheduler pins them: the earliest
  // per-Day bingo in the roster above.
  const dayHonors = [
    { dayIndex: 0, firstBingo: { uid: 'hero-p1', displayName: rae, at: at(0, 5) } },
    { dayIndex: 1, firstBingo: { uid: 'hero-p2', displayName: devon, at: at(1, 3) } },
    { dayIndex: 2, firstBingo: { uid: 'hero-p3', displayName: priya, at: at(2, 2) } },
  ];
  const podium = buildPodiumPayload(roster, days, dayHonors, event.standingsFreezeAt);
  const closing = days[days.length - 1];
  // The two label shapes BuildPodiumEmailArgs documents: "Day 2 in 🇭🇷 Split"
  // for an honour, "Day 7 · 🇮🇹 Rome" for the photo.
  const honorLabel = (i: number) => `Day ${i + 1} in ${placeLabel(days[i])}`;
  const photoLabel = (i: number) => `Day ${i + 1} · ${placeLabel(days[i])}`;
  const podiumModel = buildPodiumEmailModel({
    eventName: event.name as string,
    podium,
    mostLoved: {
      winners: [{
        proofId: 'hero-photo',
        uid: 'hero-p3',
        displayName: priya,
        promptText: 'Catch someone talking to a bird',
        dayIndex: 1,
        proofCreatedAt: at(1, 4),
      }],
      winnerCount: 1,
      heartCount: 6,
      frozenAt: event.standingsFreezeAt as number,
      computedAt: event.standingsFreezeAt as number,
    },
    boardWasEmpty: !podium.playRecorded,
    ranked: roster.map(({ uid, displayName, bingoCount, squaresMarked }) => ({ uid, displayName, bingoCount, squaresMarked })),
    closingDay: {
      themeId: closing.theme,
      dayNumber: closing.index + 1,
      dayCount: days.length,
      dateLabel: formatDayDate(closing.date),
      placeLabel: placeLabel(closing),
    },
    honorDayLabels: Object.fromEntries(days.map((d) => [d.index, honorLabel(d.index)])),
    photoDayLabel: photoLabel(1),
    recipient: reader,
    edition: 'vacay',
    feedUrl: FEED_URL,
    unsubscribeUrl: UNSUBSCRIBE_URL,
    preferencesUrl: PREFERENCES_URL,
  });
  await shootHtml(page, renderPodiumEmailHtml(podiumModel), 'winner-announcement');
});
