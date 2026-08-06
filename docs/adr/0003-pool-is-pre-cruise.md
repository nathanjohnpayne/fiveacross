---
status: accepted
---

# The prompt pool is a pre-cruise seeding activity; boards freeze at join

A bingo card must be fixed, so a Board freezes when a Player joins, and a Prompt added afterward can never appear on an already-dealt Board. We therefore treat the community-editable pool as primarily a **pre-cruise** activity (plus latecomers and future Events): the group loads prompts before embarkation, and the pool effectively freezes as people join. We keep the pool deliberately **dense** (~30–50 active prompts) so Boards overlap and the Tally stays rich, and we ship **no re-deal or square-swap** at launch.

## Consequences

- Mid-cruise adds are allowed but mostly **inert** on existing Boards—expected, not a bug.
- "Add a prompt in < 5s" is a real mechanic, but its value is pre-cruise—message it as "get your prompts in before we sail."
- Admins prune runaway pool growth to protect Tally density (see [ADR 0002](0002-mark-visibility-boundary.md)).
- If mid-cruise editability ever matters, it needs a deliberate re-deal / square-swap mechanism—a known, deferred cost.
