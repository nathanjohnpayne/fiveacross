---
spec_id: w2-ban-console
status: accepted
---

# w2-ban-console—the Admin ban console + presentational banned-content filter (#108)

#113 (`specs/w2-banned-uids.md`) landed the rules + type contract for the Admin ban: `EventDoc.bannedUids: string[]`, the `isAdmin`-gated event-doc write path (validated as a list, size-capped at 1000, disjoint from `admins`, accepting `arrayUnion`/`arrayRemove` partial updates), and the `eventConverter` default of `[]`. This ticket is the **client consumer**: the `banUser`/`unbanUser` writes, the Admin console control, and the presentational filter that hides a banned Player's content across every PUBLIC/player surface. It changes **no** rules and **no** types—it only consumes the #113 contract.

The approved design (human-decided): `bannedUids` is a **presentational, event-scoped hide/mute** (ADR 0004 Phase 0), **NOT hard access revocation**—a banned Player can still read and write; their content is simply filtered out of other Players' views. Server-authoritative enforcement (blocking a banned uid's reads/writes) is #43/#44 and is **explicitly out of scope**. A ban is a **moderation / dispute tool, NOT anti-cheat** (ADR 0001): there is no motivated cheater in the threat model, and the ban does not make marks trustworthy—it mutes disruptive or disputed content so the group's shared surfaces stay usable with no Admin awake.

## What already shipped (consumed, not rebuilt)

