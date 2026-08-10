import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAYS } from './data/seed';
import { editionBrand } from './editions';
import { THEMES } from './theme/themes';

// Reconciliation guard for ADR 0005 (issue #39), not an app unit test: it
// asserts on the *contents* (and, for cloud-run/, the *absence*) of the repo
// files the scaffolded server-side Open Graph pipeline touched, proving the
// Cloud Run OG renderer, the `share` Function, the `/s/**` hosting rewrite,
// and the inert `/og/**` Storage block all stay removed, while the static
// bare-URL unfurl path (public/og-default.png + the index.html OG meta) and
// on-device Share Cards (#36) stay intact. It lives under src/ (not
// tests/reconciliation/, despite the issue's suggested path) so the mandated
// `npm test` run (vitest, `include: ['src/**/*.test.{ts,tsx}']`) actually
// executes it — the same reason src/recon-recompute-stats.test.ts (issue #40)
// lives under src/ rather than tests/.
const resolve = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url).href);
const read = (rel: string): string => readFileSync(resolve(rel), 'utf8');

const functionsIndex = read('../functions/src/index.ts');
const firebaseJson = read('../firebase.json');
const storageRules = read('../storage.rules');
const indexHtml = read('../index.html');
const rootReadme = read('../README.md');
const appReadme = read('../docs/app/README.md');
const deployGuide = read('../docs/app/phase-1-deploy.md');
const multiEventSpec = read('../specs/x-multi-event-schema.md');

describe('recon: cloud-run/og-renderer is gone (#39, ADR 0005)', () => {
  it('cloud-run/ does not exist', () => {
    expect(existsSync(resolve('../cloud-run'))).toBe(false);
  });
});

describe('recon: share Function + escapeHtml + OG_RENDERER_URL removed from functions/src/index.ts', () => {
  it('functions/src/index.ts no longer defines share, escapeHtml, or OG_RENDERER_URL', () => {
    expect(functionsIndex).not.toMatch(/export const share\b/);
    expect(functionsIndex).not.toMatch(/escapeHtml/);
    expect(functionsIndex).not.toMatch(/OG_RENDERER_URL/);
    // HTTPS callables are legitimate server APIs (for example bug intake); the
    // removed OG pipeline specifically used an onRequest HTTP renderer.
    //
    // This used to ban the `onRequest` IMPORT outright, which was a proxy for
    // "no HTTP renderer" rather than the thing itself, and #616 is the case
    // that shows the proxy was too coarse: RFC 8058 one-click unsubscribe is a
    // bare POST from the mail client, with no Firebase SDK, no session and no
    // callable envelope, so the daily email's unsubscribe endpoint cannot be a
    // callable. Banning the import would have forced either a broken
    // unsubscribe or a workaround written to dodge a regex — neither of which
    // ADR 0005 asks for; ADR 0005 removed the Cloud Run OG RENDERER.
    //
    // So the guard is now an ALLOW-LIST of the onRequest exports that exist,
    // which is strictly tighter in the dimension that matters: a re-added
    // `share`/OG renderer fails this even if it is named something new, and any
    // future HTTP surface has to be declared here deliberately.
    const onRequestExports = [...functionsIndex.matchAll(/export const (\w+) = onRequest\b/g)].map((m) => m[1]);
    expect(onRequestExports).toEqual(['emailUnsubscribe']);
  });

  it('keeps moderateProof intact', () => {
    expect(functionsIndex).toMatch(/export const moderateProof\b/);
  });
});

describe('recon: firebase.json drops the /s/** rewrite and header rule, keeps the SPA fallback', () => {
  it('firebase.json has no /s/** rewrite or header rule, and keeps the SPA fallback', () => {
    expect(firebaseJson).not.toMatch(/"source":\s*"\/s\/\*\*"/);
    expect(firebaseJson).not.toMatch(/"function":\s*"share"/);
    expect(firebaseJson).toMatch(/"source":\s*"\*\*",\s*"destination":\s*"\/index\.html"/);
  });
});

