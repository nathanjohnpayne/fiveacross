---
spec_id: w4-gate-vision-moderation
status: accepted
---

# Gate `moderateProof` (Cloud Vision) behind an off-by-default flag (`functions/src/index.ts`, `functions/src/visionGate.ts`, #126)

Cloud Vision (`moderateProof`) is part of the Phase-1 Functions backend that is intentionally not deployed yet, but the #101 email notifiers (`notifyProofModeration` / `notifyItemModeration`, merged in #120) live in the same `functions/src/index.ts` module. Firebase validates every trigger in a module at deploy-plan time, and `moderateProof` fails that validation—it is a `us-central1` `onObjectFinalized` Storage trigger, but the project's default Storage bucket is `us-east1`, and a function cannot listen to a bucket in another region. That single invalid trigger blocks deploying the whole `functions` package, so the notifiers cannot ship on their own while `moderateProof` is unconditionally exported. The human decision (2026-07-09) was to deploy the notifiers only and leave Cloud Vision deferred. This spec records the gate that makes that possible; it is guarded by `tests/functions/w4-gate-vision-moderation.test.ts` (the `test:functions` layer).

## `moderateProof` is exported only when `ENABLE_VISION_MODERATION` is `true`

`functions/src/index.ts` computes `const VISION_ENABLED = visionModerationEnabled()` at module load and assigns the `moderateProof` export conditionally: `export const moderateProof = VISION_ENABLED ? onObjectFinalized({ memory: '512MiB' }, moderateProofHandler) : undefined`. `visionModerationEnabled` (in `functions/src/visionGate.ts`) resolves the `ENABLE_VISION_MODERATION` flag from `functions/.env` / `functions/.env.<projectId>` (see the discovery-vs-runtime section below for exactly how). It defaults OFF: an absent value, or any value other than the literal string `true`, resolves to `false`.

- **Given** the flag is absent **when** the module is loaded **then** `moderateProof` is `undefined` (Cloud Vision deferred; default off). (Test: "is undefined (not exported) when the flag is absent—default OFF".)
- **Given** the flag is set to a value other than the literal string `true` (e.g. `TRUE`) **when** the module is loaded **then** `moderateProof` is still `undefined`—the check is a strict equality against `'true'`, so no other truthy-looking value turns Vision on. (Test: "is undefined when the flag is set to anything other than the literal string \"true\"" and the `visionModerationEnabled` process.env cases.)

## The flag is honored at deploy trigger discovery, not just runtime (the load-bearing mechanism)

