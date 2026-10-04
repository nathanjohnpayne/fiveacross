/**
 * The calendar-date-in-a-timezone primitive.
 *
 * Extracted from `components/dayIdentity.tsx` (which re-exports it, so every
 * existing import keeps working) because it is a pure date function with no
 * React in it, and `draftValidation.ts` — which declares no Firebase, no React
 * — needs the SAME conversion the header uses. Restating the arithmetic there
 * would be a second answer to "what calendar day is this instant on", and the
 * whole point of the launch gates is that they agree with the consumers by
 * construction rather than by two careful re-implementations.
 *
 * It also holds the opposite direction, wall clock → instant
 * (`instantFromZonedTime`), which Step 4 of the setup wizard needs to turn a
 * Day's date and unlock time into `unlockAt` (#1377). Keeping both halves in
 * one module is what lets the gate's `isoDateInTz` check and the transform
 * that writes the instant agree on what "this date in this zone" means.
 */

/**
 * Today's calendar date as 'YYYY-MM-DD' in the given IANA timezone. en-CA is
 * the locale whose date format IS the ISO string, so the result compares
 * lexicographically against `DayDef.date`. An invalid timezone degrades to the
 * host zone rather than throwing — a hand-edited Event doc must never blank
 * the header.
 */
export function isoDateInTz(now: number, timeZone: string): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone }).format(new Date(now));
  } catch {
    // The first throw is usually an unusable timeZone, which the host-zone
    // fallback fixes. But an instant outside the representable `Date` range
    // makes EVERY formatter throw, fallback included — so the fallback is
    // itself guarded and an unformattable instant yields '' rather than
    // propagating a RangeError into a render or a validation pass. '' matches
    // no `DayDef.date`, which is the correct answer for "no such day".
    try {
      return new Intl.DateTimeFormat('en-CA', opts).format(new Date(now));
    } catch {
      return '';
    }
  }
}

/** `HH:MM`, 24-hour, `00:00`–`23:59`: the shape `OccasionScheduleShape.unlockTime`
 *  and a native `<input type="time">` both use. `24:00` is not a time of day. */
const WALL_CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isWallClockTime(value: string): boolean {
  return WALL_CLOCK_TIME.test(value);
}

const ISO_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Milliseconds for a wall clock read as UTC. `setUTCFullYear` rather than
 *  `Date.UTC`, which maps years 0–99 onto 1900–1999. */
function utcWallMs(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getTime();
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter for the zone's wall clock, or `null` for a zone the runtime
 *  does not recognise. `hourCycle: 'h23'` so midnight reads `00`, never `24`. */
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!timeZone) return null;
  const cached = wallClockFormatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallClockFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** The zone's wall clock at an instant, as UTC-shaped milliseconds. */
function wallMsAt(at: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(at));
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `% 24` as well as `h23`: some ICU builds still spell midnight `24` while
  // the date parts name the day that is STARTING (the fold `unlockCopy`'s
  // `zoneOffsetMs` applies for the same reason, Codex P1 on #674).
  return utcWallMs(num('year'), num('month'), num('day'), num('hour') % 24, num('minute'), num('second'));
}

/** The zone's offset from UTC at an instant, in ms (east positive). */
function offsetAt(at: number, formatter: Intl.DateTimeFormat): number {
  return wallMsAt(at, formatter) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at which a calendar date and wall-clock time occur in an IANA
 * zone: the inverse of `isoDateInTz` + `isoTimeInTz`, and the clock Step 4
 * (#792) needs to turn "Day 2 opens at 06:00" into `DraftDayDef.unlockAt`.
 *
 * Returns `null`, never a guess, for a malformed date, a malformed time, or a
 * zone the runtime does not recognise. Unlike `isoDateInTz` there is no
 * host-zone fallback: an unlock instant computed in the organizer's own zone
 * is the silent wrong-zone schedule #785 catalogues, and refusing is the only
 * answer a caller can act on.
 *
 * DST is resolved the way `Temporal`'s default `'compatible'` disambiguation
 * does, so the rule matches the platform's own future answer
 * (specs/event-setup-wizard.md § Look (Step 4)):
 *
 * - GAP (spring forward). A wall time the zone skips (02:30 on 2026-03-08 in
 *   `America/Los_Angeles`) resolves FORWARD by the length of the gap, using
 *   the offset in force before the transition: 02:30 becomes the instant the
 *   zone calls 03:30. The Day still opens on its own date, as close as
 *   possible to the time asked for, and never before it.
 * - OVERLAP (fall back). A wall time the zone shows twice (01:30 on
 *   2026-11-01 in `America/Los_Angeles`) resolves to the EARLIER of the two
 *   instants, the pre-transition daylight-time one. A Day opens the first
 *   time its clock reads the time it was given.
 *
 * Every other wall time has exactly one instant and round-trips exactly. The
 * one way a resolved instant can land on a different DATE is a zone that
 * skips a whole calendar day (`Pacific/Apia` skipped 2011-12-30); the shared
 * gate's `day-unlock-date-mismatch` then reports it rather than this function
 * quietly relabelling the Day.
 *
 * The transition is located by sampling the offset a day either side of the
 * wall time, which brackets any transition within ten hours of it; real zones
 * move their clocks by at most an hour, and never twice in a day.
 */
export function instantFromZonedTime(date: string, time: string, timeZone: string): number | null {
  const dateParts = ISO_DATE_PARTS.exec(date);
  const timeParts = WALL_CLOCK_TIME.exec(time);
  if (!dateParts || !timeParts) return null;
  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  const wall = utcWallMs(year, month, day, Number(timeParts[1]), Number(timeParts[2]));
  // `2026-02-30` would roll over to March 2nd; the round-trip proves the day exists.
  const echo = new Date(wall);
  if (echo.getUTCFullYear() !== year || echo.getUTCMonth() !== month - 1 || echo.getUTCDate() !== day) {
    return null;
  }
  const formatter = wallClockFormatter(timeZone);
  if (!formatter) return null;
  const before = offsetAt(wall - DAY_MS, formatter);
  const after = offsetAt(wall + DAY_MS, formatter);
  // A candidate is real when the zone's offset AT that instant is the offset
  // that produced it. Two real candidates is an overlap; none is a gap.
  const real = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((at) => offsetAt(at, formatter) === wall - at)
    .sort((a, b) => a - b);
  if (real.length > 0) return real[0];
  return wall - before;
}

/**
 * The wall-clock time `HH:MM` (24-hour) an instant shows in an IANA zone: the
 * half `isoDateInTz` leaves out, so Step 4 can display an existing `unlockAt`
 * in the Event's zone. Seconds are truncated, never rounded up.
 *
 * `''` for a zone the runtime does not recognise or an unformattable instant.
 * Deliberately NOT the host-zone fallback `isoDateInTz` takes: a time shown in
 * the organizer's own zone beside a date in the Event's would invite an edit
 * that moves the unlock by the difference.
 */
export function isoTimeInTz(at: number, timeZone: string): string {
  const formatter = wallClockFormatter(timeZone);
  if (!formatter) return '';
  try {
    const wall = new Date(wallMsAt(at, formatter));
    if (Number.isNaN(wall.getTime())) return '';
    return `${String(wall.getUTCHours()).padStart(2, '0')}:${String(wall.getUTCMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
