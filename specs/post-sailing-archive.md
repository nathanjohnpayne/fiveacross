---
spec_id: post-sailing-archive
status: accepted
---

# post-sailing-archive—freeze the Event, keep the Leaderboard and the First-to-BINGO hall of fame

Delivers the PRD's *"remember the winners"* end state (issue #134): after the occasion, an Admin freezes the Event, and the final Leaderboard standings plus the First-to-BINGO hall of fame persist unchanged from then on. `EventDoc.status` has been typed `'active' | 'archived'` since the schema contract landed, but nothing set it and nothing read it; this ticket makes it a real state with a real consequence on both sides—a durable record on the read side, and a server-enforced write denial on the other.

Honor-system-consistent throughout ([ADR 0001](../docs/adr/0001-honor-system-trust-model.md)). The archive **snapshots** the client-authoritative standings; it never recomputes, re-derives or "verifies" them. Archiving is a per-Event state transition, not a migration: the data model is already event-scoped ([ADR 0003](../docs/adr/0003-pool-is-pre-cruise.md)), a future occasion is a NEW Event document, and an archived Event is never reset or reused.

## Contract

### The frozen record—`EventDoc.archivedAt` + `EventDoc.archive`

`src/domainTypes.d.ts` gains `archivedAt?: number` (the freeze stamp) and `archive?: EventArchive` (the record), alongside `ArchivedStandingRow`, `ArchivedFirstBingo`, `ArchivedDayHonor` and `EventArchive` itself. Both Event fields are ABSENT until the Event is archived and pass through `eventConverter` untouched, exactly as `frozenAt` and `mostLovedPhoto` do—inventing a default could only ever manufacture an archive that was never taken.

