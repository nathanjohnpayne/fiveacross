// Shared multi-Day seed for the Phase 1.5 daily-cards e2e verification pass.
// Builds on `seedEmulatorEvent` (which seeds the main ITEMS pool + the Event
// doc) and layers on: (1) the two curated tutorial pools (embark/farewell) as
// real item docs, and (2) a five-Day `days[]` schedule —
//   0  embark   (tutorial, embark pool)   unlocked, snapshot-stamped
//   1  main A   (welcome-aboard)          unlocked, snapshot-stamped
//   2  main B   (get-sporty)              unlocked, snapshot-stamped  ← today (default) WHILE farewell is locked
//   3  farewell (tutorial, farewell pool) LOCKED by default (see below), snapshot-stamped
//   4  main C   (glamiators)              LOCKED (future, no snapshot)
// When the farewell Day is opted UNLOCKED (below) it seeds as the MOST-RECENT
// unlock — later than main B — so it, not main B, is `defaultViewedIndex`'s
// "today". That mirrors the real scheduler-lag window (the farewell unlocks at
// D10 08:00, after every main Day) and keeps `unlockAt` monotonic by index; an
// earlier shape seeded it BEFORE today, an inverted schedule that only ever
// read as "today = main B" because it was chronologically invalid (#317 Codex).
// The two unlocked MAIN Days (1, 2) both draw from the full 80-item main pool,
// so their cards are disjoint (the no-repeats-across-the-cruise exclusion keeps
// them from overlapping too). `now`-relative `unlockAt`s mirror d15-day-cards so
// the fixture never rots against a wall-clock date.
//
// THE FAREWELL DAY MUST DEFAULT TO LOCKED (#317). In the app's model the
// farewell Day unlocks AT the standings freeze (D10 08:00 — unlockDay.ts stamps
// `frozenAt` at the farewell's own `unlockAt`), and `standingsFrozen`
// (src/game/logic.ts) fails CLOSED on exactly that: a PAST farewell `unlockAt`
// freezes the stats fold even with no `frozenAt` stamp. An early fixture shape
// seeded the farewell Day unlocked 30h ago to make every Day state reachable in
// one Event — which silently froze EVERY seeded event, so no mark/confirm ever
// credited player stats (the #317 leaderboard-reads-zero failures). Specs that
// need a DEALT farewell card (tutorial banners; the podium's scheduler-lag /
// post-freeze states) opt in via `farewellUnlocked` (or `frozenAt`, which
// implies it — a frozen event with a locked farewell would be contradictory).
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { expect, type Page } from '@playwright/test';
import { seedEmulatorEvent } from './seed';
import { EVENT_ID } from './env';
// @ts-expect-error — plain-JS seed script, no type declarations (see support/seed.ts).
import { seedItemDocId } from '../../../scripts/seed.mjs';
import { ITEMS, EASY_ITEMS, CLOSING_ITEMS } from '../../../scripts/seed-data/med-2026.mjs';

const HOUR = 3_600_000;

export interface SeededDays {
  testEnv: RulesTestEnvironment;
  /** All main-pool item doc ids (the snapshot for Days 1, 2). */
  mainSnapshotIds: string[];
  embarkSnapshotIds: string[];
  farewellSnapshotIds: string[];
}

type SeedItem = { text: string; spicy?: boolean };

const idsOf = (items: SeedItem[]): string[] => items.map((it) => seedItemDocId(it.text));

/**
 * Seed the full five-Day event + all three pools into the running emulator.
 * The farewell Day (index 3) seeds LOCKED by default so `standingsFrozen`
 * stays false and player stats fold normally (see the header comment);
 * `farewellUnlocked` opts into the unlocked farewell (which freezes stats —
 * the app's fail-closed D10 semantics), and `frozenAt` (the farewell-podium
 * path) implies it.
 */
