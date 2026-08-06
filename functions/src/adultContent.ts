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
export function isDealablePool(pool: unknown): boolean {
  return pool === undefined || pool === 'main';
}

/** Does this Prompt, as it now stands, make its Event 18+? */
export function itemImpliesAdultContent(item: Record<string, unknown> | undefined): boolean {
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
export function eventForcesAdultContent(event: Record<string, unknown> | undefined): boolean {
  const settings = event?.settings;
  return (
    typeof settings === 'object' &&
    settings !== null &&
    (settings as Record<string, unknown>).forceAdult === true
  );
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
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
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
 * remaining aliases — but the failures are COLLECTED and rethrown once the loop
 * is done, so the trigger fails and the platform retries it (Codex P2 on #615).
 * Swallowing them would acknowledge the trigger while an alias keeps serving the
 * un-gated sign-in shell for an Event that now has active explicit content, with
 * no guaranteed second attempt: the derived flag is a fail-closed security
 * posture, and "logged and forgotten" is not a fail direction it can afford.
 * Retrying is safe because the stamp is idempotent — the already-stamped
 * documents are skipped on the way through.
 *
 * Returns how many documents it stamped.
 */
export async function raiseAdultContentForEvent(db: AdultFirestore, eventId: string): Promise<number> {
  const snap = await db.collection('hostnames').where('eventId', '==', eventId).get();
  let stamped = 0;
  const failed: string[] = [];
  for (const d of snap.docs) {
    if (d.data()?.adultContent === true) continue; // already gated — monotone, nothing to do
    try {
      await db.doc(`hostnames/${d.id}`).update({ adultContent: true });
      stamped++;
    } catch (err) {
      console.error('raiseAdultContentForEvent: per-host stamp failed', eventId, d.id, err);
      failed.push(d.id);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `raiseAdultContentForEvent: ${failed.length} hostname document(s) for ${eventId} still serve ` +
        `an un-gated shell: ${failed.join(', ')}`,
    );
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
 * A Prompt write that leaves an ACTIVE, spicy, main-pool Prompt in the Event
 * gates that Event.
 *
 * The cheap predicate runs BEFORE any read, so the overwhelming majority of item
 * writes — tame Prompts, pending submissions, report-count bumps on non-spicy
 * rows, our own auto-hide's `status: 'hidden'` flip — cost nothing at all.
 *
 * THROWS on a failed stamp, deliberately parting company with the never-throw
 * discipline next door (Codex P2 on #615). `autohide.ts` swallows because it
 * shares an `onDocumentWritten` path with the #101 notifiers and must not take
 * them down. This is a DEDICATED trigger: nothing else rides it, the approval
 * write it reacts to has already committed, and a throw costs only a Cloud
 * Functions retry of an idempotent operation. Against that, swallowing would
 * leave a public fail-closed flag reading `false` on an Event with active
 * explicit content, with no second attempt — which is the failure this whole
 * module exists to prevent.
 */
export async function applyItemAdultContent(
  eventId: string,
  after: Record<string, unknown> | undefined,
  deps: AdultContentDeps = {},
): Promise<number> {
  if (!itemImpliesAdultContent(after)) return 0;
  return (deps.raiseAdultContent ?? defaultRaise)(eventId);
}

/**
 * An Event whose `settings.forceAdult` is on gates that Event.
 *
 * Fires on the after-state rather than on the false→true transition, for the
 * same retry reason as the item path: a crossing test would otherwise leave an
 * Event an admin explicitly marked adult serving an un-gated shell until the
 * flag was toggled off and on again. Admin config writes are rare, and the raise
 * skips already-stamped documents, so re-checking is nearly free.
 *
 * Throws on a failed stamp, for the platform retry — see `applyItemAdultContent`.
 */
export async function applyEventAdultContent(
  eventId: string,
  after: Record<string, unknown> | undefined,
  deps: AdultContentDeps = {},
): Promise<number> {
  if (!eventForcesAdultContent(after)) return 0;
  return (deps.raiseAdultContent ?? defaultRaise)(eventId);
}

// --- Routing-document reconciliation (Phase 4b round 3) -------------------------
//
// The two triggers above fire on ITEM and EVENT writes, which covers every way an
// Event can BECOME adult. It does not cover the other direction of the same
// invariant: a routing document that appears AFTER the Event is already adult.
//
// Two ways that happens, and neither has a qualifying source document left to
// change:
//
//   - An alias is added later — a second hostname for a running Event, which is
//     an ordinary operational act (ADR 0009 makes canonical and alias separate
//     records). Nothing writes an item or the Event doc, so nothing re-derives,
//     and the new host serves the un-gated shell indefinitely.
//   - A routing document is created CONCURRENTLY with a derivation run, after
//     that run's `hostnames` query snapshot was taken. The stamp writes the
//     documents it saw; this one was never in the result set.
//
// So the invariant is closed from the other side: when a routing document is
// written and is not already stamped, ask the Event whether it is adult.

/**
 * Is this Event adults-only RIGHT NOW, derived from source rather than from the
 * routing documents?
 *
 * The same rule the triggers apply — `settings.forceAdult || (any active spicy
 * Prompt in a dealable pool)` — but computed from scratch, because the caller is
 * a routing document that may have existed for milliseconds and carries no
 * history.
 *
 * The Prompt query filters on `spicy` ALONE and applies status/pool in code.
 * That is deliberate: a `status`+`spicy` query would need a composite index, and
 * a pool is 30–50 Prompts, so the whole spicy subset is a trivial read. One less
 * thing that can be forgotten in `firestore.indexes.json` and silently fail in
 * production.
 */
export async function eventIsAdult(db: AdultFirestore, eventId: string): Promise<boolean> {
  const eventSnap = await db.doc(`events/${eventId}`).get();
  if (eventSnap.exists && eventForcesAdultContent(eventSnap.data())) {
    return true;
  }
  const spicy = await db.collection(`events/${eventId}/items`).where('spicy', '==', true).get();
  return spicy.docs.some((d) => itemImpliesAdultContent(d.data()));
}

export interface HostnameReconcileDeps {
  /** Defaults to `eventIsAdult` against the admin SDK. */
  eventIsAdult?: (eventId: string) => Promise<boolean>;
  /** Defaults to stamping the one document. */
  stampHost?: (host: string) => Promise<void>;
}

async function defaultEventIsAdult(eventId: string): Promise<boolean> {
  return eventIsAdult(await adminFirestore(), eventId);
}

async function defaultStampHost(host: string): Promise<void> {
  await (await adminFirestore()).doc(`hostnames/${host}`).update({ adultContent: true });
}

/**
 * A routing document was written. If it is not already gated and its Event is
 * adult, stamp it.
 *
 * The cheap checks run first, so the overwhelming majority of writes to this
 * collection — including OUR OWN stamp, which re-fires this trigger — cost
 * nothing: an already-`true` document returns before any read, which is also the
 * loop guard. A document with no `eventId` routes nowhere and is skipped.
 *
 * THROWS on a failed stamp, like its siblings, so the platform retries an
 * idempotent operation rather than leaving a public fail-closed flag at `false`.
 */
export async function reconcileHostnameAdultContent(
  host: string,
  after: Record<string, unknown> | undefined,
  deps: HostnameReconcileDeps = {},
): Promise<boolean> {
  if (!after) return false; // deleted — nothing routes here any more
  if (after.adultContent === true) return false; // already gated (and our own write)
  const eventId = typeof after.eventId === 'string' ? after.eventId : '';
  if (!eventId) return false;
  if (!(await (deps.eventIsAdult ?? defaultEventIsAdult)(eventId))) return false;
  await (deps.stampHost ?? defaultStampHost)(host);
  return true;
}
