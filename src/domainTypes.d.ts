// Shared declaration-only domain types. These describe Firestore documents and flow through
// the whole app (converters, hooks, components) as one contract.

/**
 * How much friction a Mark carries — a friction/vibe knob, NOT a trust level
 * (ADR 0001). `admin_confirmed` makes a Mark start pending until an Admin
 * resolves its Claim; it is a dispute/ceremony tool, not an integrity guarantee.
 * Events written before the rename are coerced on read by `migrateClaimMode`
 * (`data/converters`) so a pre-rename persisted value resolves to
 * `admin_confirmed`; writes only ever emit a current value.
 */
export type ClaimMode = 'honor' | 'proof_required' | 'admin_confirmed';

/** Vocabulary fragments shared by every consumer of an Edition register. */
export interface EditionLexicon {
  /** The occasion itself, lowercase, mid-sentence: "the whole {occasion}". */
  occasion: string;
  /** Scope adjective: "⭐ marks the {occasionWide} First to BINGO". */
  occasionWide: string;
  /** One location on the schedule, lowercase singular. */
  place: string;
  /** The same, Title Case plural — it opens a list. */
  placePlural: string;
  /** Audience fragment, including any determiner the register needs. */
  crowd: string;
  /** WHY signal for Edition-specific offline reassurance. */
  offlineWhy: string;
  /** Decorative share mark; functional emoji remain Edition-invariant. */
  shareMark: string;
  /** Download filename stem for a rasterised share card. */
  fileSlug: string;
}

/** The shared code-table contract for one resolved Edition. */
export interface EditionBrand {
  wordmark: string;
  wordmarkBold: string;
  /** The endorsement micro-line under the header wordmark ("BY FIVE ACROSS",
   *  daily-cards-wireframes § in-app header lockup). Optional because the
   *  wireframes give it ONLY to Editions endorsed by the platform: Vacay
   *  carries it, Gay Cruise Bingo predates the platform and carries none, and
   *  Five Across IS the platform so an endorsement of itself would be noise. */
  wordmarkByline?: string;
  preEventVerb: string;
  tagline: string;
  /** The gate's voice line ("Take the detour. For the story.") — the italic
   *  chip the wireframes draw inside the Join lockup (#647, § Join). Optional
   *  because only vacay's frame carries one; when present it REPLACES the
   *  plain `tagline` on the signed-out gate, which the wireframe omits there. */
  signinTaglineChip?: string;
  /** The invitation copy block under the Join CTA ("Prompts are invitations,
   *  not chores…"). Optional: only the vacay frame draws it. */
  signinInviteNote?: string;
  /** How the gate's Event-preview card is dressed: `'postcard'` adds the
   *  dashed stamp corner the wireframes give the vacay Join frame; absent
   *  draws the plain panel gcb and fiveacross use. A STRING variant rather
   *  than a boolean so editions.test.ts's every-field-is-a-nonempty-string
   *  exhaustiveness sweep covers it like any other brand field. */
  signinCardVariant?: 'postcard';
  offlineNote: string;
  documentTitle: string;
  appName: string;
  appShortName: string;
  appDescription: string;
  /** The `<meta name="description">` line (#587). Crawlers read it without
   *  running JS, so it is baked into index.html at build time alongside the
   *  og:* block — see `HTML_IDENTITY_TOKENS` in `src/editions.ts`. */
  metaDescription: string;
  /** `og:url` — the canonical origin an unfurl attributes the link to (#587).
   *  Strictly this is a per-EVENT fact (the Event's canonical hostname), but a
   *  build can only bake per-Edition data, so each Edition carries its flagship
   *  origin here until the edge Worker (#546) rewrites the tag per hostname. */
  ogUrl: string;
  /** `og:image` / `twitter:image` — an ABSOLUTE URL (#587, artwork #609).
   *  Absolute because crawlers resolve unfurl images poorly against relative
   *  paths, and pinned to the serving project's always-healthy `web.app` host
   *  rather than a custom domain: the gcb apex TLS-resets for link crawlers
   *  (#340) and is SNI-blocked on the ship network (#164). The referenced file
   *  must ship in `public/` of the same bundle — guarded by
   *  `src/recon-share-og.test.ts`. */
  ogImage: string;
  /** `og:image:alt` for the artwork above (#609 supplies the wording). */
  ogImageAlt: string;
  lexicon: EditionLexicon;
  passCheckLabel: string;
  scheduleTitle: string;
  scheduleSub: string;
  walkthroughReplaySub: string;
  promptDeadlineNote: string;
  tutorialWarmupNote: string;
  championRole: string;
  podiumLabel: string;
  reviewQueueAllClear: string;
  bingoShareText: string;
  blackoutShareText: string;
  updateToastMark: string;
  updateToastTitle: string;
  guidelinesScope: string;
}

