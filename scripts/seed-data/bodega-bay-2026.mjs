// Five Across / Vacay Bingo — the bodega-bay-2026 Event's seed payload: the
// Bodega Bay house weekend (2026-08-07..09) on the `fiveacross` Firebase
// project. One module per Event (#563) so `node scripts/seed.mjs --verify`
// compares live Firestore against THIS Event's canonical pools — and so a
// seed/verify run against `fiveacross` can never touch the Med pool (the
// registry keys payloads by Event id; there is no global ALL_ITEMS).
//
// Content is the 2026-08-05 EDITED pool (Nathan's "Bodega Bay — prompt pool
// draft" rev 2 — 65 prompt rewrites + 3 em-dash tightenings over the original
// plans/bodega-prompt-pools.md draft), which is byte-identical to the LIVE
// Firestore `text` fields after the same-day in-place data pass. 40 easy /
// 40 exploratory / 40 final-day, every entry tame (general-audience Event,
// spicyRatio 0).
//
// KNOWN LIVE-DATA QUIRKS:
//   - "Post of a picture of you and somebody else in your jammies" carries
//     the draft's typo verbatim.
//   - the live docs' ids still hash the PRE-edit texts (in-place edit), so
//     `--verify` against the live pool reports id-level drift until a dedicated
//     maintenance path reconciles it. Do not reseed the live Event casually:
//     once a Day has a frozen snapshot, this script deliberately refuses a
//     `SEED_DAYS=1` overwrite rather than risking existing cards.
//
// PERSISTED pool literals are the LEGACY values ('embark' for the easy pool,
// 'farewell' for the closing pool) — deliberately, while the #565 pool-value
// migration is in transition: the live Event was seeded with the legacy
// values, deployed Cloud Functions key snapshot/freeze behavior off them
// (`snapshotPoolsFor`, `standingsFrozen`), and firestore.rules validate them.
// See plans/bodega-prompt-pools.md § "The `pool` column shows persisted
// literals". Flip these to 'easy'/'closing' only when the #565 coercion is
// deployed end-to-end and the legacy values are retired.

import { seedItemDocId } from './item-id.mjs';

