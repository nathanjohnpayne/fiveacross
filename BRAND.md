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

All three Editions are implemented in `BRANDS` (`src/editions.ts`). Their shared contract lives in `src/types.ts`; each supplies a vocabulary register plus whole-string overrides for copy whose grammar does not survive token replacement.

`gcb` is the fallback **Edition**, which is a narrower guarantee than it sounds: it covers a hostname document that resolves but names an unknown or absent `edition`, so a misconfigured Edition field degrades to the shipped experience rather than an unbranded screen. It does **not** cover a hostname that fails to resolve at all — a missing or inactive `hostnames/{host}` document, or a revalidation failure with no usable cached mapping, renders the not-found state (`src/eventResolution.ts`). Resolution fails closed; only the Edition field falls back.

The Edition is resolved **pre-auth** from `hostnames/{host}.edition` (ADR [0009](docs/adr/0009-event-resolved-from-hostname.md)), because the sign-in gate has to be branded and the Event document requires an authenticated read. A single-Event build may seed it from `VITE_EDITION`; a bundle serving many Events may not.

**The one-identity rule:** after a player enters through an Edition's hostname, the experience shows that Edition and nothing else. It covers the wordmark, tagline, document title, PWA identity, crash panel, Themes, shared UI vocabulary, Share Card footers and filenames, and celebration/share copy. The Share Card app-name consumer moved into #608 while closing the source-wide vocabulary leak; #607 retains any share work not represented by those local card surfaces, and [#587](https://github.com/nathanjohnpayne/gaycruisebingo/issues/587) still owns unfurl metadata.

## Namespaces and domains

A **Namespace** is an apex domain whose wildcard subdomains address Events; an Event's **Slug** is the first label (`bodega-bay` in `bodega-bay.vacaybingo.com`). A Slug is a friendly address, not a secret — knowing one grants nothing.

| Domain | Role |
|---|---|
| `fiveacross.app` | **Canonical Brand domain going forward** ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) as amended). New Events provision here first; analytics canonicalize here (one canonical host per Event); this is the name we print on things. Share links deliberately do **not** canonicalize—a guest shares the host they are standing on ([#607](https://github.com/nathanjohnpayne/gaycruisebingo/issues/607)). |
| `gaycruisebingo.com` | The Gay Cruise Bingo Edition's domain. |
| `vacaybingo.com` | Travel Namespace; the Bodega Bay Event's original host, still live—and still named canonical by its own `hostnames` doc until the post-event repoint ([#601](https://github.com/nathanjohnpayne/gaycruisebingo/issues/601)). |
| `fiveacrossbingo.com` | Original Brand domain — a registered zone, never a Namespace. **Being retired**, not a serving host: no Event has ever been dealt from this origin, and the zone becomes a 301 to `fiveacross.app` once the Bodega migration completes ([#630](https://github.com/nathanjohnpayne/gaycruisebingo/issues/630)). Today it carries a redirect **hostname** — deliberately not an Alias, which by definition serves in place with no edge redirect — plus DNS-only `auth.` / `d.` infrastructure. |

**Every domain in service stays live as a first-class serving host.** The canonical pivot to `fiveacross.app` is a response to the shipboard network blocking `gaycruisebingo.com` — best theory, substring filtering on "bingo," which indicts the two other bingo-substring names equally. That is an edge case, not a reason to kill working domains. The operative rule is the one hostname resolution exists to serve: **any domain that serves must carry the right branding and resolve its Event and Edition dynamically.** No host may hardcode a wordmark.

**"In service" is doing real work in that sentence.** The rule protects a domain guests actually reach from being retired because some network somewhere filters it — the failure it was written against. It is not a promise that no domain is ever retired. A **brand-name retirement** is a different act with a different cause: when the brand name itself moves, the old name is retired *as the pivot*, not as collateral damage from one. `fiveacrossbingo.com` is the worked example — the whole zone becomes a 301 to `fiveacross.app` once the Bodega host migration completes ([#630](https://github.com/nathanjohnpayne/gaycruisebingo/issues/630), owner-confirmed 2026-08-17). No Event was ever dealt from a `*.fiveacrossbingo.com` origin, so nothing is taken from a guest: its `bodega-bay` label is already a redirect hostname rather than an Alias, and `auth.` / `d.` are DNS-only infrastructure. `vacaybingo.com` is the case the rule does protect, and it keeps serving.

The distinction is worth stating because the two look identical from the DNS panel and opposite in intent. Ask which one applies before retiring a domain: *is this name being filtered, or has this name stopped being ours?* And prefer fewer serving origins where the answer is the latter, because each additional serving origin is a separate isolation island — its own session, installed PWA, offline cache, storage quota and permission grants (ADR [0009](docs/adr/0009-event-resolved-from-hostname.md) § Why not one origin with a path prefix). That per-origin separation is the property Event addressing is built on; carrying a retired brand name as an extra origin pays its cost and buys nothing.

Each Event has exactly one **canonical hostname** and any number of validated **aliases**. An alias serves the Event in place with correct branding—no edge redirect ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) as amended); sessions, installed PWAs, and offline storage are per-origin facts of whichever host a guest uses, and share links carry that entry-point host ([#607](https://github.com/nathanjohnpayne/gaycruisebingo/issues/607)). What the canonical hostname does is keep the Event's analytics whole: every host reports the one canonical host, so cross-host traffic aggregates. Ingest is Brand-level besides, and one PostHog project carries `brand_id` / `edition_id` / `event_id`.

## Themes

A **Theme** is a named look the whole app reskins into — cosmetic only, never navigation or mechanics. Themes are Edition-scoped by `themesForEdition` (`src/theme/themes.ts`): Gay Cruise Bingo carries the Atlantis party looks plus its two tutorial Themes, Vacay Bingo carries the three Bodega Day Themes. The mapping is total by design — adding a Theme without declaring its Editions is a compile error, and there is no "shared by everyone" escape hatch. Each Edition also has a default Theme for the signed-out shell, where no Event document has been read yet.

## The 18+ posture follows content, not Edition

Whether an Event shows the 18+ acknowledgement and adults-only copy is a property of **the Event's prompt pool**, not of its Edition ([#608](https://github.com/nathanjohnpayne/gaycruisebingo/issues/608)). A `fiveacross` Event with spicy Prompts is 18+ with general vocabulary; a `gcb` Event with a tame pool is not 18+ at all. The two axes are independent, and copy must never assume otherwise.

The signal is `hostnames/{host}.adultContent` — world-readable, derived server-side from active spicy Prompts in dealable pools, OR'd with an Admin override, monotone once true, and failing to `true` when missing or malformed (ADR [0012](docs/adr/0012-server-derived-adult-content-posture.md)). The acknowledgement and adults-only copy render only when that posture requires them; open tabs watch for a raise and re-gate un-attested Players.

## Relationship to mergepath

Five Across is a downstream **consumer** of the [mergepath](https://github.com/nathanjohnpayne/mergepath) template — the canonical implementation of the AI Agent Tooling Standard ([`ai_agent_tooling_standard.md`](ai_agent_tooling_standard.md)) for this account. This repo is not the template hub, nor its reference implementation; it inherits mergepath's governance (review policy, deploy tooling, agent docs) and builds the game on top.
