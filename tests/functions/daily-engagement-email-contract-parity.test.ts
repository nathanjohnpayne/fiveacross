import { describe, it, expectTypeOf } from 'vitest';
import type { DayDef, EventDoc, PlayerDoc } from '../../src/types';
import type { EmailDay, EmailEvent, EmailPlayer } from '../../functions/src/dailyEmailContent';

// Contract-parity guard for the email module's local domain shapes (#616,
// Codex #623 P1).
//
// WHY THE SHAPES ARE LOCAL AT ALL. `functions/` and `src/` are deliberately
// decoupled TypeScript projects: `functions/tsconfig.json` sets
// `rootDir: "src"` and `include: ["src"]`, so a functions module CANNOT import
// `../../src/types` — and it should not, because that would pull the app's
// contract module (and its transitive imports) into the Functions bundle. Every
// functions module that needs a domain shape re-states the subset it reads:
// `unlockDay.ts` (`DayLike`/`EventLike`), `autohide.ts` (`ReportableDoc`),
// `notify.ts` (`ModeratedDoc`), `finaleContent.ts` (`FinalePlayer`/`FinaleDay`).
// This module follows that established pattern rather than inventing a third.
//
// WHAT THIS FILE IS FOR. Decoupling is fine; SILENT divergence is not — the
// exact failure `tests/functions/finale-parity.test.ts` was written after. A
// TEST can import both projects even though neither can import the other, so
// the drift risk is closed here rather than by collapsing the boundary.
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
    expectTypeOf<DayDef['port']>().toExtend<NonNullable<EmailDay['port']>>();
    expectTypeOf<DayDef['portEmoji']>().toExtend<NonNullable<EmailDay['portEmoji']>>();
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
  });
});
