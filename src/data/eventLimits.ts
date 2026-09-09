// The numeric limits `firestore.rules` and the writers must agree about, stated
// once. THIS MODULE IMPORTS NOTHING, on purpose: it is the one place both the
// pure game layer (`src/game/logic.ts`) and the data layer (`src/data/**`) can
// read a shared bound from without either importing the other — `eventArchive`
// already imports `game/logic`, so the bound could not live on that side without
// a cycle (#1152, Codex P2 on PR #1165). Keep it dependency-free.

/**
 * The Event schedule ceiling shared by setup validation and runtime writers.
 * `daysThemeLockOk` (`firestore.rules`) unrolls its schedule lock over indexes
 * 0–9 only, so an eleventh Day is unsupported rather than merely undesirable.
 */
export const MAX_DAYS = 10;

/**
 * Is this a Day index the shared `DayDef` contract actually supports? (#1151,
 * Codex P2 on PR #1162.)
 *
 * `DayDef.index` is declared `0..9` (`src/domainTypes.d.ts`) and the ceiling
 * above says why that is a RULES FACT rather than a preference: `daysThemeLockOk`
 * unrolls the schedule lock over exactly ten array positions, so a Day at index
 * 10 sits outside the lock the moment it is written. Every other bound in the
 * estate keys off the same number, and this is the predicate that asks the
 * question of ONE index — `MAX_DAYS` bounds how many Days a schedule may have,
 * which is a different question about a different value.
 *
 * `Number.isInteger` was what the archive asked instead, and it is the wrong
 * question in three ways that all end in the same permanent record. `-1`, `10`
 * and `Number.MAX_SAFE_INTEGER + 2` are all integers by that test, none of them
 * names a Day, and each is the `days/{dayIndex}` path segment an honour pin is
 * addressed by — so a hand-edited, seeded or legacy schedule carrying one was
 * read as USABLE, an arbitrary meta path was fetched, and an `ArchivedDayHonor`
 * labelled `D0` or `D11` could be frozen into `dailyHonors`, where
 * `firestore.rules` cannot look inside a list to refuse it. The same integer can
 * arrive from the other side too, off a `dayStats` KEY: that map is
 * Player-written under ADR 0001 and its rules arm validates nothing, so a row can
 * name Day 4000 and the derived honour fallback would carry it.
 *
 * SAFE-INTEGER as well as ranged, stated rather than implied. The range bound
 * already refuses every unsafe value, because an unsafe integer is by definition
 * far outside `0..9`; asking both keeps the predicate correct on its own terms if
 * the range is ever widened, and says out loud which shapes the callers were
 * getting wrong.
 *
 * ONE PREDICATE, FOUR CALLERS, which is the whole point (#1151): the freeze's own
 * `usableDayIndexes` (`src/data/eventArchive.ts`, and through it `archiveEvent`'s
 * `schedule-unusable` refusal), the console's honour fan (`useDayMetasStatus`),
 * the honour selection every surface shares (`pinnedOrDerivedDailyHonors`) and
 * the record builder's own carried-honour filter. Stated once here, beside the
 * bound it is derived from, so no surface can invent a different answer to "is
 * this a Day?".
 */
export function supportedDayIndex(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value < MAX_DAYS
  );
}

/**
 * Refuse an oversized Event schedule before a writer performs any Firestore
 * reads or constructs a batch. Counting the supplied entries (rather than
 * unique values) is deliberately conservative: every entry can fan out into
 * another read or write in the calling operation.
 */
export function assertSupportedDayIndexes(
  dayIndexes: readonly number[] | undefined,
  operation: string,
): void {
  if (dayIndexes !== undefined && dayIndexes.length > MAX_DAYS) {
    throw new RangeError(
      `${operation} cannot process ${dayIndexes.length} Day indexes; the Event maximum is ${MAX_DAYS}.`,
    );
  }
}

/**
 * The magnitude `firestore.rules`' `finiteArchiveNumber` bounds every number in
 * the frozen record by, EXCLUSIVELY:
 * `value is number && value > -4102444800000 && value < 4102444800000`.
 *
 * 4102444800000 is 2100-01-01T00:00:00Z, the estate's stand-in for an
 * `isFinite()` Rules does not have — already used that way for
 * `standingsFreezeAt` and for the flip's own `archivedAt`. Restated here rather
 * than left implicit because the WRITER and the RULES have to agree about it:
 * see `MAX_ARCHIVE_NUMBER`. Exported for the writer's own pre-flight check
 * (`writableArchiveNumber`), which has to ask the rules' EXCLUSIVE question
 * rather than the clamp's inclusive one: a non-integer a hair under the bound
 * passes the rules and would fail a `<= MAX_ARCHIVE_NUMBER` restatement.
 */
export const ARCHIVE_NUMBER_BOUND = 4_102_444_800_000;

/**
 * The largest magnitude a ranking number may carry (#1151, Codex P1 on PR
 * #1162) — one below `firestore.rules`' exclusive bound, because the rules'
 * comparison is `<` rather than `<=`.
 *
 * THE WRITER AND THE RULES MUST SHARE ONE REPRESENTABLE-NUMBER CONTRACT, and
 * before this they did not. The archive's coercions kept ANY finite value, while
 * `finiteArchiveNumber` accepts only the bounded ones — so a Player self-writing
 * `bingoCount: 5e12` on their own row (`players/{uid}` validates no field at all,
 * ADR 0001) produced a record the rules REFUSED. That refusal lands on the flip,
 * which runs after `beginArchive` has already shut the Event, and a rejected
 * write throws past the refusal cleanup rather than returning one — so play was
 * closed, nothing was frozen, no automatic reopen ran, and every retry failed
 * identically until an admin found and repaired, banned or deleted that one row.
 *
 * Clamping rather than refusing, for the reason every other coercion clamps: the
 * record has to be expressible, and a value 40 times the age of the universe in
 * milliseconds is not a stat anybody is going to lose. It decides nothing about
 * who won (ADR 0001) — no real count or instant is within nine orders of
 * magnitude of this — it only keeps the row writable.
 *
 * AND IT BOUNDS THE LIVE ORDER TOO, which is why it lives here rather than in
 * `src/data/eventArchive.ts` (Codex P2 on PR #1165). The archive clamped and the
 * live ranking normaliser did not, so two rows above the bound could order one
 * way on the last live Leaderboard and another way in the frozen record — two
 * distinct oversized `bingoCount`s collapsing to a tie and then reordering on
 * squares, for instance — and the archived standings then no longer COPY what
 * Players last saw, which is the record's whole promise (ADR 0001). One bound,
 * both ranking paths.
 */
export const MAX_ARCHIVE_NUMBER = ARCHIVE_NUMBER_BOUND - 1;

/** A finite number brought inside `MAX_ARCHIVE_NUMBER` in both directions, so
 *  the value the writer produces is one `finiteArchiveNumber` accepts — and so
 *  the live ranking reads the same number the record will. */
export function clampArchiveNumber(value: number): number {
  return Math.min(MAX_ARCHIVE_NUMBER, Math.max(-MAX_ARCHIVE_NUMBER, value));
}
