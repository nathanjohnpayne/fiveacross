# Vercel hosts — preview deploys, and the Five Across mirror

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
| `gaycruisebingo-git-preview-…vercel.app` | Yes | The stable preview alias — one branch URL, registered once (Parts 1–4). |
| `fiveacross.vercel.app` | Yes | The Five Across mirror, registered on the `fiveacross` project (last section). |
| A single-Event Firebase custom domain, e.g. `bodega-bay.fiveacross.app` | Yes | Its build pins `authDomain` to itself — ADR 0010's same-origin escape hatch. |
| Any per-deployment or per-branch preview host, `…-<hash>-…vercel.app` | **No, and never** | The hostname changes per push, so there is nothing stable to register. |

A per-deployment preview host therefore renders the `auth-unconfigured` screen — "This address is not open yet". That screen is the gate working as designed, not a regression: before #576 those hosts showed a Google button that silently dead-ended, which was strictly worse. On a `*.vercel.app` hostname the screen now adds a developer note pointing back here (#585, `src/components/EventNotFound.tsx`), because the person reading it on that host is by construction someone who just pushed a branch.

The long-term fix is #530 / [ADR 0010](../adr/0010-centralised-auth-origin-with-handoff.md): a central auth origin plus a single-use handoff abolishes per-host registration entirely, and when it lands both arbitrary preview hosts and wildcard Event hostnames get working sign-in. Until then, every registration on this page is the escape-hatch baseline.

---

## Part 1 — one-time setup (human only)

Steps 2 and 3 are console configuration. An agent must not attempt them; leave them for a human and do them in order. Until all three are done, sign-in on the preview alias fails with `auth/unauthorized-domain` or `redirect_uri_mismatch` even though the code is already in place.

### 1. Create the `preview` branch

```bash
git push origin origin/main:refs/heads/preview
```

Vercel builds it and the branch URL above starts resolving (before this, it returns `DEPLOYMENT_NOT_FOUND`). Do **not** protect this branch — it is force-pushed constantly and nothing merges from it.

### 2. Firebase Authentication → authorized domains

Console: **Firebase console → Authentication → Settings → Authorized domains → Add domain**, and add

```
gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app
```

This one has an API path if you prefer it (same one the custom-domain runbook in [`README.md` §6](README.md) uses): read `GET https://identitytoolkit.googleapis.com/admin/v2/projects/gaycruisebingo/config`, append the host to `authorizedDomains`, and `PATCH` it back with `?updateMask=authorizedDomains`. Send the **whole** list — the field is replaced, not merged, so a PATCH that omits `gaycruisebingo.com`, `gaycruisebingo.vercel.app`, `gaycruisebingo.firebaseapp.com`, `gaycruisebingo.web.app`, or `localhost` takes production sign-in down with it.

### 3. Google OAuth web client → authorized redirect URI

Console only — there is no API for this. **Google Cloud console → APIs & Services → Credentials**, open the auto-created **Web client** (the one whose client id ends `-9m43`; this project has more than one OAuth client and only that one is what Firebase Auth uses), and under **Authorized redirect URIs** add

```
https://gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app/__/auth/handler
```

Save. Google's own note applies: a change here can take five minutes to a few hours to take effect, so a `redirect_uri_mismatch` immediately after saving is not necessarily a mistake — wait and retry before changing anything.

### 4. Optional — keep preview play out of the live event

A preview build uses the Vercel **Preview** environment's `VITE_FIREBASE_*`, which point at the production Firebase project, so anything you mark while testing lands in the real `med-2026` event. If that becomes a nuisance, set `VITE_EVENT_ID` on the Preview environment (Vercel → Settings → Environment Variables → Preview) to a throwaway event id. The schema is event-scoped, so this isolates cleanly, but the throwaway event needs seeding before a preview can deal a card.

`VITE_EVENT_ID` is **baked into the bundle at build time** (`src/firebase.ts` reads it into `EVENT_ID`), so changing it in the dashboard does nothing to a deployment that already exists — including the one step 1 just created. Push to `preview` again to force a rebuild, and confirm the new deployment finished before you test, or you will still be writing to the live event while believing you are isolated.

---

## Part 2 — previewing a branch

From the branch you want to look at:

```bash
git push --force origin HEAD:preview
```

Then open the preview alias on the device. Vercel takes roughly a minute to build, and the URL serves the previous deployment until the new one is ready.

