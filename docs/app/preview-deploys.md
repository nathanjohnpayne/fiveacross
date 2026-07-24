# Preview deploys — signing in on a branch before it merges

Runbook for the decision in [`docs/adr/0007-preview-auth-stable-vercel-alias.md`](../adr/0007-preview-auth-stable-vercel-alias.md): previews are served from **one fixed hostname**, so Google sign-in can be registered for it once instead of once per deployment.

The preview alias is:

```
gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app
```

It is the Vercel branch URL of a dedicated `preview` branch, and it always serves that branch's most recent deployment.

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

## Not doing this at all

For a pure visual check — layout, type, theme, motion — `npm run dev -- --host` and the Mac's LAN address on the phone is cheaper than any of the above and needs no setup. It cannot cover sign-in: a raw LAN IP is neither a Firebase authorized domain nor a legal Google redirect URI. Reach for the preview alias when the thing you need to see is behind sign-in, or when sign-in itself is the thing you need to see.
