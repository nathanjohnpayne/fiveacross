/**
 * The Event-draft store seam (specs/event-setup-wizard.md § Draft lifecycle).
 *
 * Drafts are DEVICE-LOCAL today (#786 Decision 1): `EventDoc.status` admits
 * only `active`/`archived`, there is no draft collection, and a client cannot
 * bootstrap its own Admin grant, so a server-side draft would either fail
 * `firestore.rules` or publish a malformed Event (#785). The frames label the
 * affordance "Save draft (local)" for exactly that reason.
 *
 * This module models the SEAM, not two backends. `EventDraftStore` is the one
 * interface the wizard talks to; `createLocalDraftStore` is its only
 * implementation. The interface is asynchronous even though localStorage is
 * not, because that is the whole point of a seam: a server draft model is
 * necessarily async, and a synchronous interface would have to be rewritten at
 * every call site the day the owner rules the other way.
 *
 * Pure: no Firebase, no React, no network. Storage is injectable so a
 * round-trip runs in a unit test.
 */

import type {
  DraftCuratedPrompt,
  DraftDayDef,
  DraftMainPrompt,
  DraftPromptPools,
  EventDraft,
  EventDraftSettings,
  SetupStep,
} from '../types';

/**
 * Bumped when the stored shape changes. A blob written by another version
 * reads as a MISS (`null`), never as a mis-shaped draft — the ADR 0009 cache
 * convention `eventResolution.CACHE_VERSION` and `CardSnapshot.v` both follow.
 *
 * This is the forward-migration lever the ticket asks for. `DayDef.scoring` /
 * `EventDoc.standingsFreezeAt` landed on the shared contract in #551, but the
 * draft does not author them yet; when it grows them, bumping this retires
 * every draft written without them rather than resuming a half-shaped one at
 * Step 5.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/**
 * One localStorage key per draft. The `gcb:` prefix matches the established
 * storage namespace (`gcb:card-snapshot:…`) — it is a key namespace, not
 * branding, and a second prefix would fragment the origin's storage for no
 * gain.
 *
 * The key deliberately carries NO schema version. Versioning the key would
 * make a bump orphan every existing draft: `list()` would stop matching them
 * and `discard()` could never reach them, so they would sit in localStorage
 * forever — and the version check in `parseEventDraft` would be reduced to a
 * guard against hand-edited blobs rather than the migration path it claims to
 * be. With one stable namespace, a version bump makes a stale draft read as a
 * miss AND leaves it REACHABLE — which matters because nothing is reclaimed
 * automatically (see `list`): `discard()` must still be able to reach it.
 */
const KEY_PREFIX = 'gcb:event-draft:';

/**
 * Fields a draft MUST NOT carry. A draft never holds a claimed slug (PRD
 * § Event creation flow): the transactional claim happens once, at launch, in
 * the provisioner. A stored blob carrying any of these was not written by this
 * flow, so it reads as a miss rather than being repaired — repairing it would
 * mean deciding which half of a contradictory record to believe.
 */
const FORBIDDEN_KEYS = ['slug', 'eventId', 'hostname'] as const;

const SETUP_STEPS: readonly SetupStep[] = ['occasion', 'basics', 'squares', 'look', 'launch'];

/** A draft's list-row slice — enough for a "Resume draft" list without
 *  deserializing and validating every stored draft in full. */
export interface EventDraftSummary {
  draftId: string;
  name: string;
  step: SetupStep;
  updatedAt: number;
}

/**
 * The one interface the wizard talks to. Every method is async so that the
 * device-local implementation and a future server-backed one are substitutable
 * without touching a single call site.
 */
