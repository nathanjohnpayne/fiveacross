/**
 * The occasion → Edition/defaults matrix (specs/event-setup-wizard.md,
 * `#frame-setup-occasion`).
 *
 * A pure code table, not Firestore data: Step 1 has to render before anything
 * about the Event exists, and the matrix binds an Edition — which is itself a
 * code table (`src/editions.ts`) for the same reason. No Firebase import ever
 * belongs here.
 *
 * CONTENT OWNERSHIP IS OPEN (#786 Decision 2). The occasion SHAPE ships in
 * this ticket; who authors and maintains the starter packs does not, so every
 * `starterPackId` below is `null`. The frames name exactly one pack — "🌊
 * Coastal weekend pack", 86 squares / 32 main / 28 easy / 26 closing, on the
 * Weekend-away worked example — and it does not exist in the repo, so naming
 * it here would be a promise rather than a reference. When a pack is authored,
 * flipping its `starterPackId` from `null` is the whole change.
 */

import type {
  ClaimMode,
  EventDraft,
  EventDraftSettings,
  OccasionDef,
  OccasionId,
  ThemeId,
} from '../types';

/**
 * The Event settings every occasion starts from.
 *
 * `spicyRatio` is `0.4` — `dealBoard`'s own documented default — rather than
 * Bodega's explicit `0`, because the draft writes the key rather than omitting
 * it, and writing a value the engine would not have chosen is a behaviour
 * change disguised as a default. A pool with no spicy Prompts deals
 * identically either way.
 *
 * `dailyEmailEnabled: false` is stated rather than omitted for the opposite
 * reason: `dailyEmailEnabled()` reads false unless EXPLICITLY true and no
 * shipped Admin surface sets it (#785), so the wizard is the only place it can
 * ever be turned on. Recording it here is what makes it reachable later.
 */
const BASE_SETTINGS: EventDraftSettings = {
  reportHideThreshold: 4,
  spicyRatio: 0.4,
  easyMixRatio: 0.5,
  forceAdult: false,
  photoProofSource: 'camera_or_library',
  stripPhotoExif: true,
  visionGate: true,
  dailyEmailEnabled: false,
};

/**
 * Every occasion defaults to Honor.
 *
 * `EventDoc.claimMode` is required with three real values, so SOMETHING must
 * choose; the frames put the choice in Step 2 while the PRD lists claim mode
 * among the defaults-with-an-escape-hatch that get no step of their own
 * (#786's recorded contradiction). The matrix satisfies both readings: it
 * supplies a default so the flow is never blocked on the question, and Step 2
 * may still ask. What it must not do is leave the field unset and let the
 * provisioner hard-code Honor invisibly.
 */
const DEFAULT_CLAIM_MODE: ClaimMode = 'honor';

/** The Themes each Edition registers (`themesForEdition`), in Day order. */
const VACAY_DAY_THEMES: ThemeId[] = ['the-birds', 'side-quests', 'fog-froth-farewells'];
const FIVEACROSS_DAY_THEMES: ThemeId[] = ['marquee', 'confetti-hour', 'afterglow'];

/**
 * The six rows of `#frame-setup-occasion`, in frame order. `label` and `blurb`
 * are the frame's own copy.
 *
 * Edition bindings: the frames name one only for the two travel rows ("plays
 * as Vacay Bingo", "Vacay edition"). The rest follow the epic's reading —
 * Wedding and Conference are Five Across-Edition occasions (#786 Decision 3
 * calls them out by name), and Custom is occasion-neutral by definition.
 *
 * CRUISE IS A JUDGEMENT CALL, recorded as an open question for #786. It binds
 * to `vacay`, not `gcb`: Gay Cruise Bingo is "the original adults-only cruise
 * edition" (CONTEXT.md) — a branded line with its own wordmark, cruise
 * Lexicon, and adult posture — so handing every self-served cruise that
 * identity would be wrong by default in exactly the way #785 catalogues.
 * Vacay's travel register serves a cruise correctly. If the owner wants the
 * gcb Edition reachable from the wizard, it is a one-line change here.
 */