export type ThemeId =
  | 'neon-playground'
  | 'get-sporty'
  | 'duty-free'
  | 'glamiators'
  | 'summer-white'
  | 'dog-tag'
  | 'revival-disco'
  | 'seriously-pink'
  // Phase 1.5 tutorial-day themes (daily-cards-spec § "Theme reference"). The
  // two ThemeMeta entries + themes.css token blocks that back these land in
  // #206; reserved in the union here so this contract-ticket's downstream
  // consumers (DayDef.theme, day chrome) can name them without waiting.
  | 'welcome-aboard'
  | 'so-long-farewell'
  // Unified day themes (schedule correction 2026-07-17, daily-cards-spec
  // § "Theme reference"). Each folds a day's two signature parties into ONE
  // chrome/palette/chip identity; the two events themselves live in
  // `DayDef.tonight`. The five superseded party ThemeIds (get-sporty, duty-free,
  // dog-tag, seriously-pink, neon-playground) stay valid — they still back the
  // theme switcher, saved player preferences, and neon-playground stays the
  // app default — they're just no longer day themes on this sailing.
  | 'uniforms-without-borders'
  | 'neon-pink-playground'
  | 'sporty-splash'
  | 'under-the-stars'
  | 'atlantis-classics'
  // Bodega Bay Day themes (#555, Five Across / Vacay edition). Scoped OUT of
  // the Gay Cruise Bingo switcher by `themesForEdition`, but they stay in the
  // `THEMES` registry so id->emoji/label lookups and the contrast suites cover
  // them like any other Theme.
  | 'the-birds'
  | 'side-quests'
  | 'fog-froth-farewells'
  // Five Across Themes (#617). Occasion-neutral by design — the fiveacross
  // register serves a conference hall, a wedding, or a birthday weekend
  // equally, so nothing here names a place or an occasion. Scoped to the
  // fiveacross Edition by `themesForEdition`, in the registry for the same
  // reason as the Bodega trio above.
  | 'marquee'
  | 'confetti-hour'
  | 'afterglow';

// One Day of an Event (daily-cards-spec § "Data model"). Ordered inside
// `EventDoc.days` (length 10 for the July sailing, 4 for Bodega Bay — the
// model assumes no fixed length; a future Event is a new EventDoc with its own
// days[]). Each Day names a date, place, ThemeId, and item pool; the tutorial
// Days sit at the ends but that placement is data, not a code assumption.
export interface DayDef {
  index: number;        // 0..9
  date: string;         // ISO date, e.g. '2026-07-16'
  // Where this Day happens — 'Split', 'Bodega Bay'. Docs written before the
  // #566 rename persist `port`/`portEmoji`; `migrateDayFields`
  // (data/converters) coerces them on read, and writes only ever emit the
  // neutral names.
  place: string;         // 'Split'
  placeEmoji: string;    // '🇭🇷'
  theme: ThemeId;       // the UNIFIED day theme — drives card + chrome styling
  // The night's two signature events, shown on the card's "Tonight:" line
  // (day bar + locked-day tease). EXACTLY two display strings with emoji —
  // parties when the Day has them, else the headline show/concert + party,
  // sourced from the VB26 vacation guide's Entertainment Preview (schedule
  // correction 2026-07-17). Purely presentational: no dealing, snapshot, or
  // scoring input reads it. Day 10's line is editorial (no disembark-day
  // events are published).
  tonight: string[];
  // Which item set this Day deals from (CONTEXT.md § Pool): the main pool, the
  // easy pool, or the closing pool. Docs written before the #565 rename
  // persist 'embark' (easy) / 'farewell' (closing); `migratePool`
  // (data/converters) coerces them on read. firestore.rules accept both
  // vocabularies during the transition.
  pool: 'main' | 'easy' | 'closing';
  tutorial: boolean;    // true for the tutorial Days (GCB: Day 1 and Day 10)
  unlockAt: number;     // ms epoch — 08:00 event-tz on `date`; an easy first Day may use the 0 open sentinel
  freeText?: string;    // per-day free-space override (tutorial Days)
  // The Day Snapshot: the frozen list of item ids stamped at `unlockAt` by the
  // scheduler (#202). Optional on purpose — absent until that function runs, so
  // the client falls back to the "waking up" locked state rather than dealing
  // from an unfrozen pool.
  snapshotItemIds?: string[];
  // Frozen with the snapshot for main Days so late first-deals and reshuffles keep
  // the ratio that was in force at unlock, even if Admin changes the event setting.
  snapshotEasyMixRatio?: number;
}

