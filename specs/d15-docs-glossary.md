---
spec_id: d15-docs-glossary
status: accepted
tested: false
reason: Documentation-only change to CONTEXT.md's glossary; there is no runtime surface and no code change to test.
---

# Phase 1.5 glossary additions (`d15-docs-glossary`)

Implements `plans/daily-cards-spec.md` § "Glossary additions (CONTEXT.md language)": adds the seven new Phase 1.5 domain terms—Day, Day Card, Tutorial Day, Pool, Pending, Day Snapshot, Tally Card—to `CONTEXT.md`'s `## Language` section, in the same style as the existing entries (bolded term, definition, `_Avoid_` note where the spec gives one).

## Contract

- `CONTEXT.md` gains a new `### Days & pools` subsection under `## Language`, placed after `### Event & pool` and before `### The card & play`, since Day/Pool/Snapshot are schema-adjacent to Event. It holds the seven new entries in the order the spec lists them: Day, Day Card, Tutorial Day, Pool, Pending, Day Snapshot, Tally Card.
- No existing entry's wording changes. `**Board**` keeps meaning the technical object (the new Day Card entry clarifies that "Board" and "Day Card" name the same thing from different angles); `**Theme**` is untouched—the two new tutorial `ThemeId`s are `#206`'s concern.
- This is a documentation-only ticket: no `src/` code changes. It does not implement Days, Pools, Snapshots, or Tally Cards—those land in `#200`, `#205`, `#202`, and `#216` respectively. This ticket only names them so every later ticket's body and code comments can use the terms consistently from Wave 1 onward.

## Verification

No `src/` runtime test applies—this is a docs-only change to a Markdown glossary. Verified by reading `CONTEXT.md` and confirming all seven terms appear under `## Language` with a definition and, where the spec gives one, an `_Avoid_` note, and that the existing Board/Theme entries are byte-for-byte unchanged. `npm run typecheck`, `npm test`, and `npm run build` are run per the Definition of Done to confirm the change has no unexpected effect on the app; none is expected since no `src/` file changes.
