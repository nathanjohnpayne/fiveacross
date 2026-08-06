// Seed the event + prompt pool using the Firebase Admin SDK (bypasses security rules).
//
// One-time setup (Application Default Credentials — no committed key file):
//   1. npm install
//   2. gcloud auth application-default login
//   3. Find each Admin's Google UID: sign into the app once, then Firebase console > Authentication > Users.
//   4. ADMIN_UID=<uid>[,<uid>,...] GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/seed.mjs
//
// Admin roster: Admin is the only privileged role, and `events/{id}.admins` is the
// roster the app trusts. ADMIN_UID takes a comma-separated list of uids; the target
// roster is 2–4 Admins including Nathan's seed uid (the concrete co-admin uids are
// the #15 decision). The event write merges, and when ADMIN_UID is unset the write
// omits `admins` entirely — so re-running the seed never wipes a granted roster, and
// re-running with the final roster once #15 lands is safe.
//
// Falls back to a serviceAccountKey.json in the project root if one exists
// (gitignored — do NOT commit).
//
// Itinerary (`days[]`): written only when the Event doc doesn't exist yet — the
// schedule stays admin-editable in the Admin console afterward, so a routine
// reseed leaves a live schedule untouched. Pass SEED_DAYS=1 to explicitly
// overwrite `days` on an existing Event (a deliberate itinerary migration).
//
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Seed payload — importable with no side effects (Firebase is only touched when
// the script is executed directly, below). `src/test/w1-event-seed.test.ts`
// asserts this shape per specs/w1-event-seed.md.
// ---------------------------------------------------------------------------

export const EVENT_SEED = {
  name: 'Atlantis Med—Trieste to Barcelona',
  sailStart: '2026-07-15',
  sailEnd: '2026-07-24',
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
      port: 'Trieste',
      portEmoji: '🇮🇹',
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
      port: 'Split',
      portEmoji: '🇭🇷',
      theme: 'uniforms-without-borders',
      tonight: ['🪖 Dog Tag T-Dance', '✈️ Duty Free'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-16T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-17T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-18T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-19T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-20T08:00:00+02:00'),
    },
    {
      index: 6,
      date: '2026-07-21',
      port: 'Rome (Civitavecchia)',
      portEmoji: '🇮🇹',
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
      port: 'Villefranche (Nice)',
      portEmoji: '🇫🇷',
      theme: 'summer-white',
      tonight: ['🎤 HAYLA', '🤍 Summer White Party'],
      pool: 'main',
      tutorial: false,
      unlockAt: Date.parse('2026-07-22T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-23T08:00:00+02:00'),
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
      unlockAt: Date.parse('2026-07-24T08:00:00+02:00'),
      freeText: 'We had the best damn time',
    },
  ],
};

// Parse the ADMIN_UID env var (comma-separated uids) into the events/{id}.admins roster.
export function adminRoster(raw = '') {
  return raw
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean);
}

// The exact object written to events/{id}: `admins` is omitted when the roster is
// empty so a `merge: true` re-run without ADMIN_UID leaves the existing roster alone.
//
// `deleteBlackoutEnabled` is a Firestore delete-field sentinel (`FieldValue.delete()`
// from firebase-admin/firestore), injected by the caller rather than imported at module
// scope so this function stays import-safe without the dev-only firebase-admin install
// (see the dynamic import in `seed()` below). It is written at `settings.blackoutEnabled`
// because a `{ merge: true }` write only touches leaf paths present in the payload:
// re-running this seed against an Event doc the previous seed already wrote —
// which included `blackoutEnabled` — would otherwise leave that stale ADR 0004 field in
// place forever. The sentinel actively deletes it instead of merely omitting it.
// `includeDays` defaults to true (a brand-new Event needs the itinerary written
// once), but a routine reseed against an EXISTING Event must omit `days` — the
// schedule stays admin-editable in the Admin console (daily-cards-spec §
// "Itinerary and schedule": "party order can shift onboard"), and this payload
// is written with `{ merge: true }`, so including `days` here would replace the
// live `days[]` array wholesale on every reseed and silently discard any admin
// edit (Codex P2, PR #229). `seed()` below decides `includeDays` by checking
// whether the Event doc already exists (or via the explicit `SEED_DAYS=1`
// migration override), not this function.
export function eventWritePayload(admins, deleteBlackoutEnabled, includeDays = true) {
  // Destructure `days` out rather than spreading it in conditionally: setting a
  // key to `undefined` would still send `days: undefined` to the Admin SDK
  // (which throws unless `ignoreUndefinedProperties` is set) instead of simply
  // omitting the field from the merge write.
  const { days, ...seedWithoutDays } = EVENT_SEED;
  return {
    ...(includeDays ? EVENT_SEED : seedWithoutDays),
    settings: {
      ...EVENT_SEED.settings,
      blackoutEnabled: deleteBlackoutEnabled,
    },
    ...(admins.length ? { admins } : {}),
  };
}

