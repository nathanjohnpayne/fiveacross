import type { DayDef } from './types';

/**
 * Every player-facing rendering of a Day's `unlockAt` (#670). One module owns
 * them so the surfaces that quote the same instant cannot drift apart: the
 * locked-Day badge and its caption sit one element from each other on the card,
 * and the warm-up banner promises the same unlock a Day earlier.
 *
 * The bug this seam exists to prevent shipped twice — the locked caption said
 * "land at 8" over a "6:00 a.m." badge (#669), and the warm-up banner said "the
 * real chaos starts tomorrow at 8" against the same 06:00 schedule (#670).
 * Both were hardcoded 8s left over from a schedule where every Day opened at
 * 08:00 event time; `DayDef.unlockAt` is per-Day and per-Edition.
 *
 * Everything here formats in the EVENT's timezone (falling back to UTC before
 * the Event doc resolves), never the viewer's.
 */

/** The clock face of an unlock, split so callers can spend the pieces. */
interface UnlockClock {
  /** Bare hour, minutes only when the Day doesn't open on the hour: "6", "9:30". */
  hour: string;
  /** Always with periods, never Intl's "AM": "a.m." / "p.m.". */
  meridiem: 'a.m.' | 'p.m.';
  /**
   * A morning anyone would call a morning. Deliberately NOT the raw `AM` day
   * period: 12:xx a.m. is `AM` to `Intl` but is midnight, where a bare "12"
   * reads as noon and "come back after coffee" is plainly wrong (Codex P2 on
   * #669).
   */
  morning: boolean;
}

function unlockClock(unlockAt: number, timezone: string | undefined): UnlockClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone || 'UTC',
  }).formatToParts(new Date(unlockAt));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const minute = part('minute');
  const clockHour = part('hour');
  const meridiem = part('dayPeriod').toUpperCase().startsWith('P') ? 'p.m.' : 'a.m.';
  return {
    hour: `${clockHour}${minute === '00' ? '' : `:${minute}`}`,
    meridiem,
    morning: meridiem === 'a.m.' && clockHour !== '12',
  };
}

/**
 * The hour as running copy: bare inside a morning ("6", "9:30"), meridiem
 * spelled out otherwise ("8 p.m.", "12 a.m."), because a bare number in a
 * sentence reads as a.m. by default.
 */
function spokenHour(clock: UnlockClock): string {
  return clock.morning ? clock.hour : `${clock.hour} ${clock.meridiem}`;
}

/** A sentence ending in "a.m."/"p.m." already has its terminal period. */
function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/** "Unlocks 8:00 a.m. · Wed Jul 22" — the locked-Day badge (#260). */
export function formatUnlockAt(unlockAt: number, timezone: string | undefined): string {
  const tz = timezone || 'UTC';
  const when = new Date(unlockAt);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  })
    .format(when)
    .replace(/\s?([AP])M\b/, (_m, p: string) => ` ${p.toLowerCase()}.m.`);
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  }).format(when);
  return `${time} · ${date}`;
}

/**
 * The locked-Day caption under that badge — "24 fresh squares land at 6. Come
 * back after coffee." A non-morning unlock takes a neutral tail instead, which
 * would otherwise assert a morning the schedule doesn't have.
 */
export function unlockCaption(unlockAt: number, timezone: string | undefined): string {
  const clock = unlockClock(unlockAt, timezone);
  return clock.morning
    ? `24 fresh squares land at ${clock.hour}. Come back after coffee.`
    : endSentence(`24 fresh squares land at ${spokenHour(clock)} Come back then.`);
}

/** The calendar date an instant falls on in `timezone`, as "2026-08-09". */
function calendarDate(at: number, timezone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone || 'UTC',
  }).format(new Date(at));
}

/**
 * How far off an unlock reads from `now`, in the Event's timezone — "later
 * today", "tomorrow", "Saturday", or a dated "Sat, Aug 15" once the weekday
 * alone stops being unambiguous. Compared by CALENDAR DATE, not elapsed hours:
 * a 6 a.m. unlock 20 hours out is still "tomorrow" to someone reading at
 * 10 a.m., and "in 20 hours" is not how anyone says it.
 */
