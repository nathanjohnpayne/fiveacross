# Five Across — brand & naming

**Five Across** is the Brand: the platform identity that owns accounts, the game engine, the analytics ingest host, and the "for the story" promise. One Brand exists. What players see is an **Edition** — a named personality the platform wears for a class of occasion. An Edition supplies positioning, default prompt packs, default features, vocabulary and visual treatment, and it is **configuration, never a separate application**.

There are no sub-brand "surfaces." There is one app, resolved at runtime into one Edition for one Event.

## Vocabulary

The domain's ubiquitous language — Brand, Edition, Namespace, Slug, Event, Day, Board, Square, Mark, Tally, Feed, Moment, Claim Mode, and the rest — is defined once in [`CONTEXT.md`](CONTEXT.md). Use those terms and don't coin synonyms; each entry lists the words to avoid. Product overview: [`README.md`](README.md).

`CONTEXT.md` is also the agnostic vocabulary the prose tree is converging on. This codebase began as one sailing, so nautical words leaked into the model — they are not the domain. Prefer the neutral term everywhere: **Event** (not cruise, sailing, trip), **Place** (not port), **Event-wide** (not cruise-wide), **the group** (not the boat), **opening / closing Day** (not embark / farewell day), **offline or unreliable network** (not at sea). Where a seafaring identifier still exists in code or persisted data it is legacy, and `CONTEXT.md` gives its neutral name.

## Editions

| Edition id | Product name | Occasion class | Register |
|---|---|---|---|
| `gcb` | Gay Cruise Bingo | The original adults-only cruise Edition | **Cruise** — ship, sea, place, sailing. Full camp. |
| `vacay` | Vacay Bingo | Travel — trips, house weekends, road trips | **Trip** — travel without water. Moderate camp. |
| `fiveacross` | Five Across | Occasion-neutral — weddings, conferences, festivals | **General** — Event, place, everyone. Minimal camp. |

`gcb` and `vacay` are live in `BRANDS` (`src/editions.ts`). The general-audience `fiveacross` Edition is decided but not yet built; it lands with the Edition lexicon in [#608](https://github.com/nathanjohnpayne/gaycruisebingo/issues/608), which also converts the cruise vocabulary still embedded in shared copy into per-register tokens and overrides. `gcb` is the fallback Edition: an unknown or absent Edition resolves to it, so an unrecognised host degrades to the shipped experience rather than an unbranded screen.

The Edition is resolved **pre-auth** from `hostnames/{host}.edition` (ADR [0009](docs/adr/0009-event-resolved-from-hostname.md)), because the sign-in gate has to be branded and the Event document requires an authenticated read. A single-Event build may seed it from `VITE_EDITION`; a bundle serving many Events may not.

**The one-identity rule:** after a player enters through an Edition's hostname, the experience shows that Edition and nothing else — wordmark, tagline, document title, PWA identity, crash panel, Themes, share cards and copy.

## Namespaces and domains

A **Namespace** is an apex domain whose wildcard subdomains address Events; an Event's **Slug** is the first label (`bodega-bay` in `bodega-bay.vacaybingo.com`). A Slug is a friendly address, not a secret — knowing one grants nothing.

| Domain | Role |
|---|---|
| `fiveacross.app` | **Canonical Brand domain going forward** ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599)). New Events provision here first; share links and analytics canonicalize here; this is the name we print on things. |
| `gaycruisebingo.com` | The Gay Cruise Bingo Edition's domain. |
| `vacaybingo.com` | Travel Namespace, and the Bodega Bay Event's current canonical host. |
| `fiveacrossbingo.com` | Original Brand Namespace; live alternate. |

**Every registered domain stays live as a first-class serving host.** The canonical pivot to `fiveacross.app` is a response to the shipboard network blocking `gaycruisebingo.com` — best theory, substring filtering on "bingo," which indicts the two other bingo-substring names equally. That is an edge case, not a reason to kill working domains. The operative rule is the one hostname resolution exists to serve: **any domain that serves must carry the right branding and resolve its Event and Edition dynamically.** No host may hardcode a wordmark.

Each Event has exactly one **canonical hostname** and any number of validated **aliases**, which redirect at the edge before the application starts, so one Event never splits its sessions, installed PWAs, offline storage or share links across two origins. Analytics deliberately does **not** split: ingest is Brand-level, and one PostHog project carries `brand_id` / `edition_id` / `event_id`.

## Themes

A **Theme** is a named look the whole app reskins into — cosmetic only, never navigation or mechanics. Themes are Edition-scoped by `themesForEdition` (`src/theme/themes.ts`): Gay Cruise Bingo carries the Atlantis party looks plus its two tutorial Themes, Vacay Bingo carries the three Bodega Day Themes. The mapping is total by design — adding a Theme without declaring its Editions is a compile error, and there is no "shared by everyone" escape hatch. Each Edition also has a default Theme for the signed-out shell, where no Event document has been read yet.

## The 18+ posture follows content, not Edition

Whether an Event shows the 18+ acknowledgement and adults-only copy is a property of **the Event's prompt pool**, not of its Edition ([#608](https://github.com/nathanjohnpayne/gaycruisebingo/issues/608)). A `fiveacross` Event with spicy Prompts is 18+ with general vocabulary; a `gcb` Event with a tame pool is not 18+ at all. The two axes are independent, and copy must never assume otherwise.

The signal is `hostnames/{host}.adultContent` — world-readable, derived server-side from active spicy Prompts in dealable pools, OR'd with an Admin override, monotone once true, and failing to `true` when missing or malformed. Today the acknowledgement is still unconditional; the flag and the surfaces that follow it ship with #608.

## Relationship to mergepath

Five Across is a downstream **consumer** of the [mergepath](https://github.com/nathanjohnpayne/mergepath) template — the canonical implementation of the AI Agent Tooling Standard ([`ai_agent_tooling_standard.md`](ai_agent_tooling_standard.md)) for this account. This repo is not the template hub, nor its reference implementation; it inherits mergepath's governance (review policy, deploy tooling, agent docs) and builds the game on top.
