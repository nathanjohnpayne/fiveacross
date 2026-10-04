import { describe, expect, it } from 'vitest';
import { instantFromZonedTime, isWallClockTime, isoDateInTz, isoTimeInTz } from './tzDate';

const LA = 'America/Los_Angeles';
const ROME = 'Europe/Rome';
const SYDNEY = 'Australia/Sydney';

/** Every quarter hour of a day, as `HH:MM`. */
function quarterHours(): string[] {
  const out: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    out.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  }
  return out;
}

function roundTrip(date: string, time: string, zone: string): { date: string; time: string } {
  const at = instantFromZonedTime(date, time, zone);
  if (at === null) throw new Error(`no instant for ${date} ${time} ${zone}`);
  return { date: isoDateInTz(at, zone), time: isoTimeInTz(at, zone) };
}

describe('isWallClockTime', () => {
  it('accepts 24-hour HH:MM from 00:00 to 23:59 only', () => {
    expect(isWallClockTime('00:00')).toBe(true);
    expect(isWallClockTime('06:00')).toBe(true);
    expect(isWallClockTime('23:59')).toBe(true);
    for (const bad of ['24:00', '6:00', '06:60', '06:00:00', ' 06:00', '', 'noon']) {
      expect(isWallClockTime(bad)).toBe(false);
    }
  });
});

