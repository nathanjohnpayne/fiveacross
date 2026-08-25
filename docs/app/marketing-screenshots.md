# Marketing screenshots

How to produce publishable screenshots of the app — project pages on nathanpayne.com, blog posts, app-store-style shots — without photographing a real Event.

```bash
scripts/marketing-shots.sh
```

Output lands in `artifacts/marketing/`: `vacay-card.png`, `vacay-feed.png`, `vacay-ranks.png`, at 393×775 CSS pixels and 2× DPR (786×1550). Copy the one you want into the consuming repo; don't commit the PNGs here.

## Why this exists instead of a phone screenshot

Every live surface that would make a good screenshot is full of things that must not be published: the podium and the Daily Honors strip carry real players' names, the Feed carries their photographs, and the Gay Cruise Bingo pool is explicit throughout. Cropping around all of that produces a worse image and still relies on a person remembering the rules every time.

So the capture drives the **real app** — same components, same Themes, same layout — over a **seeded demo Event** in the Firestore emulator. Nothing it renders came from production.

## The three rules the fixture enforces

`tests/marketing/support/fixture.ts` is the whole safety story, and it is deliberately small enough to re-read before every capture:

1. **Invented display names.** `Rae M.`, `Devon K.`, `Priya S.`, `Tomas L.` — never the real roster.
2. **General-audience pools only.** Bodega Bay (Vacay) is general-audience throughout (`spicyRatio: 0`). Gay Cruise Bingo is not — so only its `embark` **tutorial** pool (med-2026's `EASY_ITEMS`) may be seeded, and `med-2026`'s `ITEMS`, the explicit main pool, is never imported into the fixture. The named import list is the enforcement; do not widen it to a namespace import.

   `spicy: false` is **not** a sufficient SFW test on its own. The embark pool ships at least one unflagged prompt that cannot go on a portfolio page, which is why `HERO_PROMPT_EXCLUSIONS` covers it. Read the rendered PNG before publishing one — the flag is a filter, not a guarantee.
3. **No photo proofs.** The Feed seeds text proofs, a shared Tally and a BINGO Moment. A hero image must carry nobody's real picture, and a staged fake one would be worse.

`HERO_PROMPT_EXCLUSIONS` additionally holds out a handful of real, perfectly fine prompts that read badly blown up to 393pt on a portfolio page. Add to that set rather than editing the seed data.

## What it captures, and why the warm-up Day

The seeded schedule puts **today on Day 0, the warm-up card** (tutorial pool, `WARM-UP` tag), with Days 1 and 2 locked ahead of it. The easy pool is the gentlest content the product has — *give a friend a compliment*, *win a game of something*, *catch someone talking to a bird* — which is what you want in a shot a recruiter reads before they read anything else. Days 1 and 2 stay locked so `standingsFrozen` never trips and the card renders live rather than as a finished Event.

Seven squares are pre-marked and no line is complete: enough colour for the card to look played-in, without the celebration overlay firing.

Dates are computed relative to *today* (`isoDay`), so the Event always reads as in progress. An absolute schedule rots into a "👋 Until next year" header the moment its end date passes.

## Changing the shot

| You want | Change |
|---|---|
| A different Day / pool | `HERO_TODAY_INDEX` and the `days[]` unlock times in `fixture.ts`. The deal pool and free-space text follow automatically — both the Event seed and the board write read `HERO_DAY_DEAL`, so they cannot drift apart |
| More or fewer marks | `MARKED` in `marketing-shots.spec.ts` |
| A different dealt card | `FIXED_SEED` in `marketing-shots.spec.ts` |
| Another screen | Add a tab click plus `page.screenshot` at the end of the spec |
| Five Across platform chrome | `HERO_EDITION=fiveacross scripts/marketing-shots.sh` (see the caveat below) |
| Gay Cruise Bingo chrome | `HERO_EDITION=gcb scripts/marketing-shots.sh` — writes `gcb-card.png` etc. Deals the `embark` tutorial pool and wears the Event's own `neon-playground` Theme |
| A different frame | `test.use({ viewport })` in the spec; `deviceScaleFactor` in `playwright.marketing.config.ts` |

### The GCB capture

`HERO_EDITION=gcb` renders the `GAY CRUISE BINGO` wordmark over `neon-playground` — the Event's own default Theme, and the one that reads as GCB at a glance beside the warm Vacay card on a project page.

The Theme is **chrome**; the **pool** is the safety property. The capture stays on `HERO_TODAY_INDEX = 0`, the `embark` tutorial Day, whose prompts are boarding-day material — *find your muster station*, *hear the ship's horn*, *befriend a bartender*. A Theme is a skin any Day can wear (ThemeIsland lets a player switch at will), so a neon warm-up card is a real app state, not a staged one.

Do **not** reach for med-2026's own neon Day (index 2) to get this look: that Day is dealt from `main`.

`VITE_ADULT_CONTENT: 'false'` stays truthful under this Edition, but state the invariant precisely: it holds because **every pool the fixture seeds is general-audience** — Bodega's `main` and `farewell`, which Days 1 and 2 still carry, plus the selected Edition's `embark`. It is *not* the case that a GCB capture seeds only embark items.

The distinction matters for the next person to change this file: the loose version ("only embark is seeded") would keep reading as true while a future edit widened one of the Bodega pools, hiding a posture regression behind a justification that no longer applied.

**The `fiveacross` Edition is wired but unused.** It renders the platform wordmark and the occasion-neutral Themes (Marquee / Confetti Hour / Afterglow), but it would still deal *Bodega* prompts under a generic "the weekend" frame, which reads as incoherent. It needs an occasion-neutral prompt pool before it produces a publishable shot. The Vacay capture already carries `BY FIVE ACROSS` under the wordmark, which is the platform story anyway.

## Mechanics

- **Not a test.** It lives in `tests/marketing/`, outside `playwright.config.ts`'s `testDir`, so `npm run test:e2e` never runs it. It asserts only enough to know the screen it wants has settled.
- **Its own demo project** (`demo-fiveacross-marketing`), distinct from the e2e suite's. The literal appears in both `scripts/marketing-shots.sh` and `fixture.ts` — keep them in lockstep, exactly as `scripts/test-e2e.sh` and `tests/e2e/support/env.ts` do. A capture run **clears Firestore**, so sharing an id with the suite would let it wipe a fixture mid-run.
- **Its own web port** (5184) and its own build output (`dist-marketing`), so a capture and an e2e run cannot serve or clobber each other's bundle.
- **Do not run it concurrently with `npm run test:e2e`.** A distinct project id namespaces the data, not the sockets: both read the fixed emulator ports in `firebase.json` (8080, 9099), and `firebase emulators:exec` has no per-invocation port override, so the second run dies on the occupied ports before Playwright starts. Run them in sequence. Separating them properly needs a second firebase config wired through the bundle.
- **`VITE_ADULT_CONTENT=false` is not enough on its own.** A single-Event build treats that as an unproven *seed* and re-derives the posture from `hostnames/{host}`; with no such document the posture fails closed and the 18+ gate returns after sign-in. The fixture therefore seeds `hostnames/127.0.0.1` with `adultContent: false` — which is the truthful value for a Bodega-pool Event, not a convenience.
- **Java.** The Firestore emulator needs a JDK on `PATH`. The script prepends Homebrew's keg-only `openjdk@21` when the ambient `java` does not run — macOS ships a `/usr/bin/java` stub that exists and exits 1, so the probe runs `java -version` rather than testing for the binary.