export interface EventDoc {
  name: string;
  // The Event's date window. Docs written before the #566 rename persist
  // `sailStart`/`sailEnd`; the eventConverter coerces them on read, and
  // writes only ever emit the neutral names.
  startsOn: string; // ISO date
  endsOn: string;   // ISO date
  status: 'active' | 'archived';
  defaultTheme: ThemeId;
  claimMode: ClaimMode;
  admins: string[];
  // IANA timezone the Day unlock schedule is computed in (e.g. 'Europe/Rome').
  // Required in the contract so day-scheduling consumers never branch on
  // undefined; `eventConverter` defaults a missing legacy field (Event docs
  // seeded before Phase 1.5) to 'Europe/Rome'.
  timezone: string;
  // The ordered per-Day schedule (daily-cards-spec § "Data model"). Required in
  // the contract; `eventConverter` defaults a missing legacy field to [] so a
  // not-yet-migrated Event doc read in dev/tests never throws downstream.
  days: DayDef[];
  // Finale freeze stamp (ms epoch): set by the Day 10 08:00 scheduler run when
  // the standings freeze and the podium Moment posts. Absent until the finale.
  frozenAt?: number;
  // Presentational, event-scoped hide/mute of a Player's content (ADR 0004
  // Phase 0) — NOT hard access revocation. An admin-maintained roster of banned
  // uids kept on the (already admin-writable) event doc; a follow-up (#108) will
  // filter their content client-side, mirroring the reportHideThreshold
  // auto-hide, never gate posting or reads server-side (that is #43/#44). Required
  // in the contract so consumers never branch on undefined; `eventConverter`
  // defaults a missing legacy field (event docs seeded before #113) to [].
  bannedUids: string[];
  settings: {
    reportHideThreshold: number;
    // Target share of spicy (🔞) Prompts among a Board's 24 non-free Squares,
    // read defensively (`typeof === 'number'`) at the deal-time call site the
    // same way `reportHideThreshold` is, even though it is typed required
    // above — optional here because an Event doc seeded before this field
    // existed has no key to read, and `dealBoard`'s own default (0.4) applies
    // when it is absent.
    spicyRatio?: number;
    /**
     * Admin override on the Event's 18+ posture (#608): an INPUT the server-side
     * derivation ORs in, never the derived flag itself (that lives on
     * `hostnames/{host}.adultContent`, which no client may write).
     *
     * Exists because `spicy` tracks SEXUAL explicitness specifically, so an
     * Event whose only mature content is non-sexual — violence, drugs,
     * self-harm — would derive `false` and show no gate. Optional: absent means
     * "derive from the pool alone", which is every Event that predates #608.
     */
    forceAdult?: boolean;
    // Easy mix (daily-cards-spec § "Resolved decisions" #8, specs/easy-mix.md): the
    // share of a main-day Board's 24 non-free Squares dealt from the EASY (embark)
    // pool instead of the main pool, 0..1. Read defensively (`typeof === 'number'`) at
    // the deal call sites (`dealDayCard` / `reshuffleBoard`) the same way `spicyRatio`
    // is, with a 0.5 default when absent. Optional here because an Event doc seeded
    // before this field existed has no key to read; `spicyRatio` then applies WITHIN
    // the main remainder. Admin-tunable so difficulty is a dial, not a deploy.
    easyMixRatio?: number;
    // Phase 1.5 Proof & Claims admin panel (daily-cards-spec § "Data model").
    // All three are optional here and read defensively at their runtime call
    // sites — the event-level defaults (`camera_or_library` for source, `true`
    // for the exif strip and vision gate) are applied by the consuming tickets
    // (#211), not baked in as type-level defaults.
    photoProofSource?: 'camera_or_library' | 'camera_only';
    stripPhotoExif?: boolean; // geotags never leave the phone
    visionGate?: boolean;     // existing moderation function, now toggleable
    // Daily themed engagement email (#616, specs/daily-engagement-email.md).
    // The Event-level admin enable toggle, and the ONLY thing that decides
    // whether anyone is emailed at all. Optional here and read as OFF unless
    // EXPLICITLY `true` server-side (`dailyEmailEnabled`, functions/src/dailyEmail.ts)
    // — an Event doc seeded before this field existed, or one whose read
    // half-failed, must never start mailing a roster.
    dailyEmailEnabled?: boolean;
  };
}