Whether `moderateProof` is exported is decided during Firebase's **trigger discovery**—the step where firebase-tools loads the functions module and reads the endpoint manifest it exports. A naive `process.env.ENABLE_VISION_MODERATION` read at module load (which is what the first cut of #126 shipped, and equally what a `firebase-functions/params` `defineBoolean(...).value()` would do) does **not** see the operator's `functions/.env.<projectId>` value at that step, so the export could never actually flip on. This was flagged by Codex (PR #128 review) and verified against the installed toolchain:

- firebase-tools spawns the discovery subprocess with an **explicitly built, sealed environment**—`{ ...firebaseEnvs, FUNCTIONS_CONTROL_API: 'true', HOME, PATH, NODE_ENV, __FIREBASE_FRAMEWORKS_ENTRY__ }`, where `firebaseEnvs` is only `{ FIREBASE_CONFIG, GCLOUD_PROJECT }` (`node_modules/firebase-tools/lib/deploy/functions/runtimes/node/index.js` `spawnFunctionsProcess`; the env passed to `discoverBuild` in `deploy/functions/prepare.js` `loadCodebases` is `firebaseEnvs` + `GOOGLE_CLOUD_QUOTA_PROJECT`). It does **not** spread `process.env` and does **not** load the user `.env` files into it.
- `loadUserEnvs` (which reads `functions/.env[.<projectId>]`) runs **after** discovery, in `prepare.js`, only to set the deployed function's **runtime** `environmentVariables` and to resolve declared `params`—never in the discovery subprocess.
- A `firebase-functions/params` boolean is no escape hatch: `BooleanParam.runtimeValue()` reads `process.env[name]` (`functions/node_modules/firebase-functions/lib/params/types.js`), the same unset key at discovery, and the SDK warns that calling `.value()` during deployment is "usually a mistake". Params resolve for CEL **config fields** after discovery, not for a JS module-load conditional export.

What firebase-tools **does** guarantee at discovery is `cwd = the functions source dir` (`spawn(..., { cwd: this.sourceDir })`) plus `GCLOUD_PROJECT` and `FUNCTIONS_CONTROL_API=true`. So `visionModerationEnabled` reads the `.env` files itself from `cwd` at discovery: it short-circuits on `process.env.ENABLE_VISION_MODERATION` when present (the runtime and emulator path, where the platform has already injected the value), and otherwise—only when `FUNCTIONS_CONTROL_API==='true'`, i.e. during discovery—resolves the project id (`GCLOUD_PROJECT`, else `FIREBASE_CONFIG.projectId`) and reads `.env` then `.env.<projectId>` (project file overrides, mirroring firebase-tools' own precedence). Any missing/malformed file resolves to OFF; no filesystem access happens outside discovery.

This was confirmed end-to-end by driving the real firebase-functions discovery server (`FUNCTIONS_CONTROL_API=true`, sealed env, `cwd = functions/`) and reading `/__/functions.yaml`: with `ENABLE_VISION_MODERATION=true` present ONLY in `functions/.env.<projectId>` (not in the process env), `moderateProof` appears in the manifest; with the flag absent it does not; the notifiers appear in every case.

- **Given** the discovery markers (`FUNCTIONS_CONTROL_API=true`, `cwd = functions dir`, `GCLOUD_PROJECT`/`FIREBASE_CONFIG`) and `ENABLE_VISION_MODERATION=true` in `.env.<projectId>` (and NOT in `process.env`) **when** `visionModerationEnabled` runs **then** it returns `true`. (Tests: the "deploy trigger-discovery: reads functions/.env[.<projectId>] from cwd" cases—`.env.<projectId>`, plain `.env`, project-file override, `FIREBASE_CONFIG` projectId fallback, quotes/comment handling, and the no-declaration default-OFF.)
- **Given** the flag is unset AND not a discovery context (`FUNCTIONS_CONTROL_API` not `'true'`) **when** `visionModerationEnabled` runs **then** it returns `false` without touching the filesystem. (Test: "is OFF when the flag is unset outside discovery (no filesystem read)".)

## When off, Firebase never registers, validates, or deploys `moderateProof`

An `undefined` export is not a deployable CloudFunction, so Firebase's Functions export discovery skips it silently. `firebase-functions/lib/runtime/loader.js` `extractStack()` walks `Object.entries(module)` and registers an export as an endpoint only when `typeof val === 'function' && val.__endpoint && typeof val.__endpoint === 'object'`. An `undefined` export fails the very first clause of that check, so it is never added to the endpoint manifest—Firebase never sees it, never runs region validation on it, and never deploys it. With the flag off, the deploy therefore brings up the notifiers (and the #43 threshold-hide function once it lands) but not Cloud Vision. (When the flag is on, the export deploys cleanly because it is pinned to `us-east1` to match the bucket—see "Region pinning" below.)

## When on, `moderateProof` is byte-behavior-identical to before the gate

The gate changes only WHETHER `moderateProof` is exported, never its behavior. When `VISION_ENABLED` is `true`, the export keeps the same CloudFunction behavior as before #126—the handler body (thumbnail via sharp, SafeSearch flagging that flags only extreme/violent content and never raciness, the flag write-back to `events/${eventId}/proofs/${proofId}`) is unchanged—except the trigger is now pinned to `region: 'us-east1'`: `onObjectFinalized({ memory: '512MiB', region: 'us-east1' }, …)`. That pin resolves the deploy-plan region mismatch (see "Region pinning" below); the global default stays `us-central1` for the Firestore-triggered notifiers. The prior inline handler was extracted verbatim into a named `moderateProofHandler` function so both branches of the conditional read cleanly; nothing in the Vision or flagging logic was touched.

- **Given** the flag resolves on **when** the module is loaded **then** `moderateProof` is a defined CloudFunction—a `function` carrying the `__endpoint` manifest object that Firebase's export discovery checks for. (Test: "is a defined CloudFunction when the flag is \"true\"".)

## The #101 notifiers are always exported, regardless of the flag

The gate scopes `moderateProof` alone. `notifyProofModeration` and `notifyItemModeration` (and their shared `handleModeration` helper) are untouched by this change and stay exported whether the flag is on or off, so the notifier-only Phase-1 deploy carries them in every configuration.

- **Given** either flag state **when** the module is loaded **then** both `notifyProofModeration` and `notifyItemModeration` are still exported functions. (Test: "leaves the #101 notifiers exported and unaffected regardless of the flag".)

## Region pinning (resolves the deploy-plan mismatch)

`moderateProof` is a Storage trigger on the project's default bucket, which is `us-east1`. A Cloud Function cannot listen to a bucket in another region, so the export is pinned to `region: 'us-east1'`, overriding the module's `us-central1` global default (which the Firestore-triggered notifiers keep). This is what lets the enabled export pass Firebase's deploy-plan region validation instead of failing it. The pin is inert while the gate is off—the export is `undefined` and never registered—so it lands safely ahead of the Cloud Vision cutover.

- **Given** the flag is on **when** the module is loaded **then** `moderateProof.__endpoint.region` includes `us-east1`. (Test: the region assertion in "is a defined CloudFunction when the flag is \"true\"".)

## Deferred deploy path

With the region pin in place, Cloud Vision stays gated off until the remaining blockers are cleared, in order: (1) enable the Cloud Vision API on the project; (2) set `ENABLE_VISION_MODERATION=true` in `functions/.env.<projectId>`; (3) redeploy `--only functions`. Because the gate is honored at discovery (previous section), step 2 genuinely enables the export, and the region pin (above) makes the enabled deploy pass region validation. Enabling the API, flipping the flag, and the end-to-end verification remain tracked in #132.

## Acceptance criteria

- **Given** the merged gate, **when** `npm run test:functions` runs, **then** `tests/functions/w4-gate-vision-moderation.test.ts` passes: the `visionModerationEnabled` gate is OFF by default and only `'true'` (via `process.env` at runtime, or `functions/.env[.<projectId>]` at discovery) turns it on; `moderateProof` is `undefined` when off and a defined `__endpoint`-bearing CloudFunction when on; and the two notifiers stay exported in both states.
- **Given** the flag is on, **when** `moderateProof` is inspected, **then** its handler logic is unchanged from its pre-gate definition and its trigger is pinned to `region: 'us-east1'` to match the default Storage bucket (`__endpoint.region` includes `us-east1`).
