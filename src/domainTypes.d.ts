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
   *  daily-cards-wireframes § in-app header lockup). Optional because it is
   *  carried only by Editions OF the platform: Vacay (#647) and Gay Cruise
   *  Bingo (#688) both wear it, while Five Across IS the platform, so an
   *  endorsement of itself would be noise. */
  wordmarkByline?: string;
  preEventVerb: string;
  /** The glyph on the pre-event header line ("⚓ Sails Jul 15", #881), paired
   *  with `preEventVerb` since both are pre-cruise-only header copy. NOT a
   *  universal ⚓ (Codex P2, PR #896 round 1): an anchor is cruise-specific
   *  decoration, so hardcoding it for every Edition leaked the GCB nautical
   *  register into vacay and fiveacross the same way a hardcoded cruise
   *  noun would — `dayIdentity.tsx` reads this field instead. */
  preEventGlyph: string;
  tagline: string;
  /** The gate's voice line ("Take the detour. For the story.") — the italic
   *  chip the wireframes draw inside the Join lockup (#647, § Join). Optional
   *  because only vacay's frame carries one; when present it REPLACES the
   *  plain `tagline` on the signed-out gate, which the wireframe omits there. */
  signinTaglineChip?: string;
  /** A second, ADDITIVE voice chip (#881, gcb/fiveacross Join frames) — same
   *  italic slot as `signinTaglineChip`, drawn ABOVE it rather than instead
   *  of it: both frames keep their own `.desc` tagline line right below the
   *  chip. Deliberately a separate field, not a reuse of `signinTaglineChip`
   *  with a modifier flag — that field's whole contract is "replaces the
   *  tagline," which is true for vacay alone; giving gcb/fiveacross a
   *  same-named field with different behavior would make the one field mean
   *  two things depending on which brand sets it. */
  signinVoiceChip?: string;
  /** The invitation copy block under the Join CTA ("Prompts are invitations,
   *  not chores…"). Optional: only the vacay frame draws it. */
  signinInviteNote?: string;
  /** How the gate's Event-preview card is dressed: `'postcard'` adds the
   *  dashed stamp corner the wireframes give the vacay Join frame; absent
   *  draws the plain panel gcb and fiveacross use. A STRING variant rather
   *  than a boolean so editions.test.ts's every-field-is-a-nonempty-string
   *  exhaustiveness sweep covers it like any other brand field. */
  signinCardVariant?: 'postcard';
  /** A fixed per-Edition stamp glyph for the gate's Event-preview corner
   *  (#881: "postage on every gate" — 🏳️‍🌈 on gcb, ✳️ on fiveacross, its own
   *  share mark). Deliberately NOT the 💒 the wireframe's fiveacross sample
   *  happens to render (Codex P2, PR #896 round 1): fiveacross is the
   *  occasion-neutral platform Edition, so a wedding glyph baked into the
   *  Edition-level brand table would leak onto every OTHER occasion's gate
   *  (a conference, a birthday) that Edition equally supports — the sample's
   *  identity, not the brand's. Distinct from `signinCardVariant: 'postcard'`,
   *  which is vacay's OWN postage and stays dynamic — it stamps whichever Day
   *  the preview is currently showing (`previewDayEmoji`), not a fixed brand
   *  mark. When set, this
   *  glyph wins over the dynamic one (`EventPostcard.tsx`) and must never
   *  repeat an emoji already drawn elsewhere on that gate screen. */
  signinStampGlyph?: string;
  /** The Join gate's / in-app offline note: ADR 0006's routine-dead-zone
   *  promise ("your card keeps working offline, marks sync when you
   *  reconnect"). NOT the total-failure fallback — that is
   *  `crashFallbackNote` below, a deliberately separate field (Codex P2, PR
   *  #896 round 2): `ErrorBoundary.tsx` used to reuse this same string for
   *  its crash panel, so #881's rewrite of gcb's copy (dropping the printed-
   *  cards/PDF claim, correct for the routine case) silently regressed the
   *  crash panel's accepted launch-critical fallback message
   *  (`specs/x-launch-checklist.md` § "Printed 12-card PDF fallback"). */
  offlineNote: string;
  /** The crash panel's OWN fallback line (`ErrorBoundary.tsx`), read instead
   *  of `offlineNote` when set. Optional: only gcb has a printed-card
   *  tradition to point to (`specs/x-launch-checklist.md`); an Edition
   *  without one falls back to the routine `offlineNote` — imperfect for a
   *  total failure, but no worse than before this field existed, and no
   *  Edition regresses a documented contract it never had. */
  crashFallbackNote?: string;
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
  /**
   * The warm-up Day's flavor line ONLY — "This one's a warm-up—easy squares,
   * close to home." The schedule sentence that used to close it ("The real
   * chaos starts tomorrow at 8") moved to `chaosLine` in `src/unlockCopy.ts`
   * (#670): it was identical across every Edition and hardcoded an 08:00
   * unlock, so it contradicted any schedule opening at another hour. Editions
   * own the flavor; the app owns the clock.
   */
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
  | 'afterglow'
  // Five Across platform chrome (#882). Registered like the trio above —
  // same contrast contract, same THEME_EDITIONS binding to `fiveacross` —
  // but flagged `ThemeMeta.chrome: true` and filtered out of
  // `themesForEdition`'s picker output: it dresses surfaces that have no
  // Day (utility states, the admin console, email, the gallery/share
  // surfaces outside a Day context), not a Day a player can wear. See
  // specs/w1-themes.md § Registry vs. picker.
  | 'fiveacross-slate';

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
  /**
   * This Day's Scoring Policy (ADR 0011, CONTEXT.md § Scoring Policy): whether
   * its Marks count toward the Event standings. STATED here, never inferred
   * from `pool` — a Day's Pool identity, its Tutorial framing and its Scoring
   * Policy are three independent facts, and a weekend Event's final morning can
   * be real competitive play on the closing pool.
   *
   * Optional in the contract because every doc written before ADR 0011 has no
   * such key, and BOTH live Events are such docs. Never read directly: resolve
   * through `scoringForDay` (src/game/scoring.ts, or the Functions mirror
   * `functions/src/scoringVocab.ts`), which falls back to the closing-pool
   * derivation the old comparisons hard-coded, so legacy Days resolve exactly
   * as they did before. `eventConverter` fills it on read for the same reason
   * `migrateDayFields` fills `place`/`pool`; raw-hydrated paths still resolve
   * at comparison time, which is why the resolver — not this field — is the
   * contract consumers hold.
   */
  scoring?: 'competitive' | 'ceremonial';
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

/** One co-winner of the Most-Loved Photo award (#534/#560,
 *  specs/most-loved-photo.md). All fields are copied from the winning
 *  `ProofDoc` AT the freeze; no media URL is persisted ON PURPOSE — display
 *  always re-joins the LIVE Proof doc (`mostLovedDisplayWinners`,
 *  src/data/mostLoved.ts), so a later-hidden photo can never be rendered from
 *  a stale stored URL. */
export interface MostLovedPhotoWinner {
  proofId: string;
  uid: string;              // owner
  displayName: string;      // ProofDoc.displayName at freeze
  promptText: string;       // ProofDoc.itemText
  dayIndex: number | null;  // ProofDoc.dayIndex ?? null
  proofCreatedAt: number;   // incarnation stamp (ProofDoc.createdAt) — the display join key
}

/** The frozen Most-Loved Photo result (#560). Field ABSENT = not yet computed
 *  (the scheduler beat's idempotence key). Present with `winners: []` =
 *  computed, no award — an explicit record, so a post-freeze heart can never
 *  mint a late award (the "never recomputes" rule). `winners` retains a
 *  deterministic bounded prefix; `winnerCount` records the complete tied
 *  cardinality so an extreme tie cannot exceed Firestore's Event-doc limit. */
export interface MostLovedPhotoAward {
  winners: MostLovedPhotoWinner[]; // first 100 co-winners, ordered proofCreatedAt asc, then proofId asc
  winnerCount?: number;            // complete tied cardinality; absent on records written before the bounded format
  heartCount: number;              // frozen eligible count shared by all winners; 0 when winners is []
  frozenAt: number;                // the freeze cutoff computed against (== EventDoc.frozenAt value)
  computedAt: number;              // scheduler run clock, diagnostics only
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
  /**
   * The CONFIGURED Standings Freeze (ms epoch, ADR 0011): the moment this
   * Event's competitive scoring stops and the podium is computed. An Event
   * setting, not a Day one — the freeze is a property of the Event's shape,
   * and tying it to the closing Day's `unlockAt` is what made a competitive
   * final morning unrepresentable.
   *
   * Named at arm's length from `frozenAt` on purpose: this is the SCHEDULE,
   * `frozenAt` is the STAMP recording that it happened. `freezeAt`/`frozenAt`
   * one character apart in the same interface is a bug waiting to be written.
   *
   * Optional because no doc written before ADR 0011 carries it. Never read
   * directly: resolve through `standingsFreezeAtFor` (src/game/logic.ts),
   * which falls back to the first ceremonial Day's `unlockAt` — the instant the
   * old derivation used — so both live Events freeze at exactly the same
   * moment they always did. An Event with neither a stored value nor a
   * ceremonial Day has no scheduled freeze, which is the pre-Phase-1.5
   * "legacy events never freeze" behaviour, unchanged.
   */
  standingsFreezeAt?: number;
  // Finale freeze stamp (ms epoch): set by the Day 10 08:00 scheduler run when
  // the standings freeze and the podium Moment posts. Absent until the finale.
  frozenAt?: number;
  // The frozen Most-Loved Photo award (#534/#560, specs/most-loved-photo.md):
  // computed and persisted exactly once by the same scheduler sweep that stamps
  // `frozenAt`, as a sibling field because the award is Event-level frozen
  // state exactly like the freeze stamp. ABSENT = not yet computed; present
  // with `winners: []` = computed, no eligible winner (the explicit no-award
  // record the write-once guard needs). Never recomputed after it exists.
  mostLovedPhoto?: MostLovedPhotoAward;
  // Presentational, event-scoped hide/mute of a Player's content (ADR 0004
  // Phase 0) — NOT hard access revocation. An admin-maintained roster of banned
  // uids kept on the (already admin-writable) event doc; a follow-up (#108) will
  // filter their content client-side, mirroring the reportHideThreshold
  // auto-hide, never gate posting or reads server-side (that is #43/#44). Required
  // in the contract so consumers never branch on undefined; `eventConverter`
  // defaults a missing legacy field (event docs seeded before #113) to [].
  bannedUids: string[];
  /**
   * The per-Event membership enforcement switch (specs/event-membership.md,
   * epic #801). `'enforced'` means this Event's rules require an admission
   * record at `events/{eventId}/memberships/{uid}`; anything else — including
   * ABSENT — means they do not.
   *
   * Optional, and absent MUST read as `'off'`: every Event document in
   * existence predates this field, and both live cohorts joined by
   * self-creating their `players` row, so a deploy that read a missing field as
   * "enforce" would lock every current player out mid-Event. Safety comes from
   * the rollout being explicit per Event (#805), not from the default. Never
   * read directly — resolve through `membershipEnforcementFor`
   * (`src/data/eventMembership.ts`), which is the only place the default lives.
   *
   * WHY IT LIVES ON THIS DOCUMENT rather than beside the memberships it gates:
   * `storage.rules` may make at most TWO Firestore ACCESSES per evaluation
   * (calls, not distinct paths), and the membership check itself spends one.
   * A switch on any third document would be unreadable from Storage, so the
   * only reachable home is a document the Storage predicate already fetches —
   * this one, which `isEventAdmin()` (`storage.rules:7-10`) already reads.
   *
   * NOT CLIENT-WRITABLE, and that is not yet true: the `events/{eventId}`
   * update rule has no key whitelist, so until #804 adds an immutability
   * clause an Admin could flip it. That clause is one more expression on a rule
   * that already exceeds Firestore's 1,000-expression cap at ten Days (#850),
   * which is why the spec records #850 as a prerequisite of #804 rather than an
   * unrelated bug.
   */
  membershipEnforcement?: MembershipEnforcement;
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
  // Monotonic revision for Admin corrections to `spicy`. Absent on legacy
  // Prompts means 0. The Approvals queue uses it only as an acknowledgement
  // boundary: once its subscription reaches the revision returned by its own
  // transaction, the optimistic checkbox can retire without masking a newer
  // correction from another Admin.
  spicyRevision?: number;
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
  // The Day this Prompt is intended for (#557, specs/community-prompt-targeting.md).
  // ABSENT is the untargeted case and means EVERY not-yet-snapshotted Day — the
  // organiser/seed pool, and every Prompt written before this field existed, so
  // the grandfathered behaviour is exactly what it always was. PRESENT means this
  // Prompt is a Community Prompt aimed at that one Day and is admitted to that
  // Day's snapshot alone. A Player sets it at submission ("put it on tomorrow's
  // card"); an organiser re-points it forward at approval when the intended Day's
  // cutoff has already passed. It is never re-pointed backwards, and re-pointing
  // it never touches a Day — a Day that has already frozen its snapshot is
  // immutable, so an unreachable target is how retention is expressed.
  targetDayIndex?: number;
  // Stamped at approval when NO eligible Day remained (#557). The Prompt stays
  // `active` with its original — now unreachable — `targetDayIndex`, so it is
  // retained in the pool for the recap or a reusable pack and is never dealt and
  // never deleted. Presence is the durable "approved but not selected" fact, so
  // no consumer has to re-derive it from the Day schedule.
  retainedAt?: number; // ms epoch
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
  // A monotonic generation assigned each time Echo Marks auto-marks this
  // square. Together with the Board seed and cell index it identifies one
  // durable transition even after a player unmarks and later re-earns it.
  echoGeneration?: number;
  // Present only for Echo transitions that advance the receiving Day's
  // `squaresMarked` bucket. This is the analytics reconciliation key; delivery
  // is allowed to retry across reloads and devices, so raw events are grouped
  // by this persisted id rather than deduplicated in browser storage.
  echoAnalyticsId?: string;
  // The propagation path that CREATED `echoAnalyticsId`. Open-time recovery
  // replays this original trigger, rather than reclassifying a deal/mark echo
  // as an `open_reconcile` event merely because another device delivered it.
  echoAnalyticsTrigger?: 'deal' | 'reshuffle' | 'mark' | 'open_reconcile' | 'admin_confirm';
  // A Player can explicitly unmark an Echo on this card. Keep that choice on
  // the cell so open-time reconciliation does not add the same Echo back.
  echoOptOut?: boolean;
  // This Square's Prompt is a Community Prompt (#559 on #557's targeting
  // model): the picked ItemDoc carried a USABLE `targetDayIndex` at deal
  // time. Denormalized onto the Cell — same idiom as the `echo*` fields
  // above — so Board can paint the "new from the group" affordance on all 25
  // Squares without re-enabling a live item-pool subscription once a Board
  // is dealt (`useItems(!board)` stays disabled post-deal; see Board.tsx).
  // Computed once, at deal time, by `dealBoard` (src/game/logic.ts); never
  // recomputed later, so a Prompt that was later retained/re-approved does
  // not retroactively relabel a card already dealt from it.
  communityPrompt?: boolean;
  // The Community Prompt's submitter uid (#559), denormalized alongside
  // `communityPrompt` for the same reason. Prompt-detail attribution
  // ("Suggested by [player]", ProofSheet.tsx) resolves this uid's display
  // name with a single one-shot read when the sheet opens — never a live
  // subscription. Absent on every non-community Square (organiser/seed
  // content has no submitter to attribute).
  suggestedBy?: string;
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
  // The latest direct Board-toggle request. A server trigger compares its
  // changed token with the committed before/after cell state and records an
  // analytics transition only when the server actually observed that edge.
  // This stays on the Board (rather than a cell) so it cannot be mistaken for
  // a later proof/admin/echo write that happens to reuse the same cell.
  directAnalyticsRequest?: {
    id: string;
    cellIndex: number;
    marked: boolean;
    mode: ClaimMode;
    source: 'pledge' | 'proof' | 'admin_confirm';
  };
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
  // The freeze-time phrase ("standings freeze at 8 a.m"), computed ONCE by the
  // scheduler (functions/src/finaleContent.ts freezePhraseForUnlock) from the
  // Event's actual closing-Day unlockAt in its own timezone, and persisted
  // here so the client's ban-aware reconstruction (src/lastCallCopy.ts) reads
  // the SAME string rather than an independently hardcoded literal (#800).
  // Absent on a Moment posted before #800 — a legacy last-call Moment falls
  // back to the historical literal.
  freezePhrase?: string;
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

// ---- Phase 5: self-service Event setup (specs/event-setup-wizard.md) ----
//
// The organizer wizard's working state. Deliberately appended as its own
// section rather than woven in beside `EventDoc`: nothing here is a Firestore
// document, and #531 (ADR 0011 `DayDef.scoring` / `EventDoc.standingsFreezeAt`)
// is editing this file mid-body at the same time.
//
// SCOPE NOTE (#787, updated by #551). `DayDef.scoring` and
// `EventDoc.standingsFreezeAt` have LANDED on the contract above (ADR 0011) and
// `scripts/seed-data/bodega-bay-2026.mjs` writes both. `DraftDayDef`/`EventDraft`
// still carry NEITHER — what remains deferred is the wizard's AUTHORING of them,
// not the vocabulary. An organizer therefore cannot yet state a Scoring Policy
// or a freeze; the launch provisioner writes neither, and both fall back to the
// read-resolution (`scoringForDay`, `standingsFreezeAtFor`), which derives them
// from the closing pool exactly as today. Adding them to the draft needs a
// `DRAFT_SCHEMA_VERSION` bump (an older stored draft then reads as a miss) and
// a matching relaxation of `finaleClosingPoolIssues`, which still requires the
// final Day to carry the closing pool.

/** Which wizard step a draft was last standing on, so Resume is lossless.
 *  Named for the frames (`#frame-setup-occasion` … `#frame-setup-launch`)
 *  rather than numbered, so re-ordering the rail is not a data migration. */
export type SetupStep = 'occasion' | 'basics' | 'squares' | 'look' | 'launch';

/** The six occasions of `#frame-setup-occasion`. `custom` starts bare. */
export type OccasionId =
  | 'weekend-away'
  | 'city-break'
  | 'wedding'
  | 'conference'
  | 'cruise'
  | 'custom';

/**
 * Step 3's "Card format" segment. `daily_cards` is an Event with an ordered
 * `days[]`; `one_card` is an Event with an EMPTY `days[]` — the legacy
 * single-Board shape ("One card, one celebration", the Wedding occasion).
 * The distinction is load-bearing for validation: every Day-shaped predicate
 * (the ten-Day ceiling, the closing-pool finale, the future first unlock,
 * per-Day completeness) is scoped to `daily_cards`, because a one-card Event
 * has no Day to fail them.
 */
export type DraftCardFormat = 'one_card' | 'daily_cards';

/**
 * One authored main-pool Prompt. `spicy` is REQUIRED here and representable
 * ONLY here (#785): `adminAddItem` forces `spicy: false` outside the main pool
 * and the 18+ posture derivation ignores non-main pools, so a spicy toggle
 * offered on an easy/closing Prompt is silently dropped — an explicit Square
 * reaching a card with no 18+ gate.
 */
export interface DraftMainPrompt {
  text: string;
  spicy: boolean;
}

/**
 * One authored easy- or closing-pool Prompt. `spicy?: never` is the type-level
 * half of the same #785 rule: `{ text, spicy: true }` does not typecheck as a
 * curated Prompt at all. The runtime half is `promptPoolIssues`, which guards
 * the JSON-parse path a type cannot reach.
 *
 * `never` here means "no DEFINED value", not "no key". Because this project
 * does not enable `exactOptionalPropertyTypes`, `{ text, spicy: undefined }`
 * still typechecks — and `JSON.stringify` drops that property, so a key-
 * presence rule would change the draft's launch validity across a save/load
 * round-trip. Both runtime guards (`isCuratedPrompt`, `promptPoolIssues`)
 * therefore test the VALUE, making `spicy: undefined` and an absent key
 * identical on either side of serialization (#787 review).
 */
export interface DraftCuratedPrompt {
  text: string;
  spicy?: never;
}

/**
 * The draft's Prompts, keyed BY pool — the key is the pool, so no entry
 * carries a redundant `pool` field that could disagree with the list it sits
 * in. Every pool is present even when empty, so `assignedPoolIssues` can count
 * a pool a Day names but nobody filled.
 */
export interface DraftPromptPools {
  main: DraftMainPrompt[];
  easy: DraftCuratedPrompt[];
  closing: DraftCuratedPrompt[];
}

/**
 * One Day under construction. A Day is NOT a calendar date (#785): Bodega runs
 * two Days on 2026-08-09 (competitive main at 06:00, closing wrap-up at
 * 11:00), so `date` is deliberately NOT unique across the list and `index` is
 * the identity.
 *
 * `pool` and `theme` are DERIVED from `DayDef` rather than re-declared, so the
 * draft's vocabulary cannot drift from the launched Day's — the same posture
 * `CardSnapshotDay` takes with its `Pick<DayDef, …>`.
 */
export interface DraftDayDef {
  /** Position in the schedule, 0-based and contiguous. Not a date. */
  index: number;
  /** ISO date, event-local. Two Days MAY share one date. */
  date: string;
  /**
   * The absolute unlock instant (ms epoch), or `null` while unset. Interpreted
   * in `EventDraft.timezone`, never the organizer's own zone (#785).
   * The `0` open sentinel is representable but not launchable from the wizard:
   * it only works alongside an atomically pre-stamped snapshot, which no
   * client can write — see `firstUnlockIssues`.
   */
  unlockAt: number | null;
  /** Required per Day, and has NO Admin editor after creation (#785). */
  place: string;
  placeEmoji: string;
  /** A REGISTERED `ThemeId` (`THEMES` + a `themes.css` block); `null` until
   *  picked. There is deliberately no custom-theme value. */
  theme: DayDef['theme'] | null;
  /** What this Day deals from. Independent of `tutorial`. */
  pool: DayDef['pool'];
  /**
   * Excludes the Day from the Event-wide First to BINGO honour — and NOTHING
   * else. INDEPENDENT of `pool` (#785: Bodega's easy-pool Friday is
   * `tutorial: false`; only the wrap-up is `true`), and a different set from
   * "ceremonial" for standings (`ceremonialDayIndexSet`), which the wizard
   * does not author. One control labelled for both would set neither.
   */
  tutorial: boolean;
  /** EXACTLY two entries at launch (#785) — the card, locked tease, schedule,
   *  leaderboard and share copy all render them. */
  tonight: string[];
  /** This Day's Free Space override; falls back to `EventDraft.freeSpaceText`. */
  freeText?: string;
}

/**
 * The `EventDoc.settings` block the launch provisioner writes.
 *
 * DERIVED from `EventDoc['settings']` — so a draft can never carry a setting
 * the Event contract has no home for — and `Required`, because "absent means
 * apply the call-site default" is a posture for documents seeded before a
 * field existed, not for a flow whose entire job is to decide. In particular
 * `dailyEmailEnabled` is here precisely because it defaults false and has NO
 * Admin control (#785): an Event created through a flow that never collects it
 * can never send the documented daily email without a direct Firestore write.
 */
export type EventDraftSettings = Required<
  Pick<
    EventDoc['settings'],
    | 'reportHideThreshold'
    | 'spicyRatio'
    | 'easyMixRatio'
    | 'forceAdult'
    | 'photoProofSource'
    | 'stripPhotoExif'
    | 'visionGate'
    | 'dailyEmailEnabled'
  >
>;

/**
 * A device-local, unlaunched Event under construction (#786 Decision 1, PRD
 * § Event creation flow). Not a Firestore document: `EventDoc.status` admits
 * only `active`/`archived`, there is no draft collection, and a client cannot
 * bootstrap its own Admin grant — so this shape is persisted through
 * `EventDraftStore` (`src/data/eventDraft.ts`) and never through the network
 * seam.
 *
 * A draft NEVER HOLDS A CLAIMED SLUG. There is no `slug`, `eventId`, or
 * `hostname` field, and `parseEventDraft` reads a stored blob carrying any of
 * those as a MISS rather than repairing it — the transactional claim happens
 * once, at launch, in the provisioner (#793).
 */
export interface EventDraft {
  /** Stored-shape version. A blob written by another version reads as a MISS,
   *  never as a mis-shaped draft — the ADR 0009 / `CardSnapshot.v` convention. */
  v: number;
  /** Device-local identity. NOT an Event id: no Event exists until launch. */
  draftId: string;
  createdAt: number;
  updatedAt: number;
  /** Where Resume reopens. */
  step: SetupStep;
  /** `null` until Step 1 picks one. */
  occasion: OccasionId | null;
  /** The Edition the players will see, COPIED from the occasion at selection
   *  time rather than re-derived on read, so editing the matrix cannot restyle
   *  a draft that is already half-built. */
  edition: string;
  name: string;
  /** ISO dates. The Event's window; the Day schedule is authored separately
   *  and is not derived from it (a Day is not a calendar date). */
  startsOn: string;
  endsOn: string;
  /**
   * The IANA zone the whole schedule is interpreted in. Organizer-EDITABLE and
   * only auto-SUGGESTED (#785): auto-detecting the organizer's own zone
   * silently provisions a destination Event hours off, which is the common
   * case for a trip planned from home.
   */
  timezone: string;
  /** The address the organizer is TRYING for — checked live, claimed only at
   *  launch. Never a claim, and never renamed to a silent variant. Format and
   *  reserved-name validation are #790's shared contract, not this type's. */
  slugCandidate: string;
  /**
   * The Edition `slugCandidate` was last CONFIRMED available against, or `''`
   * when it has not been confirmed at all (Phase 4b P1, PR #911).
   *
   * The wizard's Continue gate is pure and synchronous, so it cannot await a
   * network read — it can only inspect what is already in the draft. Presence
   * of `slugCandidate` alone was therefore doing two jobs: recording the
   * organizer's choice AND standing in for "this address is claimable". Those
   * came apart in two ways. A resumed step paints an already-committed
   * candidate as available with no read (deliberate: it must not block
   * Continue on a round trip), so an organizer advancing inside the debounce
   * carried a candidate nothing had verified. And an Edition change alters
   * WHICH hostnames a launch claims, so a candidate confirmed under one
   * Edition says nothing about another.
   *
   * Storing the Edition rather than a boolean answers both with one field: the
   * gate requires `slugVerifiedForEdition === edition`, which is false for an
   * unverified candidate and false again the moment the Edition moves.
   */
  slugVerifiedForEdition: string;
  /** Required, three real values — a flow that never asks hard-codes Honor. */
  claimMode: ClaimMode;
  cardFormat: DraftCardFormat;
  /** Player-facing social metadata only. The CREATOR is granted Admin, and
   *  that grant — not this string — authorizes every setup write (#785). */
  hostedBy: string;
  /** Required on the launched Event, independent of every `DayDef.theme`, and
   *  what a new player sees first. `null` until picked. */
  defaultTheme: ThemeId | null;
  //
  // THERE IS NO EVENT-LEVEL FREE SPACE FIELD, deliberately. The Free Space
  // text is the build-time `FREE_TEXT` constant in `src/data/seed.ts`
  // (`dealBoard(pool, day.freeText ?? FREE_TEXT, …)`); `EventDoc` has no
  // per-Event home for it, so a draft field would have nowhere to land at
  // launch. `#frame-setup-look` agrees — it offers "Free space, per day" and
  // nothing Event-wide. Per-Day copy lives on `DraftDayDef.freeText`.
  //
  prompts: DraftPromptPools;
  /** Empty for `one_card`; 1..10 Days for `daily_cards`. */
  days: DraftDayDef[];
  settings: EventDraftSettings;
}

/** The schedule an occasion PROPOSES. Shape only — turning it into absolute
 *  `unlockAt` instants needs the Event timezone and belongs to Step 4 (#792). */
export interface OccasionScheduleShape {
  /** 1..10. The ceiling is a rules fact (`daysThemeLockOk` unrolls 0–9). */
  dayCount: number;
  /** Local time-of-day each Day opens, `HH:MM` in the Event's timezone. */
  unlockTime: string;
  /** The opener's pool — `easy` for a warm-up card, else `main`. */
  firstDayPool: DayDef['pool'];
  /** The finale's pool. `closing` or `finaleTimes` returns null and there is
   *  no standings freeze, no podium and no Most-Loved. */
  finalDayPool: DayDef['pool'];
  /** Whether the opener is excluded from Event-wide First to BINGO.
   *  SEPARATE from `firstDayPool` on purpose (#785). */
  firstDayTutorial: boolean;
  finalDayTutorial: boolean;
}

/** Everything an occasion pre-fills. Every one of them is changeable before
 *  launch — the occasion is a starting point, not a mode. */
export interface OccasionDefaults {
  cardFormat: DraftCardFormat;
  claimMode: ClaimMode;
  /** `null` when the occasion proposes NO Days at all — a one-card Event has
   *  no schedule, and "Custom" starts bare on purpose. */
  schedule: OccasionScheduleShape | null;
  /** The Event's `defaultTheme`. Must be registered AND in this occasion's
   *  Edition (`themesForEdition`). */
  defaultTheme: ThemeId;
  /** Proposed per-Day Themes, in Day order. Empty when `schedule` is `null`.
   *  May be SHORTER than `dayCount` (Step 4 repeats the tail, exactly as
   *  Bodega's two Sunday Days share one Theme). */
  dayThemes: readonly ThemeId[];
  settings: EventDraftSettings;
}

/**
 * One row of `#frame-setup-occasion`, and the matrix entry behind it.
 *
 * CONTENT OWNERSHIP IS OPEN (#786 Decision 2): who authors and maintains the
 * starter packs is an owner call, so `starterPackId` is `null` for every
 * occasion whose pack does not exist yet. `null` is the honest value — an
 * invented id would read as a promise that something is there.
 */
export interface OccasionDef {
  id: OccasionId;
  /** Row label, verbatim from the frame. */
  label: string;
  /** Row subtitle, verbatim from the frame. */
  blurb: string;
  emoji: string;
  /**
   * The Edition an Event created from this occasion wears — what the PLAYERS
   * see. The wizard chrome stays Five Across regardless (the one-identity
   * rule). Whether that Edition also owns an alternate Namespace is an Edition
   * fact and deliberately NOT modelled here: the alternate is optional, not
   * guaranteed (#785), and the namespace table belongs to Steps 2/5 (#790,
   * #793).
   */
  edition: string;
  /** The seeded pack, or `null` while unowned. */
  starterPackId: string | null;
  defaults: OccasionDefaults;
}

// ---- Phase 3: multi-Event isolation (specs/event-membership.md) ----
//
// The admission model. Appended as its own section for the same reason the
// Phase 5 block above is: nothing here weaves into `EventDoc` except the single
// `membershipEnforcement` field, and this file is a hot one with concurrent
// tickets editing it mid-body.
//
// WHAT THIS SECTION IS FOR. `events/{eventId}/players/{uid}` already MEANS
// membership in the ubiquitous language (`CONTEXT.md` § People) but cannot
// AUTHORIZE it: `firestore.rules:1007-1008` lets any signed-in account create
// its own Player row under any `eventId`, so a gate keyed off that row is
// satisfiable by the reader (#844, and `specs/x-multi-event-schema.md`
// § "Rules / indexes / hosting implications"). These types describe the
// separate, non-self-writable record that CAN authorize it.
//
// SCOPE. Ticket #802 ships the vocabulary and the pure predicates only. No
// rule enforces any of this yet (#804 Firestore, #806 Storage), nothing writes
// a membership yet (#803 invitations, #805 backfill), and no Event is enforced
// (`membershipEnforcement` is absent everywhere). The contract lands first
// precisely so those five tickets implement one shape rather than five.

/**
 * What a membership grant conferred. Admin is the ONLY privileged role today
 * (`CONTEXT.md` § People: "The only privileged role"), and a Host is a social
 * identity that grants nothing — so this union is deliberately two-valued
 * rather than speculative.
 *
 * `role` is the record OF THE GRANT, not the enforcement surface.
 * `EventDoc.admins` remains the sole authority on privilege and is what
 * `isAdmin()` reads; nothing in `firestore.rules` or `storage.rules` reads this
 * field. The two are kept consistent by the server grant path and checked by
 * `adminsMissingMembership` (`src/data/eventMembership.ts`) — see
 * specs/event-membership.md § "Admins, bans, and the three notions of
 * not-welcome".
 */
export type MembershipRole = 'member' | 'admin';

/**
 * Whether a membership currently admits. Exactly `'active'` admits; everything
 * else does not.
 *
 * Revocation is a STATUS CHANGE, not a delete, so that "was removed" stays
 * distinguishable from "was never here" — which the client needs in order to
 * say which one happened, and which a re-invitation path needs in order not to
 * silently re-admit somebody who was deliberately removed.
 */
export type MembershipStatus = 'active' | 'revoked';

/** The per-Event enforcement posture. See `EventDoc.membershipEnforcement`. */
export type MembershipEnforcement = 'off' | 'enforced';

/** The fields every membership carries, whatever its status. Split out so the
 *  union below can make the revocation audit fields structurally required on
 *  a revoked record and structurally absent on an active one. */
export interface MembershipBase {
  /**
   * The envelope version, pinned to the CURRENT literal rather than `number`
   * (Codex P2 on PR #891). A writer using this contract could otherwise set
   * `schemaVersion: 2` and type-check, persisting a record that AUTHORIZES —
   * `admits()` is version-blind by design — while parsing as `null` for every
   * consumer that needs its role or provenance. Bumping the version is then a
   * deliberate edit here, in lockstep with `MEMBERSHIP_SCHEMA_VERSION`.
   *
   * Gates the parse, never the authorization decision — see
   * `src/data/eventMembership.ts`.
   */
  schemaVersion: 1;
  /**
   * The granting Event. Denormalised from the path on purpose: the Functions
   * and the export paths read these documents detached from their location, and
   * a future "which Events am I in?" lookup (#807's Event switching) needs a
   * collectionGroup query, which can filter on a FIELD but not on the document
   * id.
   *
   * That query is deliberately NOT enabled here. A `{path=**}/memberships/{uid}`
   * read rule would be a new cross-Event read surface of exactly the kind this
   * epic exists to close — the same shape as the `{path=**}/markers/{markerUid}`
   * rule (`firestore.rules:1770-1772`) that already leaks other Events' markers.
   * Whoever enables it must bind it to `resource.data.uid == request.auth.uid`.
   */
  eventId: string;
  /** The admitted User. Authoritative copy is the document id; this is the
   *  queryable one, for the reason `eventId` is denormalised. */
  uid: string;
  /**
   * What the grant CONFERRED, at grant time. Not a statement of current
   * privilege and never an authorization input: `EventDoc.admins` is
   * client-writable, so an array-edit promotion leaves `role: 'member'` on a
   * real Admin and an array-edit demotion leaves `role: 'admin'` on someone who
   * is no longer one. Anything deciding what a caller may DO reads the live
   * roster (Codex P2 on PR #891).
   */
  role: MembershipRole;
  /** ms epoch, stamped server-side. */
  grantedAt: number;
  /** The uid of the granting Admin, or a `system:` sentinel for grants with no
   *  human author — `system:provisioner` for the launch provisioner's grant to
   *  an Event's creator (#793), `system:backfill` for #805's migration of the
   *  two live cohorts. Never empty: "we do not know who granted this" is a fact
   *  worth recording explicitly rather than by omission. */
  grantedBy: string;
  /** The invitation this grant was redeemed from, or `null` for grants that
   *  had no invitation (provisioner, backfill). Present so a revocation can
   *  answer "how did this person get in?" and so an invitation cannot be
   *  silently reused (#803, rhyming with #548's single-use discipline). */
  invitationId: string | null;
}

/** An admitting record. Carries NO revocation fields — the `never` types make
 *  a stale `revokedAt` a compile error rather than something only
 *  `readMembership` catches at runtime. */
export interface ActiveMembership extends MembershipBase {
  status: 'active';
  revokedAt?: never;
  revokedBy?: never;
}

/** A revoked record. Both audit fields are REQUIRED, so a writer cannot
 *  persist a revocation with no author or date. */
export interface RevokedMembership extends MembershipBase {
  status: 'revoked';
  /** ms epoch. */
  revokedAt: number;
  /** The uid of the revoking Admin, or a `system:` sentinel. */
  revokedBy: string;
}

/**
 * A document at `events/{eventId}/memberships/{uid}` — the organizer-issued,
 * non-self-writable record that a User is admitted to an Event.
 *
 * A DISCRIMINATED UNION on `status`, so the type enforces exactly what
 * `readMembership` enforces (Codex P2 on PR #891). With independent optional
 * fields, strict TypeScript accepted a revoked record with no audit fields and
 * an active record carrying stale ones — both of which the parser rejects, so a
 * writer using the canonical shared contract could persist data its consumers
 * could not read back.
 *
 * THE DOCUMENT ID IS THE UID, and that is a constraint rather than a
 * convenience: `storage.rules` can only reach Firestore through
 * `firestore.get()`/`firestore.exists()` on a fully-qualified path, so the
 * record has to be findable from `(eventId, uid)` alone with no query. That
 * single requirement is what eliminated a membership array on the Event
 * document and a subcollection under `users/{uid}`.
 *
 * NO CLIENT MAY WRITE THIS. The whole collection is denied to every client
 * credential and written only by the Admin SDK, exactly as `hostnames/{host}`
 * is (`firestore.rules:624-628`) — the in-tree precedent for a record whose
 * value depends on clients not being able to author it. A membership a client
 * can write is not a membership.
 *
 * FROZEN vs VERSIONED. The path and `status` are frozen forever: they are what
 * the two rules files transcribe, and re-versioning them would put a rules
 * deploy in lockstep with every data migration. Every other field sits behind
 * `schemaVersion` and may change; `readMembership` reads a drifted version as a
 * miss rather than coercing it (the convention `src/eventResolution.ts` uses
 * for its cache envelope, ADR 0009).
 */
export type MembershipDoc = ActiveMembership | RevokedMembership;

/**
 * Why the admission predicate answered the way it did.
 *
 * The outcomes are distinguished because the client has to say different things
 * for each: an unenforced Event is today's behaviour and shows nothing at all,
 * `denied-revoked` is "you were removed from this Event", and
 * `denied-not-a-member` is "this is not your Event". Collapsing them to a
 * boolean would make the difference unrecoverable at the call site.
 */
export type AdmissionOutcome =
  | 'admitted'
  | 'admitted-unenforced'
  /**
   * Admitted ONLY by Decision D-A's transitional `|| isAdmin(eventId)` disjunct
   * — the caller is on `EventDoc.admins` but holds no active membership, and
   * the Event IS enforced. Exists so the transitional posture is representable
   * in the reference predicate rather than only in prose (Phase 4b P1 on PR
   * #891): without it, `admits()` cannot express the state D-A tells #804 to
   * ship, and the reference would contradict the rules it is supposed to pin.
   *
   * **This outcome is the bypass, so it is also the audit hook.** Every
   * admission it accounts for is one the final posture denies. It disappears
   * when #805's backfill is verified and the disjunct is removed; a non-zero
   * count at that point is exactly the set D-A's rollout has not finished
   * with, and `adminsMissingMembership()` names them.
   */
  | 'admitted-admin-transitional'
  /** No authenticated identity. Denies FIRST, before the enforcement switch is
   *  consulted, mirroring the reference predicate's leading `signedIn()` — an
   *  unenforced Event is open to every signed-in account, not to the public. */
  | 'denied-not-signed-in'
  | 'denied-not-a-member'
  | 'denied-revoked'
  /** A record exists but its `status` is neither `'active'` nor `'revoked'` —
   *  shape drift or a half-written document. Denies, because an unreadable
   *  answer is not an admission. */
  | 'denied-unreadable';

/** The result of `admits` (`src/data/eventMembership.ts`). */
export interface AdmissionDecision {
  admitted: boolean;
  outcome: AdmissionOutcome;
}
