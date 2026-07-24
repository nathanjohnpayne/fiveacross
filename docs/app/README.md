# Gay Cruise Bingo — app guide (Phase 0)

> App-specific guide. Repo-wide conventions live in the root `README.md`, `AGENTS.md`, and `DEPLOYMENT.md`. Deploy auth follows this account's 1Password-backed model (`.ai_context.md` § Deploy Tooling) — there are **no committed service-account keys**, and deploys go through `op-firebase-deploy`, never `firebase login` / `firebase deploy` directly.

Live, multiplayer bingo PWA. React (Vite) + TypeScript + Firebase. Ships the pre-cruise MVP from the PRD: Google sign-in, a randomized card from a community-editable prompt pool, honor-system marking, BINGO/blackout detection, a leaderboard, all eight party themes, PWA install, GA4, and a static share image. The printed PDFs are the offline fallback.

Phase 1 backend features land as live updates during the sailing without reworking this — see [`phase-1-deploy.md`](phase-1-deploy.md). The private bug-report intake and manual LLM export workflow are documented in [`bug-reports.md`](bug-reports.md).

> **Live:** Hosting, Firestore and Storage rules, and selected Cloud Functions are deployed at **https://gaycruisebingo.web.app**. The event `events/med-2026` is seeded (honor mode, `neon-playground` theme, 80 prompts), and `gaycruisebingo.com` is registered with Hosting. See [`phase-1-deploy.md`](phase-1-deploy.md) for gated backend features and [`bug-reports.md`](bug-reports.md) for private report intake. Sections 1–6 below are the runbook to reproduce or re-run any of this.

## Stack

- **Vite + React 18 + TypeScript** (strict).
- **Firebase**: Auth (Google), Firestore (data), Storage (avatars/proofs), Analytics (GA4), Hosting.
- **vite-plugin-pwa** for installability.
- Phase 0 is **Cloud Functions-free** — each player writes their own stats and the leaderboard is a client-side sort. Stats stay client-authoritative in every phase (ADR 0001); Phase 1 adds moderation functions, not stat authority.

## 1. Firebase project (one-time — already done)

These one-time steps are complete on the `gaycruisebingo` project; recorded here for reference / rebuild.

1. **Web app** registered (`Project settings > General > Your apps`) — app id `1:849798007162:web:70dffafa77cc65a8306ec3`. Pull its config with `firebase apps:sdkconfig WEB` (see §2) rather than copying by hand.
2. **Google sign-in** enabled (`Authentication > Sign-in method > Google`).
3. **Firestore** `(default)` in `us-west1` (Native mode — permanent location). **Storage** default bucket `gaycruisebingo.firebasestorage.app` enabled.
4. **Blaze** plan enabled with a budget alert (required for the Phase-1 Functions/Cloud Run/Vision; Phase 0 itself stays within Spark limits).
5. **Authorized domains** (`Authentication > Settings > Authorized domains`) include `localhost`, `gaycruisebingo.firebaseapp.com`, `gaycruisebingo.web.app`, and `gaycruisebingo.com`.

## 2. Local env

`.env.local` holds the Firebase web-app config. These are **non-secret client identifiers** — they are baked into the client bundle by design, and security is enforced by the Firestore/Storage rules + Auth, not by hiding them. It is gitignored. Regenerate it any time from the registered web app instead of copying values by hand:

```bash
cp .env.example .env.local

# Fetch the live config (needs a deploy credential — see §5 for the SA key):
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcb-sa.json \
  firebase apps:sdkconfig WEB --project gaycruisebingo --non-interactive
```

Map the JSON fields into `.env.local`: `apiKey`→`VITE_FIREBASE_API_KEY`, `authDomain`→`VITE_FIREBASE_AUTH_DOMAIN` (**do not copy verbatim — override, see below**), `projectId`→`VITE_FIREBASE_PROJECT_ID`, `storageBucket`→`VITE_FIREBASE_STORAGE_BUCKET`, `messagingSenderId`→`VITE_FIREBASE_MESSAGING_SENDER_ID`, `appId`→`VITE_FIREBASE_APP_ID`, `measurementId`→`VITE_FIREBASE_MEASUREMENT_ID`. `VITE_EVENT_ID` defaults to `med-2026`; `VITE_RECAPTCHA_SITE_KEY` is Phase-1 (App Check) — leave it blank for Phase 0.

