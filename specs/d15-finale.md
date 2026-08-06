---
spec_id: d15-finale
status: accepted
---

# Two-beat finale: last-call standings + freeze + podium (`d15-finale`)

Implements `plans/daily-cards-spec.md` § "Scoring and social surfaces" → "The finale—two-beat finish" and § "Farewell view". The Event ends on two scheduled beats: at **20:00 on Day 9** a last-call Moment posts the going-into-the-final-night standings; at **08:00 on Day 10** the standings **freeze** (`EventDoc.frozenAt` set), the closing Day unlocks, and the closing view opens with the **podium**—Event champion, Event-wide First to BINGO, and the ten daily honors—also posted as a final Moment. `d15-scheduler-unlock` (#202) owns firing the two beats on schedule; this ticket owns their CONTENT—the standings/podium copy and computation—and the client-side farewell podium banner + freeze semantics.

## Contract

- `functions/src/finaleContent.ts` (new, needs-phase-4)—pure, injectable content functions the scheduler's 20:00-D9 / 08:00-D10 triggers call into. No `firebase-admin`, no live backend (mirrors `unlockDay.ts`'s decoupled-pure posture):
  - `lastCallStandingsCopy(players, opts?)`—the going-into-the-final-night line ("Jess leads by 2 bingos—standings freeze at 8 a.m."), naming the leader and their margin; degrades to a generic line on a tie or an empty board.
  - `buildPodiumPayload(players, days, dayHonors)`—the podium payload: Event champion (top of the aggregated standings, EXCLUDING the ceremonial closing Day), Event-wide First to BINGO (non-Tutorial Days only—a Tutorial Day's mark never takes the honor). Excluded by `DayDef.tutorial` ALONE, never by pool: pool identity and Tutorial framing are independent (ADR 0011), and a curated pool can be real competitive play, and the ten daily honors read from each Day's `meta.firstBingo`.
  - The ranking + tutorial-exclusion semantics MIRROR `src/game/logic.ts`'s `comparePlayers` / `eventFirstBingoAt` (the app and functions packages are deliberately decoupled, like `autohide.ts` from `moderation.ts`).
- `src/data/finale.ts` (new)—the client mirror:
  - `buildPodium(players, days)`—the same podium the scheduler posts, computed client-side from the live-but-frozen `PlayerDoc` aggregates + per-Day honors. The champion/standings EXCLUDE the closing Day's contribution, so post-freeze closing-Day marks never move the podium (the closing-Day-is-ceremonial rule; the podium is "as of `frozenAt`", not live).
  - `farewellPinIndex(days, frozenAt, now)`—the default-view pin: the closing Day's array index once `frozenAt` is set AND the closing Day is unlocked, else `null` (fall back to the normal "today" default). Never pins before the freeze.
- `src/components/FarewellPodium.tsx` (new)—the closing view's podium banner (champion + Event-wide First to BINGO + ten daily-honor rows), rendered ABOVE the goodbye banner (`d15-tutorial-banners` owns the goodbye copy/mount; this ticket owns the podium banner and their stacking order). Issue #449 later added the podium's own share affordance—a "Share final standings" button at the bottom of the section rendering the same frozen `Podium` payload as an on-device Share Card; the card and share mechanics are owned by `specs/w2-share-cards.md` § Final standings.
- `src/components/Board.tsx` (modify)—mount the podium above the goodbye banner on the closing Day once frozen, and pin the closing Day as the default view once the Event has ended (`farewellPinIndex`).
- `src/types.ts` / `src/data/converters.ts`—`EventDoc.frozenAt?: number` (ms epoch) is the freeze stamp; a missing field reads as `undefined` (unset) through `eventConverter`'s passthrough. (Landed with the #212 schema contract.)

## Acceptance criteria

- **Given** it is 20:00 on Day 9, **when** the scheduled trigger fires, **then** a last-call Moment posts naming the current leader and their margin. (Test: last-call-copy.)
- **Given** it is 08:00 on Day 10, **when** the scheduled trigger fires, **then** `frozenAt` is set, the closing Day unlocks, and a podium Moment posts with the champion, Event-wide First to BINGO, and ten daily honors. (Test: podium-payload.)
- **Given** the Event has ended (`frozenAt` set) and the closing Day is unlocked, **when** a Player opens the app, **then** the closing Day (podium included) is the default view; before the freeze it is never pinned. (Test: default-view-pin.)
- **Given** the podium, **then** its Event-wide First to BINGO never credits a Tutorial Day's mark. (Test: tutorial-exclusion.)
- **Given** the podium, **then** the champion/standings are computed EXCLUDING the closing Day, so a post-freeze closing-Day mark never changes the podium. (Test: ceremonial-farewell.)
- **Given** the event doc, **then** `frozenAt` is admin/Function-writable only, never client-writable directly by a Player. (Test: rules.)

## Test coverage

- `tests/functions/d15-finale.test.ts` (functions layer, `vitest.functions.config.ts`)—`lastCallStandingsCopy` names the correct leader + margin from a fixture player set and degrades on a tie/empty board; `buildPodiumPayload` excludes a Tutorial Day's first bingo from the Event-wide honor, excludes the closing Day from the champion totals, and includes all ten daily honors when present.
- `src/components/FarewellPodium.test.tsx` (RTL/jsdom)—renders champion, Event-wide First to BINGO, and ten daily-honor rows from a fixture payload, above the goodbye banner mount point.
- `src/data/d15-finale.test.ts` (Vitest unit)—`farewellPinIndex` pins only once `frozenAt` is set and the closing Day is unlocked, never before; `buildPodium` picks the champion, excludes the ceremonial closing Day, and excludes tutorial Days from the Event-wide First to BINGO.
- `tests/rules/d15-finale.test.ts` (rules emulator)—`EventDoc.frozenAt` is writable by an admin/Function but rejected for a non-admin Player.
