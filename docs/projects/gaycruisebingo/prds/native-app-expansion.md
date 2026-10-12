---
tags:
  - fiveacrossbingo
  - gaycruisebingo
  - prd
  - native
  - ios
  - android
---
<!--
generated_by: scripts/project-doc-sync.sh
do_not_edit: true
source_repo: nathanjohnpayne/docs
source_path: projects/gaycruisebingo/prds/native-app-expansion.md
source_ref: ae89224
project: gaycruisebingo
document_class: prd
document_slug: native-app-expansion
sync_direction: central-to-repo
-->

# Five Across—Native App Expansion

**Phase:** 7, extending the Migration Plan in the parent PRD (Phases 0–6).
**Delivery model:** Capacitor shell over the existing web application; one binary, one store listing, Editions as runtime skin.
**Primary domain:** `fiveacross.app`—supersedes `fiveacrossbingo.com` in the parent PRD; see § Canonical domain.
**Author:** Nathan Payne
**Status:** Draft—not yet scheduled. The block-user gate has since shipped (#689, PRs #1300/#1304/#1307, 2026-09-25; ADR 0016, `specs/player-blocking.md`); no Capacitor shell exists in the app repo as of 2026-10-05. Reconciled 2026-10-12 against ADR 0009, ADR 0016, and `specs/hostnames-lookup.md` (docs#15)
**Last Updated:** 2026-10-12
**Parent PRD:** [Five Across Bingo](fiveacrossbingo.md)
**Source brief:** [Gay Cruise Bingo](gaycruisebingo.md)

> **This phase supersedes a parent Non-Goal, as the parent anticipated.** The parent lists "Native App Store or Play Store applications. The PWA remains the *initial* delivery model." That wording reserved the option rather than closing it, and this document exercises it. The Non-Goal remains in force for **Gay Cruise Bingo** in two respects: it gets no store listing of its own, and its explicit pool never ships in a store binary. A general-audience GCB Event may still resolve in the Five Across app—see § Decision 1.

### Where each kind of decision lives

This document follows the parent's split. It is authoritative for the **product intent of native delivery**: why a store build, what ships in it, which Events it may reach, and how a player gets from an invite to a card. It is not the home for implementation contracts or architecture decisions, which stay in the application repository:

| Surface | Owns |
|---|---|
| `CONTEXT.md` | The ubiquitous language—Edition, Event, Slug, Prompt, Day. |
| `docs/adr/**` | The hard-to-reverse architectural decisions. This phase touches ADR 0005 (share images), 0006 (offline resilience), 0009 (Event resolved from hostname), 0012 (server-derived adult-content posture), and 0016 (player blocking). |
| `specs/**` | Implementation contracts and acceptance criteria per shipped behavior. |
| GitHub epics | The work breakdown, dependencies, review path, and per-ticket acceptance. |

## Recommendation

Ship a **Capacitor shell** around the existing web application as a single **Five Across** listing on the App Store, with Google Play as a fast follow. Do not rewrite the client in SwiftUI or React Native. Do not create per-Edition listings. Do not give Gay Cruise Bingo a listing, and do not put its explicit pool in a store binary.

The client is roughly 32.5k lines of production TypeScript against 46k lines of tests. A SwiftUI rewrite reuses none of it and costs five to seven months; React Native reuses about a third—the data layer and game logic—and costs two and a half to four months. A Capacitor shell keeps essentially all of it and costs roughly seven to nine weeks including compliance, before two pieces of work this document leaves open and does not estimate: native offline persistence (§ Over-the-air updates) and the join-code record shape (§ Decision 2), which is the only option whose cost is proportionate to what native actually buys this product.

What native buys is specific and worth naming: iOS install friction disappears, a push channel opens for the daily unlock, and "download the app" replaces "visit this URL" as the invite instruction. What it must not cost is the mid-Event hotfix path, which over-the-air bundle updates preserve for the fixes store policy allows (§ Over-the-air updates).

## Problem Statement

The PWA delivery model is strong on Android and weak on iOS, and the parent PRD's phone-native goal is only half met as a result.

Safari never fires `beforeinstallprompt`, so iOS installation is a manual Share-sheet ritual that has to be explained in the invite. Push notifications require the player to have already home-screened the app, which most will not have done. For the wedding, conference, and group-trip Events that Phase 5 makes self-service, an organizer telling twenty guests to "visit this URL and then add it to your home screen" loses people at exactly the moment attention is highest.

The product also has a recurring re-engagement beat it cannot currently deliver to a lock screen. The daily unlock already reaches inboxes through the Phase 1 email family; it does not reach notifications, which is where a trip-day prompt belongs.

## Goals and Success Metrics

- **Goal: Remove iOS install friction.** **Metric:** invite-link to first-mark conversion on iOS reaches or exceeds the Android PWA baseline for the same Event.
- **Goal: Open a push channel.** **Metric:** the daily unlock reaches lock screens; at least half of installed players have notifications enabled at Event start.
- **Goal: Preserve the mid-Event hotfix path.** **Metric:** an eligible change—content, configuration, or a policy-qualified bug fix in the web layer (§ Over-the-air updates)—reaches players in under an hour with no store submission, matching today's deploy cadence. Feature and native-capability changes go through store review and are outside this metric.
- **Goal: One binary serves every shippable Edition.** **Metric:** a single listing renders the correct Edition skin from an invite link or join code, with no per-Edition build.
- **Goal: Do not regress the web.** **Metric:** the PWA remains canonical and every Event stays fully playable in a browser, including for players who never install.

## Non-Goals

- **A SwiftUI or React Native rewrite.** Wrong cost for a 5×5 grid; see § Recommendation.
- **Per-Edition store listings.** Two listings double review, compliance, and update channels to buy marketing surface that store copy already provides.
- **A Gay Cruise Bingo store listing, or its explicit pool in a store binary.** General-audience GCB Events may still resolve in the Five Across app; see § Decision 1.
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

One Capacitor binary wrapping the existing web application, published as a single Five Across listing. The web layer ships inside the bundle and updates over the air within the limits store policy sets (§ Over-the-air updates); the native shell supplies camera, microphone, share sheet, push, and deep links. Events arrive by Universal Link or join code, and the resolved Event's Edition skins the whole in-app experience at runtime.

### Decision 1—the native resolver gates on adult-content posture, not on Edition

**The native application refuses to resolve any Event whose server-derived `adultContent` posture is true, of any Edition. It resolves every general-audience Event, of any Edition—Gay Cruise Bingo included.**

An earlier draft of this decision whitelisted Editions and excluded Gay Cruise Bingo outright. That was wrong on its own terms: ADR 0012 makes the adult posture a property of the **Event's Prompt pool**, explicitly independent of Edition—"a `fiveacross` Event with spicy Prompts is 18+ with general vocabulary; a `gcb` Event with a tame pool is not 18+ at all." An Edition whitelist gates the wrong axis, and it would have excluded a tame GCB Event that poses no store problem while admitting a spicy Vacay Event that does.

Gating on the posture instead is both narrower and stronger. It reuses a field that is already server-derived, already readable before sign-in on the public routing projection (`publicHostnames/{host}`, #1419), and already fails closed—anything that is not a proven `false` reads as `true`. It needs no whitelist to maintain as Editions are added, and it keeps the store rating honest by construction: the binary can only ever reach general-audience pools, so the rating covers everything reachable through it.

**Gay Cruise Bingo therefore remains usable in the native application** whenever its pool is general-audience **and its Event lives in the Five Across Firebase project.** The binary initializes Auth, Firestore, Functions, and Storage once, from one build-time Firebase configuration (`src/firebaseCore.ts`). Event resolution changes only the Event id and Edition, never the project. The existing GCB Event lives in the legacy `gaycruisebingo` project, which the binary cannot reach, so that Event stays web-only. Reaching an Event in another project would first require defining its project identity and switching clients before Firebase initializes. This document does not commission that work. What it cannot do is serve its explicit cruise pool through a store binary rated for general audiences—which is a constraint on one pool, not on an Edition, and not on the web at all.

**Timing is not the safeguard, and should not be treated as one.** The next Atlantis sailing is scheduled for summer 2027 ([itinerary](https://atlantisevents.com/vacation/copenhagen-to-stockholm-cruise/addons/)), so the GCB Event is inactive today and its hostname documents already resolve to not-found on `status` alone. It is true that a reviewer cannot reach the pool during an initial submission. But store compliance is assessed against what a shipped binary can do in production, not against what a reviewer happened to find: review recurs on every native-shell submission, both stores audit live applications after release, and the 2027 window is precisely when GCB players would be using the app. A gate that depends on an Event being switched off is a gate that fails exactly when it matters. The posture check costs one predicate and does not.

Implementation is a check in the **native bootstrap**, after the shared resolver returns and before the Event id is installed. It distinguishes two outcomes, and both keep access closed:

- **Adult posture confirmed by a server read** (`adultContent: true`, `adultContentProven: true`): the Event is not available in the app. Render the existing not-found screen, with copy directing the player to the web.
- **Posture unproven** (`adultContentProven: false`): the resolver could not confirm the posture. For example, revalidating a cached general-audience posture failed, so the resolver keeps the cached Event mapping but reports `adultContent: true` (`src/eventResolution.ts`, `src/adult-content.test.ts`). Keep access blocked, but do not claim the Event does not exist. **Recommendation:** show a retryable "Couldn't verify this Event" state whose retry re-runs resolution. The cached Event identity may label that state and drive the retry, but it never permits showing the Event's content. The retry experience is a recommendation for the implementing spec, not a settled contract.

Four constraints matter. It is native-only and must not apply on the web, where the 18+ acknowledgement remains the correct control. It must live in the bootstrap rather than in a view, so a deep link cannot route around it. Because the field fails closed, an Event that cannot be proven general-audience is never admitted—the safe direction for a store binary.

The fourth constraint: **the gate must keep watching after bootstrap.** The posture can rise during a session, for example when an Admin approves an Event's first explicit Prompt or enables the adult override and the server re-derives the routing document. A launch-time check alone would leave a session that resolved general-audience showing the newly adult content. The app already watches posture live (`src/components/AdultContentWatcher.tsx`, ADR 0012). On the web, a rise re-shows the 18+ acknowledgement, and an attested Player continues. In the native shell an acknowledgement is not enough: a rise to adult, or a lost live read that returns the posture to unproven, must block or leave the Event before the newly adult content renders. Treat it as a bootstrap rejection: show the not-found or retryable state and remount without the Event. **The live subscription must be keyed to the record that resolved the Event.** Today the watcher subscribes to `publicHostnames/{window.location.hostname}` (`src/components/AdultContentWatcher.tsx`, `src/data/hostnames.ts`). In a Capacitor shell that hostname is the shell's own host, not an Event address, and an Event entered by join code has no Event hostname at all. Watching the shell host would either eject every general-audience Event under the fail-closed rule or miss the adult transition. The native bootstrap must keep the public-record key it resolved through (an Event hostname or the join-code record from Decision 2) and pass it to the live watcher.

This preserves the parent PRD's commitment that Gay Cruise Bingo "remains live on its existing Firebase project, preserving installed PWAs, saved links, authentication callbacks, cruise-specific entry points, and adult event history." Nothing about GCB on the web changes.

**If the 2027 cruise should run natively with its explicit pool**, that is a different decision with a different price: ship the single listing at 17+ and keep the adult acknowledgement in the app. See § Open Decisions—it is a live option, not a foreclosed one, and it is the only path that puts an explicit pool in a store binary.

### Decision 2—the join code is the Event Slug, resolved through the public hostname projection

**Give each Event a Slug-keyed join-code record alongside its hostname records, following the same paired canonical/public projection contract. The join code is the Slug.**

```
hostnames/bodega-bay.fiveacross.app          ← canonical source, signed-in-only (existing)
publicHostnames/bodega-bay.fiveacross.app    ← its public projection (existing)
hostnames/bodega-bay.vacaybingo.com          ← alias, serves in place (existing)
publicHostnames/bodega-bay.vacaybingo.com    ← its public projection (existing)
bodega-bay                                   ← native join code (new; record shape open, see below)
```

A native application has no hostname, so hostname resolution cannot be its Event source. The Slug already exists on the hostname document and the resolver already documents it as an analytics dimension and never an authorization secret—which is exactly the property a code typed into a group chat needs. ADR 0009 makes the same argument in the other direction: knowing an address is meant to grant nothing, because once membership enforcement lands every read of Event data must pass the membership gate. That gate is a target contract, not a property of the current rules: reads are gated on sign-in today (ADR 0009). The join code is therefore exactly as safe as a hostname is now, and no safer.

**The join screen runs before sign-in, so it must read the public projection.** Since #1419, anonymous resolution reads only the field-allowlisted `publicHostnames/{host}` projection, and canonical `hostnames/{host}` is signed-in-only (`specs/hostnames-lookup.md`). An earlier draft of this decision read a Slug-keyed document from `hostnames` before sign-in and promised no new collection, rule, type, or resolver. Neither holds under the current contract.

What the join flow can still inherit:

| Reused | What it gives the join flow |
|---|---|
| The `publicHostnames` security rule | Single-document `get` is allowed for allowlisted documents and `list` is denied, so the collection never becomes a directory of every Event—the precise property a guessable join code requires |
| The paired lifecycle writer | `scripts/event-router-registry/hostname-lifecycle.mjs` writes the canonical record and its public projection in one transaction, so the two cannot drift |
| The pure resolver | An injectable decision table already returning missing, inactive, and unreachable—the join screen's three error states |
| The resolution type | Event id, Edition, adult-content posture and its proof state, canonical hostname, and the sign-in preview all arrive together |
| Cache and staleness logic | The bounded stale window and server-read revalidation rule apply unchanged |

**Open prerequisite: the join-code record's shape.** A bare Slug is not a hostname. The lifecycle helper also writes the edge router's `routerReplicas/{host}` ledger and validates hosts against the namespace contract, so a Slug-keyed record may not fit it unchanged. Decide in the application repository whether a join code is a new lifecycle intent, a separate public projection keyed by Slug, or something else. The answer may need rules, type, or writer changes, and it must keep the canonical and public copies paired. **It must also participate in adult-posture derivation.** Today `raiseAdultContentForEvent` (`functions/src/adultContent.ts`) finds only `hostnames` rows by `eventId` and stamps their paired public copies. If a separate join-code record is not covered by every adult-posture trigger and by reconciliation, a code-joined native session could watch a stale `false` after the first explicit Prompt is approved or the adult override is enabled. Either bring the record into derivation, or constrain the join code to the covered hostname model. In both cases, add a regression test that raises the posture and checks it on the join-code record. The public-projection contract is accepted and its source writers are paired, but backfill and production rollout are separately authorized (ADR 0009). The join flow must not assume them until they are verified.

Net new product surface is a join screen, a stored last-joined code so relaunch skips it, and a "leave Event" affordance that remounts the root—plus whatever the record-shape decision above requires.

**The join code is the primary install path, not a fallback.** Universal Links carry context only when the application is already installed. A player who taps an invite, is bounced to the browser, installs from the store, and then opens the app from the home screen arrives with no Event context—the link is gone. Every invite surface must therefore print the code beside the store button: *"Install Five Across, then enter code: bodega-bay."*

### Canonical domain

**`fiveacross.app` is the platform's canonical domain, superseding `fiveacrossbingo.com` in the parent PRD's domain table.** The change was made mid-flight on two grounds: `fiveacross.app` was available and is the shorter, more speakable form of the wordmark, and a `.app` domain is materially better suited to this phase—the TLD is HSTS-preloaded, so every association-file fetch and every deep link is HTTPS by construction, which is exactly what Universal Links and App Links require.

The parent PRD's domain table was amended in place on 2026-08-08 to match. Two mechanism changes from the same work also apply here. First, every registered host serves in place, so an alias no longer redirects to its canonical host (#599). Second, the `fiveacross.app` address is canonical. Bodega Bay is canonical at `bodega-bay.fiveacross.app` (migration applied 2026-09-10, #960), and `bodega-bay.vacaybingo.com` serves in place as an alias. `vacaybingo.com` remains the Edition-branded player-facing namespace for travel Events. Gay Cruise Bingo keeps `gaycruisebingo.com` and its legacy project. *Historical:* an earlier draft of this section kept Bodega canonical at `bodega-bay.vacaybingo.com` and recorded the parent table as unamended.

### Universal Links and App Links

Association files at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, served over the existing Hosting configuration with a header rule forcing the JSON content type on the extension-less Apple file.

Both namespaces must carry them, because either can be the address a player taps: `fiveacross.app` and its wildcard for platform addresses, and `vacaybingo.com` and its wildcard for Edition-branded travel-Event addresses. `gaycruisebingo.com` deliberately carries neither, so every GCB-domain link keeps opening the web application. The reason is not that the app refuses GCB Events: under Decision 1 it resolves any general-audience Event, GCB included. The reason is the domain itself. It is the legacy edition's doorway on its own Firebase project, and the parent PRD commits to leaving its installed PWAs, saved links, and authentication callbacks unchanged. Claiming its links for the app would reroute that cohort's existing links. Decision 1 still governs any GCB Event the app reaches by join code or a platform address.

Per-Event subdomains are close to free, because the wildcard namespaces the parent PRD establishes in Phase 0 resolve to one Hosting site per namespace—one association file serves every Event host under it, and Apple's subdomain wildcard covers the rest. The application-not-installed path degrades to the web application by design, which is the correct fallback and needs no attribution service.

The native side is a URL-open listener that parses the incoming address, maps host or path to a Slug, runs the same gated resolution as the join screen, and routes.

### Runtime skin and fixed identity

Everything inside the application re-skins from the resolved Edition: wordmark and endorsement byline, the full lexicon, taglines, offline copy, themes, share marks and share text, champion and podium labels, schedule titles, and update copy. This is what makes the parent's one-identity rule hold in a native shell—after a player enters, they see Vacay Bingo by Five Across, never competing branding.

Fixed per binary are the home-screen icon and the application name, which come from the native bundle rather than the web manifest. A player who installs from a Vacay invite sees **Five Across** on the home screen and **Vacay Bingo by Five Across** inside. This is the established pattern for event-platform applications and reads as normal.

This is a genuine narrowing of the parent's rule that installed-app identity follows the canonical hostname. On the web that rule still holds exactly. In the native shell the installed identity is the platform and the in-app identity is the Edition, and the parent's brand hierarchy—Five Across as the recognizable foundation, the Edition owning the emotional layer—is what makes that acceptable rather than a violation.

### Over-the-air updates

The web bundle ships inside the binary and can update at runtime, but store policy limits what an update may carry, and the under-one-hour goal applies only to eligible payloads.

- **Eligible for an over-the-air update:** content and configuration changes (copy, Prompt text, themes, Event data), and bug fixes that restore already-reviewed behavior without adding or changing features.
- **Store submission required:** new features, changed functionality, and anything that touches native capabilities, plugins, permissions, or the shell.

[Apple App Review Guideline 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements) bars downloaded code that introduces or changes features or functionality. [Google Play](https://support.google.com/googleplay/android-developer/answer/16559646?hl=en) permits interpreted code such as JavaScript in a WebView, subject to its broader policies. Neither makes every bug fix automatically eligible: a fix that changes behavior a reviewer would recognize as new functionality goes through review. Classify each mid-Event change against this split before shipping it over the air, and submit it for review when in doubt.

A remote-first shell pointing at the live site was rejected twice over. It is the textbook minimum-functionality rejection, and it fails on constrained venue networks that block the application's own domain—precisely when the app is most needed. A bundled application reaching only its update host and the Firebase APIs sidesteps that class of failure.

The operating split is **eligible web-layer changes instant, everything else reviewed**. Cloud Functions and security rules are server-side and ship as they do today. Client changes in the web layer ship over the air only when they are eligible under the split above. The native shell—plugins, capabilities, icons, framework version—needs a submission, and should be touched two or three times a year.

**Native offline behavior needs a named, tested persistence strategy before any shared offline code is retired.** An earlier draft said service workers do not survive the transition and that platform persistence covers what ADR 0006 builds by hand. Neither holds as stated. The targets differ: on iOS, Capacitor serves the bundle over a custom scheme where the web view does not register service workers, while Android serves over `https` by default and does expose service-worker request handling ([Capacitor configuration](https://capacitorjs.com/docs/config)). And wrapping the app changes nothing about its data layer: the retained Firebase JavaScript SDK does not gain native-SDK persistence ([Firestore offline persistence](https://firebase.google.com/docs/firestore/manage-data/enable-offline)), and the pending Mark and media queues are application code that no shell provides.

- **Do not retire** the precache layer, shell-recovery machinery, or offline queues on the native path until a named persistence approach covers durable gameplay queues and offline cold boot, and is tested in the native shell. Up to roughly 1,800 lines could then come out of the native path, replaced by the bundle updater and the platform's own refresh control.
- **That approach is an open prerequisite** (fiveacross#1767; § Open Decisions). This document does not choose it.
- **The browser path keeps** its offline, install, and update behavior unchanged.
- ADR 0006 and ADR 0005 both need a native-delivery amendment recorded in the application repository.

### Trust, safety, and compliance

- **Sign in with Apple becomes mandatory** because the application offers Google sign-in. It is absent today. This touches authentication configuration and the attestation flow, and it interacts with the parent's centralized-auth decision: the native client uses native sign-in rather than the web handoff, which removes the redirect-origin problem for installed players but does not remove it for the web.
- **Player-level blocking is required by both stores for an application with a shared user-generated feed, and it has shipped** (#689; PRs #1300/#1304/#1307, 2026-09-25; ADR 0016, `specs/player-blocking.md`). It started first and independently because this phase was gated on it. Content filtering and reporting already existed. This phase verifies the shipped contract in the native shell; it does not commission a second implementation. What shipped:
  - **Reciprocal, per pair, per viewer.** A block hides each Player from the other.
  - **Display-only on shared read paths.** The client hides the other Player at render across Feed, proofs, hearts, doubts, tally markers, moments, leaderboard rows, and podium entries, using the pair record both parties can read.
  - **Rules-enforced only where ADR 0016 chose:** the privacy and integrity of the block records themselves, and a Heart aimed across a pair. **Blocked reads are not rules-enforced.** A blocked Player who queries Firestore directly still receives the other Player's proofs, moments, markers, doubts, and hearts, and can fetch their avatar and media. The owner accepted this residual on 2026-09-24. Only reader-scoped server projections could close it, and they are not commissioned. An earlier draft of this document required rules-enforced reads; ADR 0016 supersedes that requirement.
  - **Doubts stay open.** A block never gates Doubt creation, so blocking cannot be used to evade the ADR 0001 verification channel; the pair's doubts are hidden from both parties only.
  - **Self-serviceable and reversible** by the blocker, without an admin.
  - **Scoring is unaffected.** Standings, records, and awards are computed on the real population; hidden leaderboard rows keep their rank gaps.
  - **Remaining native work:** verify reciprocal hiding and the Hearts denial in the native build before submission. If a store reviewer reads "blocking" as covering direct reads, point them at the spec's enforcement table, as ADR 0016 recommends.
- **The sharper content-policy exposure is the proof feed, not the Prompt text.** An earlier draft of this document asserted that no age rating covers the legacy Prompt pool. That overstates it: the prohibition on pornographic material targets explicit imagery and erotica, and crude comedic text ships on 17+ applications routinely. What genuinely carries risk on an adult Event is **player-uploaded photography** in a shared feed, which is why blocking, reporting, and the automated flagging path are the load-bearing controls rather than the Prompt wording. This is the real reason a general-audience rating is the safer default, and the real cost of a 17+ listing.
- **Content rating.** With Decision 1 in force the binary reaches only general-audience pools, so expect a low rating on both stores.
- **Store review needs a working demo code** in the review notes. A reviewer who lands on a bare join screen with no way in is a rejection for reasons unrelated to the product.
- **Play's closed-testing requirement.** A new personal developer account must run a closed test with a dozen or more testers for fourteen continuous days before production access. An organization account is exempt. Verify current terms before planning around them.

## Functional Scope and Level of Effort

Single engineer, iOS first. Player-level blocking shipped on 2026-09-25 and is no longer a workstream here; verifying it in the native build is part of store testing.

| Workstream | Days |
|---|---:|
| Capacitor scaffold, iOS and Android targets, build configuration | 3–4 |
| Bundle updater; retire native-path offline machinery once its persistence approach is chosen (the persistence work itself is not estimated) | 4–5 |
| Native Google sign-in and Sign in with Apple | 5–6 |
| Camera, microphone, and photo picker for proof capture and avatars | 3–4 |
| Share cards to native share sheet and view capture (ADR 0005 amendment) | 3–4 |
| Push notifications wired to the existing notification family | 4–5 |
| Universal Links and App Links | 3–4 |
| Join screen and adult-content posture gate (Decisions 1 and 2), excluding the open join-code record-shape work | 4–5 |
| Store setup, assets, privacy labels, testing tracks, review cycles | 5–8 |
| **Total** | **34–45 days ≈ 7–9 weeks, excluding the open native persistence and join-code record work** |

Android adds **1.5–2 weeks** for back-button handling, device coverage, and Play submission. The fourteen-day closed-test window runs in parallel and should start early.

**Exit condition:** a player can install Five Across from either store, arrive at the correct Event and Edition by link or code, play a full Day offline-tolerant, and receive the daily unlock as a push notification—while a copy fix still reaches them the same day without a store submission.

## Dependencies and Risks

| Dependency or risk | Impact | Mitigation |
|---|---|---|
| Native offline persistence is unresolved when the shell is otherwise ready | High | Do not retire native-path offline machinery or ship a native build that depends on it until a named persistence approach is tested (fiveacross#1767). The browser path is unaffected. |
| Store review rejects the build as insufficiently native | High | Ship bundled rather than remote-first; the platform shape—multi-Event, accounts, camera, push, deep links—is the argument, and a single-Event wrapper is what gets rejected. |
| The adult-content posture gate is bypassed and a reviewer reaches an adult pool | High | Enforce in the native bootstrap, never in a view a deep link could route around, and keep enforcing on live posture changes after launch. Regression-test on `adultContent`, not Edition: a server-confirmed adult Event is not-found natively; an unproven posture blocks access to the Event's content (the retryable state is the recommended presentation, not a tested contract); a general-audience Event of any Edition, GCB included, resolves; a mid-session rise to adult blocks the Event before the new content renders; web behavior is unchanged. |
| Shipped player blocking behaves differently in the native shell, or a reviewer expects rules-enforced reads | Medium | Blocking shipped (ADR 0016). Verify reciprocal hiding and the Hearts denial in the native build before submission, and cite the spec's enforcement table in review notes. |
| Post-install link context is lost and players strand on the join screen | Medium | Treat the code as the primary path and print it on every invite surface beside the store button. |
| Play's fourteen-day closed test collides with an Event date | Medium | Use an organization account, or start the clock well before any Event depends on it. |
| The shipped bundle needs a plugin the installed shell lacks | Medium | Carry a minimum-shell-version field in the bundle manifest and refuse an incompatible bundle rather than crashing into it. |
| The Event id is installed after mount and listeners point at the wrong Event | Medium | Join, set, remount—never hot-swap. The call-once contract is load-bearing. |
| Native sign-in diverges from the centralized web auth origin | Medium | Treat them as two paths to one identity; verify account continuity for a player who uses both web and app. |
| Store search does not surface Edition names | Low | Put Edition names in the store keywords field; distribution is invite-driven, not search-driven. |
| Association-file caching slows deep-link verification | Low | Budget testing time beyond what the code size suggests and test on real devices. |

## Open Decisions

- [ ] Does this phase ship iOS-only first, or iOS and Android together? Android's PWA already works well, so its increment is small but not obviously worth paying at the same time.
- [x] ~~Does the parent PRD's domain table get amended in place, or does this document stand as the record of the change?~~ Resolved: the parent table was amended in place on 2026-08-08; see § Canonical domain.
- [ ] **Native offline persistence (prerequisite).** Which named, tested persistence approach covers durable gameplay queues and offline cold boot on the native path before any shared offline code is retired? (fiveacross#1767; § Over-the-air updates)
- [ ] **Join-code record shape (prerequisite).** How does a Slug-keyed join code fit the paired canonical/public projection contract and the lifecycle writer? (§ Decision 2)
- [ ] Should the join screen accept a pasted invite URL as well as a bare Slug? Cheap, and covers the player who copies the link rather than the code.
- [ ] Does the bundle updater apply quietly on next launch, or prompt as the web update flow does today? The current prompt copy is Edition-branded and would otherwise be deleted.
- [ ] **Does the summer-2027 Atlantis sailing run natively with its explicit pool?** This is the one decision that changes the store rating. Rated for general audiences, the binary reaches only tame pools and that cruise plays on the web, as every prior sailing has. Rated 17+, it can carry the explicit pool—at the cost of every wedding, conference, and family trip inheriting a 17+ listing, and of a materially higher moderation bar on the proof feed (see § Trust, safety, and compliance). **Recommendation: stay general-audience and let the 2027 cruise play on the web.** The PWA is the surface that sailing has always used, GCB players are the cohort least likely to need a store install, and the rating cost falls on every other Event. Revisit only if native-only capabilities—push, offline capture—become load-bearing for a cruise.
- [ ] Does native delivery change the Phase 5 self-service story—can an organizer's Event be reached from the app without a developer registering anything? Under Decision 2 the answer should be yes automatically, but it needs confirming against the organizer flow.

## Appendix

- **Parent:** [Five Across Bingo](fiveacrossbingo.md) § Migration Plan (Phases 0–6), § Non-Goals, § Editions.
- **Source brief:** [Gay Cruise Bingo](gaycruisebingo.md).
- **Application repository surfaces:** `CONTEXT.md` (ubiquitous language) · `docs/adr/0005`, `0006`, `0009`, `0012`, `0016` · `docs/app/README.md` and `docs/app/phase-1-deploy.md` (prior delivery phases) · `specs/hostnames-lookup.md` · `specs/player-blocking.md`.
- **Editions and store eligibility:** Five Across (platform register—ships) · Vacay Bingo, by Five Across (travel edition—ships) · Gay Cruise Bingo (legacy edition—no listing; its explicit pool and `gaycruisebingo.com` links stay on the web, while general-audience GCB Events may resolve natively; see Decision 1).
- **Store facts:** Apple Developer Program is 99 USD per year; Google Play is a one-time 25 USD registration. Over-the-air limits are in § Over-the-air updates: Apple Guideline 2.5.2 bars downloaded code that introduces or changes features, and Play permits interpreted code subject to its broader policies.
