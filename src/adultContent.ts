// The 18+ posture for THIS Event, resolved pre-auth (#608).
//
// The posture follows the Event's CONTENT, not its Edition. If the Event's pool
// holds explicit Prompts, the app wears the 18+ branding; otherwise it does not.
// A `fiveacross` Event with spicy Prompts is 18+ with general vocabulary; a
// `gcb` Event with a tame pool is not 18+ at all. The two axes are independent,
// which is why this lives here and not in `editions.ts` — an Edition is a
// product line, and this is a fact about one Event's pool.
//
// WHY IT CANNOT BE DERIVED ON THE CLIENT. `ItemDoc.spicy` lives at
// `events/{eventId}/items/{id}`, which requires `signedIn()`. The 18+
// acknowledgement is ON the sign-in gate — pre-auth — so the one client that
// needs the answer is the one client that can never read the source. This is
// the same shape as the Edition problem (ADR 0009) and it takes the same
// solution: a server-derived field on the world-readable `hostnames/{host}`
// document, fetched by the resolver before mount.
//
// Server-side derivation, monotone and OR'd with an Admin override:
//
//     adultContent = settings.forceAdult || (any active spicy item in a dealable pool)
//
// (see functions/src/adultContent.ts). `forceAdult` exists because `spicy` is a
// narrower flag than it looks: the seeded pool tags sexual explicitness
// specifically, so an Event whose only mature content is non-sexual — violence,
// drugs, self-harm — would derive `false` and show no gate. Rather than invent a
// content taxonomy, a human gets an escape hatch.
//
// MONOTONE. Once true it stays true for the Event's lifetime. Retracting the
// posture from Players who already attested is meaningless, and a flapping gate
// is worse than an over-broad one.

/**
 * FAIL DIRECTION: missing or malformed ⇒ `true`.
 *
 * Under-gating is the harmful direction; over-gating costs one checkbox. This
 * also makes every hostname document that predates #608 correct with no
 * backfill — an unstamped Gay Cruise Bingo host keeps exactly today's gate.
 */
export const ADULT_CONTENT_DEFAULT = true;

/**
 * Read an `adultContent` field off untrusted document data.
 *
 * Only a literal `false` turns the gate off. A missing field, a string
 * `"false"`, a `0`, a null — anything at all that is not the boolean — reads as
 * `true`. Shared by the network seam (`fetchHostnameDoc`) and the cache reader
 * (`readCache`) so the two paths can never disagree about the same bytes, the
 * discipline #576 established for `status`.
 */
export function coerceAdultContent(value: unknown): boolean {
  return value === false ? false : ADULT_CONTENT_DEFAULT;
}

/**
 * The resolved posture for this session — the only copy of it.
 *
 * Installed once by `bootstrapEventResolution`, BEFORE React mounts, exactly
 * like the resolved Edition. Read through the accessor, never captured at import
 * time: a module-level constant would freeze whatever was true before resolution
 * ran, which on a hostname-resolved build is "nothing has resolved yet".
 */
let currentAdultContent: boolean | null = null;

/** Whether this Event asks Players to acknowledge they are 18 or older.
 *
 *  Answers the fail-closed default until the resolver installs something, so a
 *  gate rendered before resolution (or in a build that never resolves) is the
 *  over-gating one. */
export function adultContentRequired(): boolean {
  return currentAdultContent ?? ADULT_CONTENT_DEFAULT;
}

/** Install the resolved posture. Anything but a literal `false` installs `true`,
 *  so a caller cannot widen the fail direction by passing through a malformed
 *  value it did not validate. */
export function setActiveAdultContent(adultContent: boolean | null | undefined): void {
  currentAdultContent = coerceAdultContent(adultContent);
}
