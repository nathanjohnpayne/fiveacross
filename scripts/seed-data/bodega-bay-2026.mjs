// Five Across / Vacay Bingo — the bodega-bay-2026 Event's seed payload: the
// Bodega Bay house weekend (2026-08-07..09) on the `fiveacross` Firebase
// project. One module per Event (#563) so `node scripts/seed.mjs --verify`
// compares live Firestore against THIS Event's canonical pools.
//
// Content is plans/bodega-prompt-pools.md verbatim (40 easy / 40 exploratory /
// 40 final-day, every entry tame — a general-audience Event, spicyRatio 0),
// and was verified 2026-08-05 to match the LIVE seeded docs field-for-field
// (doc ids are the content hash, so text fidelity here IS the drift check).
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
  { text: `Make a "for the story" toast`, spicy: false, pool: 'embark' },
  { text: `Post a candid that makes the group laugh`, spicy: false, pool: 'embark' },
  { text: `Wear the layer you swore you wouldn't need`, spicy: false, pool: 'embark' },
  { text: `Catch someone checking the weather app for the fourth time`, spicy: false, pool: 'embark' },
  { text: `Photograph the fog rolling in, or refusing to leave`, spicy: false, pool: 'embark' },
  { text: `Find the house's weirdest decorative object`, spicy: false, pool: 'embark' },
  { text: `Claim your bed and photograph the view from it`, spicy: false, pool: 'embark' },
  { text: `Get a group photo where nobody is ready`, spicy: false, pool: 'embark' },
  { text: `Spot a dog living its best coastal life`, spicy: false, pool: 'embark' },
  { text: `Photograph something the exact color of the sea today`, spicy: false, pool: 'embark' },
  { text: `Start a group in-joke and write it down`, spicy: false, pool: 'embark' },
  { text: `Take a photo through a window`, spicy: false, pool: 'embark' },
  { text: `Catch the moment someone says "I could live here"`, spicy: false, pool: 'embark' },
  { text: `Find a hand-painted sign`, spicy: false, pool: 'embark' },
  { text: `Photograph your shoes somewhere they don't belong`, spicy: false, pool: 'embark' },
  { text: `Get everyone in one frame using a timer`, spicy: false, pool: 'embark' },
  { text: `Spot a gull, pelican, or heron doing something undignified`, spicy: false, pool: 'embark' },
  { text: `Photograph someone's hair losing a fight with the wind`, spicy: false, pool: 'embark' },
  { text: `Find something in the house older than everyone here`, spicy: false, pool: 'embark' },
  { text: `Capture a sunset, or the sky pretending it's going to be one`, spicy: false, pool: 'embark' },
  { text: `Spot a hat you'd steal if you were a different person`, spicy: false, pool: 'embark' },
  { text: `Catch someone asleep in a chair they meant to sit in briefly`, spicy: false, pool: 'embark' },
  { text: `Photograph the group's shoes in a pile by the door`, spicy: false, pool: 'embark' },
  { text: `Find a flower growing somewhere it shouldn't`, spicy: false, pool: 'embark' },
  { text: `Photograph the drink of the day`, spicy: false, pool: 'embark' },
  { text: `Get a reflection shot — window, puddle, or sunglasses`, spicy: false, pool: 'embark' },
  { text: `Spot a license plate from a state nobody expected`, spicy: false, pool: 'embark' },
  { text: `Listen for the fog horn and stop talking until it goes again`, spicy: false, pool: 'embark' },
  { text: `Catch someone talking to a bird`, spicy: false, pool: 'embark' },
  { text: `Find the most dramatic cloud of the trip so far`, spicy: false, pool: 'embark' },
  { text: `Photograph a handwritten note, menu, or chalkboard`, spicy: false, pool: 'embark' },
  { text: `Take a photo where someone is laughing too hard to pose`, spicy: false, pool: 'embark' },
  { text: `Find something with a bird on it that isn't a bird`, spicy: false, pool: 'embark' },
  { text: `Capture the exact moment the plan changes`, spicy: false, pool: 'embark' },
];