/**
 * A `hostnames/{host}` document — the public, pre-auth hostname → Event lookup
 * (ADR 0009, specs/hostnames-lookup.md). One document per public address, keyed
 * by full hostname, so an Event's canonical address and each of its aliases are
 * separate documents pointing at the same Event.
 *
 * Lives here rather than beside the resolver because it is a Firestore document
 * contract consumed by the resolver, the Firestore seam and the seed — three
 * places that must not be free to disagree about what `status` means.
 */
export interface HostnameDoc {
  eventId: string;
  canonicalHost: string;
  edition: string;
  /** `active` is the ONLY value that serves an Event. Never defaulted. */
  status: 'active' | 'disabled' | 'archived';
  /**
   * Whether this Event's pool holds adult content, and therefore whether the
   * app shows the 18+ acknowledgement (#608). Server-derived — never written by
   * a client — from `settings.forceAdult || (any active spicy Prompt in a
   * dealable pool)`; see `functions/src/adultContent.ts`.
   *
   * REQUIRED in the type but ALWAYS defaulted on read: both the network seam and
   * the cache reader coerce anything that is not a literal `false` to `true`
   * (`coerceAdultContent`), because under-gating is the harmful direction. That
   * is what makes every hostname document written before #608 correct with no
   * backfill.
   */
  adultContent: boolean;
  slug?: string;
  isCanonical?: boolean;
  /**
   * The sign-in gate's Event-preview slice (#647, wireframes § Join): the few
   * display strings the pre-auth postcard renders. OPTIONAL and read fail-soft
   * (`coerceEventPreview`) — absent means the gate simply draws no card, which
   * is every hostname document written before #647.
   *
   * Lives HERE, on the one deliberately world-readable document, because
   * `events/{eventId}` requires `signedIn()` and the screen this feeds is the
   * one that gets you signed in. Same reasoning as `edition` and
   * `adultContent`: what it exposes (the Event's name, dates, host first name)
   * is exactly what the sign-in page announces to anyone who loads the
   * hostname anyway. Admin-SDK-seeded like every other field — no client
   * write arm exists, and none is added.
   */
  preview?: EventPreview;
}

/** One Day of the pre-auth preview schedule — enough to render "Day 1: The
 *  Birds Have Entered the Chat" without reading the rules-gated Event doc. */
export interface EventPreviewDay {
  /** ISO date (`2026-08-07`), event-local. */
  date: string;
  /** The Day's display title, exactly as the schedule names it. */
  title: string;
  /** The Day Theme's decorative mark ("🐦"), drawn before the Day label. */
  emoji?: string;
}

/** The world-readable Event slice behind the sign-in postcard (#647). Every
 *  field is display copy, seeded via the Admin SDK; nothing here is an
 *  authorization input. */
export interface EventPreview {
  /** The Event's display name ("Weekend in Bodega Bay"). REQUIRED — a card
   *  with no name is not worth drawing, so `coerceEventPreview` rejects the
   *  whole slice without it. */
  eventName: string;
  /** Pre-formatted date range ("Aug 7–9"). Authored, not computed, so the
   *  seed controls its own abbreviation style. */
  dateRange?: string;
  /** The host's display name ("Kim") — the card prepends "hosted by". */
  hostedBy?: string;
  /** The preview schedule, in Day order, for the live "Day N" line. */
  days?: EventPreviewDay[];
}