export interface EventDraftStore {
  /** Every readable draft on this device, most recently updated first.
   *  Unreadable blobs are skipped, never thrown — and never deleted: listing
   *  is a read, and no read in this module destroys storage. */
  list(): Promise<EventDraftSummary[]>;
  /**
   * Storage-key suffixes for entries `list()` cannot show: unparseable,
   * version-drifted, or key/id-mismatched blobs. Each returned suffix is a
   * valid `discard(id)` argument — `discard` builds the exact same key from
   * it — so this is the discovery path a caller needs before it can clean
   * one of these up at all: `list()` deliberately never reclaims them (see
   * its own doc), so without a way to NAME a hidden blob, `discard()`'s
   * `draftId` parameter has nothing to call it with, and stale entries from
   * an old `DRAFT_SCHEMA_VERSION` accumulate toward the storage quota
   * forever (#814).
   *
   * Read-only, exactly like `list()`: it enumerates and deletes nothing.
   * Surfacing a hidden entry here is not the same as reclaiming it — the
   * caller still has to call `discard()` explicitly, which is what keeps the
   * "listing never deletes" guarantee intact while still making cleanup
   * possible.
   */
  unreadable(): Promise<string[]>;
  /** One draft, or `null` on any miss: absent, unparseable, version-drifted,
   *  or carrying a claimed slug. */
  load(draftId: string): Promise<EventDraft | null>;
  /** Persist, stamping `updatedAt`. Returns the stored draft. */
  save(draft: EventDraft): Promise<EventDraft>;
  /**
   * Remove one draft. Discarding something that is already gone succeeds.
   * Unlike `load`, an empty `draftId` is NOT a guaranteed no-op here: it is
   * a valid identifier `unreadable()` can report (the degenerate
   * exact-prefix key), and this method must be able to reach it.
   *
   * Returns whether absence was CONFIRMED (#848, #901): `true` when there
   * was no storage to remove from (nothing was ever persisted) or a direct
   * post-removal key read returned `null`; `false` when removal or that raw
   * verification read failed, or when the key remained present. The raw
   * read is load-bearing: `load()` maps absent, unreadable, and malformed
   * values to the same `null`, so it cannot prove deletion.
   */
  discard(draftId: string): Promise<boolean>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  // Dense FIRST: `every` skips holes, so `new Array(2)` would otherwise pass
  // as a pair of strings. `save` then serializes the holes as `[null, null]`
  // and the next `load` rejects the draft — saving an incomplete schedule
  // would destroy it (#787 review).
  return isDenseArray(v) && v.every((entry) => typeof entry === 'string');
}

function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === 'string' && (SETUP_STEPS as readonly string[]).includes(v);
}

function isPool(v: unknown): v is DraftDayDef['pool'] {
  return v === 'main' || v === 'easy' || v === 'closing';
}

/**
 * The persisted Prompt-text bounds, mirroring the item-write contract in
 * `firestore.rules` (`text.size() > 0 && text.size() <= 80`) and the
 * `maxLength={80}` on every authoring input.
 *
 * Enforced HERE rather than only at launch because a draft that stores blank
 * or over-long text still counts toward `MIN_POOL` in `assignedPoolIssues`, so
 * it can clear the shared launch gate and then either be refused by rules or —
 * through a trusted provisioner that bypasses them — create blank board
 * content that no Admin editor can repair.
 */
export const MAX_PROMPT_TEXT = 80;

function isPromptText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  // The bound is on the RAW string, because `firestore.rules` applies
  // `text.size() <= 80` to the value as PERSISTED — measuring the trimmed form
  // would accept 80 visible characters plus trailing whitespace, store 82, and
  // be refused at provisioning. Non-blank is judged on the trimmed form,
  // because whitespace is not content.
  return v.trim().length > 0 && v.length <= MAX_PROMPT_TEXT;
}

/** Whether an array holds a real entry at every index. `every` and `forEach`
 *  SKIP holes, so a sparse array would otherwise satisfy both the element
 *  predicate and the pool minimum while holding fewer Prompts than its
 *  `length` claims — and a save/load would turn each hole into `null`. */
function isDenseArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.filter(() => true).length === v.length;
}

function isMainPrompt(v: unknown): v is DraftMainPrompt {
  return isRecord(v) && isPromptText(v.text) && typeof v.spicy === 'boolean';
}

