---
spec_id: recon-share-og
status: accepted
---

# Reconciliation: remove the Cloud Run OG renderer, `share` Function, and `/s/**` rewrite (`cloud-run/og-renderer/`, `functions/src/index.ts`, `firebase.json`, `storage.rules`)

ADR 0005 supersedes the scaffolded server-side Open Graph pipeline: Share Cards are generated **on-device** (canvas / html-to-image, landed by #36) and handed to the native share sheet, and there are no public unauthenticated pages for an 18+ app. This reconciliation deletes the scaffold ADR 0005 marked as not used at launch—the `cloud-run/og-renderer/` Playwright/Chromium Express service, the crawler-facing `share` Cloud Function (and its only caller, the `escapeHtml` helper), the `firebase.json` `/s/**` → `share` rewrite (and its now-dead `/s/**` cache-header rule), and the inert `/og/**` Storage block—while keeping `public/og-default.png` and the static `index.html` Open Graph meta, which cover bare-URL unfurl with no server. The removal is guarded by `src/recon-share-og.test.ts` (unit; asserts on the contents of the affected source files and runs under `npm test`); it lives under `src/` rather than `tests/reconciliation/` because vitest's `include` is scoped to `src/**/*.test.{ts,tsx}` (see `src/recon-recompute-stats.test.ts`, the precedent for this class of reconciliation guard).

## The Cloud Run OG renderer is gone

`cloud-run/og-renderer/` (`src/server.ts`, `src/template.ts`, `Dockerfile`, `package.json`, `README.md`, `tsconfig.json`) no longer exists in the tree, and `cloud-run` is dropped from the `extra_top_level_dirs` whitelist in `.repo-template.yml` and from the directory justification in `plans/app-scaffold-dirs.md` now that nothing occupies the top-level `cloud-run/` directory.

- **Given** ADR 0005 marks the renderer as not used at launch **when** the repo tree is read **then** `cloud-run/` does not exist. (Test: "cloud-run/og-renderer is gone".)

## The `share` Function and its orphaned `escapeHtml` helper are gone

`functions/src/index.ts` no longer exports `share`, no longer imports `onRequest`, and no longer defines `escapeHtml`—the crawler OG HTML + redirect handler was its only caller. `moderateProof` (ADR 0004 Phase 1 moderation) is untouched by this removal—and is, since #126, conditionally exported behind the off-by-default `ENABLE_VISION_MODERATION` flag, so it deploys as a CloudFunction only when Cloud Vision is enabled (see `specs/w4-gate-vision-moderation.md`).

- **Given** the on-device Share Card replacement (#36) **when** `functions/src/index.ts` is read **then** it defines no `share` export, no `escapeHtml` helper, and no `OG_RENDERER_URL` reference. (Test: "functions/src/index.ts no longer defines share, escapeHtml, or OG_RENDERER_URL".)
- **Given** `moderateProof` is the real Phase-1 moderation surface **when** `functions/src/index.ts` is read **then** it still declares the `export const moderateProof` binding (conditionally a CloudFunction since #126). (Test: "keeps moderateProof intact".)

## The `/s/**` hosting rewrite and its cache-header rule are gone

`firebase.json` no longer rewrites `/s/**` to a `share` function, and the now-orphaned `/s/**`-scoped `Cache-Control: public, max-age=3600` header rule (added only to protect that function's response from the SPA-shell catch-all) is removed with it, since `/s/**` now falls through to the same SPA fallback as every other route. The `**` → `/index.html` SPA fallback is untouched.

- **Given** the removed `share` Function **when** `firebase.json` is read **then** its `rewrites` array contains no `/s/**` entry and its `headers` array contains no `/s/**`-scoped rule, while the `**` → `/index.html` rewrite remains. (Test: "firebase.json has no /s/** rewrite or header rule, and keeps the SPA fallback".)

## The inert `/og/**` Storage block is gone

`storage.rules` no longer carries the public-read/`write:false` `/og/{allPaths=**}` block. `tests/rules/w0-storage-rules.test.ts` (rules-emulator layer, `npm run test:rules`) now asserts the removal took effect: an object written under `og/**` (with rules disabled to seed it) is denied on read too, since no rule matches the path anymore—Storage's default deny applies, unlike the removed block's `allow read: if true`.

- **Given** ADR 0005 **when** `storage.rules` is read **then** it contains no `/og/` match block. (Test: "storage.rules has no /og/ block".)

## Bare-URL unfurl keeps working with no server

`public/og-default.png` and the static Open Graph `<meta>` block in `index.html` are untouched—they are the permanent (not Phase-1-temporary) unfurl path per ADR 0005, not a placeholder pending a dynamic renderer.

- **Given** a crawler fetches a bare URL **when** `index.html` and `public/og-default.png` are read **then** both are present and the static OG `<meta property="og:image">` still points at `og-default.png`. (Test: "keeps public/og-default.png and the static index.html OG meta".)

## Docs no longer instruct deploying or configuring the removed pipeline

No live doc or operator-facing spec describes the Cloud Run OG renderer, the `share` Function, or `OG_RENDERER_URL` as something to build, deploy, or configure. The two exceptions are historical/operational-completeness, not instructions to use the removed pipeline: `docs/app/phase-1-deploy.md` names the removed surfaces exactly twice—a cleanup note that the next `functions` deploy will prompt to delete the `share` export (alongside `recomputeStats`), and a one-time retirement step to delete the already-deployed Cloud Run service (`gcloud run services delete og-renderer`), since that service was stood up outside Firebase and Firebase deploys will not remove it. The static planning tables in `plans/**` and the ADR itself may keep their historical mentions.

- **Given** an operator following the Phase 1 deploy guide **when** `docs/app/phase-1-deploy.md` is read **then** it configures no `OG_RENDERER_URL`, carries no `gcloud run deploy og-renderer` create step, and instead carries the `gcloud run services delete og-renderer` retirement step and names `share` in the forced-`--force` cleanup note. (Test: "phase-1-deploy.md configures no OG_RENDERER_URL and retires the Cloud Run service instead of deploying it".)
- **Given** the same operator reading the app guide **when** `docs/app/README.md` (and the root `README.md`) are read **then** neither lists `cloud-run/og-renderer/` nor mentions `OG_RENDERER_URL`, dynamic/Playwright-rendered OG images, or a Cloud Run OG renderer as a live surface. (Test: "README.md drops the cloud-run/og-renderer references".)
- **Given** the design-only `specs/x-multi-event-schema.md` **when** its Cloud-Functions and branding-sweep guidance is read **then** it describes the `share` Function as removed (ADR 0005, #39) rather than instructing operators to edit and redeploy it. (Test: "x-multi-event-schema.md no longer instructs redeploying the removed share Function".)

## Acceptance criteria

- **Given** the merged removal, **when** `npm run build` runs, **then** it is green.
- **Given** the merged removal, **when** the repo is grepped for `og-renderer`, `OG_RENDERER_URL`, `/s/**`, or the `share` Function, **then** the only remaining hits are intentional-historical (the ADR, the `plans/**` planning tables, the `scripts/gh-projects/examples/**` issue-authoring scaffolding, this spec/test, and the two `phase-1-deploy.md` cleanup/retirement mentions above)—no live code path, config, or operator-facing doc/spec still instructs deploying, configuring, or depending on the pipeline.
- **Given** a bare URL pasted into chat, **when** a crawler fetches it, **then** the static `index.html` OG + `og-default.png` still unfurl with no server involved.