// Canonical 80-entry Prompt pool (24 spicy / 56 tame — w1-seed-and-composition),
// the SAME content as `SEED_ITEMS` in `src/data/seed.ts`; kept as a separate
// literal here (rather than imported) so this plain-JS script has no
// cross-module import into the TS app source. `src/data/seed-and-composition.test.ts`
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

// Deterministic doc id (content hash of the text only) so re-running the seed
// upserts the same prompt docs instead of creating duplicates (boards sample
// distinct ids, so dupes would surface the same prompt on multiple squares).
export function seedItemDocId(text) {
  return `seed-${createHash('sha1').update(text).digest('hex').slice(0, 20)}`;
}

// All three seeded pools combined — the main 80-entry pool (untagged, so it
// defaults to 'main' below) plus the two curated tutorial pools (already
// tagged). Curated pools are seeded `status: 'active'` directly (no
// pending-approval gate — that gate is `main`-only, per daily-cards-spec §
// "Item pools and the approval flow").
export const ALL_ITEMS = [...ITEMS, ...EASY_ITEMS, ...CLOSING_ITEMS];

export function seedItemMutations(existingDocs, now = Date.now(), pool = ALL_ITEMS) {
  return {
    deleteIds: existingDocs.filter((doc) => doc.createdBy === 'seed').map((doc) => doc.id),
    writes: pool.map(({ text, spicy, pool: itemPool }) => ({
      id: seedItemDocId(text),
      data: {
        text,
        createdBy: 'seed',
        createdAt: now,
        isFreeSpace: false,
        status: 'active',
        reportCount: 0,
        spicy,
        // Honor the now-required ItemDoc.pool: main-pool entries in ITEMS carry
        // no `pool` tag of their own (so default to 'main'); embark/farewell
        // entries already carry their own tag.
        pool: itemPool ?? 'main',
      },
    })),
  };
}

