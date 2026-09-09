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