**`VITE_FIREBASE_AUTH_DOMAIN` must be a bare hostname (no `https://`): `gaycruisebingo.com` for the Firebase build and `gaycruisebingo.vercel.app` for the Vercel build.** At runtime the app pins known production hosts (`.com`, `.vercel.app`, and `.firebaseapp.com`) to their own first-party handler regardless of a stale build variable. A signed-out `.web.app` visitor is moved once to the same-project `.firebaseapp.com` app before sign-in because that Google callback is already authorized. Firebase serves the OAuth helper at `<authDomain>/__/auth/handler`; keeping it first-party prevents storage-partitioned browsers from losing the sign-in state. Mobile browser tabs and installed desktop PWAs use top-level redirect rather than a popup tab/window, which avoids iOS private-browsing window loss and desktop standalone windows where OAuth popups can be blocked or hidden. Installed mobile PWAs retain popup sign-in because their standalone app window has a stable opener.

## 3. Install & run

```bash
npm install
npm run dev        # local dev at http://localhost:5173
npm test           # game-logic unit tests
npm run typecheck  # tsc --noEmit
```

## 4. Seed the event + prompts

`scripts/seed.mjs` uses the Firebase Admin SDK (bypasses security rules), so it needs an admin credential and the **admin's Auth UID**. The admin UID is a signed-in user's Firebase Auth id, so the admin must sign in once at the deployed URL before their UID exists — there is no UID to seed against on a project where nobody has logged in yet.

**Get the admin UID** — read it straight from Auth (no manual copying). With a deploy credential active (see §5):

```bash
curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/projects/gaycruisebingo/accounts:query" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" -d '{"returnUserInfo":true}' \
  | jq -r '.userInfo[] | "\(.localId)  \(.email)"'
```

**Seed** — the Admin SDK needs `firebase-admin` plus a credential (ADC, or the Firebase-vault SA key as `serviceAccountKey.json`, which is gitignored and never committed — `seed.mjs` prefers the key file if present, else falls back to ADC):

```bash
npm i -D firebase-admin                 # or ephemeral: npm i --no-save firebase-admin

# credential — pick one:
gcloud auth application-default login    # ADC (no key file on disk), OR
op document get "gaycruisebingo — Firebase Deployer SA Key" \
  --vault Firebase --out-file serviceAccountKey.json

ADMIN_UID=<admin-uid> GOOGLE_CLOUD_PROJECT=gaycruisebingo node scripts/seed.mjs
rm -f serviceAccountKey.json             # don't leave the key on disk
```

This creates `events/med-2026` (honor claim-mode, `neon-playground` default theme, the admin uid) and the canonical **80-prompt pool** (24 spicy / 56 tame — see `specs/seed-and-composition.md`). It is idempotent and uses **replace semantics**: deterministic content-hash doc ids, and every seed-owned prompt the current pool no longer contains is deleted (player-submitted prompts, `createdBy !== 'seed'`, are preserved). So it is safe — and expected — to re-run to refresh prompts or add a new admin. The free center ("Complain about circuit music") is synthetic and not stored as an item. On success the seed **self-verifies** the live pool against the canonical list. See the header of `scripts/seed.mjs` for details.

