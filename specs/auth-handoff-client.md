---
spec_id: auth-handoff-client
status: accepted
---

# The centralised-auth handoff, client half—mode selection, the transaction, and the three legs (`auth-handoff-client`)

Implements [ADR 0010](../docs/adr/0010-centralised-auth-origin-with-handoff.md) (#549, epic #530) against the server contract in [auth-handoff](auth-handoff.md) (#548, shipped). That document owns the wire: two callables, the `authHandoffs` collection, and the uniform rejection posture. This one owns everything in the browser—deciding which route sign-in takes, generating and keeping the transaction verifier, crossing the origin boundary twice, and reporting every way that can fail.

> **The validated target origin is the serving host sign-in began on, and the handoff returns the player to that same entry origin.** There is no canonicalisation step. #599 as amended removed edge canonicalization because a serving domain is never bounced off itself, and [ADR 0010](../docs/adr/0010-centralised-auth-origin-with-handoff.md) recorded the correction on 2026-08-05. Treat any surviving "canonicalise the alias" phrasing in older tickets or comments as stale.

## Glossary

**Direct sign-in**—the existing same-origin path (`AuthContext.signIn`, popup or redirect). Correct wherever the OAuth helper is already same-origin. *Avoid:* "same-origin mode", which names the env value rather than the route.

**Handoff**—leaving the Event origin for the central auth origin and returning with a code. The route ADR 0010 exists to create. *Avoid:* redirect, which already means the Firebase popup alternative on the direct path.

**Central auth origin**—the one exact registered origin Google sign-in actually happens at (`auth.fiveacross.app`, #547). *Avoid:* auth domain, which is the Firebase `authDomain` config value and a different thing.

**Entry origin / target origin**—the origin the player tapped Sign in on, and the only origin their handoff may return to. The same thing under two names because the server contract calls it `targetOrigin`.

**Transaction verifier**—the 256-bit secret generated at the entry origin and never disclosed. Its SHA-256 digest is the transaction id, which travels. Exactly PKCE's pair.

## Mode selection

`VITE_AUTH_MODE` selects, and `resolveSignInStrategy` (`src/auth/authMode.ts`) is its only consumer. It answers one question—which route sign-in takes from this origin—and both the pre-mount gate in `src/main.tsx` and the Sign in button in `src/components/SignIn.tsx` read the same answer, so the screen a player sees and the action the button takes can never disagree.

The ordering is load-bearing. `isSignInReachableOnHost` (`src/auth-domain.ts`) is consulted **first, before either mode branches**, because a host whose OAuth helper is already same-origin needs no handoff under either mode—`gaycruisebingo` is one registered origin that signs in same-origin and never mints a handoff, and the local and e2e origins must keep signing in against the Auth Emulator exactly as they do today. Reusing that predicate rather than restating it is deliberate: a second copy of "is the helper same-origin here" is a second thing to drift.

Only once that is false do the two modes differ at all, and that difference is the escape hatch's entire observable behaviour.

| Mode | Registered / local host | Unregistered Event host |
|---|---|---|
| `handoff` (default) | `direct` | `handoff`, via the central auth origin |
| `same_origin` | `direct` | `unavailable: same-origin-host-unregistered` |
| anything else | `unavailable: auth-mode-invalid` | `unavailable: auth-mode-invalid` |

**`handoff` is the default because the default has to be correct for the builds nobody hand-tunes.** A wildcard Event host cannot sign in any other way, and those are precisely the addresses self-service Event creation will mint.

**An unset value is the default; a misspelled one is not.** `VITE_AUTH_MODE=sameorigin` is rejected rather than read as "handoff, then". The moment that value is most likely typed is during an incident, which is exactly when nobody is positioned to notice it did nothing.

**`same_origin` refuses rather than falls back, even when a perfectly good central origin is configured.** That is the whole meaning of "no silent fallback between the two modes": the escape hatch is a deliberate operator instruction, and a handoff sitting ready must not quietly overrule it.

### The escape hatch is not a single switch

Selecting `same_origin` on a host works only where the OAuth helper is already same-origin, which needs **all** of: the hostname present in `FIRST_PARTY_AUTH_HOSTS` (`src/auth-domain.ts`) or a build baking `VITE_FIREBASE_AUTH_DOMAIN` equal to that host; the host registered in Firebase Auth's authorized domains; `https://<host>/__/auth/handler` registered on the Google OAuth web client; and `/__/auth/*` served same-origin there. The first is a code edit and a redeploy; the middle two are console-only. Choosing it anywhere else now reports `same-origin-host-unregistered` at mount instead of rendering the generic auth-unconfigured screen—which is the difference between an operator reading "sign-in is set to a mode this address cannot use" and reading "this address is not open yet" about a build they just configured.

## The central auth origin

`VITE_AUTH_HANDOFF_ORIGIN` names it. It must be a plain https origin with no path, query, fragment, port credentials, or trailing slash—enforced by comparing the input against `URL.origin`, which is a normalisation, so one comparison rejects every decoration at once with no list to keep current. Loopback over http is accepted so the flow can be stood up against emulators; the server's own origin policy independently refuses loopback unless it is running under an emulator, so that arm cannot widen production.

Absent or malformed in handoff mode on an unregistered host, sign-in reports `handoff-origin-unconfigured` / `handoff-origin-invalid` rather than dead-ending mid-flow. A value equal to the origin being served is also refused: a build that hands off to itself would bounce the player off themselves forever.

**Both keys are documented in `.env.example` as commented lines and must stay that way.** `scripts/build-target.mjs` requires every `VITE_*` key that file *defines* to be present in each target's env file, and `.env.gaycruisebingo` / `.env.fiveacross` are untracked operator-held state—so defining either key there hard-fails every build and deploy until a human edits both. That is the client-side twin of the `functions/.env.<projectId>` trap recorded in [auth-handoff](auth-handoff.md) (#767). Both are optional with in-code defaults, so leaving them commented costs nothing.

## The transaction verifier

`src/auth/handoffTransaction.ts`. A 256-bit value from `crypto.getRandomValues`, base64url-encoded to the same 43-character shape the server uses for the code and the digest. There is no `Math.random` fallback: it would produce a verifier that looks correct, redeems correctly, and is predictable, which is strictly worse than failing.

The published transaction id is `base64url(SHA-256(verifier))`, computed with WebCrypto and required to be byte-identical to the server's `transactionIdFor`. A padding or alphabet drift would not fail loudly—it would fail as "this sign-in link is no longer valid" on every handoff, indistinguishable from a dozen benign causes—so the two implementations are pinned against each other in a parity test rather than trusted to a comment.

**The verifier is written to both `sessionStorage` and `localStorage`, and read session-first.** `sessionStorage` is the narrower, correct-by-default home, but "the return lands in the tab that left" is not guaranteed: an installed PWA can hand a top-level navigation to the browser rather than the app window, and iOS Safari is already documented in this repo (`SIGNIN_ADULT_ACK_KEY`, `src/auth/AuthContext.tsx`) as dropping sessionStorage across a provider round trip while localStorage survives. A lost verifier is not a security failure; it is an unrecoverable dead end, because the code it was paired with is single-use and already spent by the time the loss is discovered. Neither store is assumed to exist—both are reached through `globalThis` with optional chaining, since a browser in private mode, and this repo's own jsdom test environment, can be missing one.

**The local TTL is deliberately looser than the server's, not tighter.** `HANDOFF_TRANSACTION_TTL_MS` is five minutes against the server's 120-second `HANDOFF_TTL_MS`. The server owns expiry and is the only clock that may reject a code for age; a tighter local window would discard the verifier for a code the server would still have honoured. A record stamped in the future is rejected too—the clock moved during the round trip, which makes the age unknowable rather than small.

## The three legs

### Leg 1—start, at the entry origin

`startAuthHandoff`, from the Sign in tap. Generate the verifier, compute the digest, store it, confirm it reads back, and only then navigate to `<authOrigin>/auth/handoff?target=<entry origin>&txn=<digest>&return=<path>`.

**Everything that can fail happens before the navigation, and that ordering is the point.** Discovering unavailable storage afterwards means discovering it once a code has been minted and spent. `returnPath` is the player's current location, so the handoff does not also lose their place.

Only the digest travels. The verifier appears nowhere in the URL, and neither does any token.

### Leg 2—mint, at the central auth origin

`src/auth/AuthHandoffOrigin.tsx`, mounted by `main.tsx` **instead of** the app when the current origin is this build's own configured auth origin and the path is `/auth/handoff`. The check sits ahead of Event resolution rather than inside it: `auth.fiveacross.app` has no `hostnames` document, so falling through would spend a network round trip only to render the not-found screen on the one origin every Event depends on for sign-in.

The page settles any redirect return, then asks the session directly—an existing session at this origin mints immediately and never shows Google at all. Otherwise it starts `signInWithRedirect`, and on return calls `mintAuthHandoff` and navigates to the returned `handoffUrl`.

**Always redirect, never popup, and this is the one place that is unconditionally right.** `AuthContext` chooses between them because it is protecting live app state and an installed-PWA window that loses its OAuth popup (#395, #347). This page has no state to lose—everything it needs is in its own query string, which survives the round trip in the address bar—and its OAuth helper is same-origin by construction, which is exactly the condition under which `AuthContext` itself calls redirect stable. So there is no UA sniffing here and no second copy of that decision to drift.

**The `handoffUrl` is navigated to verbatim, with `replace` rather than `assign`.** The server returns a URL rather than a code precisely so that no client ever assembles a redirect target; rebuilding or appending to it is what would reintroduce the open redirect. `replace` keeps a spent handoff URL from sitting one Back tap away.

Query parameters are validated for shape only. Whether `targetOrigin` is a registered Event address is the server's question, answered against the `hostnames` registry at mint time—**origin validation is not duplicated client-side**, per the server contract, because a second copy would only drift.

### Leg 3—complete, back at the entry origin

Run by `main.tsx` before the app mounts, when `window.location.hash` carries a code. Pre-mount because the session must exist by the time `onAuthStateChanged` first settles; completing it inside the tree would render the signed-out gate and then flip it out from under the player.

The fragment is cleared first, unconditionally, with `history.replaceState`—no navigation, no new history entry. Then the stored transaction is read, the entry origin is confirmed to match, and `exchangeAuthHandoff` is called with the code, the verifier, and this origin. The returned custom token goes straight to `signInWithCustomToken`.

**The verifier is deleted on every terminal path, success included**, and before the sign-in rather than after: it has done its only job the moment the exchange returns, and the code it was paired with is spent either way. That also means the client cannot replay a handoff even if asked to—there is nothing left to replay it with.

**Nothing here retries.** The code is single-use and spent by the time anything can fail, so a retry could only fail again.

## Failure states

Every failure is named, and none of them falls back to the other mode.

| Where | Reason | Surfaced as |
|---|---|---|
| Mount gate | `same-origin-host-unregistered` | `EventNotFound reason="auth-same-origin-unavailable"` |
| Mount gate | `auth-mode-invalid`, `handoff-origin-unconfigured`, `handoff-origin-invalid` | `EventNotFound reason="auth-handoff-misconfigured"` |
| Start leg | `start-failed` (no entropy, or no store would hold the verifier) | Inline message on the Sign in screen |
| Return leg | `transaction-missing`, `origin-mismatch`, `exchange-rejected`, `sign-in-failed` | Inline message on the Sign in screen |
| Central origin | bad request, sign-in failed, mint failed | The bounce page's own error copy |

The return-leg reasons are deliberately **coarser** than the set of things that can go wrong, because the server answers every exchange rejection identically on purpose—expired, already used, wrong origin, and never-existed are one `permission-denied` so a caller cannot learn whether a guessed code was ever real. Inventing finer client-side reasons would either be a lie or would leak the distinction the server just spent effort hiding. All of them reach the player as one sentence, because the player's next move is identical in every case.

The two mount-gate rows are separate reasons rather than folded into the existing `auth-unconfigured` because a different person fixes each: `auth-unconfigured` means nobody finished provisioning this address, while these two mean this build was told to sign in a way that cannot work here.

## Wire parity

Three things are mirrored from `functions/src/authHandoff.ts` rather than imported—the client cannot import it, because it is a different TypeScript program and pulls in `node:crypto`:

- `HANDOFF_FRAGMENT_KEY` (`fa_handoff`)
- `HANDOFF_TOKEN_PATTERN` (`/^[A-Za-z0-9_-]{43}$/`)
- the transaction-id digest

All three are pinned by a parity test that imports both sides, the same shape `src/data/w4-bug-report-contract-parity.test.ts` uses for the bug-report contract.

## Acceptance criteria

- **Given** an unset `VITE_AUTH_MODE` on an unregistered Event host, **when** sign-in is resolved, **then** the handoff route is chosen. (Test: handoff-is-default.)
- **Given** any mode on a registered, local, or `web.app` host, **when** sign-in is resolved, **then** the existing direct path is chosen and nothing changes. (Test: direct-hosts-unchanged.)
- **Given** `VITE_AUTH_MODE=same_origin` on an unregistered host, **when** sign-in is resolved, **then** it is `unavailable` by name and renders its own screen, never the generic auth-unconfigured one, and never silently takes the handoff. (Test: escape-hatch-loud.)
- **Given** an unrecognised `VITE_AUTH_MODE`, **when** sign-in is resolved, **then** it is rejected rather than defaulted. (Test: mode-invalid.)
- **Given** handoff mode and no usable central origin, **when** sign-in is resolved, **then** it is `unavailable` rather than dead-ending mid-flow. (Test: handoff-origin-missing, handoff-origin-malformed.)
- **Given** a sign-in start, **then** the verifier is stored and only its digest appears in the URL, and no token appears at all. (Test: start-publishes-digest-only.)
- **Given** storage that refuses every write, **when** a handoff starts, **then** it does not navigate. (Test: start-aborts-without-storage.)
- **Given** a client and the server, **when** both compute a transaction id for the same verifier, **then** the results are byte-identical. (Test: digest-parity.)
- **Given** a return with a valid code and a matching verifier, **when** the handoff completes, **then** the custom token signs the player in and the verifier is deleted. (Test: complete-happy, verifier-cleared-on-success.)
- **Given** a return whose verifier is missing or whose origin does not match, **when** the handoff completes, **then** it fails by name without sending the verifier anywhere. (Test: transaction-missing, origin-mismatch.)
- **Given** a rejected exchange or a rejected custom token, **when** the handoff completes, **then** it fails by name, retries nothing, and leaves no verifier behind. (Test: exchange-rejected, sign-in-failed.)
- **Given** a code presented in a query string rather than a fragment, **when** the return leg reads it, **then** it is ignored. (Test: fragment-only.)

## Test coverage

All in the app layer (`npm test`, jsdom—no emulator).

- `src/auth/authMode.test.ts`—the mode/strategy decision table, including every `unavailable` arm and the guarantee that an unregistered host never resolves to `direct`.
- `src/auth/handoffTransaction.test.ts`—verifier generation, base64url, the dual-store durability and clearing, and every malformed-record and TTL rejection.
- `src/auth/handoffClient.test.ts`—fragment reading and clearing, the central-origin URL, request parsing, the start leg, and the failure channel.
- `src/auth/handoffExchange.test.ts`—the two callable legs: mint returning the server URL untouched and never sending a uid, and complete's happy path plus every named failure.
- `src/auth/AuthHandoffOrigin.test.tsx`—the central-origin bounce page: minting straight away for an existing session, redirecting when there is none, navigating to the server URL verbatim, and refusing a malformed request.
- `src/components/event-not-found-auth-reasons.test.tsx`—the two new mount-gate screens and their operator notes.
- `src/components/signin-handoff-route.test.tsx`—that the Sign in button actually reads the strategy: it starts a handoff where one is needed, never falls back to direct sign-in when the route is unavailable, and surfaces a return leg that failed before the tree mounted.
- `src/auth/handoff-parity.test.ts`—the three mirrored constants and the digest, against `functions/src/authHandoff.ts` directly.
- `src/auth-domain.test.ts`—the central auth origin's presence in `FIRST_PARTY_AUTH_HOSTS`.

Mapped explicitly in `.repo-template.yml` `spec_test_map`, because the coverage is module-named rather than spec-basename-named.

## Not in scope

- **Provisioning `auth.fiveacross.app` (#547).** Firebase Auth authorized domains and the Google OAuth web client are console-only. Until that lands, the `FIRST_PARTY_AUTH_HOSTS` entry pins an `authDomain` Google will reject, so the handoff cannot carry real traffic.
- **The `fiveacross` invoker reconciliation.** `skipInvokerReconcile: true` (`scripts/build-target.mjs`) leaves both callables 403ing on that project. Flipping it needs `run.services.update` granted to the `fiveacross` deploy service account—an IAM action no code change can make. Recorded in [auth-handoff](auth-handoff.md).
- **Enabling `AUTH_HANDOFF_APP_CHECK`.** The client already initialises App Check when `VITE_RECAPTCHA_SITE_KEY` is set, so attestation rides along automatically; turning the server param on is a deploy-time decision that also needs the key present in the untracked `functions/.env.<projectId>` files.
- **Carrying the 18+ acknowledgement across the handoff.** A handoff return signs in with a custom token, so `AuthContext`'s acknowledgement record—consumed by its `getRedirectResult` effect—is discarded unused, and a returning player meets the existing 18+ re-prompt instead. That is one extra tap, and it is the direction this must fail in: fabricating a durable cross-Event `attestedAdultAt` for a checkbox nobody saw would be the genuinely bad outcome. Threading it properly means touching `AuthContext`'s private acknowledgement helpers, which #765 is actively rewriting.
- **The Firestore TTL policy on `authHandoffs.expiresAt`.** Server-side, and already recorded in [auth-handoff](auth-handoff.md).