// Main pool — exploratory (40): Saturday's discovery pool, blended 50/50 with
// the easy pool. Untagged (defaults to 'main' in seedItemMutations).
export const ITEMS = [
  { text: `Walk to a Bodega Head viewpoint`, spicy: false },
  { text: `Walk part of the Bird Walk Coastal Access Trail`, spicy: false },
  { text: `Stage an original suspense-movie still`, spicy: false },
  { text: `See St. Teresa of Avila Church in Bodega`, spicy: false },
  { text: `Spot the Potter Schoolhouse from the public road — it's someone's home, so admire and keep moving`, spicy: false },
  { text: `Find a Hitchcock detail at the Tides Wharf`, spicy: false },
  { text: `Ask a local for a favorite view or detour`, spicy: false },
  { text: `Discover a local artist, gallery, or studio`, spicy: false },
  { text: `Fly a kite at Doran Beach`, spicy: false },
  { text: `Watch marine wildlife from a safe distance and stay there`, spicy: false },
  { text: `Watch a fishing boat come in or head out`, spicy: false },
  { text: `Find the highest point you can safely walk to`, spicy: false },
  { text: `Photograph the harbor at its foggiest`, spicy: false },
  { text: `Count the crab pots stacked at the marina`, spicy: false },
  { text: `Walk a beach end to end without checking your phone`, spicy: false },
  { text: `Find a tide pool and leave everything exactly where it was`, spicy: false },
  { text: `Photograph something you had to pull over on Highway 1 for`, spicy: false },
  { text: `Spot a whale spout, or convincingly claim you did`, spicy: false },
  { text: `Find the best bench on this coast and sit in it a while`, spicy: false },
  { text: `Photograph a boat name that sounds like a warning`, spicy: false },
  { text: `Get a group photo with the whole Pacific behind you`, spicy: false },
  { text: `Walk part of the Bodega Dunes`, spicy: false },
  { text: `Find a shell, feather, or stone worth keeping — photograph it, then decide`, spicy: false },
  { text: `Recreate a movie poster on the beach`, spicy: false },
  { text: `Spot a bird of prey`, spicy: false },
  { text: `Photograph a barn, silo, or fence line just inland`, spicy: false },
  { text: `Find the town of Bodega — it is not the same place as Bodega Bay`, spicy: false },
  { text: `Watch the fog swallow something entirely`, spicy: false },
  { text: `Ask someone what they'd order if money were no object`, spicy: false },
  { text: `Photograph a road disappearing into fog`, spicy: false },
  { text: `Record ten seconds of the loudest birds you can find`, spicy: false },
  { text: `Spot a cypress or pine bent flat by the wind`, spicy: false },
  { text: `Photograph Salmon Creek Beach from above`, spicy: false },
  { text: `Find something growing out of driftwood`, spicy: false },
  { text: `Take a photo with no horizon in it at all`, spicy: false },
  { text: `Watch a sunset from a spot you found yourselves`, spicy: false },
  { text: `Stand somewhere you can hear the surf and the fog horn at once`, spicy: false },
  { text: `Photograph the group's shadows instead of the group`, spicy: false },
  { text: `Find a bakery, farm stand, or roadside sign worth coming back for`, spicy: false },
  { text: `Catch the moment this stops being a weekend and starts being the story`, spicy: false },
];

