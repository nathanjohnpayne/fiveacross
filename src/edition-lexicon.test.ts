import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_EDITION, editionBrand, editionLexicon, setActiveEdition } from './editions';
import { defaultThemeForEdition } from './theme/themes';

// Covers the three vocabulary registers (#608).
//
// `editions.test.ts` covers the pre-auth brand mechanics — resolution, fallback,
// the HTML identity substitution. This file covers the VOCABULARY: that the
// three registers say what the signed-off wording tables say, that no cruise
// noun survives in a string every Edition shares, and — the load-bearing one —
// that Gay Cruise Bingo's rendered copy did not move a byte.

const EDITIONS = ['gcb', 'vacay', 'fiveacross'] as const;

afterEach(() => setActiveEdition(DEFAULT_EDITION));

describe('the lexicon resolves through the active Edition', () => {
  it('answers the legacy register by default', () => {
    expect(editionLexicon().occasion).toBe('cruise');
    expect(editionLexicon().shareMark).toBe('🚢');
  });

  it('follows setActiveEdition, like every other Edition accessor', () => {
    setActiveEdition('fiveacross');
    expect(editionLexicon().occasion).toBe('event');
    expect(editionLexicon().occasionWide).toBe('event-wide');
    expect(editionLexicon().fileSlug).toBe('five-across');
  });

  // #597. `BRANDS` is an object literal, so it inherits Object.prototype; a bare
  // `BRANDS[edition]` answers a TRUTHY non-brand for `constructor`, `toString`,
  // `valueOf` and friends. `hostnames/{host}.edition` is operator-authored, so
  // one typo (or one malicious mapping) would install a FUNCTION as the resolved
  // brand and render a blank wordmark on the sign-in gate instead of falling
  // back to the shipped experience.
  it('falls back to the legacy Edition for an inherited Object.prototype key', () => {
    for (const poisoned of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      setActiveEdition(poisoned);
      const brand = editionBrand();
      expect(brand.wordmark, poisoned).toBe('GAY CRUISE BINGO');
      expect(brand.lexicon.occasion, poisoned).toBe('cruise');
      // The explicit-argument form is the one `vite.config.ts` uses at BUILD
      // time, where a bad value bakes into the manifest permanently.
      expect(editionBrand(poisoned).appName, poisoned).toBe('Gay Cruise Bingo');
      // The exact twin in `theme/themes.ts`: an unguarded lookup there would set
      // `[data-theme]` to a stringified function on the pre-auth shell.
      expect(defaultThemeForEdition(poisoned), poisoned).toBe('neon-playground');
    }
  });
});

describe('the registers say what the wording tables say', () => {
  it('speaks trip, not cruise, on vacay', () => {
    const brand = editionBrand('vacay');
    expect(brand.lexicon).toMatchObject({
      occasion: 'trip',
      occasionWide: 'trip-wide',
      place: 'stop',
      placePlural: 'Stops',
      offlineWhy: 'wherever you land',
      shareMark: '🗺️',
      fileSlug: 'vacay-bingo',
    });
    expect(brand.scheduleTitle).toBe('Trip schedule');
    expect(brand.championRole).toBe('Trip champion');
    expect(brand.blackoutShareText).toBe('BLACKOUT. I win the trip. 🗺️');
  });

  it('speaks occasion-neutral on fiveacross, and spends no camp', () => {
    const brand = editionBrand('fiveacross');
    expect(brand.wordmark).toBe('FIVE ACROSS');
    expect(brand.appName).toBe('Five Across');
    expect(brand.lexicon).toMatchObject({
      occasion: 'event',
      place: 'place',
      placePlural: 'Places',
      offlineWhy: 'in a packed venue',
      shareMark: '✳️',
      fileSlug: 'five-across',
    });
    // The general Edition drops the noun entirely where naming it would be
    // filler — "Schedule", not "Event schedule"; "Champion", not "Event champion".
    expect(brand.scheduleTitle).toBe('Schedule');
    expect(brand.championRole).toBe('Champion');
    expect(brand.podiumLabel).toBe('Final podium');
  });

  // Not flavour. A conference hall or a wedding venue — a few hundred phones on
  // one cell, behind concrete and structural steel — drops signal more reliably
  // than a ship does, so the general Edition gets the STRONGEST offline story of
  // the three, not the weakest. The first draft of #608 omitted the clause here
  // entirely, which gets it exactly backwards.
  it('gives fiveacross a real offline story, not a shortened one', () => {
    const brand = editionBrand('fiveacross');
    expect(brand.offlineNote).toMatch(/offline/i);
    expect(brand.offlineNote.length).toBeGreaterThanOrEqual(editionBrand('vacay').offlineNote.length);
    // Names congestion and barriers as the player experiences them ("no bars"),
    // and deliberately does NOT name jammers: they are real, but an
    // illegal-device reference in a sign-in footnote alarms without informing.
    expect(brand.offlineNote).not.toMatch(/jammer/i);
  });
});

