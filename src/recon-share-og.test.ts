import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAYS } from './data/seed';
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
  it('keeps public/og-default.png and the static index.html OG meta', () => {
    expect(existsSync(resolve('../public/og-default.png'))).toBe(true);
    // #338: og:image (and twitter:image) point at the web.app host, NOT the
    // apex — the apex TLS-resets for link crawlers (#340) and is SNI-blocked
    // on the ship network (#164), which is what broke iMessage unfurls. The
    // page's canonical identity (og:url) stays the apex.
    expect(indexHtml).toMatch(/<meta property="og:image" content="https:\/\/gaycruisebingo\.web\.app\/og-default\.png" \/>/);
    expect(indexHtml).toMatch(/<meta name="twitter:image" content="https:\/\/gaycruisebingo\.web\.app\/og-default\.png" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:url" content="https:\/\/gaycruisebingo\.com\/" \/>/);
    // Crawler hints that let messengers lay out the preview without sniffing
    // the image: MIME type, pixel dimensions, and alt text.
    expect(indexHtml).toMatch(/<meta property="og:image:type" content="image\/png" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:width" content="2400" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:height" content="1260" \/>/);
    expect(indexHtml).toMatch(/<meta property="og:image:alt" content="[^"]+" \/>/);
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
    expect(template).toContain(`${day.portEmoji} ${day.port}`);
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
