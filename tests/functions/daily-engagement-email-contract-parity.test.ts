import { describe, it, expectTypeOf } from 'vitest';
import type { DayDef, EventDoc, PlayerDoc } from '../../src/types';
import type { EmailDay, EmailEvent, EmailPlayer } from '../../functions/src/dailyEmailContent';

// Contract guard for the email module's canonical domain views (#616).
//
// `src/domainTypes.d.ts` is declaration-only, so the separately-rooted
// Functions compiler can import the same source of truth without emitting an
// app file outside `functions/src`. `EmailDay` / `EmailEvent` / `EmailPlayer`
// are Pick/Partial views of those declarations, never restated interfaces.
//
// These are TYPE-LEVEL assertions: they cost nothing at runtime and fail at
// `npm run typecheck` / `vitest` compile time. Each says "the email's local
// field is assignable FROM the canonical one", which is the direction that
// matters — the email must keep accepting whatever the app produces. Narrowing
// a canonical field (say `DayDef.date` from `string` to a union) or changing
// its type outright breaks these; ADDING a canonical field does not, which is
// correct, because the email reads a deliberate subset.

describe('email domain shapes stay assignable from the canonical contracts', () => {
  it('EmailDay accepts every field it reads from a DayDef', () => {
    expectTypeOf<DayDef['index']>().toExtend<EmailDay['index']>();
    expectTypeOf<DayDef['date']>().toExtend<NonNullable<EmailDay['date']>>();
    expectTypeOf<DayDef['place']>().toExtend<NonNullable<EmailDay['place']>>();
    expectTypeOf<DayDef['placeEmoji']>().toExtend<NonNullable<EmailDay['placeEmoji']>>();
    expectTypeOf<DayDef['theme']>().toExtend<NonNullable<EmailDay['theme']>>();
    expectTypeOf<DayDef['tonight']>().toExtend<NonNullable<EmailDay['tonight']>>();
    expectTypeOf<DayDef['tutorial']>().toExtend<NonNullable<EmailDay['tutorial']>>();
    expectTypeOf<DayDef['unlockAt']>().toExtend<EmailDay['unlockAt']>();
  });

  it('a whole DayDef is a valid EmailDay', () => {
    // The blunt version of the above: whatever the app's schedule produces must
    // be passable to the email builder without a cast.
    expectTypeOf<DayDef>().toExtend<EmailDay>();
  });

  it('EmailEvent accepts every field it reads from an EventDoc', () => {
    expectTypeOf<EventDoc['name']>().toExtend<NonNullable<EmailEvent['name']>>();
    expectTypeOf<EventDoc['timezone']>().toExtend<NonNullable<EmailEvent['timezone']>>();
    expectTypeOf<EventDoc['days']>().toExtend<NonNullable<EmailEvent['days']>>();
    expectTypeOf<EventDoc['bannedUids']>().toExtend<NonNullable<EmailEvent['bannedUids']>>();
    // The Event-level admin toggle — the field this feature added to the
    // canonical contract, and the one thing that decides whether anyone is
    // mailed at all. If its type ever changes, this fails.
    expectTypeOf<EventDoc['settings']['dailyEmailEnabled']>().toExtend<
      NonNullable<EmailEvent['settings']>['dailyEmailEnabled']
    >();
  });

  it('a whole EventDoc is a valid EmailEvent', () => {
    expectTypeOf<EventDoc>().toExtend<EmailEvent>();
  });

  it('EmailPlayer accepts every field the standings snapshot reads from a PlayerDoc', () => {
    expectTypeOf<PlayerDoc['uid']>().toExtend<EmailPlayer['uid']>();
    expectTypeOf<PlayerDoc['displayName']>().toExtend<EmailPlayer['displayName']>();
    expectTypeOf<PlayerDoc['bingoCount']>().toExtend<EmailPlayer['bingoCount']>();
    expectTypeOf<PlayerDoc['squaresMarked']>().toExtend<EmailPlayer['squaresMarked']>();
    expectTypeOf<PlayerDoc['firstBingoAt']>().toExtend<EmailPlayer['firstBingoAt']>();
    expectTypeOf<PlayerDoc['dayStats']>().toExtend<EmailPlayer['dayStats']>();
  });

  it('a whole PlayerDoc is a valid EmailPlayer', () => {
    expectTypeOf<PlayerDoc>().toExtend<EmailPlayer>();
  });
});
