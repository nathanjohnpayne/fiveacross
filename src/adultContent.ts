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
 * THE ONE RULE, and everything below is a consequence of it:
 *
 *     A GATED posture may be ASSUMED. An UNGATED posture must be PROVEN.
 *
 * Both directions of every decision in this feature fall out of it. A cached
 * `false` may not short-circuit resolution, because it is a claim that has to be
 * re-proven (`eventResolution.ts` step 1). A revalidation that FAILS resolves to
 * gated, because "we could not ask" is not proof. A single-Event build may bake
 * `VITE_ADULT_CONTENT=false`, but that seed only survives until a live read
 * either confirms it or fails to. And once a server read has said `true`, this
 * session never goes back — see `sessionRaised` below.
 *
 * The rule exists because the two errors are not symmetric. Over-gating costs a
 * player one checkbox they did not need. Under-gating shows explicit content to
 * someone who was never asked, which is the harm the acknowledgement exists to
 * prevent, and it cannot be undone after the fact.
 */

/**
 * The resolved posture for this session.
 *
 * Seeded by `bootstrapEventResolution` BEFORE React mounts, exactly like the
 * resolved Edition — but unlike the Edition it does NOT stop there. The Event's
 * pool can turn adult while a tab is open (an admin approves the first explicit
 * Prompt), and a tab that resolved once at launch would serve the rest of that
 * session ungated. So this is a REACTIVE store: `revalidateAdultContent`
 * installs fresh answers, and subscribers re-render.
 */
let currentAdultContent: boolean | null = null;

/**
 * Has a live read said `true` at any point in this session?
 *
 * The Event's flag is monotone on the server, and this is the client-side
 * mirror of that. Without it, revalidation would be a channel for UN-gating an
 * Event that has already turned adult: one read served from a stale edge, one
 * malformed response, one lost race between two in-flight polls, and a session
 * that had already been told `true` would go back to showing no gate.
 *
 * A latch, not a lock: it only ever refuses to lower. The gate can still be
 * lifted by the ONE transition that is safe — from the provisional gated
 * posture we assume when we have not yet proven otherwise — because that is
 * resolving uncertainty rather than retracting a posture.
 */
let sessionRaised = false;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Whether this Event asks Players to acknowledge they are 18 or older.
 *
 *  Answers the fail-closed default until something is installed, so a gate
 *  rendered before resolution — or in a build that never resolves — is the
 *  over-gating one. */
export function adultContentRequired(): boolean {
  return currentAdultContent ?? ADULT_CONTENT_DEFAULT;
}

/**
 * Subscribe to posture changes. Returns an unsubscribe.
 *
 * The React seam (`useAdultContent`) is built on this rather than on a context
 * because the posture is resolved before React exists and is read from
 * non-component code (`AuthContext`'s callbacks, the flip confirm's guard). One
 * store, two readers.
 */
export function subscribeAdultContent(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Install a posture.
 *
 * `proven` distinguishes the two kinds of `false` and is the whole reason this
 * takes a second argument. An UNPROVEN `false` — a build-time seed, a cached
 * entry — is provisional: it may paint the first frame, but it is not allowed
 * to survive a failed attempt to confirm it. A PROVEN `false` came from a live
 * server read of `hostnames/{host}` and stands until something raises it.
 *
 * Raising to `true` is always accepted and always latches. Lowering to `false`
 * is refused once the session has been raised.
 */
export function setActiveAdultContent(
  adultContent: boolean | null | undefined,
  { proven = false }: { proven?: boolean } = {},
): void {
  const next = coerceAdultContent(adultContent);
  if (next) {
    if (proven) sessionRaised = true;
    if (currentAdultContent !== true) {
      currentAdultContent = true;
      emit();
    }
    return;
  }
  // Ungating. Refused outright once a live read has said `true` — the monotone
  // latch — and otherwise accepted.
  if (sessionRaised) return;
  if (currentAdultContent !== false) {
    currentAdultContent = false;
    emit();
  }
}

/** Whether a live read has raised this session's posture. Exported for tests and
 *  for the revalidator, which stops polling once the answer can no longer
 *  change: the flag is monotone, so `true` is terminal. */
export function adultContentSettledAdult(): boolean {
  return sessionRaised;
}

/** Test seam: forget everything, including the latch. Production code never
 *  calls this — a session that has been raised stays raised. */
export function resetAdultContentForTests(): void {
  currentAdultContent = null;
  sessionRaised = false;
  listeners.clear();
}

