/**
 * Server-side derivation of an Event's 18+ posture (#608).
 *
 * The client that needs this answer is the one client that cannot compute it.
 * `ItemDoc.spicy` lives at `events/{eventId}/items/{id}`, which requires
 * `signedIn()`; the 18+ acknowledgement is ON the sign-in gate, pre-auth. So the
 * posture is derived HERE, by the admin SDK (which bypasses security rules), and
 * published onto the world-readable routing documents the resolver already
 * fetches before mount — `hostnames/{host}.adultContent` (ADR 0009's shape,
 * reused).
 *
 *     adultContent = settings.forceAdult || (any ACTIVE spicy Prompt in a dealable pool)
 *
 * MONOTONE. This module only ever writes `true`. Retracting the posture from
 * Players who already attested is meaningless, and a flapping gate is worse than
 * an over-broad one — so there is deliberately no lowering path, not even when
 * the last explicit Prompt is deleted. Un-gating an Event is a deliberate act
 * that belongs to an operator, not to a trigger.
 *
 * FAIL DIRECTION. Every read defaults toward `true` on the client
 * (`src/adultContent.ts` `coerceAdultContent`), so a derivation that never runs,
 * or that throws, leaves the Event GATED. Under-gating is the harmful direction;
 * over-gating costs one checkbox. That is also why this never needs a backfill:
 * every hostname document written before #608 has no `adultContent` field and
 * therefore already reads as `true`.
 *
 * IDEMPOTENT, not crossing-based. Unlike the auto-hide next door
 * (`autohide.ts`), the predicates here answer "does the AFTER state qualify?"
 * rather than "did this write CROSS?". A crossing test would make a swallowed
 * failure permanent: the item stays active-and-spicy, no later write is a fresh
 * crossing, and the Event stays un-gated forever. Answering on the after-state
 * means every subsequent write to that item is another attempt, and the raise
 * itself skips documents already at `true`, so the steady state costs one query
 * and no writes.
 *
 * The writes land on `hostnames/*`, never on `events/*` — so neither trigger can
 * re-fire itself, and no loop guard is needed.
 */

/** The subset of a Prompt this derivation reads. */
export interface AdultItemDoc {
  status?: string;
  spicy?: boolean;
  pool?: string;
}

/** The subset of an Event this derivation reads. */
export interface AdultEventDoc {
  settings?: { forceAdult?: unknown };
}

/**
 * Can a Prompt in this pool make the Event 18+?
 *
 * Only the dealable MAIN pool. The tutorial pools cannot hold explicit Prompts
 * by construction — `adminAddItem` forces `safeSpicy = pool === 'main' ? spicy :
 * false` (src/data/admin.ts) and the admin pool editor gates its 🔞 control on
 * `spicyAllowed = pool === 'main'` (src/components/admin/PromptPool.tsx) — so a
 * spicy embark/farewell item is a data anomaly, not a reason to gate an Event.
 *
 * A MISSING `pool` counts as main. `ItemDoc.pool` arrived with the Phase 1.5
 * pools (#207); items seeded before it have no field, and every one of them is a
 * main-game Prompt. Reading `undefined` as "not main" would leave exactly the
 * oldest explicit content un-gated, which is the wrong direction.
 */
export function isDealablePool(pool: string | undefined): boolean {
  return pool === undefined || pool === 'main';
}

/** Does this Prompt, as it now stands, make its Event 18+? */
export function itemImpliesAdultContent(item: AdultItemDoc | undefined): boolean {
  if (!item) return false; // deleted
  return item.status === 'active' && item.spicy === true && isDealablePool(item.pool);
}

/**
 * Does this Event's config force the 18+ posture on regardless of the pool?
 *
 * `spicy` is a narrower flag than its position suggests: the seeded pool tags
 * SEXUAL explicitness specifically — `Suite orgy` is spicy, `Domestic violence`
 * is not — so an Event whose only mature content is non-sexual would derive
 * `false` and show no gate at all. `settings.forceAdult` is the human escape
 * hatch for that case; ORing it in keeps the automatic path (which handles the
 * common case with no admin effort) while leaving a lever for the case the flag
 * cannot see. Strict `=== true`: a stray string or number does not gate.
 */
export function eventForcesAdultContent(event: AdultEventDoc | undefined): boolean {
  return event?.settings?.forceAdult === true;
}

