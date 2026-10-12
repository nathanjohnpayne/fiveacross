---
spec_id: w4-app-check
status: accepted
tested: false
reason: App Check is a provisioned, break-glass operational control; console registration, deployed-browser exchange and enforcement readback establish it, and source tests cannot prove live App Check configuration.
---

# App Check: provisioned, break-glass only

Ticket #44 adds abuse protection for Cloud Firestore and Cloud Storage. It does not change Membership authority, honor-system Marks or reactive moderation. App Check attests the calling app; it does not authorize a Player's Mark.

**Owner decision (2026-10-12, [recorded on #44](https://github.com/nathanjohnpayne/fiveacross/issues/44#issuecomment-6116613038)):** App Check is a **break-glass control**. Both Firebase projects keep it provisioned and registered, but shipped bundles carry no site key and neither service is enforced in routine operation. It is switched on only for an active abuse incident and switched off when the incident ends. This supersedes the routine monitor-then-enforce rollout this spec originally described, and the deferral in [#44's timing decision](https://github.com/nathanjohnpayne/fiveacross/issues/44#issuecomment-4919347400).

## Why it is not on routinely

`src/firebaseCore.ts` initializes `ReCaptchaEnterpriseProvider` only when `VITE_RECAPTCHA_SITE_KEY` is nonempty. Once it does, Firestore waits for an App Check token before its first RPC, and minting that token first runs reCAPTCHA in the page. The measurements below were taken on 2026-10-12 with both keys deployed to production, on cold loads with no cached token:

| Host | First Firestore RPC |
|---|---|
| `bodega-bay.fiveacross.app` | 3.6s, behind a 3.4s App Check exchange |
| `gaycruisebingo.com` | 7.6s and 10s; on two loads Firestore never connected until reCAPTCHA was triggered by hand |
| Either host, no site key | about 0.2s |

A slow or blocked `google.com/recaptcha`, as on ship networks or behind ad blockers, therefore gates the whole data layer. That cost is not justified by monitoring metrics alone, and enforcement adds false rejections for players who cannot attest or score below `minValidScore`. A score-based key never shows a visible challenge, so the cost is latency and false rejection, not friction. Both projects were rolled back to key-free builds the same day.

## Provisioned state

| | `fiveacross` | `gaycruisebingo` |
|---|---|---|
| Serves | `fiveacross.app` and `vacaybingo.com` hosts, `fiveacross.vercel.app`, `vacaybingo.vercel.app` | `gaycruisebingo.com`, `gaycruisebingo.vercel.app` |
| reCAPTCHA Enterprise key | Score-based Website key "Five Across"; site key in 1Password item `oslqrargfw57urqiy4tsz3bir4` | Score-based Website key "Gay Cruise Bingo"; site key in 1Password item `uooosjdc6mqd27k46likrlaktm` |
| Allowed domains | `fiveacross.app`, `vacaybingo.com`, `fiveacross.web.app`, `fiveacross.firebaseapp.com`, `fiveacross.vercel.app`, `vacaybingo.vercel.app` | `gaycruisebingo.com`, `gaycruisebingo.web.app`, `gaycruisebingo.firebaseapp.com`, `gaycruisebingo.vercel.app` |
| App Check registration | Web app `1:5297095641:web:aff3537cf7c95dec220fc8`, reCAPTCHA Enterprise provider, token TTL 1h, `minValidScore` 0.5 | Web app `1:849798007162:web:70dffafa77cc65a8306ec3`, same settings |
| Routine state | No site key in `.env.fiveacross` or either mirror's Vercel Production env; Firestore and Storage unenforced | No site key in `.env.gaycruisebingo` or the mirror's Vercel Production env; Firestore and Storage unenforced |

Allowed domains cover subdomains implicitly, so a new Event on `*.fiveacross.app` or `*.vacaybingo.com` needs no key change; a new apex does. Changing a key needs an owner credential with reCAPTCHA Enterprise admin rights. The per-project `firebase-deployer` service accounts can read and update App Check configuration and enforcement, but cannot list, create or edit reCAPTCHA keys or enable APIs. Keep domain validation on and do not add `localhost`. Local development leaves the site key empty, so App Check never initializes there. The client has no debug-provider wiring, so exercising enforcement from `localhost` would first need a dev-only `FIREBASE_APPCHECK_DEBUG_TOKEN` path, which is out of scope here. The "Five Across" key also has a legacy secret key (1Password item `7slecmeueq2t5nvm2gslcr4whi`); the Enterprise provider never uses it, and it must never enter a bundle or a Vercel env.

On 2026-10-12, before the rollback, a deployed browser on each project loaded reCAPTCHA, `exchangeRecaptchaEnterpriseToken` returned 200 and Firestore succeeded. That is the end-to-end proof that the provisioned state works. Re-read the table above against the live consoles before relying on it in an incident.

## Switching it on

Use this only for an active abuse incident on Firestore or Storage. Act per project: a project's App Check registration does not attest the other project's web app.

1. **Bundle.** Copy the project's site key from 1Password into `VITE_RECAPTCHA_SITE_KEY` in `.env.fiveacross` or `.env.gaycruisebingo`. Named production builds ignore `.env.local`. Before deploying, merge a one-line change to `main` that raises `public/build-floor.json`'s `floor` to the current time ([`app-update-reload-prompt`](app-update-reload-prompt.md)). Otherwise installed and long-lived shells keep running the key-free bundle, can decline the update indefinitely, and would be locked out by step 4. Then, from a clean, current `main`, run the guarded hosting deploy for that target (`npm run deploy:<target>:hosting`; see [the deployment process](../docs/agents/deployment-process.md)).
2. **Mirrors.** Add `VITE_RECAPTCHA_SITE_KEY` to each of that project's Vercel mirrors' Production env as type **Config** (the site key is public by design), then redeploy each mirror with the guarded block in [`deploy-targets.md` § Deploying a mirror](../docs/app/deploy-targets.md#deploying-a-mirror). Every serving host must carry the key before step 4, or enforcement locks that host out.
3. **Attest.** Load every serving host in a browser and confirm `exchangeRecaptchaEnterpriseToken` returns 200. On the Firebase Hosting hosts and on `gaycruisebingo.vercel.app`, a registered auth host, also confirm that sign-in, a Firestore read/write and a Storage upload/download still work. The Five Across mirrors (`fiveacross.vercel.app`, `vacaybingo.vercel.app`) cannot sign in yet ([`deploy-targets.md`](../docs/app/deploy-targets.md#deploying-a-mirror)). They are `VITE_EVENT_ID`-pinned and may issue no Firestore request while signed out, so on them run an explicit Firestore SDK read of a public document from the page and confirm it succeeds. Do not record App Check or Auth tokens. Then watch Firebase console → App Check request metrics until verified traffic dominates and outdated-client traffic has drained after the floor raise. Stale shells that are still unverified will be rejected in step 4.
4. **Enforce.** Firebase console → App Check → enforce Cloud Firestore. Read back the enforced state, then repeat the step 3 checks. Expect a 3–10s first-load delay and some lockouts for players whose network blocks reCAPTCHA. **Do not enforce Cloud Storage** until a rehearsal proves media still loads under enforcement. Proof photos and audio (`src/components/ProofFeed.tsx`) and custom avatars (`src/components/Avatar.tsx`) load through plain `<img>`/`<audio>` download URLs, and the service worker forwards them unchanged (`src/sw.ts`). Those requests carry no App Check header, so Storage enforcement may break every proof and avatar even on an attested page.
5. **Confirm the block.** For each enforced service separately, send an otherwise-authorized request without an App Check token, for example a Firestore read for Cloud Firestore. It should be rejected by App Check, not by Security Rules. A rejection from one service proves nothing about another.

## Standing down

When the incident ends:

1. Unenforce Firestore and Storage in the App Check console and read the state back.
2. Clear `VITE_RECAPTCHA_SITE_KEY` in the target env file and remove it from each mirror's Vercel Production env.
3. Merge a one-line change to `main` that raises `public/build-floor.json`'s `floor` to the current time, so installed shells leave the key-bearing bundle and its first-load delay. Then deploy a newly built key-free hosting release from that `main`. A Hosting rollback cannot carry the new floor, because it re-serves an older immutable release.
4. Rebuild each mirror from that same revision. Do not use `vercel rollback` for mirrors: it turns off production-domain auto-assignment, so a later `vercel deploy --prod` silently stops updating the mirror.
5. Confirm in a browser that no host loads reCAPTCHA and that Firestore starts promptly.

Keep the keys and registrations in place for the next incident.

## Boundaries

- The edge Event router must keep working whenever enforcement is on and must never require it to be off ([ADR 0014](../docs/adr/0014-app-check-compatible-edge-routing-registry.md)). Its R3 gate rehearses that compatibility with a temporary switch-on rather than waiting for permanent enforcement ([`event-router-registry`](event-router-registry.md)).
- Callable-level App Check policy is [#1892](https://github.com/nathanjohnpayne/fiveacross/issues/1892). `AUTH_HANDOFF_APP_CHECK`, `BUG_REPORT_APP_CHECK`, `APPROVE_PROMPTS_APP_CHECK` and `SUBMIT_PROMPT_APP_CHECK` must stay `false` while routine builds are key-free. A callable flag that is on without a client key rejects every request, and `AUTH_HANDOFF_APP_CHECK` would break sign-in on every handoff-mode host. Neither the switch-on nor the stand-down procedure changes them unless #1892 adds that step. This spec also does not satisfy #1411's attended two-account device acceptance.
- The private memory app receives the primary App Check token through its custom provider (`src/privateFirestore.ts`), so it attests automatically whenever the primary app does.
- Initializing App Check without making Firestore's first RPC wait on reCAPTCHA would make routine monitoring affordable. That would be a client change, outside this spec.
