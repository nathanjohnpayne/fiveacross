---
spec_id: most-loved-photo
status: accepted
---

# Most-Loved Photo: the frozen finale award (`most-loved-photo`)

At the Standings Freeze the scheduler computes and persists, exactly once, the visible, moderation-eligible photo Proof holding the most eligible Hearts—the Most-Loved Photo (#534/#560). Server-computed and persisted, never derived live: the final standings and the finale share composition (#561) render the recorded award, and the frozen result never recomputes. Guarded by `tests/functions/most-loved.test.ts` (the beat), `tests/functions/most-loved-parity.test.ts` (client/functions mirror parity), `src/data/mostLoved.test.ts` (client derivations + analytics payload), and `tests/rules/most-loved-photo.test.ts` (the rules posture).

## Glossary

**Award**—the frozen `EventDoc.mostLovedPhoto` record. Appreciation for a moment, never player rank: it touches no stats, no leaderboard, no win logic (ADR 0001 untouched, the feed-hearts posture).

**Winner**—one persisted co-winner entry inside the award. Ties share the honour: the first 100 co-winners, ordered `proofCreatedAt` ascending then `proofId` ascending, persist as the deterministic display/share prefix (`winners[0]` is the earliest-posted hero); `winnerCount` records the full tied cardinality.

**No-award record**—the award with `winners: []`, persisted when no eligible Heart exists at the freeze. Explicit on purpose; see § Idempotence.

## The persisted artefact

`events/{eventId}.mostLovedPhoto`—a sibling of `frozenAt`, NOT a Moment and NOT a new collection. The award is Event-level frozen state exactly like the freeze stamp; the client already holds the Event doc everywhere the finale needs it (Board's `useEventDoc` flows into `FarewellPodium` as a prop per the no-second-listener rule); Moments carry report/heart surfaces an award must not have; a new collection would need new read rules. `winners` is a deterministic first-100 prefix, so even an anomalously large zero/one-Heart tie stays comfortably below the 1 MiB doc limit; `winnerCount` retains its full cardinality.

The shape is the shared contract in `src/domainTypes.d.ts` (`MostLovedPhotoAward` / `MostLovedPhotoWinner`), consumed by both compiler roots via the declaration-only import (the daily-engagement-email precedent): `winners` (the first 100 ordered co-winners, each carrying `proofId`, `uid`, `displayName`, `promptText`, `dayIndex`, `proofCreatedAt`—the winning ProofDoc's own denormalized fields at the freeze, no roster join), `winnerCount` (the complete tied cardinality, including co-winners outside the bounded display prefix), `heartCount` (the frozen eligible count shared by all winners, 0 when `winners` is empty), `frozenAt` (the freeze cutoff computed against, equal to the `EventDoc.frozenAt` value), and `computedAt` (the scheduler run clock, diagnostics only). `eventConverter` passes the field through untouched—absence is meaningful and gets no default.

**No media URL is persisted, deliberately.** The winners carry no `mediaURL`/`thumbURL`/`storagePath`. The client must consult the live Proof doc anyway to honor the hidden-after-freeze display fallback, and the live doc carries the media; persisting a URL would create exactly one failure mode—rendering an image moderation has since hidden. `proofCreatedAt` is the display join key (the incarnation stamp).

## The compute trigger: a third finale beat

The award computes in a new sibling best-effort beat inside `runFinaleBeats` (`functions/src/unlockDay.ts`), keyed to the same `atFreeze` transition that stamps `frozenAt`—it piggybacks on the proven `frozenAt` machinery rather than introducing `standingsFreezeAt` consumption (see § Deviations #1). `finaleActions` returns `computeMostLoved` only while the Event is still unfrozen and the award is absent. Unlike the podium, this beat is deliberately coupled to the freeze: an award retry must never rebuild its eligibility from later moderation state.

`freezeStandingsAndPersistMostLovedAward` reads the Event, `events/{eventId}/proofs`, and `events/{eventId}/hearts` inside one Firestore transaction, maps the collection snapshots defensively onto plain shapes, delegates to the pure `buildMostLovedPhotoAward` in `functions/src/finaleContent.ts`, then writes `frozenAt` and the explicit award record together. The transaction's read snapshot captures Proof visibility, the event report threshold and ban roster, and Heart eligibility at the one successful freeze. If an award-input read fails, neither frozen field lands; the next tick retries the complete snapshot rather than combining an old freeze with new moderation data. The podium remains an independent best-effort beat.

**The cutoff is the SCHEDULED freeze instant** (`times.farewellUnlockAt`), never the run clock: Hearts whose Firestore `createTime` is after the cutoff are excluded, even if the transaction begins late. Once the atomic write succeeds, its explicit award record is immutable for all later ticks, report actions, Proof moderation, and roster changes. Residual, accepted: if a scheduler cannot obtain the input snapshot at all, it delays the entire freeze until a later healthy run rather than claiming a historically exact award it cannot reconstruct.

## Idempotence and the explicit no-award record

The transaction's absent-field guards mean only the run that flips both `frozenAt` and `mostLovedPhoto` from unset writes; every retry, quarter-hourly re-tick, concurrent double-invocation, or manual run no-ops. This holds for the no-award case too BECAUSE that case persists `winners: []`: if no-award were represented by field absence, a later run could invent an award—violating "the frozen result NEVER recomputes". The explicit empty record freezes the no-award outcome with the same write-once semantics.

## Eligibility

The verbatim rules (decided 2026-08-04) map onto the data model as follows; each clause is a named predicate the parity test pins on both implementations:

| Verbatim rule | Data-model mapping |
|---|---|
| visible, moderation-eligible photo Proof | `type === 'photo'` AND the Feed's exact filter (`useProofFeed`): `status === 'active'`, NOT report-hidden (fail-open threshold, `isReportHidden`), owner not banned (`isBanned`) |
| hidden, deleted, retracted excluded | hidden = the status/report filters; deleted = doc removal, absent from the read set by construction; retracted has no Proof state (see § Deviations #2) |
| a Heart counts for a Proof | `targetKind === 'proof'`, `targetId` match, incarnation match (`targetCreatedAt === proof.createdAt`, the `heartState` rule), Firestore server `createTime <= cutoff` (not the client-set Feed-ordering `createdAt`) |
| own Heart on own Proof does NOT count | `heart.uid !== proof.uid`—new logic existing nowhere else; `heartState` deliberately counts self-hearts for display and that stays unchanged |
| banned Players' Hearts do NOT count | `!isBanned(heart.uid, bannedUids)` UNCONDITIONALLY: `heartState`'s own-content exception (a banned viewer still sees their own heart) is display-only and does NOT apply to the award |
| the count | unique eligible heart uids per proof (the deterministic slot id already guarantees one doc per pair; the Set makes the pure function total) |
| winner / tie | every eligible proof at the maximum count when the maximum is at least 1; `winnerCount` preserves that full cardinality, while the first 100 in `proofCreatedAt`/`proofId` order persist for the bounded display/share prefix |
| no eligible Hearts means no award | the explicit `{ winners: [], heartCount: 0 }` record |
| the frozen result never recomputes; hidden later stays recorded | the transaction guard prevents recomputation; display fallback is render-time (`mostLovedDisplayWinners`) |

## Client mirror, display gate, and parity

`src/data/mostLoved.ts` (pure, Firestore-free, React-free) exports `proofFeedVisible` (the Feed's three-predicate filter as one named function; `useProofFeed` itself is NOT refactored—it is a hot pre-freeze file), `buildMostLovedPhotoAward` (the mirror, same semantics as the functions builder), `mostLovedDisplayWinners` (the render-time gate: persisted winners joined against live, already-Feed-filtered proofs by `proofId` AND `proofCreatedAt` AND `type === 'photo'`; a winner with no surviving live proof is dropped from display while the award record is untouched, and the finale falls back to photo highlights), and `mostLovedFrozenEventPayload` (§ Analytics). `tests/functions/most-loved-parity.test.ts` feeds one fixture set to BOTH builders and asserts deep-equal output plus pinned literals—the #551 finale-parity pattern, per ADR 0011's pre-commitment that a mirror ships with its parity test.

## The share credit line reports the TRUE tie (#659)

The finale share card's credit line—`<hero name> · “<prompt>” · <day label>`, composed by `mostLovedShareCreditLine` in `src/components/FarewellPodium.tsx` and rendered as the photo-hero card's `.share-card-ml-by`—closes with a `shared with` tie suffix, and that suffix counts from `winnerCount`, never from `winners.length`. `winners` is the deliberately bounded first-100 prefix (§ The persisted artefact), so deriving the suffix from its length undercounted every tie that overflowed the prefix: a 101-way tie read "shared with 99 others".

The rule, in order. When the persisted prefix holds the COMPLETE tie (`winners.length >= winnerCount`) the suffix reads `· shared with <Name>` for a single co-winner and `· shared with <N> others` for more, N counting the co-winner entries actually present with the hero excluded—the pre-#659 wording, unchanged, because in that case the array and the count agree. When the prefix was TRUNCATED (`winners.length < winnerCount`) the array is not the whole tie, so no name from it can be presented as "the" co-winner: the suffix reports the true total minus the hero (`· shared with 100 others` for a 101-way tie) and names nobody. A record written before `winnerCount` existed has the field absent, which falls back to `winners.length` and reproduces the pre-#659 behaviour exactly. A hero with no co-winners gets no suffix at all.

Pinned by `src/components/w2-share-cards.test.tsx` (the named-co-winner wording, and the truncated-prefix case asserting `shared with 100 others` against a `winnerCount: 101` record whose `winners` array holds two entries).

## Rules posture

**No rules edit.** The field inherits `frozenAt`'s exact posture: the whole `events/{eventId}` doc is `read: if signedIn()` and `create, update: if isAdmin(eventId)`, so non-admin clients can never write the award, every signed-in Player can read it (which is what the finale needs), and the scheduler's Admin SDK write bypasses rules. This is the documented precedent—`tests/rules/d15-finale.test.ts` pins "frozenAt is admin/Function-writable only" with no dedicated clause, and `tests/rules/most-loved-photo.test.ts` is its clone for this field. A stricter admin-cannot-touch guard was considered and rejected: it edits a live-event rules file for no attacker the current model recognizes (admins are trusted; `frozenAt` has identical exposure).

## Analytics

`most_loved_photo_frozen` is registered in `GA4_EVENTS` (`src/analytics.ts`) and fired CLIENT-SIDE on first observation of the persisted award (once per device per event via a localStorage guard, the #561 call site in `FarewellPodium`)—functions emit no PostHog/GA4 events today and building a first-ever server capture path days before a live freeze is unjustified risk (§ Deviations #5). Params come from `mostLovedFrozenEventPayload`: `winnersCount`, `heartCount`, `tie`, `award`, `proofId` (winners[0] or null), `dayIndex`—ids and counts only, never `mediaURL`/`thumbURL`/`storagePath`/display names, unit-tested to contain no media keys. The no-award record fires too (`award: false` is signal).

## Deviations, vocabulary mappings, and flags

1. **ADR 0011 letter deferred:** the award freezes against the `frozenAt` transition (`times.farewellUnlockAt`), not a consumed `standingsFreezeAt`—no runtime consumer of that field exists (only seed data and a seed test), and for Bodega the seed pins the two instants equal (`standingsFreezeAt == days[3].unlockAt`). When the standingsFreezeAt migration lands, freeze and award move together by construction because both read the same boundary. The parity test ADR 0011 demands DOES ship.
2. **"Retracted Proofs" cannot be excluded as specified**—no retracted state exists on Proofs (retraction is a Moments concept); deletion is doc removal. Mapped to: status filter + report threshold + ban + doc absence.
3. **"PRD § Community contribution and connection" does not exist in the repo**—the substance is carried by the verbatim eligibility decisions and the epic body.
4. **"Subject to the Event's media-sharing policy" (#561): no such EventDoc field exists.** Not invented here; winners render under the Feed's visibility rules. Flagged for a follow-up ticket.
5. **Analytics fires client-side on observation, not server-side at the freeze instant**—the acceptance criterion ("fires without private media in the payload") is met by the payload builder.
6. **The wireframe's crown-row stat is dropped**—`fx-share-final-photo-*` shows a stat beside the First-to-BINGO crown row ("Day 1, 4:12 p.m." on vacay/fa, "11 bingos" on gcb), but `FarewellShareCardData.firstBingo` carries only `displayName` and the card system renders no timezone-formatted times, so the photo-hero card renders the crown row name-only (`src/components/ShareCard.tsx`, `buildFarewellCardNode`).
