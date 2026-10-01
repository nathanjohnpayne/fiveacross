---
spec_id: d15-admin-schedule
status: accepted
---

# d15-admin-schedule—Admin Schedule editor: ten Days as rows, theme dropdown, locked once unlocked

> **Vocabulary note (#565/#566):** this spec's persisted-contract language was updated for the neutral vocabulary — Day/Event fields `place`/`placeEmoji` and `startsOn`/`endsOn` (legacy `port`/`portEmoji`, `sailStart`/`sailEnd` coerced on read by `eventConverter`), and Pool values `easy`/`closing` (both live Events still PERSIST the legacy `embark`/`farewell` spellings; reads normalize via `migratePool`/`normalizePool`, rules accept both, and writes keep emitting the legacy values until the post-Event cleanup).


Implements `plans/daily-cards-spec.md` § "Admin console" (the Schedule editor) and the admin-editability promise in § "Itinerary and schedule" ("the schedule stays admin-editable in the Admin console anyway"). The ten-Day mapping (`EventDoc.days[]`) is seeded once by `d15-tutorial-seed`, but party order can shift mid-Event and a future Event needs its own mapping—this ticket gives admins a rows-per-Day editor for date, port, and theme, with the one write-time rule the spec asks for: a Day's theme is editable while it is still locked-future, and locked once that Day has unlocked.

Depends on #200 (`d15-schema-contract`, the `EventDoc.days: DayDef[]` shape this ticket edits) and #201 (`d15-firestore-rules`, the rules baseline this ticket's Day-theme lock extends).

## What already shipped (consumed, not rebuilt)

- `EventDoc.days: DayDef[]` (`{ index, date, place, placeEmoji, theme, pool, tutorial, unlockAt, freeText?, snapshotItemIds? }`), `src/types.ts` (#200).
- The Admin console's Moderation/Approvals sub-navigation (`src/components/Admin.tsx`, #210)—a local `useState` toggle, untouched by this ticket except for a new sibling tab.
- `themesForEditionIncluding(day.theme)` (`src/theme/themes.ts`)—the Themes pickable on this build's Edition, plus the Day's current Theme if that one is off-Edition, with label/emoji, for the Schedule tab's theme `<select>` options. **Not the raw `THEMES` registry and not a fixed count**—see [`specs/w1-themes.md`](w1-themes.md) § Registry vs. picker (#555). The registry spans every Edition, so rendering it would let an Admin set another Edition's Theme on a Day; the `…Including` variant exists because a `<select>` whose value matches no option renders the first one instead of what is stored.

## The change

- `src/components/Admin.tsx`—a "Schedule" surface: ten rows (`ScheduleRow`), one per seeded Day, each showing `Day {n} · {date} · {placeEmoji} {place}` (read-only context) and a theme `<select>` populated from the Edition-scoped pick list above. The dropdown is `disabled` when `day.unlockAt <= now` (already past or already unlocked), enabled otherwise. Scoped to `theme` only—date and port are display-only, and there is no row add/remove (`days[]` length is fixed at seed). *Re-housed by `admin-console-ia`*: originally a sub-tab, now the Schedule detail at `/more/admin/schedule` (`src/components/admin/SchedulePanel.tsx`)—rows, locks, and the Unlock-now/Re-snapshot row anchoring unchanged.
- `src/data/admin.ts`—`setDayTheme(days, dayIndex, theme)`: a targeted array-ELEMENT update expressed as a whole-array write. Firestore's `updateDoc` cannot address one array element by dot-path (`days.0.theme` would target a map key, not an array index), so this takes the caller's already-subscribed `days` array, replaces only the entry at `dayIndex`, and writes back `{ days }` alone—every other event field (`claimMode`, `defaultTheme`, `admins`, `settings`, `bannedUids`) and every other Day's entry stay untouched.
- `firestore.rules` (`events/{eventId}` `allow create, update`)—a new clause, `daysThemeLockOk`, enforces the lock server-side: when the write carries `days` and a prior doc with its own `days` exists to compare against, every Day whose `theme` actually changed must have an EXISTING (pre-write) `unlockAt` still in the future (`request.time.toMillis() < oldDay.unlockAt`); a Day whose `unlockAt` has already passed denies the whole write if its `theme` changed. A `create` (no prior doc) or a legacy doc with no `days` yet has nothing to lock against and is unaffected—the same "resulting state, not diff" reasoning the existing Board/day-meta gates already use. Array-length mismatch between the incoming and existing `days` is rejected outright. Because an edit resends the whole array, an entry that is equal on both sides short-circuits before the per-field checks; each generally changed Day shares one pass for scoring validation, metadata shape and the unlock lock rather than triggering a second ten-Day scoring traversal. The production-shaped all-ten-Days theme setup has a narrower fast path: both arrays must contain exactly ten Days, every old Day must still be future, and each per-Day map diff may affect only `theme`. That proves scoring, Tonight metadata and every other locked field carried through unchanged while avoiding the complete-map comparisons that otherwise cross Firestore's 1000-expression limit.

## Schedules longer than ten Days: the two-Day edit window (#1357)

`daysThemeLockOk` names Day indexes 0–9 and nothing after—rules have no loop, and the Event arm sits at Firestore's 1000-expression cap, so the unroll cannot simply grow. Before #1357 a longer schedule therefore had Days 10+ outside the lock entirely: an admin could move an unlocked Day's `unlockAt`, change its theme or Tonight lines, or flip its `scoring`. The platform ceiling (`MAX_DAYS`, `src/data/eventLimits.ts`) was 10 for that reason alone.

A long schedule now changes only through a declared **edit window**. The write carries `scheduleEditFrom: k` beside `days`, and `scheduleEditWindowOk` requires:

- `k` is an integer with `0 <= k` and `k + 2 <= days.size()`, and the array length is unchanged;
- every Day outside `[k, k + 2)` is identical, proved by two list-slice comparisons (`days[0:k]`, `days[k + 2:n]`)—a list `==` is one expression however long the list, so the cost does not grow with the schedule (measured on the emulator against a 2000-entry list);
- both Days inside the window pass the same per-Day lock as the unroll (`dayThemeChangeOk`: scoring shape, Tonight shape, and locked-once-unlocked).

**The boundary guards are load-bearing.** An empty slice errors in the rules runtime and denies the write—`days[0:0] == days[0:0]` and even `days[0:0].size() == 0` both fail—so a window at the start (`k == 0`) or the end (`k + 2 == n`) skips the comparison on its empty side instead of making it. A wrong `k` cannot widen anything: it only moves which two Days may differ, and both still pay the full lock.

The window is the last alternative in the `days` clause, so no write the existing paths allow pays for it. `daysThemeLockOk` itself now refuses a schedule longer than ten Days rather than checking only its first ten. Two more consequences of the unroll stopping at Day 9:

- **Long schedules are born by script.** The standalone `daysScoringValid` check (for a doc with no prior `days`) refuses a long schedule, so the Admin SDK seed, which bypasses rules, is how one is created. The setup wizard keeps a ten-Day ceiling (`draftValidation`'s `MAX_DAYS`) for this reason.
- **Long schedules state their freeze at seed time.** `firstDerivedFreezeAt` cannot see a ceremonial Day past index 9, so a client may not add `standingsFreezeAt` to a long schedule that has none; the seed sets it.

The console's two schedule writers (`setDayTheme`, `setDayTonight`) each change one Day, and send `scheduleEditFrom` (via `scheduleEditFromFor`) only when the schedule is longer than `UNROLLED_SCHEDULE_LOCK_DAYS`. Editing the last Day opens the window one Day earlier, so it fits. A short schedule's writes and doc shape are unchanged. `MAX_DAYS` is now 20—room for a sixteen-week semester plus slack—bounded by the per-Day fan-out (honour reads, the archive's `dailyHonors` bound, which `firestore.rules` restates as a literal) rather than by the lock. A single Mark echoing onto all 20 Boards in one batch still commits (`tests/rules/membership-mark-batch-budget.test.ts`).

## Why the lock is server-side, not just a disabled control

A disabled `<select>` is a UI courtesy—it stops an admin from *fat-fingering* a stale Day's theme through the app, but a direct-SDK write (or a stale/rebuilt client) can still submit any payload it likes. The rule is what actually holds the guarantee: "changing an already-unlocked Day is disallowed" is a security-relevant, not merely presentational, invariant—once a Day's Card has been dealt from its snapshot at `unlockAt`, its `theme` needs to stay pinned for that Day's chrome/board consistency, matching what players already saw. Changing a **future** Day's theme stays explicitly SAFE (the lock is one-directional, past/unlocked → frozen, never "the whole schedule is read-only after seed").

## Acceptance criteria

- Given a Day whose `unlockAt` is in the future, when an admin picks a different theme from its row's dropdown, then the write commits and the Day's `theme` updates (rules: `daysThemeLockOk` allows it; UI: the dropdown is enabled).
- Given a Day whose `unlockAt` has passed, when an admin views its row, then the theme dropdown is disabled; a direct rules-bypassing write attempt (a hand-built `updateDoc` with only that Day's `theme` changed) is denied server-side too.
- Given the Schedule tab, when it loads, then it shows exactly the seeded Days in order, one row per Day.
- The theme lock holds both client-side (disabled control) and server-side (rules)—pinned by the component test (client) and the rules-emulator test (server), respectively.
- Editing a locked-future Day's theme never touches any other `EventDoc.days[]` entry or event field—`setDayTheme` maps over the full array and replaces only the targeted index's `theme` key.

## Test coverage

- `src/components/Admin.test.tsx` (extend, RTL-jsdom)—the Schedule tab renders one row per seeded Day; a future Day's theme dropdown is enabled and calling its `onChange` invokes `setDayTheme` with the full `days` array, the target `dayIndex`, and the new theme; a past/unlocked Day's dropdown is `disabled`.
- `tests/rules/d15-admin-schedule.test.ts` (rules-emulator, time-gated against a fixed `request.time` via `PAST()`/`FUTURE()` helpers)—an admin CAN change `days[i].theme` for a Day with a future `unlockAt`; an admin CANNOT change `days[i].theme` for a Day whose `unlockAt` has passed; a non-admin can never write `days[]` at all, locked or unlocked Day, any field; and the full ten-Day coverage includes one changed Day, all ten future Days changed together, and a locked-Day denial.
- `tests/rules/d15-admin-schedule.test.ts` § long schedules (#1357)—on a sixteen-Day schedule: a future Day changes through a covering window, both Days of one window may change, the first-Day (`k == 0`) and last-Day (`k + 2 == n`) windows pass their empty-slice guards; a change with no window, outside the window, or across two Days no window covers is denied; a malformed window start (negative, past the end, string, fractional) is denied; the regression that an unlocked Day past index 9 is now locked (unlock move, theme, scoring); an unlocked Day inside an otherwise-legal window is denied; growing or shrinking the schedule is denied; untouched-schedule writes and non-admin denial are unchanged; and adding a stated freeze to a long schedule without one is denied. `src/data/schedule-writeback-raw.test.ts` pins the writers' marker (window at the edited Day, pulled back one for the last Day, absent on a short schedule) and `src/data/eventLimits.test.ts` the limits.
