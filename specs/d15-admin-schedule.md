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
- `firestore.rules` (`events/{eventId}` `allow create, update`)—a new clause, `daysThemeLockOk`, enforces the lock server-side: when the write carries `days` and a prior doc with its own `days` exists to compare against, every Day whose `theme` actually changed must have an EXISTING (pre-write) `unlockAt` still in the future (`request.time.toMillis() < oldDay.unlockAt`); a Day whose `unlockAt` has already passed denies the whole write if its `theme` changed. A `create` (no prior doc) or a legacy doc with no `days` yet has nothing to lock against and is unaffected—the same "resulting state, not diff" reasoning the existing Board/day-meta gates already use. Array-length mismatch between the incoming and existing `days` is rejected outright.

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
- `tests/rules/d15-admin-schedule.test.ts` (rules-emulator, time-gated against a fixed `request.time` via `PAST()`/`FUTURE()` helpers)—an admin CAN change `days[i].theme` for a Day with a future `unlockAt`; an admin CANNOT change `days[i].theme` for a Day whose `unlockAt` has passed; a non-admin can never write `days[]` at all, locked or unlocked Day, any field.
