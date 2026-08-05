import type { DayDef } from '../types';

// The free space + the 80 other prompts that seed a new event's pool
// (24 spicy / 56 tame — see specs/seed-and-composition.md).
export const FREE_TEXT = 'Complain about circuit music';

export const SEED_ITEMS: { text: string; spicy: boolean }[] = [
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

// The two curated tutorial pools (daily-cards-spec § "Tutorial item lists"), each
// verbatim, in spec order — 28 entries, all tame (tutorial pools are unstratified,
// so they carry no spicy split). Curated pools are admin-editable but never go
// through the pending-approval gate #210 adds to `main`; seeded with
// `status: 'active'` directly (see scripts/seed.mjs's write path).
export const EASY_ITEMS: { text: string; spicy: false; pool: 'embark' }[] = [
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

export const CLOSING_ITEMS: { text: string; spicy: false; pool: 'farewell' }[] = [
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

// 08:00 Europe/Rome (CEST, UTC+2 for the whole July sailing window — no ship-clock
// drift handling needed per daily-cards-spec § "Itinerary and schedule") on `date`,
// as an ms-epoch constant. Index 0 (the embark tutorial Day) is the spec's one
// exception — unlocked "from the moment the Event opens" rather than 08:00 on its
// date — seeded as `0` (epoch), a sensible default that resolves to "always
// unlocked" since `unlockAt <= now` is true for any real clock value; there is no
// separate "event open" timestamp in the current data model to seed against.
function unlockAt0800Rome(date: string): number {
  return Date.parse(`${date}T08:00:00+02:00`);
}

// The ten-Day mapping that drives the whole feature's unlock/theme/pool machinery
// (daily-cards-spec § "Itinerary and schedule" + "Free space per day"). All eight
// main-day themed Days share `pool: 'main'` — theme is visual only, per the
// spec's already-made decision that all eight themed days deal from the shared
// main pool. `snapshotItemIds` stamping is the scheduler's job (#202), not
// seeded here.
export const DAYS: DayDef[] = [
  {
    index: 0,
    date: '2026-07-15',
    port: 'Trieste',
    portEmoji: '🇮🇹',
    theme: 'welcome-aboard',
    // Day 1's two signature events. "Welcome Party" is paraphrased from the
    // guide's "Atlantis Welcome Party" to keep the brand mark out of user-facing
    // copy — the same w1-themes non-goal that ships summer-white's blurb as "The
    // pinnacle white party" (see THEMES in src/theme/themes.ts).
    tonight: ['⛵ Sail-Away Party', '🎉 Welcome Party'],
    pool: 'embark',
    tutorial: true,
    // The 0 sentinel MEANS "live from event open" (spec § Unlock mechanics) and
    // is load-bearing: the scheduler treats a non-positive cutoff as NO cutoff
    // (#289 — activeSnapshotIds fails open), so an always-open Day snapshots
    // its full pool whenever the seed ran. A positive historical constant here
    // would resurrect the empty-snapshot starvation for any FRESH seed run
    // after that constant, because seeded items carry `createdAt: Date.now()`
    // (Codex P1 on the #289 fix). Do not "fix" this back to a real timestamp.
    unlockAt: 0,
    freeText: 'You made it aboard',
  },
  {
    index: 1,
    date: '2026-07-16',
    port: 'Split',
    portEmoji: '🇭🇷',
    theme: 'uniforms-without-borders',
    tonight: ['🪖 Dog Tag T-Dance', '✈️ Duty Free'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-16'),
  },
  {
    index: 2,
    date: '2026-07-17',
    port: 'Sea Day',
    portEmoji: '🌊',
    theme: 'neon-pink-playground',
    tonight: ['💖 Seriously Pink T-Dance', '🌈 Neon Playground'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-17'),
  },
  {
    index: 3,
    date: '2026-07-18',
    port: 'Valletta',
    portEmoji: '🇲🇹',
    theme: 'sporty-splash',
    tonight: ['💦 Splash T-Dance', '🏋️ Get Sporty'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-18'),
  },
  {
    index: 4,
    date: '2026-07-19',
    port: 'Palermo (Sicily)',
    portEmoji: '🇮🇹',
    theme: 'under-the-stars',
    tonight: ['🎭 AirOtic', '🌌 Under the Stars'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-19'),
  },
  {
    index: 5,
    date: '2026-07-20',
    port: 'Naples (Pompeii)',
    portEmoji: '🇮🇹',
    theme: 'glamiators',
    tonight: ['🎤 Solea Pfeiffer', '🏛️ Glamiators'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-20'),
  },
  {
    index: 6,
    date: '2026-07-21',
    port: 'Rome (Civitavecchia)',
    portEmoji: '🇮🇹',
    theme: 'atlantis-classics',
    // "Dance Classics" paraphrases the guide's "Atlantis Classics" for the same
    // markless-copy non-goal noted on Day 1.
    tonight: ['🎭 Persephone', '🏺 Dance Classics'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-21'),
  },
  {
    index: 7,
    date: '2026-07-22',
    port: 'Villefranche (Nice)',
    portEmoji: '🇫🇷',
    theme: 'summer-white',
    tonight: ['🎤 HAYLA', '🤍 Summer White Party'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-22'),
  },
  {
    index: 8,
    date: '2026-07-23',
    port: 'Marseille',
    portEmoji: '🇫🇷',
    theme: 'revival-disco',
    tonight: ['🪩 Revival! Classic Disco T-Dance', '🎉 Last Dance'],
    pool: 'main',
    tutorial: false,
    unlockAt: unlockAt0800Rome('2026-07-23'),
  },
  {
    index: 9,
    date: '2026-07-24',
    port: 'Barcelona',
    portEmoji: '🇪🇸',
    theme: 'so-long-farewell',
    // Editorial line — disembark morning publishes no guide events.
    tonight: ['🧳 Disembark in Barcelona', '👋 Until next year'],
    pool: 'farewell',
    tutorial: true,
    unlockAt: unlockAt0800Rome('2026-07-24'),
    freeText: 'We had the best damn time',
  },
];