describe('instantFromZonedTime', () => {
  it('converts a date and time in the zone, not the host', () => {
    // PDT is UTC-7 in August; CEST is UTC+2.
    expect(instantFromZonedTime('2026-08-07', '06:00', LA)).toBe(Date.UTC(2026, 7, 7, 13, 0));
    expect(instantFromZonedTime('2026-08-07', '06:00', ROME)).toBe(Date.UTC(2026, 7, 7, 4, 0));
    // Half- and three-quarter-hour zones.
    expect(instantFromZonedTime('2026-08-07', '06:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 7, 7, 0, 30));
    expect(instantFromZonedTime('2026-01-15', '06:00', 'Pacific/Chatham')).toBe(Date.UTC(2026, 0, 14, 16, 15));
  });

  it('round-trips midnight and the last minute of the day onto the same date', () => {
    expect(roundTrip('2026-08-07', '00:00', LA)).toEqual({ date: '2026-08-07', time: '00:00' });
    expect(roundTrip('2026-08-07', '23:59', LA)).toEqual({ date: '2026-08-07', time: '23:59' });
    expect(roundTrip('2026-08-07', '00:00', ROME)).toEqual({ date: '2026-08-07', time: '00:00' });
  });

  describe('spring-forward gap', () => {
    it('round-trips an ordinary time on the transition date (06:00 is PDT on 2026-03-08)', () => {
      expect(instantFromZonedTime('2026-03-08', '06:00', LA)).toBe(Date.UTC(2026, 2, 8, 13, 0));
      expect(roundTrip('2026-03-08', '06:00', LA)).toEqual({ date: '2026-03-08', time: '06:00' });
      // The last minute before the gap is still PST.
      expect(instantFromZonedTime('2026-03-08', '01:59', LA)).toBe(Date.UTC(2026, 2, 8, 9, 59));
    });

    it('resolves a skipped time FORWARD by the gap: 02:30 opens at what the zone calls 03:30', () => {
      const at = instantFromZonedTime('2026-03-08', '02:30', LA);
      expect(at).toBe(Date.UTC(2026, 2, 8, 10, 30));
      expect(isoDateInTz(at as number, LA)).toBe('2026-03-08');
      expect(isoTimeInTz(at as number, LA)).toBe('03:30');
      // Same rule in Europe (02:00 CET → 03:00 CEST on 2026-03-29).
      const rome = instantFromZonedTime('2026-03-29', '02:30', ROME);
      expect(rome).toBe(Date.UTC(2026, 2, 29, 1, 30));
      expect(isoTimeInTz(rome as number, ROME)).toBe('03:30');
    });

    it('keeps every quarter hour of the transition date on that date, exact outside the gap', () => {
      for (const time of quarterHours()) {
        const back = roundTrip('2026-03-08', time, LA);
        expect(back.date).toBe('2026-03-08');
        if (time.startsWith('02:')) expect(back.time).toBe(`03:${time.slice(3)}`);
        else expect(back.time).toBe(time);
      }
    });

    it('applies in the southern hemisphere too (Sydney springs forward 2026-10-04)', () => {
      const at = instantFromZonedTime('2026-10-04', '02:15', SYDNEY);
      expect(isoTimeInTz(at as number, SYDNEY)).toBe('03:15');
      expect(roundTrip('2026-10-04', '06:00', SYDNEY)).toEqual({ date: '2026-10-04', time: '06:00' });
    });
  });

  describe('fall-back overlap', () => {
    it('resolves a repeated time to the EARLIER instant (the daylight-time one)', () => {
      const at = instantFromZonedTime('2026-11-01', '01:30', LA);
      // 01:30 PDT = 08:30Z; the second 01:30 (PST) is 09:30Z.
      expect(at).toBe(Date.UTC(2026, 10, 1, 8, 30));
      expect(isoTimeInTz(Date.UTC(2026, 10, 1, 9, 30), LA)).toBe('01:30');
      expect(roundTrip('2026-11-01', '01:30', LA)).toEqual({ date: '2026-11-01', time: '01:30' });
      // Europe: 02:30 happens twice on 2026-10-25; the first is CEST (UTC+2).
      expect(instantFromZonedTime('2026-10-25', '02:30', ROME)).toBe(Date.UTC(2026, 9, 25, 0, 30));
      // Southern hemisphere: Sydney repeats 02:00–03:00 on 2026-04-05; the first is AEDT (UTC+11).
      expect(instantFromZonedTime('2026-04-05', '02:30', SYDNEY)).toBe(Date.UTC(2026, 3, 4, 15, 30));
    });

    it('round-trips every quarter hour of the transition date exactly', () => {
      for (const time of quarterHours()) {
        expect(roundTrip('2026-11-01', time, LA)).toEqual({ date: '2026-11-01', time });
        expect(roundTrip('2026-10-25', time, ROME)).toEqual({ date: '2026-10-25', time });
      }
    });

    it('lands an ordinary time after the overlap on standard time (06:00 is PST on 2026-11-01)', () => {
      expect(instantFromZonedTime('2026-11-01', '06:00', LA)).toBe(Date.UTC(2026, 10, 1, 14, 0));
    });
  });

  it('refuses rather than guesses on a malformed date, time or zone', () => {
    expect(instantFromZonedTime('2026-02-30', '06:00', LA)).toBeNull();
    expect(instantFromZonedTime('not-a-date', '06:00', LA)).toBeNull();
    expect(instantFromZonedTime('', '06:00', LA)).toBeNull();
    expect(instantFromZonedTime('2026-08-07', '24:00', LA)).toBeNull();
    expect(instantFromZonedTime('2026-08-07', '6:00', LA)).toBeNull();
    expect(instantFromZonedTime('2026-08-07', '06:00', 'Not/AZone')).toBeNull();
    expect(instantFromZonedTime('2026-08-07', '06:00', '')).toBeNull();
  });

  it('accepts a leap day', () => {
    expect(roundTrip('2028-02-29', '06:00', LA)).toEqual({ date: '2028-02-29', time: '06:00' });
  });
});

describe('isoTimeInTz', () => {
  it('formats the wall clock in the given zone, 24-hour, with midnight as 00', () => {
    expect(isoTimeInTz(Date.UTC(2026, 7, 7, 13, 0), LA)).toBe('06:00');
    expect(isoTimeInTz(Date.UTC(2026, 7, 7, 7, 0), LA)).toBe('00:00');
    expect(isoTimeInTz(Date.UTC(2026, 7, 7, 22, 45), ROME)).toBe('00:45');
  });

  it('truncates seconds rather than rounding into the next minute', () => {
    expect(isoTimeInTz(Date.UTC(2026, 7, 7, 13, 0, 59), LA)).toBe('06:00');
  });

  it('returns an empty string, never the host zone, for an unknown zone or unformattable instant', () => {
    expect(isoTimeInTz(Date.UTC(2026, 7, 7, 13, 0), 'Not/AZone')).toBe('');
    expect(isoTimeInTz(Number.MAX_VALUE, LA)).toBe('');
  });
});