// Drift check (#129 reopened): the app renders the pool from Firestore, not from
// the JS bundle, so a change to ITEMS only reaches players once this seed is
// re-run against the live project. Merging + deploying the frontend does NOT
// reseed — so a pool change can pass CI, ship the bundle, and still leave players
// on the OLD pool (exactly what happened after #135: 87-prompt pool merged, but
// events/{id}/items still held the pre-#135 32). `verifySeedPool` compares the
// live SEED-OWNED docs against the canonical `pool` and reports the drift so a
// post-deploy check (or `node scripts/seed.mjs --verify`) fails loudly instead of
// the mismatch going unnoticed. Player-submitted docs (createdBy !== 'seed') are
// ignored — they are not part of the canonical pool and must never count as drift.
export function verifySeedPool(
  existingDocs,
  // Defaults to ALL_ITEMS (main + embark + farewell), not the main-only ITEMS:
  // both real call sites (seed()/verify() below) already pass ALL_ITEMS
  // explicitly, and a caller that relies on the documented/default contract
  // (an ad-hoc smoke check, a test that omits the argument) must not silently
  // report OK while every embark/farewell seed doc is missing or stale
  // (Codex P2, PR #229).
  pool = ALL_ITEMS,
  reportHideThreshold = EVENT_SEED.settings.reportHideThreshold,
) {
  const expected = new Map(
    pool.map(({ text, spicy, pool: itemPool }) => [
      seedItemDocId(text),
      // An untagged entry (the main 80-entry pool in ITEMS) defaults to 'main',
      // mirroring the stamp in `seedItemMutations`; a tagged entry (embark/
      // farewell) keeps its own tag — a live seed doc missing `pool` or
      // drifted to another pool is itself drift this check surfaces.
      { text, spicy, isFreeSpace: false, status: 'active', pool: itemPool ?? 'main' },
    ]),
  );
  const seedDocs = existingDocs.filter((doc) => doc.createdBy === 'seed');
  const seedById = new Map(seedDocs.map((doc) => [doc.id, doc]));

  // Canonical prompts absent from the live seed pool (a new/renamed prompt that
  // was never seeded — the #135 symptom for every new-text entry).
  const missing = [];
  // Present at the canonical id but a stored field drifted from the canonical
  // record. The doc id is a content hash of `text`, so a matching id normally
  // implies matching text — but a malformed or hand-edited doc can carry the
  // canonical id with a different stored `text`, and the whole point of this
  // check is to catch a live pool that has silently diverged, so compare the
  // stored fields exactly (Codex P2, PR #139) rather than trusting the id.
  // `spicy` is compared strictly, not by truthiness: firestore.rules require
  // `spicy is bool`, so a live value of `"true"`, `1`, `undefined`, or a missing
  // field (all of which `Boolean(...)` would silently coerce to the "right"
  // answer) is itself drift the check must surface (Codex P2, PR #139).
  const mismatched = [];
  for (const [id, expectedDoc] of expected) {
    const { text } = expectedDoc;
    const live = seedById.get(id);
    if (!live) {
      missing.push({ id, text });
    } else if (
      live.text !== expectedDoc.text ||
      live.spicy !== expectedDoc.spicy ||
      live.isFreeSpace !== expectedDoc.isFreeSpace ||
      live.status !== expectedDoc.status ||
      live.pool !== expectedDoc.pool ||
      (typeof reportHideThreshold === 'number' &&
        reportHideThreshold > 0 &&
        live.reportCount >= reportHideThreshold)
    ) {
      mismatched.push({
        id,
        text,
        expectedSpicy: expectedDoc.spicy,
        actualSpicy: live.spicy,
        ...(live.text !== text ? { actualText: live.text } : {}),
        ...(live.isFreeSpace !== expectedDoc.isFreeSpace
          ? { expectedIsFreeSpace: expectedDoc.isFreeSpace, actualIsFreeSpace: live.isFreeSpace }
          : {}),
        ...(live.status !== expectedDoc.status
          ? { expectedStatus: expectedDoc.status, actualStatus: live.status }
          : {}),
        ...(live.pool !== expectedDoc.pool
          ? { expectedPool: expectedDoc.pool, actualPool: live.pool }
          : {}),
        ...(typeof reportHideThreshold === 'number' &&
        reportHideThreshold > 0 &&
        live.reportCount >= reportHideThreshold
          ? { reportHideThreshold, actualReportCount: live.reportCount }
          : {}),
      });
    }
  }
  // Seed-owned docs the canonical pool no longer contains (an old prompt that a
  // reseed should have deleted — the #135 symptom for every retired entry).
  const stale = seedDocs
    .filter((doc) => !expected.has(doc.id))
    .map((doc) => ({ id: doc.id, text: doc.text }));

  return {
    ok: missing.length === 0 && mismatched.length === 0 && stale.length === 0,
    expected: expected.size,
    seedOwned: seedDocs.length,
    playerOwned: existingDocs.length - seedDocs.length,
    missing,
    mismatched,
    stale,
  };
}

// ---------------------------------------------------------------------------
// Seeding — runs only when executed directly (`node scripts/seed.mjs`), so
// importing the payload above never requires the dev-only firebase-admin install.
// ---------------------------------------------------------------------------

