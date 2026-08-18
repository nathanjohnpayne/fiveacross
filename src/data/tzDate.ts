/**
 * The calendar-date-in-a-timezone primitive.
 *
 * Extracted from `components/dayIdentity.tsx` (which re-exports it, so every
 * existing import keeps working) because it is a pure date function with no
 * React in it, and `draftValidation.ts` — which declares no Firebase, no React
 * — needs the SAME conversion the header uses. Restating the arithmetic there
 * would be a second answer to "what calendar day is this instant on", and the
 * whole point of the launch gates is that they agree with the consumers by
 * construction rather than by two careful re-implementations.
 */

/**
 * Today's calendar date as 'YYYY-MM-DD' in the given IANA timezone. en-CA is
 * the locale whose date format IS the ISO string, so the result compares
 * lexicographically against `DayDef.date`. An invalid timezone degrades to the
 * host zone rather than throwing — a hand-edited Event doc must never blank
 * the header.
 */
export function isoDateInTz(now: number, timeZone: string): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone }).format(new Date(now));
  } catch {
    return new Intl.DateTimeFormat('en-CA', opts).format(new Date(now));
  }
}