> **⚠️ The prompt pool lives in Firestore, not in the deployed JS bundle** — the app renders `events/{id}/items`, which only this seed writes. Changing the pool in `src/data/seed.ts` / `scripts/seed.mjs` and deploying the app does **not** reach players: you must re-run the seed against the live project. A frontend change (e.g. the 🔞-toggle) ships with `npm run deploy:hosting`; a **pool** change additionally requires a reseed. This is exactly how the #129 87-prompt update reached players' cards late — the code merged and the bundle deployed, but the reseed was skipped. Whenever `ITEMS` changes, reseed, then confirm with the drift check:
>
> ```bash
> npm run verify:seed    # production-pinned, read-only; exit 1 on drift
> ```
>
> Run `verify:seed` as the last step of any deploy that touched the pool (and any time you suspect players are on a stale pool). It reads the live `events/{id}/items`, compares the seed-owned docs to the canonical `ITEMS`, and fails loudly — listing what is missing / stale — instead of the drift going unnoticed. The root install includes `firebase-admin`; the remaining prerequisite is a credential (ADC or the SA key). The npm command pins production, while direct `node scripts/seed.mjs --verify` calls may select another project/event with `GOOGLE_CLOUD_PROJECT` and `VITE_EVENT_ID`.

## 5. Deploy