// Resolve the Admin SDK + a Firestore handle. Shared by `seed()` (writes) and
// `verify()` (read-only). firebase-admin is a dev dependency used only when this
// script runs directly. The specifiers are computed + @vite-ignore so Vite (which transforms
// this module when a test imports the pure payload/verify builders) never tries
// to resolve them at transform time — Node resolves them normally at run time.
export async function initFirestore() {
  const { readFileSync, existsSync } = await import('node:fs');
  const adminAppModule = 'firebase-admin/app';
  const adminFirestoreModule = 'firebase-admin/firestore';
  let initializeApp, cert, applicationDefault, getFirestore, FieldValue;
  try {
    ({ initializeApp, cert, applicationDefault } = await import(/* @vite-ignore */ adminAppModule));
    ({ getFirestore, FieldValue } = await import(/* @vite-ignore */ adminFirestoreModule));
  } catch (err) {
    // Keep a focused error if a partial or production-only install omitted the
    // dev dependency, rather than surfacing a raw ERR_MODULE_NOT_FOUND.
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'firebase-admin is not installed — it is a dev-only dependency this script\n' +
          'loads at runtime. Install it first, then re-run:\n' +
          '  npm i -D firebase-admin',
      );
      process.exit(1);
    }
    throw err;
  }

  const EVENT_ID = process.env.VITE_EVENT_ID || 'med-2026';

  // Pin the target Firebase project so a bare `node scripts/seed.mjs [--verify]`
  // (npm run seed / verify:seed) can never silently read or write the wrong
  // project (Codex P2, PR #139): prefer the standard env vars, else fall back to
  // the .firebaserc default, and pass it to initializeApp explicitly rather than
  // relying on ADC's ambient project.
  let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
  if (!projectId) {
    const rcUrl = new URL('../.firebaserc', import.meta.url);
    if (existsSync(rcUrl)) {
      try {
        projectId = JSON.parse(readFileSync(rcUrl, 'utf8'))?.projects?.default || '';
      } catch {
        projectId = '';
      }
    }
  }

  const keyUrl = new URL('../serviceAccountKey.json', import.meta.url);
  initializeApp({
    ...(existsSync(keyUrl)
      ? { credential: cert(JSON.parse(readFileSync(keyUrl))) }
      : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  });
  return { db: getFirestore(), EVENT_ID, FieldValue, projectId };
}

async function seed() {
  const { db, EVENT_ID, FieldValue } = await initFirestore();
  const admins = adminRoster(process.env.ADMIN_UID);

  const eventRef = db.doc(`events/${EVENT_ID}`);
  // Write `days` when creating the Event, when the existing Event has no
  // schedule yet (missing/empty `days`), or when SEED_DAYS=1 explicitly opts
  // into overwriting it (e.g. a deliberate itinerary migration). A routine
  // reseed against an existing Event that already HAS a schedule (to refresh
  // prompts, grant an admin, etc.) must never clobber a live, admin-edited
  // schedule (Codex P2, PR #229 — daily-cards-spec § "Itinerary and
  // schedule": "the schedule stays admin-editable in the Admin console").
  // Checking existence alone missed the case where the Event doc was created
  // without a schedule (e.g. med-2026 pre-dating this migration): the
  // existence check alone left `days` permanently missing until an operator
  // knew to pass SEED_DAYS=1 (Codex P1, PR #229).
  const existingEventSnap = await eventRef.get();
  const existingDays = existingEventSnap.data()?.days;
  const hasScheduledDays = Array.isArray(existingDays) && existingDays.length > 0;
  const includeDays = !hasScheduledDays || process.env.SEED_DAYS === '1';
  await eventRef.set(eventWritePayload(admins, FieldValue.delete(), includeDays), {
    merge: true,
  });

  const col = eventRef.collection('items');

  // Replace semantics, not append (w1-seed-and-composition): every SEED-OWNED
  // item doc is deleted and the current ITEMS are (re)written in ONE atomic
  // batch (Codex P2, PR #135) — not a delete batch committed separately from
  // the write batch, which would leave events/{id}/items with no seed prompts
  // (and joinAndDeal short of MIN_POOL) if the process died or the write
  // batch failed between the two commits. A doc whose id is unchanged across
  // reseeds (same text) gets a delete followed by a set within the same
  // batch; Firestore applies per-document batch ops in order, so the set is
  // what lands. The delete pass is scoped to `createdBy === 'seed'`
  // (CodeRabbit Major, PR #135) — addItem writes live Player-submitted
  // prompts into this SAME collection with their own uid as createdBy, so an
  // unscoped delete-everything would erase user content on every reseed.
  const existing = await col.get();
  const { deleteIds, writes } = seedItemMutations(
    existing.docs.map((doc) => ({
      id: doc.id,
      createdBy: doc.data().createdBy,
    })),
    Date.now(),
  );
  const batch = db.batch();
  for (const id of deleteIds) batch.delete(col.doc(id));
  for (const { id, data } of writes) batch.set(col.doc(id), data, { merge: true });
  await batch.commit();

  // Self-check: read the collection back and confirm the live seed pool now
  // matches the canonical ALL_ITEMS (main + embark + farewell). A green seed
  // run that leaves drift (partial batch, wrong project, stale doc a scoped
  // delete missed) should fail loudly right here, not weeks later when a
  // player notices the old prompts.
  const report = verifySeedPool(
    (await col.get()).docs.map((doc) => ({
      id: doc.id,
      text: doc.data().text,
      createdBy: doc.data().createdBy,
      spicy: doc.data().spicy,
      isFreeSpace: doc.data().isFreeSpace,
      status: doc.data().status,
      reportCount: doc.data().reportCount,
      pool: doc.data().pool,
    })),
    ALL_ITEMS,
  );
  if (!report.ok) {
    console.error(formatDriftReport(report, EVENT_ID));
    process.exit(1);
  }

  console.log(`Seeded ${ALL_ITEMS.length} prompts into events/${EVENT_ID}.`);
  // Redacted on purpose (CodeQL js/clear-text-logging, alert #2): report that the
  // roster was set — and how many uids parsed — without echoing the env-sourced uids.
  console.log(
    admins.length
      ? `Admins: set (${admins.length})`
      : 'No ADMIN_UID set — set the roster (comma-separated uids) and re-run to grant admin.',
  );
  process.exit(0);
}