export async function seedDailyEvent(
  opts: { frozenAt?: number; farewellUnlocked?: boolean; withStorage?: boolean } = {},
): Promise<SeededDays> {
  const testEnv = await seedEmulatorEvent({ withStorage: opts.withStorage });
  const now = Date.now();
  // Unlocked opt-in: seed the farewell as the MOST-RECENT unlock (2h ago, later
  // than main B's 10h) so the schedule stays monotonic by index and
  // `defaultViewedIndex` lands on the farewell as "today" — the real
  // scheduler-lag state. Locked default: 48h in the future.
  const farewellUnlockAt =
    opts.frozenAt != null || opts.farewellUnlocked === true ? now - 2 * HOUR : now + 48 * HOUR;
  const mainSnapshotIds = idsOf(ITEMS as SeedItem[]);
  const embarkSnapshotIds = idsOf(EASY_ITEMS as SeedItem[]);
  const farewellSnapshotIds = idsOf(CLOSING_ITEMS as SeedItem[]);

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // The two tutorial pools are NOT part of the main ITEMS seedEmulatorEvent
    // wrote — deal-from-snapshot resolves each id to its item doc, so those docs
    // must exist. pool is stamped for fidelity; dealDayCard reads only
    // text/spicy/isFreeSpace (pool membership is the snapshot itself).
    for (const { items, pool } of [
      { items: EASY_ITEMS as SeedItem[], pool: 'embark' },
      { items: CLOSING_ITEMS as SeedItem[], pool: 'farewell' },
    ]) {
      for (const it of items) {
        await setDoc(doc(db, 'events', EVENT_ID, 'items', seedItemDocId(it.text)), {
          text: it.text,
          createdBy: 'seed',
          createdAt: now,
          isFreeSpace: false,
          status: 'active',
          reportCount: 0,
          spicy: it.spicy === true,
          pool,
        });
      }
    }

    await updateDoc(doc(db, 'events', EVENT_ID), {
      ...(opts.frozenAt != null ? { frozenAt: opts.frozenAt } : {}),
      days: [
        { index: 0, date: '2026-07-15', place: 'Trieste', placeEmoji: '🚢', theme: 'welcome-aboard', pool: 'embark', tutorial: true, unlockAt: now - 100 * HOUR, snapshotItemIds: embarkSnapshotIds },
        { index: 1, date: '2026-07-16', place: 'Split', placeEmoji: '🇭🇷', theme: 'welcome-aboard', pool: 'main', tutorial: false, unlockAt: now - 50 * HOUR, snapshotItemIds: mainSnapshotIds },
        { index: 2, date: '2026-07-17', place: 'Valletta', placeEmoji: '🇲🇹', theme: 'get-sporty', pool: 'main', tutorial: false, unlockAt: now - 10 * HOUR, snapshotItemIds: mainSnapshotIds },
        { index: 3, date: '2026-07-24', place: 'Venice', placeEmoji: '🇮🇹', theme: 'so-long-farewell', pool: 'farewell', tutorial: true, unlockAt: farewellUnlockAt, snapshotItemIds: farewellSnapshotIds },
        // +72h, not +24h (CodeRabbit, PR #339): the locked farewell above sits
        // at +48h, and a later-index Day unlocking EARLIER than its
        // predecessor is an invalid schedule shape. Still locked either way.
        { index: 4, date: '2026-07-25', place: 'Corfu', placeEmoji: '🇬🇷', theme: 'glamiators', pool: 'main', tutorial: false, unlockAt: now + 72 * HOUR },
      ],
    });
  });

  return { testEnv, mainSnapshotIds, embarkSnapshotIds, farewellSnapshotIds };
}

/** The default viewed Day (today) for the seeded schedule above: index 2. */
export const TODAY_INDEX = 2;
export const MAIN_A_INDEX = 1;
export const EMBARK_INDEX = 0;
export const FAREWELL_INDEX = 3;
export const LOCKED_INDEX = 4;

