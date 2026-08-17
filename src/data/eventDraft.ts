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
 * This is the forward-migration lever the ticket asks for. When #531 lands
 * `DayDef.scoring` / `EventDoc.standingsFreezeAt` and the draft grows them,
 * bumping this retires every draft written without them rather than resuming
 * a half-shaped one at Step 5.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/**
 * One localStorage key per draft. The `gcb:` prefix matches the established
 * storage namespace (`gcb:card-snapshot:…`) — it is a key namespace, not
 * branding, and a second prefix would fragment the origin's storage for no
 * gain. Version-scoped so a future bump cannot collide with a live key.
 */
const KEY_PREFIX = `gcb:event-draft:v${DRAFT_SCHEMA_VERSION}:`;

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
   *  Unreadable blobs are skipped, never thrown. */
  list(): Promise<EventDraftSummary[]>;
  /** One draft, or `null` on any miss: absent, unparseable, version-drifted,
   *  or carrying a claimed slug. */
  load(draftId: string): Promise<EventDraft | null>;
  /** Persist, stamping `updatedAt`. Returns the stored draft. */
  save(draft: EventDraft): Promise<EventDraft>;
  /** Remove one draft. Discarding something that is already gone succeeds. */
  discard(draftId: string): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === 'string');
}

function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === 'string' && (SETUP_STEPS as readonly string[]).includes(v);
}

function isPool(v: unknown): v is DraftDayDef['pool'] {
  return v === 'main' || v === 'easy' || v === 'closing';
}

function isMainPrompt(v: unknown): v is DraftMainPrompt {
  return isRecord(v) && typeof v.text === 'string' && typeof v.spicy === 'boolean';
}

/** The runtime half of the main-pool-only `spicy` rule (#785). The type half
 *  is `DraftCuratedPrompt['spicy']: never`; this closes the JSON-parse path a
 *  type cannot reach. */
function isCuratedPrompt(v: unknown): v is DraftCuratedPrompt {
  return isRecord(v) && typeof v.text === 'string' && !('spicy' in v);
}

function isPromptPools(v: unknown): v is DraftPromptPools {
  return (
    isRecord(v) &&
    Array.isArray(v.main) &&
    v.main.every(isMainPrompt) &&
    Array.isArray(v.easy) &&
    v.easy.every(isCuratedPrompt) &&
    Array.isArray(v.closing) &&
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
    (typeof v.freeText === 'undefined' || typeof v.freeText === 'string')
  );
}

function isDraftSettings(v: unknown): v is EventDraftSettings {
  if (!isRecord(v)) return false;
  return (
    isFiniteNumber(v.reportHideThreshold) &&
    isFiniteNumber(v.spicyRatio) &&
    isFiniteNumber(v.easyMixRatio) &&
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
    typeof value.freeSpaceText !== 'string' ||
    !isPromptPools(value.prompts) ||
    !Array.isArray(value.days) ||
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
    return (c.randomUUID as () => string)();
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
    freeSpaceText: '',
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
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key || !key.startsWith(KEY_PREFIX)) continue;
        const draft = readAt(key);
        if (!draft) continue;
        summaries.push({
          draftId: draft.draftId,
          name: draft.name,
          step: draft.step,
          updatedAt: draft.updatedAt,
        });
      }
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
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
          ls.setItem(KEY_PREFIX + stamped.draftId, JSON.stringify(stamped));
        } catch {
          // Quota or serialization failure. Best-effort, exactly like the card
          // snapshot: the in-memory draft the organizer is editing is
          // unaffected, and the next save may well succeed.
        }
      }
      return stamped;
    },

    async discard(draftId: string): Promise<void> {
      const ls = store(storage);
      if (!ls || !draftId) return;
      try {
        ls.removeItem(KEY_PREFIX + draftId);
      } catch {
        /* nothing to do — a draft that cannot be removed is already unreadable */
      }
    },
  };
}