// Easy pool (40) — Friday's whole card AND the Easy Mix source on Saturday and
// Sunday, so entries are evergreen-easy rather than first-day-specific.
// Stored under the LEGACY 'embark' pool value (see the header note).
export const EASY_ITEMS = [
  { text: `Take a windblown group selfie`, spicy: false, pool: 'embark' },
  { text: `Get a bird into the background of a photo`, spicy: false, pool: 'embark' },
  { text: `Find the best boat name in the harbor`, spicy: false, pool: 'embark' },
  { text: `Spot bird-themed art, a sign, or a souvenir`, spicy: false, pool: 'embark' },
  { text: `Photograph someone in full coastal-main-character mode`, spicy: false, pool: 'embark' },
  { text: `Capture a colorful buoy or crab pot`, spicy: false, pool: 'embark' },
  { text: `Make a toast about friendship`, spicy: false, pool: 'embark' },
  { text: `Post a candid that makes the group laugh`, spicy: false, pool: 'embark' },
  { text: `Post of a picture of you and somebody else in your jammies`, spicy: false, pool: 'embark' },
  { text: `Suggest something for the group to do tomorrow`, spicy: false, pool: 'embark' },
  { text: `Photograph the fog rolling in, or refusing to leave`, spicy: false, pool: 'embark' },
  { text: `Find the house's weirdest decorative object`, spicy: false, pool: 'embark' },
  { text: `Take a photo of your favorite view from inside the house`, spicy: false, pool: 'embark' },
  { text: `Get a group photo where nobody is ready`, spicy: false, pool: 'embark' },
  { text: `Catch somebody talking about their partner`, spicy: false, pool: 'embark' },
  { text: `Photograph something the exact color of the sea today`, spicy: false, pool: 'embark' },
  { text: `Take a picture of a fire`, spicy: false, pool: 'embark' },
  { text: `Take a photo of somebody arriving at the house`, spicy: false, pool: 'embark' },
  { text: `Catch the moment someone says "I could live here"`, spicy: false, pool: 'embark' },
  { text: `Find a hand-painted sign`, spicy: false, pool: 'embark' },
  { text: `Catch somebody singing a quintessentially millennial song`, spicy: false, pool: 'embark' },
  { text: `Get everyone in one frame using a timer`, spicy: false, pool: 'embark' },
  { text: `Spot a gull, pelican, or heron doing something undignified`, spicy: false, pool: 'embark' },
  { text: `Photograph someone's hair losing a fight with the wind`, spicy: false, pool: 'embark' },
  { text: `Find something in the house older than everyone here`, spicy: false, pool: 'embark' },
  { text: `Capture a sunset, or the sky pretending it's going to be one`, spicy: false, pool: 'embark' },
  { text: `Win a game of something`, spicy: false, pool: 'embark' },
  { text: `Catch someone asleep in a chair they meant to sit in briefly`, spicy: false, pool: 'embark' },
  { text: `Photograph the group's shoes in a pile by the door`, spicy: false, pool: 'embark' },
  { text: `Find a flower growing somewhere it shouldn't`, spicy: false, pool: 'embark' },
  { text: `Photograph the drink of the day`, spicy: false, pool: 'embark' },
  { text: `Get a reflection shot—window, puddle, or sunglasses`, spicy: false, pool: 'embark' },
  { text: `Take a picture of something red`, spicy: false, pool: 'embark' },
  { text: `Take a picture of yourself in the hot tub`, spicy: false, pool: 'embark' },
  { text: `Catch someone talking to a bird`, spicy: false, pool: 'embark' },
  { text: `Give a friend a compliment`, spicy: false, pool: 'embark' },
  { text: `Get everybody to sing along to a song from the 90’s`, spicy: false, pool: 'embark' },
  { text: `Take a photo where someone is laughing too hard to pose`, spicy: false, pool: 'embark' },
  { text: `Find something with a bird on it that isn't a bird`, spicy: false, pool: 'embark' },
  { text: `Capture a cheers/toast in action`, spicy: false, pool: 'embark' },
];

// Main pool — exploratory/social (40): Saturday's discovery pool, blended
// 50/50 with the easy pool. Untagged (defaults to 'main' in
// seedItemMutations).
export const ITEMS = [
  { text: `Walk to a Bodega Head viewpoint`, spicy: false },
  { text: `Walk part of the Bird Walk Coastal Access Trail`, spicy: false },
  { text: `Stage an original suspense-movie still`, spicy: false },
  { text: `See St. Teresa of Avila Church in Bodega`, spicy: false },
  { text: `Spot the Potter Schoolhouse from the public road—it's someone's home, so admire and keep moving`, spicy: false },
  { text: `Share a story you haven’t told anybody in the group before`, spicy: false },
  { text: `Tell somebody in the group your favorite thing about them`, spicy: false },
  { text: `Discover a local artist, gallery, or studio`, spicy: false },
  { text: `Paint a picture`, spicy: false },
  { text: `Win a game`, spicy: false },
  { text: `Karaoke your best song`, spicy: false },
  { text: `Share a photo you’ve taken where you feel sexy`, spicy: false },
  { text: `Photograph the fog`, spicy: false },
  { text: `Share your favorite memory with each person you’re currently sitting with`, spicy: false },
  { text: `Find a seashell on the beach`, spicy: false },
  { text: `Tell a friend something that you love about her`, spicy: false },
  { text: `Photograph something you had to pull over on Highway 1 for`, spicy: false },
  { text: `Spot a whale spout, or convincingly claim you did`, spicy: false },
  { text: `Find the best bench on this coast and sit in it a while`, spicy: false },
  { text: `Photograph a boat name that is pun-y`, spicy: false },
  { text: `Get a group photo with the whole Pacific behind you`, spicy: false },
  { text: `Walk part of the Bodega Dunes`, spicy: false },
  { text: `Share your favorite music video with the group`, spicy: false },
  { text: `Give a convincing speech on why men should not be included in this trip`, spicy: false },
  { text: `Take a shot`, spicy: false },
  { text: `Take a photo of your feet in the sand`, spicy: false },
  { text: `Tell an embarrassing story from your 20s`, spicy: false },
  { text: `Text a friend's significant other your favorite thing about that friend`, spicy: false },
  { text: `Ask someone what they'd buy first if money were no object`, spicy: false },
  { text: `Tell the story of the first time you told your partner you loved them`, spicy: false },
  { text: `Ask a question and draw a tarot card`, spicy: false },
  { text: `Share your enneagram number with the group and if you identify with it`, spicy: false },
  { text: `Take a photo of somebody else looking sexy`, spicy: false },
  { text: `Take a picture of a wildflower`, spicy: false },
  { text: `Take a photo with no horizon in it at all`, spicy: false },
  { text: `Share a favorite friendship memory you have of someone in the group`, spicy: false },
  { text: `Catch somebody talking about their children, pet, or job`, spicy: false },
  { text: `Photograph the group's shadows instead of the group`, spicy: false },
  { text: `Find a bakery, farm stand, or roadside sign worth coming back for`, spicy: false },
  { text: `Ask somebody about their dream job`, spicy: false },
];

