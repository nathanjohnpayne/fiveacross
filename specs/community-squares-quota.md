---
spec_id: community-squares-quota
status: accepted
---

# Community Squares quota—reserve 2–4 Day Card Squares for approved suggestions

Implements #558 and the player/admin promises shown by `plans/daily-cards-wireframes.html#frame-vacay-card-sidequests` and `#frame-admin-settings`: a main Day Card carries two to four approved Community Prompts when that many are available, still has exactly the configured easy/exploratory composition, and a reshuffle inherits the frozen Day settings. This extends `specs/community-prompt-targeting.md` (which decides which Day may see a suggestion) and `specs/easy-mix.md` (which decides the 24 non-free Squares' easy/exploratory capacities). It does not change the targeting, snapshot, approval-authority, or free-centre contracts.

## Vocabulary and eligibility

- A **Community Prompt** is an item with a usable `targetDayIndex`: a non-negative integer, the same fail-closed predicate used by `community-prompt-targeting`. Only items already admitted to this Day's frozen snapshot reach the dealer. The snapshot therefore remains authoritative for the target Day, `retainedAt` exclusion, approval cutoff, moderation, and bans; the quota never re-derives or weakens those decisions.
- An item with an absent or malformed target is organiser/seed content for quota purposes. This preserves legacy untargeted content and keeps malformed targets from gaining a new admission path.
- **Difficulty** is the approved Prompt's normalized pool: `easy` (persisted as the transitional spelling `embark`) or `main`, labelled **Exploratory** in the approval UI. Adult-content sampling remains a property of exploratory/main Squares only: choosing Easy atomically forces `spicy: false`, mirroring `adminAddItem`, because Event adult-content derivation deliberately ignores non-main pools. The UI hides the spicy control while Easy is selected and clears any optimistic spicy intent; switching back to Exploratory restores the authoritative row posture.

## Approval-time classification

Every pending Community Prompt has an explicit Easy/Exploratory control in the Admin Review queue. The control defaults from the row's normalized pool (`main` for current and legacy submissions), and the selected difficulty plus the exact Exploratory spicy/tame choice travel with both single and bulk approval.

`approveItems` reads the authoritative pending row in the same Firestore transaction that reads the Event schedule and writes the approval. For a still-pending row it validates the caller's requested difficulty as `main` or `easy`, persists it through the existing pool vocabulary seam (`main` or `embark`), writes the caller's exact boolean spicy choice for Exploratory (or the authoritative stored value for an older caller that omitted it), forces `spicy: false` for Easy, and stamps status, routing, and approval metadata atomically. A stale/non-pending or missing row remains a no-op exactly as in `community-prompt-targeting`; no classification-only write escapes the approval guard. This caller-supplied classification is the one deliberate exception to the otherwise authoritative stored-row rule: it is an Admin decision made at approval, not stale routing state. Closing is never offered or accepted for Community Prompts.

The queue's `setItemSpicy` write is transactional too: it updates only an authoritative row that is still `pending` and still normalizes to `main`. If a spicy toggle races approval, Firestore retries the loser; once approval wins, the toggle sees an active row and becomes a no-op. The approval itself carries the same exact UI choice, so this safe no-op loses neither a tick nor an un-tick. `firestore.rules` independently enforce the resulting-state invariant on every item create and every Admin update that changes `pool` or `spicy`, including old clients: `main` (and a legacy row with no pool, which reads as main) may be spicy or tame, while `easy`/`embark`/`closing`/`farewell` must be `spicy: false`. Unrelated Admin edits and the existing report-only arm stay compatible with legacy rows whose pool is absent.

## Quota rule

The reservation is deterministic in size, not randomly chosen:

| classification-placeable Community capacity after easy/exploratory slot caps | Community Squares reserved before organiser selection |
| ---------------------------------------------------------------------------: | ----------------------------------------------------: |
|                                                                            0 |                                                     0 |
|                                                                            1 |           1, with organiser backfill for the other 23 |
|                                                                            2 |                                                     2 |
|                                                                            3 |                                                     3 |
|                                                                    4 or more |                                                     4 |

Thus “2–4 when enough exist” means every classification-placeable suggestion is guaranteed through four; a Day with only one placeable suggestion still shows that one rather than suppressing it. A frozen suggestion in a classification with zero capacity is still eligible Community content but is not placeable on this card. After the reservation, organiser content is preferred. Unselected Community Prompts are retained as a final **same-classification thin-pool backfill** before the existing cross-pool fallback, however, so a drawable 24-item snapshot never produces blanks or a false `MIN_POOL` failure merely because organiser supply is sparse. In that shortage case the final card may contain more than four Community Squares; four is the normal cap when organiser supply can fill the remaining slots, not permission to make an otherwise drawable Day fail.