- `EventDoc.bannedUids: string[]` (`src/types.ts`, #113)—the required, presentational roster. **Unchanged here.**
- `firestore.rules`—the `isAdmin`-gated event-doc `bannedUids` write path (list / `<= 1000` / disjoint-from-`admins`, validating the resulting state so `arrayUnion`/`arrayRemove` partials are accepted). `users/{uid}` stays owner-only. **Unchanged here** (pinned by `tests/rules/w2-banned-uids.test.ts`).
- `eventConverter` defaults a missing/malformed `bannedUids` to `[]` (`src/data/converters.ts`, #113). **Unchanged here.**
- `isReportHidden` (`src/data/moderation.ts`)—the sibling ADR 0004 Phase 0 community auto-hide predicate this ticket mirrors.

## The change

- `src/data/moderation.ts`—a new **exported pure predicate** `isBanned(uid, bannedUids)`: `true` iff `uid` is a non-empty string and `bannedUids` is an array containing it. It **fails OPEN** exactly like `isReportHidden`—an empty, missing (event doc loading / fresh event), or malformed (non-array) roster filters **nothing**, and an absent owner uid is never "banned". It lives in this **Firestore-free, React-free** module so BOTH the read hooks AND the deal path apply the identical test; pure, so every boundary is unit-testable.
- `src/data/admin.ts`—`banUser(uid)` / `unbanUser(uid)`: `updateDoc(events/{EVENT_ID}, { bannedUids: arrayUnion(uid) })` and `arrayRemove(uid)`. The **partial-update shape is deliberate**—it touches ONLY `bannedUids`, so a ban never clobbers other event config (`claimMode`, `defaultTheme`, `settings`, `admins`), and it is exactly the shape the #113 rules accept (they validate the resulting field state, not the diff). It writes ONLY the event doc, never owner-only `users/{uid}`. Scoped by the module-level `EVENT_ID` like `setClaimMode`/`setEventTheme` (single-event app). **Signature note:** matching the established `data/admin.ts` write style (`confirmClaim`, `setClaimMode`, … all key off `EVENT_ID`), these take only `uid`—the event is implicit, not an explicit `eventId` parameter.
- `src/hooks/useData.ts`—a combined internal `useEventModeration(enabled)` reads BOTH `threshold` and `bannedUids` from ONE `useEventDoc()` subscription (so a consumer needing both opens one event-doc listener, not two), and re-exports `isBanned` (like `isReportHidden`). The public read hooks apply `isBanned` by the content's OWNER uid (see § Filtered surfaces). `useEventModeration(false)` opens no subscription, preserving the "pass null to open no subscription" contract of `useTally`/`useDoubts`.
- `src/data/api.ts`—`joinAndDeal` reads `bannedUids` from the SAME event-doc fetch it already makes for the threshold, and drops banned-author Prompts (`createdBy`) from the deal pool with the SAME `isBanned` predicate, **before** `dealBoard`—so a frozen card is dealt from the SAME pool a Player sees live (`useItems`), and the `MIN_POOL` thin-pool guard counts the ban-visible pool.
- `src/components/Admin.tsx`—a **Ban author / Unban author** control on every report-queue row (keyed on the content owner: a Proof's `uid`, a Prompt's `createdBy`), mirroring the hide/restore/delete controls, plus a **Banned players** roster listing with an **Unban** for each—so a Player with no queued content left is still reachable to unban. The label reflects the current banned state. Admin views stay **UNfiltered** (see § Admin reachability). *Re-housed by `admin-console-ia`*: the queue-row controls live in the Review queue (`src/components/admin/ReviewQueue.tsx`) and the roster is the Players detail at `/more/admin/players` (`src/components/admin/PlayersPanel.tsx`).
- `src/components/Leaderboard.tsx`—the presentational ban filter for the VIEW only (see § Leaderboard / first-bingo split).

## Filtered surfaces (every UID-bearing PUBLIC read)

A banned uid's content is filtered by its OWNER uid off every PUBLIC/player-facing read, mirroring `isReportHidden`. All of these are PUBLIC reads; the Admin views below are deliberately left UNfiltered.

- **Prompt pool + deal**—`useItems` (filter `createdBy`) and `joinAndDeal`'s deal pool (filter `createdBy`).
- **Proof Feed**—`useProofFeed` (filter `uid`); through it the merged `useFeed` inherits the filter on its proof side.
- **Per-item Proof lookup**—`useProofsForItemText` (filter `uid`)—the Tally sheet's public "Proof shown ✓" per-marker read.
- **Tally markers**—`useTally` (filter marker `uid`); the banned marker drops from both the who-list AND the derived `count`.
- **Moments**—`useMoments` (filter `uid`); the banned Player's broadcast beats drop from the Feed.
- **Doubts**—`useDoubts` (VIEWER-AWARE): a banned accuser's Doubts (`fromUid` banned) are hidden **everywhere**, themselves included. A Doubt against a banned **target** (`targetUid` banned) is hidden from **other** viewers—but NOT from the target themselves on their own board (see § The viewer's own content). `useDoubts` therefore takes the signed-in `viewerUid` (Board threads it for both the per-Square DoubtBadge and the TallySheet) and keeps a target-banned Doubt when `targetUid === viewerUid`.

### The viewer's own content is not filtered for themselves

A ban is presentational: it hides a Player's content from OTHERS, not from themselves. Two hooks carry this own-content exception:

- `useMyProofs`—the VIEWER'S OWN active Proofs (consumed only by the viewer's own Doubt-badge derivation) is deliberately **NOT** ban-filtered, so a banned viewer's own Proofs still answer Doubts against them in their own UI. The ban takes effect on the PUBLIC-facing reads (`useProofFeed`, `useProofsForItemText`) where OTHERS see that same content.
- `useDoubts`—the target-side ban filter is **viewer-aware** (Codex P2, PR #122 round 2): a banned Player viewing their OWN board must still **see and be able to answer** a Doubt raised against them, so a Doubt whose `targetUid === viewerUid` is kept even when the target is banned. Without this, the ban would silence accusations against a banned Player in their own UI—the opposite of the `useMyProofs` exception, which lets those same Proofs satisfy the Doubt. The accuser-side (`fromUid`) filter has no such exception: a banned accuser's own Doubts are hidden from everyone, because a Doubt is content aimed at others.

## Leaderboard / first-bingo split

`useLeaderboard()` is the SHARED roster read by BOTH the Leaderboard VIEW and Board's First-to-BINGO ceremony, and the two need OPPOSITE treatment of a ban:

- **Board's First-to-BINGO** determination must read the **RAW, UNFILTERED** roster. First to BINGO is a **factual historical event**—who crossed the line first already happened. If banning removed a Player from the roster Board reads, a later Player would **retroactively become "first to BINGO"**—rewriting history. That is not intended.
- **The Leaderboard VIEW** should hide a banned Player's row.

So `useLeaderboard()` stays **RAW**—it never reads `bannedUids`—and the presentational filter lives in the **Leaderboard component**: it filters banned Players out of the displayed rows and the Share Card, but computes the First-to-BINGO **pin identity from the RAW roster**. Consequence: if the first-to-BINGO holder is banned, their row is simply hidden and **no visible row wins the "1st BINGO" badge**—a later Player is never promoted. Board, reading the raw hook, is entirely unaffected.

The regression that pins this: banning the original first-bingo Player must NOT hand the badge to a later Player (the VIEW) while `useLeaderboard` still returns the banned Player (the raw source Board reads). A test that applied the filter to the shared source instead would fail both halves.

## Admin reachability—admin views stay UNfiltered

Only PUBLIC/player reads filter. The Admin console (`useAllItems`, `useReportedProofs`, `usePendingClaims`, and the queue rows derived from them) applies **no** ban filter, so a banned Player's Prompts and Proofs stay reachable there for review, moderation, and unban—the same reachability invariant `specs/w2-admin-console.md` establishes for the threshold auto-hide. The Banned players section additionally lists every banned uid so an Admin can unban even a Player whose content has all been deleted.

## System/sentinel authors are never bannable (the pool-nuke footgun)

Not every `createdBy` is a real player uid. `scripts/seed.mjs` seeds the default Prompt pool with `createdBy: 'seed'`—a **sentinel**, not a player—on every seeded Prompt (a content-hash-keyed upsert). Because the pool filter (`useItems`) and the deal path (`joinAndDeal`) now hide Prompts by `createdBy`, banning `'seed'` would hide the **entire default pool at once**, leaving new Players with a thin/empty board—a single mis-click could nuke the game (Codex P1, PR #122).

The fix is **defense in depth**, both layers, plus a recovery asymmetry:

- **UI**—`moderation.ts` owns `SYSTEM_AUTHOR_UIDS` (today `['seed']`) and `isSystemAuthor(uid)`. The Admin console's Ban control (`BanControl`) renders **nothing** for a system author, so a seeded Prompt offers no Ban button. Extend `SYSTEM_AUTHOR_UIDS` if any other non-uid system author is ever introduced.
- **Write guard**—`banUser(uid)` **refuses** a system author: it no-ops (resolves) rather than writing, so `'seed'` can **never** enter `bannedUids` even via a leaked or programmatic call. This protects the pool regardless of the UI.
- **Recovery asymmetry**—`unbanUser(uid)` is **deliberately NOT** gated: it removes **any** uid, including a sentinel. So an admin who banned `'seed'` on a pre-fix build (or by any other means) can always recover the pool via the Banned players section's Unban. `banUser` refuses to **ADD** a sentinel; `unbanUser` will **REMOVE** one.

The other filtered surfaces are **sentinel-clean** and need no such guard: Proofs, Tally markers, Moments, and Doubts are all authored by / keyed on real player uids (a Proof's `uid`, a marker's uid, a Moment's `uid`, a Doubt's `fromUid`/`targetUid`), never a sentinel. `'Anonymous'` is only a displayName fallback (`markerDisplayName`), never a `uid`/`createdBy`, so it is not a poisoning vector either. Only the Prompt `createdBy === 'seed'` case can poison the pool, and it is closed above.

## Fellow admins are never bannable (a doomed action)

`BanControl` also renders **no Ban button when the author is a fellow admin** (its `uid` is in the event's `admins`), for the same reason it excludes system authors—Codex P2, PR #122 round 2. #113's rules **reject** any resulting `bannedUids` that overlaps `admins` (`firestore.rules`: `!bannedUids.hasAny(admins)`, pinned by `tests/rules/w2-banned-uids.test.ts`), so a Ban on an admin-authored row could only ever fail with a permission error and give the admin no useful feedback. `Admin.tsx` reads `admins` from the same event doc it already reads `bannedUids` from and threads it into `BanControl`, which suppresses the Ban path when `isSystemAuthor(uid) || admins.includes(uid)`. No write-guard is needed for the admin case (unlike the sentinel case, which the rules would otherwise ACCEPT) because the rules already fail an admin-overlap ban closed server-side; the UI suppression is the primary fix so the admin never sees a doomed action.

## Presentational, bypassable by design (ADR 0004 Phase 0)

The doc is untouched by the filter: it is a client-side `.filter` computed from the shared `bannedUids`, so every honest client agrees and it works with no Admin online. It is **bypassable by design**—a client can patch its bundle to ignore the filter and still read the (rules-permitted) content. That is acceptable under the honor-system posture (ADR 0001). **Server-authoritative enforcement—blocking a banned uid's reads/writes—is #43/#44 and is explicitly NOT attempted here.** A reviewer who "hardens" this into a server access gate has jumped the ADR 0004 phase boundary.

## Claim → test

Basename-aligned to this spec (`specs/w2-ban-console.md` → `*w2-ban-console*` under `tests/**` or `src/**/*.test.*`, matched by `check_spec_test_alignment`).

### Data layer—the predicate + the write shape

Runner: `npm test` (Vitest). Test: `src/data/w2-ban-console.test.ts`.

- `isBanned` is true only for a uid on the roster; fails **open** on an empty, missing, or malformed (non-array) roster; is false for an absent (`undefined`/`null`/empty) owner uid.
- `banUser(uid)` calls `updateDoc` on `events/{EVENT_ID}` (exactly 3 path segments—the EVENT doc, not `users/{uid}` and not a subcollection) with a payload touching ONLY `bannedUids` via `arrayUnion(uid)`.
- `unbanUser(uid)` is the `arrayRemove(uid)` twin.
- `isSystemAuthor` flags the `'seed'` sentinel (and `SYSTEM_AUTHOR_UIDS` contains it), and is false for real player uids / absent uids.
- `banUser('seed')` **refuses**—no `updateDoc`, no `arrayUnion`—so a sentinel can never enter `bannedUids` (the pool-nuke guard).
- `unbanUser('seed')` **still** removes it (`arrayRemove('seed')`)—the recovery path is not gated (the ban/unban asymmetry).

### Read hooks—the presentational filter + the raw-roster pin

Runner: `npm test` (Vitest, jsdom). Test: `src/hooks/w2-ban-console.test.tsx`.

- `useItems` drops a Prompt whose `createdBy` is banned, keeps others, and filters nothing on an empty roster (fail-open).
- `useProofFeed` drops a banned author's Proof (by `uid`).
- `useTally` drops a banned marker from the who-list AND shrinks the derived `count`.
- `useMoments` drops a banned Player's Moments (by `uid`).
- `useDoubts` (viewer-aware): from ANOTHER viewer's board, a Doubt drops when either `fromUid` OR `targetUid` is banned; on the banned Player's OWN board (`viewerUid === targetUid`), a Doubt against THEM is kept (own-content exception) while their own accusations (`fromUid` banned) and Doubts against a DIFFERENT banned target stay hidden.
- `useProofsForItemText` (the public Tally-sheet read) drops a banned author's Proof.
- `useMyProofs` (the viewer's OWN content) is NOT ban-filtered—a banned viewer still sees their own Proofs.
- `useLeaderboard` returns the RAW roster INCLUDING a banned Player—the shared First-to-BINGO source stays raw (this assertion fails if the filter is moved into the hook).

### Component—the console control + the leaderboard view

Runner: `npm test` (Vitest, jsdom). Test: `src/components/w2-ban-console.test.tsx`.

- A queue Proof row offers **Ban author**; clicking calls `banUser(proof.uid)`.
- A banned author's row shows **Unban author** and STAYS reachable (admin views unfiltered); clicking calls `unbanUser(uid)`.
- A queue Prompt row's **Ban author** calls `banUser(createdBy)`.
- A **seeded Prompt** (`createdBy === 'seed'`) renders **NO** Ban control, while a real-player Prompt DOES—the system-author exclusion.
- A row authored by a **fellow admin** renders **NO** Ban control, while a normal-player row DOES—the admin-overlap exclusion (a ban that overlaps `admins` is rejected by the rules).
- The **Banned players** section lists banned uids and **Unban** calls `unbanUser(uid)`—reachable even with no queued content; empty when no one is banned.
- Leaderboard hides a banned Player from the view and does NOT promote a later Player to **1st BINGO** (the raw-source pin, VIEW half); a baseline without the ban shows the first-to-BINGO Player with the badge.

### Rules—consumed, not changed

Runner: `npm run test:rules` (Firestore emulator). Test: `tests/rules/w2-banned-uids.test.ts` (from #113, unchanged). The `banUser`/`unbanUser` `arrayUnion`/`arrayRemove` partial-update shape is exactly what that suite already accepts; this ticket adds no rules and needs no new rules test.

## Acceptance criteria

- `banUser`/`unbanUser` write `bannedUids` on the event doc via `arrayUnion`/`arrayRemove` (partial update, never clobbering other config, never touching `users/{uid}`)—`src/data/w2-ban-console.test.ts` (+ the shape the #113 `tests/rules/w2-banned-uids.test.ts` accepts).
- A banned uid's content is filtered off every PUBLIC read—pool/deal, Proof Feed, per-item Proof lookup, Tally, Moments, Doubts—by its owner uid; an empty/absent roster filters nothing (fail-open)—`src/hooks/w2-ban-console.test.tsx`.
- The viewer's own content is not filtered for themselves—`useMyProofs` is unfiltered, and `useDoubts` keeps a Doubt against the viewer when the viewer is a banned target (own-content exception), while still hiding a banned accuser's Doubts everywhere and a banned target's Doubts from other viewers—`src/hooks/w2-ban-console.test.tsx`.
- Board's First-to-BINGO reads the RAW roster (a ban never promotes a later Player), while the Leaderboard VIEW hides the banned Player—`src/hooks/w2-ban-console.test.tsx` (raw hook) + `src/components/w2-ban-console.test.tsx` (view + no-promotion).
- The Admin console bans/unbans from the report queue and a Banned players section, and admin views stay UNfiltered so banned content is reachable for review/unban—`src/components/w2-ban-console.test.tsx`.
- A system/sentinel author (`'seed'`) is never bannable—no UI Ban control and `banUser` refuses to add it—so the default pool cannot be nuked by a mis-click; `unbanUser` still removes a sentinel for recovery (the ban/unban asymmetry)—`src/data/w2-ban-console.test.ts` (guard + asymmetry) + `src/components/w2-ban-console.test.tsx` (no control on a seeded Prompt).
- A fellow admin is never bannable—`BanControl` renders no Ban control for an author in `admins` (a ban that overlaps `admins` is rejected by the #113 rules, so it is a doomed action)—`src/components/w2-ban-console.test.tsx` (no control on an admin-authored row).
- Presentational, bypassable by design; server-authoritative enforcement deferred to #43/#44; no rules or type change—this spec + no `firestore.rules`/`src/types.ts` diff.