// Closing pool — final day (40 rows, 38 unique texts; see the header's
// duplicate quirk): the wrap-up card, which unlocks at the 11:00 check-out
// freeze alongside the podium. Deliberately achievable from a kitchen or a
// passenger seat. Stored under the LEGACY 'farewell' pool value.
export const CLOSING_ITEMS = [
  { text: `One last sunrise or foggy-morning photo`, spicy: false, pool: 'farewell' },
  { text: `Photograph the most chipper person this morning`, spicy: false, pool: 'farewell' },
  { text: `Share your favorite quote of the weekend`, spicy: false, pool: 'farewell' },
  { text: `Photograph the house before anyone tidies it`, spicy: false, pool: 'farewell' },
  { text: `Find something someone almost left behind`, spicy: false, pool: 'farewell' },
  { text: `Take a photo of somebody still sleeping`, spicy: false, pool: 'farewell' },
  { text: `Give this trip a #hashtag`, spicy: false, pool: 'farewell' },
  { text: `Photograph the friend who brought the most stuff`, spicy: false, pool: 'farewell' },
  { text: `Share your favorite picture you took of somebody this weekend`, spicy: false, pool: 'farewell' },
  { text: `Share an accidental photo you took from the weekend`, spicy: false, pool: 'farewell' },
  { text: `Share your favorite photo of the weekend`, spicy: false, pool: 'farewell' },
  { text: `Pick the spot for the last coffee/breakfast moment`, spicy: false, pool: 'farewell' },
  { text: `Take a photo from the exact spot you took your first one`, spicy: false, pool: 'farewell' },
  { text: `Take a picture of the spot you spent the most time at`, spicy: false, pool: 'farewell' },
  { text: `Photograph the last of the snacks`, spicy: false, pool: 'farewell' },
  { text: `Suggest a location for the next girls' weekend`, spicy: false, pool: 'farewell' },
  { text: `Photograph someone doing the final sweep`, spicy: false, pool: 'farewell' },
  { text: `Share your favorite picture of yourself you took this weekend`, spicy: false, pool: 'farewell' },
  { text: `Photograph the view one last time`, spicy: false, pool: 'farewell' },
  { text: `Find something you'd swear wasn't there on Friday`, spicy: false, pool: 'farewell' },
  { text: `Take the last group photo`, spicy: false, pool: 'farewell' },
  { text: `Photograph a car, packed and ready to go`, spicy: false, pool: 'farewell' },
  { text: `Take a picture of your soundtrack home`, spicy: false, pool: 'farewell' },
  { text: `Photograph the fog one last time—it'll be there`, spicy: false, pool: 'farewell' },
  { text: `Group photo where everyone is genuinely ready to go`, spicy: false, pool: 'farewell' },
  { text: `Name the weekend's MVP moment`, spicy: false, pool: 'farewell' },
  { text: `Photograph the last shoes by the door`, spicy: false, pool: 'farewell' },
  { text: `Share the photo that tells the story of the weekend`, spicy: false, pool: 'farewell' },
  { text: `Prove that we followed the house rules`, spicy: false, pool: 'farewell' },
  { text: `Take one last photo in the hot tub`, spicy: false, pool: 'farewell' },
  { text: `Photograph the road out`, spicy: false, pool: 'farewell' },
  { text: `Share one word you’ll take away from this weekend`, spicy: false, pool: 'farewell' },
  { text: `Take a picture of the front door on your way out`, spicy: false, pool: 'farewell' },
  { text: `Sing the song “Closing Time” at the top of your lungs`, spicy: false, pool: 'farewell' },
  { text: `Take a picture of your snack/drink/meal you got on the way home`, spicy: false, pool: 'farewell' },
  { text: `Share the quote you’ll still be repeating next week`, spicy: false, pool: 'farewell' },
  { text: `Photograph the sky on the way home`, spicy: false, pool: 'farewell' },
  { text: `Name one thing your partner missed about you this weekend`, spicy: false, pool: 'farewell' },
  { text: `Photograph the very last bird`, spicy: false, pool: 'farewell' },
  { text: `Text a girlfriend a compliment you need to give her`, spicy: false, pool: 'farewell' },
];
// Unlock instants (all America/Los_Angeles, PDT for the August window).
// 06:00 — this group is early to rise, so the card waits for them (06:00 PDT
// is exactly 13:00 UTC, on the hourly UTC scheduler tick). Day 0 carries the
// `0` open sentinel ("live from event open", #289 fail-open semantics), NOT a
// real Friday-afternoon instant: the snapshot filter only admits Prompts whose
// approvedAt/createdAt is at or before `unlockAt`, so a real 16:00 unlock on a
// same-day seed would stamp an EMPTY snapshot — and there is no un-stamp.
const SAT_UNLOCK = Date.parse('2026-08-08T06:00:00-07:00');
const SUN_UNLOCK = Date.parse('2026-08-09T06:00:00-07:00');
// The wrap-up Day's unlock IS the Standings Freeze (check-out): a closing-pool
// unlock freezes the standings (`standingsFrozen`) and `finaleTimes` anchors
// the podium on the same instant, so the podium fires exactly at 11:00.
const CHECKOUT_FREEZE = Date.parse('2026-08-09T11:00:00-07:00');