// Render a `verifySeedPool` drift report as a human-readable, actionable block.
// Only the first few entries per bucket are listed so a wholesale reseed (dozens
// of missing/stale) stays readable; the counts tell the full story.
export function formatDriftReport(report, eventId) {
  const preview = (rows) =>
    rows
      .slice(0, 5)
      .map((r) => JSON.stringify(r.text))
      .join(', ') + (rows.length > 5 ? ', …' : '');
  const lines = [
    `✗ events/${eventId}/items DRIFTS from the canonical ${report.expected}-prompt pool`,
    `  live seed-owned: ${report.seedOwned}   player-owned (ignored): ${report.playerOwned}`,
  ];
  if (report.missing.length)
    lines.push(`  missing from live (${report.missing.length}): ${preview(report.missing)}`);
  if (report.stale.length)
    lines.push(`  stale in live (${report.stale.length}): ${preview(report.stale)}`);
  if (report.mismatched.length)
    lines.push(`  field drift (${report.mismatched.length}): ${preview(report.mismatched)}`);
  // Reconcile with a bare reseed — NO ADMIN_UID. The seed's event write merges,
  // and omitting ADMIN_UID leaves `events/{id}.admins` untouched (a reseed to
  // refresh prompts must never overwrite the live admin roster, Codex P2 PR
  // #139). ADMIN_UID is only for the separate act of *granting* admin.
  //
  // Echo the SAME target the drift was found against, not a hardcoded default
  // (Codex P2, PR #139): carry the resolved project and — when it is not the
  // `med-2026` default — the `VITE_EVENT_ID`, so a copy-pasted reconcile command
  // reseeds the event that actually drifted rather than a different one.
  const project =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'gaycruisebingo';
  const eventEnv = eventId && eventId !== 'med-2026' ? `VITE_EVENT_ID=${eventId} ` : '';
  lines.push(
    `  → reconcile (prompts only): ADMIN_UID= ${eventEnv}GOOGLE_CLOUD_PROJECT=${project} node scripts/seed.mjs`,
  );
  return lines.join('\n');
}

// Read-only drift check (`node scripts/seed.mjs --verify`). Never writes — safe
// to run as a post-deploy smoke test. Exits 0 when the live seed pool matches
// the canonical ALL_ITEMS (main + embark + farewell), 1 (with an actionable
// report) when it drifts.
async function verify() {
  const { db, EVENT_ID } = await initFirestore();
  const snap = await db.collection(`events/${EVENT_ID}/items`).get();
  const report = verifySeedPool(
    snap.docs.map((doc) => ({
      id: doc.id,
      text: doc.data().text,
      createdBy: doc.data().createdBy,
      spicy: doc.data().spicy,
      isFreeSpace: doc.data().isFreeSpace,
      status: doc.data().status,
      reportCount: doc.data().reportCount,
      pool: doc.data().pool,
    })),
    ALL_ITEMS,
  );
  if (report.ok) {
    console.log(
      `✓ events/${EVENT_ID}/items matches the canonical ${report.expected}-prompt pool ` +
        `(${report.seedOwned} seed-owned, ${report.playerOwned} player-owned).`,
    );
    process.exit(0);
  }
  console.error(formatDriftReport(report, EVENT_ID));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--verify')) await verify();
  else await seed();
}