/**
 * The runtime half of the main-pool-only `spicy` rule (#785). The type half is
 * `DraftCuratedPrompt['spicy']: never`, whose ONLY assignable value is
 * `undefined`.
 *
 * The check is on the VALUE, not on key presence, so that the rule survives a
 * JSON round-trip. `JSON.stringify` drops an explicitly-undefined property, so
 * a presence check would reject `{ text, spicy: undefined }` in memory and
 * accept the very same draft after a save/load — launch validity changing
 * across serialization. Treating `spicy: undefined` as equivalent to an absent
 * key makes the two readings identical, while any DEFINED spicy value is still
 * refused on both sides of the round-trip.
 */
function isCuratedPrompt(v: unknown): v is DraftCuratedPrompt {
  return isRecord(v) && isPromptText(v.text) && v.spicy === undefined;
}

function isPromptPools(v: unknown): v is DraftPromptPools {
  return (
    isRecord(v) &&
    isDenseArray(v.main) &&
    v.main.every(isMainPrompt) &&
    isDenseArray(v.easy) &&
    v.easy.every(isCuratedPrompt) &&
    isDenseArray(v.closing) &&
    v.closing.every(isCuratedPrompt)
  );
}

function isDraftDay(v: unknown): v is DraftDayDef {
  if (!isRecord(v)) return false;
  return (
    Number.isInteger(v.index) &&
    typeof v.date === 'string' &&
    (v.unlockAt === null || isFiniteNumber(v.unlockAt)) &&
    typeof v.place === 'string' &&
    typeof v.placeEmoji === 'string' &&
    (v.theme === null || typeof v.theme === 'string') &&
    isPool(v.pool) &&
    typeof v.tutorial === 'boolean' &&
    isStringArray(v.tonight) &&
    // A PRESENT override must carry text. Both the deal path and the locked-card
    // preview read `day.freeText ?? FREE_TEXT`, so a blank string is not "no
    // override" — it SUPPRESSES the fallback and deals an empty centre Square.
    // Absent means default; present means override; blank means neither, so it
    // is refused rather than quietly repaired (#787 review).
    (typeof v.freeText === 'undefined' ||
      (typeof v.freeText === 'string' && v.freeText.trim().length > 0))
  );
}

/** A share of a Board, as `dealBoard` reads it. Values outside 0–1 are not a
 *  stronger preference — `dealBoard` clamps them — so accepting one stores a
 *  setting the organizer will never actually receive. */
