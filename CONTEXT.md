# Five Across—Domain Context

A phone-first, live, social bingo game for a group sharing one occasion—a trip, a wedding, a conference, a festival. The card's prompts are things that might happen there; play is shared, and the "truth" of the game is the live feed the group watches together—not server-side verification.

Vocabulary note: this codebase began as one sailing, so nautical words leaked into the model. They are not the domain. Prefer the neutral term everywhere; where a seafaring identifier still exists in code it is legacy, and its neutral name is given below.

## Language

### Platform & addressing

**Brand**: Five Across—the platform identity that owns accounts, the game engine, the analytics ingest host, and the "For the story" promise. One Brand exists. _Avoid_: Product, company

**Edition**: A named personality the platform wears for a class of occasion—Five Across (occasion-neutral), Vacay Bingo (travel), Gay Cruise Bingo (the original adults-only cruise edition). Supplies positioning, default prompt packs, default features, visual treatment, and a **Lexicon**. An Edition is configuration, never a separate application. _Avoid_: Vertical, tenant, white-label

**Namespace**: An apex domain whose wildcard subdomains address Events—`fiveacross.app` (canonical), plus `vacaybingo.com` and `fiveacrossbingo.com`, which stay live as serving hosts. Every Event is reachable in the Five Across namespace; an Edition may own a second one. _Avoid_: Domain (ambiguous), zone

**Slug**: The first hostname label identifying an Event—`bodega-bay` in `bodega-bay.vacaybingo.com`. A lowercase DNS-safe friendly address, globally unique across Namespaces, and explicitly **not** an authorization secret: knowing a Slug grants nothing. _Avoid_: Code, join code, invite code (those are secrets; a Slug is not)

**Canonical hostname**: The Event's primary address—in the `fiveacross.app` Namespace going forward (#599 as amended): the host new provisioning targets first and the name we print on things. It is the hostname analytics **report** (one canonical host per Event, so cross-host traffic aggregates), but not the host they **ingest to**: ingestion is Brand-level, so every Edition sends to the one Five Across host. It is NOT the only address an Event serves from—every registered host serves in place with correct branding via hostname resolution—and share links carry the entry-point host the sharer is standing on (#607), so recipients land on the same-branded surface. _Avoid_: Primary domain, main URL

**Alias**: A validated non-canonical hostname for an Event. It serves the Event in place with correct branding (#599 as amended—no edge redirect; a serving domain is never bounced off itself); the Canonical hostname is what keeps the Event's analytics aggregated across hosts, while sessions, installed PWAs, and offline storage remain per-origin facts of whichever host the guest uses. _Avoid_: Mirror, vanity URL

**Lexicon**: The vocabulary register an Edition's copy speaks—three of them today: **cruise** (Gay Cruise Bingo), **trip** (Vacay Bingo), **general** (Five Across). It supplies the occasion noun, the word for a Place, the audience, the reason signal drops, and the decorative mark on a share card. Distinct from the Edition's name: the register survives a find-and-replace of the brand untouched, which is exactly why it needs its own concept. _Avoid_: Copy pack, locale, i18n (this is register, not language)

**Adult content**: Whether an Event shows the 18+ acknowledgement. A property of the Event's **content**, derived server-side from whether its pool holds explicit Prompts (OR'd with an Admin override), never of its Edition—a general-audience Edition with explicit Prompts is 18+ in general vocabulary, and a cruise Edition with a tame pool is not 18+ at all. Monotone once true, and fails closed when unknown. _Avoid_: Adult edition, NSFW mode (both imply the Edition decides)

### Event & pool

**Event**: One occasion—a trip, a wedding, a festival. The top-level scope that owns everything else: prompts, days, boards, players, and feed. Addressed by its Slug, served from its Canonical hostname, and dressed by its Edition. Several can run at once. _Avoid_: Room, game, tenant, trip, cruise, sailing

**Prompt**: A single thing-that-might-happen that can land on a card (e.g. "Loses their room key"). Each Event seeds its own pool, which the group can then extend. _Avoid_: Item, tile, square

**Community Prompt**: A Prompt a Player suggested *during* the Event, approved by an Admin, and dealt onto a later Day Card with the submitter attributed. Player-facing copy is "put it on tomorrow's card"—never "bingo moment", which would collide with **Moment** below. _Avoid_: Bingo moment, player prompt, suggestion (fine informally)

**Theme**: A named look the whole app reskins into, supplied by the Edition and chosen per Day. Cosmetic only—a Theme never changes navigation or mechanics.