`EventArchive` carries the final `standings` (already ranked, ban-filtered, in Leaderboard order), `playerCount` (the complete ban-filtered roster size), `firstBingo` (the Event-wide headline honour, or `null`), `dailyHonors` (each Day's own First to BINGO), `freezeAt` (the resolved Standings Freeze the snapshot cut on) and `archivedAt`.

`standings` retains a bounded prefix of `MAX_ARCHIVED_STANDING_ROWS` (200) rows while `playerCount` records the true cardinality—the `MostLovedPhotoAward.winners` / `winnerCount` pattern, for the same reason: the Event document has one 1 MiB budget that `days`, `bannedUids` and `mostLovedPhoto` already draw on, and an unbounded roster copy is the one field that could make it unwritable. Both live Events have two-figure rosters, so nothing is dropped in practice.

**`archivedAt` is named at arm's length from `frozenAt` on purpose,** the same discipline ADR 0011 applied to `standingsFreezeAt` versus `frozenAt`. `frozenAt` stamps the FINALE—competitive scoring stops, the podium computes, the closing Day opens, and the Event keeps running. `archivedAt` stamps the END—gameplay writes are denied at the rules boundary and the frozen record is what the Leaderboard renders. Two different events, hours or weeks apart.

**`EventDoc.status` is not `HostnameDoc.status`.** They are different fields with different value sets answering different questions for different audiences: the routing status (`'active' | 'disabled' | 'archived'`) decides ADDRESSING, world-readably, before first paint (`src/eventResolution.ts`, [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md)); the Event status decides BEHAVIOUR, after mount, behind `signedIn()`. An Event can be archived while its hostname is still perfectly servable—that is how a Player reaches the archive at all.

### The snapshot—`src/data/eventArchive.ts`

`buildEventArchive(...)` is pure, Firestore-free and React-free (the `src/data/finale.ts` precedent), so the freeze rules are unit-testable without an emulator or a mounted component. `isEventArchived(event)` is the ONE place the client asks whether an Event is frozen, so no surface invents its own spelling of the comparison.

The builder mirrors `src/components/Leaderboard.tsx` clause for clause, because the archive's promise is "the Leaderboard, kept":

- **Standings** are the ban-filtered roster in `sortPlayers` order—exactly the rows the live Leaderboard lists and the Share Card prints. Every number is COPIED off the Player-written `PlayerDoc`; a row whose root totals disagree with its own `dayStats` keeps its root totals, because the Player wrote both and the archive records what the Leaderboard showed rather than adjudicating between them (ADR 0001). The only derivation is the ORDER, and `sortPlayers` is a stable sort, so passing `useLeaderboard`'s already-ranked roster reorders nothing—running it anyway means the record cannot depend on a caller remembering to sort.
- **The headline First to BINGO** comes from `eventFirstBingoWinner`, the ONE selector the live pin, the frozen podium and the ceremonial `first_bingo` Moment gate already share, cut on the same resolved Standings Freeze (`resolvedStandingsFreezeAt`). The archive must not become a fourth answer to a question three surfaces already agree on.
- **Daily honours** come from `pinnedOrDerivedDailyHonors`, exported from `src/data/finale.ts` by this ticket rather than restated—the write-once day-meta pin when a Day has one, the roster-derived fallback when it does not.

### The admin action—`archiveEvent` (`src/data/admin.ts`)

ONE `runTransaction` update on ONE document, writing `status: 'archived'`, `archivedAt`, and the record together. That atomicity is load-bearing rather than incidental: the rules key gameplay denial on `status` and the Leaderboard renders from `archive`, so an observer who could see one without the other would see either an empty archive or a writable one.

The transaction re-reads the Event inside itself and returns `already-archived` rather than re-freezing, so a double tap—or a second Admin's tap—can never overwrite the record with a later roster. It re-reads the Event RAW (the `setDayTheme` / `confirmClaim` discipline) so the ban roster and schedule the record freezes against are the stored ones, while the ROSTER comes from the caller's live `useLeaderboard` subscription: this is a snapshot of the standings the Admin is looking at, not a server-side recompute of them.

### The surfaces

- `src/components/admin/ArchiveEvent.tsx`—the archive door, rendered last inside **Game settings** (`specs/admin-console-ia.md` § "Game settings"), because it is the one control there that ends the Event rather than tuning it. Two taps, never one: the button arms an inline confirm row stating what is about to be frozen (derived from the same builder the write uses, so the preview cannot drift from the record), and the result is reported in place. Once the Event is archived the control retires and the row states the frozen record instead.
- `src/components/ArchivedLeaderboard.tsx`—the read-only archive surface: the frozen standings, the hall of fame (Event-wide First to BINGO plus the daily honours strip), and the Share Card. It subscribes to NOTHING. There is no `useLeaderboard`, no `sortPlayers`, no `cruiseFirstBingoUid` and no day-meta read in it; every number, name and honour was decided once, at the archive. That is what makes "opened later, the standings persist unchanged" true rather than merely likely.
- `src/components/Leaderboard.tsx`—branches to that surface when the Event is archived AND carries a record. The branch sits after every hook call and before the loading/empty early returns (the #280 hook-order rule): it changes what renders, never how many hooks ran.
- `src/index.css`—the `.lb-archived-banner` block. Quiet on purpose: an archive is a keepsake, not an error state, so it borrows the panel chrome the honours strip already uses.

The archived view stays shareable through the existing on-device Share Cards (#36, [ADR 0005](../docs/adr/0005-client-side-share-images.md))—a frozen leaderboard is the most shareable thing an Event ever produces—and there is still no crawler-facing page.

### The enforcement—`firestore.rules` and `storage.rules`

`eventOpenForPlay(eventId)` is the single predicate, and it is ANDed into every gameplay write arm: Boards, Player rows, the write-once per-Day honour, reshuffle spends, Prompt creates and reports, Proof creates and reports, Claims, Tally markers (create, update and delete), Doubts (raise, satisfy, withdraw), Hearts (create and delete), Moments, and retraction tombstones. `storage.rules` mirrors it on proof-media upload, because a Proof document and its media must refuse together or the archive still grows blobs—the #806 lesson, restated by `specs/path-addressing-and-root.md` § D8 as "Storage uploads under that Event's prefix alike".

Rendering is not enforcement, and this spec refuses to pretend otherwise: hiding the controls client-side would leave a direct Firestore write succeeding, which is exactly the client-only convention D8 rejects. Every rules case in the test map below is a direct SDK write, not a UI path.

The Event document's own arm gains three clauses beside the existing `isAdmin(eventId)` gate—which is where "admin-only toggle" comes from, inherited rather than invented, since no Player may write that document at all:

1. `status`, now that something finally reads it, must be `'active'` or `'archived'`. A typo'd status reads as OPEN through `eventOpenForPlay`'s default, so an Event an organiser believed was frozen would silently keep taking Marks.
2. An archived Event must carry a numeric `archivedAt`, which makes "no reader sees an archived Event with no stamp" an enforced invariant rather than a property of one client's writer.
3. The freeze is WRITE-ONCE: once `status` is `'archived'`, `status`, `archivedAt` and `archive` are locked to their stored values. Every OTHER field stays editable, so moderation (`bannedUids`) and configuration survive the freeze.

## Design decisions

- **Archiving is one-way from the client.** `status: 'archived'` is terminal: the rules refuse to move it back, refuse a second stamp, and refuse a rewritten record. The alternative—a reversible toggle—means the "frozen" standings can silently drift out of sync with a roster that resumed playing, and hands an Admin a switch that reopens writes on a record other people have already shared. Write-once is the same posture the day-meta honour doc and Moment immutability already take in this rules file. See § Recovery for the escape hatch.
- **Moderation is not a gameplay write.** Every `isAdmin(eventId)` arm keeps working on an archived Event: hide, restore, delete, ban, resolve a dangling claim, edit configuration, and delete proof media from Storage. A permanent record needs a takedown path—a reported photo that can never be hidden again is the support incident (#808's "an archive that locks out its own Admin"), and the write-once clause deliberately protects only the three archive fields.
- **Admins are bound by the freeze for GAMEPLAY, though.** The Board and Player arms deny the admin branch too. An "archive" whose own organiser can still mark a square is not a frozen record.
- **A ban hides; it never reassigns.** The headline honour is selected over the FULL, RAW roster and then dropped to `null` if its holder is banned, so a later Player is never promoted into an honour that already happened. A pinned daily honour whose holder is banned yields no chip for that Day rather than the derived runner-up. This is the live Leaderboard's own rule (`specs/w2-ban-console.md` § Leaderboard), made permanent.
- **The record stores no photo URLs.** Standings rows carry no `photoURL`, for the reason `MostLovedPhotoWinner` persists no media URL: a frozen record must never render a Player's identity from a stale copy they have since changed or removed. The archived rows show initials.
- **The archive freezes the LEADERBOARD, not the podium.** The frozen podium (`specs/d15-finale.md`) answers a different question—champion as of the Standings Freeze, with ceremonial Days re-excluded from the totals—and it already has its own immutable Moment. The archive keeps what the Leaderboard showed, which is what a returning Player is looking for.
- **The archive control lives inside Game settings**, not behind a seventh hub door. It is a once-per-Event switch, not a surface anyone visits; giving it its own card would put the most destructive control in the console at the same level as the prompt pool.

## Out of scope—and stated, so nothing is assumed

- **Read gating is untouched, deliberately.** An archived Event stays exactly as readable as it was live, to exactly the audience it was readable to. Who may read an archived Event, and for how long—member, ex-member, stranger, and the mirrored Storage posture—is [#808](https://github.com/nathanjohnpayne/fiveacross/issues/808)'s question, and that ticket is explicit that #134 must not independently invent what `status: 'archived'` means for reads. A rules case in the test map asserts reads still succeed after the freeze, so a future read gate is a deliberate change rather than an accident of this one.
- **The `apexPath` / routing half of `specs/path-addressing-and-root.md` § D8 does not ship here.** D8 requires the archival write to move every routing document, the `apexPath` field and `EventDoc.status` in ONE transaction. Path addressing ships nothing today (that spec says so itself), so there are no routing fields to move: `archiveEvent` is one update on one document, which satisfies the ordering hazard D8 actually names (routing flipping first, serving an "archive" a Player can still mark) by construction. When path addressing lands, that transaction has to grow to include the routing documents; this spec is the record that it has not yet.
- **The bounded client transition does not ship here either.** D8 requires a live `hostnames/{host}` watcher to re-resolve and unmount an open session, and boot-time status revalidation before a cached entry mounts, so archival is not left waiting on TTL expiry. This ticket ships neither, and the honest statement is D8's own: **archival is prompt at the origin and lagging on cached clients.** The bound that does hold is the server one—an archived Event's gameplay writes are denied for every client from the moment the flip lands, whatever a stale client still renders.
- **No Cloud Functions change.** `runScheduledUnlockForActiveEvents`, the daily-email sweep and the admin-alert sweep all filter `status == 'active'`, so archiving removes an Event from them—which is the desired effect. `defaultListEventThresholds` (`functions/src/autohide.ts`) reads every Event with no status filter and continues to touch archived ones; that asymmetry predates this ticket and is left alone rather than changed under it (#808 § Contract facts records it).

## Acceptance criteria

- **Given** an admin archives the Event after the occasion, **when** any Player tries to Mark or attach a Proof, **then** the write is denied at the rules boundary and the app shows the read-only final standings plus the First-to-BINGO hall of fame—`tests/rules/post-sailing-archive.test.ts` ("DENIES a Mark…", "DENIES a Proof create…", "DENIES a proof-media upload…") + `src/components/post-sailing-archive.test.tsx` ("shows the frozen standings, not the live roster", "announces the archive and pins the hall of fame").
- **Given** an archived Event, **when** it is opened later, **then** the final Leaderboard and hall of fame persist unchanged—`tests/rules/post-sailing-archive.test.ts` ("LOCKS status, archivedAt and the frozen record once archived") + `src/components/post-sailing-archive.test.tsx` (the archived render reads only `EventDoc.archive`, with a live roster fixture that deliberately disagrees).
- The Event has an archived/read-only state with `archivedAt`, and the toggle is admin-only—`tests/rules/post-sailing-archive.test.ts` ("ALLOWS an admin to flip status…", "DENIES a Player archiving the Event", "DENIES an unauthenticated archive", "DENIES archiving without a numeric archivedAt stamp") + `src/components/post-sailing-archive.test.tsx` ("needs a second, explicit confirmation…").
- Rules deny gameplay writes on an archived Event, across every collection—`tests/rules/post-sailing-archive.test.ts` § "gameplay writes stop at the freeze" (eleven paired cases, each proving the SAME write succeeds while live and fails once frozen).
- The final Leaderboard and First-to-BINGO snapshot persists and renders read-only—`src/data/post-sailing-archive.test.ts` (the snapshot is copied, ranked, bounded and ban-aware) + `src/components/post-sailing-archive.test.tsx` ("offers no live controls—the archive is read-only").
- A future occasion is a new Event, not a reset (ADR 0003)—nothing in this ticket writes to another Event, resets a roster, or clears a subtree; the freeze is write-once and un-archiving is not a client operation.
- Stats stay client-authoritative; no server-side recompute is added (ADR 0001)—`src/data/post-sailing-archive.test.ts` ("takes each row straight off the Player-written stats, even when the per-Day buckets disagree"); `functions/**` is untouched.
- Absence still means open—`tests/rules/post-sailing-archive.test.ts` ("leaves an Event document that carries no status key OPEN"). Every Event document written before this ticket carries no `status` key, and a missing status that read as archived would freeze the whole estate on deploy.

## Test coverage

- `src/data/post-sailing-archive.test.ts` (Vitest unit)—`isEventArchived`'s literal comparison and its absent-means-open default; `buildEventArchive` copying Player-written stats verbatim when root totals and `dayStats` disagree; ranking an unsorted roster into Leaderboard order; bounding the retained rows while `playerCount` records the true size; the Tutorial-Day exclusion and the freeze cutoff on the headline honour; pinned-over-derived daily honours; and the ban rule—dropped from the standings, honour vacated rather than reassigned.
- `src/components/post-sailing-archive.test.tsx` (RTL/jsdom)—the archived Leaderboard rendering the frozen record while the live roster fixture says something else, the banner and hall of fame, the absence of the live filter row, the "Share final standings" affordance, the truncation footnote, the live fallback for an archived Event with no record and for a still-active Event; plus the Admin control's two-tap confirm, its cancel path, the roster it hands the write, and its retirement once frozen.
- `tests/rules/post-sailing-archive.test.ts` (rules emulator, Firestore + Storage)—the admin-only, shape-checked, write-once toggle; eleven paired gameplay cases covering Marks and Tally markers, Player rows and late joins, the daily honour, the reshuffle spend batch, Prompts and reports, Proofs and reports and owner deletes, Claims, Doubts, Hearts, Moments and retractions, and proof-media upload; and the three things the freeze deliberately leaves open—every read, every Admin moderation path, and an Event document carrying no `status` key.
- `tests/rules/membership-mark-batch-budget.test.ts`—re-anchored, not rewritten. Its #1079 preview now patches the arm's OPENING lines only, so the freeze clause rides through the preview untouched and the Mark/Echo access-budget proof keeps covering the arms as they actually ship.

## Recovery

Un-archiving is not a client operation, on purpose. If an Event is archived by mistake, the fix is an Admin-SDK or console edit—the same escape hatch the write-once day-meta honour and the immutable Moment already rely on, and the same trust boundary the Cloud Functions Admin SDK already sits on (it bypasses these rules). That is a deliberate trade: a mis-click costs an operator intervention, and the alternative costs the guarantee the whole feature exists to make.

## Residuals

- **A Player can still delete their own proof MEDIA from an archived Event.** The Firestore Proof document's owner-delete is denied, and the Admin takedown path is preserved, but the Storage delete arm is left ungated: it already spends its one `firestore.get()` on `isEventAdmin()`, and Storage Rules allow at most two Firestore accesses per evaluation—which the create/update arm now uses in full. The exposure is bounded and one-directional: it can remove media, never add it, and it cannot touch `EventDoc.archive`, which is what the archived Leaderboard and hall of fame actually render.
- **The `archive` payload is shape-checked only as a map.** Rules cannot iterate a list, so per-row validation of the standings is not expressible—the same stated residual `bannedUids` carries. The write-once clause is what bounds it: exactly one payload is ever accepted, from an Admin.
- **An Event marked `archived` with no record renders the live Leaderboard.** Not a state this app can produce (the write carries all three fields in one update), so a hand-edited document falls back rather than dead-ends. It is still read-only where it counts: the rules key on `status` alone.
