import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  activeEventPreview,
  applyResolvedEventPreview,
  coerceEventPreview,
  previewDayEmoji,
  previewDayLine,
  previewMetaLine,
  type EventPreview,
} from './eventPreview';
import { readCache, resolveEvent, writeCache, type StorageLike } from './eventResolution';
import type { HostnameDoc } from './types';

// Covers the sign-in gate's Event-preview slice (#647): the defensive read of
// `hostnames/{host}.preview`, the LIVE Day-line computation, and the slice's
// passage through the resolver's network and cache paths. Pure module — no
// network, no DOM, same discipline as eventResolution.test.ts.

const PREVIEW: EventPreview = {
  eventName: 'Weekend in Bodega Bay',
  dateRange: 'Aug 7–9',
  hostedBy: 'Kim',
  days: [
    { date: '2026-08-07', title: 'The Birds Have Entered the Chat', emoji: '🐦' },
    { date: '2026-08-08', title: 'Side Quests' },
    { date: '2026-08-09', title: 'Fog, Froth & Farewells' },
  ],
};

/** A LOCAL-timezone instant on the given date — previewDayLine compares
 *  against the device's local calendar, so tests must construct their "now"
 *  the same way to stay green in every CI timezone. */
const localNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

afterEach(() => applyResolvedEventPreview(null));

describe('coerceEventPreview — fail-soft field-by-field read', () => {
  it('accepts a full slice verbatim', () => {
    expect(coerceEventPreview(PREVIEW)).toEqual(PREVIEW);
  });

  it('rejects the whole slice without an eventName — a nameless card is not drawn', () => {
    expect(coerceEventPreview({ dateRange: 'Aug 7–9', hostedBy: 'Kim' })).toBeUndefined();
    expect(coerceEventPreview({ eventName: '   ' })).toBeUndefined();
    expect(coerceEventPreview(undefined)).toBeUndefined();
    expect(coerceEventPreview('Weekend in Bodega Bay')).toBeUndefined();
    expect(coerceEventPreview(null)).toBeUndefined();
  });

  it('keeps the valid fields of a partially-malformed slice', () => {
    const got = coerceEventPreview({
      eventName: 'Weekend in Bodega Bay',
      dateRange: 42,
      hostedBy: 'Kim',
      days: 'not-a-list',
    });
    expect(got).toEqual({ eventName: 'Weekend in Bodega Bay', hostedBy: 'Kim' });
  });

  it('drops the WHOLE schedule on a malformed Day — never renumbers survivors', () => {
    // A Day's ordinal is its array position: skipping a bad Day 1 would
    // announce the second Day as "Day 1" (Codex P2 round 1). The rest of the
    // slice keeps rendering; only the Day line goes quiet.
    const got = coerceEventPreview({
      eventName: 'Weekend in Bodega Bay',
      hostedBy: 'Kim',
      days: [
        { date: 'Aug 7', title: 'not ISO' },
        { date: '2026-08-08', title: 'Side Quests' },
      ],
    });
    expect(got).toEqual({ eventName: 'Weekend in Bodega Bay', hostedBy: 'Kim' });
  });

  it('drops the whole schedule on an out-of-order or duplicate date — never renumbers or misfires the ordinal', () => {
    // Codex P2 on #653: previewDayLine finds "today" with `findIndex` and
    // reports the array position as the Day number, so a schedule that isn't
    // strictly increasing could skip the current day or announce the wrong
    // ordinal instead of failing soft.
    const outOfOrder = coerceEventPreview({
      eventName: 'Weekend in Bodega Bay',
      hostedBy: 'Kim',
      days: [
        { date: '2026-08-08', title: 'Side Quests' },
        { date: '2026-08-07', title: 'The Birds Have Entered the Chat' },
      ],
    });
    expect(outOfOrder).toEqual({ eventName: 'Weekend in Bodega Bay', hostedBy: 'Kim' });

    const duplicate = coerceEventPreview({
      eventName: 'Weekend in Bodega Bay',
      days: [
        { date: '2026-08-07', title: 'The Birds Have Entered the Chat' },
        { date: '2026-08-07', title: 'Duplicate Day' },
      ],
    });
    expect(duplicate).toEqual({ eventName: 'Weekend in Bodega Bay' });
  });

  it('drops the whole schedule when a date has ISO shape but is not a calendar day', () => {
    for (const date of ['2026-13-01', '2026-02-31']) {
      expect(
        coerceEventPreview({
          eventName: 'Weekend in Bodega Bay',
          days: [{ date, title: 'Not a real Day' }],
        })?.days,
      ).toBeUndefined();
    }
  });

  it('drops an over-long schedule whole rather than truncating it', () => {
    const days = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      title: `Title ${i + 1}`,
    }));
    expect(coerceEventPreview({ eventName: 'ok', days })?.days).toBeUndefined();
  });

  it('drops an over-long field rather than rendering it', () => {
    const got = coerceEventPreview({ eventName: 'ok', hostedBy: 'x'.repeat(500) });
    expect(got).toEqual({ eventName: 'ok' });
  });
});

