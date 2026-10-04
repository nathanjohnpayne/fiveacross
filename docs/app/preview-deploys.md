# Vercel hosts: isolated test previews and production mirrors

The owner [selected isolated test Firebase Auth/data for previews](https://github.com/nathanjohnpayne/fiveacross/issues/1420#issuecomment-5975979267) and [confirmed the decision](https://github.com/nathanjohnpayne/fiveacross/issues/1420#issuecomment-5975991119). This supersedes the production-backed stable-preview runbook in [ADR 0007](../adr/0007-preview-auth-stable-vercel-alias.md). **No preview host has production sign-in trust**, including the former `gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app` alias.

## Preview readiness and required owner actions

Previews are currently disabled at the build boundary: `vite.config.ts` calls `assertPreviewFirebaseIsolation` before loading Firebase configuration and refuses `VERCEL_ENV=preview`. This includes populated production configurations, named-target builds and generic CI builds. No isolated project ID or configuration is invented here, and changing only `VITE_EVENT_ID` within a production project is insufficient.

Before a preview can be enabled, the owner must select an isolated test Firebase project/web app and authorize its provisioning, test-only Auth/OAuth configuration, data and deployment. A reviewed source follow-up must validate the complete project/web-app configuration and its Auth helper or handoff routing before replacing the refusal. Preview `VITE_FIREBASE_*`, storage and any handoff endpoint must belong to that isolated environment. Neither production Firebase project, its credentials nor its central Auth origin may back a preview.

The shared `vercel.json` gives only the three exact production mirror hosts a production `/__/auth/*` proxy. Preview hosts fall through to the SPA; this does not implement a working test Auth proxy. No force-push to `preview`, added production authorized domain or production OAuth redirect registration enables a supported sign-in flow.

The build checks the platform's `process.env.VERCEL_ENV`, not a browser `VITE_*` flag. [Vercel documents that system variables are available at build time when system-variable access is enabled](https://vercel.com/docs/environment-variables/system-environment-variables). Verify that exposure and the actual preview value in the project configuration before any authorized rollout; a build outside that platform context is not proof of hosted isolation.

The owner will provide the Google OAuth redirect-URI export and Vercel protection/branch-permission visibility separately. The historical audit found the former stable alias absent from both production Firebase authorized-domain lists; Google OAuth registrations and current Vercel protection remain unverified. Existing deployed preview artifacts or registrations are not removed by a source commit. Inventory and any removal require a separately authorized configuration rollout and readback.

## Preview acceptance after separately authorized rollout

Verify the deployed test project/web-app configuration, test-only redirect registrations, Vercel protection and push permissions. Complete sign-in on the intended device, inspect Auth/Firestore/Storage network routing and prove no production endpoint or data mutation occurs. Source tests cover the current fail-closed build, host and proxy boundaries; they do not complete these deployed acceptance checks.

For layout-only local checks, `npm run dev -- --host` can serve the Mac's LAN address. Local development is outside the Vercel preview-publication guard; it does not prove isolated hosted sign-in. When a supported preview is eventually deployed, use the waiting-service-worker Reload banner or pull-to-refresh before assessing a new build.

## The brand mirrors

`fiveacross.vercel.app` is the Five Across backup host (#585): a **second Vercel project**, building this same repository and the same `main` branch, against the `fiveacross` Firebase project ([ADR 0008](../adr/0008-five-across-second-firebase-project.md)).

It exists because a Five Across Event served only from Firebase Hosting has no fallback if a venue network blocks that host. Gay Cruise Bingo already lived through exactly that—`gaycruisebingo.com` was SNI-blocked on Virgin Voyages' shipboard network while `*.vercel.app` stayed reachable, and the Vercel mirror was what players used mid-cruise. The [#599](https://github.com/nathanjohnpayne/fiveacross/issues/599) pivot to `fiveacross.app` removes the *suspected* cause of that specific block (a `bingo` substring filter), but the mirror is not made redundant by it: it is independent CDN, certificate, and hostname class, so it also covers a Firebase Hosting or Cloudflare outage and any future filter the theory does not predict.

### Why this shape

**A separate Vercel project, not a branch on the existing one.** A branch URL on the `gaycruisebingo` project historically sat behind Vercel Standard Protection (historically described in ADR 0007; current protection remains an owner inventory task)—a vercel.com login wall, which is disqualifying for a host players are meant to open on their phones. Only a *production* deployment is public, a project has exactly one production branch, and `gaycruisebingo`'s is already `main` serving the gcb env. So the mirror needs its own project.

**One `vercel.json` on `main`, not a mirror branch.** The Gay Cruise Bingo mirror's exact-host `/__/auth/:path*` rule targets `gaycruisebingo.firebaseapp.com`. Each Five Across-family mirror instead has its own exact-host rule targeting `fiveacross.firebaseapp.com`, ahead of the SPA catch-all:

```json
{
  "source": "/__/auth/:path*",
  "has": [{ "type": "host", "value": { "eq": "fiveacross.vercel.app" } }],
  "destination": "https://fiveacross.firebaseapp.com/__/auth/:path*"
}
```

For `/__/auth/:path*`, the three production mirror hosts match their respective exact-host Auth rules. Every other host matches no Auth rule and falls through to the SPA catch-all. The `{ eq }` object form is required: a bare string `value` is an unanchored regex to Vercel and would also match `fiveacross.vercel.app.evil.example`. Guarded by `src/vercel-auth-proxy.test.ts`; the reasoning lives in [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md).

The two alternatives the ticket floated were both worse. A **long-lived mirror branch** carrying its own `vercel.json` makes the backup host a permanent fork of `main` that has to be re-synced by hand—and a backup host quietly serving stale code is precisely the failure it exists to prevent, discovered at the worst possible moment. **Build-time templating** cannot work at all: Vercel reads `vercel.json` from the source before the build command runs, so a `vercel.json` written during the build is never read. (Generating `.vercel/output/config.json` via the Build Output API would work, but it means hand-rolling what the Vite framework preset does for free, on both projects.)

### Current state

| Step | `fiveacross.vercel.app` | `vacaybingo.vercel.app` |
|---|---|---|
| 0. Repo wiring (`vercel.json` rule + allowlist entry) | **Done**—#622 | **Done**—#628 |
| 1. Vercel project | **Done** | **Done** |
| 2. Minted host confirmed exact | **Done** | **Done** |
| 3. Production env vars | **Done**—nine `VITE_*`, Production scope | **Done**—same nine, own `authDomain`, `VITE_EDITION=vacay` |
| 4. Git connected, branch auto-deploy OFF | **Done**—linked, `git.deploymentEnabled: { "**": false, "preview": true }` (#676/#680) | **Done**—same |
| 5. Firebase authorized domain | **Outstanding** | **Outstanding** |
| 6. Google OAuth redirect URI | **Outstanding—console-only** | **Outstanding—console-only** |

Step 0 is not optional and not merely cosmetic. A mirror host whose `vercel.json` rule is missing falls through to the SPA, so its OAuth helper is unavailable—a failure that survives both console registrations and reads as an inexplicable auth bug. Never provision a mirror host before its rule is on `main`.

Both mirrors are live and serve the Bodega Event with Vacay branding. Since #676 they **do not rebuild on a merge**—see § Operating it. **Neither can complete sign-in yet**—step 6 is outstanding on both.

> **Do not advertise either mirror URL until step 6 is done for that host.** This is the one thing on this page that can burn a player.
>
> Because each mirror host is in `FIRST_PARTY_AUTH_HOSTS`, `isAuthConfiguredForHost` returns true there, so the app **mounts and renders a real Google sign-in button**—it does *not* show the `auth-unconfigured` screen. Until steps 5 and 6 are done for that host, tapping it fails with `auth/unauthorized-domain` or `redirect_uri_mismatch`. The window is inherent to any allowlist entry: the code half has to land before the console half can reference it. Harmless while the host is unadvertised, unrecoverable-by-the-player once it is not.

### Setup runbook

Steps 1–4 are Vercel work and step 6 is console-only. Step 5 has an API path but needs a credential with Identity Toolkit access on `fiveacross`—ordinary local ADC gets `PERMISSION_DENIED`.

1. **Create the project.** Vercel dashboard → **Add New → Project** → import `nathanjohnpayne/fiveacross` → **Project Name: `fiveacross`**. Framework preset **Vite**, build command `npm run build`, output `dist`, production branch `main`. (CLI equivalent: `vercel project add fiveacross`, then `vercel git connect` from a linked checkout—the dashboard flow is less fiddly and shows you step 2's answer immediately.)

   `vercel project add` creates the project with **no framework preset**, which defaults the output directory to `build` and fails the first deploy with *"No Output Directory named `build` found"* even though the Vite build succeeded. The CLI has no flag for this; either use the dashboard, or `PATCH https://api.vercel.com/v9/projects/<projectId>?teamId=<orgId>` with `{"framework":"vite","outputDirectory":"dist","buildCommand":"npm run build"}`.

   `vercel link` also writes a `.env.local` holding a `VERCEL_OIDC_TOKEN` **and appends `.vercel` + `.env*` to `.gitignore`.** In this repo both are unwanted—`.gitignore` is tracked and already covers what it needs to. Revert the `.gitignore` edit and delete the generated `.env.local` before committing anything.

2. **Confirm the minted production host is exactly `fiveacross.vercel.app`.** This is the load-bearing check of the whole runbook. ✅ *Confirmed on provisioning—`vercel project ls` and `vercel inspect` both report `https://fiveacross.vercel.app` as the production alias.* Vercel assigns `<project>.vercel.app` when that subdomain is free and falls back to `<project>-<scope>.vercel.app` when it is not; `fiveacross.vercel.app` was unclaimed when this was written, but the `.vercel.app` namespace is global and shared with every other Vercel user. If Vercel mints anything else, **stop**: `vercel.json`'s `has` condition and `FIRST_PARTY_AUTH_HOSTS` in `src/auth-domain.ts` both hard-code this literal string, and a mismatch leaves the mirror without its production Auth proxy. Fix the two constants in a follow-up PR before doing steps 5 and 6. (You can also add the alias explicitly under **Settings → Domains** if the project minted a longer default but the short name is free.)

3. **Set Production environment variables** (Settings → Environment Variables, **Production** scope only). Take the `VITE_FIREBASE_*` values from the `fiveacross` console (Project settings → General → Your apps → Web app), **not** from the gcb project:

   | Variable | Value |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | from the `fiveacross` web app |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `fiveacross.vercel.app` |
   | `VITE_FIREBASE_PROJECT_ID` | `fiveacross` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | from the `fiveacross` web app |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | from the `fiveacross` web app |
   | `VITE_FIREBASE_APP_ID` | from the `fiveacross` web app |
   | `VITE_EVENT_ID` | the Bodega Event id |
   | `VITE_EDITION` | whatever the primary Bodega build sets |
   | `VITE_POSTHOG_KEY` | same as the primary Bodega build |
   | `VITE_POSTHOG_HOST` | **leave unset** (#612)—the client walks the in-code failover chain (`POSTHOG_INGEST_HOSTS`); setting a host outside that chain silently disables the failover |

   `VITE_FIREBASE_AUTH_DOMAIN` is belt-and-braces—`resolveAuthDomain` pins the mirror host in code regardless of what the dashboard holds, deliberately, as required by the production same-origin policy. Setting it correctly anyway keeps the dashboard from documenting a lie.

   `VITE_EVENT_ID` makes this a **single-Event build**: the bundle serves exactly the Bodega Event and skips `publicHostnames/{host}` for hostname-to-Event resolution. After mount, the independent adult-content watcher can still read that public document for posture and display-only preview; it does not change Event or Edition identity. The resolution bypass is what makes a `.vercel.app` host servable at all (ADR 0010's same-origin escape hatch, ADR 0009's build-mode switch). It is baked in at build time, so changing it later needs a redeploy, not just an edit. `VITE_EDITION` must be set together with it and must **match the primary build**—a mismatch ships the backup host under different branding and chrome than the host it is backing up.

4. **Connect Git, and leave auto-deploy off.** Settings → Git → connect `nathanjohnpayne/fiveacross`, production branch `main`. The link is what gives the project a repo to build from; it is **not** what triggers builds. `vercel.json` on `main` carries

   ```json
   "git": { "deploymentEnabled": { "**": false, "preview": true } }
   ```

   so **no branch deploys any of the three projects except `preview`** (#676, widened in #680). Deploys are the explicit command in § Operating it.

   **`**`, not `*`.** Vercel matches these with [minimatch](https://github.com/isaacs/minimatch), where `*` does not cross a `/` — and every working branch here is `claude/…`, so a `*` rule matches none of them and the setting would look applied while changing nothing. Verified twice: against minimatch 10.2.5 locally, then against Vercel itself — with `**` in place a branch push creates **no deployment record at all**, where the same branch shape created three (one per project) an hour earlier.

   **`preview: true` is the historical Git exception**; the source build now refuses preview publication until isolated configuration is reviewed. Vercel's documented precedence is that a branch matching several rules deploys if **any** matched rule is `true`.

   **Do not "fix" this by re-enabling automatic deployments.** Every escalation of Vercel build volume on this repo has ended the same way, and it has now happened twice at different scales:

   - **Previews (the first incident).** A per-project Ignored Build Step (`[ "$VERCEL_ENV" != "production" ]`) was briefly removed from both mirrors on the theory that skipping builds risked a silently stale backup host. Within minutes, preview builds from the two mirror projects—on top of `gaycruisebingo`, all three now building on every branch push—exhausted the **account-wide build rate limit**, and Vercel began refusing deployments across the whole team with *"Deployment rate limited—retry in 24 hours."* That takes out `gaycruisebingo.vercel.app`, the brand's own ship-network fallback, for a day.
   - **Production merges (why #676 went further).** Even with previews skipped, three projects × every merge to `main` is three builds nobody asked for, most of them rebuilding a mirror whose content did not change.

   Those preview builds were pure waste besides: no `VITE_*` values are set on the mirror projects' **Preview** environment, so historical builds failed the Vite blank-API-key guard, and the resulting red `Vercel – <project>` check lands on unrelated pull requests. That is also why the three `Vercel – *` contexts on a PR read *"Canceled by Ignored Build Step"* rather than passing on merit.

   **Do not narrow the Ignored Build Step to enable production-backed previews.** The historical preview flow was canceled by `[ "$VERCEL_ENV" != "production" ]`; current Vercel protection/ignore settings require owner inventory. Even if a console setting permits a preview build, the source isolation guard refuses it. Leave production mirror deployment settings unchanged; configure a test-only preview path only through a separately authorized reviewed rollout.

   **And do not reach for the Ignored Build Step as the manual-deploy switch**—Vercel does not document whether that step also runs for CLI deployments, so setting it to always-skip risks silently cancelling the deploy you just typed. `git.deploymentEnabled` is scoped to commits by definition and has no such ambiguity.

   **Never assume a mirror is current**—the reason has simply moved. It used to be that Vercel cancels queued deployments under build pressure, leaving no visible mark: the host keeps serving its previous build at `HTTP 200` with correct branding. Now it is more direct: nothing publishes a mirror but you.

   **The old Git-SHA check no longer answers this, and fails misleadingly.** It read `meta.githubCommitSha` off the latest production deployment, which exists only on *Git* deployments—a CLI deploy carries no Git metadata at all, so that query now prints `?` and cannot tell current from stale.

   What replaces it is not weaker. The guarded command in [`deploy-targets.md`](deploy-targets.md) § Deploying a mirror passes `--build-env GITHUB_SHA=...`, so the **served bundle** carries the exact commit and can be grepped for it, exactly as the Firebase hosts are (§ Post-deploy verification). Distinguish the two: Vercel's *deployment metadata* is unusable on this path, the *bundle stamp* is authoritative. The content-marker check is the fallback for mirrors published before #676, or any deploy where the flag was dropped—a bare `unknown` where a sha was expected means exactly that.

5. **Firebase Auth authorized domains on `fiveacross`.** Console: **Firebase console (fiveacross project) → Authentication → Settings → Authorized domains → Add domain** → `fiveacross.vercel.app`. Scriptable, with a deploy credential for `fiveacross` active—read, append, write back:

   ```bash
   TOKEN=$(gcloud auth print-access-token)
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://identitytoolkit.googleapis.com/admin/v2/projects/fiveacross/config" \
     | jq '.authorizedDomains += ["fiveacross.vercel.app"] | {authorizedDomains}' \
     > /tmp/fiveacross-authdomains.json
   # Read /tmp/fiveacross-authdomains.json and confirm nothing is missing BEFORE the PATCH.
   curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d @/tmp/fiveacross-authdomains.json \
     "https://identitytoolkit.googleapis.com/admin/v2/projects/fiveacross/config?updateMask=authorizedDomains"
   ```

   The field is **replaced, not merged**. A PATCH that drops `localhost`, `fiveacross.firebaseapp.com`, `fiveacross.web.app`, or the Bodega custom domain takes Five Across sign-in down with it—which is why the read-modify-write above never types the list by hand, and why the intermediate file is worth eyeballing.

6. **Google OAuth web client redirect URI—console only, human step.** There is no API for this. **Google Cloud console → the `fiveacross` project → APIs & Services → Credentials**, open the auto-created **Web client** (the one Firebase Auth uses on `fiveacross`; if the project has several OAuth clients, it is the auto-created "Web client"—check it against the `fiveacross` Firebase Auth Google provider's client id before editing), and add

   - **Authorized redirect URI**: `https://fiveacross.vercel.app/__/auth/handler`
   - **Authorized JavaScript origin**: `https://fiveacross.vercel.app`

   Google's propagation note applies: a `redirect_uri_mismatch` in the first few minutes after saving is not necessarily a mistake.

### The Vacay Bingo mirror (#625)

`vacaybingo.vercel.app` is the third and last of the family, alongside `gaycruisebingo.vercel.app` and `fiveacross.vercel.app`. It follows the runbook above unchanged except for the values below, because **Vacay is an Edition of the `fiveacross` Firebase project, not a project of its own**—ADR 0008 splits the data plane by cohort, not by brand. Same Firebase project, same registrations console, same `/__/auth/*` proxy destination; only the Vercel project and the baked Edition differ.

| Setting | Value |
|---|---|
| Vercel project name | `vacaybingo` |
| Required minted host | `vacaybingo.vercel.app` (exact—the hard stop in step 2 applies identically) |
| `VITE_FIREBASE_AUTH_DOMAIN` | `vacaybingo.vercel.app` |
| `VITE_EDITION` | `vacay` |
| Every other `VITE_*` | identical to the `fiveacross` mirror |
| Firebase authorized domain | `vacaybingo.vercel.app`, on the **`fiveacross`** project |
| OAuth redirect URI | `https://vacaybingo.vercel.app/__/auth/handler` on the **`fiveacross`** web client |
| OAuth JS origin | `https://vacaybingo.vercel.app` |

**It serves the branded app in place and must never redirect to `vacaybingo.com`.** A mirror that bounces to the canonical host is worthless in the one situation it exists for—the canonical host being unreachable. Nothing in the code does this today; the rule is written down so nobody adds it as a convenience later.

#### The paired hostname records and the pinned mirror’s resolution bypass

[#625](https://github.com/nathanjohnpayne/fiveacross/issues/625) specifies a Firestore `hostnames/vacaybingo.vercel.app` document so the mirror resolves its Brand and Event the way DNS does. **The provisioned mirror does not use the canonical document for hostname-to-Event resolution**, deliberately: setting `VITE_EVENT_ID` makes a *single-Event build*, which per ADR 0009 serves exactly that Event and **skips `publicHostnames/{host}` for hostname-to-Event resolution**. Its post-mount adult-content watcher can still read the public copy for posture and display-only preview, without changing Event or Edition identity. A hostname-resolved build would instead have to complete a Firestore `getDocFromServer` before first paint, and `shouldMountOnBootstrapFailure` makes it fail **closed** to the `unreachable` screen when that read fails.

That is the wrong trade for a backup host. The mirror's entire job is to work when something else is broken, so it should depend on as little as possible at boot—an env-pinned build has no pre-paint network dependency at all. The paired canonical/public hostname records are the right mechanism for a mirror that must serve *many* Events, which is the follow-up design #625 itself defers ("Event slugs on mirrors are the follow-up design ticket").

If and when a mirror needs hostname resolution, first use the reviewed paired writer to create canonical `hostnames/vacaybingo.vercel.app` and its full allowlisted `publicHostnames/vacaybingo.vercel.app` replacement in the same atomic operation. The public copy must come from `projectPublicHostname`, preserving the approved seven routing/four nested preview fields while excluding canonical registry/recovery metadata. Both records need the following routing values:

```
Canonical collection: hostnames
Public collection:    publicHostnames
Document id: vacaybingo.vercel.app     (lowercase; the lookup lowercases the hostname)
  eventId:       "bodega-bay-2026"     REQUIRED, non-empty
  status:        "active"              REQUIRED, one of active | disabled | archived
  edition:       "vacay"
  canonicalHost: "vacaybingo.vercel.app"   ← the mirror itself, NOT the brand domain
  isCanonical:   true
```

Field names are `eventId` and `status`, **not** `event` and no status: `fetchHostnameDoc` (`src/data/hostnames.ts`) returns `null` unless `eventId` is a non-empty string *and* `status` is a recognised value, and a `null` renders the not-found screen rather than the Event. A document written from the shorthand in the ticket would look correct in the console and resolve to nothing. Full field table: [`specs/hostnames-lookup.md`](../../specs/hostnames-lookup.md).

**`canonicalHost` must name the mirror itself, and `isCanonical` must be `true`.** This is the field where a reasonable-looking value breaks the mirror. Nothing redirects an alias—every registered host in service serves in place ([#599](https://github.com/nathanjohnpayne/fiveacross/issues/599) as amended; a zone being retired, like `fiveacrossbingo.com`, redirects instead)—but a `canonicalHost` naming the brand's real domain would make analytics (`resolvedCanonicalHost()`, `src/canonicalHost.ts`) report the mirror's traffic under the very hostname that was unreachable in the one situation the mirror exists for. Share links are not a harm: since #607 they carry the entry-point origin (`shareOrigin()`), so a link shared from the mirror already points at the mirror regardless of this field. A mirror is its own canonical.

Verify the canonical/public pair, including an anonymous public point read, before removing `VITE_EVENT_ID` and rebuilding the hostname-resolved mirror. Pre-staging the pair while `VITE_EVENT_ID` remains set does not exercise hostname-to-Event resolution in that pinned build, though its post-mount watcher may read the public copy; a missing or denied public copy has no canonical fallback. Provisioning, backfill and deployment still require their separate authorization.

### Verifying the mirror

1. `https://fiveacross.vercel.app/` loads the Bodega Event—with **no** Vercel login wall (if you hit one, step 1 created a preview deployment, not a production one). ✅
2. The `<title>`, iOS home-screen label and PWA manifest all read the Edition's name, and the bundle carries the `fiveacross` project id, the Bodega Event id, and a non-empty `apiKey`. An empty `apiKey` in the bundle means the env vars did not reach the build—though the Vite blank-key guard should have failed the build first. ✅
3. `/__/auth/iframe` returns Firebase's helper shell rather than the SPA's `index.html`—compare the two response bodies, they must differ. If they are identical, the auth rewrite lost its priority over the catch-all. ✅
4. The auth iframe request in the network panel goes to `https://fiveacross.vercel.app/__/auth/iframe`, not to `fiveacross.firebaseapp.com`. If it points at `firebaseapp.com`, the `FIRST_PARTY_AUTH_HOSTS` entry or the `has` condition does not match the minted host. ✅
5. Google sign-in completes in a fresh session (a private window, so no existing session masks a broken registration) and the board deals. **Blocked on steps 5 and 6.**
6. The board is the same Event the primary Bodega host serves—same Event id, same Edition chrome, same theme. **Check after sign-in works.**

Note that steps 3–4 prove the rewrite fires and reaches Firebase Hosting, but they cannot prove *which* Firebase project it reached: Firebase serves a byte-identical helper shell from every project, so no black-box request distinguishes `fiveacross` from `gaycruisebingo` here. That the correct one is reached follows from the deployed `vercel.json`, and is confirmed for real only by step 5's sign-in.

### Operating it

The mirror deploys **only when you deploy it** (#676/#680)—`vercel.json` carries `git.deploymentEnabled: { "**": false, "preview": true }`, so neither a merge nor a branch push builds anything on any of the three projects. The guarded command lives in [`deploy-targets.md`](deploy-targets.md) § Deploying a mirror; use it rather than a bare `npx vercel deploy` — it pins the source (`origin/main`, clean tree), the team scope, and the project, none of which the CLI infers safely on its own here.

The guards are not ceremony. `vercel deploy` uploads your **current working directory**—`--project` picks the destination, not the source—so with Git deploys off this is the only production path and the only thing standing between a dirty feature checkout and a live host. `git.deploymentEnabled` governs *Git-triggered* deployments ("branches that should not trigger a deployment upon commits"), so it never blocks the command itself.

This inverts the old hazard. The mirror can no longer be *ahead* of the primary; it is now reliably *behind* until you catch it up, so a deploy that matters is two commands, primary then mirror, in that order. The reason is the account-wide build cap: three projects on one repository meant three production builds per merge, and exhausting the cap refuses deployments team-wide for 24 hours—including `gaycruisebingo.vercel.app`, the brand's own ship-network fallback. The automation was not buying reliability anyway (see the cancelled-build warning in step 4), so the trade is explicit staleness you can see for implicit staleness you cannot.

Add the mirrors to the post-deploy check. After any deploy that changes what a browser receives—`src/**`, `public/**`, `index.html`, `vite.config.ts`, dependencies, or `vercel.json` itself, the same trigger [`../agents/deployment-process.md`](../agents/deployment-process.md) names—publish each affected mirror **after its own Firebase primary has been deployed** — `gaycruisebingo.vercel.app` follows the `gaycruisebingo` project, `vacaybingo.vercel.app` and `fiveacross.vercel.app` follow `fiveacross` — then load each once and confirm it mounts, alongside the `SYNTHETIC_URL` check the primary host gets from `scripts/deploy.sh`. Publishing a mirror whose primary has not moved points a new client at an old backend; the mapping and the reasoning are in [`deploy-targets.md`](deploy-targets.md) § Deploying a mirror. The mirrors are not covered by that synthetic—they are a different deploy pipeline entirely, and since #676 nothing publishes them but you.

Handing a mirror to players is a manual decision: it is a backup URL to give out when the primary host is unreachable, not a second address to advertise. And not before that host’s OAuth registration is done—see the warning under Current state.

## Troubleshooting

Production mirror failures still require the exact host rewrite, corresponding production Firebase authorized domain and OAuth redirect registration, and matching Production-scoped build configuration. Check the mirror's minted hostname against its exact rule; never broaden it to a suffix or preview pattern.

A preview build refused with the isolated-configuration message is the intended current boundary. An old preview displaying an app or Google button is not evidence of approved isolation: stop testing against production and request the owner configuration inventory. Do not add its hostname to `FIRST_PARTY_AUTH_HOSTS` or either production project's consoles.

A successful deployment can still display a waiting service worker's old bundle. Use the app's Reload banner or pull-to-refresh before comparing versions; a reload alone does not establish which source/configuration is running.

The build also refuses `VERCEL=1` with missing or unknown `VERCEL_ENV`. If all platform system variables are disabled, source alone cannot identify a Vercel build; verifying system-variable exposure remains a deployed configuration prerequisite, not a proven live state.