function relativeDay(unlockAt: number, timezone: string | undefined, now: number): string {
  const today = calendarDate(now, timezone);
  const target = calendarDate(unlockAt, timezone);
  if (target === today) return 'later today';
  // Both dates are midnight-anchored ISO days, so this difference is whole
  // calendar days — never an off-by-one from a DST-shortened 23-hour day.
  const days = Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 1) return 'tomorrow';
  const tz = timezone || 'UTC';
  if (days > 1 && days < 7) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(new Date(unlockAt));
  }
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  }).format(new Date(unlockAt));
}

/**
 * The warm-up banner's second sentence — "The real chaos starts tomorrow at 6."
 * — pointed at the first `main`-POOL Day, which is what "the real chaos" has
 * always meant: the competitive deal, as opposed to the easy warm-up card.
 *
 * Selected on `pool`, never re-derived as `!tutorial` (Codex P1 on #670).
 * They are not the same set: the Bodega Bay schedule opens with a
 * `pool: 'embark'`, `tutorial: false` Day — a competitive EASY card — carrying
 * the `unlockAt: 0` open sentinel, so a `!tutorial` predicate picks that Day,
 * reads it as long unlocked, and silently drops the sentence on the very
 * Edition this fix was written for. `'main'` is also the one pool id the
 * pre-#565 vocabulary spells identically, so a live doc written either way
 * matches without going through `migratePool`.
 *
 * Returns `null` (drop the sentence) when there is nothing to promise: no
 * schedule yet, no main Day in it, or — the case the walkthrough replay hits
 * from More → How to play mid-event — a first main Day that has already
 * unlocked. Chaos that started three days ago is not something to tease, and a
 * stale promise is exactly the kind of copy this module exists to prevent.
 */
export function chaosLine(
  days: readonly DayDef[] | undefined,
  timezone: string | undefined,
  now: number,
): string | null {
  const first = firstChaosDay(days);
  if (!first || first.unlockAt <= now) return null;
  const clock = unlockClock(first.unlockAt, timezone);
  return endSentence(
    `The real chaos starts ${relativeDay(first.unlockAt, timezone, now)} at ${spokenHour(clock)}`,
  );
}

function firstChaosDay(days: readonly DayDef[] | undefined): DayDef | undefined {
  const first = days?.find((d) => d.pool === 'main');
  return first && Number.isFinite(first.unlockAt) ? first : undefined;
}

/** The Event zone's offset from UTC at a given instant, in ms. */
function zoneOffsetMs(at: number, timezone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour: '2-digit'` with hour12:false renders midnight as "24" in some ICU
  // builds; Date.UTC absorbs the rollover either way.
  const wallClock = Date.UTC(num('year'), num('month') - 1, num('day'), num('hour'), num('minute'), num('second'));
  return wallClock - Math.floor(at / 1000) * 1000;
}

/**
 * The next instant at which `chaosLine` could say something different, so a
 * mounted banner can re-render exactly then instead of going stale (Codex P2 on
 * #670): either the unlock itself — after which the sentence retires — or the
 * Event zone's next midnight, which is what turns "tomorrow" into "later
 * today". `null` once there is no sentence left to maintain.
 *
 * Across a DST transition the computed midnight can land an hour early or late,
 * since the offset is sampled at `now` rather than at the boundary. The caller
 * re-arms after every tick, so the worst case is one extra wake-up (early) or a
 * caption an hour stale on one night a year (late) — not worth an exact-zone
 * arithmetic library for a banner.
 */
export function nextChaosBoundary(
  days: readonly DayDef[] | undefined,
  timezone: string | undefined,
  now: number,
): number | null {
  const first = firstChaosDay(days);
  if (!first || first.unlockAt <= now) return null;
  const offset = zoneOffsetMs(now, timezone);
  const dayMs = 86_400_000;
  const nextMidnight = (Math.floor((now + offset) / dayMs) + 1) * dayMs - offset;
  return Math.min(first.unlockAt, nextMidnight);
}