Deploys go through `op-firebase-deploy` (1Password-backed — it resolves the project's Firebase-vault SA key and impersonates the deployer SA; never `firebase login` / `firebase deploy` directly). See the root `DEPLOYMENT.md`.

```bash
# 1. Security rules + indexes + Storage rules FIRST, so access is locked
#    before the app goes live. (Rules compile-check happens here — a bad
#    rule fails this step, not at runtime.)
op-firebase-deploy --only firestore:rules,firestore:indexes,storage

# 2. The app (build + hosting):
npm run deploy:hosting    # = vite build + op-firebase-deploy --only hosting
```

`op-firebase-deploy` re-resolves the SA key from 1Password on each run (a biometric prompt). To run several commands in one session without re-prompting — e.g. `apps:sdkconfig` in §2, then both deploys — materialize the key once and pass it explicitly (it is honored as the rank-1 credential):

```bash
op document get "gaycruisebingo — Firebase Deployer SA Key" \
  --vault Firebase --out-file /tmp/gcb-sa.json
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcb-sa.json op-firebase-deploy --only firestore:rules,firestore:indexes,storage
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcb-sa.json op-firebase-deploy --only hosting
rm -f /tmp/gcb-sa.json    # wipe the key when done
```

Phase 0 deploys rules/indexes/storage + hosting only. The Phase-1 backend (`functions`) deploys separately once Blaze features are live — see [`phase-1-deploy.md`](phase-1-deploy.md).

## 6. Custom domain (→ Firebase Hosting)

`gaycruisebingo.com` is registered as a Hosting custom domain and added to Auth's authorized domains. To wire (or re-wire) it, add these DNS records at the registrar — the values are Firebase's for this site:

| Type  | Host       | Value                         |
| ----- | ---------- | ----------------------------- |
| `A`   | `@` (apex) | `199.36.158.100`              |
| `TXT` | `@` (apex) | `hosting-site=gaycruisebingo` |

- **Remove** any conflicting apex `A`/`AAAA`/`CNAME` records.
- If DNS is proxied (Cloudflare orange-cloud), set both records to **DNS-only / unproxied** so Firebase can complete the ACME challenge and issue the SSL cert.
- Firebase then auto-verifies ownership (via the TXT) and issues SSL — usually minutes, up to ~24h. Once live, `gaycruisebingo.com` just mirrors `gaycruisebingo.web.app`.

The console path is `Hosting > Add custom domain`. To do it programmatically: `POST https://firebasehosting.googleapis.com/v1beta1/projects/gaycruisebingo/sites/gaycruisebingo/customDomains?customDomainId=gaycruisebingo.com`, then `GET …/customDomains/gaycruisebingo.com` and read `requiredDnsUpdates.desired[].records` for the exact records above. Sign-in on a custom domain also requires it in the authorized-domains list (`Authentication > Settings`, or Identity Toolkit `admin/v2/projects/gaycruisebingo/config`, field `authorizedDomains`) — already done for `gaycruisebingo.com`.

## 7. Vercel production mirror

The Vercel project serves the same Vite build at `gaycruisebingo.vercel.app`. Set its Production `VITE_FIREBASE_AUTH_DOMAIN` to `gaycruisebingo.vercel.app`. Do not use `gaycruisebingo.com` (it defeats the mirror during a custom-domain outage) or `gaycruisebingo.firebaseapp.com` (it reintroduces cross-origin auth storage and the intermittent "missing initial state" failure).

`vercel.json` rewrites `/__/auth/:path*` to the equivalent Firebase Hosting path. Vercel performs this as a transparent reverse proxy, so the Firebase helper is served while the browser remains on the Vercel origin; replacing it with a `301`/`302` redirect breaks the same-origin guarantee. Keep `gaycruisebingo.vercel.app` in Firebase Auth's authorized domains and keep `https://gaycruisebingo.vercel.app/__/auth/handler` in the Google OAuth web client's authorized redirect URIs.

This configuration is Vercel-only. Firebase Hosting builds continue to use `VITE_FIREBASE_AUTH_DOMAIN=gaycruisebingo.com`; direct `.firebaseapp.com` visits pin auth to that same origin, and signed-out `.web.app` visits hand off there before SignIn renders. Both hosting providers remain independently usable.

Vercel **preview** deploys get the same rewrites, but sign-in additionally needs the preview host in the two allowlists above — which only works if the host is stable. See [`preview-deploys.md`](preview-deploys.md) for the fixed preview alias, its one-time console setup, and how to push a branch onto it.

## 8. Configuration knobs

- **Claim mode** (`events/med-2026.claimMode`): `honor` (default) · `proof_required` · `verified`. The card UI adapts; `verified` marks are `pending` until confirmed (confirmation UI is Phase 1).
- **Default theme** (`defaultTheme`): any of the 8 theme ids in `src/theme/themes.ts`.
- **Admins** (`admins: string[]`): uids that can edit the event and moderate.
- **Event id**: `VITE_EVENT_ID` (defaults to `med-2026`). The schema is event-scoped, so future cruises are new event docs.

## Project structure

```
src/
  types.ts               # shared domain types (the one contract)
  firebase.ts            # SDK init (reads VITE_* env)
  analytics.ts           # GA4 track() helper
  game/logic.ts          # pure rules: deal, bingo/blackout, leaderboard sort
  game/logic.test.ts     # vitest unit tests
  data/{converters,paths,api,seed}.ts
  auth/AuthContext.tsx   # Google auth
  theme/{ThemeContext.tsx,themes.ts,themes.css}
  hooks/useData.ts       # real-time Firestore hooks
  components/            # SignIn, Nav, Board, Leaderboard, ItemPool, ThemeSwitcher, Celebration, Avatar, Admin, Proof*
firestore.rules · storage.rules · firestore.indexes.json
functions/               # Phase 1 Cloud Functions (Vision, thumbnails)
scripts/seed.mjs
```

## Trust & safety (Phase 0 baseline)

Public app with user-generated content, so even under minimal gating: a one-time 18+ acknowledgment on sign-in, a `report` action on prompts, admin hide/delete via rules, `noindex`, and Storage rules that cap type/size. Phase 1 adds Cloud Vision flagging (for illegal/extreme content, not raciness), App Check, and an admin console. Set a Firebase **budget alert** before enabling Blaze features.

## Known Phase 0 simplifications

- Stats are client-written (honor-system game). Trivially spoofable; that is the accepted ADR-0001 trade-off — they never move server-side (`recomputeStats` was removed as anti-cheat, #40).
- Boards are frozen at deal time; prompts added later feed _future_ deals only.
- OG image is static (`og-default.png`); there are no server-rendered per-share images — Share Cards are generated on-device instead (ADR 0005, #36).

## Phase 1 (scaffolded — see [`phase-1-deploy.md`](phase-1-deploy.md))

Phase 1 is scaffolded in this same repo and wired into the client: proof system (`ProofSheet` + live Proof Feed), admin console (`/admin`), verified mode, `functions/` (Vision moderation, thumbnails — stats stay client-authoritative, ADR 0001), and an App Check hook in `src/firebase.ts`. Backend deploy steps are in [`phase-1-deploy.md`](phase-1-deploy.md).

## Verified

`npm run typecheck` clean · `npm test` 10/10 passing · `npm run build` produces a PWA-enabled `dist/`. (Built against firebase 10.14.1, Vite 5, React 18, TypeScript 5.6.)