export interface ItemDoc {
  id: string;
  text: string;
  createdBy: string;
  createdAt: number; // ms epoch
  isFreeSpace: boolean;
  // Phase 1.5 approval flow (daily-cards-spec § "Item pools and the approval
  // flow"): main-pool submissions written after #210 ships start `pending`;
  // an admin approve → `active`, reject → `rejected` (kept for audit, hidden
  // from non-admins). Every existing `active` item stays `active` — this
  // ticket only widens the union, it migrates no data.
  status: 'active' | 'hidden' | 'pending' | 'rejected';
  reportCount: number;
  // Whether this Prompt is in the 🔞-tagged "spicy" category (vs. "tame") for
  // stratified Board composition (`dealBoard`'s spicyRatio sampling).
  spicy: boolean;
  // Which of the three Phase 1.5 pools this Prompt belongs to (main game vs
  // the easy/closing curated cards), separated by field within the one `items`
  // collection. Absent on legacy docs → `'main'`, and the pre-#565 persisted
  // values ('embark'/'farewell') coerce to 'easy'/'closing' — both via
  // `migratePool` in `itemConverter`; no data backfill (daily-cards-spec §
  // "Migration"). Writes through the transition keep emitting the LEGACY
  // values (see `adminAddItem`) so not-yet-redeployed Functions never see a
  // vocabulary they don't know.
  pool: 'main' | 'easy' | 'closing';
  approvedBy?: string; // uid of the approving admin
  approvedAt?: number; // ms epoch
}

export interface Cell {
  index: number;               // 0..24
  itemId: string | null;       // null for the free center
  text: string;
  free: boolean;
  marked: boolean;
  markedAt: number | null;     // ms epoch
  proofId?: string | null;     // Phase 1
  status?: 'confirmed' | 'pending'; // used only in admin_confirmed claim mode
  // An Echo Mark (specs/echo-marks.md): this Square was auto-marked because the
  // Player's Mark on the SAME Prompt reached confirmed on another of their
  // boards — the Player did the thing; the cards just agree. Absent/false = a
  // manual Mark. PERSISTED (not inferred) because the Reshuffle pristine check
  // counts only non-echo Marks: an echo-only card is still tradeable, and both
  // `isPristine` (src/game/logic.ts) and the firestore.rules `boardPristine()`
  // gate read this flag. A manual toggle of the Square clears it (`computeMark`
  // strips `echo` on the toggled cell), so a real Mark can never ride under an
  // echo's pristine exemption.
  echo?: boolean;
  // A Player can explicitly unmark an Echo on this card. Keep that choice on
  // the cell so open-time reconciliation does not add the same Echo back.
  echoOptOut?: boolean;
}

export interface BoardDoc {
  uid: string;
  // Which Day this Board belongs to — one Board per Player per Day
  // (daily-cards-spec § "Data model"). Path wiring for the day-scoped location
  // `events/{eventId}/days/{dayIndex}/boards/{uid}` is added by #204; this
  // field is what lets the dealer look up a Player's earlier Day Cards to
  // exclude repeats across the cruise.
  dayIndex: number;
  seed: number;
  // Last Board seed a normal Mark write was computed against. Firestore rules use
  // this as a stale-write guard after a Reshuffle; legacy rows may omit it.
  markSeed?: number;
  createdAt: number;
  // APP-SIDE shape: length 25, index order. The WIRE shape is a MAP keyed by
  // the canonical decimal index ('0'..'24') since #457 — a Mark writes ONLY
  // its touched cells as a { merge: true } patch, so concurrent devices
  // marking different squares commute instead of clobbering (the class the
  // retired markVersion counter could not close). src/game/cells.ts is the
  // boundary: reads normalize either shape (legacy array docs/caches
  // included), writes emit the map; boardConverter routes through it.
  cells: Cell[];
}

// The durable localStorage card snapshot (#434) — this device's LATEST painted
// card, kept so a transient deal failure renders the saved card instead of the
// reload screen (src/data/cardCache.ts). It is a persisted serialization
// contract shared by the data helper, Board (writer), CachedCardFallback
// (reader), and their tests, so it lives here with the other domain types
// rather than drifting in a component file. The Day subset is DERIVED from
// `DayDef` (never re-declared) and keeps `ThemeId`, so the stored and live Day
// contracts cannot diverge without a type error.
export interface CardSnapshotDay extends Pick<DayDef, 'place' | 'placeEmoji' | 'theme'> {
  number: number; // day.index + 1 (1..10) — the 1-based label the header shows
  label: string; // resolved ThemeMeta label for the header line (themeLabel(theme))
}

