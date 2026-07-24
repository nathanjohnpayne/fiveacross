---
status: accepted
---

# Preview deploys sign in on one stable Vercel alias, not on per-deployment hosts

A Vercel preview is served from a host minted per commit — `gaycruisebingo-<hash>-nathanjohnpaynes-projects.vercel.app` — and Google sign-in cannot work there. Firebase Authentication's authorized-domains list and the Google OAuth web client's authorized redirect URIs both match an **exact** host, and neither accepts a wildcard: Google's OAuth client validation rejects `*` in a redirect URI outright and requires the runtime `redirect_uri` to match a registered value exactly. No pattern can cover a hostname that changes on every push. The cost of that, seen on [#451](https://github.com/nathanjohnpayne/gaycruisebingo/issues/451)/[#452](https://github.com/nathanjohnpayne/gaycruisebingo/pull/452), is that an iOS-only visual bug whose entire acceptance gate is "look at it on a real device" has to be merged and deployed to production before anybody can look at it.

**Decision: give previews one fixed hostname and register that single host everywhere sign-in needs it.** The fixed hostname is the Vercel *branch URL* of a dedicated, long-lived `preview` branch:

```
gaycruisebingo-git-preview-nathanjohnpaynes-projects.vercel.app
```

Vercel mints `<project>-git-<branch>-<scope>.vercel.app` per branch, and that URL "will always show you the most recent changes for the branch and won't change if you push new commits to the branch." So the host is stable while the deployment behind it is not — exactly the property the three allowlists need. To preview any branch, push it onto `preview`:

```bash
git push --force origin HEAD:preview
```

The console half of the setup is human-only and is written up as numbered steps in [`docs/app/preview-deploys.md`](../app/preview-deploys.md). **Until a human completes that runbook, sign-in on the preview alias stays broken** — the code change that ships with this ADR is necessary but not sufficient.

## Why this host

- **The same-origin `/__/auth/*` proxy already works on it.** `vercel.json`'s rewrites apply to every deployment of the project, previews included, so the helper namespace is already reverse-proxied to `gaycruisebingo.firebaseapp.com` while the browser stays on the preview origin. That is the guarantee [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md) exists to protect, and nothing about this decision touches it. What was missing on a preview host was never the proxy — it was the three registrations.
- **`.vercel.app` over `preview.gaycruisebingo.com`.** A custom subdomain would also work and is deterministic, but it needs DNS plus a certificate, and `gaycruisebingo.com` is SNI-blocked on Virgin Voyages' shipboard network while `*.vercel.app` is not. The whole point of a preview is looking at the app on a real device, sometimes at sea, so the more reachable host wins. Revisit only if `.vercel.app` ever becomes the blocked one.
- **It fits inside Vercel's truncation limit.** Generated URLs are truncated past 63 characters before the suffix. `gaycruisebingo-git-` plus `-nathanjohnpaynes-projects` is 45 characters, leaving an 18-character branch-name budget; `preview` (7) lands at 52. This is also what disqualifies option B below.
- **The host is pinned in code, not in an environment variable.** `resolveAuthDomain` in `src/auth-domain.ts` now returns the preview alias for itself, the same way it does for the three production hosts, so the auth handler is same-origin regardless of what the Vercel Preview environment has `VITE_FIREBASE_AUTH_DOMAIN` set to. A Preview-scoped env var would achieve the same thing and be one less line of code, but it would be silently wrong the moment somebody edits it in the dashboard, and it is untestable from the repo. The code path is guarded by `src/auth-domain.test.ts`.

## Options considered and rejected

| Option | Verdict |
|---|---|
| **A. Stable preview alias** | **Chosen.** One host, three one-time registrations, works for any branch. |
| B. Deterministic per-branch URLs | Rejected — see below. |
| C. Preview-only auth path (emulator / dev sign-in) | Rejected — see below. |
| D. Previews with no real auth (seeded read-only boot) | Rejected as the primary; a narrower substitute is kept. |
| E. Firebase Hosting preview channels | Rejected — see below. |

**B. Deterministic per-branch URLs.** Vercel already mints a branch URL for every branch, so in principle each feature branch could be registered on demand. Two things kill it. The 18-character branch-name budget above is smaller than the names this repo actually uses (`docs-preview-auth-decision` is 26 and would be truncated into something unpredictable), so the host often cannot even be derived ahead of time. And the registration is per branch: Firebase's authorized domains can at least be scripted (Identity Platform `projects.updateConfig`, field `authorizedDomains` — the app guide already documents that path), but the Google OAuth redirect URI genuinely has no API and would be a console visit per branch, on branches that live for hours. Option A pays that cost once.