export const OCCASIONS: readonly OccasionDef[] = [
  {
    id: 'weekend-away',
    label: 'Weekend away',
    blurb: 'Trips & getaways · plays as Vacay Bingo',
    emoji: '🏝',
    edition: 'vacay',
    // The frames' "Coastal weekend pack" would live here once authored.
    starterPackId: null,
    defaults: {
      cardFormat: 'daily_cards',
      claimMode: DEFAULT_CLAIM_MODE,
      schedule: {
        dayCount: 4,
        unlockTime: '06:00',
        firstDayPool: 'easy',
        // Bodega's easy-pool Friday is `tutorial: false` (#785) — the warm-up
        // pool and the First-to-BINGO exclusion are two different decisions,
        // and an arrival Day's wins are meant to count.
        firstDayTutorial: false,
        finalDayPool: 'closing',
        finalDayTutorial: true,
      },
      defaultTheme: 'the-birds',
      dayThemes: VACAY_DAY_THEMES,
      settings: BASE_SETTINGS,
    },
  },
  {
    id: 'city-break',
    label: 'City break',
    blurb: 'Short urban trips · Vacay edition',
    emoji: '🏙',
    edition: 'vacay',
    starterPackId: null,
    defaults: {
      cardFormat: 'daily_cards',
      claimMode: DEFAULT_CLAIM_MODE,
      schedule: {
        dayCount: 3,
        unlockTime: '06:00',
        firstDayPool: 'easy',
        firstDayTutorial: false,
        finalDayPool: 'closing',
        finalDayTutorial: true,
      },
      defaultTheme: 'the-birds',
      dayThemes: VACAY_DAY_THEMES,
      settings: BASE_SETTINGS,
    },
  },
  {
    id: 'wedding',
    label: 'Wedding',
    blurb: 'One card, one celebration',
    emoji: '💍',
    edition: 'fiveacross',
    starterPackId: null,
    defaults: {
      // "One card, one celebration" is the frame's own Card-format wording: an
      // Event with an empty `days[]`, so it proposes no schedule at all.
      cardFormat: 'one_card',
      claimMode: DEFAULT_CLAIM_MODE,
      schedule: null,
      defaultTheme: 'confetti-hour',
      dayThemes: [],
      settings: BASE_SETTINGS,
    },
  },
  {
    id: 'conference',
    label: 'Conference or offsite',
    blurb: 'Mingle-and-discover defaults',
    emoji: '🎤',
    edition: 'fiveacross',
    starterPackId: null,
    defaults: {
      cardFormat: 'daily_cards',
      claimMode: DEFAULT_CLAIM_MODE,
      schedule: {
        dayCount: 3,
        unlockTime: '06:00',
        firstDayPool: 'easy',
        // A conference opener IS onboarding — day one is name badges, so its
        // wins are framed out of the Event-wide honour.
        firstDayTutorial: true,
        finalDayPool: 'closing',
        finalDayTutorial: true,
      },
      defaultTheme: 'marquee',
      dayThemes: FIVEACROSS_DAY_THEMES,
      settings: BASE_SETTINGS,
    },
  },
  {
    id: 'cruise',
    label: 'Cruise',
    blurb: 'Multi-day, themed nights',
    emoji: '🚢',
    edition: 'vacay',
    starterPackId: null,
    defaults: {
      cardFormat: 'daily_cards',
      claimMode: DEFAULT_CLAIM_MODE,
      schedule: {
        dayCount: 7,
        unlockTime: '06:00',
        firstDayPool: 'easy',
        firstDayTutorial: true,
        finalDayPool: 'closing',
        finalDayTutorial: true,
      },
      defaultTheme: 'the-birds',
      dayThemes: VACAY_DAY_THEMES,
      settings: BASE_SETTINGS,
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    blurb: 'Start empty, choose everything',
    emoji: '✨',
    edition: 'fiveacross',
    starterPackId: null,
    defaults: {
      cardFormat: 'daily_cards',
      claimMode: DEFAULT_CLAIM_MODE,
      // "Start empty, choose everything": Custom proposes no schedule, so
      // Step 4 authors every Day from nothing rather than deleting rows the
      // organizer never asked for.
      schedule: null,
      defaultTheme: 'marquee',
      dayThemes: [],
      settings: BASE_SETTINGS,
    },
  },
];

/** The matrix entry for an occasion, or `null` for an unknown id. Never
 *  falls back to another occasion — silently starting someone on the wrong
 *  Edition is worse than making Step 1 ask again. */
export function occasionById(id: OccasionId | null | undefined): OccasionDef | null {
  if (!id) return null;
  return OCCASIONS.find((o) => o.id === id) ?? null;
}

/**
 * Apply an occasion's defaults to a draft, returning a NEW draft.
 *
 * Applies the Edition binding, card format, claim mode, default Theme and
 * settings. It deliberately does NOT build `days[]`: turning an
 * `OccasionScheduleShape` into absolute `unlockAt` instants needs the Event's
 * timezone and a zone-aware clock, which is Step 4's job (#792) — this ticket
 * ships the shape as data, not a scheduler.
 *
 * Prompts are untouched for the same reason: seeding a starter pack is Step
 * 3's job, and no pack exists to seed yet.
 */
export function applyOccasionDefaults(draft: EventDraft, occasion: OccasionDef): EventDraft {
  // A one-card Event IS an Event with an empty `days[]`. Re-picking a one-card
  // occasion after authoring a schedule has to drop those Days: `dayCountIssues`
  // refuses a one-card draft that carries any, and every Day-authoring surface
  // is scoped to `daily_cards`, so the organizer would be left holding rows
  // nothing can edit and nothing will launch.
  const days = occasion.defaults.cardFormat === 'one_card' ? [] : draft.days;
  return {
    ...draft,
    occasion: occasion.id,
    days,
    // Copied, never re-derived on read: editing the matrix must not restyle a
    // draft that is already half-built.
    edition: occasion.edition,
    cardFormat: occasion.defaults.cardFormat,
    claimMode: occasion.defaults.claimMode,
    defaultTheme: occasion.defaults.defaultTheme,
    settings: { ...occasion.defaults.settings },
  };
}
