/**
 * The Event schedule ceiling shared by setup validation and runtime writers.
 * `daysThemeLockOk` (`firestore.rules`) unrolls its schedule lock over indexes
 * 0–9 only, so an eleventh Day is unsupported rather than merely undesirable.
 */
export const MAX_DAYS = 10;

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
