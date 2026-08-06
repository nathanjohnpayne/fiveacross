// Gay Cruise Bingo — the med-2026 Event's seed payload: the Atlantis Med
// sailing (Trieste → Barcelona, 2026-07-15..24). One module per Event so each
// project's drift verifier (`node scripts/seed.mjs --verify`) compares live
// Firestore against ITS OWN canonical pools rather than a single global set
// (#563). Content moved verbatim from scripts/seed.mjs — the literals are the
// SAME content as src/data/seed.ts (SEED_ITEMS/EASY_ITEMS/CLOSING_ITEMS/DAYS);
// kept as separate literals (rather than imported) so this plain-JS module has
// no cross-module import into the TS app source.
// `src/data/seed-and-composition.test.ts` asserts the two stay in sync.

export const EVENT_SEED = {
  name: 'Atlantis Med—Trieste to Barcelona',
  startsOn: '2026-07-15',
  endsOn: '2026-07-24',
  status: 'active',
  defaultTheme: 'neon-playground',
  claimMode: 'honor', // 'honor' | 'proof_required' | 'admin_confirmed'
  // NOTE: `bannedUids` (#113) is deliberately NOT seeded. This payload is written
  // with { merge: true } and the seed is documented as safe to re-run (to add
  // admins / refresh prompts), so writing bannedUids here would clobber a live ban
  // list back to [] on every reseed once #108 starts populating it — silent data
  // loss (unbanning everyone) on a routine op. A brand-new event never carries the
  // field and reads as [] via eventConverter's missing-field default (converters.ts),
  // and a reseed leaves the existing bannedUids untouched because this merge write
  // never mentions it. The follow-up (#108) fills it via banUser/unbanUser
  // (arrayUnion/arrayRemove) on the admin-writable event doc, never users/{uid}.
  // reportHideThreshold is load-bearing (ADR 0004 reactive moderation: auto-hide
  // at 4 distinct reports; value pending final confirmation via #15).
  // spicyRatio is the target share of spicy (🔞) Prompts among a Board's 24
  // non-free Squares for `dealBoard`'s stratified sampling (w1-seed-and-composition);
  // 0.4 matches `dealBoard`'s own default, kept explicit here so the seeded Event
  // doc is self-describing rather than relying on the app-side fallback. ADR 0004
  // removed the event's other Phase-0 flag as dead config (type-side removal:
  // w0-type-contract), so no other key is seeded here.
  settings: { reportHideThreshold: 4, spicyRatio: 0.4 },
  // Single event timezone (daily-cards-spec § "Itinerary and schedule") — every
  // port on the July sailing is CEST, so no ship-clock drift handling is needed.
  timezone: 'Europe/Rome',
  // The ten-Day mapping that drives the whole feature's unlock/theme/pool
  // machinery (daily-cards-spec § "Itinerary and schedule" + "Free space per
  // day"), the SAME content as `DAYS` in `src/data/seed.ts`; kept as a separate
  // literal here for the same no-cross-module-import reason as ITEMS below.
  // `src/data/seed-and-composition.test.ts` asserts the two stay in sync.
  days: [
    {
      index: 0,
      date: '2026-07-15',
      place: 'Trieste',
      placeEmoji: '🇮🇹',
      theme: 'welcome-aboard',
      // Paraphrased from the guide's "Atlantis Welcome Party" for the markless-
      // copy non-goal (mirrors src/data/seed.ts + THEMES).
      tonight: ['⛵ Sail-Away Party', '🎉 Welcome Party'],
      pool: 'embark',
      tutorial: true,
      // 0 = "live from event open", and the scheduler fails OPEN on a
      // non-positive cutoff (#289) — a positive historical constant would
      // re-starve any FRESH seed run after it (seeded items carry
      // `createdAt: Date.now()`; Codex P1). Mirrors src/data/seed.ts.
      unlockAt: 0,
      freeText: 'You made it aboard',
    },
    {
      index: 1,
      date: '2026-07-16',
      place: 'Split',
      placeEmoji: '🇭🇷',
      theme: 'uniforms-without-borders',
      tonight: ['🪖 Dog Tag T-Dance', '✈️ Duty Free'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-16T08:00:00+02:00'),
    },
    {
      index: 2,
      date: '2026-07-17',
      place: 'Sea Day',
      placeEmoji: '🌊',
      theme: 'neon-pink-playground',
      tonight: ['💖 Seriously Pink T-Dance', '🌈 Neon Playground'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-17T08:00:00+02:00'),
    },
    {
      index: 3,
      date: '2026-07-18',
      place: 'Valletta',
      placeEmoji: '🇲🇹',
      theme: 'sporty-splash',
      tonight: ['💦 Splash T-Dance', '🏋️ Get Sporty'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-18T08:00:00+02:00'),
    },
    {
      index: 4,
      date: '2026-07-19',
      place: 'Palermo (Sicily)',
      placeEmoji: '🇮🇹',
      theme: 'under-the-stars',
      tonight: ['🎭 AirOtic', '🌌 Under the Stars'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-19T08:00:00+02:00'),
    },
    {
      index: 5,
      date: '2026-07-20',
      place: 'Naples (Pompeii)',
      placeEmoji: '🇮🇹',
      theme: 'glamiators',
      tonight: ['🎤 Solea Pfeiffer', '🏛️ Glamiators'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-20T08:00:00+02:00'),
    },
    {
      index: 6,
      date: '2026-07-21',
      place: 'Rome (Civitavecchia)',
      placeEmoji: '🇮🇹',
      theme: 'atlantis-classics',
      // "Dance Classics" paraphrases the guide's "Atlantis Classics".
      tonight: ['🎭 Persephone', '🏺 Dance Classics'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-21T08:00:00+02:00'),
    },
    {
      index: 7,
      date: '2026-07-22',
      place: 'Villefranche (Nice)',
      placeEmoji: '🇫🇷',
      theme: 'summer-white',
      tonight: ['🎤 HAYLA', '🤍 Summer White Party'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-22T08:00:00+02:00'),
    },
    {
      index: 8,
      date: '2026-07-23',
      place: 'Marseille',
      placeEmoji: '🇫🇷',
      theme: 'revival-disco',
      tonight: ['🪩 Revival! Classic Disco T-Dance', '🎉 Last Dance'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-23T08:00:00+02:00'),
    },
    {
      index: 9,
      date: '2026-07-24',
      place: 'Barcelona',
      placeEmoji: '🇪🇸',
      theme: 'so-long-farewell',
      // Editorial line — disembark morning publishes no guide events.
      tonight: ['🧳 Disembark in Barcelona', '👋 Until next year'],
      pool: 'farewell',
      tutorial: true,
      unlockAt: Date.parse('2026-07-24T08:00:00+02:00'),
      freeText: 'We had the best damn time',
    },
  ],
};

// asserts the two stay in sync.
export const ITEMS = [
  { text: `Threesome`, spicy: true },
  { text: `Foursome`, spicy: true },
  { text: `Fivesome`, spicy: true },
  { text: `Get propositioned by septuagenarians`, spicy: true },
  { text: `Suite orgy`, spicy: true },
  { text: `Domestic violence`, spicy: false },
  { text: `Dance-floor blowjob`, spicy: true },
  { text: `Get locked in a bathroom`, spicy: false },
  { text: `Lost passport`, spicy: false },
  { text: `Make OnlyFans content on a boat`, spicy: true },
  { text: `Make LinkedIn content on a boat`, spicy: false },
  { text: `Selfie with Bianca Del Rio`, spicy: false },
  { text: `Selfie with HAYLA`, spicy: false },
  { text: `Three loads in one day`, spicy: true },
  { text: `Bang a Dutch person`, spicy: true },
  { text: `Bang an Aussie`, spicy: true },
  { text: `Sex with four gays from four continents`, spicy: true },
  { text: `Passaround-party Norwegian`, spicy: true },
  // entry 19 = Free Space (FREE_TEXT) — not a pool Prompt
  { text: `Poppers spill`, spicy: true },
  { text: `30-year age gap`, spicy: true },
  { text: `Dance-floor k-hole`, spicy: false },
  { text: `Cafeteria k-hole`, spicy: false },
  { text: `Make out with a woman`, spicy: true },
  { text: `Three-way kiss`, spicy: true },
  { text: `Cause an international incident`, spicy: false },
  { text: `Wear a sissy skirt`, spicy: true },
  { text: `Loudly announce an early night`, spicy: false },
  { text: `Karaoke "Fergalicious"`, spicy: false },
  { text: `Eat carbs`, spicy: false },
  { text: `Become Dick Deck famous`, spicy: true },
  { text: `Post a butthole pic to Telegram`, spicy: true },
  { text: `Use a condom`, spicy: true },
  { text: `Mirror-hall selfie`, spicy: false },
  { text: `Snort powder off a cock`, spicy: true },
  { text: `Hear Madonna's "Danceteria" on the dance floor`, spicy: false },
  { text: `Get read by Bianca Del Rio`, spicy: false },
  { text: `Get bred by Bianca Del Rio`, spicy: true },
  { text: `Drink three dirty martinis`, spicy: false },
  { text: `Matching Speedos`, spicy: false },
  { text: `Sunset selfie`, spicy: false },
  { text: `Lost bracelet`, spicy: false },
  { text: `Dramatic outfit change before dinner`, spicy: false },
  { text: `Feathers, mesh, or sequins before noon`, spicy: false },
  { text: `"I'm just having one drink"`, spicy: false },
  { text: `Pool-chair territory dispute`, spicy: false },
  { text: `Overpacked toiletries`, spicy: false },
  { text: `Cruise boyfriend`, spicy: false },
  { text: `Cruise-boyfriend breakup`, spicy: false },
  { text: `Accidental matching outfits`, spicy: false },
  { text: `Elevator outfit compliment`, spicy: false },
  { text: `New best friend from another city`, spicy: false },
  { text: `Late-night pizza`, spicy: false },
  { text: `Breakfast in sunglasses`, spicy: false },
  { text: `Nap through the main event`, spicy: false },
  { text: `Poolside caftan moment`, spicy: false },
  { text: `Too many group chats`, spicy: false },
  { text: `"I need electrolytes"`, spicy: false },
  { text: `Emergency fan deployment`, spicy: false },
  { text: `Cabaret hands during karaoke`, spicy: false },
  { text: `Join a new friend group`, spicy: false },
  { text: `Themed-party costume escalation`, spicy: false },
  { text: `Get lost on the ship`, spicy: false },
  { text: `Ship-photographer ambush`, spicy: false },
  { text: `"This is my vacation personality"`, spicy: false },
  { text: `Unexpected Broadway sing-along`, spicy: false },
  { text: `Become ship-famous`, spicy: false },
  { text: `Matching tank tops`, spicy: false },
  { text: `Reappear at Dick Deck two hours after "going to bed"`, spicy: false },
  { text: `Suspiciously perfect tan`, spicy: false },
  { text: `"I'm never drinking again"`, spicy: false },
  { text: `"I need a vacation from my vacation"`, spicy: false },
  { text: `Caftan gets sincere applause`, spicy: false },
  { text: `Garment steamer packed`, spicy: false },
  { text: `Group-dinner reservation drama`, spicy: false },
  { text: `Bathroom-mirror selfie`, spicy: false },
  { text: `Book next year's cruise before this one ends`, spicy: false },
  { text: `"I'm going to be homophobic for a week after this cruise"`, spicy: false },
  { text: `Dance to the "Total Eclipse of the Heart" remix`, spicy: false },
  { text: `Fuck a drag queen out of drag`, spicy: true },
  { text: `Fuck a drag queen IN drag`, spicy: true },
];

// The two curated tutorial pools (daily-cards-spec § "Tutorial item lists"), the
// SAME content as `EASY_ITEMS`/`CLOSING_ITEMS` in `src/data/seed.ts`; kept as
// separate literals here for the same no-cross-module-import reason as ITEMS
// above. `src/data/seed-and-composition.test.ts` asserts they stay in sync.
export const EASY_ITEMS = [
  { text: `Get your favorite dessert`, spicy: false, pool: 'embark' },
  { text: `Find your muster station`, spicy: false, pool: 'embark' },
  { text: `Get lost finding your cabin`, spicy: false, pool: 'embark' },
  { text: `Ride an elevator the wrong way`, spicy: false, pool: 'embark' },
  { text: `Locate the late-night pizza`, spicy: false, pool: 'embark' },
  { text: `First soft-serve of the cruise`, spicy: false, pool: 'embark' },
  { text: `Toast at the sailaway party`, spicy: false, pool: 'embark' },
  { text: `Wave goodbye to land`, spicy: false, pool: 'embark' },
  { text: `Hear the ship's horn`, spicy: false, pool: 'embark' },
  { text: `Meet someone from another country`, spicy: false, pool: 'embark' },
  { text: `Learn a crew member's name`, spicy: false, pool: 'embark' },
  { text: `Befriend a bartender`, spicy: false, pool: 'embark' },
  { text: `Compliment a stranger's outfit`, spicy: false, pool: 'embark' },
  { text: `Ask "where are you from?" three times`, spicy: false, pool: 'embark' },
  { text: `Exchange Instagrams with a new friend`, spicy: false, pool: 'embark' },
  { text: `Spot matching Speedos`, spicy: false, pool: 'embark' },
  { text: `Unpack a truly unhinged outfit`, spicy: false, pool: 'embark' },
  { text: `Plan tomorrow's party look`, spicy: false, pool: 'embark' },
  { text: `Test the bed (nap counts)`, spicy: false, pool: 'embark' },
  { text: `Stateroom mirror selfie`, spicy: false, pool: 'embark' },
  { text: `Balcony or porthole photo`, spicy: false, pool: 'embark' },
  { text: `Order a frozen drink with zero shame`, spicy: false, pool: 'embark' },
  { text: `Sunscreen a stranger's back (or volunteer yours)`, spicy: false, pool: 'embark' },
  { text: `Scope out the gym you'll never use`, spicy: false, pool: 'embark' },
  { text: `Find the theater`, spicy: false, pool: 'embark' },
  { text: `Locate the Dick Deck (reconnaissance only)`, spicy: false, pool: 'embark' },
  { text: `Sign up for something you'll never attend`, spicy: false, pool: 'embark' },
  { text: `Overhear someone already complaining`, spicy: false, pool: 'embark' },
];

export const CLOSING_ITEMS = [
  { text: `One last sunrise or sunset photo`, spicy: false, pool: 'farewell' },
  { text: `Say goodbye to your cruise boyfriend`, spicy: false, pool: 'farewell' },
  { text: `Exchange numbers with your new best friend`, spicy: false, pool: 'farewell' },
  { text: `Promise to visit someone in their city`, spicy: false, pool: 'farewell' },
  { text: `Say "see you next year"—and mean it`, spicy: false, pool: 'farewell' },
  { text: `Book next year's cruise (or swear you will)`, spicy: false, pool: 'farewell' },
  { text: `Final soft-serve`, spicy: false, pool: 'farewell' },
  { text: `Thank your cabin steward by name`, spicy: false, pool: 'farewell' },
  { text: `Thank the bartender who carried you`, spicy: false, pool: 'farewell' },
  { text: `One last lap around the ship`, spicy: false, pool: 'farewell' },
  { text: `Last dance to one more song`, spicy: false, pool: 'farewell' },
  { text: `Group photo with your chosen family`, spicy: false, pool: 'farewell' },
  { text: `Cry (or valiantly almost cry)`, spicy: false, pool: 'farewell' },
  { text: `Find glitter somewhere impossible`, spicy: false, pool: 'farewell' },
  { text: `Suitcase no longer closes`, spicy: false, pool: 'farewell' },
  { text: `Wear your softest airport look`, spicy: false, pool: 'farewell' },
  { text: `Breakfast in sunglasses, one last time`, spicy: false, pool: 'farewell' },
  { text: `Swap favorite memories of the week`, spicy: false, pool: 'farewell' },
  { text: `"I'm never drinking again" (sincere)`, spicy: false, pool: 'farewell' },
  { text: `Post the photo dump`, spicy: false, pool: 'farewell' },
  { text: `Screenshot the group chat's new name`, spicy: false, pool: 'farewell' },
  { text: `Set a reunion date`, spicy: false, pool: 'farewell' },
  { text: `Give away your leftover sunscreen`, spicy: false, pool: 'farewell' },
  { text: `Realize you never used the gym`, spicy: false, pool: 'farewell' },
  { text: `Hum the song of the week`, spicy: false, pool: 'farewell' },
  { text: `Take home a (legal) souvenir`, spicy: false, pool: 'farewell' },
  { text: `Five-star shoutout for your favorite crew member`, spicy: false, pool: 'farewell' },
  { text: `Stand at the back of the ship and feel things`, spicy: false, pool: 'farewell' },
];

// All three seeded pools combined — the main 80-entry pool (untagged, so it
// defaults to 'main' in seedItemMutations) plus the two curated tutorial pools
// (already tagged). Curated pools are seeded `status: 'active'` directly (no
// pending-approval gate — that gate is `main`-only, per daily-cards-spec §
// "Item pools and the approval flow").
export const ALL_ITEMS = [...ITEMS, ...EASY_ITEMS, ...CLOSING_ITEMS];
