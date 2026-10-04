---
status: superseded
---

# Previews require isolated test Firebase Auth and data

The original ADR selected a stable, force-pushable Vercel preview alias backed by production Firebase. That trust decision is superseded by the owner decision in [#1420](https://github.com/nathanjohnpayne/fiveacross/issues/1420#issuecomment-5975979267), [confirmed by the owner](https://github.com/nathanjohnpayne/fiveacross/issues/1420#issuecomment-5975991119): previews use an isolated test Firebase project for authentication and data. No preview hostname may receive production OAuth or Firebase Auth trust. A different Event ID within a production project does not satisfy this isolation requirement.

## Source boundary

`FIRST_PARTY_AUTH_HOSTS` contains production hosts only; the stable preview alias is removed. `vercel.json` proxies production Firebase Auth helpers only for the three exact production mirror hosts. Preview hosts, including the former stable alias, receive no production helper proxy. Production mirrors remain production-backed and retain their existing exact-host Auth routes.

No isolated project/web-app configuration has been selected and verified. `assertPreviewFirebaseIsolation` in `src/build-config.ts`, called by `vite.config.ts` before loading Firebase configuration, therefore refuses all builds with `VERCEL_ENV=preview`, including named-target and CI builds. A claimed non-production project ID alone cannot establish that its web API key, Auth helper or handoff endpoints are isolated. Production and ordinary local/CI builds retain their existing behavior. The existing Git `preview` branch exception is not deployment readiness: its build fails closed.

This build guard does not revoke an existing deployment or console OAuth registration, prevent someone serving a previously built bundle from another host, or prove live Vercel protection. Those require configuration inventory and separately authorized rollout/readback.

## Enabling isolated previews

The owner must select the test Firebase project and web app, provide their configuration and authorize provisioning, test-only OAuth registrations, test data and deployment. A reviewed follow-up must verify the entire preview configuration belongs to that isolated project, choose the test Auth hosting/proxy or handoff strategy, and replace the current build refusal with that approved boundary. Do not add preview hosts to either production project's authorized domains or OAuth redirect URIs. Do not reuse production credentials, Auth handoffs, storage or data.

The OAuth redirect-URI export and Vercel deployment-protection/branch-permission visibility remain owner-provided evidence. The prior audit found the former stable alias absent from both production Firebase authorized-domain lists; that does not prove its Google OAuth redirect registration is absent. Any required production trust removal is a separate authorized configuration change, followed by exact readback.

## Validation

Tests cover removal of the stable alias, rejection of preview builds, exact production-only proxy routes, unchanged production mirror resolution and honest developer guidance. Source tests are not proof of deployed isolation. The eventual isolated deployment must complete Google sign-in on a real device and show all Auth, Firestore and Storage traffic stays within the selected test project, with no production requests or writes.

The build also refuses `VERCEL=1` with missing or unknown `VERCEL_ENV`. If all platform system variables are disabled, source alone cannot identify a Vercel build; verifying system-variable exposure remains a deployed configuration prerequisite, not a proven live state.
