---
spec_id: posthog-source-maps
status: proposed
tested: false
reason: Private uploads and fresh deployed exception symbolication still require operational acceptance.
---

# Private source maps

Owner decision #1222 selects privately uploaded, release-matched maps with no public map artifacts. This applies to both Firebase targets and all three Vercel mirrors in this repository. The personal website is a separate repository.

## Sample scope — 2026-10-09

Both accessible PostHog projects were sampled. The latest ten FiveAcross.app (503790) exceptions containing stacktrace structures span four asset hashes; their 350 frames all report `Invalid source map: bad json: expected value at line 1 column 1`. The latest five exceptions had no frames, so they cannot establish symbolication. NathanPayne.com (469428) has missing source-map errors for two browser asset frames, native/no-source failures, empty traces and one resolved frame. The original claim that every project shares the exact bad-JSON failure is therefore too broad. No sampled Five Across frame resolves, across the four observed builds; this is evidence across those sampled releases rather than proof about every historical release.

## Build and credential contract

Deploy-shaped production builds (named Firebase targets and Vercel Production) require the scoped PostHog Personal API key. Generic CI compilation and emulator builds produce no source maps and need no upload credential. The upload project is pinned to 503790 and the API host to `https://us.posthog.com`, independent of the client ingestion proxy. The release name is `fiveacross`; its version is the same exact commit baked into `__APP_VERSION__`.

The official PostHog Rollup plugin injects chunk IDs before output hashing in the app, dedicated worker and service-worker builds. One final upload uses the pinned official CLI in symbol-set release mode after Workbox has updated the service-worker map for its injected precache. The temporary service-worker map URL is removed without changing mapped offsets; all maps are deleted only after a successful upload. Application and dedicated-worker maps are hidden throughout. An upload error fails the build. A final artifact guard rejects any remaining `.map`, `.map.gz` or `.map.br` file, including one copied from `public/`; Firebase Hosting also excludes these patterns. The service worker precache excludes maps and is generated from the injected assets, preserving content revisions. No post-build injection rewrites already-hashed assets.

Local guarded deployments wrap the build with `scripts/with-posthog-sourcemaps.sh`. The default reference is the owner-provisioned item `lvnykakmgy4a6vjaibwda6gkoq`, field `credential`, in the Private vault. Set `POSTHOG_UPLOAD_OP_REF` only to select another scoped 1Password credential field; the wrapper reads it without logging or persisting the token and passes it only to the child build. It refuses a missing reference, empty key or any `op` failure. Follow the attended preflight/auth-failure policy in `docs/agents/operating-rules.md`; do not retry an authentication failure through a different path. Use a Personal API key scoped to Error Tracking write and Organization read, restricted to project 503790 where supported.

Vercel builds need the same 1Password-sourced key provisioned as a sensitive Production-only `POSTHOG_UPLOAD_API_KEY` variable on each mirror. Do not use a `VITE_` variable or put the key in tracked files, command-line arguments, `.env.*` uploads or browser code. Existing primary-before-mirror, current-main and clean-worktree deployment guards remain mandatory.

## Operational acceptance

Keep #1222 open until the scoped key is provisioned, both primaries and their three mirrors ship the reviewed commit, and a fresh real deployed exception resolves to authored `src/**` paths and line numbers in PostHog. Record the exception id, release commit, resolved source/line and serving origin; an upload success alone is insufficient. Probe `.map` counterparts for each deployed JS asset on each host and verify they return no source-map JSON. A SPA HTML response is acceptable non-disclosure evidence, though its HTTP 200 alone proves nothing.

The owner provisioned the scoped credential on 2026-10-09. The credential authenticated and a preliminary private upload succeeded; complete app/worker/service-worker artifact acceptance, deployed exception and host probes are pending. No deployment or live symbolication success is claimed here.