export interface PlayerStats {
  squaresMarked?: number;
  bingoCount?: number;
  firstBingoAt?: number | null;
  dayStats?: Record<string, { bingoCount: number; squaresMarked: number; firstBingoAt: number | null }>;
}

/** Every Player-doc uid in the seeded Event, straight from the emulator, rules
 *  disabled — the SERVER-side ground truth behind the Leaderboard's roster
 *  subscription. Lets a sole-Player assertion pin "exactly my uid exists" as
 *  data before asserting the rendered row count, so a stray second row fails
 *  with the intruding uid in the message instead of a bare count mismatch
 *  (#317's union-run diagnosis gap). */
export async function playerUids(testEnv: RulesTestEnvironment): Promise<string[]> {
  let uids: string[] = [];
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDocs(collection(ctx.firestore(), 'events', EVENT_ID, 'players'));
    uids = snap.docs.map((d) => d.id);
  });
  return uids;
}

/** Read a Player row straight from the emulator, rules disabled. */
export async function readPlayer(testEnv: RulesTestEnvironment, uid: string): Promise<PlayerStats> {
  let data: Record<string, unknown> = {};
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'events', EVENT_ID, 'players', uid));
    data = (snap.data() as Record<string, unknown>) ?? {};
  });
  return data as PlayerStats;
}

/**
 * Wait until a FULLY-DEALT day grid is on screen (25 cells, >=20 non-free
 * squares carrying text) whose content differs from `differsFrom` — so a read
 * never lands on the stale previous-Day grid during the "Dealing…" transient
 * after a Day switch. Returns the settled grid's cell texts. (Mirrors the
 * helper d15-day-cards.spec.ts uses.)
 */
export async function readDealtDayGrid(page: Page, differsFrom?: string): Promise<string[]> {
  await expect
    .poll(
      async () => {
        const texts = await page.locator('.grid .cell').allTextContents();
        if (texts.length !== 25) return false;
        const dealt = texts.filter((t, i) => i !== 12 && t.trim().length > 0).length >= 20;
        return dealt && (differsFrom === undefined || texts.join('|') !== differsFrom);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return page.locator('.grid .cell').allTextContents();
}

/**
 * Dismiss the one-time Reshuffle launch announcement (#378) if present. Like the
 * coach overlay it draws a full scrim, so it intercepts taps until cleared.
 * Idempotent / best-effort.
 */
export async function dismissLaunchIntro(page: Page): Promise<void> {
  const cta = page.getByRole('button', { name: /let's play/i });
  if (await cta.isVisible().catch(() => false)) await cta.click();
}

/**
 * Dismiss every first-open scrim standing between the suite and the board — the
 * once-per-event coach overlay (#214) and then the Reshuffle launch announcement
 * (#378). Idempotent / best-effort.
 *
 * The ORDER matters and is not incidental: LaunchIntro is deliberately queued
 * BEHIND the coach overlay (Board only mounts it once the coach flag is set), so
 * it does not exist in the DOM until the coach CTA has been clicked. Clearing
 * both here — rather than making every one of this helper's ~20 call sites learn
 * about the new overlay — is what keeps "get me to a tappable board" one call.
 */
export async function dismissCoach(page: Page): Promise<void> {
  const cta = page.getByRole('button', { name: /deal me in/i });
  if (await cta.isVisible().catch(() => false)) await cta.click();
  await dismissLaunchIntro(page);
}

/** Read all Moment docs from the emulator (the Feed's server truth). */
export async function readMoments(
  testEnv: RulesTestEnvironment,
): Promise<Array<{ id: string; kind: string; uid: string; displayName: string; dayIndex?: number }>> {
  let out: Array<{ id: string; kind: string; uid: string; displayName: string; dayIndex?: number }> = [];
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const col = await getDocs(collection(ctx.firestore(), 'events', EVENT_ID, 'moments'));
    out = col.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) })) as never;
  });
  return out;
}