export interface CardSnapshot {
  v: number; // schema version — an older blob reads as a miss, never mis-shaped
  uid: string;
  eventId: string;
  dayIndex: number | null; // null for a legacy single board
  savedAt: number;
  bingoCount: number;
  cells: Cell[];
  day: CardSnapshotDay | null; // null for a legacy single-board (no day schedule) Event
}

export interface PlayerDoc {
  uid: string;
  displayName: string;
  photoURL: string | null;
  theme?: ThemeId;
  joinedAt: number;
  // Cruise-wide totals, summed across every Day Card (daily-cards-spec §
  // "Scoring and social surfaces").
  bingoCount: number;
  squaresMarked: number;
  firstBingoAt: number | null;
  blackout?: boolean;
  // How many Reshuffles this Player has spent, CRUISE-WIDE — not per Day (#378,
  // specs/reshuffle.md). Trading a pristine Day Card for a fresh deal costs
  // nothing in the game (a pristine card has produced nothing to undo), so the
  // scarcity lives entirely in this allowance: 3 for the whole sailing, which
  // makes the choice strategic rather than three free re-rolls every morning.
  // Required in the contract so consumers never branch on undefined;
  // `playerConverter` defaults a missing legacy field (every Player row written
  // before #378 — there is no backfill) to 0. firestore.rules holds it MONOTONIC:
  // it only ever rises by exactly 1, never falls, never exceeds 3.
  reshufflesUsed: number;
  // Per-Day breakdown of the same three stats, keyed by dayIndex. Optional —
  // absent until a Player has played a Day; the aggregates above remain the
  // cruise-long leaderboard source.
  dayStats?: Record<
    number,
    { bingoCount: number; squaresMarked: number; firstBingoAt: number | null }
  >;
}

export interface UserDoc {
  displayName: string;
  handle?: string;
  photoURL: string | null;
  customPhoto?: boolean;
  createdAt: number;
  // Honor-system 18+ self-attestation (ADR 0001): the User's own statement,
  // recorded once, not identity verification. Absent until first attested.
  attestedAdultAt?: number; // ms epoch
}

// ---- Phase 1 ----

export type ProofType = 'photo' | 'audio' | 'text';

export interface ProofDoc {
  id: string;
  uid: string;
  displayName: string;
  photoURL: string | null;
  type: ProofType;
  cellIndex: number;
  itemText: string;
  storagePath?: string | null;
  mediaURL?: string | null;
  thumbURL?: string | null;
  text?: string | null;
  createdAt: number;
  reportCount: number;
  // 'pending' = created under admin_confirmed Claim Mode (data/proofs attachProof);
  // admin-only readable per firestore.rules until confirming the Claim flips it
  // to 'active'. A rejected Claim leaves its Proof 'pending' rather than exposed.
  status: 'active' | 'pending' | 'hidden' | 'flagged';
  visionFlag?: string | null; // set by the moderation function for illegal/extreme content
  // Whether the photo came from the live camera or the photo library — stamps
  // the 🖼️ Feed badge on library picks (daily-cards-spec § "Square tap"; #190).
  // Optional: absent on Proofs written before the two-affordance photo body.
  // `null` (not just absent) is in the contract: attachProof ALWAYS writes the
  // key, storing `null` for audio/text/camera picks, so reads must model it.
  source?: 'camera' | 'library' | null;
  // Which Day this Proof belongs to, so the Feed reads "Day 2 · Get Sporty".
  // Optional until the day-scoped claim flow (#211) stamps it; `null` when the
  // write carries no viewed Day (attachProof always writes the key).
  dayIndex?: number | null;
}

export interface ClaimDoc {
  id: string;
  uid: string; // board owner who claimed the square
  displayName: string;
  cellIndex: number;
  itemText: string;
  proofId?: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: number;
  resolvedBy?: string | null;
  // Which Day's board the claimed mark lives on (#246). Present on claims created
  // in daily-cards mode, so `confirmClaim`/`rejectClaim` resolve against the
  // day-scoped board `days/{dayIndex}/boards/{uid}` and fold `dayStats[dayIndex]`.
  // Absent on legacy claims → the single event-level board.
  dayIndex?: number;
}

// ---- Phase 2: social core (Tally / Doubts / Moments) ----