// --- Admin-SDK Firestore surface (minimal, injectable) --------------------------
//
// Declared locally rather than imported from `autohide.ts`: that module's
// `DocRef` is read-only (`get()` alone), because its writes all go through a
// transaction. This one needs a plain `update`, and widening the shared
// interface would hand the auto-hide a write path it deliberately does not have.

interface AdultDocSnapshot {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}
interface AdultDocRef {
  update(data: Record<string, unknown>): Promise<unknown>;
}
interface AdultQueryRef {
  get(): Promise<{ docs: AdultDocSnapshot[] }>;
}
export interface AdultFirestore {
  doc(path: string): AdultDocRef;
  collection(path: string): { where(field: string, op: string, value: unknown): AdultQueryRef };
}

async function adminFirestore(): Promise<AdultFirestore> {
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore() as unknown as AdultFirestore;
}

/**
 * Stamp `adultContent: true` on every routing document that points at this
 * Event, skipping the ones already stamped.
 *
 * EVERY document, not just the canonical one: an Event's canonical address and
 * each of its aliases are separate `hostnames/{host}` records (ADR 0009), and a
 * Player arriving on an un-stamped alias would get the un-gated shell. The query
 * is a single-field `eventId ==` (auto-indexed, no composite index), and it runs
 * with the admin SDK, which is why it is allowed at all — the rule denies `list`
 * to every client precisely so the collection cannot become a directory.
 *
 * Each write is independently try/caught so one failure never abandons the
 * remaining aliases. Returns how many documents it stamped.
 */
export async function raiseAdultContentForEvent(db: AdultFirestore, eventId: string): Promise<number> {
  const snap = await db.collection('hostnames').where('eventId', '==', eventId).get();
  let stamped = 0;
  for (const d of snap.docs) {
    if (d.data()?.adultContent === true) continue; // already gated — monotone, nothing to do
    try {
      await db.doc(`hostnames/${d.id}`).update({ adultContent: true });
      stamped++;
    } catch (err) {
      console.error('raiseAdultContentForEvent: per-host stamp failed', eventId, d.id, err);
    }
  }
  return stamped;
}

export interface AdultContentDeps {
  /** Defaults to `raiseAdultContentForEvent` against the admin SDK. */
  raiseAdultContent?: (eventId: string) => Promise<number>;
}

async function defaultRaise(eventId: string): Promise<number> {
  return raiseAdultContentForEvent(await adminFirestore(), eventId);
}

/**
 * Best-effort: a Prompt write that leaves an ACTIVE, spicy, main-pool Prompt in
 * the Event gates that Event.
 *
 * The cheap predicate runs BEFORE any read, so the overwhelming majority of item
 * writes — tame Prompts, pending submissions, report-count bumps on non-spicy
 * rows, our own auto-hide's `status: 'hidden'` flip — cost nothing at all.
 * Never throws (ADR 0001): a failure here must not crash the pipeline the
 * approval flow and the moderation notifiers share.
 */
export async function applyItemAdultContent(
  eventId: string,
  after: AdultItemDoc | undefined,
  deps: AdultContentDeps = {},
): Promise<number> {
  try {
    if (!itemImpliesAdultContent(after)) return 0;
    return await (deps.raiseAdultContent ?? defaultRaise)(eventId);
  } catch (err) {
    console.error('applyItemAdultContent failed', eventId, err);
    return 0;
  }
}

/**
 * Best-effort: an Event whose `settings.forceAdult` is on gates that Event.
 *
 * Fires on the after-state rather than on the false→true transition, for the
 * same retry reason as the item path: a swallowed failure would otherwise leave
 * an Event an admin explicitly marked adult serving an un-gated shell until the
 * flag was toggled off and on again. Admin config writes are rare, and the raise
 * skips already-stamped documents, so re-checking is nearly free.
 */
export async function applyEventAdultContent(
  eventId: string,
  after: AdultEventDoc | undefined,
  deps: AdultContentDeps = {},
): Promise<number> {
  try {
    if (!eventForcesAdultContent(after)) return 0;
    return await (deps.raiseAdultContent ?? defaultRaise)(eventId);
  } catch (err) {
    console.error('applyEventAdultContent failed', eventId, err);
    return 0;
  }
}