describe('previewDayLine — computed live, never stored', () => {
  it('previews Day 1 before the event begins — the night-before gate', () => {
    expect(previewDayLine(PREVIEW.days, localNoon(2026, 8, 6))).toBe(
      '🐦 Day 1: The Birds Have Entered the Chat',
    );
  });

  it('numbers the current Day by schedule position, mid-event', () => {
    expect(previewDayLine(PREVIEW.days, localNoon(2026, 8, 8))).toBe('Day 2: Side Quests');
  });

  it('goes quiet after the last Day rather than pointing at a finished one', () => {
    expect(previewDayLine(PREVIEW.days, localNoon(2026, 8, 10))).toBeNull();
  });

  it('goes quiet on a missing or empty schedule', () => {
    expect(previewDayLine(undefined)).toBeNull();
    expect(previewDayLine([])).toBeNull();
  });
});

// #776: the postcard's stamp postage. Read through the SAME Day selection as
// the line above, so the two can never describe different Days — and returning
// `null` on the three no-postage shapes is what makes the empty dashed box
// unreachable in the component.
describe('previewDayEmoji — the stamp postage, or nothing', () => {
  it('is the previewed Day’s own emoji, tracking the same Day as the line', () => {
    expect(previewDayEmoji(PREVIEW.days, localNoon(2026, 8, 6))).toBe('🐦');
    expect(previewDayEmoji(PREVIEW.days, localNoon(2026, 8, 7))).toBe('🐦');
  });

  it('is null on a Day the seed gave no emoji — Bodega’s Days 2 and 3', () => {
    expect(previewDayEmoji(PREVIEW.days, localNoon(2026, 8, 8))).toBeNull();
    expect(previewDayEmoji(PREVIEW.days, localNoon(2026, 8, 9))).toBeNull();
  });

  it('is null once the trip is over, like the Day line it follows', () => {
    expect(previewDayEmoji(PREVIEW.days, localNoon(2026, 8, 10))).toBeNull();
  });

  it('is null on a missing or empty schedule — the loading and pre-#647 shapes', () => {
    expect(previewDayEmoji(undefined)).toBeNull();
    expect(previewDayEmoji([])).toBeNull();
  });

  // Codex P2, round 3: `asText` accepts up to 200 characters because that cap
  // guards a malformed seed, not this layout. The stamp is content-sized
  // against a FIXED reserved corner, so an over-wide value would grow the box
  // back over the copy — the exact overlap #776 removes. Postage that is not
  // one glyph is declined, and the card falls back to its unstamped layout.
  const dayWith = (emoji: string) => [{ date: '2026-08-07', title: 'Day', emoji }];

  it.each([
    ['a whole sentence', 'The Birds Have Entered the Chat'],
    ['several emoji', '🐦🐦🐦'],
    ['an emoji with trailing text', '🐦 Day one'],
    ['a long malformed value', 'x'.repeat(200)],
  ])('declines postage that is not a single glyph: %s', (_label, emoji) => {
    expect(previewDayEmoji(dayWith(emoji), localNoon(2026, 8, 6))).toBeNull();
  });

  it.each([
    ['a plain emoji', '🐦'],
    ['a variation-selector emoji', '🌫️'],
    ['a flag (two code points, one glyph)', '🇮🇹'],
    ['a skin-toned emoji', '👋🏽'],
    ['a ZWJ family sequence', '👨‍👩‍👧‍👦'],
    ['a non-emoji single character', '★'],
  ])('accepts genuine single-glyph postage: %s', (_label, emoji) => {
    expect(previewDayEmoji(dayWith(emoji), localNoon(2026, 8, 6))).toBe(emoji);
  });

  // #779/#780: every case above runs under Vitest's Node environment, where
  // `Intl.Segmenter` is natively available — so none of them ever exercise
  // `isSingleGlyph`'s no-Segmenter fallback. That's how the fallback's old
  // `<= 8 code points` bug (accepting '🐦🐦🐦' or eight ordinary characters as
  // "one glyph") shipped untested. Delete `Intl.Segmenter` for just this
  // block to force every call through the fallback, and restore it
  // afterward — the rest of the suite depends on the real one.
  describe('the isSingleGlyph fallback when Intl.Segmenter is unavailable', () => {
    // Same `as unknown as {...}` cast `isSingleGlyph` itself uses to reach
    // `Intl.Segmenter` as an optional property, so `delete` type-checks.
    type IntlWithOptionalSegmenter = { Segmenter?: unknown };
    const intlWithOptionalSegmenter = Intl as unknown as IntlWithOptionalSegmenter;
    let originalSegmenter: unknown;

    beforeEach(() => {
      originalSegmenter = intlWithOptionalSegmenter.Segmenter;
      delete intlWithOptionalSegmenter.Segmenter;
    });

    afterEach(() => {
      intlWithOptionalSegmenter.Segmenter = originalSegmenter;
    });

    it('still accepts a genuine single code point', () => {
      expect(previewDayEmoji(dayWith('🐦'), localNoon(2026, 8, 6))).toBe('🐦');
    });

    it('rejects three separate emoji — the literal #779/#780 regression case', () => {
      expect(previewDayEmoji(dayWith('🐦🐦🐦'), localNoon(2026, 8, 6))).toBeNull();
    });

    it('rejects eight arbitrary ordinary characters', () => {
      expect(previewDayEmoji(dayWith('abcdefgh'), localNoon(2026, 8, 6))).toBeNull();
    });

    it.each([
      ['a flag (two code points, one glyph)', '🇮🇹'],
      ['a skin-toned emoji', '👋🏽'],
      ['a ZWJ family sequence', '👨‍👩‍👧‍👦'],
    ])(
      'conservatively degrades genuine multi-codepoint postage to null without Segmenter: %s',
      (_label, emoji) => {
        expect(previewDayEmoji(dayWith(emoji), localNoon(2026, 8, 6))).toBeNull();
      },
    );
  });

  it('leaves the Day LINE alone — inline text wraps, so it costs nothing there', () => {
    // Only the STAMP has a layout constraint. A multi-glyph value still leads
    // the line rather than being silently dropped from the card entirely.
    expect(previewDayLine(dayWith('🐦🐦🐦'), localNoon(2026, 8, 6))).toBe('🐦🐦🐦 Day 1: Day');
  });
});