**A plain reload is not enough to pick up the new build.** The app runs `vite-plugin-pwa` with `registerType: 'prompt'`, so a fresh deployment's service worker installs and *waits* while the old precache keeps serving — reloading a page you have already visited on this alias can render the previous branch, which is the worst possible failure here because it looks like your change simply did not work. Use the in-app **Reload** banner when it appears, or pull down to refresh (both activate the waiting worker before reloading — see [`specs/app-update-reload-prompt.md`](../../specs/app-update-reload-prompt.md) and [`specs/pull-to-refresh.md`](../../specs/pull-to-refresh.md)). On a device you have not visited the alias from before, there is no cached worker and an ordinary load is fine.

The alias holds **one** branch at a time. If two people (or two agent lanes) want a device check at once, take turns. A second slot is possible but is **not** console-only: a `preview2` branch would need Part 1's two registrations *and* its hostname added to `FIRST_PARTY_AUTH_HOSTS` in `src/auth-domain.ts` (with its test and spec updates, merged and deployed), because that list is an exact match by design and every other branch URL deliberately falls back to the configured domain. Branch names are also capped at 18 characters inside this URL shape before Vercel truncates the host, so keep any additional slot names short.

## Part 3 — the Vercel login wall

The project runs Vercel's **Standard Protection**, so every preview URL — including the proxied `/__/auth/*` paths — is gated behind a Vercel session. The production host `gaycruisebingo.vercel.app` is unaffected and stays public.

In practice: sign in to `vercel.com` once in the browser you are testing with (Safari on the phone, most likely), then open the preview alias. The SSO round trip is automatic after that. Because the gate also covers the auth helper, load the preview page **first** and sign in to Google **second** — starting the OAuth flow in a browser with no Vercel session lands the popup on Vercel's login page instead of Firebase's handler, and the sign-in silently does nothing.

If a sign-in attempt fails oddly after a long idle, reload the preview URL to refresh the Vercel session and try again — an expired session mid-OAuth swallows the callback's query string.

## Part 4 — verifying it works

1. The alias loads the app (after the Vercel SSO round trip).
2. In the browser's network panel, the auth iframe request is to `https://gaycruisebingo-git-preview-…vercel.app/__/auth/iframe` — the **preview** origin, not `firebaseapp.com`. That is the same-origin guarantee from [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md); if it points at `firebaseapp.com`, step 2 or the `FIRST_PARTY_AUTH_HOSTS` entry in `src/auth-domain.ts` is wrong.
3. Google sign-in completes and the board deals.
4. On iOS Safari it completes as a **top-level redirect**, not a popup — that is the behavior the alias exists to let you test.

---

## The Five Across mirror

