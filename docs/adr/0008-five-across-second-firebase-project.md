---
status: accepted
implemented: false
---

# One repository, two production Firebase projects: Five Across is a new project, not a new tenant

> **Decision accepted; the project split and membership admission are not yet fully implemented.** The repository deploy wiring (an explicit `fiveacross` project id passed through `scripts/deploy.sh`) is only that—wiring. Until Five Across has its own provisioned project, host configuration, and authentication/membership enforcement, it must not be presented as an active cohort-isolation boundary.

> **Amended 2026-08-05 (#599, #579):** the canonical Five Across domain is now `fiveacross.app`, so the planned analytics ingest proxy named below as `d.vacaybingo.com` becomes `d.fiveacross.app`—and it is **Brand-level**, one ingest host for every Edition, not an Edition-selected hostname (#578/#579). The body text below is left as written; read `d.vacaybingo.com` as the historical name.

The existing Firestore and Storage rules give **path scoping, not tenant isolation**—any signed-in account can read every Event's doc, items, players, active proofs, tally, doubts, and moments, and proof media under `proofs/{eventId}/{uid}/{file}` is likewise readable by path (see [x-multi-event-schema](../../specs/x-multi-event-schema.md) § "Rules / indexes / hosting implications"). Sequential Events within one community could accept that; an adults-only cohort and an unrelated general-audience group cannot. Five Across will use a **separate production Firebase project** while Gay Cruise Bingo remains on `gaycruisebingo`. That gives the applications separate Firebase resources, credentials, and deploy targets: an authenticated session or Firestore request for one project cannot read the other project's resources. Both targets still use this repository's source, tests, and release process—this is a data-plane boundary, not a fork.

**A separate project is not cohort admission.** A person who can reach either public app can normally complete Google sign-in in either Firebase project; once signed in, the current rules permit the reads described above within that project. Cohort isolation therefore remains deferred until authentication admission or membership-scoped rules are enforced. Do not describe the project split alone as preventing Bodega users from accessing Gay Cruise Bingo, or vice versa.

The reason is the read-scope gap, **not brand positioning**. Brand positioning alone never justifies a new project.

## Consequences

- Two `.env.local` files, two Firebase project ids (`gaycruisebingo` and `fiveacross`) passed explicitly to deploys, and two deploy runs. The Vite blank-API-key guard applies to both. `.firebaserc` intentionally carries **no per-project aliases**—only `default`—because a self-referential alias (`"fiveacross": "fiveacross"`) makes the Firebase CLI reject a functions deploy whenever `functions/.env.fiveacross` exists: the same filename matches both the projectId and projectAlias dotenv patterns ("Can't have both dotenv files with projectId (env.fiveacross) and projectAlias (.env.fiveacross)").
- **Use the guarded deploy wrapper with an explicit target.** `.firebaserc`'s `default` remains `gaycruisebingo`, and the underlying helper falls back to it when no project is given—so a Five Across deploy must pass `fiveacross` through `scripts/deploy.sh`, never call `op-firebase-deploy` directly. The named Five Across target explicitly skips the Gay Cruise Bingo Cloudflare zone and pins its production synthetic URL; do not supply an inherited cache zone. This retains the main/freshness/clean-tree checks and post-deploy synthetic while selecting the non-default Firebase project.
- Blaze billing, first-time API enablement, and a cold Functions deploy are one-time costs on the new project. App Check is opt-in via `VITE_RECAPTCHA_SITE_KEY` and can start unset.
- The projects have no shared Firebase data plane, but that is not a user-admission boundary: a Google user can still sign into both public applications until membership enforcement lands. The isolation workstream remains the owner of that property.
- Analytics deliberately does *not* split: one PostHog project carries `brand_id` / `edition_id` / `event_id` dimensions, because cross-event comparison is the question the platform exists to answer. A second managed reverse proxy (`d.vacaybingo.com`) keeps the old brand's hostname out of the new edition's network traffic.
- The projects may collapse into one only after non-self-writable membership and two-cohort isolation tests land. Additional projects after that need a contractual, ownership, or compliance reason.
