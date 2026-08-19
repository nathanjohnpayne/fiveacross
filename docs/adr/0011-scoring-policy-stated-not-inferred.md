---
status: accepted
implemented: true
---

> **Implemented.** `DayDef.scoring` and `EventDoc.standingsFreezeAt` exist, `ceremonialDayIndexSet` keys off the stated policy, and the client freeze derivation reads the Event setting. Both fields are OPTIONAL and resolved on read—`scoringForDay` (`src/game/scoring.ts`, mirrored by `functions/src/scoringVocab.ts`) falls back to the closing-pool derivation, and `standingsFreezeAtFor` (`src/game/logic.ts`) falls back to the first ceremonial Day's `unlockAt`—so the two live Events, whose docs carry neither key, behave exactly as they did. The resolvers, not the fields, are the contract every consumer holds: several data paths hydrate raw documents that no converter has touched, the same reason `normalizePool` exists.
>
> `tests/functions/finale-parity.test.ts` now feeds one fixture schedule and one fixture roster to BOTH podium builders and asserts identical champion and First-to-BINGO output, on the cruise shape, a Five Across shape, a competitive-close shape and a schedule with no ceremonial Day at all. `src/game/scoring-policy.test.ts` pins the legacy read: the seeded ten-Day schedule and a legacy-spelling Event doc both resolve to the same ceremonial set and the same freeze instant the pool-scanning code produced.
>
> **The divergence this audit exposed was fixed ahead of the rest**, because the Bodega schedule aimed it at a real Event: `functions/src/finaleContent.ts` excludes Tutorial Days by the flag alone, matching the client, and an easy-pool Friday with `tutorial: false` would otherwise have had the card and the Feed name different players as First to BINGO.

# A Day's Scoring Policy is stated, not inferred from its Pool—and the Standings Freeze is an Event setting

[d15-finale](../../specs/d15-finale.md) tied three things together that are actually independent: the closing **pool** meant the card was ceremonial, and the freeze fired at that Day's `unlockAt`. That holds for a ten-day Event whose last card opens on the morning everyone goes home, and breaks immediately for a weekend trip whose final morning is real competitive play ending at check-out. We therefore state scoring explicitly—`DayDef.scoring: 'competitive' | 'ceremonial'`—and put the freeze on the Event as `EventDoc.standingsFreezeAt`. A Day's **Pool identity** (which prompts it deals), its **Tutorial framing** (whether it is eligible for the Event-wide First to BINGO), and its **Scoring Policy** are three independent facts. Legacy Event docs default `scoring` from pool on read, so the Gay Cruise Bingo Event's behaviour is byte-identical.

`standingsFreezeAt` is named at arm's length from the existing `frozenAt` on purpose: one is the schedule, the other is the stamp recording that it happened, and `freezeAt`/`frozenAt` one character apart in the same interface is a bug waiting to be written.

## Consequences

Now that it has landed:

- `ceremonialDayIndexSet` keys off `scoring`, and the client freeze derivation off `standingsFreezeAt`, in both the app and the functions package. **A reader who finds `pool === 'farewell'` (or `=== 'closing'`) in a scoring path is now looking at a regression, not the design.** The one legitimate remaining place is inside the two `scoringForDay` resolvers, which is where the legacy derivation is deliberately concentrated.
- The podium exclusion is a SET, not a single index. The old `farewellDayIndex` resolved the first closing-pool Day and excluded that one, so a second standings-inert Day silently counted; a schedule may now state as many ceremonial Days as it means.
- `finaleTimes` returns `null` only when an Event has NEITHER a configured freeze nor a ceremonial Day. The finale is still not an automatic consequence of the schedule ending—it is now a stated freeze or a stated policy rather than a pool assignment.
- Most-Loved Photo freezes against the same resolved instant (`finaleTimes` feeds its cutoff) and rides the same parity test.
- **Not yet done:** the organiser wizard authors neither field. `EventDraft` still validates "the final Day carries the closing pool" (`finaleClosingPoolIssues`, `src/data/draftValidation.ts`), which remains correct for what the wizard can express—it just cannot yet express a competitive final morning. Teaching the wizard to author a Scoring Policy and a freeze is a follow-up.

**The divergence this audit exposed, fixed ahead of the rest.** The client excluded only `tutorial` Days from First to BINGO (`src/game/logic.ts`), while `functions/src/finaleContent.ts` also excluded the easy and closing **pools**. Invisible on Gay Cruise Bingo, where those Days are also `tutorial: true`—but on any Event where they aren't, the card and the Feed print contradictory podiums, crediting different players. The fix aligned the functions side to the client and added a **parity test feeding one fixture schedule to both implementations, asserting identical output**—since extended to compare the full podium (champion and First to BINGO), not just the Tutorial set that feeds it. The two packages stay decoupled by design; the test is what stops them drifting again.