`fiveacross.vercel.app` is the Five Across backup host (#585): a **second Vercel project**, building this same repository and the same `main` branch, against the `fiveacross` Firebase project ([ADR 0008](../adr/0008-five-across-second-firebase-project.md)).

It exists because a Five Across Event served only from Firebase Hosting has no fallback if a venue network blocks that host. Gay Cruise Bingo already lived through exactly that — `gaycruisebingo.com` was SNI-blocked on Virgin Voyages' shipboard network while `*.vercel.app` stayed reachable, and the Vercel mirror was what players used mid-cruise. The [#599](https://github.com/nathanjohnpayne/gaycruisebingo/issues/599) pivot to `fiveacross.app` removes the *suspected* cause of that specific block (a `bingo` substring filter), but the mirror is not made redundant by it: it is independent CDN, certificate, and hostname class, so it also covers a Firebase Hosting or Cloudflare outage and any future filter the theory does not predict.

### Why this shape

**A separate Vercel project, not a branch on the existing one.** A branch URL on the `gaycruisebingo` project sits behind Vercel Standard Protection ([ADR 0007](../adr/0007-preview-auth-stable-vercel-alias.md) § Consequences, and Part 3 above) — a vercel.com login wall, which is disqualifying for a host players are meant to open on their phones. Only a *production* deployment is public, a project has exactly one production branch, and `gaycruisebingo`'s is already `main` serving the gcb env. So the mirror needs its own project.

**One `vercel.json` on `main`, not a mirror branch.** The repository's `/__/auth/:path*` rewrite targets `gaycruisebingo.firebaseapp.com`, which is the wrong Firebase project for a fiveacross build. That conflict is resolved by a **host-conditional rewrite** placed first in `vercel.json`:

```json
{
  "source": "/__/auth/:path*",
  "has": [{ "type": "host", "value": { "eq": "fiveacross.vercel.app" } }],
  "destination": "https://fiveacross.firebaseapp.com/__/auth/:path*"
}
```

Rewrites match in array order, so requests on the mirror host take this rule and every other host falls through to the unchanged Gay Cruise Bingo rule. The `{ eq }` object form is required: a bare string `value` is an unanchored regex to Vercel and would also match `fiveacross.vercel.app.evil.example`. Guarded by `src/vercel-auth-proxy.test.ts`; the reasoning lives in [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md).

The two alternatives the ticket floated were both worse. A **long-lived mirror branch** carrying its own `vercel.json` makes the backup host a permanent fork of `main` that has to be re-synced by hand — and a backup host quietly serving stale code is precisely the failure it exists to prevent, discovered at the worst possible moment. **Build-time templating** cannot work at all: Vercel reads `vercel.json` from the source before the build command runs, so a `vercel.json` written during the build is never read. (Generating `.vercel/output/config.json` via the Build Output API would work, but it means hand-rolling what the Vite framework preset does for free, on both projects.)

### Setup runbook

**Not yet done.** Steps 1–4 are Vercel dashboard work under Nathan's account and step 6 is console-only; an agent must not attempt them. Step 5 has an API path. Until all of it is done, `fiveacross.vercel.app` does not resolve, and the `FIRST_PARTY_AUTH_HOSTS` entry that ships with this document is inert — it can only affect a browser sitting on that exact hostname, which does not exist yet.

1. **Create the project.** Vercel dashboard → **Add New → Project** → import `nathanjohnpayne/gaycruisebingo` → **Project Name: `fiveacross`**. Framework preset **Vite**, build command `npm run build`, output `dist`, production branch `main`. (CLI equivalent: `vercel project add fiveacross`, then `vercel git connect` from a linked checkout — the dashboard flow is less fiddly and shows you step 2's answer immediately.)

2. **Confirm the minted production host is exactly `fiveacross.vercel.app`.** This is the load-bearing check of the whole runbook. Vercel assigns `<project>.vercel.app` when that subdomain is free and falls back to `<project>-<scope>.vercel.app` when it is not; `fiveacross.vercel.app` was unclaimed when this was written, but the `.vercel.app` namespace is global and shared with every other Vercel user. If Vercel mints anything else, **stop**: `vercel.json`'s `has` condition and `FIRST_PARTY_AUTH_HOSTS` in `src/auth-domain.ts` both hard-code this literal string, and a mismatch means the mirror's auth helper proxies to the wrong Firebase project. Fix the two constants in a follow-up PR before doing steps 5 and 6. (You can also add the alias explicitly under **Settings → Domains** if the project minted a longer default but the short name is free.)

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
   | `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | same as the primary Bodega build |

   `VITE_FIREBASE_AUTH_DOMAIN` is belt-and-braces — `resolveAuthDomain` pins the mirror host in code regardless of what the dashboard holds, deliberately, for the reason ADR 0007 § "The host is pinned in code" gives. Setting it correctly anyway keeps the dashboard from documenting a lie.

   `VITE_EVENT_ID` makes this a **single-Event build**: the bundle serves exactly the Bodega Event and never consults the `hostnames/{host}` lookup, which is what makes a `.vercel.app` host servable at all (ADR 0010's same-origin escape hatch, ADR 0009's build-mode switch). It is baked in at build time, so changing it later needs a redeploy, not just an edit. `VITE_EDITION` must be set together with it and must **match the primary build** — a mismatch ships the backup host under different branding and chrome than the host it is backing up.

4. **Turn off preview builds on this project.** Settings → Git → **Ignored Build Step**, command:

   ```bash
   [ "$VERCEL_ENV" != "production" ]
   ```

   Without this, every push to every branch builds twice across the two projects, and the mirror mints per-deployment hosts that can never sign in.

   **The exit codes are inverted from the intuitive reading**, and getting them backwards silently disables the mirror rather than the previews — the failure would only surface as "the backup host is serving last month's code", at the moment you need it. Vercel **skips** the build on exit `0` and **proceeds** on any non-zero exit. The command above therefore exits `0` (skip) on a preview and non-zero (build) on production, which is what you want. After saving, push something to `main` and confirm a production deployment actually runs.

5. **Firebase Auth authorized domains on `fiveacross`.** Console: **Firebase console (fiveacross project) → Authentication → Settings → Authorized domains → Add domain** → `fiveacross.vercel.app`. Scriptable, with a deploy credential for `fiveacross` active — read, append, write back:

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

   The field is **replaced, not merged**. A PATCH that drops `localhost`, `fiveacross.firebaseapp.com`, `fiveacross.web.app`, or the Bodega custom domain takes Five Across sign-in down with it — which is why the read-modify-write above never types the list by hand, and why the intermediate file is worth eyeballing.

6. **Google OAuth web client redirect URI — console only, human step.** There is no API for this. **Google Cloud console → the `fiveacross` project → APIs & Services → Credentials**, open the auto-created **Web client** (the one Firebase Auth uses on `fiveacross`; if the project has several OAuth clients, it is the auto-created "Web client" — check it against the `fiveacross` Firebase Auth Google provider's client id before editing), and add

   - **Authorized redirect URI**: `https://fiveacross.vercel.app/__/auth/handler`
   - **Authorized JavaScript origin**: `https://fiveacross.vercel.app`

   Google's propagation note applies: a `redirect_uri_mismatch` in the first few minutes after saving is not necessarily a mistake.

### Verifying the mirror

1. `https://fiveacross.vercel.app/` loads the Bodega Event — with **no** Vercel login wall (if you hit one, step 1 created a preview deployment, not a production one).
2. The auth iframe request in the network panel goes to `https://fiveacross.vercel.app/__/auth/iframe`, not to `fiveacross.firebaseapp.com`. If it points at `firebaseapp.com`, the `FIRST_PARTY_AUTH_HOSTS` entry or the `has` condition does not match the minted host.
3. Google sign-in completes in a fresh session (a private window, so no existing session masks a broken registration) and the board deals.
4. The board is the same Event the primary Bodega host serves — same Event id, same Edition chrome, same theme.

### Operating it

The mirror deploys **automatically on every push to `main`**; the primary Firebase Hosting deploy is manual (`scripts/deploy.sh`). So the mirror can be *ahead* of the primary, serving merged-but-not-yet-deployed code. That is usually harmless and occasionally not — before an event, deploy the primary first and treat the mirror as already current.

Add the mirror to the post-deploy check for Five Across: after any deploy that touches `src/**`, load `https://fiveacross.vercel.app/` once and confirm the app mounts, alongside the `SYNTHETIC_URL` check the primary host gets from `scripts/deploy.sh`. The mirror is not covered by that synthetic — it is a different deploy pipeline entirely.

Handing the mirror to players is a manual decision: it is a backup URL to give out when the primary host is unreachable, not a second address to advertise.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `DEPLOYMENT_NOT_FOUND` | No `preview` branch yet, or its last build failed. Check Vercel's deployments list. |
| Redirected to `vercel.com/login` | Expected — Part 3. Sign in to Vercel in that browser. |
| `auth/unauthorized-domain` | Part 1 step 2 not done, or the host was typed differently. |
| `redirect_uri_mismatch` | Part 1 step 3 not done, still propagating, or added to the wrong OAuth client. |
| "Unable to process request due to missing initial state" | The auth handler resolved cross-origin. The host is missing from `FIRST_PARTY_AUTH_HOSTS`, or `vercel.json`'s `/__/auth/:path*` rewrite lost its priority over the SPA catch-all. |
| Sign-in works but the board is someone else's | You are on the live event. Part 1 step 4 — and it needs a rebuild, not just an env-var edit. |
| Your change is missing but the build succeeded | A waiting service worker; the old precache is still serving. Use the Reload banner or pull-to-refresh, not a plain reload. |
| "This address is not open yet" on a `*.vercel.app` host | Expected on any per-deployment host — they can never sign in. Use the stable preview alias (Part 2). |
| The mirror serves the Gay Cruise Bingo event | The mirror project's Production env vars point at `gaycruisebingo`, or `VITE_EVENT_ID` was changed without a redeploy. Mirror runbook step 3. |
| The mirror's auth iframe loads from `gaycruisebingo.firebaseapp.com` | The minted host is not exactly `fiveacross.vercel.app`, so `vercel.json`'s `has` condition never matches. Mirror runbook step 2. |

## Not doing this at all

For a pure visual check — layout, type, theme, motion — `npm run dev -- --host` and the Mac's LAN address on the phone is cheaper than any of the above and needs no setup. It cannot cover sign-in: a raw LAN IP is neither a Firebase authorized domain nor a legal Google redirect URI. Reach for the preview alias when the thing you need to see is behind sign-in, or when sign-in itself is the thing you need to see.