// One Player's attributed entry in a Prompt's Tally. Keyed by the marker's uid
// so unmarking removes exactly that Player's entry. No anonymity (ADR 0002).
export interface TallyEntry {
  uid: string;
  displayName: string;
  markedAt: number; // ms epoch
  // Day-scoped Tally Cards (#216): the Mark's own attributes, stamped so the
  // Feed can group markers of the SAME `(itemId, dayIndex)` into one live Tally
  // Card and label it. Optional/back-compat — legacy per-Prompt markers written
  // before #216 carry neither, so they contribute to the Square badge (`useTally`
  // counts every marker of the Prompt) but never form a day-scoped Feed card.
  // `itemText` is denormalized here (the marker path carries only `itemId`) so a
  // Tally Card can render "…got 'Balcony or porthole photo'" without a pool read.
  dayIndex?: number;
  itemText?: string;
}

// One live Tally Card in the Feed (#216): a derived, per-`(itemId, dayIndex)`
// aggregation of the Prompt's markers — NOT a stored record. The Feed renders one
// once anyone marks the Prompt on a Day and drops it when the group empties. Its
// `count`/names/avatars are the LIVE tally; `lastMarkedAt` is DERIVED as the max
// of the group's marker times (the parent `tally` doc is admin-only-write, so a
// Mark cannot stamp it client-side). `displayBump` is the debounced sort key the
// merge orders on (see `nextDisplayBumpTime`) so a hot square can't churn the Feed.
export interface TallyCard {
  itemId: string;
  dayIndex: number;
  itemText: string;
  count: number;
  markers: TallyEntry[]; // chronological (earliest first), like `useTally`
  lastMarkedAt: number; // max(marker.markedAt) over the group
  displayBump: number; // debounced Feed-position time (>= its previous value)
}

// The public, attributed per-Prompt Tally: who has marked a given Prompt, plus
// the denormalized count for the Square badge (ADR 0002). Keyed by itemId; every
// Mark — proofed or not — publishes here, even though the Board stays private.
export interface TallyDoc {
  itemId: string; // the Prompt this Tally aggregates
  count: number; // number of Players who have marked the Prompt
  markers: TallyEntry[];
  // ms epoch of the most recent Mark, so the Feed can re-sort a Tally Card
  // toward the top as new Players get the Prompt. Optional until a day-scoped
  // consumer stamps it.
  lastMarkedAt?: number;
  // Which Day this Tally aggregates — a Mark of "Lost passport" on Tuesday's
  // card is a different Tally entry than Thursday's (daily-cards-spec § "Data
  // model"). Optional until the day-scoped surfaces stamp it.
  dayIndex?: number;
}

// One Player publicly asking another to back up a marked Prompt ("pics or it
// didn't happen") — social pressure, never a gate (ADR 0001). It never blocks,
// unmarks, or discounts the Mark. Attaching a Proof satisfies it, so `satisfied*`
// tracks open vs answered without gating play.
// A Heart (specs/feed-hearts.md): one Player's like on a Feed post — a Proof
// or a Moment (Tally Cards are derived aggregates, not posts, and take no
// hearts). ONE slot per (Player, post): the doc id IS
// `${uid}_${targetKind}_${targetId}` — the same deterministic-slot shape as a
// Doubt — so a Player can heart many posts but each post only once; toggling
// off is a delete, never an update (a Heart is immutable). Carries no
// displayName (nothing to misattribute, so no identityKnown gate): counts are
// derived client-side from this collection's live size, per ADR 0001.
export type HeartTargetKind = 'proof' | 'moment';

export interface HeartDoc {
  id: string;
  uid: string; // the Player who hearted
  targetKind: HeartTargetKind;
  targetId: string; // the hearted Proof/Moment doc id
  // The hearted post's OWN createdAt — the incarnation stamp (Codex P2 on
  // #425): Moment ids are deterministic and a deleted Moment can be
  // recreated at the same id, so a Heart binds to the specific document it
  // was given to (rules verify this against the live target), and the
  // display filters by it. A recreated post starts at zero hearts.
  targetCreatedAt: number;
  createdAt: number; // ms epoch
}

export interface DoubtDoc {
  id: string;
  itemId: string; // the doubted Prompt
  cellIndex: number; // the doubted Square on the target's Board
  fromUid: string; // the Player raising the Doubt
  fromDisplayName: string;
  targetUid: string; // the Player whose Mark is doubted
  targetDisplayName: string;
  createdAt: number; // ms epoch
  satisfiedAt?: number | null; // set when a Proof answers the Doubt
  satisfiedProofId?: string | null;
  // Which Day the doubted Mark is on, so day-scoped surfaces stay per-Day.
  // Optional until the day-scoped Doubt flow stamps it.
  dayIndex?: number;
}