The card's configured easy count remains `round(24 * easyMixRatio)` and the exploratory count remains `24 - easyCount`. Community Prompts count inside those capacities, never in addition to them. The reservation target is `min(4, eligibleCommunityCount)`. Its actual size is `min(target, easyPlaceable + exploratoryPlaceable)`, where each placeable count is capped by that classification's card capacity. It is apportioned proportionally: begin with `round(actual * easyCount / 24)` easy Community Squares, then clamp that value to the feasible interval imposed by (a) the easy/exploratory slot capacities and (b) eligible Community Prompts in each classification. Any reservation share one classification cannot supply moves to the other classification when that classification has both a slot and an eligible Prompt.

Conflict precedence is explicit:

1. Never admit an item the Day snapshot excluded, and never deal the same item twice.
2. Preserve the 24-Square easy/exploratory capacities whenever the existing pool/backfill contract can do so.
3. Fill the feasible Community quota up to four within those capacities.
4. Within exploratory Squares, preserve the configured spicy count when the available Community/organiser strata make it possible; otherwise use the existing stratum-dry backfill posture.

An easy-classified Community Prompt cannot occupy an exploratory-only card (`easyMixRatio: 0`), and the reverse holds at `easyMixRatio: 1`. Exact composition wins over an infeasible classification; the approval control is where an Admin avoids that conflict. Existing easy-mix shortage behavior still applies when a whole classification lacks enough total content.

## Selection, seed, and layout

Community and organiser candidates are separated before selection. The seeded PRNG chooses the reserved Community subset and organiser backfill, then uses unselected same-classification Community content only if the organiser pool cannot fill that classification's remaining capacity. The same pool/options/seed therefore produce the same board and different seeds can choose different reserved suggestions. Selection retains the existing interleaving posture rather than clustering a category.

On the exploratory side, Community selection and organiser backfill jointly target `round(exploratoryCount * spicyRatio)` spicy Squares. If the required Community reservation makes that target impossible, the reservation wins and the remainder is filled from the available stratum. Easy Squares remain outside spicy-ratio arithmetic, as specified by `easy-mix`.

When there are zero eligible Community Prompts, `dealBoard` executes the pre-#558 selection path with the same inputs and PRNG calls. Main-only, easy-mix, tutorial/unstratified, legacy untargeted, exclusion, backfill, error, and free-centre behavior is byte-identical.

## Reshuffle

No reshuffle-specific quota state is stored. `reshuffleBoard` already reloads the same frozen snapshot, reuses the board's frozen `easyMixRatio`, applies the same Event-wide main exclusion, and calls `dealBoard` with a fresh seed. The shared dealer therefore enforces the same quota and difficulty composition on the replacement card. The discarded board is not added to peer-player exclusion, preserving the existing reshuffle contract.

## Acceptance criteria

- With adequate organiser supply in the applicable classifications, a Day with 1, 2, 3, or at least 4 eligible Community Prompts deals exactly 1, 2, 3, or 4 of them; organiser content backfills the rest, and excess Community Prompts do not leak through.
- When organiser supply is thin, unselected Community Prompts may fill otherwise-empty slots in their own classification before the existing cross-pool fallback, so every previously drawable 24-item snapshot remains drawable.
- With adequate pools, every card has exactly the configured easy/exploratory counts, with Community Prompts counted inside their approved classification.
- A fixed seed is reproducible, and different seeds can select different Community Prompts when more than four are eligible.
- A zero-Community pool produces the exact legacy board for the same seed and options.
- Targeted-to-another-Day and retained Prompts remain absent because the Day snapshot filters them before dealing; malformed/absent targets do not acquire quota status.
- Single and bulk approval persist each Admin-selected Easy/Exploratory and spicy/tame classification atomically with approval and routing; Easy always persists `spicy: false` in that same write.
- Reshuffle uses the same frozen snapshot/settings and satisfies the same quota and composition.

## Claim → test

Mapped explicitly in `.repo-template.yml` because the coverage follows the existing module seams rather than this spec's basename alone.

- `src/game/community-squares-quota.test.ts`: reservation sizes 1/2/3/4, adequate-organiser cap/no-leak behavior, same-classification Community thin-pool backfill, exact easy/exploratory and spicy composition, classification-capacity precedence, deterministic selection, malformed/absent-target legacy treatment, free centre, and zero-community byte identity.
- `src/data/community-prompt-targeting.test.ts`: single/bulk approval writes the selected normalized difficulty atomically with the existing status/routing transaction and leaves stale/missing rows untouched.
- `src/components/Admin.test.tsx`: the Review queue exposes Easy/Exploratory classification and supplies the selected value to single and bulk approval.
- `src/data/reshuffle.test.ts`: a real reshuffle over a frozen mixed snapshot deals the same quota and exact inherited easy/exploratory composition.
- `tests/rules/community-squares-quota.test.ts`: the resulting-state adult-content invariant across canonical/legacy pool spellings, pending-main toggle allowance, atomic Easy approval, and denial of a late stale spicy toggle.

The unchanged `src/game/easy-mix.test.ts`, `src/game/logic.test.ts`, targeting snapshot tests, and approval tests remain regression coverage for the inherited contracts.
