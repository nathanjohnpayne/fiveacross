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
2. **Bodega Bay (Vacay) pools only.** They are the general-audience pools (`spicyRatio: 0`). `scripts/seed-data/med-2026.mjs` is never imported here.
3. **No photo proofs.** The Feed seeds text proofs, a shared Tally and a BINGO Moment. A hero image must carry nobody's real picture, and a staged fake one would be worse.

`HERO_PROMPT_EXCLUSIONS` additionally holds out a handful of real, perfectly fine prompts that read badly blown up to 393pt on a portfolio page. Add to that set rather than editing the seed data.

## What it captures, and why the warm-up Day

The seeded schedule puts **today on Day 0, the warm-up card** (tutorial pool, `WARM-UP` tag), with Days 1 and 2 locked ahead of it. The easy pool is the gentlest content the product has — *give a friend a compliment*, *win a game of something*, *catch someone talking to a bird* — which is what you want in a shot a recruiter reads before they read anything else. Days 1 and 2 stay locked so `standingsFrozen` never trips and the card renders live rather than as a finished Event.

Seven squares are pre-marked and no line is complete: enough colour for the card to look played-in, without the celebration overlay firing.

Dates are computed relative to *today* (`isoDay`), so the Event always reads as in progress. An absolute schedule rots into a "👋 Until next year" header the moment its end date passes.

## Changing the shot

| You want | Change |
|---|---|
| A different Day / pool | `HERO_TODAY_INDEX` and the `days[]` unlock times in `fixture.ts` |
| More or fewer marks | `MARKED` in `marketing-shots.spec.ts` |
| A different dealt card | `FIXED_SEED` in `marketing-shots.spec.ts` |
| Another screen | Add a tab click plus `page.screenshot` at the end of the spec |
| Five Across platform chrome | `HERO_EDITION=fiveacross scripts/marketing-shots.sh` (see the caveat below) |
| A different frame | `test.use({ viewport })` in the spec; `deviceScaleFactor` in `playwright.marketing.config.ts` |

**The `fiveacross` Edition is wired but unused.** It renders the platform wordmark and the occasion-neutral Themes (Marquee / Confetti Hour / Afterglow), but it would still deal *Bodega* prompts under a generic "the weekend" frame, which reads as incoherent. It needs an occasion-neutral prompt pool before it produces a publishable shot. The Vacay capture already carries `BY FIVE ACROSS` under the wordmark, which is the platform story anyway.

## Mechanics

- **Not a test.** It lives in `tests/marketing/`, outside `playwright.config.ts`'s `testDir`, so `npm run test:e2e` never runs it. It asserts only enough to know the screen it wants has settled.
- **Its own demo project** (`demo-fiveacross-marketing`), distinct from the e2e suite's. The literal appears in both `scripts/marketing-shots.sh` and `fixture.ts` — keep them in lockstep, exactly as `scripts/test-e2e.sh` and `tests/e2e/support/env.ts` do. A capture run **clears Firestore**, so sharing an id with the suite would let it wipe a fixture mid-run.
- **Its own port** (5184), so it can run alongside an e2e run.
- **`VITE_ADULT_CONTENT=false` is not enough on its own.** A single-Event build treats that as an unproven *seed* and re-derives the posture from `hostnames/{host}`; with no such document the posture fails closed and the 18+ gate returns after sign-in. The fixture therefore seeds `hostnames/127.0.0.1` with `adultContent: false` — which is the truthful value for a Bodega-pool Event, not a convenience.
- **Java.** The Firestore emulator needs a JDK on `PATH`. The script prepends Homebrew's keg-only `openjdk@21` when the ambient `java` does not run — macOS ships a `/usr/bin/java` stub that exists and exits 1, so the probe runs `java -version` rather than testing for the binary.
