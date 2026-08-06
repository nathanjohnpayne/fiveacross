---
status: accepted
---

# Marks are private on the Board but public as an attributed per-Prompt Tally

Three surfaces expose play at deliberately different granularities:

- **Board**—a Player's full card (which prompts they hold, their positions, bingo progress) is private to its owner and admins.
- **Feed**—a time-stream of Proofs and Moments; a *bare* mark posts nothing here.
- **Tally**—a per-Prompt, attributed aggregate of who has marked each prompt; **every** mark, proofed or not, publishes to it.

So "the Board is private" means *layout and progress* stay private, while the *fact that you marked a given prompt* is public by design. That disclosure is the "see who else got this square" feature—the product's core differentiator over the printed card. Marking is therefore a deliberate public act at the per-Prompt grain, not a private one.

## Consequences

- Do not "lock down" mark visibility—publishing each mark to its Prompt's Tally is intended, even though the Board that holds the mark is unreadable to others.
- **No anonymity.** If a Player marks a Prompt, their identity appears in that Prompt's Tally. Acceptable for a single 18+ friend group (see [ADR 0001](0001-honor-system-trust-model.md)); revisit if the audience ever widens.
- "Community-editable pool" and "frozen board" interact here: the Tally is only rich when boards share prompts, which favours a small, stable pool over an ever-growing one.