// Closing pool — final day (40): the wrap-up card, which unlocks at the 11:00
// check-out freeze alongside the podium. Deliberately achievable from a
// kitchen or a passenger seat. Stored under the LEGACY 'farewell' pool value.
export const CLOSING_ITEMS = [
  { text: `One last sunrise or foggy-morning photo`, spicy: false, pool: 'farewell' },
  { text: `Photograph whatever is keeping you upright this morning`, spicy: false, pool: 'farewell' },
  { text: `Say the funniest thing that happened out loud one more time`, spicy: false, pool: 'farewell' },
  { text: `Photograph the house before anyone tidies it`, spicy: false, pool: 'farewell' },
  { text: `Find something someone almost left behind`, spicy: false, pool: 'farewell' },
  { text: `Group photo in whatever you slept in`, spicy: false, pool: 'farewell' },
  { text: `Name the trip`, spicy: false, pool: 'farewell' },
  { text: `Photograph the fullest suitcase`, spicy: false, pool: 'farewell' },
  { text: `Tell someone the thing you were too shy to say on Friday`, spicy: false, pool: 'farewell' },
  { text: `Screenshot the group chat's new name`, spicy: false, pool: 'farewell' },
  { text: `Post the photo dump`, spicy: false, pool: 'farewell' },
  { text: `Swap favorite memories over the last cup of coffee`, spicy: false, pool: 'farewell' },
  { text: `Take a photo from the exact spot you took your first one`, spicy: false, pool: 'farewell' },
  { text: `Find the receipt, ticket, or scrap worth keeping`, spicy: false, pool: 'farewell' },
  { text: `Photograph the last of the snacks`, spicy: false, pool: 'farewell' },
  { text: `Set a date for the next one`, spicy: false, pool: 'farewell' },
  { text: `Photograph someone doing the final sweep`, spicy: false, pool: 'farewell' },
  { text: `Say thank you to whoever booked it`, spicy: false, pool: 'farewell' },
  { text: `Photograph the view one last time`, spicy: false, pool: 'farewell' },
  { text: `Find something you'd swear wasn't there on Friday`, spicy: false, pool: 'farewell' },
  { text: `Take the photo that becomes the group chat's picture`, spicy: false, pool: 'farewell' },
  { text: `Photograph the car, packed and defeated`, spicy: false, pool: 'farewell' },
  { text: `Admit which prompt you never managed`, spicy: false, pool: 'farewell' },
  { text: `Photograph the fog one last time — it'll be there`, spicy: false, pool: 'farewell' },
  { text: `Group photo where everyone is genuinely ready to go`, spicy: false, pool: 'farewell' },
  { text: `Name the weekend's MVP moment`, spicy: false, pool: 'farewell' },
  { text: `Photograph the last shoes by the door`, spicy: false, pool: 'farewell' },
  { text: `Tell the group your favorite photo of the weekend`, spicy: false, pool: 'farewell' },
  { text: `Photograph the empty kitchen table`, spicy: false, pool: 'farewell' },
  { text: `Find the thing you're taking home that nobody expected`, spicy: false, pool: 'farewell' },
  { text: `Photograph the road out`, spicy: false, pool: 'farewell' },
  { text: `Say one thing you'd do differently and one you wouldn't change`, spicy: false, pool: 'farewell' },
  { text: `Photograph the keys going back`, spicy: false, pool: 'farewell' },
  { text: `Sing the song of the weekend one more time`, spicy: false, pool: 'farewell' },
  { text: `Photograph whatever the group decided was cursed`, spicy: false, pool: 'farewell' },
  { text: `Look at the first photo of the trip together`, spicy: false, pool: 'farewell' },
  { text: `Photograph the sky on the way home`, spicy: false, pool: 'farewell' },
  { text: `Say who you'll miss most — they're in the car`, spicy: false, pool: 'farewell' },
  { text: `Photograph the very last bird`, spicy: false, pool: 'farewell' },
  { text: `Do it for the story, one more time`, spicy: false, pool: 'farewell' },
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
// The wrap-up Day's unlock IS the Standings Freeze (check-out): a farewell-pool
// unlock freezes the standings (`standingsFrozen`) and `finaleTimes` anchors
// the podium on the same instant, so the podium fires exactly at 11:00.
const CHECKOUT_FREEZE = Date.parse('2026-08-09T11:00:00-07:00');

export const EVENT_SEED = {
  name: 'Bodega Bay',
  // Neutral field names (#566): the Event was seeded startsOn/endsOn from day
  // one — it never carried sailStart/sailEnd.
  startsOn: '2026-08-07',
  endsOn: '2026-08-09',
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
  // wrap-up Day at 11:00 is the farewell-pool Day whose unlock IS the freeze.
  // Friday is `embark`-pool but NOT tutorial — a competitive easy card, safe
  // because the podium mirrors key First-to-BINGO exclusion off the `tutorial`
  // flag alone (tests/functions/finale-parity.test.ts pins both sides).
  days: [
    {
      index: 0,
      date: '2026-08-07',
      place: 'Bodega Bay',
      placeEmoji: '🐦',
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
      // the seed run, not scheduler timing, decides its content.
      snapshotItemIds: EASY_ITEMS.map((i) => seedItemDocId(i.text)).sort(),
    },
    {
      index: 1,
      date: '2026-08-08',
      place: 'Bodega Bay',
      placeEmoji: '🌊',
      theme: 'side-quests',
      tonight: ['🦀 Harbor dinner', '🔥 Fire pit'],
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
      theme: 'fog-froth-farewells',
      tonight: ['📸 The photo dump', '📅 Next one'],
      pool: 'farewell',
      // tutorial: true keeps a ceremonial wrap-up bingo out of the Event-wide
      // First to BINGO; buildPodium already excludes the farewell Day from
      // champion totals.
      tutorial: true,
      scoring: 'ceremonial',
      unlockAt: CHECKOUT_FREEZE,
      freeText: 'We did it for the story',
    },
  ],
};

export const ALL_ITEMS = [...ITEMS, ...EASY_ITEMS, ...CLOSING_ITEMS];