function isRatio(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

function isDraftSettings(v: unknown): v is EventDraftSettings {
  if (!isRecord(v)) return false;
  return (
    // STRICTLY positive: `isReportHidden` and the server auto-hide path both
    // treat a non-positive threshold as "report-based hiding is off", so a
    // stored `0` would silently launch an Event without the moderation the
    // organizer believes they configured.
    isFiniteNumber(v.reportHideThreshold) &&
    v.reportHideThreshold > 0 &&
    isRatio(v.spicyRatio) &&
    isRatio(v.easyMixRatio) &&
    typeof v.forceAdult === 'boolean' &&
    (v.photoProofSource === 'camera_or_library' || v.photoProofSource === 'camera_only') &&
    typeof v.stripPhotoExif === 'boolean' &&
    typeof v.visionGate === 'boolean' &&
    typeof v.dailyEmailEnabled === 'boolean'
  );
}

/**
 * Validate a parsed blob as an `EventDraft`, or return `null`.
 *
 * Exported because the guarantee it enforces — a well-formed draft at the
 * current schema version that holds no claimed slug — is what makes resuming
 * safe, and the wizard shell (#788) needs to assert it on anything it did not
 * itself construct.
 */
export function parseEventDraft(value: unknown): EventDraft | null {
  if (!isRecord(value)) return null;
  if (value.v !== DRAFT_SCHEMA_VERSION) return null;
  if (FORBIDDEN_KEYS.some((key) => key in value)) return null;
  if (
    typeof value.draftId !== 'string' ||
    value.draftId.length === 0 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isSetupStep(value.step) ||
    !(value.occasion === null || typeof value.occasion === 'string') ||
    typeof value.edition !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.startsOn !== 'string' ||
    typeof value.endsOn !== 'string' ||
    typeof value.timezone !== 'string' ||
    typeof value.slugCandidate !== 'string' ||
    !(
      value.claimMode === 'honor' ||
      value.claimMode === 'proof_required' ||
      value.claimMode === 'admin_confirmed'
    ) ||
    !(value.cardFormat === 'one_card' || value.cardFormat === 'daily_cards') ||
    typeof value.hostedBy !== 'string' ||
    !(value.defaultTheme === null || typeof value.defaultTheme === 'string') ||
    !isPromptPools(value.prompts) ||
    // Dense, for the same reason every other array here is: a hole survives
    // `every`, then serializes to `null` and makes the draft unreadable.
    !isDenseArray(value.days) ||
    !value.days.every(isDraftDay) ||
    !isDraftSettings(value.settings)
  ) {
    return null;
  }
  return value as unknown as EventDraft;
}

/** Optional seams for `createEventDraft`, so a test can pin both. */
export interface CreateEventDraftInit {
  draftId?: string;
  now?: number;
  timezone?: string;
  settings?: EventDraftSettings;
}

/**
 * The settings a bare draft starts from, before Step 1 applies an occasion.
 * Kept here rather than imported from the occasion matrix so that creating a
 * draft never depends on a matrix entry existing.
 */
const BARE_SETTINGS: EventDraftSettings = {
  reportHideThreshold: 4,
  spicyRatio: 0.4,
  easyMixRatio: 0.5,
  forceAdult: false,
  photoProofSource: 'camera_or_library',
  stripPhotoExif: true,
  visionGate: true,
  dailyEmailEnabled: false,
};

function newDraftId(): string {
  const c: unknown = globalThis.crypto;
  if (isRecord(c) && typeof c.randomUUID === 'function') {
    // Called THROUGH the receiver, never extracted. `randomUUID` is a Web IDL
    // method that requires its `Crypto` `this`: pulling it off the object and
    // invoking it bare throws "Illegal invocation" in browsers and a receiver
    // `TypeError` in Node, which would break every draft created without an
    // injected id. The unit environment's `crypto` shim does NOT enforce the
    // receiver, so no test could catch this — it is guarded by construction
    // here instead (#787 Phase 4b review).
    return (c as { randomUUID: () => string }).randomUUID();
  }
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A new, empty draft standing on Step 1.
 *
 * The timezone is a SUGGESTION seeded from the device when the caller does not
 * supply one, and the organizer is expected to change it: `EventDoc.timezone`
 * is the zone the whole schedule is interpreted in, so auto-detecting the
 * organizer's own zone and treating it as answered silently provisions a
 * destination Event hours off (#785) — the common case for a trip planned from
 * home. It is seeded so the field is never empty, never so the question is
 * skipped.
 */
export function createEventDraft(init: CreateEventDraftInit = {}): EventDraft {
  const now = init.now ?? Date.now();
  return {
    v: DRAFT_SCHEMA_VERSION,
    draftId: init.draftId ?? newDraftId(),
    createdAt: now,
    updatedAt: now,
    step: 'occasion',
    occasion: null,
    edition: 'fiveacross',
    name: '',
    startsOn: '',
    endsOn: '',
    timezone: init.timezone ?? deviceTimezoneSuggestion(),
    slugCandidate: '',
    claimMode: 'honor',
    cardFormat: 'daily_cards',
    hostedBy: '',
    defaultTheme: null,
    prompts: { main: [], easy: [], closing: [] },
    days: [],
    settings: init.settings ? { ...init.settings } : { ...BARE_SETTINGS },
  };
}

/** The device's IANA zone, or `''` when the environment will not say. Never
 *  throws — a missing `Intl` is a blank suggestion, not a broken wizard. */
export function deviceTimezoneSuggestion(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function store(explicit?: Storage): Storage | null {
  if (explicit) return explicit;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // localStorage throws in some privacy modes and is absent under SSR. No
    // store means "drafts do not persist on this device", never a crash.
    return null;
  }
}

/**
 * The device-local `EventDraftStore`.
 *
 * `list` scans the key namespace rather than maintaining an index document: an
 * index is a second source of truth that drifts the first time a write half
 * fails, and the draft count on one device is small enough that scanning is
 * free.
 */
export function createLocalDraftStore(
  storage?: Storage,
  clock: () => number = Date.now,
): EventDraftStore {
  function readAt(key: string): EventDraft | null {
    const ls = store(storage);
    if (!ls) return null;
    try {
      const raw = ls.getItem(key);
      if (!raw) return null;
      return parseEventDraft(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  return {
    async list(): Promise<EventDraftSummary[]> {
      const ls = store(storage);
      if (!ls) return [];
      const summaries: EventDraftSummary[] = [];
      try {
        // `length` and `key()` can THROW in a restricted Storage, not just
        // return nothing — so the enumeration is guarded as a whole. A store
        // that will not be read is "no drafts on this device", never a crash
        // in the middle of rendering the resume list.
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (!key || !key.startsWith(KEY_PREFIX)) continue;
          const draft = readAt(key);
          if (!draft) continue;
          // The key suffix and the embedded id must agree, or the row is
          // unusable: `list()` would advertise the EMBEDDED id, `load()` would
          // then read a different key and miss, and `discard()` could never
          // reach the original key — a permanently stuck row in the resume
          // list. A copied blob or a prior bad writer produces exactly this
          // (#787 review). Such a blob is SKIPPED but deliberately not
          // reclaimed: it parses, so it is somebody's real draft, and this
          // module never deletes valid work to tidy a listing.
          if (key !== KEY_PREFIX + draft.draftId) {
            continue;
          }
          summaries.push({
            draftId: draft.draftId,
            name: draft.name,
            step: draft.step,
            updatedAt: draft.updatedAt,
          });
        }
      } catch {
        return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      // `list()` DELETES NOTHING. Reading the resume list is not a destructive
      // operation.
      //
      // Earlier revisions reclaimed blobs this build could not read, guarding
      // the delete with a re-read that spared future schema versions and
      // concurrent saves. That guard cannot be made correct: `mustPreserve`
      // and `removeItem` are two separate localStorage operations, another
      // same-origin tab can land a valid save in the window between them, and
      // localStorage offers no compare-and-delete primitive to close it. The
      // window can be narrowed forever and never shut.
      //
      // Given a race that cannot be eliminated, the asymmetry decides it:
      // wrongly keeping a dead blob costs some quota, and `save` already
      // tolerates a full store without losing the draft being edited. Wrongly
      // deleting one destroys an organizer's work permanently and silently.
      // So nothing is reclaimed here, and quota is left to `discard()` — the
      // one path where deletion is what the organizer actually asked for
      // (#787 Phase 4b review). `unreadable()` below is the discovery path
      // that makes reaching `discard()` for one of these possible at all
      // (#814).
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async unreadable(): Promise<string[]> {
      const ls = store(storage);
      if (!ls) return [];
      const hidden: string[] = [];
      try {
        // Same guarded enumeration as `list()`: `length`/`key()` can throw in
        // a restricted Storage, and a store that will not be read has no
        // hidden entries to report, not a crash.
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (!key || !key.startsWith(KEY_PREFIX)) continue;
          const suffix = key.slice(KEY_PREFIX.length);
          const draft = readAt(key);
          // Exactly the complement of what `list()` shows: unreadable
          // (absent, unparseable, version-drifted) OR readable but stored
          // under a key that disagrees with its own embedded `draftId` — the
          // same mismatch `list()` skips without advertising a wrong id.
          // Either way the SUFFIX, not the embedded id, is what makes the
          // entry reachable again: `discard(suffix)` reconstructs this exact
          // key regardless of what the blob claims about itself.
          if (!draft || key !== KEY_PREFIX + draft.draftId) {
            hidden.push(suffix);
          }
        }
      } catch {
        return hidden;
      }
      return hidden;
    },

    async load(draftId: string): Promise<EventDraft | null> {
      if (!draftId) return null;
      return readAt(KEY_PREFIX + draftId);
    },

    async save(draft: EventDraft): Promise<EventDraft> {
      const stamped: EventDraft = { ...draft, v: DRAFT_SCHEMA_VERSION, updatedAt: clock() };
      const ls = store(storage);
      if (ls) {
        try {
          const serialized = JSON.stringify(stamped);
          // Only write a snapshot that will READ BACK. `JSON.stringify` is not
          // round-trip safe for every in-memory draft: a sparse array becomes
          // explicit `null` entries, which `parseEventDraft` rejects. Writing
          // one would replace a perfectly good stored draft with a blob the
          // next `load()` misses and `list()` may reclaim — a save DESTROYING
          // the thing it was meant to preserve (#787 Phase 4b review).
          //
          // On failure the previous stored value is left exactly as it was.
          // That matches the existing best-effort posture: the in-memory draft
          // the organizer is editing is untouched, and the save that follows a
          // repaired schedule will succeed.
          if (parseEventDraft(JSON.parse(serialized)) !== null) {
            ls.setItem(KEY_PREFIX + stamped.draftId, serialized);
          }
        } catch {
          // Quota or serialization failure. Best-effort, exactly like the card
          // snapshot: the in-memory draft the organizer is editing is
          // unaffected, and the next save may well succeed.
        }
      }
      return stamped;
    },

    async discard(draftId: string): Promise<boolean> {
      // Unlike every other method here, `discard()`'s return value makes a
      // POSITIVE claim about what happened, so it cannot reuse `store()`'s
      // shared "any throw collapses to null" behavior the way `load`/
      // `save`/`list` safely do (#848 round 2, Codex P2): that would
      // conflate "no storage was ever configured" (nothing was ever
      // persisted, so there is nothing to confirm — `true`) with "storage
      // EXISTED and merely REFERENCING it now throws" — access can be
      // revoked mid-session, and something MAY already be persisted from
      // before that happened. This call cannot tell the two apart, so it
      // must report UNCONFIRMED for the second one rather than the trivial
      // `true` a shared null-collapsing check would give it.
      let ls: Storage | null;
      if (storage) {
        ls = storage;
      } else {
        try {
          ls = typeof localStorage !== 'undefined' ? localStorage : null;
        } catch {
          return false;
        }
      }
      // NOT `!draftId`: an empty string is a legitimate `discard()` argument,
      // not a guaranteed miss the way it is for `load()`. `unreadable()` can
      // report `''` as a hidden entry's suffix — the degenerate exact-prefix
      // key `gcb:event-draft:` — reachable only via a hand-edited blob or a
      // foreign writer, since this module's own `save()` never persists an
      // empty `draftId` (`parseEventDraft` refuses one). Guarding on falsiness
      // here would make that one advertised id permanently un-discardable,
      // silently defeating the very cleanup path it was named for (Codex P2,
      // #814 round 2 review).
      // No storage at all means nothing was ever persisted anywhere on this
      // device — there is nothing to remove, and nothing left unconfirmed.
      if (!ls) return true;
      try {
        const key = KEY_PREFIX + draftId;
        ls.removeItem(key);
        // Read the RAW key, not `load()`. A Storage may silently ignore the
        // removal and then throw on read (#901); `load()` collapses that throw
        // (and a malformed value) to `null`, which would falsely confirm the
        // draft was gone. Here only an actual absent key is success.
        return ls.getItem(key) === null;
      } catch {
        // The removal or its raw verification read failed. Report this as
        // UNCONFIRMED rather than swallowing it: `load()` would turn the same
        // failed read into a false-looking absence.
        return false;
      }
    },
  };
}
