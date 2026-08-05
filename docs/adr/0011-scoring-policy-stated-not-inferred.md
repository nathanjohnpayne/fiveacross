---
status: accepted
implemented: false
---

> **Decision accepted; code not yet migrated.** Nothing described below exists in the tree at the time of writing: there is no `DayDef.scoring` or `EventDoc.standingsFreezeAt`, `ceremonialDayIndexSet` and the client freeze derivation still infer from `pool === 'farewell'`, and the functions mirror still excludes the easy and closing pools from First to BINGO. The divergence in the Consequences section is therefore **live**, not fixed. This ADR records the decision and the defect it exposed so the implementation lands against a written intent; the code and its parity test are tracked separately.

# A Day's Scoring Policy is stated, not inferred from its Pool — and the Standings Freeze is an Event setting

[d15-finale](../../specs/d15-finale.md) tied three things together that are actually independent: the closing **pool** meant the card was ceremonial, and the freeze fired at that Day's `unlockAt`. That holds for a ten-day Event whose last card opens on the morning everyone goes home, and breaks immediately for a weekend trip whose final morning is real competitive play ending at check-out. We therefore state scoring explicitly — `DayDef.scoring: 'competitive' | 'ceremonial'` — and put the freeze on the Event as `EventDoc.standingsFreezeAt`. A Day's **Pool identity** (which prompts it deals), its **Tutorial framing** (whether it is eligible for the Event-wide First to BINGO), and its **Scoring Policy** are three independent facts. Legacy Event docs default `scoring` from pool on read, so the Gay Cruise Bingo Event's behaviour is byte-identical.

`standingsFreezeAt` is named at arm's length from the existing `frozenAt` on purpose: one is the schedule, the other is the stamp recording that it happened, and `freezeAt`/`frozenAt` one character apart in the same interface is a bug waiting to be written.

## Consequences

Once implemented:

- `ceremonialDayIndexSet` will key off `scoring`, and the client freeze derivation off `standingsFreezeAt`, in both the app and the functions package. **After that lands, a reader who finds `pool === 'farewell'` in a scoring path is looking at a regression, not the design** — until then it is simply the current code.
- Most-Loved Photo will freeze against `standingsFreezeAt` under the same rule and carry the same parity test.

**The divergence this audit exposed is live today.** The client excludes only `tutorial` Days from First to BINGO (`src/game/logic.ts`), while `functions/src/finaleContent.ts` also excludes the easy and closing **pools**. Invisible on Gay Cruise Bingo, where those Days are also `tutorial: true` — but on any Event where they aren't, the card and the Feed print contradictory podiums, crediting different players. The fix aligns the functions side to the client and adds a **parity test feeding one fixture schedule to both implementations, asserting identical output**. The two packages stay decoupled by design; the test is what stops them drifting again.