describe('previewMetaLine — the fragments that exist, joined', () => {
  it('joins dates, host and Day line the way the wireframe does', () => {
    expect(previewMetaLine(PREVIEW, localNoon(2026, 8, 6))).toBe(
      'Aug 7–9 · hosted by Kim · 🐦 Day 1: The Birds Have Entered the Chat',
    );
  });

  it('renders the achievable subset when fragments are absent', () => {
    expect(previewMetaLine({ eventName: 'X', hostedBy: 'Kim' })).toBe('hosted by Kim');
    expect(previewMetaLine({ eventName: 'X' })).toBeNull();
  });

  // #776: the emoji MOVES to the stamp, it is not removed — so the Day stays
  // named in words and the glyph is never printed twice on one card.
  it('yields the Day’s emoji to the stamp without losing the Day itself', () => {
    expect(previewMetaLine(PREVIEW, localNoon(2026, 8, 6), 'stamp')).toBe(
      'Aug 7–9 · hosted by Kim · Day 1: The Birds Have Entered the Chat',
    );
    expect(previewDayLine(PREVIEW.days, localNoon(2026, 8, 6), 'stamp')).toBe(
      'Day 1: The Birds Have Entered the Chat',
    );
  });

  it('changes nothing on a Day with no emoji — there is no stamp to yield to', () => {
    const line = previewDayLine(PREVIEW.days, localNoon(2026, 8, 8), 'stamp');
    expect(line).toBe('Day 2: Side Quests');
    expect(line).toBe(previewDayLine(PREVIEW.days, localNoon(2026, 8, 8)));
  });
});

describe('resolved-state singleton', () => {
  it('answers null until installed, then the installed slice', () => {
    expect(activeEventPreview()).toBeNull();
    applyResolvedEventPreview(PREVIEW);
    expect(activeEventPreview()).toEqual(PREVIEW);
    applyResolvedEventPreview(null);
    expect(activeEventPreview()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Passage through the resolver (#647 × #543): the slice must survive both the
// network path and the localStorage envelope, and a malformed cached slice
// must cost the card, never the Event.
// ---------------------------------------------------------------------------

const HOST = 'bodega-bay.vacaybingo.com';
const T0 = 1_700_000_000_000;

const DOC: HostnameDoc = {
  eventId: 'bodega-bay-2026',
  canonicalHost: HOST,
  edition: 'vacay',
  status: 'active',
  adultContent: true,
  slug: 'bodega-bay',
  preview: PREVIEW,
};

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('resolver passthrough', () => {
  it('carries the preview on a network resolution', async () => {
    const r = await resolveEvent({ hostname: HOST, fetchDoc: async () => DOC });
    expect(r).toMatchObject({ kind: 'event', preview: PREVIEW });
  });

  it('round-trips the preview through the cache envelope', () => {
    const s = fakeStorage();
    writeCache(s, HOST, DOC, T0);
    expect(readCache(s, HOST, T0)?.doc.preview).toEqual(PREVIEW);
  });

  it('drops a malformed cached preview without dropping the mapping', () => {
    const s = fakeStorage();
    writeCache(s, HOST, { ...DOC, preview: { eventName: 42 } as unknown as EventPreview }, T0);
    const r = readCache(s, HOST, T0);
    expect(r?.doc.eventId).toBe('bodega-bay-2026');
    expect(r?.doc.preview).toBeUndefined();
  });

  it('resolves the env short-circuit with no preview at all', async () => {
    const r = await resolveEvent({
      hostname: HOST,
      fetchDoc: async () => DOC,
      envEventId: 'med-2026',
    });
    expect(r.kind).toBe('event');
    expect(r.kind === 'event' && r.preview).toBeFalsy();
  });
});