**C. A preview-only auth path.** Pointing previews at the Auth emulator or shipping a dev sign-in gated to non-production builds removes the allowlist problem entirely. It is not rejected because the security bar is unreachable: Vercel exposes the environment at build time, so a `VITE_*` constant scoped to the Preview environment is statically substituted by Vite and dead-code-eliminated from the production bundle, which is the same standard the `import.meta.env.MODE === 'e2e'` + `demo-` project-id gate in `src/firebase.ts` meets, verifiable by the same `dist/` grep. It is rejected on cost and on **fidelity**. Cost: a second sign-in path, a seeded fake user, and a permanent obligation to re-prove the bypass is absent from every release, forever. Fidelity: the bug class that motivated this ticket is sign-in-adjacent — the redirect-versus-popup matrix on iOS Safari and installed PWAs that [`specs/vercel-auth-proxy.md`](../../specs/vercel-auth-proxy.md) pins — and a fake sign-in path cannot reproduce it by construction. Also the Auth emulator listens on `127.0.0.1` and is not reachable from Vercel's edge at all, so "point previews at the emulator" would mean hosting one publicly, which is worse than the problem. Option A costs an afternoon of console clicks and keeps full production fidelity. C stays on the shelf as the fallback if console access is ever unavailable.

**D. Previews with no real auth.** Booting a preview into a seeded read-only state is *more* work than option A (it needs a read-only mode plus fixtures) and answers fewer questions, because most of this app is behind sign-in — including the nav bar whose iOS behavior started this. Rejected as the primary. Its cheap cousin is kept and is worth trying first for pure visual work: `npm run dev -- --host` and open the Mac's LAN address on the phone. That covers layout, type, theme, and motion with zero infrastructure; it cannot cover sign-in, because a raw LAN IP is neither a Firebase authorized domain nor a legal Google redirect URI. The emulator-backed `--mode e2e` build would cover sign-in on the LAN too, except `src/firebase.ts` hard-codes the emulator hosts to `127.0.0.1`, which a phone cannot resolve — worth a follow-up if LAN previewing becomes the common path.

**E. Firebase Hosting preview channels.** The obvious alternative, and it has one real advantage: `firebase hosting:channel:deploy` registers the channel URL in Firebase Auth's authorized domains for you. It still loses. The channel host carries a random hash (`gaycruisebingo--<channel>-<hash>.web.app`), so the Google OAuth redirect URI for `https://<channel-host>/__/auth/handler` is still a manual console entry, per channel — the harder half of the problem is untouched. Channels also expire (7 days by default, 30 at most), so the hash churns on a timer. And it moves previewing off Vercel, away from the `vercel.json` proxy topology that production actually runs, which is the topology a preview should be exercising.

## Consequences

- **One preview at a time.** `preview` holds one branch. Two lanes wanting a device check must take turns, or a second slot can be added later by registering `preview2` the same way — the branch-name budget has room and nothing about the design is single-slot.
- **`preview` is force-pushed and disposable.** It is never merged from and never merged into. It must not be branch-protected, and nothing may depend on its history.
- **Previews write to the live event.** A preview build uses the Preview environment's `VITE_FIREBASE_*`, which today point at the production Firebase project, so marks and Moments made while testing land in the real `med-2026` event. That is already true of any preview anyone opens today; this decision makes it likelier to happen. If it becomes a nuisance, set `VITE_EVENT_ID` on the Preview environment to a throwaway event id — the schema is event-scoped by design.
- **Vercel Authentication still gates the preview.** The project runs Standard Protection, so every preview URL — including the `/__/auth/*` paths — redirects to `vercel.com/login` for a browser without a Vercel session. This is compatible with sign-in (load the preview once to establish the session, then sign in), but it is a second wall the runbook has to name, and a Vercel session that expires mid-OAuth produces a confusing failure. Making a single preview domain public without disabling protection wholesale is a $150/month Pro add-on (Deployment Protection Exceptions), which is not worth it here.
- **Production sign-in is untouched.** The three production hosts, the redirect-versus-popup matrix, and the `/__/auth/*` rewrite order are all unchanged; the only code delta is one additional entry in `FIRST_PARTY_AUTH_HOSTS`, which can only affect a browser sitting on that exact preview hostname.
