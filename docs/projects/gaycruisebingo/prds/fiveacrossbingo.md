<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/gaycruisebingo/prds/fiveacrossbingo.md
source_ref: 7089783
project: gaycruisebingo
document_class: prd
document_slug: fiveacrossbingo
sync_direction: central-to-repo
-->

---
tags:
  - fiveacrossbingo
  - gaycruisebingo
  - prd
  - product-strategy
  - rebrand
---
# Five Across Bingo

**Customer-facing brand:** Five Across
**Brand promise:** For the story.
**Primary domain:** `fiveacross.app` (amended 2026-08-08; was `fiveacrossbingo.com`—see § Brand and domain architecture)
**Author:** Nathan Payne
**Status:** Accepted—platform rebrand and migration from Gay Cruise Bingo; in build. As of 2026-10-05: the `fiveacross` Firebase project is live; the Bodega Bay proof of concept (Phase 2) ran August 7–9, 2026, now canonical at `bodega-bay.fiveacross.app` (#599) with `bodega-bay.vacaybingo.com` still serving; the repository was renamed `gaycruisebingo` → `fiveacross` on 2026-08-27 (part of Phase 6); membership-scoped isolation (Phase 3) is not yet enforced (app repo `README.md`, ADR 0008).
**Last Updated:** 2026-10-05
**Source brief:** [Gay Cruise Bingo](gaycruisebingo.md)

### Where each kind of decision lives

This PRD is authoritative for **product intent**: the problem, the audiences, the principles, the scope, and the product-level decisions below. It is deliberately *not* the single home for everything, because four other surfaces own their subjects and live in the application repository next to the code they govern:

| Surface | Owns |
|---|---|
| `CONTEXT.md` | The ubiquitous language. Every domain term, its definition, and the words to avoid. |
| `docs/adr/0008`–`0011` | The hard-to-reverse architectural decisions and the reasoning and rejected alternatives behind them. |
| `specs/**` | Implementation contracts and acceptance criteria per shipped behavior. |
| `specs/path-addressing-and-root.md` | How events are addressed and what serves `/`: live events by subdomain, historical events and brand-mirror events by path, and the non-installability requirement that lets the two share an origin. The spec behind this document's Phase 5 root create-Event page. |
| GitHub epics #527–#536 | The work breakdown, dependencies, review path, and per-ticket acceptance. |

Where this document touches those subjects it summarizes and cites them rather than restating them, so a fact has exactly one home and cannot drift between two repositories.

## Recommendation

Build **Five Across** as the universal platform, keep **Vacay Bingo** as its travel-focused edition, preserve **Gay Cruise Bingo** as the original event-specific experience, and use **For the Story** as the brand promise and campaign language rather than as a separate product.

Do this in the existing `gaycruisebingo` application repository. Do **not** fork the application. The card engine, Daily Cards, feed, proofs, tally, leaderboard, moderation, offline behavior, and event data model are shared product capabilities. Forking would duplicate those capabilities and make every improvement, security fix, and deployment a multi-repository coordination problem.

Keep the existing `gaycruisebingo` Firebase project as the legacy Gay Cruise Bingo production environment. Establish a new Five Across production Firebase project for new platform events, beginning with the Bodega Bay girls-trip proof of concept. This is a data and deployment boundary, not a product fork: the current Gay Cruise Bingo rules do not yet isolate unrelated cohorts, and its existing adult event data should not share a readable project with the first general-audience pilot.

The migration should establish wildcard event routing for both Five Across and Vacay Bingo plus centralized authentication first, then separate brand and event configuration from the shared application, launch the Bodega Bay pilot canonically at `bodega-bay.vacaybingo.com` with `bodega-bay.fiveacrossbingo.com` as its platform alias, and add full membership isolation before a second unrelated cohort enters the Five Across project.

### Brand and domain architecture

> **Amended 2026-08-08:** the canonical Five Across domain is now **`fiveacross.app`**, not `fiveacrossbingo.com`. Two reasons: the shorter form is the speakable wordmark, and `.app` is HSTS-preloaded, so every Universal Link, App Link, and `/.well-known/` association fetch is HTTPS by construction—a precondition for the native delivery path in [Native App Expansion](native-app-expansion.md) (Phase 7). The table below is updated; **elsewhere in this document, read `fiveacrossbingo.com` and `auth.fiveacrossbingo.com` as historical names for `fiveacross.app` and `auth.fiveacross.app`** (application repo #599, #547; `docs/adr/0010` carries the matching amendment). Two mechanism changes ride along and are *not* reflected in the prose below: #599 removed edge canonicalization—**every registered host serves in place**, so an alias no longer redirects to a canonical host—and the auth handoff's validated target origin is therefore the serving host sign-in began on. `vacaybingo.com` and `gaycruisebingo.com` are unaffected.

| Brand or domain | Recommended role | Initial behavior |
|---|---|---|
| **Five Across** / `fiveacross.app` | Master brand, organizer home, and central account surface | Hosts brand, event-management, and centralized sign-in entry points; individual games live on event subdomains. |
| **Five Across event namespace** / `*.fiveacross.app` | Durable platform address for every event | A wildcard Cloudflare DNS record and Worker route resolve the first hostname label to an Event. For edition-branded Events, this address is a stable alias of the Event's canonical hostname—serving in place rather than redirecting (#599). |
| **Vacay Bingo** / `vacaybingo.com` and `*.vacaybingo.com` | Travel edition endorsed by Five Across and canonical namespace for travel Events | The apex is the travel-focused landing experience; the wildcard uses the same Event router and makes `<event-slug>.vacaybingo.com` the preferred player address for Vacay Events. Bodega Bay is the first production slug. |
| **Gay Cruise Bingo** / `gaycruisebingo.com` | Original edition and legacy production environment | Remains live on its existing Firebase project, preserving installed PWAs, saved links, authentication callbacks, cruise-specific entry points, and adult event history. |
| **For the Story** / `forthestorybingo.com` | Brand promise, campaign, or shareable acquisition URL | Redirects to an appropriate Five Across campaign or landing page; it is not a fourth product to maintain. |

Every Event receives a durable `<event-slug>.fiveacrossbingo.com` platform address. A travel Event may additionally use `<event-slug>.vacaybingo.com` as its canonical player-facing address. Configure proxied wildcard DNS and wildcard Cloudflare Worker routes for both domains from the first Five Across launch so future Events do not require new DNS records, Firebase custom-domain registrations, certificates, or per-event edge deployments.

Each Event must declare exactly one canonical hostname and may declare validated aliases. The edge resolves the domain-plus-slug pair before application startup. A request to a valid noncanonical alias redirects to the canonical hostname while preserving the path and permitted query parameters. This tests and operates both namespaces without splitting authentication state, installed PWAs, offline storage, analytics, share URLs, or search metadata between two app origins. For Bodega Bay, `bodega-bay.vacaybingo.com` is canonical and `bodega-bay.fiveacrossbingo.com` is the platform alias.

OAuth redirect URIs do not support arbitrary wildcard event hosts, so authentication must remain centralized on one exact registered origin, recommended as `auth.fiveacrossbingo.com`. A player can start and finish play on the Event's canonical subdomain, but the sign-in transaction temporarily uses the central auth origin and returns through a short-lived, single-use handoff. No Firebase ID token or custom token may appear in a query string. If the secure return flow cannot be completed before the first launch, the acceptable fallback is to continue play on the Event's canonical origin after entering through either public subdomain—not to manually register a one-off OAuth callback for the Event.

## Brand Identity and Expression

Five Across and Vacay Bingo are one family with two personalities. **Five Across is the charismatic host**; **Vacay Bingo is the spontaneous friend who suggests the detour.**

| | Five Across | Vacay Bingo |
|---|---|---|
| Core feeling | Connection and friendly competition | Discovery and spontaneity |
| Personality | Clever, confident, inclusive, energetic | Curious, sunny, mischievous, relaxed |
| Visual language | Grids, bold typography, modular cards, crisp motion | Postcards, map marks, stickers, snapshots, organic motion |
| Color | Ink, cream, and adaptable event accents | Seafoam, sky, citrus, sunset, destination-specific colors |
| Copy | "Bring everyone into the game." | "Take the detour." |
| Product emphasis | Groups, events, standings, prizes | Daily adventures, local discoveries, photos, trip recaps |
| Avoid | Corporate event software or casino bingo | Generic palm trees and travel-agency clichés |

**Brand hierarchy for travel Events:** the lockup reads **VACAY BINGO** / *by Five Across* / **Take the detour.** / *For the story.* Five Across provides the recognizable foundation—the grid mark, core typography, navigation, game mechanics, and the "For the story" promise. Vacay changes the emotional layer: colors, imagery, prompt language, themes, unlock moments, and recap treatment.

**Brand hierarchy for Gay Cruise Bingo (amended 2026-08-08):** GCB carries the endorsement byline too—the lockup reads **GAY CRUISE BINGO** / *by Five Across*. The original scoping gave the byline to Vacay alone on the reasoning that GCB predates the platform, but that reasoning describes the product's history rather than its present: GCB is now one edition of Five Across alongside Vacay, it runs on the same engine, and under Phase 7 the store binary a GCB player installs is literally named Five Across. An unendorsed GCB is the only surface still implying a separate product. This is an endorsement line, not a rename—the wordmark, cruise vocabulary, adult posture, domain, and Firebase project are unchanged.

**One-identity rule:** after a player enters through either domain, the experience shows one identity—**Vacay Bingo by Five Across**—never competing Five Across and Vacay branding. Five Across is the platform endorsement; Vacay owns the player experience for a travel Event. The alias redirect enforces this technically (the canonical hostname selects the identity); onboarding, share cards, recaps, notices, and installed-app identity enforce it visually.

**Installed-app identity follows the canonical hostname.** The PWA manifest served for a Vacay Event must carry the Vacay Bingo name, icons, and theme color, not Gay Cruise Bingo's or a generic Five Across shell's. Because today's manifest is compiled into the bundle, per-hostname manifest delivery (Worker-injected or route-served) is part of the brand-configuration work, and the installed-app name is verified in the POC launch gate.

**Bodega Bay expression:** for this Sonoma Coast weekend, Vacay must not look tropical. Use fog silver, sea-glass green, Pacific blue, weathered red, and postcard cream, with coastal snapshots, route scribbles, bird silhouettes, and slightly campy suspense—a Sonoma Coast weekend preserved in a scrapbook. The three Day themes below are variations inside this event identity, not departures from it.

## Problem Statement

Trips and events are full of possibility, but groups often fall into the easiest available routine. People visit the obvious places, stay near the people they already know, postpone the funny idea, forget to take the photo, and finish with fewer shared stories than the occasion could have produced. A conventional itinerary tells people where to go, while a conventional bingo card gives them boxes to complete; neither fully turns the experience into a shared adventure.

Five Across uses bingo as a playful guide. Its prompts suggest unexpected activities, social challenges, discoveries, and photo-worthy moments. The card gives a group enough structure to get moving without turning the day into a checklist. Friendly competition, live reactions, shared evidence, and an optional prize add momentum, but completing the card is not the ultimate purpose. The purpose is to help people try something they otherwise would not have tried and create stories they will remember together.

The existing Gay Cruise Bingo application proves the core social loop in a specific, high-energy setting. The next product problem is to preserve that personality and immediacy while making the engine reusable, safe, and understandable for vacations, weddings, conferences, festivals, reunions, cruises, bachelor or bachelorette weekends, and other group occasions.

## Product Vision

Five Across turns a destination or event into a shared game of discovery.

An organizer chooses or customizes a set of prompts, invites the group, and optionally sets a time window, theme, proof rules, and prize. Each player receives a phone-first bingo card. As people complete prompts, they can mark squares, add photos or notes, see who else did the same thing, react to shared moments, and watch the friendly competition develop. The result is simultaneously:

- a guide that gives people ideas;
- a game that creates momentum;
- a social feed that keeps the group connected;
- a record of memorable moments; and
- an optional contest with a clear finish.

The product should feel like a nudge toward adventure, not an assignment.

## Audiences and Jobs to Be Done

### Group organizer

When I am planning a trip or event, I want to give people an easy shared activity that does not require constant coordination, so the group mingles, explores, and creates memorable moments on its own.

Examples include a trip planner, wedding host, conference organizer, cruise group leader, reunion host, or friend organizing a weekend away.

### Player

When I arrive somewhere with a group, I want fun ideas and a little friendly competition, so I have permission to try unusual things, meet people, take photos, and participate without having to invent the activity myself.

When something funny, surprising, or perfectly specific to our group happens, I want to put it on tomorrow's card, so the next card feels like it was made with us—not just for us—and gives the group a new reason to connect around a shared experience.

When other players share what they did, I want an effortless way to show that I noticed and enjoyed it, so the Feed feels like encouragement from the group rather than a stream of evidence or scores.

### Event operator or sponsor

When I want attendees to discover venues, exhibits, vendors, neighborhoods, or programmed experiences, I want a branded game that drives real participation and produces shareable moments without requiring a custom app.

This is a later commercial audience. The first platform release should optimize for self-organized groups before adding sponsor workflows.

## Product Principles

1. **The story is the outcome.** A completed square matters because of what someone did, discovered, or shared—not because a database field changed.
2. **Prompts are invitations, not chores.** Cards should mix easy momentum, genuine discovery, social interaction, and a few memorable stretches.
3. **The group provides the energy.** Tallies, proofs, doubts, moments, and standings should encourage conversation without trying to replace the group's existing chat.
4. **Competition stays friendly.** Prizes and rankings create momentum, but the app should celebrate participation and memorable moments as much as winning.
5. **The vibe belongs to the event.** Content rating, theme, tone, proof requirements, duration, and prize rules are event-level choices.
6. **Joining must be easier than explaining.** A link, code, or QR should take a player directly into the correct event with minimal setup.
7. **One platform, many editions.** Travel and events can have different positioning and defaults without becoming different application codebases.
8. **Private groups remain private.** Players must only see the events, people, and media they are authorized to see.
9. **The group can shape tomorrow.** A good trip or event produces ideas no organizer could predict. Approved player suggestions should flow into a future card while the experience is still happening.
10. **Attention is part of participation.** Hearts and finale recognition should reward noticing and encouraging other people's moments without turning popularity into bingo score.

## Goals and Success Metrics

The following are initial targets to validate. They should be recalibrated after the first three non-cruise events.

- **Goal: Inspire real participation.** **Metric:** at least 70% of joined players mark one or more prompts, and at least 40% complete a BINGO during the event.
- **Goal: Create memorable discovery.** **Metric:** at least 50% of surveyed players report doing or discovering something they would probably not have done without the prompts.
- **Goal: Generate shared moments.** **Metric:** at least 30% of active players attach a photo, note, or other proof, and each event produces at least five feed moments or share actions.
- **Goal: Let the group co-create the experience.** **Metric:** in a multi-day Event with player suggestions enabled, at least 25% of active players suggest a Prompt and at least one approved player suggestion appears on a later Day Card.
- **Goal: Encourage reciprocal attention.** **Metric:** at least 50% of active players heart another player's Feed post, and the final recap can identify an eligible Most-Loved Photo when the Event received photo proofs and hearts.
- **Goal: Make organizing lightweight.** **Metric:** an organizer can create a standard event from a template, customize it, and produce an invite link in under 15 minutes without developer assistance.
- **Goal: Support repeated engagement.** **Metric:** for events lasting three or more days, at least 50% of active players return on three separate days; Daily Card events should show a participation lift after each unlock.
- **Goal: Be reliably phone-native.** **Metric:** installable PWA on iOS and Android, primary actions reachable one-handed, Lighthouse PWA and performance scores of at least 90 on a mid-tier phone, and useful read/write behavior during temporary connectivity loss.
- **Goal: Become operationally reusable.** **Metric:** after the multi-event milestone, a new event can launch without a source-code edit or event-specific application deployment.
- **Goal: Make event addresses automatic.** **Metric:** creating an Event with an available slug makes `<slug>.fiveacrossbingo.com` and, when it is a Vacay Event, `<slug>.vacaybingo.com` resolvable without a new DNS record, Hosting custom domain, TLS certificate request, OAuth callback, or Worker route.
- **Goal: Enforce group privacy.** **Metric:** automated rules tests demonstrate that a signed-in player cannot read or write another event's private membership, boards, proofs, media, feed, or standings.

## Non-Goals

- **Replacing the group chat.** Five Across creates moments worth discussing and sharing; it does not need private messaging, threads, or a general-purpose social network.
- **Real-world verification or serious anti-cheat.** Proof modes shape the vibe and can support organizer confirmation, but the product does not guarantee that a real-world action occurred.
- **Ticketing, lodging, itinerary booking, or event registration.** Five Across complements the trip or event; it does not become its planning and commerce system.
- **Holding prize funds or operating sweepstakes.** Organizers may describe a prize, but payment custody, random drawings, eligibility administration, and jurisdiction-specific contest compliance are outside the initial product.
- **A public event marketplace.** Discovery of strangers' events and public room browsing add moderation and safety obligations that are not needed for private-group launch. **Read this precisely, because a retired non-goal sits next to it (2026-08-17):** retiring the single-active-Event constraint *is* in scope—Phase 5 self-service creation, a create-Event page at the platform root, and historical events addressable by path—and it supersedes the "Full multi-tenant 'rooms' product" non-goal in `projects/gaycruisebingo/prds/gaycruisebingo.md`. What remains out of scope is unchanged: no public directory of other organizers' events, no join-code room-hopping, and no cross-event browsing for a player who is not a member. The distinction is structural rather than a matter of restraint, but the structure is membership rather than address secrecy, and the two should not be conflated. `hostnames/{host}` is world-readable by `get` and never by `list` (`specs/hostnames-lookup.md`), which removes *collection* enumeration: no caller can query for the set of addresses. It does **not** make a guessable address unguessable—a caller who tries candidate hostnames one at a time can tell which resolve, and slugs are chosen to be memorable rather than high-entropy. That is accepted rather than overlooked, because knowing an address grants nothing on its own: ADR 0009 is explicit that *a Slug is not a secret*, and every read of Event data must still pass the membership gate (epic #801, `specs/event-membership.md`). So the guarantee against discovering strangers' events is that a non-member cannot read an Event's contents even holding its address; `list: false` additionally denies the bulk path to finding addresses at all. A create-Event page is a form for a signed-in organizer to *make* an event; it is not a directory for a stranger to *find* one.
- **A separate application repository per edition.** Brand, content, and defaults are configuration. A separate repository is warranted only if a product acquires different ownership, data boundaries, features, and release cadence.
- **Native App Store or Play Store applications.** The PWA remains the initial delivery model.
- **A single global content rating.** Gay Cruise Bingo remains an adults-only edition, while other events may be family-friendly or general audience. Rating and consent requirements belong to the event or template.

## Background and Existing Foundation

The source application began as Gay Cruise Bingo: a live, phone-first game for an adult friend group on a July 15–24, 2026 cruise from Trieste to Barcelona. It transformed a printed card into a shared experience with live marking, proofs, tallies, moments, doubts, a leaderboard, themes, share cards, offline support, moderation, and Daily Cards.

That implementation is the launch foundation, not a disposable prototype. The following capabilities should be inherited rather than rebuilt:

- randomized 5×5 player cards with a free center;
- event-scoped prompts, players, boards, proofs, claims, tallies, doubts, moments, and standings;
- honor, proof-required, and admin-confirmed claim modes;
- attributed per-prompt tallies showing who else completed something;
- a live feed containing proofs and milestone moments, with one-heart-per-player social reactions;
- player Prompt suggestions with organizer approval before they enter an eligible pool;
- first-BINGO, blackout, and leaderboard mechanics;
- optional daily cards, scheduled unlocks, themed days, and a multi-day finale;
- on-device share cards and native share-sheet integration;
- Google sign-in, PWA installation, offline cache, and reconnect synchronization;
- configurable visual themes and accessibility contrast checks;
- report, hide, ban, admin takedown, moderation email, and flag-gated Vision moderation;
- GA4 and PostHog analytics, session diagnostics, bug reporting, and uptime monitoring.

The current implementation also has deliberate single-event assumptions that the platform must retire:

- one deployed bundle resolves one build-time event ID;
- event metadata, PWA metadata, canonical URLs, email copy, monitoring, analytics, and some tests contain Gay Cruise Bingo-specific values;
- joining assumes one active event and therefore has no invite, membership, room selection, or event-resolution flow;
- event paths exist, but current rules provide path scoping rather than true tenant isolation for distinct groups;
- proof media access and already-issued media download URLs need an explicit privacy migration;
- analytics do not consistently carry brand, edition, and event dimensions.

## Proposal

### Core game loop

1. An organizer starts from a template or creates an event.
2. The organizer chooses the event's name, dates or duration, audience rating, prompt pack, visual theme, claim mode, and optional prize copy.
3. Five Across generates an invite link, short code, and QR code.
4. A player joins the event, accepts any event-specific advisory, and receives a frozen randomized card.
5. Prompts inspire the player to explore, interact, try something, or capture a moment.
6. The player marks the prompt and, depending on the event, adds a pledge, photo, audio clip, or note—or submits it for organizer confirmation.
7. The group sees the tally or Feed post and can heart shared Proofs and milestone Moments as lightweight encouragement.
8. A player can suggest a new Prompt inspired by the trip or Event—player-facing, "put it on tomorrow's card". After organizer approval, it becomes eligible for the next Day that has not yet been snapshotted or dealt.
9. Friendly competition develops through BINGOs and standings, while the group also helps shape what happens next.
10. Five Across celebrates milestones during the Event and produces a recap afterward, including the Event's Most-Loved Photo when an eligible photo received hearts.

### Player experience

A player opens an invite link or scans a QR code. The event name and host make the destination clear before sign-in. After joining, the player lands on the current card with a short explanation: use the prompts as inspiration; take the fun detour; share the story if you want; five across earns a BINGO.

The primary navigation remains optimized for play:

- **Card:** today's or the event's active bingo card;
- **Feed:** proofs, aggregated tally cards, organizer notices, milestone moments, and hearts for showing other players some love;
- **Ranks:** standings, first-to-BINGO, participation highlights, and the final Most-Loved Photo;
- **More:** profile, schedule, **Put it on tomorrow's card**, accessibility, install, reporting, rules, and event switching;
- **Admin:** organizer tools, shown only to authorized event administrators.

Prompt contribution should not be buried in settings. On eligible Days, the Card and Feed may surface a lightweight **Put it on tomorrow's card** invitation explaining that approved ideas can appear on the next Day Card. The submitter can see whether the suggestion is pending, approved, scheduled, or not selected.

**The player-facing verb is deliberately not "bingo moment" (decided 2026-08-04).** `Moment` is already a domain object—a milestone Feed post such as a BINGO or Blackout, with its own collection, rules, and deterministic ids—so a button that used the same word for a Prompt would mean a player taps "add a bingo moment" and then opens the Feed to find *Moments* that are a different thing entirely. "Put it on tomorrow's card" is also closer to what people actually say out loud on a trip. The stored object remains a player-sourced Prompt; see `CONTEXT.md` § Community Prompt.

The Feed should invite reciprocity with concise, warm cues such as “Show the group some love” and “Heart the moments you want to remember.” Hearts are social recognition only: they do not change square completion, BINGO totals, Daily Honors, or competitive ranking.

The app should recognize more than the bingo winner. At the Event's standings freeze, the finale should feature **Most-Loved Photo**: the visible, moderation-eligible photo Proof with the highest eligible heart count. Tied photos share the honor rather than being separated by an arbitrary timestamp. Freeze the award with the final standings so later reactions cannot rewrite the finale; if no eligible photo has a heart, omit the award and show a broader photo highlight instead. Recaps can also highlight the most-completed Prompt, the rarest square, the most-doubted claim, the biggest group Moment, and memorable photos selected by their owners or organizer.

### Organizer experience

The organizer starts with a use-case template such as Weekend Away, City Break, Wedding, Conference, Festival, Cruise, Reunion, or Custom. Each template provides sensible prompt categories, content guidance, duration, and scoring defaults.

The organizer can then:

- edit the event identity, schedule, theme, and welcome message;
- select, remove, edit, or add prompts;
- choose one event-long card or scheduled Daily Cards;
- choose an audience rating and require an advisory or acknowledgment;
- choose honor, proof-required, or admin-confirmed claims;
- enable or disable photo, audio, notes, doubts, standings, and prompt suggestions;
- review, lightly edit, approve, reject, and schedule player-suggested Prompts before the next Day snapshot;
- describe an optional prize and link to organizer-provided rules;
- invite co-organizers;
- generate and revoke invitations;
- moderate content and participants;
- archive the event and create a recap.

### Editions

#### Five Across Events

The general edition supports weddings, conferences, parties, reunions, festivals, team offsites, and other occasions. It should default to a single event-long card, general-audience prompts, quick joining, optional team play, and organizer branding.

#### Vacay Bingo by Five Across

The travel edition emphasizes discovery, spontaneity, destinations, and multi-day play. It should default to Daily Cards or a trip-long card, location-aware prompt categories without requiring precise location tracking, itinerary-friendly unlocks, group photos, and a trip recap.

#### Gay Cruise Bingo

The original edition remains an adults-only, cruise-specific configuration with its existing voice, prompt pools, themes, and event history. Its domain can continue as a durable doorway into the relevant event while the shared application and accounts live under Five Across.

#### For the Story

“For the story” is the emotional reason to play. It should appear in campaigns, share cards, recaps, and selected onboarding copy. It should not introduce another account system, application surface, or separately maintained feature set.

## Functional Scope

### Reuse and generalize first

- centralize customer-facing brand name, short name, descriptions, canonical origin, imagery, support details, email sender, analytics hosts, and PWA metadata;
- separate Brand, Edition, Event, Day, Prompt, Card, Player, Claim, Proof, Tally, Moment, Heart, Prize, and Recap Award concepts;
- make each Day's scoring policy explicit (`competitive` or `ceremonial`) instead of inferring it from an arrival or farewell prompt pool;
- replace cruise-specific defaults with event or edition configuration while preserving the existing cruise values in its edition;
- attach `brand_id`, `edition_id`, and `event_id` to analytics events and operational reports;
- generate brand-appropriate canonical metadata and share assets;
- keep the core card, feed, proof, tally, leaderboard, theme, moderation, offline, and share behavior in one application.

### Community contribution and connection

- Rename the prominent player-facing suggestion action to **Put it on tomorrow's card**, retaining Prompt as the internal domain object and `Moment` for milestone Feed posts. "Bingo moment" is rejected: it collides with the shipped `Moment` object.
- Allow an organizer to enable player suggestions per Event and define which Days or Prompt pools accept them.
- Store submitter attribution, submission time, intended eligible Day, moderation status, and any organizer-edited final text without exposing suggestions outside the Event.
- Keep every submission pending until an organizer approves it; duplicate, unsafe, out-of-scope, or rating-inappropriate suggestions never enter a Day snapshot.
- At each Day snapshot, mix approved player-sourced Prompts intended for that Day into the deal. Target two to four community Prompts on a 24-square Daily Card when enough are approved, backfilling from the organizer pool when they are not.
- Treat a community Prompt's easy or exploratory classification as part of the configured Daily Card mix rather than as an extra square outside the ratio.
- Never mutate an already snapshotted or dealt Day. A suggestion approved after its cutoff moves to the next eligible unsnapshotted Day; if no future Day exists, retain it for the organizer's recap or reusable Prompt pack.
- Let the submitter see pending, approved, scheduled, and not-selected states. When enabled by the Event, show “Suggested by [player]” in Prompt detail so co-creation becomes a connection point without crowding the card tile.
- Preserve Feed hearts on Proof and milestone Moment posts, with at most one heart from each player per post. Hearts remain independent of scoring and do not apply to aggregate Tally Cards.
- Encourage hearts through onboarding, a Feed cue, and the finale promise—not through repeated notifications, streak pressure, or a public list of who failed to react.
- At the Event freeze, persist a deterministic Most-Loved Photo result using the same visibility, moderation, and eligible-heart filters as the Feed. Exclude hidden, deleted, retracted, or otherwise ineligible Proofs; show all co-winners on a tie. Two eligibility rules are decided (2026-08-04): a Player's own Heart on their own Proof does **not** count toward this award—nothing about the Heart button changes elsewhere—and Hearts from banned Players do not count either, mirroring the filtering the Feed already applies to displayed counts. Without the first rule, in a small group the award goes to whoever remembered to heart themselves, which is precisely the popularity-contest failure the risk table warns about.
- Include the winning photo or tied photos, owner attribution, originating Prompt, and frozen heart count in the final standings view and final share composition, subject to the Event's media-sharing policy.
- Measure `prompt_suggestion_submitted`, `prompt_suggestion_approved`, `community_prompt_dealt`, `heart_post`, and `most_loved_photo_frozen` without including Prompt text, private media, or invitation secrets in analytics payloads.

### Required before unrelated groups coexist in one Firebase project

- organizer-created event membership that a player cannot grant to themselves arbitrarily;
- revocable invite links or codes tied to a specific event;
- Firestore rules that gate reads and writes on non-self-writable membership;
- equivalent Cloud Storage rules for proof media;
- a plan to revoke or replace previously issued capability-style media download URLs where privacy requires it;
- event-aware subscription and cache keys so switching events cannot show stale data;
- archived-event access rules and retention behavior;
- tests proving isolation between two unrelated event cohorts;
- event resolution at startup from an invitation, stable URL, or selected membership;
- an event switcher for players who belong to more than one event.

### Required for self-service launch

- organizer event creation and editing;
- template and prompt-pack selection;
- invite-link, code, and QR generation;
- co-organizer management;
- event preview and launch checklist;
- configurable event rules, content rating, proof policy, and prize description;
- archive and recap flows;
- support and moderation escalation appropriate to multiple organizers.

#### Event creation flow

The organizer wizard (design authority: `#frame-setup-occasion` through `#frame-setup-launch` in `daily-cards-wireframes.html`) collects only five decisions—occasion, basics, squares, look, launch—and three behaviors of that flow are product requirements, not wireframe incidentals:

- **Drafts exist and never hold a slug.** An event can be saved unlaunched and half-configured from any step. Slug availability is checked live during editing, but the transactional dual-namespace claim happens only at launch; a draft neither reserves nor squats an address. If the slug is taken between the availability check and launch, the launch fails closed with an inline rename—it never claims a variant silently. (Reservation, expiration, and rename policy for *launched* slugs remains the open decision above; drafts are deliberately outside it because they hold nothing.)
- **The minimum-pool gate runs at creation time.** An event cannot launch while any card it would deal lacks enough approved squares—24 non-free squares per dealt card—and the wizard surfaces the live count against that threshold rather than letting the first player discover an undealable event.
- **Everything else is a default with an escape hatch.** Claim mode, media toggles, prompt suggestions, unlock times, welcome message, prize, and co-organizers are all set by the chosen occasion's defaults, surfaced as verified rows on the launch checklist with per-row Edit, and remain fully editable in the Admin console afterward. This deferral is the wizard's core design stance: the five steps are the ceiling, and adding steps for settings the occasion can default is a regression against the under-15-minutes goal, not added compliance.

### Later opportunities

- teams and team standings;
- sponsor challenges and venue checkpoints;
- reusable private prompt packs;
- AI-assisted prompt drafting with organizer approval;
- paid organizer plans or branded event packages;
- exportable photo recaps or keepsakes;
- multilingual prompt packs;
- optional guest or passwordless authentication after privacy and account-recovery design.

## Trust, Safety, and Privacy

Five Across expands the risk surface from one known adult friend group to unrelated groups with different expectations. Privacy and content settings must therefore be explicit product behavior, not event-organizer convention.

- Membership must be authoritative and non-self-writable.
- Players must not be able to enumerate or read unrelated events.
- Proofs, names, tallies, feed items, and standings must be scoped to authorized event members.
- Organizers must be able to remove members, revoke invitations, hide content, and archive events.
- Each event must declare its audience rating and media policy before invitations are sent.
- Adult templates must be segregated from general-audience templates and require an appropriate acknowledgment.
- Location data should not be collected merely because the product is travel-oriented. Prompts may reference a place without recording continuous or precise location.
- Photos and audio must remain optional unless the organizer clearly chooses a stricter claim mode before players join.
- Player-suggested Prompts require organizer approval and the same audience-rating, privacy, location, accessibility, and safety review as organizer-authored Prompts before entering a card.
- Analytics and session replay must avoid invitation secrets, private proof content, and sensitive URL parameters.
- Prize language must make the organizer responsible for eligibility, fulfillment, and applicable rules until Five Across intentionally builds a compliant prize product.

## Technical Approach

### Repository and backend strategy

Continue with one TypeScript/React application repository and two initial production deployment targets:

- the existing `gaycruisebingo` Firebase project remains the legacy Gay Cruise Bingo environment; and
- a new Five Across Firebase project hosts Bodega Bay and subsequent platform events.

This split avoids migrating the live cruise data while keeping the first non-cruise cohort out of a project whose current rules allow signed-in users to read most Event data and proof media across Event paths. It also gives Five Across a clean Authentication, Firestore, Storage, Functions, App Check, analytics, and custom-domain baseline. Both deployments use the same source, tests, and release process.

The application remains a Vite PWA hosted on Firebase Hosting with Firebase Authentication, Firestore, Cloud Storage, Cloud Functions, GA4, and PostHog. Build shared capabilities once, configure them by brand, edition, and event, and keep environment separation distinct from brand separation.

After Bodega Bay, new Five Across events should share the Five Across project only after authoritative membership and two-cohort isolation tests are complete. Create additional production projects later only for contractual data boundaries, different ownership, incompatible compliance requirements, or independent operating teams. Brand positioning alone is not sufficient reason.

### Configuration model

Introduce three explicit layers:

- **Brand configuration:** Five Across identity, domains, global assets, support, legal links, and default messaging.
- **Edition configuration:** travel, general events, Gay Cruise Bingo, or future packages; supplies positioning, default prompt packs, default features, content range, and visual treatment.
- **Event configuration:** globally unique slug, canonical hostname, approved alias hostnames, organizer-owned name, dates, members, prompts, schedule, claim mode, prize copy, settings, admins, and archive status.

Brand and edition should never be inferred from prompt text. Event identity should never be compiled into every data helper. Startup should validate the request hostname and namespace, extract the slug, resolve them to an Event ID and canonical hostname, and provide that immutable result through an event-aware application context. Slugs are friendly addresses, not authorization secrets. Aliases redirect at the edge before the application establishes local state.

### Hosting and domains

Use one Cloudflare Worker service as the wildcard Event edge from the first Five Across launch:

1. create a proxied `*.fiveacrossbingo.com` wildcard DNS record;
2. create a proxied `*.vacaybingo.com` wildcard DNS record;
3. attach `*.fiveacrossbingo.com/*` and `*.vacaybingo.com/*` Worker routes to the same versioned router service;
4. reserve infrastructure labels—`www`, `auth`, `api`, `admin`, `play`, `status`, and **`d`**—with exact records that take precedence over each wildcard. `d` is the analytics ingest host: PostHog is reached through a branded managed reverse proxy, and without an exact record the wildcard router would swallow it;
5. validate both the hostname namespace and first label against the Event slug contract;
6. return an event-not-found experience for unknown, reserved, disabled, archived, or domain-ineligible slug combinations;
7. redirect a valid alias to the Event's canonical hostname while preserving the path and only explicitly allowed query parameters; and
8. route a valid canonical request to the shared Five Across application origin while preserving its public hostname.

The Worker is an Event router, canonicalizer, and namespace guard—not an authorization layer. The application still verifies membership before reading Event data. Event creation must claim slugs transactionally across every enabled namespace, normalize them to lowercase DNS-safe labels, reject reserved names, and define a redirect policy for any later rename. Bodega Bay must resolve to one Event ID from both domains; the hostname selects branding and canonicalization behavior, never a second Event record.

Centralize Google/Firebase sign-in at `auth.fiveacrossbingo.com`, an exact Firebase authorized domain and OAuth redirect URI. For an event-subdomain sign-in:

1. canonicalize any valid alias before sign-in, then generate a cryptographically random transaction with the target Event slug and canonical return origin;
2. navigate to the central auth origin;
3. complete Google sign-in there;
4. create a short-lived, single-use handoff code bound to the authenticated UID, target origin, and transaction;
5. return only the opaque handoff code to the event origin; and
6. exchange it over HTTPS for the event origin's Firebase session, then immediately invalidate it.

Never place an ID token, refresh token, or Firebase custom token in the URL. Reject replay, expired codes, mismatched origins, unrecognized slugs, and open-redirect targets. Verify the complete flow in mobile Safari, mobile Chrome, installed PWAs, and ordinary desktop tabs.

Keep `gaycruisebingo.com` live during the transition. Once the new origin is proven, it can either retain a thin event-specific landing experience or redirect into the Gay Cruise Bingo event on Five Across. Do not break existing deep links or installed app behavior merely to make the domain change appear instantaneous.

Start the `vacaybingo.com` apex as a travel landing page or entry into the Five Across organizer flow, while its wildcard subdomains serve as canonical addresses for travel Events. Point `forthestorybingo.com` to a campaign or landing page. No edition domain creates a second game runtime.

The wildcard architecture is supported by Cloudflare wildcard DNS and Worker routes. Firebase Hosting custom domains remain suitable for the small set of exact infrastructure hosts, but not as the event-provisioning mechanism: Firebase provisions certificates per custom domain and limits custom-domain subdomains per apex, while Google OAuth redirect validation disallows arbitrary wildcard callbacks.

**Revert lever, not a break-glass deadline (revised 2026-08-04).** An earlier draft held an exact Firebase Hosting custom domain in reserve, to be provisioned on Thursday at 18:00 PT if the wildcard path was not green. That was backwards: Firebase documents custom-domain certificate issuance at **up to 24 hours**, so a fallback triggered on Thursday evening can still be dark on Friday morning—while a proxied Cloudflare wildcard is covered by Universal SSL the instant the record exists. The reserve plan was slower than the thing it protected against.

Both hostnames are therefore provisioned as exact Firebase Hosting custom domains **on day one**, and the choice between paths becomes a DNS record state rather than a deadline:

- **grey cloud (DNS-only)** — the exact record outranks the wildcard and Firebase Hosting serves the host directly on its own certificate;
- **orange cloud (proxied)** — the Worker route matches, the Worker fetches the Hosting origin with a rewritten `Host` header, and players see the same public hostname.

One toggle in the Cloudflare dashboard, no deploy, no propagation wait, reversible in both directions in under a minute. The wildcard-plus-central-auth architecture remains the platform requirement; grey cloud is the state a verified baseline is built on rather than a concession.

### Multi-event data and authorization

The existing `events/{eventId}/...` shape is a strong starting point, but path scoping is not tenant isolation. The platform must introduce organizer-issued membership and gate both Firestore and Storage access on it. Event archival and membership revocation must be meaningful in the rules, not just labels in documents.

When event switching arrives, every subscription, offline cache, mutation, and analytics event must carry the resolved event ID. A player switching from one event to another must not retain live listeners, cached cards, feed data, or upload destinations from the previous event.

## Migration Plan

### Phase 0—Establish the dual-namespace wildcard platform foundation

- confirm Five Across as the master brand, `fiveacrossbingo.com` as the central account/organizer origin, `auth.fiveacrossbingo.com` as the authentication origin, `*.fiveacrossbingo.com` as the durable platform namespace, and `*.vacaybingo.com` as the canonical namespace for travel Events;
- confirm Vacay Bingo as an edition, Gay Cruise Bingo as the legacy/original edition, and For the Story as the brand promise;
- inventory every customer-visible and operational Gay Cruise Bingo reference;
- create the new Five Across Firebase production project without moving Gay Cruise Bingo data;
- create proxied wildcard DNS and Worker routes for both `*.fiveacrossbingo.com` and `*.vacaybingo.com`, attached to the same router service;
- reserve infrastructure hostnames in both namespaces and implement domain-plus-slug validation, canonical redirects, and unknown-Event handling;
- establish `auth.fiveacrossbingo.com` and its exact OAuth/Firebase configuration;
- implement or explicitly gate the secure auth handoff back to event subdomains; and
- define redirect behavior for all four registered apex domains.

**Exit condition:** a configured test slug in each wildcard namespace reaches the shared router without per-host setup; the Five Across alias redirects safely to the Vacay canonical hostname; unknown or domain-ineligible slugs fail closed; centralized sign-in succeeds on the supported device matrix.

Verification runs as a **gate ladder**, where every rung is a separately provable state and every toggle is independently revertable. Each gate is built on top of a baseline already known to work, so the riskiest component—the Worker's origin proxying, whose failure modes are silent and whose blast radius is total—can only ever be an enhancement rather than a prerequisite:

1. **Gate 1** — grey cloud, straight to Firebase Hosting, `VITE_AUTH_MODE=same_origin`. The whole game verified end to end on the real hostname.
2. **Gate 2** — `VITE_AUTH_MODE=handoff`, still grey cloud. Sign-in verified on mobile Safari, mobile Chrome, an installed PWA, and desktop. Reverting is one environment variable and a redeploy.
3. **Gate 3** — orange cloud. The Worker proxies the origin and injects the per-hostname manifest. Re-verify installed-app identity, service worker, offline cold boot, deep links, and `/__/auth/` passthrough. Reverting is one Cloudflare toggle.
4. **Gate 4** — the Five Across alias redirects to canonical, preserving path and allowed query parameters.

Do not let players install the PWA before Gate 3 passes: an installed service worker and manifest from the grey-cloud path can outlive the cutover.

### Phase 1—Extract brand configuration

- centralize names, descriptions, canonical URLs, PWA metadata, social metadata, images, email sender and base URL, analytics hosts, support links, and monitoring targets;
- make Gay Cruise Bingo an explicit edition configuration rather than the application default;
- make the event schedule length, timezone, unlock times, Day themes, free spaces, prompt pools, and per-Day scoring policy fully event-configured;
- generalize player Prompt suggestions so approved submissions can target the next eligible unsnapshotted Day regardless of cruise-specific pool names;
- preserve Feed hearts and add a frozen Most-Loved Photo result to the event finale model;
- add brand and edition dimensions to analytics;
- replace tests that accidentally require the old brand with tests for intentional configuration behavior;
- keep the existing Gay Cruise Bingo domain, deployment, and Event unchanged while producing the separately configured Five Across build.

**Exit condition:** the existing production experience remains unchanged, but a Five Across build can be produced without searching and replacing literals.

### Phase 2—Launch the Bodega Bay proof of concept

- seed the Bodega Bay Event, three-Day schedule, easy/main/farewell pools, working themes, free spaces, and administrator roster;
- configure Friday and Saturday's **Put it on tomorrow's card** invitation, the 6:00 a.m. organizer review cutoff, and the next-Day community Prompt mix;
- publish it canonically at `bodega-bay.vacaybingo.com` and expose `bodega-bay.fiveacrossbingo.com` as its platform alias through the same wildcard router;
- update Five Across email links, canonical metadata, share assets, analytics, PostHog, monitoring, Content Security Policy, and operational documentation;
- verify sign-in, sign-out, auth handoff, PWA install/update, offline startup, Day unlocks, deep links, player suggestions, approval and snapshot timing, hearts, share flows, Proofs, media uploads, and finale behavior;
- capture activation, marking, Proof, suggestion, approval, heart, BINGO, return, and qualitative discovery metrics; and
- keep Gay Cruise Bingo running independently throughout the pilot.

**Exit condition:** the first non-Gay-Cruise cohort completes a three-day game using the Vacay canonical hostname and Five Across alias on the reusable Five Across backend, with no one-off domain registration and no access to Gay Cruise Bingo data.

### Phase 3—Harden multi-event isolation

- implement organizer-issued membership and revocable invitations;
- enforce membership in Firestore and Storage rules;
- address media download-token exposure;
- add event-aware listeners, cache keys, analytics, uploads, and event switching;
- implement archived-event behavior and two-cohort isolation tests; and
- block a second unrelated Five Across Event until the isolation gate passes.

**Exit condition:** two unrelated groups can use the Five Across production project without seeing or modifying one another's information or media.

### Phase 4—Complete the edition entry points

- launch the Vacay Bingo apex travel landing experience and complete its travel defaults;
- preserve Gay Cruise Bingo's voice, content rating, themes, and event entry path;
- redirect `forthestorybingo.com` to the selected campaign;
- add edition-aware onboarding and share language while keeping one account and game engine.

**Exit condition:** each domain has one clear job, and no domain implies a separately maintained product.

### Phase 5—Make event creation self-service

- build organizer setup, templates, prompt packs, preview, co-admin, invite, moderation, archive, and recap flows;
- add general event and travel templates;
- establish support, abuse handling, and retention policies for organizers outside Nathan's own groups;
- validate the product and initial metric targets with at least three non-cruise events.

**Exit condition:** an organizer can launch and run an event without developer intervention.

### Phase 6—Clean up the legacy naming

- rename the GitHub repository, package names, and internal documentation only after the Five Across domain and deployment path are stable;
- keep redirects or references for old repository links where the hosting service supports them;
- do not attempt to rename the provisioned legacy `gaycruisebingo` Firebase project ID;
- decide whether `gaycruisebingo.com` remains a permanent edition page or becomes a durable redirect.

**Exit condition:** customer-facing and developer-facing naming is clear, while stable infrastructure identifiers and legacy links continue to work.

## Dependencies and Risks

| Dependency or risk | Impact | Mitigation |
|---|---|---|
| Current event paths are not true tenant isolation | Critical before unrelated groups coexist | Make non-self-writable membership and matching Firestore/Storage enforcement the gate for multi-event launch; test with two adversarial cohorts. |
| Wildcard DNS solves routing but not OAuth | Critical for the first event | Use one exact central auth origin and a short-lived, single-use, origin-bound handoff; never register event hosts individually or put credentials in URLs. |
| Serving one Event from two namespaces can split sessions, PWA storage, analytics, and shared links | High | Declare one canonical hostname per Event and redirect aliases at the edge before app startup or authentication; test deep-link and permitted-query preservation. |
| The Bodega Bay launch has only days of lead time | High | Reuse the shipped Daily Cards experience and its wireframes, limit net-new product work to platform configuration, wildcard routing, authentication, branding, themes, event seed, and launch verification; cut optional polish before cutting privacy or auth safeguards. The descope ladder is explicit: first the Most-Loved Photo finale (degrades to photo highlights), then the Five Across alias (Vacay canonical only), then grey-clouding the exact record so Bodega is served directly by Hosting and the Worker is deferred; player suggestions and the privacy/auth gates are never the cut. |
| The first Five Across deployment adds a second Firebase project | Medium | Treat it as a configured deployment target of the same repository; document project aliases, keep secrets isolated, and run the same verified deployment process for both environments. |
| Existing proof URLs may behave as bearer capabilities | High | Inventory how media URLs are created and stored; migrate or revoke tokens where event privacy requires it rather than relying on Firestore rules alone. |
| PWA caches and installed shortcuts retain the old origin | Medium-High | Keep the old domain live during the transition, ship clear update behavior, and test installed-app migration rather than assuming a browser redirect updates an installed PWA. |
| Universal positioning could flatten the product's personality | Medium | Keep strong edition voices and opinionated prompt packs; generalize infrastructure, not every piece of copy. |
| One brand presented under several domains can confuse users | Medium | Give each domain one documented job and keep account, navigation, and the authenticated game anchored to Five Across. |
| User-generated photos, audio, names, and adult content create privacy and moderation obligations | High | Make rating and media policy explicit per event, preserve reactive moderation, restrict membership, and separate adult templates from general templates. |
| Hearts and a Most-Loved Photo could feel like a popularity contest | Medium | Frame hearts as appreciation for moments, never player rank; keep them out of bingo scoring, omit who-did-not-react mechanics, share tied honors, and retain broader photo highlights. |
| Prizes introduce fulfillment and contest-law expectations | Medium | Limit the first product to organizer-authored prize descriptions and external rules; do not hold funds, select random winners, or promise compliance. |
| Self-service organizers increase support and abuse volume | Medium | Pilot with known organizers, instrument setup failures, document escalation, and expand access only after isolation and moderation controls are proven. |
| The Firebase project keeps the old internal name | Low | Treat it as an infrastructure identifier; remove it from customer-facing copy and document why it remains. |
| The scheduled unlock functions are pinned to `Europe/Rome` | Critical for the POC | In August that cron fires at 23:00 and 11:00 Pacific, so a Day due at 6:00 a.m. PT would not snapshot until 11:00 a.m.—a five-hour window with every card locked. The scheduler iterates every active Event and each beat is idempotent, so one hourly UTC trigger replaces both and serves every timezone correctly. |
| The client and Cloud Functions compute the podium from different exclusion rules | High | Invisible on the cruise, contradictory on any Event whose curated Days are not tutorial Days. Align the functions mirror to the client and add a parity test that feeds one fixture schedule to both. |
| The prompt pools are bundle constants pinned by hard-equality tests, with a drift verifier comparing live data against them | High | A second Event's pools fail the pin on contact, and relaxing the pin would switch off a guard that has already caught a real incident. Make the pools per-Event with per-pool tests instead. |
| Firebase Auth UIDs are scoped per project | Medium | The admin roster cannot be seeded until someone has signed in to the new project at least once; the existing UID does not carry over. Sequence project creation, one sign-in, then seed. |
| Every planned change touches a protected review path | Medium-High | `firestore.rules`, `functions/**`, and `src/auth/**` all mandate Phase 4 external review regardless of size, so no small PR exists in this migration. Budget review latency into the schedule rather than discovering it at merge time. |

## Resolved Product Decisions

- [x] **Five Across is the master platform brand.**
- [x] **Vacay Bingo is the travel edition, endorsed by Five Across.**
- [x] **Gay Cruise Bingo is retained as the original adult cruise edition and legacy domain experience.**
- [x] **For the Story is a brand promise and campaign surface, not a separately maintained product.**
- [x] **The existing application is evolved in place; it is not forked.**
- [x] **Gay Cruise Bingo remains on its existing Firebase project; Five Across begins on a new production Firebase project using the same repository.**
- [x] **Every Five Across Event receives a stable `<event-slug>.fiveacrossbingo.com` address.**
- [x] **Vacay Events may use `<event-slug>.vacaybingo.com` as their canonical address while retaining the Five Across address as a platform alias.**
- [x] **Wildcard DNS and routing ship before the first Five Across Event; event domains are never provisioned one at a time.** Bodega's exact record is retained as a revert lever rather than as a provisioning pattern (see Hosting and domains); grey-clouding it does not waive the platform requirement.
- [x] **Brand identity is a codified family system:** Five Across is the host, Vacay Bingo is the detour-suggesting friend, the travel lockup is "VACAY BINGO by Five Across — Take the detour. / For the story.", and the one-identity rule governs every player-facing surface after entry.
- [x] **If the three-day window forces a cut, player suggestions ship and the Most-Loved Photo finale degrades** to the existing photo-highlights treatment; the finale then ships as a fast-follow for the next Vacay Event.
- [x] **Authentication uses one exact central origin rather than per-event OAuth callbacks.**
- [x] **Bodega Bay is the first non-Gay-Cruise proof of concept.**
- [x] **Bodega Bay tests both wildcard domains: Vacay Bingo is canonical and Five Across is the redirecting platform alias.**
- [x] **The existing Daily Cards wireframes remain the visual and interaction authority for the Bodega Bay pilot.**
- [x] **Players can put their own ideas on tomorrow's card; approved suggestions become player-sourced Prompts mixed into the next eligible Daily Card.**
- [x] **Feed hearts are an explicit connection mechanic, and final standings include the frozen Most-Loved Photo when an eligible photo received hearts.**
- [x] **Membership isolation is a launch gate before a second unrelated group joins the Five Across Firebase project.**
- [x] **Prompts and shared experiences remain the point; card completion and prizes are motivational devices.**

Decided 2026-08-04, during the design review that produced ADRs 0008–0011:

- [x] **The Event is resolved from the hostname through a world-readable `hostnames/{host}` lookup**, keyed by full hostname so an Event's canonical address and its aliases are separate documents pointing at one Event. Readable by `get`, never by `list`, and cached in local storage. Safe because a Slug is an address, not a secret. (ADR 0009)
- [x] **Both Bodega hostnames are provisioned as exact custom domains on day one**, making the Cloudflare proxy toggle the revert lever and retiring the Thursday break-glass deadline.
- [x] **`VITE_AUTH_MODE=same_origin` ships alongside the handoff as a deliberate escape hatch**, and is the baseline the handoff is verified on top of. (ADR 0010)
- [x] **Day scoring is stated, not inferred from the prompt pool**, and the standings freeze is an Event setting rather than a side effect of a Day unlocking. (ADR 0011)
- [x] **The player-facing verb is "put it on tomorrow's card", never "bingo moment"**, which would collide with the shipped `Moment` object.
- [x] **A Player's own Heart on their own Proof does not count toward Most-Loved Photo**, nor do Hearts from banned Players; the frozen result never recomputes.
- [x] **Analytics stay in one PostHog project with brand, edition, and event dimensions** rather than splitting per edition—cross-event comparison is the question the platform exists to answer.
- [x] **Nautical vocabulary is retired from the shared model.** The codebase began as one sailing and the seafaring words leaked into the domain; they are not the domain. Gay Cruise Bingo's own edition content keeps its voice.

## Open Decisions

These remain genuinely open. Items resolved on 2026-08-04 have moved to the resolved list above.

- Should the first general release support individual standings only, or teams as well?
- Which Vacay Bingo templates launch first: city break, beach trip, cruise, road trip, or weekend away?
- Which authentication methods are required beyond Google before inviting broader groups?
- What slug reservation, rename, expiration, and redirect policies should self-service organizers receive?
- What event retention and proof-media deletion defaults should organizers receive?
- Should archived events remain viewable as recaps, and who can reopen or export them?
- What organizer controls and terms are required before prizes are promoted in public or paid events?
- How much visual customization can an organizer apply without weakening the Five Across identity?

## First Non-Gay-Cruise Proof of Concept: Bodega Bay

**Event:** Bodega Bay girls trip
**Role:** First Five Across / Vacay Bingo proof of concept outside Gay Cruise Bingo
**Host:** Kim Taylor — the trip's organizer and the Event's primary Admin
**Target:** August 7–9, 2026. Airbnb check-in 4:00 p.m. Friday; check-out 11:00 a.m. Sunday
**Day unlocks:** 6:00 a.m. `America/Los_Angeles`; Friday opens on arrival via the already-open sentinel
**Standings freeze:** Sunday 11:00 a.m. `America/Los_Angeles` (check-out)
**Event slug:** `bodega-bay`
**Canonical public URL:** `bodega-bay.vacaybingo.com`
**Platform alias:** `bodega-bay.fiveacrossbingo.com`
**Internal Event ID:** `bodega-bay-2026`, resolved from the hostname through the public `hostnames/{host}` lookup
**Audience:** One private friends group
**Administrators:** Kim Taylor (host) and Nathan Payne (platform). Both must be on the Event's `admins` roster before the trip: the community-Prompt review queue closes at the 6:00 a.m. snapshot and only an Admin can approve, so a host who is not an Admin cannot run her own Event's overnight review.
**Deployment:** One Event in the new Five Across Firebase production project, reached through both wildcard Cloudflare routes and canonicalized to the Vacay hostname

### Purpose

This trip is the first test of whether the Gay Cruise Bingo engine transfers successfully from one adult cruise community to a general friends-travel experience. It should validate the reusable platform without pretending to be the final self-service product.

The POC must answer:

- Does an event-specific subdomain feel memorable and make joining obvious?
- Does the Vacay hostname strengthen the travel positioning while the Five Across alias remains a useful and trustworthy platform address?
- Do both wildcard namespaces resolve the same Event reliably without splitting identity, PWA state, analytics, or shared links?
- Can centralized authentication return players safely to a wildcard event origin?
- Do Daily Cards create a reason to reopen the app each morning during a short trip?
- Does a deliberate mix of easy and exploratory Prompts encourage participation without making the card feel trivial or burdensome?
- Do location-specific themes make each day feel like a new chapter while the interaction model stays consistent?
- Do proofs, tallies, the Feed, Daily Honors, and standings create conversation and shared memories in a non-cruise group?
- Does letting players put their own ideas on tomorrow's card make each new card feel more personal and spark conversations about what happened the day before?
- Do Feed prompts and the Most-Loved Photo finale encourage players to notice and heart one another's contributions?
- Which cruise-specific concepts or copy still leak through and need to become Event or Edition configuration?

### Design authority

The Bodega POC reuses the complete Daily Cards interaction and visual system documented in [`daily-cards-wireframes.html`](https://github.com/nathanjohnpayne/fiveacross/blob/main/plans/daily-cards-wireframes.html). It does not create a parallel set of trip screens.

Reuse the existing:

- Day chips, current-Day selection, and locked future previews;
- scheduled Event-timezone unlock behavior, with an arrival-Day override. Bodega unlocks at **6:00 a.m.** rather than the cruise's 8:00 a.m.: this group is early to rise and early to bed, so the card should be waiting before anyone is up;
- themed board chrome and automatic match-the-Day appearance;
- first-open coach overlay and reshuffle behavior;
- Claim sheet, proof choices, tallies, doubts, Feed, and Notices;
- Feed hearts on Proof and milestone Moment posts;
- Easy Mix slider and admin schedule controls;
- overall standings plus per-Day First to BINGO honors; and
- final standings and share-card composition.

The next-Day community Prompt mix and the Most-Loved Photo block extend this design system; they do not create new primary navigation. Only brand identity, Event configuration, Day content, themes, Prompt pools, hostname resolution, authentication, and deployment configuration should otherwise differ.

### Working schedule

| Day | Working theme | Content source | Recommended mix | Free space | Unlock | Scoring |
|---|---|---|---|---|---|
| Friday—arrival | **🐦 The Birds Have Entered the Group Chat** | Easy pool | Easy, social, and immediately achievable | **The flock has landed** | Already-open sentinel | Competitive |
| Saturday—main adventure | **🌊 Bodega Bay Side Quests** | Main exploratory pool blended with the easy pool | 50% easy / 50% exploratory—12 of each on a 24-square card | **Main character on the coast** | 6:00 a.m. | Competitive |
| Sunday—final morning | **🌫️ Fog, Froth & Farewells** | Main pool blended with the easy pool | Easy and unhurried; a packing morning | **One last coastal morning** | 6:00 a.m. | Competitive until the 11:00 a.m. freeze |
| The wrap-up | **🌫️ Fog, Froth & Farewells** | Closing pool | Reflective, gratitude, photo sharing | **We did it for the story** | 11:00 a.m. | Ceremonial — its unlock *is* the freeze |

**A three-day trip is seeded as four Days (decided 2026-08-04).** `standingsFrozen` returns true the moment a closing-pool Day unlocks, and the finale anchors its freeze and podium on that same timestamp. A closing-pool Sunday would therefore freeze standings at 6:00 a.m. and make the final morning ceremonial, while moving Sunday off the closing pool entirely would leave the Event with no freeze, no podium and no Most-Loved Photo. Keeping Sunday on the main pool and adding a ceremonial wrap-up Day whose unlock *is* the freeze resolves both, needs no code change, and stays correct once scoring is stated explicitly — the configured freeze is seeded to the same instant as the wrap-up's unlock, so the inferred and stated values agree. The closing prompts move to the wrap-up card, which suits them: they are read on the drive home rather than over the last coffee.

Friday must use the already-open sentinel rather than a 4:00 p.m. timestamp. A Day's snapshot only admits Prompts whose pool-entry time is at or before its unlock, so seeding the pool after 4:00 p.m. Friday against a 4:00 p.m. unlock would stamp Friday an **empty snapshot**—and there is no un-stamp. The sentinel skips the timestamp cutoff entirely, which is exactly why the cruise's embark Day uses it.

The 6:00 a.m. unlock gives Sunday a five-hour competitive window before the 11:00 a.m. freeze. It also moves the community-Prompt review cutoff to 6:00 a.m., so suggestions are reviewed the night before rather than over morning coffee.

The cruise implementation treated its farewell Day as ceremonial because standings froze when that card unlocked. That assumption does not survive a three-day weekend whose final morning is real competitive play. Day scoring is therefore stated rather than inferred: `DayDef.scoring` is `competitive` or `ceremonial`, and the freeze moves to the Event as `EventDoc.standingsFreezeAt`. Prompt-pool identity, tutorial framing, and standings eligibility are three independent facts; legacy Event documents default `scoring` from their pool on read, so the cruise's behavior is byte-identical. See ADR 0011.

Auditing this exposed a live defect worth recording: the client excluded only tutorial Days from the Event-wide First to BINGO, while the Cloud Functions mirror also excluded the easy and closing **pools**. Invisible on the cruise, where those Days are also tutorial—but on any Event where they are not, the card and the Feed would print contradictory podiums. The two implementations stay deliberately decoupled; a parity test feeding one fixture schedule to both is what now stops them drifting.

### Theme direction

- **The Birds Have Entered the Group Chat:** Hitchcock-inspired coastal suspense with original artwork and copy—eggshell, ink black, sea green, and a restrained warning red. Use silhouettes, flock patterns, and campy suspense; do not use film stills, poster art, logos, or imply an official affiliation.
- **Bodega Bay Side Quests:** adventurous Sonoma Coast energy—deep Pacific blue, seafoam, fog white, buoy orange, harbor details, and wind-drawn movement.
- **Fog, Froth & Farewells:** soft final-morning warmth—fog silver, chowder cream, coffee brown, dusk coral, and photo-album framing.

These themes use the existing Theme token contract and contrast tests. They should change the day's emotional framing without changing navigation or mechanics.

### Prompt strategy

Seed enough approved content that each 24-square card feels intentional and reshuffles remain useful:

- **40 easy Prompts:** low coordination, available at the lodging or around town, socially connective, and achievable even if plans change. This pool is also the Easy Mix source on main Days, so most entries must read well on any morning rather than only on arrival;
- **40 exploratory Prompts:** Bodega-specific discoveries, scenic detours, local culture, food, wildlife, movie history, and group creativity; and
- **40 final-day Prompts:** easy last looks, favorite-memory capture, gratitude, photo sharing, and a few optional farewell detours.

**Why 40 and not 28 (revised 2026-08-04).** A Day Card deals 24 non-free squares. The cruise's easy and closing pools hold 28 each, but those feed *tutorial* Days where near-identical cards are the point. Bodega's Friday and Sunday are competitive: drawing 24 from 28 means any two players share roughly 20.5 of 24 squares, a Reshuffle barely changes the card, and the rarest-square recap has almost nothing to work with. At 40 per pool two players share about 14 of 24—enough overlap for the Tally to feel social, enough difference for discovery. Saturday is insensitive either way because it blends the main and easy pools.

Easy examples:

- take a windblown group selfie;
- get a bird into the background of a photo;
- find the best boat name in the harbor;
- spot bird-themed art or a souvenir;
- photograph someone in full coastal-main-character mode;
- capture a colorful buoy or crab pot;
- make a “for the story” toast; and
- post a candid that makes the group laugh.

Exploratory examples:

- walk to a Bodega Head viewpoint;
- complete part of the Bird Walk trail;
- create an original suspense-movie still;
- see St. Teresa of Avila Church;
- spot the Potter Schoolhouse from a respectful public viewpoint;
- find a Hitchcock detail at the Tides Wharf;
- ask a local for a favorite view or detour;
- discover a local artist or gallery;
- fly a kite at Doran Beach; and
- spot marine wildlife from a safe distance.

No Prompt should require a purchase, trespassing, approaching wildlife, swimming, unsafe cliff or surf access, revealing private location data, or pressuring a stranger. Any venue-specific or mobility-intensive Prompt needs a nearby, weather-safe alternative. The Potter Schoolhouse is a private residence and may only be observed respectfully from a public viewpoint. Use official Sonoma County tourism and parks sources when finalizing locations and safety language.

### Bodega community co-creation loop

- On Friday and Saturday, show **Put it on tomorrow's card** on the active Card and in the Feed, with copy explaining that approved ideas can appear the next morning.
- Let players submit a concise Prompt, optionally add context for the organizer, and see its review state. A submission is not a Feed post and does not count as completing a square.
- Give the organizer an overnight review queue to approve, lightly edit, classify as easy or exploratory, reject, or defer each suggestion before the **6:00 a.m.** `America/Los_Angeles` Day snapshot. With a 6:00 a.m. snapshot the review realistically happens **before bed, not over coffee**—a 7:00 a.m. review would miss the card, and it would miss it silently: the suggestion simply would not be there.
- Reserve two to four of the next Day Card's 24 non-free squares for approved community Prompts when enough exist. Those Prompts still count inside the Day's easy/exploratory ratio.
- Preserve contributor attribution and show it in Prompt detail as “Suggested by [player]” for this private group.
- Never alter an already unlocked Bodega card. Suggestions not approved before the next snapshot may move to the following eligible Day; after Saturday's cutoff, hide the “tomorrow” invitation because no later trip Day remains.

### Bodega connection and finale loop

- Keep the existing heart affordance on every eligible Proof and milestone Moment in the Feed, and use a light Feed cue—**Heart the moments you want to remember**—to make the purpose clear.
- Encourage appreciation of other players' posts without adding reaction streaks, heart-based bingo points, or a public participation score.
- At the configured Sunday trip-end freeze, persist the visible, moderation-eligible photo Proof with the most eligible hearts as **Most-Loved Photo of the Trip** alongside the bingo podium and Daily Honors. The result is computed once and stored; it is never recomputed, so a photo hidden after the freeze leaves the award recorded while the finale falls back to photo highlights for display.
- Show the winning photo, its owner, originating Prompt, and frozen heart count in final standings and the finale share composition. If eligible photos tie, celebrate all tied photos; if none received a heart, show photo highlights without declaring a winner.

### POC launch gate

Scope priority for the three-day window: player suggestions are the keeper among the two net-new features; the Most-Loved Photo finale degrades to the existing photo-highlights treatment if time runs short (decided 2026-08-04). The gates below that reference the finale apply in whichever form ships.

Do not share the player link until all of the following are true:

- the proxied wildcard DNS records and Worker routes resolve arbitrary slugs in both namespaces without per-event setup, and Bodega is served through that router—its exact record retained, grey-cloudable, as the instant revert lever rather than as the serving path;
- the Vacay hostname serves as canonical, while the Five Across hostname redirects before app startup and preserves the path plus explicitly allowed query parameters;
- arbitrary test slugs in both namespaces reach the same router, while unknown, reserved, and domain-ineligible slugs fail closed;
- the Bodega slug resolves to the intended Event and cannot be treated as authorization by itself;
- centralized sign-in and the event-origin return succeed on mobile Safari, mobile Chrome, installed PWA, and desktop;
- no credential is placed in a URL and handoff replay, expiry, origin mismatch, and open redirects are rejected;
- Bodega players and data live in the new Five Across Firebase project and have no access path to Gay Cruise Bingo data;
- all three Day definitions, unlocks, snapshots, themes, free spaces, prompt pools, scoring settings, and finale time are correct in the Event timezone;
- the 24-square deal contains the intended easy/exploratory ratio;
- player suggestions remain private to the Event, require organizer approval, and place approved community Prompts into the intended next-Day snapshot without changing an unlocked card;
- Proofs, media uploads, tallies, Feed entries, hearts, Daily Honors, standings, the frozen Most-Loved Photo, and the final freeze pass end-to-end tests;
- analytics include `brand_id`, `edition_id`, `event_id`, `event_slug`, and `day_index` without recording invitation secrets;
- analytics and share metadata report only the Vacay canonical hostname after alias redirection;
- the Gay Cruise Bingo adults-only acknowledgment and cruise-specific copy do not appear anywhere in the Bodega experience (Bodega is general-audience; its advisory, if any, is its own);
- the installed-app identity for the Bodega hostname is Vacay Bingo (per-hostname PWA manifest name, icons, and theme color), or the deferral is explicitly accepted and documented;
- every expected participant is confirmed to have a Google account, since Google is the only sign-in method; and
- an administrator has a tested manual unlock, Notice, moderation, and event-stop procedure.

### POC success measures

Use the platform targets as directional, but prioritize learning over statistical confidence for one small group:

- at least 70% of joined players mark one Prompt;
- at least 40% complete one BINGO during the weekend;
- at least half of active players return on all three Days;
- the group creates at least five proofs, Feed moments, or share actions;
- at least 25% of active players suggest a Prompt, with at least one approved suggestion appearing on Saturday or Sunday;
- at least half of active players heart another player's Feed post;
- the final standings correctly recognize the eligible Most-Loved Photo or intentionally fall back to photo highlights when no photo received a heart;
- at least one participant reports doing or discovering something they likely would not have tried without the card;
- no event-routing, authentication, privacy, unlock, offline, or scoring failure blocks play;
- entry through both public hostnames converges on one canonical Event experience without duplicate sessions or analytics identities; and
- the post-trip debrief identifies which Prompts felt effortless, motivating, too hard, too location-dependent, or most memorable.

## Launch Edition: Gay Cruise Bingo

Gay Cruise Bingo remains the canonical record of the product's first implementation and its event-specific decisions. Its source PRD documents the July 2026 Mediterranean cruise, 18+ posture, adult prompt pool, Atlantis non-affiliation, claim modes, Daily Cards, themed schedule, moderation posture, shipped social layer, analytics, and original success targets.

The Five Across migration must preserve the following behaviors for that edition:

- the existing event data, players, boards, proofs, moments, standings, and moderation history;
- the adults-only acknowledgment and cruise-specific content;
- the existing themes and Daily Card schedule behavior;
- old links, installed PWA access, and authentication return paths during the transition;
- the honor-system philosophy, including optional stricter claim modes;
- the original domain as a recognizable doorway for the cruise group.

No universalization task should silently sanitize or overwrite the Gay Cruise Bingo edition. The platform should make that experience one intentional configuration among many.

**Gay Cruise Bingo remains a single-Event edition, and that is a product choice rather than a platform limit.** Phase 5 makes self-service event creation a platform capability; this edition does not adopt it. Its audience is one sailing's group, its prompt pool and 18+ posture are written for that group, and a create-Event surface on this edition's domain would invite exactly the stranger-facing discovery the platform's § Non-Goals rules out. Should a second Gay Cruise Bingo sailing ever want its own Event, nothing in the platform prevents it — the constraint is editorial, and revisiting it is a decision for this section rather than a change to the platform. This is the statement `projects/gaycruisebingo/prds/gaycruisebingo.md` § Non-Goals cites; it lives here so the fact has one home.

## Appendix

- **Implementation repository:** `nathanjohnpayne/fiveacross` (renamed from `gaycruisebingo` on 2026-08-27; the old slug 301-redirects).
- **Legacy production environment:** `gaycruisebingo.com` on the `gaycruisebingo` Firebase project.
- **Five Across production environment:** the `fiveacross` Firebase project (provisioned; served Bodega Bay).
- **First Five Across Event:** Bodega Bay girls trip canonically at `bodega-bay.vacaybingo.com`, with `bodega-bay.fiveacrossbingo.com` as its platform alias.
- **Registered expansion domains:** `fiveacross.app` (canonical since 2026-08-08), `vacaybingo.com`, and `forthestorybingo.com`. `fiveacrossbingo.com` is retained; its master-brand role moved to `fiveacross.app`.
- **Infrastructure:** React, Vite, TypeScript, Firebase Hosting, Authentication, Firestore, Cloud Storage, Cloud Functions, Cloudflare wildcard DNS and Workers routing, GA4, and PostHog.
- **Current event selection:** build-time `VITE_EVENT_ID`, with one active event per deployed bundle.
- **Target event selection:** domain-plus-slug resolution through `*.fiveacrossbingo.com` and `*.vacaybingo.com`, canonicalizing aliases before producing one immutable Event context at startup. The slug-to-Event mapping is the public `hostnames/{host}` collection, read before authentication and cached per hostname (ADR 0009).
- **Domain glossary:** `CONTEXT.md` in the application repository is authoritative for Brand, Edition, Namespace, Slug, Canonical hostname, Alias, Community Prompt, Scoring Policy, Standings Freeze, and Most-Loved Photo.
- **Architecture decisions:** `docs/adr/0008` (second Firebase project), `0009` (hostname resolution), `0010` (centralized auth and handoff), `0011` (stated scoring policy).
- **Work breakdown:** GitHub epics #527–#536 and their sub-issues, on Project #7.
- **Bodega prompt pools:** `plans/bodega-prompt-pools.md` in the application repository.
- **Canonical current product detail:** the [Gay Cruise Bingo PRD](gaycruisebingo.md), plus the application repository's architecture decisions and accepted specifications.
- **Daily Cards design authority:** [`daily-cards-wireframes.html`](https://github.com/nathanjohnpayne/fiveacross/blob/main/plans/daily-cards-wireframes.html) and its companion Daily Cards specification in the application repository.
- **Wildcard DNS reference:** [Cloudflare wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).
- **Wildcard routing reference:** [Cloudflare Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/).
- **Exact-domain Hosting reference:** [Firebase Hosting custom domains](https://firebase.google.com/docs/hosting/custom-domain).
- **OAuth redirect reference:** [Google OAuth web-server redirect validation](https://developers.google.com/identity/protocols/oauth2/web-server).
- **Migration rule:** make both wildcard namespaces, canonical alias routing, centralized authentication, brand identity, and hostname Event resolution reusable before Bodega Bay; make membership private before onboarding a second unrelated cohort into the Five Across project.