// THE REGRESSION NET. This class of leak reappears with every new string, which
// is why the guard is a scan over the whole table rather than a hand-listed set
// of fields: adding a row to `EditionBrand` without filling in its non-cruise
// registers fails here by default instead of by remembering.
describe('no cruise noun survives outside the cruise Edition', () => {
  const CRUISE_NOUN = /\b(cruise|cruises|sail|sails|sailing|sea|seas|ship|ships|boat|boats|port|ports|aboard|onboard|dock|docked|voyage)\b/i;

  it.each(['vacay', 'fiveacross'])('keeps every cruise noun out of %s', (edition) => {
    const { lexicon, ...text } = editionBrand(edition);
    for (const [field, value] of Object.entries({ ...text, ...lexicon })) {
      expect(value, `${edition}.${field} — "${value}"`).not.toMatch(CRUISE_NOUN);
    }
  });

  // The mirror of the guard above: the cruise-coded emoji budget. 🚢 / 🛳️ / ⛵
  // may appear only behind an Edition-scoped value or GCB-scoped content.
  it.each(['vacay', 'fiveacross'])('keeps the cruise-coded emoji out of %s', (edition) => {
    const { lexicon, ...text } = editionBrand(edition);
    const all = [...Object.values(text), ...Object.values(lexicon)].join(' ');
    for (const emoji of ['🚢', '🛳️', '⛵']) {
      expect(all, `${edition} carries ${emoji}`).not.toContain(emoji);
    }
  });

  // Functional emoji carry STATE or CATEGORY, not tone — they are Edition-
  // invariant by design, and narrowing the guard above to the decorative budget
  // is only defensible if that distinction is actually pinned somewhere.
  it('leaves the functional emoji Edition-invariant', () => {
    for (const edition of EDITIONS) {
      // 🏆 is the champion medal: state, not camp. Every register keeps it.
      expect(editionBrand(edition).championRole, edition).not.toContain('🏆');
    }
  });
});

// #608's load-bearing acceptance: `gcb` is the fallback Edition, so a diff in
// its rendered copy is a BUG, not a rewrite. These are the exact strings that
// shipped before the lexicon existed, transcribed from the pre-#608 source.
describe('Gay Cruise Bingo is byte-identical to what shipped', () => {
  const brand = editionBrand('gcb');

  it.each([
    ['wordmark', 'GAY CRUISE BINGO'],
    ['tagline', 'Sign in, get your card, mark it if you see it.'],
    ['offlineNote', 'Lost signal at sea? The printed cards and PDF still work.'],
    ['documentTitle', 'Gay Cruise Bingo'],
    ['appName', 'Gay Cruise Bingo'],
    ['appShortName', 'Gay Bingo'],
    ['appDescription', 'Live multiplayer bingo for the high seas.'],
    ['passCheckLabel', 'Checking your cruise pass…'],
    ['scheduleTitle', 'Cruise schedule'],
    ['scheduleSub', 'Ports, parties, unlock times'],
    ['walkthroughReplaySub', 'Replay the Welcome Aboard walkthrough'],
    [
      'promptDeadlineNote',
      "Get your prompts in before we sail—once your card is dealt it's frozen, so a prompt added after that joins the pool for a future card, not yours.",
    ],
    [
      'tutorialWarmupNote',
      "This one's a warm-up—easy squares, all on the ship. The real chaos starts tomorrow at 8.",
    ],
    ['championRole', 'Cruise champion'],
    ['podiumLabel', 'Cruise podium'],
    ['reviewQueueAllClear', 'All clear. Go enjoy the boat.'],
    ['bingoShareText', 'I got BINGO on the high seas 🚢'],
    ['blackoutShareText', 'BLACKOUT. I win the boat. 🚢'],
    ['updateToastMark', '🚢'],
    ['updateToastTitle', 'A fresh build just docked'],
    // Rendered through JSX, where the original spelled it `&rsquo;` — the same
    // U+2019 this literal carries.
    ['guidelinesScope', 'one sailing’s friend group'],
  ])('%s', (field, expected) => {
    expect(brand[field as keyof typeof brand]).toBe(expected);
  });

  it('keeps the cruise lexicon the interpolated copy composed before', () => {
    expect(brand.lexicon.occasion).toBe('cruise');
    expect(brand.lexicon.occasionWide).toBe('cruise-wide');
    expect(brand.lexicon.offlineWhy).toBe('at sea');
    expect(brand.lexicon.crowd).toBe('the whole boat');
    expect(brand.lexicon.shareMark).toBe('🚢');
    expect(brand.lexicon.fileSlug).toBe('gay-cruise-bingo');
    // Composed at the call sites: "works offline at sea.", "the whole cruise",
    // "Cruise days", "gay-cruise-bingo-bingo.png".
    expect(`Full screen, works offline ${brand.lexicon.offlineWhy}.`).toBe(
      'Full screen, works offline at sea.',
    );
    expect(`Three for the whole ${brand.lexicon.occasion}`).toBe('Three for the whole cruise');
    expect(`nothing you would not want ${brand.lexicon.crowd} to see`).toBe(
      'nothing you would not want the whole boat to see',
    );
  });
});