### Days & pools

**Day**: One chapter of an Event, owning a date, place, Theme, Pool, Scoring Policy, and unlock state. The Event owns an ordered list of them; the length is data, not a constant. _Avoid_: Round, stage

**Day Card**: A Player's Board for one Day—same 5×5 contract as today, now one per Player per Day. "Board" continues to mean this object; "Day Card" is the player-facing name.

**Tutorial Day**: A Day framed as onboarding or send-off rather than competition, so it is excluded from the Event-wide First to BINGO honour. An independent flag—a Day can be dealt from a curated pool without being a Tutorial Day, and vice versa.

**Scoring Policy**: Whether a Day's Marks count toward the standings—`competitive` or `ceremonial`. Stated on the Day, never inferred from its Pool. A Day's Pool identity, Tutorial framing, and Scoring Policy are three independent facts. _Avoid_: Ceremonial day (that's a Scoring Policy value, not a kind of Day)

**Standings Freeze**: The configured moment an Event's competitive scoring stops and the podium is computed. Distinct from the stamp recording that it happened. Nothing after it can move the standings or rewrite the finale. _Avoid_: Finale (that's the whole two-beat finish), end of event

**Reshuffle**: Trading a pristine Day Card for a fresh deal; 3 per Event. _Avoid_: re-deal (that's pool recovery), mulligan

**Pool**: Which item set a Prompt belongs to—the **main** pool, the **easy** pool, or the **closing** pool. Only the main pool accepts player submissions. The easy pool is both a Day's own content and the Easy Mix source on main Days; the closing pool belongs to a final Day. _Legacy (transition, #565)_: both live Events' docs still store the easy pool as `embark` and the closing pool as `farewell`—nautical names that predate the platform and mean nothing about arrival or departure. Code speaks only the neutral values: reads coerce (`migratePool` in `src/data/converters.ts`; `normalizePool` in `functions/src/poolVocab.ts`), `firestore.rules` accept both spellings, and persisted writes deliberately keep emitting the legacy values (`persistedPool`, `src/data/admin.ts`; the seed modules) until the post-Event cleanup flips writes, drops the coercions, and narrows the rules.

**Pending**: A submitted Prompt awaiting admin approval—a Prompt-moderation state, distinct from a pending Claim (the Admin-confirmed Mark workflow, see Claim below). Invisible to players; never dealt.

**Day Snapshot**: The frozen list of approved Prompts captured at a Day's unlock moment; before that moment the Day stays locked and deals nothing, so a card can never draw from an unfrozen pool. All of that Day's deals draw from the snapshot, so everyone's card reflects the same pool regardless of when they first open it. On a main Day the snapshot carries BOTH pools—every active main item and every active easy item—so the [Easy Mix](#days--pools) (a share of each card dealt from the easy pool) rides the one frozen list and every deal and reshuffle inherits it (specs/easy-mix.md). A Day dealt from a single curated pool freezes only that pool.

**Tally Card**: The Feed's live, aggregated entry for one Prompt on one Day—bumped toward the top as new Players mark it. A rendering of the Tally, not a new record. _Avoid_: Wave, streak

### The card & play

**Board**: One Player's frozen 5×5 card—24 sampled prompts plus the free centre. Private to its owner; dealt once and, once you have marked a square, never re-dealt. The one exception is a [Reshuffle](#days--pools): while a card is still pristine it may be traded whole for a fresh deal, 3 times per Event. _Avoid_: Card (fine informally), grid

**Square**: One of the 25 positions on a Board. Carries a Prompt's text and whether it's been marked. _Avoid_: Cell, tile, space

**Free Space**: The always-marked centre square. Its text is Event copy, and a Day may override it with its own. Counts toward lines but is never a Player-marked square.

**Mark**: The act (and resulting state) of a Player tapping a Square to say the thing happened. Marks are self-recorded on the Player's own Board—nobody else's approval is required by default.

**Echo Mark**: A Square auto-marked because the same Player's Mark on the same Prompt reached confirmed on another of their Day Cards—once a thing has happened, it's happened; if it's on three of your cards, that's three squares. Echoes are real Marks for scoring, but they never cost a card its Reshuffle pristine-ness (the Player did nothing on *that* card), and unmarking never cascades in either direction. _Avoid_: carry-over, sync mark

**BINGO**: Five marked squares in any one line—row, column, or diagonal. The centre counts. A Player can score several.

**Blackout**: All 24 non-free squares marked. The maximal win.

### People

**User**: A person's global identity and profile—one per Google account, shared across every Event. Holds display name and photo. _Avoid_: Account, player

**Player**: A User's membership and stats *within one Event*: bingo count, squares marked, first-bingo time. The same User is a distinct Player in each Event. _Avoid_: User, member, participant

**Admin**: A User granted moderation and settings rights for an Event. The only privileged role, and the only one that can approve a Community Prompt or resolve a Claim. _Avoid_: Moderator, owner

**Host**: The person whose occasion this is—player-facing, and shown alongside the Event name before sign-in so a joiner knows whose trip they are joining. A Host is a social identity, not a permission: hosting grants nothing on its own, so a Host who needs to run their own Event must also be an Admin. _Avoid_: Organizer, owner, creator

### Trust, proof & claims

**Feed**: The live, public stream everyone sees—Proofs plus Moments, newest first. The social source of truth, where the group witnesses what happened in place of server verification.

**Moment**: A broadcast announcement of a big social beat—a BINGO, a Blackout, or the First to BINGO—posted to the Feed for everyone. Unlike a Proof it carries no attached evidence; it marks *that* something happened, not what it looked like. _Avoid_: Milestone, highlight, announcement

**Notice**: An admin-authored broadcast to every Player—a title and body the admin writes, optionally pinned—posted to the Feed and, while pinned, shown once as a dismissible Card-tab banner. Distinct from a Moment: a Moment announces a game beat and carries no authored copy, whereas a Notice IS the admin's own words. Not a chat—no recipients, threading, or read receipts. _Avoid_: Announcement, bulletin, message (as a chat), Moment

**Tally**: The public, attributed record of which Players have marked a given Prompt—shown on the card as a count plus a tap-to-see-who list, so you can see who else "got" it. An aggregate surface, separate from the Feed. _Avoid_: Count, score

**Share Card**: A retina image a Player generates on their own device—for a BINGO or the Leaderboard—to drop into the group chat. Out-of-app, unlike a Moment (which lives in the in-app Feed) or a Proof. _Avoid_: OG image, unfurl

**Leaderboard**: The for-fun ranking of Players (bingos, then squares marked, then earliest first-bingo), with a pinned First to BINGO. A social artefact, not a tamper-proof record. _Avoid_: Ranks (fine as a UI label)

**First to BINGO**: The pinned honour of the earliest first-bingo in the Event, excluding Tutorial Days. Ceremonial; its time is self-reported like any other stat.

**Most-Loved Photo**: The visible, moderation-eligible photo Proof holding the most eligible Hearts at the Standings Freeze, computed once and persisted so later reactions cannot rewrite it. A Player's own Heart on their own Proof is not eligible, nor is a banned Player's. Ties share the honour; no eligible Hearts means no award and the finale shows photo highlights instead. _Avoid_: Best photo, winning photo, photo of the trip

**Claim Mode**: The Event-wide setting for how much friction a Mark carries—a friction/vibe knob, *not* a trust level. One of Honor, Proof-to-mark, or Admin-confirmed. _Avoid_: Trust mode, verification level

**Honor**: The default Claim Mode—mark freely, proof optional.

**Proof-to-mark**: A Claim Mode where a Mark requires an attached Proof. Friction that enriches the Feed; it does not make the Mark more trustworthy. _Avoid_: Proof required

**Admin-confirmed**: A Claim Mode where a Mark starts pending and doesn't count until an Admin resolves its Claim. A dispute/ceremony tool, not anti-cheat. _Avoid_: Verified

**Proof**: A playful photo, audio clip, or text callout a Player attaches when marking a Square; it posts to the Feed. Flavour, never enforcement.

**Doubt**: One Player publicly asking another to back up a specific marked Prompt—"pics or it didn't happen." The count of doubts shows on the marked square and the Tally entry; attaching a Proof satisfies them. Social pressure, never a gate—it's how the group applies the "the group is the verification" principle in-app. _Avoid_: Callout, demand, challenge

**Heart**: One Player's like on a Feed post—a Proof or a Moment. Many posts per Player, each post only once; tapping again takes it back. Warmth, never score—hearts touch no stats, no Leaderboard, no win logic, and a Tally Card (an aggregate, not a post) takes none. _Avoid_: Like, favorite, reaction

**Claim**: In Admin-confirmed mode, the pending record raised when a Player marks a Square, for an Admin to confirm or reject.
