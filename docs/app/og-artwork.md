# Link-unfurl artwork: how to change it

The artwork a shared link previews with is a set of committed PNGs, not something the app renders. This is the runbook for changing them.

Before #688, they had no generator. The three per-Edition renders landed as binaries in #642 (from the #609 design pass), so the first two content changes to them — [#681](https://github.com/nathanjohnpayne/fiveacross/issues/681) moving Vacay's share mark from 🗺️ to 🧳, and [#688](https://github.com/nathanjohnpayne/fiveacross/issues/688) giving Gay Cruise Bingo the `BY FIVE ACROSS` endorsement — each opened with an archaeology pass over a PNG. The generator exists so that stops being the workflow.

## The assets

| File | What it is | Source |
|---|---|---|
| `public/og-gcb.png` | Gay Cruise Bingo unfurl, 1200×630 | `scripts/og/og-edition.html` |
| `public/og-vacay.png` | Vacay Bingo unfurl, 1200×630 | same |
| `public/og-fiveacross.png` | Five Across unfurl, 1200×630 | same |
| `plans/og-images/*-og.png` | the wireframes' reference copies | written from the same render |
| `public/og-default.png` | the superseded bare-URL unfurl, 2400×1260 | `scripts/og/og-default.html` |
| `plans/og-images/share-final-photo-*.png` | reference pictures of the final-standings share card, 600×750 | the `.shc` artboards in `plans/daily-cards-wireframes.html` — see [Share cards](#share-cards) |

`plans/og-images/<slug>-og.png` must stay **byte-identical** to its `public/` counterpart. The renderer writes both from one screenshot so they cannot drift, and `src/recon-share-og.test.ts` fails if they ever do.

## Changing what the artwork says

Almost every change is a brand-table edit, because the generator reads its copy from the `BRANDS` table in `src/edition-brands.ts` (reached through `editionBrand()` in `src/editions.ts`):

| On the artwork | Brand-table field |
|---|---|
| wordmark, and which word is bold | `wordmark`, `wordmarkBold` |
| the endorsement line under it | `wordmarkByline` |
| the eyebrow's mark, and the Vacay stamp's | `lexicon.shareMark` |
| the domain line | `ogUrl`'s hostname (see the note below) |
| the platform's free square | `lexicon.shareMark` |

So the whole of #681 is: change `shareMark`, re-render Vacay. The whole of #688's raster half is: add `wordmarkByline`, re-render GCB.

`src/recon-share-og.test.ts` enforces this — it strips comments from the renderer and fails if any brand-table-owned string was retyped into the code.

All three renderers below read that module through `scripts/og/load-editions.mjs`, which bundles it with esbuild so its own imports (`edition-registry.ts`, `edition-brands.ts`) resolve instead of being stubbed. Each renderer used to carry a private loader that transpiled the one file and handed it an empty `require`; the day `src/editions.ts` gained a real import, those scripts crashed on load while this runbook kept naming them. `scripts/og/load-editions.test.mjs` runs the loader, and each renderer up to its `--edition` check, in `npm test`, so that class of rot fails the suite rather than the next re-render.

**The domain line is the one deliberate exception.** It defaults to the `ogUrl` hostname, which for `gcb` and `fiveacross` *is* the brand's apex. Vacay's `ogUrl` is Event-scoped (`bodega-bay.fiveacross.app`) until the edge HTML rewrite (#1118) emits it per hostname, and an unfurl is a brand impression, so that row overrides the domain to `vacaybingo.com` in the renderer with a comment saying why.

Art direction shared by the generated cards and the annotated wireframes — eyebrow treatment, board pattern, prompt-rule variation, cell radius, free-square ink, board shadow, and marked-cell glow — lives in `scripts/og/og-edition-art.mjs`. Render-only composition such as full palettes, lockup geometry, and the Vacay passport frame stays in the `ART` table in `scripts/og/render-og-editions.mjs`. Neither belongs in the brand table because the app has no runtime consumer for it.

## Re-rendering

```bash
node scripts/og/render-og-editions.mjs --edition vacay
```

`--edition` is required rather than defaulting to all three, and `--all` is the explicit opt-in. A re-render is never byte-identical to the last one, so rendering the full set for a one-Edition change commits binary diffs to Editions whose artwork nobody asked to change — and each of those is a live link preview. `--out <dir>` writes to a scratch directory instead of the repo, which is what you want for a first look.

Every render is checked against WhatsApp's 600 KB `og:image` hard cap before it touches anything committed: the screenshot lands in a scratch file next to its destination, and only replaces `public/og-*.png` and its `plans/og-images/` mirror once it clears the cap. A render that doesn't clear the cap leaves the previous committed copy untouched and exits nonzero. `--all` extends this to the whole run — every targeted Edition has to individually clear the cap before ANY of them is committed, so a late failure (say, the third Edition of three) cannot leave the first two already replaced and the third still on disk from the last successful run. A failed `--all` either updates every targeted Edition or none of them.

For the same reason, `public/og-fiveacross.png` is still the original #609 binary: #681 and #688 gave it no content change, so it was left alone rather than swapped for a fresh render of the same design. It picks up the generator the first time its own copy actually moves.

Requirements:

- `npm install` (uses the repo's playwright and esbuild) and `npx playwright install chromium`
- network at render time — Anton and Oswald come from Google Fonts, and the renderer **refuses to write a degraded PNG** if the stylesheet or a face fails to load, because a system-fallback wordmark looks almost right
- **Do not suppress the output.** The renderer fails closed on a bad config or a degraded font load, and a `>/dev/null 2>&1` turns that into a silent no-op that leaves the previous PNG in place — which reads downstream as "the change had no effect" rather than as "the render never ran". This bit during #697.
- **macOS.** The body copy resolves to Helvetica Neue and the share marks rasterise as Apple Color Emoji, which is what the committed assets use. The script refuses to run elsewhere unless you pass `--allow-foreign-platform`, because rendering on another host restyles every word rather than only the ones you meant to change.

## Proving you changed only what you meant to

Both tickets that have needed this artwork asked for the rest of the composition to be untouched, and two PNGs side by side cannot establish that. So:

```bash
node scripts/og/render-og-editions.mjs --edition vacay --out /tmp/og
node scripts/og/compare-og.mjs --new /tmp/og --edition vacay
```

It prints a per-band difference score — eyebrow, wordmark, byline/rule, description, domain, board, caption, full frame — so a change reads as "the eyebrow moved" rather than as one number, and writes a `compare-<edition>.png` sheet stacking the committed render, the fresh one, and an amplified difference map, so a score you cannot explain has somewhere to be looked at. The bands are per-Edition, because the platform centres a one-line lockup where the two Editions stack a two-line one; a band that lands empty in both images is reported as drifted rather than silently scoring 0.0. It is a review aid, not a gate: a legitimate change makes some bands differ, and the point is being able to name which ones and why. Use `--ref HEAD` to compare against the committed revision once you have already overwritten the files in place.

## Share cards

`plans/og-images/share-final-photo-*.png` are a different kind of asset: they are pictures of the final-standings share card in its photo-hero composition, embedded by the `fx-share-final-photo-*` frames in `plans/daily-cards-wireframes.html`. The app renders that card on the Player's own device (`src/components/ShareCard.tsx`, ADR 0005) from a real photo blob, so the shipped component is not something a script can screenshot offline. What it answers to is: the wireframes doc draws each card as a live `.shc` artboard at half scale — 300×375 CSS px representing the rendered 600×750 — and the renderer below captures exactly those elements at 2×.

Until #887 that capture was hand-driven, and it produced both failures an unreproducible asset produces. The GCB refresh in #867 caught the adjacent Vacay artboard in shot and composited it over the upper-right corner, obscuring the wordmark line and half of `FINAL STANDINGS`; and the same picture still read `Turntilla` on its 👑 row long after the artboard beside it was corrected to `Logan Murdock`, because nobody was going to re-screenshot three cards for one row. So there is a renderer:

```bash
node scripts/og/render-share-rasters.mjs --edition gcb
```

It opens the wireframes document in Playwright's chromium at `deviceScaleFactor: 2`, rewrites the footer line from the brand table (`${appName} ${lexicon.shareMark}`, uppercased by the artboard's own CSS), and screenshots the artboard. The capture is staged beside its destination and only replaces the committed picture once it is 600×750, it is 8-bit non-interlaced truecolor, and its upper-right quadrant is not mostly cream — the #887 overlay, expressed as a check. That last one is the same check `src/recon-share-og.test.ts` runs on the files already in the tree, from the same constant and the same predicate (`scripts/og/share-card-overlay.mjs`), and it refuses a capture that reaches the cap rather than only one that exceeds it: the committed-file guard accepts a share strictly below the cap, so anything looser here would let a run report success and red the suite on the file it had just written. The format half of that is `scripts/og/share-raster-format.mjs`, split out so it is testable without a browser: dimensions alone let a correctly sized capture in the wrong PNG format through, and since the recon guard requires colour type 2 of the committed files, the first thing that would notice is a red suite with the good picture already overwritten. `--edition` is required and `--all` is the explicit opt-in, for the same reason the unfurl renderer gives; `--out <dir>` writes to a scratch directory for a first look, and `--check` reports without writing.

`--all` is atomic. Every targeted Edition is captured and fully validated into its own scratch file first, and a single commit phase moves them all into place only once the LAST one has passed — `commitStaged` (`scripts/og/og-stage-commit.mjs`), the same primitive the unfurl renderer publishes through. The rename used to happen per Edition the moment that Edition validated, so a run whose third card failed its overlay check exited with the first two updated and the third stale: a mixed render set from one command, with nothing in the tree to say which cards came from which run. Now a failure anywhere deletes every scratch file in the run, leaves all three committed pictures exactly as they were, and names the Edition that failed.

**It needs the Arial Narrow display face, and it checks.** The artboards' `.shc` rules ask for `'Bebas Neue','Arial Narrow',sans-serif`. Bebas Neue is not a macOS face, so the committed pictures are captures with Arial Narrow — which macOS ships as a *supplemental* font (`/System/Library/Fonts/Supplemental/Arial Narrow.ttf`), and a host can therefore be without it. `document.fonts.ready` resolves either way: it promises that pending font *loads* have settled, not that the families a stylesheet asked for exist. So on a host missing that face Chromium quietly falls through to the generic sans-serif, the capture is still 600×750 truecolor with a dark upper-right quadrant, every check above passes, and the committed picture is replaced with one in visibly different typography — an asset nobody can reproduce, which is the whole failure #887 exists to end. The renderer probes the page before it captures anything (`document.fonts.check` at the rules' own size, plus a measured sample width against the generic, because `check` answers about availability rather than about what the cascade drew) and refuses unless the artboards resolve to Arial Narrow. The check is an equality and it refuses in both directions: **installing** Bebas Neue restyles the cards just as surely as removing Arial Narrow does, because the stack puts Bebas Neue first. `--check` prints the face it resolved, which is the cheap way to ask whether this host can re-render at all.

How closely each committed picture matches its artboard today varies, because only the GCB one has been through the renderer. Re-rendering GCB reproduces the committed file **byte for byte**. `-fa` differs by a mean 4.8/255 per channel with no structural difference — the same composition, separated by colour-profile handling between macOS `screencapture` and headless Chromium. `-vacay` is the outlier and its picture is **not** a capture of the artboard as it stands: at a mean 15.5/255 the differences are structural, not encode noise. Its role chips (`🏆 TRIP CHAMPION`, `FIRST TO BINGO`) render as bare text where the artboard's `.mlrole` rule draws an accented pill, its credit line wraps to two lines where the artboard fits one, and its corners outside the border radius are pure black where every artboard capture carries the wireframe page ground. So the first re-render of `-vacay` restyles the card as well as changing whatever copy you came for; that is the artboard asserting itself, not a regression, but it is not a one-word diff. `plans/daily-cards-wireframes.html` says the same thing on the frame itself.

`src/recon-share-og.test.ts` holds the other end: the renderer has to exist and name the artboards, the pictures have to be 600×750 truecolor, and the two dark-ground cards have to stay free of a composited overlay. That guard runs in `npm test`, which is why its PNG reader (`scripts/og/png-pixels.mjs`) is a dependency-free decoder rather than the headless-Chromium canvas the renderers next door use.

**Changing what the cards say is an edit to the artboard, not to the picture.** The frame in `plans/daily-cards-wireframes.html` is the source; re-run the renderer for the Edition whose frame moved.

The one exception is the brand footer, which has a narrower tool because it is the one line the brand table owns outright. That is all #681 needed:

```bash
node scripts/og/render-share-footer.mjs --edition vacay
```

It repaints the footer band with the card's own background — sampled from the asset, so it works on Vacay's cream ground and the other two Editions' dark ones — and redraws the line from the brand table. It changes 32 rows of pixels and nothing else.

The clear is done row by row, walking in from each edge until the pixel already matches the interior ground, rather than filling the row's full width. The obvious version is a full-width `fillRect`, and it is wrong: these cards carry a rounded outer border, so it paints over the card's own outline and leaves a 32-row gap in it on both sides. Deriving the interior span per row keeps that correct through the corner curvature and on any border width or colour.

It writes **truecolor** (PNG colour type 2), which is what all three committed cards are, what `scripts/og/render-share-rasters.mjs` writes, and what `src/recon-share-og.test.ts` requires — and it now converts and proves that rather than assuming it. The band is repainted in a 2D canvas, which carries an alpha channel, so `toDataURL('image/png')` hands back colour type 6 however opaque the composited pixels are. `scripts/og/png-truecolor.mjs` takes those bytes, checks that every alpha byte really is 255, drops the plane and re-encodes as colour type 2, refusing by pixel coordinate if any alpha is not — the drop is lossless exactly when the channel carries nothing, and flattening a translucent pixel would composite it against a background nobody chose. The result is staged beside its destination and validated by the same `assertCapturedCardFormat` guard the raster generator runs before it is allowed to replace the committed card, and `--all` publishes all three or none of them through the same `commitStaged` phase. A canvas flag (`getContext('2d', { alpha: false })`) is not relied on for this: it usually makes Chromium emit colour type 2, but that is an encoder heuristic rather than a promise, and a silent change to it would put a committed asset back in the wrong format.

An earlier version ran `pngquant` after its canvas re-encode, on the reasoning that these are soft-focus reference pictures in `plans/` rather than brand assets crawlers serve; that pass is gone, along with the `--no-crush` flag that turned it off. `pngquant` emits a palette PNG (colour type 3), which reds the recon guard — and for the same reason the unfurl renders are truecolor: a palette pass perturbs pixels everywhere, so "only the thing you meant to move moved" stops being provable, which is the one property this tool exists to have. The re-encode above keeps that property: it is pixel-for-pixel identical to what the canvas produced, and it re-encodes the three committed cards at 167/188/172 KB against Chromium's own 175/193/214 KB.

`--edition` is required rather than defaulting to all three: a re-render rewrites the PNG whether or not its mark moved, so running the full set for a one-Edition change commits binary diffs that carry no content change.

**If anything other than the footer line changes, this is the wrong tool** — re-render from the artboard instead. It is also the wrong tool for a layout change, which is an edit to the artboard first and a re-render second.

## After a change

1. `npx vitest run src/recon-share-og.test.ts` — mirrors byte-identical, unfurl dimensions still 1200×630, no brand copy retyped into the generator, and the share-card references still 600×750 truecolor with nothing composited over them.
2. Check the file sizes the renderer prints. The renders are **truecolor**, like the #609 originals, and land near 250 KB — comfortably inside WhatsApp's 600 KB `og:image` cap. The renderer only reaches for `pngquant` if a render misses a 500 KB budget, and says so loudly when it does. That is deliberate: `render-og-default.mjs` next door always quantises because at 2400×1260 it is ~1.6 MB lossless, but at 1200×630 there is nothing to buy, and the palette is not free — it takes a corner radial wash from ~70 distinct values across a row to ~16, which is invisible at size but shows as contour rings under contrast amplification.
3. These are static assets under `public/`, so they publish on the next hosting deploy of the project that serves them — `og-vacay.png` and `og-fiveacross.png` are served from `fiveacross.web.app` per the `ogImage` rows in `src/edition-brands.ts`, `og-gcb.png` from the GCB project.
4. Crawler caches hold old unfurls. The URLs do not change, so previously-unfurled links keep the old picture until each platform re-fetches.
