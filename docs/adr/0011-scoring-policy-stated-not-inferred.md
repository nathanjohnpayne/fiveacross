---
status: accepted
implemented: false
---

> **Decision accepted; scoring migration not yet implemented.** There is still no `DayDef.scoring` or `EventDoc.standingsFreezeAt`, and `ceremonialDayIndexSet` plus the client freeze derivation still infer from `pool === 'farewell'`. That work is tracked separately.
>
> **The divergence this audit exposed IS fixed**, ahead of the rest: `functions/src/finaleContent.ts` now excludes Tutorial Days by the flag alone, matching the client, and `tests/functions/finale-parity.test.ts` feeds one fixture schedule to both implementations and fails if either moves alone. It was pulled forward because the Bodega schedule aims it at a real Event—an easy-pool Friday with `tutorial: false` would have had the card and the Feed name different players as First to BINGO.

# A Day's Scoring Policy is stated, not inferred from its Pool—and the Standings Freeze is an Event setting

[d15-finale](../../specs/d15-finale.md) tied three things together that are actually independent: the closing **pool** meant the card was ceremonial, and the freeze fired at that Day's `unlockAt`. That holds for a ten-day Event whose last card opens on the morning everyone goes home, and breaks immediately for a weekend trip whose final morning is real competitive play ending at check-out. We therefore state scoring explicitly—`DayDef.scoring: 'competitive' | 'ceremonial'`—and put the freeze on the Event as `EventDoc.standingsFreezeAt`. A Day's **Pool identity** (which prompts it deals), its **Tutorial framing** (whether it is eligible for the Event-wide First to BINGO), and its **Scoring Policy** are three independent facts. Legacy Event docs default `scoring` from pool on read, so the Gay Cruise Bingo Event's behaviour is byte-identical.

`standingsFreezeAt` is named at arm's length from the existing `frozenAt` on purpose: one is the schedule, the other is the stamp recording that it happened, and `freezeAt`/`frozenAt` one character apart in the same interface is a bug waiting to be written.

## Consequences

Once implemented:

- `ceremonialDayIndexSet` will key off `scoring`, and the client freeze derivation off `standingsFreezeAt`, in both the app and the functions package. **After that lands, a reader who finds `pool === 'farewell'` in a scoring path is looking at a regression, not the design**—until then it is simply the current code.
- Most-Loved Photo will freeze against `standingsFreezeAt` under the same rule and carry the same parity test.

**The divergence this audit exposed, now fixed.** The client excluded only `tutorial` Days from First to BINGO (`src/game/logic.ts`), while `functions/src/finaleContent.ts` also excluded the easy and closing **pools**. Invisible on Gay Cruise Bingo, where those Days are also `tutorial: true`—but on any Event where they aren't, the card and the Feed print contradictory podiums, crediting different players. The fix aligned the functions side to the client and added a **parity test feeding one fixture schedule to both implementations, asserting identical output**. The two packages stay decoupled by design; the test is what stops them drifting again.
