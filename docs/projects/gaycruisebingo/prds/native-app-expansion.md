<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/gaycruisebingo/prds/native-app-expansion.md
source_ref: 7089783
project: gaycruisebingo
document_class: prd
document_slug: native-app-expansion
sync_direction: central-to-repo
-->

---
tags:
  - fiveacrossbingo
  - gaycruisebingo
  - prd
  - native
  - ios
  - android
---
# Five Across—Native App Expansion

**Phase:** 7, extending the Migration Plan in the parent PRD (Phases 0–6).
**Delivery model:** Capacitor shell over the existing web application; one binary, one store listing, Editions as runtime skin.
**Primary domain:** `fiveacross.app`—supersedes `fiveacrossbingo.com` in the parent PRD; see § Canonical domain.
**Author:** Nathan Payne
**Status:** Draft—not yet scheduled. The block-user gate has since shipped (#689, PRs #1300/#1304/#1307, 2026-09-25; ADR 0016, `specs/player-blocking.md`); no Capacitor shell exists in the app repo as of 2026-10-05
**Last Updated:** 2026-08-08
**Parent PRD:** [Five Across Bingo](fiveacrossbingo.md)
**Source brief:** [Gay Cruise Bingo](gaycruisebingo.md)

> **This phase supersedes a parent Non-Goal, as the parent anticipated.** The parent lists "Native App Store or Play Store applications. The PWA remains the *initial* delivery model." That wording reserved the option rather than closing it, and this document exercises it. The Non-Goal remains in force for **Gay Cruise Bingo**, which does not ship to any store—see § Decision 1.

### Where each kind of decision lives

This document follows the parent's split. It is authoritative for the **product intent of native delivery**: why a store build, what ships in it, which Events it may reach, and how a player gets from an invite to a card. It is not the home for implementation contracts or architecture decisions, which stay in the application repository:

| Surface | Owns |
|---|---|
| `CONTEXT.md` | The ubiquitous language—Edition, Event, Slug, Prompt, Day. |
| `docs/adr/**` | The hard-to-reverse architectural decisions. This phase touches ADR 0005 (share images), 0006 (offline resilience), 0009 (Event resolved from hostname), and 0012 (server-derived adult-content posture). |
| `specs/**` | Implementation contracts and acceptance criteria per shipped behavior. |
| GitHub epics | The work breakdown, dependencies, review path, and per-ticket acceptance. |

## Recommendation

Ship a **Capacitor shell** around the existing web application as a single **Five Across** listing on the App Store, with Google Play as a fast follow. Do not rewrite the client in SwiftUI or React Native. Do not create per-Edition listings. Do not ship Gay Cruise Bingo to any store.

The client is roughly 32.5k lines of production TypeScript against 46k lines of tests. A SwiftUI rewrite reuses none of it and costs five to seven months; React Native reuses about a third—the data layer and game logic—and costs two and a half to four months. A Capacitor shell keeps essentially all of it and costs eight to ten weeks including compliance, which is the only option whose cost is proportionate to what native actually buys this product.

What native buys is specific and worth naming: iOS install friction disappears, a push channel opens for the daily unlock, and "download the app" replaces "visit this URL" as the invite instruction. What it must not cost is the mid-Event hotfix path, which over-the-air bundle updates preserve.

## Problem Statement

The PWA delivery model is strong on Android and weak on iOS, and the parent PRD's phone-native goal is only half met as a result.

Safari never fires `beforeinstallprompt`, so iOS installation is a manual Share-sheet ritual that has to be explained in the invite. Push notifications require the player to have already home-screened the app, which most will not have done. For the wedding, conference, and group-trip Events that Phase 5 makes self-service, an organizer telling twenty guests to "visit this URL and then add it to your home screen" loses people at exactly the moment attention is highest.

The product also has a recurring re-engagement beat it cannot currently deliver to a lock screen. The daily unlock already reaches inboxes through the Phase 1 email family; it does not reach notifications, which is where a trip-day prompt belongs.

## Goals and Success Metrics

- **Goal: Remove iOS install friction.** **Metric:** invite-link to first-mark conversion on iOS reaches or exceeds the Android PWA baseline for the same Event.
- **Goal: Open a push channel.** **Metric:** the daily unlock reaches lock screens; at least half of installed players have notifications enabled at Event start.
- **Goal: Preserve the mid-Event hotfix path.** **Metric:** a copy or logic fix reaches players in under an hour with no store submission, matching today's deploy cadence.
- **Goal: One binary serves every shippable Edition.** **Metric:** a single listing renders the correct Edition skin from an invite link or join code, with no per-Edition build.
- **Goal: Do not regress the web.** **Metric:** the PWA remains canonical and every Event stays fully playable in a browser, including for players who never install.

## Non-Goals

- **A SwiftUI or React Native rewrite.** Wrong cost for a 5×5 grid; see § Recommendation.
- **Per-Edition store listings.** Two listings double review, compliance, and update channels to buy marketing surface that store copy already provides.
- **Shipping Gay Cruise Bingo to the stores.** See § Decision 1.
- **In-session Event switching.** Joining a second Event tears down and remounts the application root. True switching requires folding the Event id into every subscription key first, which is separate work.
- **A dynamic home-screen icon per Edition.** iOS cannot rename an installed app at runtime and shows a system alert on every icon change; Android's equivalent drops the app from the launcher mid-swap. The icon and name stay Five Across.
- **Deferred-deep-link attribution services.** The join code closes the post-install gap without a third-party dependency or its privacy-label consequences.
- **Replacing the web as the primary surface.** Native is an additional delivery path for the same application, not a migration off it.

## Background and Existing Foundation

Three properties of the shipped application decide most of this phase's shape. All three are already true; none is prerequisite work.

**The Event id is already a runtime value.** `EVENT_ID` is a mutable live binding in `src/firebase.ts`, resolved before the application mounts by `applyResolvedEventId()` (ADR 0009). Every consumer reads it inside a function, so each call re-reads the binding. A join-by-code flow is a second producer on a resolution path that is already pluggable, not a refactor of one that is not.

**The Edition is already a runtime skin.** `setActiveEdition()` swaps the entire brand record—wordmark, endorsement byline, lexicon, taglines, themes, share marks, podium labels—and the hostname resolver already calls it. The build configuration names this exact case: a hostname-resolved bundle defers to the lookup and takes the default, precisely so one bundle can serve every Event. A native binary is that shared bundle.

**The adult-content posture follows the Event's pool, not its Edition** (ADR 0012). The Bodega Bay pool is 120 Prompts at a spicy ratio of zero—a general-audience Event by construction. The explicit pool exists only in the legacy Gay Cruise Bingo payload. The store's content-rating question is therefore a question about which Events a binary can reach, which § Decision 1 answers.

## Proposal

### Overview

One Capacitor binary wrapping the existing web application, published as a single Five Across listing. The web layer ships inside the bundle and updates over the air; the native shell supplies camera, microphone, share sheet, push, and deep links. Events arrive by Universal Link or join code, and the resolved Event's Edition skins the whole in-app experience at runtime.

### Decision 1—the native resolver gates on adult-content posture, not on Edition

**The native application refuses to resolve any Event whose server-derived `adultContent` posture is true, of any Edition. It resolves every general-audience Event, of any Edition—Gay Cruise Bingo included.**

An earlier draft of this decision whitelisted Editions and excluded Gay Cruise Bingo outright. That was wrong on its own terms: ADR 0012 makes the adult posture a property of the **Event's Prompt pool**, explicitly independent of Edition—"a `fiveacross` Event with spicy Prompts is 18+ with general vocabulary; a `gcb` Event with a tame pool is not 18+ at all." An Edition whitelist gates the wrong axis, and it would have excluded a tame GCB Event that poses no store problem while admitting a spicy Vacay Event that does.

Gating on the posture instead is both narrower and stronger. It reuses a field that is already server-derived, already world-readable on the routing document, and already fails closed—anything that is not a proven `false` reads as `true`. It needs no whitelist to maintain as Editions are added, and it keeps the store rating honest by construction: the binary can only ever reach general-audience pools, so the rating covers everything reachable through it.

**Gay Cruise Bingo therefore remains usable in the native application** whenever its pool is general-audience. What it cannot do is serve its explicit cruise pool through a store binary rated for general audiences—which is a constraint on one pool, not on an Edition, and not on the web at all.

**Timing is not the safeguard, and should not be treated as one.** The next Atlantis sailing is scheduled for summer 2027 ([itinerary](https://atlantisevents.com/vacation/copenhagen-to-stockholm-cruise/addons/)), so the GCB Event is inactive today and its hostname documents already resolve to not-found on `status` alone. It is true that a reviewer cannot reach the pool during an initial submission. But store compliance is assessed against what a shipped binary can do in production, not against what a reviewer happened to find: review recurs on every native-shell submission, both stores audit live applications after release, and the 2027 window is precisely when GCB players would be using the app. A gate that depends on an Event being switched off is a gate that fails exactly when it matters. The posture check costs one predicate and does not.

Implementation is a check in the **native bootstrap**, after the shared resolver returns and before the Event id is installed: a resolution whose `adultContent` is true becomes not-found and renders the existing not-found screen, with copy directing the player to the web. Three constraints matter. It is native-only and must not apply on the web, where the 18+ acknowledgement remains the correct control. It must live in the bootstrap rather than in a view, so a deep link cannot route around it. And because the field fails closed, an Event that cannot be proven general-audience is refused rather than admitted—the safe direction for a store binary.

This preserves the parent PRD's commitment that Gay Cruise Bingo "remains live on its existing Firebase project, preserving installed PWAs, saved links, authentication callbacks, cruise-specific entry points, and adult event history." Nothing about GCB on the web changes.

**If the 2027 cruise should run natively with its explicit pool**, that is a different decision with a different price: ship the single listing at 17+ and keep the adult acknowledgement in the app. See § Open Decisions—it is a live option, not a foreclosed one, and it is the only path that puts an explicit pool in a store binary.

### Decision 2—the join code is the Event Slug, keyed into the existing hostname lookup

**Write a second, Slug-keyed document into the existing `hostnames` collection alongside each Event's real hostname documents. The join code is the Slug.**

```
hostnames/bodega-bay.vacaybingo.com   ← web, canonical (existing)
hostnames/bodega-bay.fiveacross.app   ← web, platform alias (existing)
hostnames/bodega-bay                  ← native join code (new, same shape)
```

A native application has no hostname, so hostname resolution cannot be its Event source. The Slug already exists on the hostname document and the resolver already documents it as an analytics dimension and never an authorization secret—which is exactly the property a code typed into a group chat needs. ADR 0009 makes the same argument in the other direction: knowing an address grants nothing, because every read of Event data still passes the membership gate.

Keying the code into the same collection means the join flow inherits rather than reimplements:

| Reused | What it gives the join flow |
|---|---|
| The `hostnames` security rule | Single-document `get` is allowed and `list` is denied, so the collection never becomes a directory of every Event—the precise property a guessable join code requires |
| The pure resolver | An injectable decision table already returning missing, inactive, and unreachable—the join screen's three error states |
| The resolution type | Event id, Edition, adult-content posture, canonical hostname, and the sign-in preview all arrive together |
| Cache and staleness logic | The bounded stale window and server-read revalidation rule apply unchanged |
| The seed payloads | One additional document per Event in the existing per-Event seed module |

Net new code is a join screen, a stored last-joined code so relaunch skips it, and a "leave Event" affordance that remounts the root. No new collection, no new rule, no new type, no new resolver.

**The join code is the primary install path, not a fallback.** Universal Links carry context only when the application is already installed. A player who taps an invite, is bounced to the browser, installs from the store, and then opens the app from the home screen arrives with no Event context—the link is gone. Every invite surface must therefore print the code beside the store button: *"Install Five Across, then enter code: bodega-bay."*

### Canonical domain

**`fiveacross.app` is the platform's canonical domain, superseding `fiveacrossbingo.com` in the parent PRD's domain table.** The change was made mid-flight on two grounds: `fiveacross.app` was available and is the shorter, more speakable form of the wordmark, and a `.app` domain is materially better suited to this phase—the TLD is HSTS-preloaded, so every association-file fetch and every deep link is HTTPS by construction, which is exactly what Universal Links and App Links require.

The rest of the parent's domain architecture is unchanged. `vacaybingo.com` remains the canonical player-facing namespace for travel Events, so Bodega Bay stays canonical at `bodega-bay.vacaybingo.com` with `bodega-bay.fiveacross.app` as its platform alias. Gay Cruise Bingo keeps `gaycruisebingo.com` and its legacy project. Only the master-brand and platform-namespace rows change domain.

The parent PRD's domain table has not yet been amended and still reads `fiveacrossbingo.com`; see § Open Decisions.

### Universal Links and App Links

Association files at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, served over the existing Hosting configuration with a header rule forcing the JSON content type on the extension-less Apple file.

Both namespaces must carry them, because either can be the address a player taps: `fiveacross.app` and its wildcard for platform addresses, and `vacaybingo.com` and its wildcard for canonical travel-Event addresses. `gaycruisebingo.com` deliberately carries neither—under Decision 1 the application will not resolve a GCB Event, so a GCB deep link must continue to open the web application rather than bounce off an app that would refuse it.

Per-Event subdomains are close to free, because the wildcard namespaces the parent PRD establishes in Phase 0 resolve to one Hosting site per namespace—one association file serves every Event host under it, and Apple's subdomain wildcard covers the rest. The application-not-installed path degrades to the web application by design, which is the correct fallback and needs no attribution service.

The native side is a URL-open listener that parses the incoming address, maps host or path to a Slug, runs the same gated resolution as the join screen, and routes.

### Runtime skin and fixed identity

Everything inside the application re-skins from the resolved Edition: wordmark and endorsement byline, the full lexicon, taglines, offline copy, themes, share marks and share text, champion and podium labels, schedule titles, and update copy. This is what makes the parent's one-identity rule hold in a native shell—after a player enters, they see Vacay Bingo by Five Across, never competing branding.

Fixed per binary are the home-screen icon and the application name, which come from the native bundle rather than the web manifest. A player who installs from a Vacay invite sees **Five Across** on the home screen and **Vacay Bingo by Five Across** inside. This is the established pattern for event-platform applications and reads as normal.

This is a genuine narrowing of the parent's rule that installed-app identity follows the canonical hostname. On the web that rule still holds exactly. In the native shell the installed identity is the platform and the in-app identity is the Edition, and the parent's brand hierarchy—Five Across as the recognizable foundation, the Edition owning the emotional layer—is what makes that acceptable rather than a violation.

### Over-the-air updates

The web bundle ships inside the binary and updates at runtime. Both stores permit this explicitly for interpreted code running in a web view, provided it does not change the application's primary purpose; bug fixes and content changes sit squarely inside that allowance.

A remote-first shell pointing at the live site was rejected twice over. It is the textbook minimum-functionality rejection, and it fails on constrained venue networks that block the application's own domain—precisely when the app is most needed. A bundled application reaching only its update host and the Firebase APIs sidesteps that class of failure.

The operating split is **web layer instant, native shell reviewed**. Everything in the application source, the Cloud Functions, and the security rules ships as it does today. The native shell—plugins, capabilities, icons, framework version—needs a submission, and should be touched two or three times a year.

**Service workers do not survive this transition.** Capacitor serves over a custom scheme where web views do not register service workers, so the precache layer, shell-recovery machinery, install prompt, update prompt, and custom pull-to-refresh come out—roughly 1,800 lines deleted and replaced by the bundle updater and the platform's own refresh control. This retires an entire class of failure the project has already paid for twice, and the platform's native offline persistence covers what ADR 0006 currently builds by hand. ADR 0006 and ADR 0005 both need a native-delivery amendment recorded in the application repository.

### Trust, safety, and compliance

- **Sign in with Apple becomes mandatory** because the application offers Google sign-in. It is absent today. This touches authentication configuration and the attestation flow, and it interacts with the parent's centralized-auth decision: the native client uses native sign-in rather than the web handoff, which removes the redirect-origin problem for installed players but does not remove it for the web.
- **Player-level blocking becomes mandatory, and is approved to start.** Both stores require it for an application with a shared user-generated feed, alongside content filtering and reporting—which already exist. Blocking does not. It is required whether or not this phase ever ships, it strengthens the parent PRD's isolation commitments today, and **this phase is gated on it**, so it starts first and independently. What "required" means concretely:
  - **Reciprocal by default.** A block hides each player from the other. One-way blocking leaves the blocker visible to the person they blocked, which is the case the requirement exists for.
  - **Every shared read path honors it**—Feed, proofs, hearts, doubts, tally markers, moments, leaderboard entries, and avatars. A block that hides the Feed but leaves the blocked player on the podium is not a block.
  - **Enforced in rules, not only in the client.** A client-side filter is a display preference; the requirement is an access control. This is the substantial part of the work.
  - **Self-serviceable and reversible** from the blocked player's own surfaces, without an admin.
  - **Scoped per Event, stored per player**, consistent with the event-scoped data model rather than as a global social graph.
  - **Does not silently distort scoring.** Blocking is a visibility control, not a scoring one; standings stay computed on the real population, and the interaction with the honor-system trust model (ADR 0001) needs stating in the spec.
- **The sharper content-policy exposure is the proof feed, not the Prompt text.** An earlier draft of this document asserted that no age rating covers the legacy Prompt pool. That overstates it: the prohibition on pornographic material targets explicit imagery and erotica, and crude comedic text ships on 17+ applications routinely. What genuinely carries risk on an adult Event is **player-uploaded photography** in a shared feed, which is why blocking, reporting, and the automated flagging path are the load-bearing controls rather than the Prompt wording. This is the real reason a general-audience rating is the safer default, and the real cost of a 17+ listing.
- **Content rating.** With Decision 1 in force the binary reaches only general-audience pools, so expect a low rating on both stores.
- **Store review needs a working demo code** in the review notes. A reviewer who lands on a bare join screen with no way in is a rejection for reasons unrelated to the product.
- **Play's closed-testing requirement.** A new personal developer account must run a closed test with a dozen or more testers for fourteen continuous days before production access. An organization account is exempt. Verify current terms before planning around them.

## Functional Scope and Level of Effort

Single engineer, iOS first.

| Workstream | Days |
|---|---:|
| Capacitor scaffold, iOS and Android targets, build configuration | 3–4 |
| Retire the service-worker layer in favor of the bundle updater | 4–5 |
| Native Google sign-in and Sign in with Apple | 5–6 |
| Camera, microphone, and photo picker for proof capture and avatars | 3–4 |
| Share cards to native share sheet and view capture (ADR 0005 amendment) | 3–4 |
| Push notifications wired to the existing notification family | 4–5 |
| Universal Links and App Links | 3–4 |
| Join screen and Edition gate (Decisions 1 and 2) | 4–5 |
| Player-level blocking (rules, functions, read paths) | 5–7 |
| Store setup, assets, privacy labels, testing tracks, review cycles | 5–8 |
| **Total** | **39–52 days ≈ 8–10 weeks** |

Android adds **1.5–2 weeks** for back-button handling, device coverage, and Play submission. The fourteen-day closed-test window runs in parallel and should start early.

**Exit condition:** a player can install Five Across from either store, arrive at the correct Event and Edition by link or code, play a full Day offline-tolerant, and receive the daily unlock as a push notification—while a copy fix still reaches them the same day without a store submission.

## Dependencies and Risks

| Dependency or risk | Impact | Mitigation |
|---|---|---|
| Store review rejects the build as insufficiently native | High | Ship bundled rather than remote-first; the platform shape—multi-Event, accounts, camera, push, deep links—is the argument, and a single-Event wrapper is what gets rejected. |
| The Edition gate is bypassed and a reviewer reaches an adult pool | High | Enforce in the native bootstrap, never in a view a deep link could route around; regression-test that a GCB Slug is not-found natively and unchanged on web. |
| Player-level blocking lands late and blocks submission | High | Start it first and independently; it is required either way and ships value to the PWA immediately. This phase is explicitly gated on it. |
| Post-install link context is lost and players strand on the join screen | Medium | Treat the code as the primary path and print it on every invite surface beside the store button. |
| Play's fourteen-day closed test collides with an Event date | Medium | Use an organization account, or start the clock well before any Event depends on it. |
| The shipped bundle needs a plugin the installed shell lacks | Medium | Carry a minimum-shell-version field in the bundle manifest and refuse an incompatible bundle rather than crashing into it. |
| The Event id is installed after mount and listeners point at the wrong Event | Medium | Join, set, remount—never hot-swap. The call-once contract is load-bearing. |
| Native sign-in diverges from the centralized web auth origin | Medium | Treat them as two paths to one identity; verify account continuity for a player who uses both web and app. |
| Store search does not surface Edition names | Low | Put Edition names in the store keywords field; distribution is invite-driven, not search-driven. |
| Association-file caching slows deep-link verification | Low | Budget testing time beyond what the code size suggests and test on real devices. |

## Open Decisions

- [ ] Does this phase ship iOS-only first, or iOS and Android together? Android's PWA already works well, so its increment is small but not obviously worth paying at the same time.
- [ ] Does the parent PRD's domain table get amended in place, or does this document stand as the record of the change? § Canonical domain settles the fact; the parent's table still reads `fiveacrossbingo.com` and is now stale.
- [ ] Should the join screen accept a pasted invite URL as well as a bare Slug? Cheap, and covers the player who copies the link rather than the code.
- [ ] Does the bundle updater apply quietly on next launch, or prompt as the web update flow does today? The current prompt copy is Edition-branded and would otherwise be deleted.
- [ ] **Does the summer-2027 Atlantis sailing run natively with its explicit pool?** This is the one decision that changes the store rating. Rated for general audiences, the binary reaches only tame pools and that cruise plays on the web, as every prior sailing has. Rated 17+, it can carry the explicit pool—at the cost of every wedding, conference, and family trip inheriting a 17+ listing, and of a materially higher moderation bar on the proof feed (see § Trust, safety, and compliance). **Recommendation: stay general-audience and let the 2027 cruise play on the web.** The PWA is the surface that sailing has always used, GCB players are the cohort least likely to need a store install, and the rating cost falls on every other Event. Revisit only if native-only capabilities—push, offline capture—become load-bearing for a cruise.
- [ ] Does native delivery change the Phase 5 self-service story—can an organizer's Event be reached from the app without a developer registering anything? Under Decision 2 the answer should be yes automatically, but it needs confirming against the organizer flow.

## Appendix

- **Parent:** [Five Across Bingo](fiveacrossbingo.md) § Migration Plan (Phases 0–6), § Non-Goals, § Editions.
- **Source brief:** [Gay Cruise Bingo](gaycruisebingo.md).
- **Application repository surfaces:** `CONTEXT.md` (ubiquitous language) · `docs/adr/0005`, `0006`, `0009`, `0012` · `docs/app/README.md` and `docs/app/phase-1-deploy.md` (prior delivery phases) · `specs/hostnames-lookup.md`.
- **Editions and store eligibility:** Five Across (platform register—ships) · Vacay Bingo, by Five Across (travel edition—ships) · Gay Cruise Bingo (legacy edition—web only, see Decision 1).
- **Store facts:** Apple Developer Program is 99 USD per year; Google Play is a one-time 25 USD registration. Both stores permit over-the-air updates to interpreted web-view code that does not change the application's primary purpose.
