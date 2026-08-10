# Link-unfurl artwork: how to change it

The artwork a shared link previews with is a set of committed PNGs, not something the app renders. This is the runbook for changing them.

Before #688, they had no generator. The three per-Edition renders landed as binaries in #642 (from the #609 design pass), so the first two content changes to them — [#681](https://github.com/nathanjohnpayne/gaycruisebingo/issues/681) moving Vacay's share mark from 🗺️ to 🧳, and [#688](https://github.com/nathanjohnpayne/gaycruisebingo/issues/688) giving Gay Cruise Bingo the `BY FIVE ACROSS` endorsement — each opened with an archaeology pass over a PNG. The generator exists so that stops being the workflow.

## The assets

| File | What it is | Source |
|---|---|---|
| `public/og-gcb.png` | Gay Cruise Bingo unfurl, 1200×630 | `scripts/og/og-edition.html` |
| `public/og-vacay.png` | Vacay Bingo unfurl, 1200×630 | same |
| `public/og-fiveacross.png` | Five Across unfurl, 1200×630 | same |
| `plans/og-images/*-og.png` | the wireframes' reference copies | written from the same render |
| `public/og-default.png` | the superseded bare-URL unfurl, 2400×1260 | `scripts/og/og-default.html` |
| `plans/og-images/share-final-photo-*.png` | reference pictures of the final-standings share card | none — see [Share cards](#share-cards) |

`plans/og-images/<slug>-og.png` must stay **byte-identical** to its `public/` counterpart. The renderer writes both from one screenshot so they cannot drift, and `src/recon-share-og.test.ts` fails if they ever do.

## Changing what the artwork says

Almost every change is a brand-table edit, because the generator reads its copy from `src/editions.ts`:

| On the artwork | Brand-table field |
|---|---|
| wordmark, and which word is bold | `wordmark`, `wordmarkBold` |
| the endorsement line under it | `wordmarkByline` |
| the eyebrow's mark, and the Vacay stamp's | `lexicon.shareMark` |
| the domain line | `ogUrl`'s hostname (see the note below) |
| the platform's free square | `lexicon.shareMark` |

So the whole of #681 is: change `shareMark`, re-render Vacay. The whole of #688's raster half is: add `wordmarkByline`, re-render GCB.

`src/recon-share-og.test.ts` enforces this — it strips comments from the renderer and fails if any brand-table-owned string was retyped into the code.

**The domain line is the one deliberate exception.** It defaults to the `ogUrl` hostname, which for `gcb` and `fiveacross` *is* the brand's apex. Vacay's `ogUrl` is Event-scoped (`bodega-bay.vacaybingo.com`) until the #546 Worker rewrites it per hostname, and an unfurl is a brand impression, so that row overrides the domain to `vacaybingo.com` in the renderer with a comment saying why.

Everything that is **art direction** rather than copy — palette, board pattern, ornament geometry, the Vacay passport frame and stamp — lives in the `ART` table in `scripts/og/render-og-editions.mjs`. It is not in the brand table because the app has no other consumer for it.

## Re-rendering

```bash
node scripts/og/render-og-editions.mjs --edition vacay
```

`--edition` is required rather than defaulting to all three, and `--all` is the explicit opt-in. A re-render is never byte-identical to the last one, so rendering the full set for a one-Edition change commits binary diffs to Editions whose artwork nobody asked to change — and each of those is a live link preview. `--out <dir>` writes to a scratch directory instead of the repo, which is what you want for a first look.

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

`plans/og-images/share-final-photo-*.png` are a different kind of asset: they are static pictures of a **live component**. `src/components/ShareCard.tsx` draws the real card's footer as `${appName} ${lexicon.shareMark}`, so when the brand table changes a mark the shipped app is already correct and only these reference pictures are stale.

That is all #681 needed from them, so there is a narrow tool for exactly that line:

```bash
node scripts/og/render-share-footer.mjs --edition vacay
```

It repaints the footer band with the card's own background — sampled from the asset, so it works on Vacay's cream ground and the other two Editions' dark ones — and redraws the line from the brand table. It changes 32 rows of pixels and nothing else.

The clear is done row by row, walking in from each edge until the pixel already matches the interior ground, rather than filling the row's full width. The obvious version is a full-width `fillRect`, and it is wrong: these cards carry a rounded outer border, so it paints over the card's own outline and leaves a 32-row gap in it on both sides. Deriving the interior span per row keeps that correct through the corner curvature and on any border width or colour. Verify with `--no-crush`, which skips the `pngquant` pass — quantisation perturbs pixels everywhere, so it is impossible to prove the redraw stayed inside the band from a crushed file.

Unlike the unfurl artwork, these **are** quantised: they are soft-focus reference pictures in `plans/`, not brand assets crawlers serve, and the canvas re-encode hands back a lossless PNG that is larger than the original. Quantising takes Vacay's card from 244 KB to 40 KB at a measured mean channel difference of 0.68/255 with no visible banding — a smaller file than the one it replaces.

`--edition` is required rather than defaulting to all three: a re-render rewrites the PNG whether or not its mark moved, so running the full set for a one-Edition change commits binary diffs that carry no content change.

**If the card's layout ever changes, this is the wrong tool.** These references then need re-screenshotting from the real component, because nothing else in them (the photo hero, the standings rows, the honors chips) has a design source in this repo.

## After a change

1. `npx vitest run src/recon-share-og.test.ts` — mirrors byte-identical, dimensions still 1200×630, no brand copy retyped into the generator.
2. Check the file sizes the renderer prints. The renders are **truecolor**, like the #609 originals, and land near 250 KB — comfortably inside WhatsApp's 600 KB `og:image` cap. The renderer only reaches for `pngquant` if a render misses a 500 KB budget, and says so loudly when it does. That is deliberate: `render-og-default.mjs` next door always quantises because at 2400×1260 it is ~1.6 MB lossless, but at 1200×630 there is nothing to buy, and the palette is not free — it takes a corner radial wash from ~70 distinct values across a row to ~16, which is invisible at size but shows as contour rings under contrast amplification.
3. These are static assets under `public/`, so they publish on the next hosting deploy of the project that serves them — `og-vacay.png` and `og-fiveacross.png` are served from `fiveacross.web.app` per `src/editions.ts`, `og-gcb.png` from the GCB project.
4. Crawler caches hold old unfurls. The URLs do not change, so previously-unfurled links keep the old picture until each platform re-fetches.