export const EVENT_SEED = {
  name: 'Bodega Bay',
  // TRANSITION DUAL-WRITE (#566, Codex P1 on PR #644): the LIVE doc carries the
  // neutral startsOn/endsOn (it was seeded that way), but the currently
  // SHIPPED bundle still reads sailStart/sailEnd — so this payload persists
  // BOTH pairs with identical values, and a seed run can never leave the
  // deployed app with a blank Event window. Drop the legacy pair when the
  // #566 read-coercion is deployed.
  startsOn: '2026-08-07',
  endsOn: '2026-08-09',
  sailStart: '2026-08-07',
  sailEnd: '2026-08-09',
  status: 'active',
  defaultTheme: 'side-quests',
  claimMode: 'honor',
  // spicyRatio 0: a general-audience Event — every seeded Prompt is tame, and
  // the deal never reserves spicy slots. easyMixRatio 0.5: Saturday and Sunday
  // blend main + easy 50/50 (specs/easy-mix.md).
  settings: { reportHideThreshold: 4, spicyRatio: 0, easyMixRatio: 0.5 },
  timezone: 'America/Los_Angeles',
  // The stated Standings Freeze (Sunday 11:00 check-out) — the same instant as
  // the wrap-up Day's unlock, so the inferred and stated freeze agree.
  standingsFreezeAt: CHECKOUT_FREEZE,
  // Four Days for a three-day trip (plans/bodega-prompt-pools.md § "Why four
  // Days"): Sunday plays competitively on `main` all morning; the ceremonial
  // wrap-up Day at 11:00 is the closing-pool Day whose unlock IS the freeze.
  // Friday is easy-pool but NOT tutorial — a competitive easy card, safe
  // because the podium mirrors key First-to-BINGO exclusion off the `tutorial`
  // flag alone (tests/functions/finale-parity.test.ts pins both sides).
  days: [
    // Days carry the SAME dual-write posture: place/placeEmoji (the live
    // doc's shape, and the post-#566 reader) PLUS port/portEmoji (what the
    // currently shipped DaySwitcher/Board/Leaderboard render). Values mirror
    // the live doc field-for-field.
    {
      index: 0,
      date: '2026-08-07',
      place: 'Bodega Bay',
      placeEmoji: '🐦',
      port: 'Bodega Bay',
      portEmoji: '🐦',
      theme: 'the-birds',
      tonight: ['🍷 Arrival pours', '🌊 First look at the water'],
      pool: 'embark',
      tutorial: false,
      scoring: 'competitive',
      unlockAt: 0,
      freeText: 'The flock has landed',
      // Pre-stamped at seed time (plans/bodega-prompt-pools.md § "Friday uses
      // the 0 sentinel"): the open sentinel disables the timestamp cutoff
      // entirely (fail-open, #289), so without a pre-stamp Friday's card would
      // be whatever is active whenever the scheduler happens to run. Fixing the
      // snapshot in the seed makes the competitive Friday card deterministic —
      // the seed run, not scheduler timing, decides its content. NOTE: the
      // LIVE Day 0 snapshot currently holds the PRE-edit ids (see the header's
      // in-place-edit quirk); this value is what a correct reseed re-stamps.
      snapshotItemIds: [...new Set(EASY_ITEMS.map((i) => seedItemDocId(i.text)))].sort(),
    },
    {
      index: 1,
      date: '2026-08-08',
      place: 'Bodega Bay',
      placeEmoji: '🌊',
      port: 'Bodega Bay',
      portEmoji: '🌊',
      theme: 'side-quests',
      // Live-edited 2026-08-05: '🌅 Sunset' replaced the fire pit.
      tonight: ['🦀 Harbor dinner', '🌅 Sunset'],
      pool: 'main',
      tutorial: false,
      scoring: 'competitive',
      unlockAt: SAT_UNLOCK,
      freeText: 'Main character on the coast',
    },
    {
      index: 2,
      date: '2026-08-09',
      place: 'Bodega Bay',
      placeEmoji: '🌅',
      port: 'Bodega Bay',
      portEmoji: '🌅',
      theme: 'fog-froth-farewells',
      tonight: ['☕ Last coffee', '🧳 The slow pack'],
      pool: 'main',
      tutorial: false,
      scoring: 'competitive',
      unlockAt: SUN_UNLOCK,
      freeText: 'One last coastal morning',
    },
    {
      index: 3,
      date: '2026-08-09',
      place: 'The drive home',
      placeEmoji: '🌫️',
      port: 'The drive home',
      // Live-edited 2026-08-05: Nathan set the wrap-up chip's emoji to 👋 on
      // the legacy field the shipped bundle renders; the neutral field keeps
      // the Theme table's 🌫️. Mirrored as-is.
      portEmoji: '👋',
      theme: 'fog-froth-farewells',
      tonight: ['📸 The photo dump', '📅 Next one'],
      pool: 'farewell',
      // tutorial: true keeps a ceremonial wrap-up bingo out of the Event-wide
      // First to BINGO; buildPodium already excludes the closing Day from
      // champion totals.
      tutorial: true,
      scoring: 'ceremonial',
      unlockAt: CHECKOUT_FREEZE,
      freeText: 'We did it for the story',
    },
  ],
};

export const ALL_ITEMS = [...ITEMS, ...EASY_ITEMS, ...CLOSING_ITEMS];
