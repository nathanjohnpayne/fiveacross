---
spec_id: w2-admin-console
status: accepted
---

# w2-admin-console—reactive auto-hide at reportHideThreshold (client Phase 0) + report queue

The Admin console already moderates Prompts, Proofs, and Claims, but the reactive auto-hide ADR 0004 defines was typed-but-dead: `EventDoc.settings.reportHideThreshold` shipped seeded (4, `scripts/seed.mjs`) yet no read path consulted it. This ticket makes it load-bearing. The public read hooks now exclude any Prompt or Proof whose `reportCount` has **reached** the threshold, so heavily-reported content self-hides on **every** client the moment the counter crosses—a community emergency-hide that works with **no Admin awake**. It also surfaces the report queue prominently in the console. Per ADR 0004 the Phase 0 hide is client-side / **presentational** and **bypassable by design**, NOT tamper-proof removal (that is Phase 1, #43). It supersedes the scaffold's read path, which only ever filtered Proofs on `status == 'active'`.

This ticket landed after #34, so the Feed is already the merged Proofs + Moments stream (`useFeed` composes `useProofFeed` + `useMoments`). The threshold filter is applied on the **proof side**—inside `useProofFeed`, the single chokepoint every proof flows through—so both the standalone proof stream and the merged Feed inherit it, while Moments (which carry no `reportCount`) are untouched.

## What already shipped (consumed, not rebuilt)

- `EventDoc.settings.reportHideThreshold: number` (`src/types.ts`)—the only settings key, seeded 4.
- `ItemDoc.reportCount` and `ProofDoc.reportCount` (`src/types.ts`), incremented by the report path.
- `firestore.rules`—a report is increment-only for non-admins (`reportCount == resource.data.reportCount + 1`, `hasOnly(['reportCount'])`) on both `items` and `proofs`; admins moderate freely; `settings.reportHideThreshold` must be a number when the event write carries `settings`. These are consumed as-is; **this ticket adds no rules**.
- `Admin.tsx` hides/restores/deletes Prompts and Proofs, resolves Claims, and shows the `reportCount ⚑` and `visionFlag` pills. `data/admin.ts` has `hideItem`/`restoreItem`/`deleteItem`, `hideProof`/`restoreProof`, `setClaimMode`/`setEventTheme`, `confirmClaim`/`rejectClaim`.
- The read hooks `useProofFeed`, `useItems`, `useAllItems`, `useReportedProofs`, `usePendingClaims`, `useEventDoc` (`src/hooks/useData.ts`).

## The change

- `src/data/moderation.ts` (the predicate's owner)—
  - `isReportHidden(reportCount, threshold)`—an **exported pure predicate**: `true` iff `threshold` is a number **strictly greater than 0** and `reportCount >= threshold` (at OR over, not just over). A missing/`undefined`, `0`, negative, `NaN`, or non-number threshold returns `false`—**no filtering** (see § Fail-open-unless-positive). It lives in this **Firestore-free, React-free** module so BOTH the read hooks below AND the deal path (`src/data/api.ts`, which must not import React) apply the identical test; pure so every boundary is unit-testable without a subscription.
- `src/hooks/useData.ts` (the read-hook owner)—
  - Imports `isReportHidden` from `src/data/moderation.ts` and **re-exports** it, so the existing importers (`Admin.tsx`, the hooks suite) keep importing it from here.
  - `useReportHideThreshold()`—an internal hook reading `settings.reportHideThreshold` from `useEventDoc()` (the ADR 0004 requirement that every client reads the SAME shared config), returning `number | undefined`.
  - `useProofFeed` and `useItems` now drop any row where `isReportHidden(reportCount, threshold)`. `useItems` keeps its existing `status == 'active'` filter and its `enabled` pool-gate (Codex P3, PR #66) unchanged; the threshold filter composes with them.
  - `useAllItems` and `useReportedProofs` stay **UNfiltered** by the threshold (their doc comments now say so explicitly)—the Admin reachability invariant below. `useReportedProofs` queues every Proof that is reported (`reportCount > 0`), `flagged`, **or hard-hidden** (`status == 'hidden'`)—see § The queue-membership rule.
- `src/data/api.ts`—`joinAndDeal` now reads the **event doc** (in the SAME `Promise.all` as the pool + profile—one extra read, join-path only, no added latency) for `reportHideThreshold` and drops community-hidden Prompts from the deal pool with the SAME `isReportHidden` predicate, **after** the `status == 'active'` query and the free-space drop. A frozen card is therefore dealt from the SAME pool a Player sees live (`useItems`)—see § The deal path honors the community hide.
- `src/data/admin.ts`—`clearItemReports(id)` / `clearProofReports(id)` reset `reportCount` to 0, the explicit admin lift for the community auto-hide (see § Lifting the community auto-hide).
- `src/components/Admin.tsx`—a **Report queue** surface. Reported Proofs (`useReportedProofs`) and reported Prompts (derived from the already-subscribed `useAllItems`, so no extra listener) are merged into **one list**. Each row keeps its per-kind hide / restore / delete controls, gains a **"Clear reports"** control when it is auto-hidden (the community-hide lift), and shows an **"auto-hidden"** pill (via the REAL predicate) marking exactly which rows the community hide has removed from every Player's Feed/pool. The full "Prompts" management list (now the Prompt-pool surface) gains the same pill. *Re-housed by `admin-console-ia`*: the queue is the Reports group of the merged Review queue at `/more/admin/queue`, ordered **oldest-first** (`createdAt` asc, uniform with the Approvals and Claims groups)—superseding this spec's original most-reported-first sort.
- `src/index.css`—a called-out `.admin-section.queue` and a `.pill-hidden` accent (coordinate-free additions).

## Presentational, bypassable by design (ADR 0004 Phase 0)

The doc is **untouched**: the hide is a client-side `.filter` computed from the shared `reportCount` and the shared `reportHideThreshold`, so every honest client computes the same result and it works with no Admin online. It is **bypassable by design**—a client can patch its own bundle to ignore the filter and still read the (rules-permitted, `status == 'active'`) Proof, or read the pool directly. That is acceptable under the honor-system posture (ADR 0001). **Tamper-proof removal—flipping `status` server-side at the threshold via a Cloud Function—is #43 and is explicitly NOT attempted here.** A reviewer who "hardens" the Phase 0 hide into a server write has jumped the ADR 0004 phase boundary.

Reports stay **increment-only and un-deduplicated** (one User can report repeatedly)—acceptable under ADR 0001; any de-dup hardening is a Phase 1 concern. `reportItem`/`reportProof` are untouched.

## Fail-open-unless-positive

An `undefined` threshold—the event doc still loading, or the setting simply unset—means **no filtering**, not "hide everything". So does a **non-positive** threshold: `0`, a negative number, or `NaN`. The filter is active **only when the threshold is a number strictly greater than 0**. The filter fails **open** because wrongly blanking the whole Feed/pool for every Player is worse than briefly showing a heavily-reported item, and the Admin report queue is the backstop either way.

The non-positive guard is load-bearing, not cosmetic (Codex P2, PR #107 finding 2): with a plain `reportCount >= threshold` test, a single admin typo of `0` (or any value `<= 0`) makes the predicate true for **all** content—`reportCount` is always `>= 0`—and blanks every Player's Feed and Prompt pool at once. `isReportHidden` requires `threshold > 0`, which also rejects `NaN` (`NaN > 0` is `false`) even though `typeof NaN === 'number'`. `isReportHidden(_, undefined) === isReportHidden(_, 0) === isReportHidden(_, -1) === isReportHidden(_, NaN) === false`, and the read hooks (and the deal path) treat all of these as "show everything".

## The deal path honors the community hide

The live pool (`useItems`) hides an over-threshold Prompt, but the **deal** path (`joinAndDeal`) originally queried only `status == 'active'`—so a new Player's frozen card could be dealt a Prompt the community has already hidden everywhere else, and (because the card is frozen at join, ADR 0003) it would sit hidden on that board with no way to swap it (Codex P2, PR #107 finding 1). `joinAndDeal` now reads the event doc for `reportHideThreshold` and filters the deal pool with the **same** `isReportHidden` predicate the hooks use, so the deal pool and the live pool agree.

The predicate is shared, not duplicated: it lives in the Firestore-free, React-free `src/data/moderation.ts` precisely so `api.ts` can import it without pulling in React (an `api.ts` → `useData.ts` import would).

The filter runs **before** `dealBoard`, which keeps the `MIN_POOL` thin-pool guard honest: `dealBoard` needs `>= 24` prompts, and it now counts the community-**visible** pool. A pool padded past the floor by heavily-reported Prompts still fails fast (the same `< MIN_POOL` throw, surfaced by Board's guard) rather than dealing a card whose squares vanish on first render. **Cost:** one extra event-doc read on the join path only (returning Players early-return before it), fetched in parallel with the pool and profile, so no added latency. A missing/unreadable event doc, or a non-positive/unset threshold, falls open to no filtering—exactly like the live pool.

## Lifting the community auto-hide

Restoring a hard-hidden row flips `status` back to `active` but leaves `reportCount` untouched—so a row that was BOTH hard-hidden and over the threshold stays community-hidden on every Player's Feed/pool after a restore, and a row that is auto-hidden but still `active` had **no** lift control at all (Codex P2, PR #107 finding 3). `data/admin.ts` gains `clearItemReports` / `clearProofReports` (reset `reportCount` to 0), and the queue renders a **"Clear reports"** control on any row the REAL predicate marks auto-hidden. Resetting the counter below the threshold is the one write that makes community-hidden content reappear in the player surfaces.

"Clear reports" is **distinct from** Restore: Restore lifts the `status` hard-hide, Clear reports lifts the community auto-hide, and a doubly-hidden row (hidden `status` AND over threshold) shows both so an Admin can fully lift it. The control appears exactly when there is a hide to lift—never on a below-threshold reported row. This is permitted because an admin `update` is rules-unconstrained on both `items` and `proofs` (`firestore.rules`: `allow update: if isAdmin(eventId) || ...`), so an admin write of `reportCount` is authorized; the rules suite pins it. This is the Phase-0 console affordance; server-authoritative removal/lift remains #43.

**The clear-then-restore ordering cannot orphan anything** (Codex P2, PR #107 round 2). On a doubly-hidden row the two lifts can be clicked in either order, and clearing FIRST leaves a `status: 'hidden'`, `reportCount: 0` row. For a Prompt that state was always reachable (`useAllItems` lists every Prompt). For a Proof there is **no all-proofs admin list**—the queue is the ONLY admin surface—so queue membership must not depend on the count alone. See § The queue-membership rule.

## The Admin reachability invariant

If `useAllItems` / `useReportedProofs` ALSO applied the threshold filter, a threshold-hidden row would vanish from the **console** too, and no Admin could ever reach it to restore or delete it—the exact failure ADR 0004 warns of. So the Admin views deliberately apply **neither** hide (not the `status` hard-hide, not the threshold auto-hide).

### The queue-membership rule

A Proof is queued when it needs admin attention: **reported** (`reportCount > 0`) OR **`flagged`** OR **hard-hidden** (`status == 'hidden'`)—hidden content belongs in the queue regardless of its count. The reported arm alone already covers every auto-hidden Proof (any count at/over a POSITIVE threshold is `> 0`—a strict superset), but the **hidden arm is load-bearing** (Codex P2, PR #107 round 2): clearing reports on a doubly-hidden Proof BEFORE restoring leaves `reportCount: 0`, `status: 'hidden'`, and without the hidden arm that Proof would satisfy no admin view at all—invisible on every Player surface (status), gone from the queue (count), with no all-proofs fallback—permanently unreachable from the UI. Prompts have the same membership in `Admin.tsx`'s `reportedItems` (`reportCount > 0 || status == 'hidden'`), backstopped by the full `useAllItems` list below the queue.

**Shape:** `useReportedProofs` subscribes to the whole proofs collection (no `where()`—the broad admin read the rules permit) and filters **client-side**, so the three-arm OR adds no second subscription and no composite index; it is one predicate over the existing listener. The Admin's Phase-0 overrides are the `status` hard-hide (`hideProof`/`hideItem`) and restore; the **Clear reports** control (`clearProofReports`/`clearItemReports`) that lifts the community auto-hide by zeroing `reportCount` (see § Lifting the community auto-hide); and deletion, which removes a row entirely. Server-authoritative removal/lift is still #43.

## Deferred: the Admin ban (→ a rules-owned follow-up)—LANDED by #113

At the time PR #107 shipped, the Admin ban #37 assumed had **no surface anywhere**—no `banned`/`bannedUids` field in `src/types.ts`, no ban write in `firestore.rules`, and `users/{uid}` owner-only—so this ticket **skipped** the ban rather than smuggle it into a feature-consumer PR (the #103 pattern: rules changes get their own reviewed PR). That deferral is now **resolved by #113**, which lands the rules + type contract in its own dedicated `needs-phase-4` PR: `bannedUids: string[]` on `EventDoc` (a presentational, event-scoped hide/mute roster per ADR 0004 Phase 0—**not** hard access revocation, which stays #43/#44), the admin-only write path + validation on the **event doc** (not a new write into owner-only `users/{uid}`), a converter default to `[]` for legacy/fresh event docs (the seed deliberately does **not** write `bannedUids`, so a reseed never clobbers a live ban list), and the full allow/deny rules matrix. The design and claim→test mapping live in [`specs/w2-banned-uids.md`](w2-banned-uids.md).

The client consumers **landed in #108** ([`specs/w2-ban-console.md`](w2-ban-console.md)): `banUser`/`unbanUser` in `data/admin.ts` (via `arrayUnion`/`arrayRemove`), a **Ban author / Unban author** control on each report-queue row **of this console** (plus a Banned players section), and the presentational banned-content filter in these same read hooks, mirroring the `isReportHidden` auto-hide. Admin views stay UNfiltered so banned content is reachable for review/unban. So the ban is no longer skipped—the report queue below now renders the ban control; the deferred-skip test this spec once pinned was flipped when #108 landed.

The pinned rules test below moved with #113: it now asserts the **new** reality—an Admin **can** set `bannedUids` on the event doc, and `users/{uid}` **stays owner-only** (the anti-schema-smuggling guarantee)—rather than the old blanket ban-surface denial.

## Claim → test

Basename-aligned to this spec (the checker matches `specs/w2-admin-console.md` → a `w2-admin-console.test.*` under `tests/**` or `src/**`); every claim maps to a real assertion driving the real code, only the SDK/data boundary mocked.

### Hooks—the presentational threshold hide

Runner: `npm test` (Vitest, jsdom). Test: `src/hooks/w2-admin-console.test.tsx`.

- `isReportHidden` hides **at** and **over** the threshold, shows **below** it, and fails **open** (returns `false`) on an `undefined` threshold.
- `isReportHidden` also fails **open** on a **non-positive** threshold—`0`, `-1`, and `NaN` all return `false` (fail-open-unless-positive, finding 2), so an admin `0` typo does not blank everything.
- `useProofFeed` drops a Proof whose `reportCount` is at/over `reportHideThreshold` and keeps below-threshold Proofs; with the threshold unset it filters nothing (a `reportCount: 99` Proof still renders); with the threshold `0` it also filters nothing (the Feed is not blanked).
- `useFeed` (the merged Feed) excludes an at/over-threshold Proof from its proof side while leaving Moments untouched—proving the single `useProofFeed` chokepoint covers the merged stream.
- `useItems` drops a Prompt at/over the threshold and keeps below-threshold Prompts.
- `useAllItems` and `useReportedProofs` **include** at/over-threshold content, so the Admin can reach it (the reachability invariant).
- `useReportedProofs` includes a **hard-hidden, zero-count** Proof (`status: 'hidden'`, `reportCount: 0`) and a `flagged` one, and still omits an active unreported one—the queue-membership rule (reported OR flagged OR hidden), so the clear-then-restore ordering can never orphan a hidden Proof (round 2).

### Deal path—the community hide reaches the frozen card (finding 1)

Runner: `npm test` (Vitest, jsdom). Test: `src/components/w1-board-deal-join.test.tsx` (the `joinAndDeal` harness, where the getDoc/getDocs/writeBatch mocks already live; reused rather than duplicated). The event doc is the 3rd `getDoc` call (board, profile, event).

- `joinAndDeal` **excludes** at/over-threshold Prompts from the deal so a frozen card never holds community-hidden content.
- The `MIN_POOL` guard counts the community-**visible** pool: 23 clean + 5 reported Prompts still throws `< MIN_POOL` (the reported rows do not pad the floor) and never persists a card.
- A **non-positive** threshold (`0`) deals the full pool—the deal path shares the fail-open-unless-positive rule (finding 2).
- An **unreadable** event doc falls open—the deal proceeds unfiltered rather than blocking.

### Component—the report queue

Runner: `npm test` (Vitest, jsdom). Test: `src/components/w2-admin-console.test.tsx`. Drives the REAL `Admin` with the data boundary stubbed; the REAL `isReportHidden` is kept via `importOriginal`, not re-implemented.

- A non-admin sees "Admins only." and no queue renders.
- The report queue lists a reported Proof with its `reportCount ⚑`.
- A threshold-hidden row is tagged **"auto-hidden"** and a below-threshold row is not—the REAL predicate at the `reportCount == threshold` boundary.
- **Restore reaches a threshold-hidden Proof**: a Proof both `status: 'hidden'` and over the threshold is reachable in the queue and its Restore control invokes `restoreProof(id)`; deletion invokes `deleteProof(id, storagePath)`.
- Reported Prompts surface in the queue; an unreported, active Prompt does not.
- **Clear reports lifts the community auto-hide** (finding 3): an auto-hidden-but-active Proof's Clear reports invokes `clearProofReports(id)`, and a Prompt's invokes `clearItemReports(id)`; a below-threshold reported row shows no Clear reports control (nothing to lift).
- **A hard-hidden zero-count Proof stays reachable** (round 2): the post-clear state (`status: 'hidden'`, `reportCount: 0`) renders in the queue with working Restore + Delete and shows neither the auto-hidden pill nor Clear reports (no community hide left to mark or lift).
- **The mixed queue orders by `reportCount` desc across kinds** (finding 4): a count-9 Prompt sorts above a count-5 Proof, and the count-5 rows tie-break by `createdAt` ascending—a heavily-reported Prompt never buries below a lightly-reported Proof.
- **The Ban author control renders** on a queue row (flipped from the old deferred-skip pin when #108 landed the ban console; its behaviour is pinned in depth by `src/components/w2-ban-console.test.tsx`).

### Rules—the moderation surface (no rules added; pins what exists)

Runner: `npm run test:rules` (Firestore emulator). Test: `tests/rules/w2-admin-console.test.ts`.

- A non-admin report increments `reportCount` by exactly 1 on a Prompt and a Proof; a jump (`+2`), a decrement, a bundled field change, and a `status` flip are each denied.
- An Admin moderates freely: hard-hide (`status`), restore, clear `reportCount` (lifting an auto-hide), and delete—Prompt and Proof.
- `reportHideThreshold` is admin-only, numeric config: an admin sets it, a non-admin is denied, and a non-numeric value is denied.
- **Ban surface is the event doc, users/{uid} stays owner-only** (#113): an Admin **can** set `bannedUids` on the event doc, and an Admin still **cannot** flag `banned` on a foreign `users/{uid}` doc (create and update both denied—the anti-schema-smuggling guarantee). The full ban allow/deny matrix (list/cap/`admins`-overlap validation, non-admin denial, `arrayUnion`/`arrayRemove` updates) lives in `tests/rules/w2-banned-uids.test.ts`—see [`specs/w2-banned-uids.md`](w2-banned-uids.md).

## Test-mock updates required by the surface change (stated honestly)

`useItems` now reads the threshold from `useEventDoc()`, so it opens a SECOND subscription—on the event **doc**—beside the pool **collection**. One existing suite moves with that:

- `src/hooks/useData.test.ts`—the Codex-P3 pool-gate assertions counted raw `onSnapshot` calls; they now count **collection** subscriptions specifically (`poolSubCount`), because the P3 concern is the heavy full-pool listener, not the tiny event-doc read Board already makes. No assertion is weakened—the gate still proves the pool listener is absent when `enabled` is false and present when true.

The Feed suite `src/components/w2-proof-capture-feed.test.tsx` is UNAFFECTED: it routes `onSnapshot` by target and delivers empty snapshots, so `useProofFeed`'s new event-doc subscription (a `doc`, never fired) leaves the threshold `undefined`—no filtering—and every proof-only assertion holds unchanged.

## Acceptance criteria

- Given a Proof whose `reportCount` reaches `event.settings.reportHideThreshold`, when any Player opens the Feed, then it is hidden on every client with no Admin action—`src/hooks/w2-admin-console.test.tsx` (`useProofFeed` + `useFeed` drop it) + `isReportHidden` boundary.
- Given that same threshold-hidden Proof, when an Admin opens the console, then it still appears in the report queue and can be restored or deleted—`src/components/w2-admin-console.test.tsx` (reachable + Restore/Delete invoke the writes) + `src/hooks/w2-admin-console.test.tsx` (`useReportedProofs` unfiltered).
- `useProofFeed` and `useItems` exclude content at/over `reportHideThreshold`; `useAllItems` / `useReportedProofs` do not—the hooks suite.
- Given a Prompt at/over `reportHideThreshold`, when a new Player joins, then it is excluded from their dealt card and the `MIN_POOL` guard counts only the visible pool—`src/components/w1-board-deal-join.test.tsx` (finding 1).
- Given a non-positive `reportHideThreshold` (`0`/`-1`/`NaN`), when any Player opens the Feed/pool or joins, then nothing is hidden—the app is never blanked by an admin typo—`isReportHidden` boundary + `useProofFeed` + the deal path (finding 2).
- Given a community-hidden row, when an Admin clicks **Clear reports**, then `reportCount` is reset to 0 and the content reappears in the player surfaces—`src/components/w2-admin-console.test.tsx` invokes `clearProofReports`/`clearItemReports`, the rules suite pins the admin `reportCount` write (finding 3).
- Given a hard-hidden Proof whose reports were cleared first (`status: 'hidden'`, `reportCount: 0`), when an Admin opens the console, then it is still in the queue with Restore and Delete—nothing is ever orphaned by the clear-then-restore ordering—the hooks suite (membership) + the component suite (controls) (round 2).
- The report queue is ONE list across Proofs and Prompts—the component suite (finding 4). *Ordering superseded by `admin-console-ia`*: OLDEST-FIRST (`createdAt` asc), uniform with the merged Review queue's other groups; the component suite pins the new order.
- Report queue surfaced in `Admin.tsx` via `useReportedProofs` (+ reported Prompts)—the component suite.
- Phase 0 hide documented as bypassable-by-design; server enforcement deferred to #43—this spec.
- The Admin ban rules + type contract landed in the dedicated #113 PR (`bannedUids` on the event doc; `users/{uid}` stays owner-only) and the client console control + presentational filter landed in #108 ([`specs/w2-ban-console.md`](w2-ban-console.md)); this console now renders the Ban author control on each queue row—this spec's § Deferred + the component suite's Ban-author assertion + the rules suites (`tests/rules/w2-banned-uids.test.ts`, and the pinned event-doc-ban / owner-only assertion in `tests/rules/w2-admin-console.test.ts`).
