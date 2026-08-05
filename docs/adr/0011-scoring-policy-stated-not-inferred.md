---
status: accepted
---

# A Day's Scoring Policy is stated, not inferred from its Pool — and the Standings Freeze is an Event setting

[d15-finale](../../specs/d15-finale.md) tied three things together that are actually independent: the closing **pool** meant the card was ceremonial, and the freeze fired at that Day's `unlockAt`. That holds for a ten-day Event whose last card opens on the morning everyone goes home, and breaks immediately for a weekend trip whose final morning is real competitive play ending at check-out. We therefore state scoring explicitly — `DayDef.scoring: 'competitive' | 'ceremonial'` — and put the freeze on the Event as `EventDoc.standingsFreezeAt`. A Day's **Pool identity** (which prompts it deals), its **Tutorial framing** (whether it is eligible for the Event-wide First to BINGO), and its **Scoring Policy** are three independent facts. Legacy Event docs default `scoring` from pool on read, so the Gay Cruise Bingo Event's behaviour is byte-identical.

`standingsFreezeAt` is named at arm's length from the existing `frozenAt` on purpose: one is the schedule, the other is the stamp recording that it happened, and `freezeAt`/`frozenAt` one character apart in the same interface is a bug waiting to be written.

## Consequences

- `ceremonialDayIndexSet` keys off `scoring`, and the client freeze derivation off `standingsFreezeAt`, in both the app and the functions package. **A future reader who finds `pool === 'farewell'` in a scoring path is looking at a regression, not the design.**
- Auditing this exposed a live divergence: the client excluded only `tutorial` Days from First to BINGO, while `functions/src/finaleContent.ts` also excluded the easy and closing **pools**. Invisible on Gay Cruise Bingo, where those Days are also `tutorial: true` — but on any Event where they aren't, the card and the Feed would print contradictory podiums. The functions side is aligned to the client, and a **parity test feeds one fixture schedule to both implementations and asserts identical output**. The two packages stay decoupled by design; the test is what stops them drifting again.
- Most-Loved Photo freezes against `standingsFreezeAt` under the same rule and carries the same parity test.