describe('recon: storage.rules drops the inert /og/** block', () => {
  it('storage.rules has no /og/ match block', () => {
    expect(storageRules).not.toMatch(/match \/og\//);
  });
});

describe('recon: bare-URL unfurl keeps working with no server', () => {
  // #587 Edition-scoped the static OG meta: the concrete gcb values this guard
  // used to pin are now `%EDITION_…%` placeholders substituted at build time
  // (src/editions.ts, brandHtmlIdentity), and the per-Edition VALUES are pinned
  // by src/editions.test.ts against the brand table. What stays recon-guarded
  // here is ADR 0005's property itself: a static meta block plus static images,
  // no server.
  it('keeps the static index.html OG meta block, Edition-tokenised (#587)', () => {
    expect(indexHtml).toMatch(/<meta property="og:image" content="%EDITION_OG_IMAGE%" \/>/);
    expect(indexHtml).toMatch(/<meta name="twitter:image" content="%EDITION_OG_IMAGE%" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:url" content="%EDITION_OG_URL%" \/>/);
    // Crawler hints that let messengers lay out the preview without sniffing
    // the image: MIME type, pixel dimensions, and alt text. 1200×630 is the
    // #609 artwork generation (down from og-default.png's 2400×1260).
    expect(indexHtml).toMatch(/<meta property="og:image:type" content="image\/png" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:height" content="630" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:alt" content="%EDITION_OG_IMAGE_ALT%" \/>/);
  });

  it('ships every Edition unfurl image, and keeps the superseded og-default.png (#609)', () => {
    // og-default.png stays until the deployed HTML that references it is gone
    // from crawler caches: platforms that re-fetch a previously unfurled
    // image URL would otherwise 404.
    for (const file of ['og-gcb.png', 'og-vacay.png', 'og-fiveacross.png', 'og-default.png']) {
      expect(existsSync(resolve(`../public/${file}`)), file).toBe(true);
    }
  });

  it('wires each unfurl image into the configs that fail quietly (#609)', () => {
    // Named explicitly in #609 because the miss ships without an error: a file
    // absent from the firebase.json no-cache rule falls to the default cache
    // policy, so stale artwork survives a redeploy in crawler-facing caches.
    for (const file of ['og-gcb.png', 'og-vacay.png', 'og-fiveacross.png']) {
      expect(firebaseJson, `firebase.json headers must name ${file}`).toContain(file);
    }
    // …and the flip side: the artwork must stay OUT of the service-worker
    // precache. og-*.png is crawler-facing — the app never renders it — and
    // without this glob the *.png precache pattern would tax every phone ~1 MB
    // at install time for files no client ever loads.
    const viteConfig = read('../vite.config.ts');
    expect(viteConfig).toContain(`globIgnores: ['og-*.png']`);
  });

  it('og-default.png is regenerable from a design source depicting a real seeded Day (#338)', () => {
    // PR #337 shipped the render binary-only; #338 commits the design source
    // so the asset is reproducible. The depicted daybar must be a real seeded
    // (day, theme, port) trio — the v1 render showed a trio that exists on no
    // seeded Day (Codex P3 on #337) — so derive the expectation from the seed
    // itself. The 2026-07-17 schedule correction moved neon-playground off
    // every Day, so the pink-neon board art now names its unified successor,
    // neon-pink-playground (Sea Day / Day 3); the daybar must name that theme's
    // own Day and port exactly as DayBar renders them
    // (`Day {index + 1} · {label}` + port, src/components/Board.tsx).
    const template = read('../scripts/og/og-default.html');
    expect(existsSync(resolve('../scripts/og/render-og-default.mjs'))).toBe(true);
    const day = DAYS.find((d) => d.theme === 'neon-pink-playground');
    if (!day) throw new Error('no seeded neon-pink-playground Day');
    const theme = THEMES.find((t) => t.id === day.theme);
    if (!theme) throw new Error('no ThemeMeta for neon-pink-playground');
    expect(template).toContain(`Day ${day.index + 1} · ${theme.label} ${theme.emoji}`);
    expect(template).toContain(`${day.placeEmoji} ${day.place}`);
  });
});

// #688 / #681. The three per-Edition renders (#609, landed via #642) shipped
// as binaries with NO generator — `render-og-default.mjs` builds og-default.png
// and nothing else — so the first two content changes to them each opened with
// an archaeology pass over a PNG. These guards keep the replacement honest:
// the source exists, the wireframes' reference copies cannot drift from the
// shipped ones, and the artwork's words keep coming from the brand table
// rather than being retyped into the generator.
describe('recon: the per-Edition unfurl artwork is regenerable and table-driven (#688)', () => {
  const EDITION_ASSETS = [
    { edition: 'gcb', shipped: 'og-gcb.png', mirror: 'gay-cruise-bingo-og.png' },
    { edition: 'vacay', shipped: 'og-vacay.png', mirror: 'vacay-bingo-og.png' },
    { edition: 'fiveacross', shipped: 'og-fiveacross.png', mirror: 'five-across-og.png' },
  ];

  it('ships a design source and a renderer for the per-Edition artwork', () => {
    for (const file of ['og-edition.html', 'render-og-editions.mjs', 'compare-og.mjs']) {
      expect(existsSync(resolve(`../scripts/og/${file}`)), file).toBe(true);
    }
    // The reference share cards' brand footer has its own refresher, because
    // those PNGs are pictures of a live component (ShareCard.tsx) rather than
    // artwork with a design source (#681).
    expect(existsSync(resolve('../scripts/og/render-share-footer.mjs'))).toBe(true);
  });

  it.each(EDITION_ASSETS)(
    'keeps plans/og-images/$mirror byte-identical to public/$shipped',
    ({ shipped, mirror }) => {
      // The wireframes doc states these are the same render committed twice —
      // one as the shipped asset, one as the doc's reference copy — and #681
      // makes it an acceptance criterion. The renderer writes both from one
      // screenshot, so a mismatch means someone hand-edited one of them.
      const a = readFileSync(resolve(`../public/${shipped}`));
      const b = readFileSync(resolve(`../plans/og-images/${mirror}`));
      expect(a.equals(b)).toBe(true);
    },
  );

  it.each(EDITION_ASSETS)('renders $shipped at the 1200x630 the meta block promises', ({ shipped }) => {
    // og:image:width/height are asserted above as MARKUP; this asserts the
    // pixels agree with them. A re-render at the wrong size unfurls letterboxed
    // on every platform and nothing else would catch it.
    const png = readFileSync(resolve(`../public/${shipped}`));
    // PNG: 8-byte signature, then a length+type header, then IHDR's width and
    // height as big-endian uint32s at offsets 16 and 20.
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it('never retypes brand-table copy into the generator', () => {
    // The whole point of the generator is that a wordmark, an endorsement line
    // or a share mark changes in `src/editions.ts` and the artwork follows. A
    // literal copy of any of those strings in the renderer's CODE is the drift
    // this replaces, so it fails here. Comments are stripped first: the header
    // legitimately narrates #681's 🗺️ → 🧳 move and #688's endorsement.
    const code = read('../scripts/og/render-og-editions.mjs')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const edition of ['gcb', 'vacay', 'fiveacross']) {
      const brand = editionBrand(edition);
      // appDescription is on this list because it was the one that got away:
      // the artwork's description line was retyped into the ART table until
      // Codex caught it on #697. It is the same sentence the manifest and the
      // share block carry, so a copy edit that skipped the artwork would have
      // shipped two different descriptions of the same product.
      for (const owned of [brand.wordmark, brand.appName, brand.appDescription, brand.lexicon.shareMark]) {
        expect(code, `${edition}: "${owned}" belongs to the brand table`).not.toContain(owned);
      }
      if (brand.wordmarkByline) {
        expect(code, `${edition} byline`).not.toContain(brand.wordmarkByline);
      }
    }
  });
});

describe('recon: docs no longer instruct deploying/configuring the removed pipeline', () => {
  it('phase-1-deploy.md configures no OG_RENDERER_URL and retires the Cloud Run service instead of deploying it', () => {
    // No configure-it step: the share Function that read this env var is gone.
    expect(deployGuide).not.toMatch(/OG_RENDERER_URL/);
    // No CREATE step for the renderer (the old `gcloud run deploy og-renderer`).
    expect(deployGuide).not.toMatch(/gcloud run deploy og-renderer/);
    // Finding 3: a one-time RETIRE step for the separately-deployed Cloud Run
    // service must be present (Firebase deploys never remove it).
    expect(deployGuide).toMatch(/gcloud run services delete og-renderer/);
    // Finding 2: the forced-cleanup note must name `share` (not just
    // recomputeStats) so an operator knows the functions deploy prompts to
    // delete it and needs --force.
    expect(deployGuide).toMatch(/recomputeStats/);
    expect(deployGuide).toMatch(/`share`/);
    expect(deployGuide).toMatch(/--force/);
  });

  it('README.md drops the cloud-run/og-renderer references', () => {
    // Root README and app guide: no live surface for the removed pipeline.
    expect(rootReadme).not.toMatch(/cloud-run\/og-renderer/);
    expect(rootReadme).not.toMatch(/OG_RENDERER_URL/);
    expect(rootReadme).not.toMatch(/Cloud Run OG renderer/);
    expect(rootReadme).not.toMatch(/Playwright-rendered OG/);
    expect(appReadme).not.toMatch(/cloud-run\/og-renderer/);
    expect(appReadme).not.toMatch(/OG_RENDERER_URL/);
    expect(appReadme).not.toMatch(/Cloud Run OG renderer/);
  });

  it('x-multi-event-schema.md no longer instructs redeploying the removed share Function', () => {
    // Finding 1: the design-only spec described the share Function as a live
    // surface (query-param OG endpoint, a branding-sweep --only functions
    // redeploy exception). It must now describe it as removed, and never as
    // something to edit/redeploy.
    expect(multiEventSpec).not.toMatch(/OG_RENDERER_URL/);
    // The old present-tense instruction phrasings that treated share as a live,
    // editable/redeployable surface must be gone.
    expect(multiEventSpec).not.toMatch(/does redeploy a Function/);
    expect(multiEventSpec).not.toMatch(/share Function['’]s OG (description|copy)/);
    // It should acknowledge the removal by ADR/issue reference.
    expect(multiEventSpec).toMatch(/ADR 0005/);
  });
});
