# Vercel hosts—preview deploys, and the Five Across mirror

Runbook for the decision in [`docs/adr/0007-preview-auth-stable-vercel-alias.md`](../adr/0007-preview-auth-stable-vercel-alias.md): previews are served from **one fixed hostname**, so Google sign-in can be registered for it once instead of once per deployment. Parts 1–4 cover that. The last section covers the Five Across backup host (#585), which is the same machinery pointed at a different Firebase project.

The preview alias is:

```
gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app
```

It is the Vercel branch URL of a dedicated `preview` branch, and it always serves that branch's most recent deployment.

## Which Vercel hosts can sign in, and why

Every host that can complete Google sign-in is registered **three times**, all by exact hostname: in `FIRST_PARTY_AUTH_HOSTS` (`src/auth-domain.ts`), in Firebase Authentication's authorized domains, and as an authorized redirect URI on a Google OAuth web client. None of the three accepts a wildcard, which is the whole reason this page exists.

| Host | Signs in? | Why |
|---|---|---|
| `gaycruisebingo.com`, `gaycruisebingo.vercel.app`, `gaycruisebingo.firebaseapp.com` | Yes | Production, registered on the `gaycruisebingo` project. |
| `gaycruisebingo-git-preview-…vercel.app` | Yes | The stable preview alias—one branch URL, registered once (Parts 1–4). |
| `fiveacross.vercel.app` | Yes† | The Five Across mirror, registered on the `fiveacross` project (last section). |
| `vacaybingo.vercel.app` | Yes† | The Vacay Bingo mirror—also registered on the `fiveacross` project; Vacay is an Edition of it, not its own project. |
| A single-Event Firebase custom domain, e.g. `bodega-bay.fiveacross.app` | Yes | Its build pins `authDomain` to itself—ADR 0010's same-origin escape hatch. |
| Any per-deployment or per-branch preview host, `…-<hash>-…vercel.app` | **No, and never** | The hostname changes per push, so there is nothing stable to register. |

† Both mirrors are provisioned and serving, but their console registrations are **outstanding**—see § The brand mirrors → Current state. Until those land they render a Google button that fails, so neither URL should be handed out yet.

A per-deployment preview host therefore renders the `auth-unconfigured` screen—"This address is not open yet". That screen is the gate working as designed, not a regression: before #576 those hosts showed a Google button that silently dead-ended, which was strictly worse. On a `*.vercel.app` hostname the screen now adds a developer note pointing back here (#585, `src/components/EventNotFound.tsx`), because the person reading it on that host is by construction someone who just pushed a branch.

The long-term fix is #530 / [ADR 0010](../adr/0010-centralised-auth-origin-with-handoff.md): a central auth origin plus a single-use handoff abolishes per-host registration entirely, and when it lands both arbitrary preview hosts and wildcard Event hostnames get working sign-in. Until then, every registration on this page is the escape-hatch baseline.

---

## Part 1—one-time setup (human only)

Steps 2 and 3 are console configuration. An agent must not attempt them; leave them for a human and do them in order. Until all three are done, sign-in on the preview alias fails with `auth/unauthorized-domain` or `redirect_uri_mismatch` even though the code is already in place.

### 1. Create the `preview` branch

```bash
git push origin origin/main:refs/heads/preview
```

Vercel builds it and the branch URL above starts resolving (before this, it returns `DEPLOYMENT_NOT_FOUND`). Do **not** protect this branch—it is force-pushed constantly and nothing merges from it.

### 2. Firebase Authentication → authorized domains

Console: **Firebase console → Authentication → Settings → Authorized domains → Add domain**, and add

```
gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app
```

This one has an API path if you prefer it (same one the custom-domain runbook in [`README.md` §6](README.md) uses): read `GET https://identitytoolkit.googleapis.com/admin/v2/projects/gaycruisebingo/config`, append the host to `authorizedDomains`, and `PATCH` it back with `?updateMask=authorizedDomains`. Send the **whole** list—the field is replaced, not merged, so a PATCH that omits `gaycruisebingo.com`, `gaycruisebingo.vercel.app`, `gaycruisebingo.firebaseapp.com`, `gaycruisebingo.web.app`, or `localhost` takes production sign-in down with it.

### 3. Google OAuth web client → authorized redirect URI

Console only—there is no API for this. **Google Cloud console → APIs & Services → Credentials**, open the auto-created **Web client** (the one whose client id ends `-9m43`; this project has more than one OAuth client and only that one is what Firebase Auth uses), and under **Authorized redirect URIs** add

```
https://gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app/__/auth/handler
```

Save. Google's own note applies: a change here can take five minutes to a few hours to take effect, so a `redirect_uri_mismatch` immediately after saving is not necessarily a mistake—wait and retry before changing anything.

### 4. Optional—keep preview play out of the live event

A preview build uses the Vercel **Preview** environment's `VITE_FIREBASE_*`, which point at the production Firebase project, so anything you mark while testing lands in the real `med-2026` event. If that becomes a nuisance, set `VITE_EVENT_ID` on the Preview environment (Vercel → Settings → Environment Variables → Preview) to a throwaway event id. The schema is event-scoped, so this isolates cleanly, but the throwaway event needs seeding before a preview can deal a card.

`VITE_EVENT_ID` is **baked into the bundle at build time** (`src/firebase.ts` reads it into `EVENT_ID`), so changing it in the dashboard does nothing to a deployment that already exists—including the one step 1 just created. Push to `preview` again to force a rebuild, and confirm the new deployment finished before you test, or you will still be writing to the live event while believing you are isolated.

---

## Part 2—previewing a branch

From the branch you want to look at:

```bash
git push --force origin HEAD:preview
```

Then open the preview alias on the device. Vercel takes roughly a minute to build, and the URL serves the previous deployment until the new one is ready.

**A plain reload is not enough to pick up the new build.** The app runs `vite-plugin-pwa` with `registerType: 'prompt'`, so a fresh deployment's service worker installs and *waits* while the old precache keeps serving—reloading a page you have already visited on this alias can render the previous branch, which is the worst possible failure here because it looks like your change simply did not work. Use the in-app **Reload** banner when it appears, or pull down to refresh (both activate the waiting worker before reloading—see [`specs/app-update-reload-prompt.md`](../../specs/app-update-reload-prompt.md) and [`specs/pull-to-refresh.md`](../../specs/pull-to-refresh.md)). On a device you have not visited the alias from before, there is no cached worker and an ordinary load is fine.

The alias holds **one** branch at a time. If two people (or two agent lanes) want a device check at once, take turns. A second slot is possible but is **not** console-only: a `preview2` branch would need Part 1's two registrations *and* its hostname added to `FIRST_PARTY_AUTH_HOSTS` in `src/auth-domain.ts` (with its test and spec updates, merged and deployed), because that list is an exact match by design and every other branch URL deliberately falls back to the configured domain. Branch names are also capped at 18 characters inside this URL shape before Vercel truncates the host, so keep any additional slot names short.

## Part 3—the Vercel login wall

The project runs Vercel's **Standard Protection**, so every preview URL—including the proxied `/__/auth/*` paths—is gated behind a Vercel session. The production host `gaycruisebingo.vercel.app` is unaffected and stays public.

In practice: sign in to `vercel.com` once in the browser you are testing with (Safari on the phone, most likely), then open the preview alias. The SSO round trip is automatic after that. Because the gate also covers the auth helper, load the preview page **first** and sign in to Google **second**—starting the OAuth flow in a browser with no Vercel session lands the popup on Vercel's login page instead of Firebase's handler, and the sign-in silently does nothing.

If a sign-in attempt fails oddly after a long idle, reload the preview URL to refresh the Vercel session and try again—an expired session mid-OAuth swallows the callback's query string.

## Part 4—verifying it works

1. The alias loads the app (after the Vercel SSO round trip).
2. In the browser's network panel, the auth iframe request is to `https://gaycruisebingo-git-preview-…vercel.app/__/auth/iframe`—the **preview** origin, not `firebaseapp.com`. That is the same-origin guarantee from [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md); if it points at `firebaseapp.com`, step 2 or the `FIRST_PARTY_AUTH_HOSTS` entry in `src/auth-domain.ts` is wrong.
3. Google sign-in completes and the board deals.
4. On iOS Safari it completes as a **top-level redirect**, not a popup—that is the behavior the alias exists to let you test.

---

## The brand mirrors

`fiveacross.vercel.app` is the Five Across backup host (#585): a **second Vercel project**, building this same repository and the same `main` branch, against the `fiveacross` Firebase project ([ADR 0008](../adr/0008-five-across-second-firebase-project.md)).

It exists because a Five Across Event served only from Firebase Hosting has no fallback if a venue network blocks that host. Gay Cruise Bingo already lived through exactly that—`gaycruisebingo.com` was SNI-blocked on Virgin Voyages' shipboard network while `*.vercel.app` stayed reachable, and the Vercel mirror was what players used mid-cruise. The [#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) pivot to `fiveacross.app` removes the *suspected* cause of that specific block (a `bingo` substring filter), but the mirror is not made redundant by it: it is independent CDN, certificate, and hostname class, so it also covers a Firebase Hosting or Cloudflare outage and any future filter the theory does not predict.

### Why this shape

**A separate Vercel project, not a branch on the existing one.** A branch URL on the `gaycruisebingo` project sits behind Vercel Standard Protection ([ADR 0007](../adr/0007-preview-auth-stable-vercel-alias.md) § Consequences, and Part 3 above)—a vercel.com login wall, which is disqualifying for a host players are meant to open on their phones. Only a *production* deployment is public, a project has exactly one production branch, and `gaycruisebingo`'s is already `main` serving the gcb env. So the mirror needs its own project.

**One `vercel.json` on `main`, not a mirror branch.** The repository's `/__/auth/:path*` rewrite targets `gaycruisebingo.firebaseapp.com`, which is the wrong Firebase project for a fiveacross build. That conflict is resolved by a **host-conditional rewrite** placed first in `vercel.json`:

```json
{
  "source": "/__/auth/:path*",
  "has": [{ "type": "host", "value": { "eq": "fiveacross.vercel.app" } }],
  "destination": "https://fiveacross.firebaseapp.com/__/auth/:path*"
}
```

Rewrites match in array order, so requests on the mirror host take this rule and every other host falls through to the unchanged Gay Cruise Bingo rule. The `{ eq }` object form is required: a bare string `value` is an unanchored regex to Vercel and would also match `fiveacross.vercel.app.evil.example`. Guarded by `src/vercel-auth-proxy.test.ts`; the reasoning lives in [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md).

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

Step 0 is not optional and not merely cosmetic. A mirror host whose `vercel.json` rule is missing falls through to the **Gay Cruise Bingo** rule, so its OAuth helper runs against the wrong Firebase project—a failure that survives both console registrations and reads as an inexplicable auth bug. Never provision a mirror host before its rule is on `main`.

Both mirrors are live and serve the Bodega Event with Vacay branding. Since #676 they **do not rebuild on a merge**—see § Operating it. **Neither can complete sign-in yet**—step 6 is outstanding on both.

> **Do not advertise either mirror URL until step 6 is done for that host.** This is the one thing on this page that can burn a player.
>
> Because each mirror host is in `FIRST_PARTY_AUTH_HOSTS`, `isAuthConfiguredForHost` returns true there, so the app **mounts and renders a real Google sign-in button**—it does *not* show the `auth-unconfigured` screen. Until steps 5 and 6 are done for that host, tapping it fails with `auth/unauthorized-domain` or `redirect_uri_mismatch`. The window is inherent to any allowlist entry: the code half has to land before the console half can reference it. Harmless while the host is unadvertised, unrecoverable-by-the-player once it is not.

### Setup runbook

Steps 1–4 are Vercel work and step 6 is console-only. Step 5 has an API path but needs a credential with Identity Toolkit access on `fiveacross`—ordinary local ADC gets `PERMISSION_DENIED`.

1. **Create the project.** Vercel dashboard → **Add New → Project** → import `nathanjohnpayne/gaycruisebingo` → **Project Name: `fiveacross`**. Framework preset **Vite**, build command `npm run build`, output `dist`, production branch `main`. (CLI equivalent: `vercel project add fiveacross`, then `vercel git connect` from a linked checkout—the dashboard flow is less fiddly and shows you step 2's answer immediately.)

   `vercel project add` creates the project with **no framework preset**, which defaults the output directory to `build` and fails the first deploy with *"No Output Directory named `build` found"* even though the Vite build succeeded. The CLI has no flag for this; either use the dashboard, or `PATCH https://api.vercel.com/v9/projects/<projectId>?teamId=<orgId>` with `{"framework":"vite","outputDirectory":"dist","buildCommand":"npm run build"}`.

   `vercel link` also writes a `.env.local` holding a `VERCEL_OIDC_TOKEN` **and appends `.vercel` + `.env*` to `.gitignore`.** In this repo both are unwanted—`.gitignore` is tracked and already covers what it needs to. Revert the `.gitignore` edit and delete the generated `.env.local` before committing anything.

2. **Confirm the minted production host is exactly `fiveacross.vercel.app`.** This is the load-bearing check of the whole runbook. ✅ *Confirmed on provisioning—`vercel project ls` and `vercel inspect` both report `https://fiveacross.vercel.app` as the production alias.* Vercel assigns `<project>.vercel.app` when that subdomain is free and falls back to `<project>-<scope>.vercel.app` when it is not; `fiveacross.vercel.app` was unclaimed when this was written, but the `.vercel.app` namespace is global and shared with every other Vercel user. If Vercel mints anything else, **stop**: `vercel.json`'s `has` condition and `FIRST_PARTY_AUTH_HOSTS` in `src/auth-domain.ts` both hard-code this literal string, and a mismatch means the mirror's auth helper proxies to the wrong Firebase project. Fix the two constants in a follow-up PR before doing steps 5 and 6. (You can also add the alias explicitly under **Settings → Domains** if the project minted a longer default but the short name is free.)

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

   `VITE_FIREBASE_AUTH_DOMAIN` is belt-and-braces—`resolveAuthDomain` pins the mirror host in code regardless of what the dashboard holds, deliberately, for the reason ADR 0007 § "The host is pinned in code" gives. Setting it correctly anyway keeps the dashboard from documenting a lie.

   `VITE_EVENT_ID` makes this a **single-Event build**: the bundle serves exactly the Bodega Event and never consults the `hostnames/{host}` lookup, which is what makes a `.vercel.app` host servable at all (ADR 0010's same-origin escape hatch, ADR 0009's build-mode switch). It is baked in at build time, so changing it later needs a redeploy, not just an edit. `VITE_EDITION` must be set together with it and must **match the primary build**—a mismatch ships the backup host under different branding and chrome than the host it is backing up.

4. **Connect Git, and leave auto-deploy off.** Settings → Git → connect `nathanjohnpayne/gaycruisebingo`, production branch `main`. The link is what gives the project a repo to build from; it is **not** what triggers builds. `vercel.json` on `main` carries

   ```json
   "git": { "deploymentEnabled": { "**": false, "preview": true } }
   ```

   so **no branch deploys any of the three projects except `preview`** (#676, widened in #680). Deploys are the explicit command in § Operating it.

   **`**`, not `*`.** Vercel matches these with [minimatch](https://github.com/isaacs/minimatch), where `*` does not cross a `/` — and every working branch here is `claude/…`, so a `*` rule matches none of them and the setting would look applied while changing nothing. Verified twice: against minimatch 10.2.5 locally, then against Vercel itself — with `**` in place a branch push creates **no deployment record at all**, where the same branch shape created three (one per project) an hour earlier.

   **`preview: true` is the one exception**, because the stable alias is a *Git* deployment like any other and a blanket `false` would kill Part 2. Vercel's documented precedence is that a branch matching several rules deploys if **any** matched rule is `true`.

   **Do not "fix" this by re-enabling automatic deployments.** Every escalation of Vercel build volume on this repo has ended the same way, and it has now happened twice at different scales:

   - **Previews (the first incident).** A per-project Ignored Build Step (`[ "$VERCEL_ENV" != "production" ]`) was briefly removed from both mirrors on the theory that skipping builds risked a silently stale backup host. Within minutes, preview builds from the two mirror projects—on top of `gaycruisebingo`, all three now building on every branch push—exhausted the **account-wide build rate limit**, and Vercel began refusing deployments across the whole team with *"Deployment rate limited—retry in 24 hours."* That takes out `gaycruisebingo.vercel.app`, the brand's own ship-network fallback, for a day.
   - **Production merges (why #676 went further).** Even with previews skipped, three projects × every merge to `main` is three builds nobody asked for, most of them rebuilding a mirror whose content did not change.

   Those preview builds were pure waste besides: no `VITE_*` values are set on the mirror projects' **Preview** environment, so every one of them fails the Vite blank-API-key guard, and the resulting red `Vercel – <project>` check lands on unrelated pull requests. That is also why the three `Vercel – *` contexts on a PR read *"Canceled by Ignored Build Step"* rather than passing on merit.

   **⚠️ The per-project Ignored Build Step now cancels the `preview` flow, and has since 2026-08-06.** A live defect, independent of #680 — recorded rather than fixed here, because it is a per-project console setting and not a repo file.

   `[ "$VERCEL_ENV" != "production" ]` exits `0` (skip) for **any** non-production deployment, and a `preview`-branch build is `VERCEL_ENV=preview`. The deployment history dates the changeover precisely: branch deployments were `READY` up to 2026-08-05 23:50Z, and every one from 2026-08-06 01:29Z onward is `CANCELED`. Nobody noticed because there have been **zero** `preview`-branch pushes in that window.

   So `preview: true` above restores the *deployment*; the ignore step still cancels its *build*. **Part 2's device-testing flow does not work until that setting changes — on the `gaycruisebingo` project only:**

   ```bash
   [ "$VERCEL_ENV" != "production" ] && [ "$VERCEL_GIT_COMMIT_REF" != "preview" ]
   ```

   **Leave the two mirror projects' ignore step exactly as it is**, and do not remove it anywhere. `vercel.json` is shared, so `preview: true` enables a `preview` deployment on all three projects — but the alias is a `gaycruisebingo` concept, and the mirrors have no `VITE_*` values on their Preview environment, so a mirror preview build fails the Vite blank-key guard and lands a red `Vercel – <project>` check on unrelated pull requests. On the mirrors the ignore step is the only thing stopping that, which makes it load-bearing there and obsolete only on `gaycruisebingo`.

   Until that one setting changes, treat the preview alias as out of service.

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

#### The `hostnames` document, and why the mirror does not use it

[#625](https://github.com/nathanjohnpayne/gaycruisebingo/issues/625) specifies a Firestore `hostnames/vacaybingo.vercel.app` document so the mirror resolves its Brand and Event the way DNS does. **The provisioned mirror does not use it, deliberately**, and the two are mutually exclusive rather than complementary: setting `VITE_EVENT_ID` makes a *single-Event build*, which per ADR 0009 serves exactly that Event and **never consults the `hostnames/{host}` lookup**. A hostname-resolved build would instead have to complete a Firestore `getDocFromServer` before first paint, and `shouldMountOnBootstrapFailure` makes it fail **closed** to the `unreachable` screen when that read fails.

That is the wrong trade for a backup host. The mirror's entire job is to work when something else is broken, so it should depend on as little as possible at boot—an env-pinned build has no pre-paint network dependency at all. The hostnames document is the right mechanism for a mirror that must serve *many* Events, which is the follow-up design #625 itself defers ("Event slugs on mirrors are the follow-up design ticket").

If and when a mirror does need hostname resolution, drop `VITE_EVENT_ID` from that project's env and create the document:

```
Collection: hostnames
Document id: vacaybingo.vercel.app     (lowercase; the lookup lowercases the hostname)
  eventId:       "bodega-bay-2026"     REQUIRED, non-empty
  status:        "active"              REQUIRED, one of active | disabled | archived
  edition:       "vacay"
  canonicalHost: "vacaybingo.vercel.app"   ← the mirror itself, NOT the brand domain
  isCanonical:   true
```

Field names are `eventId` and `status`, **not** `event` and no status: `fetchHostnameDoc` (`src/data/hostnames.ts`) returns `null` unless `eventId` is a non-empty string *and* `status` is a recognised value, and a `null` renders the not-found screen rather than the Event. A document written from the shorthand in the ticket would look correct in the console and resolve to nothing. Full field table: [`specs/hostnames-lookup.md`](../../specs/hostnames-lookup.md).

**`canonicalHost` must name the mirror itself, and `isCanonical` must be `true`.** This is the field where a reasonable-looking value breaks the mirror. Nothing redirects an alias—every registered host serves in place ([#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) as amended)—but a `canonicalHost` naming the brand's real domain would make analytics (`resolvedCanonicalHost()`, `src/canonicalHost.ts`) report the mirror's traffic under the very hostname that was unreachable in the one situation the mirror exists for. Share links are not a harm: since #607 they carry the entry-point origin (`shareOrigin()`), so a link shared from the mirror already points at the mirror regardless of this field. A mirror is its own canonical.

Creating the document while `VITE_EVENT_ID` is still set is harmless but inert—nothing reads it—so it is not a safe way to "pre-stage" a switch, and the switch needs a rebuild either way.

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

| Symptom | Cause |
|---|---|
| `DEPLOYMENT_NOT_FOUND` | No `preview` branch yet, or its last build failed. Check Vercel's deployments list. |
| Redirected to `vercel.com/login` | Expected—Part 3. Sign in to Vercel in that browser. |
| `auth/unauthorized-domain` | Part 1 step 2 not done, or the host was typed differently. |
| `redirect_uri_mismatch` | Part 1 step 3 not done, still propagating, or added to the wrong OAuth client. |
| "Unable to process request due to missing initial state" | The auth handler resolved cross-origin. The host is missing from `FIRST_PARTY_AUTH_HOSTS`, or `vercel.json`'s `/__/auth/:path*` rewrite lost its priority over the SPA catch-all. |
| Sign-in works but the board is someone else's | You are on the live event. Part 1 step 4—and it needs a rebuild, not just an env-var edit. |
| Your change is missing but the build succeeded | A waiting service worker; the old precache is still serving. Use the Reload banner or pull-to-refresh, not a plain reload. |
| "This address is not open yet" on a `*.vercel.app` host | Expected on any per-deployment host—they can never sign in. Use the stable preview alias (Part 2). |
| The mirror serves the Gay Cruise Bingo event | The mirror project's Production env vars point at `gaycruisebingo`, or `VITE_EVENT_ID` was changed without a redeploy. Mirror runbook step 3. |
| The mirror's auth iframe loads from `gaycruisebingo.firebaseapp.com` | The minted host is not exactly `fiveacross.vercel.app`, so `vercel.json`'s `has` condition never matches. Mirror runbook step 2. |

## Not doing this at all

For a pure visual check—layout, type, theme, motion—`npm run dev -- --host` and the Mac's LAN address on the phone is cheaper than any of the above and needs no setup. It cannot cover sign-in: a raw LAN IP is neither a Firebase authorized domain nor a legal Google redirect URI. Reach for the preview alias when the thing you need to see is behind sign-in, or when sign-in itself is the thing you need to see.