// The finale adds two scheduler-posted beats (daily-cards-spec § "Scoring and
// social surfaces"): `last_call` at 20:00 on Day 9 (going-into-the-final-night
// standings) and `podium` at the 08:00 Day 10 freeze (champion + honors).
export type MomentKind =
  | 'bingo'
  | 'blackout'
  | 'first_bingo'
  | 'last_call'
  | 'podium';

// A broadcast announcement of a big social beat, posted to the Feed for everyone
// (ADR 0002). Unlike a Proof it carries no attached evidence — it marks *that*
// something happened, not what it looked like; a bare Mark broadcasts nothing.
export interface MomentDoc {
  id: string;
  kind: MomentKind;
  uid: string;
  displayName: string;
  photoURL: string | null;
  createdAt: number; // ms epoch
  // Which Day this beat belongs to, so the Feed reads "BINGO — Day 4 ·
  // Glamiators". Optional until the day-scoped Moment writers stamp it.
  dayIndex?: number;
  // #266 — the finale beats' CONTENT, written by the scheduler
  // (functions/src/unlockDay.ts). `line` is the last-call standings copy
  // ("X leads by 2 bingos—standings freeze at 8 a.m."); `podium` is the
  // Day-10 freeze payload. Both optional: an older minimal beat (or a
  // content-build failure) renders the generic line.
  line?: string;
  lastCall?: LastCallMomentPayload;
  podium?: PodiumMomentPayload;
}

export interface LastCallMomentPayload {
  players: { uid: string; displayName: string; bingoCount: number; squaresMarked: number }[];
}

// The podium Moment's payload (#266) — the shape
// functions/src/finaleContent.ts buildPodiumPayload writes.
export interface PodiumMomentPayload {
  champion: { uid: string; displayName: string; bingoCount: number; squaresMarked: number } | null;
  firstBingo: { uid: string; displayName: string; at: number } | null;
  dailyHonors: { dayIndex: number; uid: string; displayName: string; at: number }[];
}

// A Notice (specs/admin-messages.md): an admin-authored broadcast — title + body,
// optionally pinned — posted to the shared Feed for everyone (ADR 0002). Unlike a
// Moment, which marks *that* a game beat happened and carries no authored copy, a
// Notice carries the admin's own words; unlike a Proof it has no evidence, no
// report counter, and no threading. A pinned Notice sorts to the very top of the
// Feed and shows once as a dismissible Card-tab banner; unpinning demotes it into
// the stream at its `createdAt`. It carries its own doc id (the Feed keys on it),
// read from events/{eventId}/notices/{noticeId}.
export interface NoticeDoc {
  id: string;
  title: string; // ≤ 60 chars (firestore.rules cap)
  body: string; // ≤ 400 chars (firestore.rules cap)
  uid: string;
  displayName: string;
  createdAt: number; // ms epoch
  // Which Day this Notice was posted on, stamped from the event's current Day at
  // post time (Moment-style). Optional so a legacy/minimal doc still renders.
  dayIndex?: number;
  pinned: boolean;
  // When the copy was last corrected in place (#455). Absent on a never-edited
  // Notice — so every doc written before Edit shipped stays valid with no
  // backfill. Present means the Feed card and the admin history show "edited":
  // a delivered broadcast may be corrected, never silently rewritten.
  editedAt?: number; // ms epoch
}

// Per-Day honor doc at events/{eventId}/days/{dayIndex}/meta/{dayIndex} — a
// `meta` subcollection holding one document whose id IS the encoded dayIndex,
// so the shape carries no id field (the path above is a valid document path:
// events/days/meta are the three collection segments, each with its id). Holds
// that Day's own First to BINGO, pinned on the Day's board view and the honors
// strip (daily-cards-spec § "Data model" / "Scoring and social surfaces").
// Every Day gets its own daily honor, tutorial Days included; the cruise-wide
// First to BINGO's exclusion of tutorial Days is a query-time filter in #212,
// not a distinction at this type level.
export interface DayMetaDoc {
  firstBingo?: { uid: string; displayName: string; at: number };
}
