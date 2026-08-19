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

**Both keys are documented in `.env.example` as commented lines and must stay that way.** `scripts/build-target.mjs` requires every `VITE_*` key that file *defines* to be present in each target's env file, and `.env.gaycruisebingo` / `.env.fiveacross` are untracked operator-held state—so defining either key there would hard-fail every build target, including Gay Cruise Bingo, until a human edited both files. That is the client-side twin of the `functions/.env.<projectId>` trap recorded in [auth-handoff](auth-handoff.md) (#767). `VITE_AUTH_MODE` remains optional with the safe `handoff` default for ordinary builds. The registered `fiveacross` production target explicitly pins both `VITE_AUTH_MODE=handoff` and `VITE_AUTH_HANDOFF_ORIGIN=https://auth.fiveacross.app` in its trusted identity, so stale incident escape-hatch state or an absent/different central origin fails the target build while the single-origin Gay Cruise Bingo target correctly requires neither.

## The transaction verifier

`src/auth/handoffTransaction.ts`. A 256-bit value from `crypto.getRandomValues`, base64url-encoded to the same 43-character shape the server uses for the code and the digest. There is no `Math.random` fallback: it would produce a verifier that looks correct, redeems correctly, and is predictable, which is strictly worse than failing.

The published transaction id is `base64url(SHA-256(verifier))`, computed with WebCrypto and required to be byte-identical to the server's `transactionIdFor`. A padding or alphabet drift would not fail loudly—it would fail as "this sign-in link is no longer valid" on every handoff, indistinguishable from a dozen benign causes—so the two implementations are pinned against each other in a parity test rather than trusted to a comment.

**The stores are reached through a guarded accessor, never named directly at a call site.** Reading `globalThis.sessionStorage` is not a safe property access: in privacy-restricted browsers and some embedded contexts the getter itself throws `SecurityError`, and evaluated as a call argument that throw escapes before the helper's own `try` can run—so the fallback store never gets a turn and the start leg rejects instead of reporting `start-failed`.

**A write is confirmed by reading back the record that was just written, not merely a record.** An abandoned, still-in-TTL transaction is readable, so the previous one is cleared first and the confirmation compares verifiers. Otherwise a write that fails in the session-first store while succeeding in the other would navigate with the new digest while the return leg reads the old verifier—every exchange rejected as a transaction mismatch, with neither side looking broken. The same record carries whether this exact tap actually collected the Event's 18+ acknowledgement. Only literal `true` is evidence; a legacy record with no field, a no-checkbox Event, or any other value reads as false.

**Each store is parsed and validated in priority order, and absent, malformed, and expired all fall through.** Falling back only when the session copy is *absent* let a damaged or stale session copy mask a perfectly good local one, which defeats the dual-store recovery in exactly the situation it exists for.

**The verifier is written to both `sessionStorage` and `localStorage`, and read session-first.** `sessionStorage` is the narrower, correct-by-default home, but "the return lands in the tab that left" is not guaranteed: an installed PWA can hand a top-level navigation to the browser rather than the app window, and iOS Safari is already documented in this repo (`SIGNIN_ADULT_ACK_KEY`, `src/auth/AuthContext.tsx`) as dropping sessionStorage across a provider round trip while localStorage survives. A lost verifier is not a security failure; it is an unrecoverable dead end, because the code it was paired with is single-use and already spent by the time the loss is discovered. Neither store is assumed to exist—both are reached through `globalThis` with optional chaining, since a browser in private mode, and this repo's own jsdom test environment, can be missing one.

**The two TTLs start on different legs, so "looser than the server" is not a coherent justification.** The server's 120-second `HANDOFF_TTL_MS` starts when the code is *minted*—after Google authentication has already completed. `HANDOFF_TRANSACTION_TTL_MS` starts when the transaction is *created*, before the player leaves the Event origin, so everything in between—picking an account, MFA, a password reset, recovering a dropped connection, putting the phone down—elapses against it and none of it against the server's. It is therefore sized against the slow human leg, at thirty minutes: a five-minute value would reject, as `transaction-missing`, a player returning with a freshly minted and perfectly server-valid code after six minutes at Google—a dead end produced entirely by the client. What this timer actually exists for is narrow: stopping a transaction abandoned hours ago from authorizing an unrelated sign-in. It does not enforce freshness; the server does that, on the only clock that can. A record stamped in the future is rejected too—the clock moved during the round trip, which makes the age unknowable rather than small.

## The three legs

### Leg 1—start, at the entry origin

`startAuthHandoff`, from the Sign in tap. Generate the verifier, compute the digest, store it together with the acknowledgement boolean captured from that render's actual checkbox state, confirm it reads back, and only then navigate to `<authOrigin>/auth/handoff?target=<entry origin>&txn=<digest>&return=<path>`.

**Everything that can fail happens before the navigation, and that ordering is the point.** Discovering unavailable storage afterwards means discovering it once a code has been minted and spent. `returnPath` is the player's current location, so the handoff does not also lose their place. The start leg applies the same single-leading-slash, same-origin, control-character, fragment, and 512-character boundary as the central-origin parser before it stores or sends the path; an invalid current URL falls back to `/`, so sign-in remains reachable without sending the player through a guaranteed remote rejection loop. That fallback emits one best-effort debug signal with fixed text only—never the rejected path or any URL data—so a caller regression is observable without copying private query data into logs or making telemetry a sign-in dependency.

Only the digest travels. The verifier appears nowhere in the URL, and neither does any token.

### Leg 2—mint, at the central auth origin

`src/auth/AuthHandoffOrigin.tsx`, mounted by `main.tsx` **instead of** the app when the current origin is this build's own configured auth origin and the path is `/auth/handoff`. The check sits ahead of Event resolution rather than inside it: `auth.fiveacross.app` has no `hostnames` document, so falling through would spend a network round trip only to render the not-found screen on the one origin every Event depends on for sign-in.

The page settles any redirect return, then asks the session directly—an existing session at this origin mints immediately and never shows Google at all. Otherwise it starts `signInWithRedirect`, and on return calls `mintAuthHandoff` and navigates to the returned `handoffUrl`.

**Terminal means terminal.** Firing the deadline cancels the effect's continuations and drops the auth subscription, exactly as unmounting does—calling `fail()` alone left them live, so a `getRedirectResult`, observer, or `mintAuthHandoff` settling afterwards could still navigate the browser away from the failure the player was already looking at. The inverse also matters: the deadline stays **armed across `signInWithRedirect`**, because disarming it before the navigation actually starts would leave a redirect that hangs on initiation spinning forever. On the happy path a real redirect unloads the page and takes the timer with it.

**The page carries one terminal deadline (`HANDOFF_ORIGIN_TIMEOUT_MS`, 30s) covering the redirect settle, the auth-state settle, and the mint.** The return leg already bounds its network work; without the same treatment here, an operation that never settles left the player on "Signing you in…" indefinitely—the identical failure, on the origin whose failure takes sign-in down for every Event at once. It is longer than the return leg's bound because this page legitimately waits on a full Google round trip, and both terminal outcomes—bouncing, and leaving for Google—stop the clock so it cannot fire against a page that has already gone.

**A rejected `getRedirectResult` is terminal, not an ordinary first visit.** An ordinary first visit resolves `null`; a rejection means Google returned an OAuth error or the player cancelled. Swallowing it leaves the session check seeing a signed-out user and firing another redirect, bouncing the player back to Google in a loop instead of showing them the failure.

**All of the page's state is effect-scoped rather than held in refs**, which is what lets React StrictMode's setup/cleanup/setup replay in development proceed. Refs survive the cleanup, so once-guards held in them made the second setup return having done nothing while the first setup's continuations were already cancelled—leaving the page on "Signing you in…" forever, on the one origin every Event depends on for sign-in, in exactly the environment it is developed in.

**Always redirect, never popup, and this is the one place that is unconditionally right.** `AuthContext` chooses between them because it is protecting live app state and an installed-PWA window that loses its OAuth popup (#395, #347). This page has no state to lose—everything it needs is in its own query string, which survives the round trip in the address bar—and its OAuth helper is same-origin by construction, which is exactly the condition under which `AuthContext` itself calls redirect stable. So there is no UA sniffing here and no second copy of that decision to drift.

**The `handoffUrl` is navigated to verbatim, with `replace` rather than `assign`.** The server returns a URL rather than a code precisely so that no client ever assembles a redirect target; rebuilding or appending to it is what would reintroduce the open redirect. `replace` keeps a spent handoff URL from sitting one Back tap away.

`returnPath` must begin with **exactly one slash**, and is then **resolved against `targetOrigin` and required to land on it**. Both checks are required: a same-host protocol-relative value can resolve to the target origin while violating the server's path contract, while a `startsWith('/') && !startsWith('//')` denylist alone is insufficient because a literal backslash, a backslash-slash pair, and literal tabs/newlines/carriage returns all begin with a single `/` and still resolve off-origin under WHATWG URL rules—and because this value is handed to the server to build the URL that carries the code, a miss turns the trusted central auth endpoint into an open redirect that leaks a freshly minted code. Resolving has no list to keep current and is right in both directions: percent-encoded sequences are *not* decoded by URL resolution, so `/%5Cevil.example` stays on the target origin and remains a valid deep link, where a denylist tuned to reject backslash-ish strings would have broken it for no benefit. The server applies the same invariant and stays authoritative.

Query parameters are otherwise validated for shape only. Whether `targetOrigin` is a registered Event address is the server's question, answered against the `hostnames` registry at mint time—**origin validation is not duplicated client-side**, per the server contract, because a second copy would only drift.

### Leg 3—complete, back at the entry origin

Run by `main.tsx` before the app mounts, when `window.location.hash` carries a code. Pre-mount because the session must exist by the time `onAuthStateChanged` first settles; completing it inside the tree would render the signed-out gate and then flip it out from under the player.

The fragment is read and cleared **in a minimal entry module, before the application's module graph is loaded at all** (`src/entry.tsx` → `src/handoffBoot.ts`), with `history.replaceState`—no navigation, no new history entry. Doing it at the top of `main.tsx`'s module *body* is provably too late, and the reason is ES module semantics rather than anything about this app: a module's static imports are fully evaluated before its own body runs, and `main.tsx` transitively imports `firebase.ts`, which initialises GA4 at import time. So an analytics SDK was already live on a URL still reading `#fa_handoff=<code>` before any statement in `main.tsx` could execute—line order inside the module could never have fixed it. `entry.tsx` therefore statically imports *only* the boot seam (itself free of Firebase, analytics and React) and reaches the application through a **dynamic** import; that import boundary is the guarantee, and it is enforced by a structural test rather than a comment. The ordering is about telemetry rather than rendering: analytics startup and the explicit initial page view both derive the current URL from `window.location`, so a fragment chosen precisely to keep the code out of access logs, proxies and `Referer` headers would otherwise be copied straight into PostHog and GA4. PKCE means the code alone cannot authenticate anyone, but a single-use bearer credential still has no business in a telemetry pipeline. The captured value is passed forward, so no later reader of `window.location.hash` can observe it.

**And the clear is confirmed, not assumed.** A `replaceState` that throws, is refused, or is accepted and silently no-ops leaves a still-live code in `window.location`; proceeding to start analytics anyway would copy it into PostHog and GA4, which is exactly the leak the ordering exists to prevent. `clearHandoffFragment` therefore re-reads the URL and reports whether the code is actually gone, and an unconfirmed clear **fails closed**: analytics are suppressed for that one page load, on both the resolved and bootstrap-failure branches. Sign-in still completes, and one lost page view on a handoff return is not comparable to exporting a bearer credential. Then the stored transaction is read, the entry origin is confirmed to match, and `exchangeAuthHandoff` is called with the code, the verifier, and this origin. The returned custom token goes straight to `signInWithCustomToken`.

**The verifier is deleted on every terminal path, success included**, and before the sign-in rather than after: it has done its only job the moment the exchange returns, and the code it was paired with is spent either way. That also means the client cannot replay a handoff even if asked to—there is nothing left to replay it with.

**Nothing here retries.** The code is single-use and spent by the time anything can fail, so a retry could only fail again.

**The 18+ acknowledgement is completed from the same transaction, never inferred from the returning session.** After the bounded custom-token sign-in succeeds, the client passes the exact `UserCredential.user` returned by that call to the existing `attestAdult` data boundary only when the redeemed transaction record carried literal `true`. It never reads `auth.currentUser` for this decision. The code exchange already proves the verifier belongs to the server-side transaction, so the acknowledgement beside that verifier cannot authorize a different or replacement handoff. Expired, abandoned, replaced, legacy, and no-checkbox records all fail toward no write and the existing settled-profile re-prompt.

**Attestation is bounded independently from authentication.** A rejected or hung Firestore write cannot turn an already-successful custom-token sign-in into `sign-in-failed` or hold the pre-mount render forever. The handoff returns success with the live session; because the profile remains unstamped, `AuthProvider`'s ordinary settled-profile check presents the 18+ re-prompt. A late successful write is still safe because it uses the exact returned User and real transaction evidence.

**A timed-out sign-in is explicitly reconciled, because a bound rejects rather than cancels—but only if it is still the newest attempt.** A slow `signInWithCustomToken` can still succeed after the bound has given up, by which point the app has mounted signed out and the player is looking at a retry prompt, so a late session is either a surprise entry into the app or a race against the second handoff they just started. An abandoned attempt that lands late is therefore signed straight back out. **Unconditionally doing so would be worse than the race it closes:** the failure surface invites an immediate retry, so the likely sequence is attempt 1 times out, the player taps again, attempt 2 succeeds, and only then does attempt 1 resolve—signing out the good session attempt 2 just established. Every attempt takes a generation on entry and reconciles only while it is still the current one.

**All three network steps are bounded by `HANDOFF_EXCHANGE_TIMEOUT_MS` (15s), and that bound guards a blank screen rather than a slow one.** `main.tsx` awaits this leg before it renders anything, so an exchange, sign-in, or attestation write that never settles renders *nothing at all*—the 2026-07-24 incident shape the whole bootstrap path is written to avoid. Captive and shipboard wifi produce exactly that: `navigator.onLine` true and a request that hangs forever. Exchange or sign-in timeouts cost the player one re-sign-in; an attestation timeout preserves the session and costs one re-prompt.

## Failure states

Every failure is named, and none of them falls back to the other mode.

| Where | Reason | Surfaced as |
|---|---|---|
| Mount gate | `same-origin-host-unregistered` | `EventNotFound reason="auth-same-origin-unavailable"` |
| Mount gate | `auth-mode-invalid` | `EventNotFound reason="auth-mode-invalid"` |
| Mount gate | `handoff-origin-unconfigured`, `handoff-origin-invalid` | `EventNotFound reason="auth-handoff-misconfigured"` |
| Start leg | `start-failed` (no entropy, or no store would hold the verifier) | Inline message on the Sign in screen |
| Return leg | `transaction-missing`, `origin-mismatch`, `exchange-rejected`, `sign-in-failed` | Inline message on the Sign in screen |
| Central origin | bad request, sign-in failed, mint failed | The bounce page's own error copy |

The return-leg reasons are deliberately **coarser** than the set of things that can go wrong, because the server answers every exchange rejection identically on purpose—expired, already used, wrong origin, and never-existed are one `permission-denied` so a caller cannot learn whether a guessed code was ever real. Inventing finer client-side reasons would either be a lie or would leak the distinction the server just spent effort hiding. All of them reach the player as one sentence, because the player's next move is identical in every case.

The mount-gate rows are separate reasons rather than folded into the existing `auth-unconfigured` because a different person fixes each: `auth-unconfigured` means nobody finished provisioning this address, while the route failures mean this build was told to sign in a way that cannot work here. An invalid mode remains distinct from an invalid handoff origin so its operator note names `VITE_AUTH_MODE`, the setting that is actually at fault.

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
- **Given** the registered Five Across production target and a newly provisioned active wildcard hostname, **when** the real target environment and startup resolver are composed, **then** the Event resolves and sign-in selects the handoff through `https://auth.fiveacross.app` without adding the hostname to `FIRST_PARTY_AUTH_HOSTS`. (Test: production-wildcard-handoff.)
- **Given** a sign-in start, **then** the verifier is stored and only its digest appears in the URL, and no token appears at all. (Test: start-publishes-digest-only.)
- **Given** storage that refuses every write, **when** a handoff starts, **then** it does not navigate. (Test: start-aborts-without-storage.)
- **Given** a client and the server, **when** both compute a transaction id for the same verifier, **then** the results are byte-identical. (Test: digest-parity.)
- **Given** a return with a valid code and a matching verifier, **when** the handoff completes, **then** the custom token signs the player in and the verifier is deleted. (Test: complete-happy, verifier-cleared-on-success.)
- **Given** a handoff whose Sign in tap showed and collected the 18+ acknowledgement, **when** that exact transaction completes, **then** `attestAdult` receives the exact User returned by `signInWithCustomToken` and the player is not re-prompted. (Tests: handoff-ack-collected, complete-attests-returned-user.)
- **Given** a no-checkbox Event, a legacy record, an expired record, an abandoned record replaced by a later attempt, or a timed-out sign-in that lands late, **when** handoff state is read or completed, **then** no attestation is written. (Tests: handoff-ack-not-collected, legacy-ack-false, expired-ack-refused, replacement-isolation, late-sign-in-no-attestation.)
- **Given** the custom-token sign-in succeeds but the attestation write rejects or never settles, **when** the handoff completes, **then** the live session is preserved and the app mounts so the settled-profile re-prompt can recover. (Tests: attestation-rejection-falls-back, attestation-timeout-falls-back.)
- **Given** a return whose verifier is missing or whose origin does not match, **when** the handoff completes, **then** it fails by name without sending the verifier anywhere. (Test: transaction-missing, origin-mismatch.)
- **Given** a rejected exchange or a rejected custom token, **when** the handoff completes, **then** it fails by name, retries nothing, and leaves no verifier behind. (Test: exchange-rejected, sign-in-failed.)
- **Given** an exchange or a sign-in that never settles, **when** the handoff completes, **then** it gives up inside the bound and lets the app mount signed out, rather than holding the render forever. (Test: exchange-hangs, sign-in-hangs.)
- **Given** a sign-in that succeeds after the bound gave up, **then** it is signed back out rather than allowed to enter the app unannounced. (Test: late-sign-in-reconciled.)
- **Given** a store whose name throws on access, **when** a transaction is stored, **then** the other store still takes it and nothing throws out of the start leg. (Test: unnameable-store.)
- **Given** an abandoned transaction still in storage and a failed write to the session-first store, **when** the write is confirmed, **then** it reports failure rather than accepting the stale record. (Test: stale-record-not-accepted.)
- **Given** a rejected `getRedirectResult` at the central origin, **then** it is reported as a failure rather than starting another redirect to Google. (Test: redirect-rejection-terminal.)
- **Given** a real StrictMode mount of the central-origin page, **then** the bounce still completes. (Test: strictmode-completes.)
- **Given** a code presented in a query string rather than a fragment, **when** the return leg reads it, **then** it is ignored. (Test: fragment-only.)
- **Given** a handoff return, **then** the fragment is cleared before analytics start, so the code never reaches telemetry. (Enforced by module ordering in `src/main.tsx`; the read/clear primitives are covered in `handoffClient.test.ts`.)
- **Given** a session copy that is malformed or expired and a valid local copy, **when** the transaction is read, **then** the local copy is used. (Test: dual-store-fallthrough.)
- **Given** any central-origin operation that never settles, **then** the page reaches an actionable failure rather than spinning. (Test: central-origin-deadline.)
- **Given** a timed-out central-origin page, **when** a late mint resolves, **then** it cannot navigate away from the failure on screen. (Test: late-mint-cannot-navigate.)
- **Given** a `signInWithRedirect` that hangs on initiation, **then** the deadline still rescues the page. (Test: hung-redirect-initiation.)
- **Given** a timed-out attempt whose sign-in lands after a LATER attempt already succeeded, **then** the newer session is left alone. (Test: generation-aware-reconciliation.)
- **Given** a `replaceState` that fails or no-ops, **then** the clear reports failure and analytics are suppressed for that load—dimension registration included. (Test: clear-confirmed, fail-closed telemetry gate in `src/main.tsx`.)
- **Given** the entry module, **then** it statically imports only the boot seam and reaches the app dynamically, and neither the seam nor the handoff client pulls in Firebase, analytics or React. (Test: entry-seam-structural.)
- **Given** a `navigate` that throws, **then** the page reports the mint failure rather than sitting on the spinner with its deadline already cleared. (Test: navigate-throws.)
- **Given** a failed handoff start, **then** the module failure channel is drained so a later successful sign-in cannot inherit a stale error. (Test: start-failure-drained.)
- **Given** a `returnPath` that is protocol-relative—even to the same host—or resolves off the target origin by any means—backslash, backslash-slash, or a literal control character—**then** the request is refused; and given a percent-encoded sequence that stays on-origin, it is still accepted. (Tests: return-path-resolves-on-origin, start-return-path-validation.)
- **Given** the Event-origin start leg an invalid or over-512-character current path, **then** it stores and sends `/` instead, before navigation; a valid deep link is preserved. (Test: start-return-path-fallback.)
- **Given** any central-origin failure, **then** the first accurate message is the one that persists—the deadline cannot later overwrite it with a generic one. (Test: first-failure-sticks.)

## Test coverage

All in the app layer (`npm test`, jsdom—no emulator).

- `src/auth/authMode.test.ts`—the mode/strategy decision table, including every `unavailable` arm and the guarantee that an unregistered host never resolves to `direct`.
- `src/auth/handoffTransaction.test.ts`—verifier generation, base64url, the dual-store durability and clearing, transaction-scoped acknowledgement evidence including legacy-safe false, and every malformed-record and TTL rejection.
- `src/auth/handoffClient.test.ts`—fragment reading and clearing, the central-origin URL, request parsing, the start leg, and the failure channel.
- `src/auth/handoffExchange.test.ts`—the two callable legs: mint returning the server URL untouched and never sending a uid, and complete's happy path plus every named failure.
- `src/auth/AuthHandoffOrigin.test.tsx`—the central-origin bounce page: minting straight away for an existing session, redirecting when there is none, navigating to the server URL verbatim, and refusing a malformed request.
- `src/components/event-not-found-auth-reasons.test.tsx`—the two new mount-gate screens and their operator notes.
- `src/components/signin-handoff-route.test.tsx`—that the Sign in button actually reads the strategy: it starts a handoff where one is needed, never falls back to direct sign-in when the route is unavailable, and surfaces a return leg that failed before the tree mounted.
- `src/auth/handoff-parity.test.ts`—the three mirrored constants and the digest, against `functions/src/authHandoff.ts` directly.
- `src/auth-domain.test.ts`—the central auth origin's presence in `FIRST_PARTY_AUTH_HOSTS`.
- `scripts/fiveacross-origin.integration.test.mjs`—the production-target composition: a second active wildcard host resolves its own Event and selects the central handoff using the registered Five Across environment rather than an exact-host source edit.
- `scripts/deploy-target.test.mjs`—the repo-owned Five Across deploy refuses before build or publish while handoff invoker reconciliation remains skipped.

Mapped explicitly in `.repo-template.yml` `spec_test_map`, because the coverage is module-named rather than spec-basename-named.

## Not in scope

- **Provisioning `auth.fiveacross.app` (#547).** Firebase Auth authorized domains and the Google OAuth web client are console-only. Until that lands, the `FIRST_PARTY_AUTH_HOSTS` entry pins an `authDomain` Google will reject, so the handoff cannot carry real traffic.
- **The `fiveacross` invoker reconciliation.** While `skipInvokerReconcile: true`, the repo-owned deploy path refuses before build or publish rather than leaving either callable 403ing on that project. Completing #547 requires `run.services.update` for `firebase-deployer@fiveacross.iam.gserviceaccount.com`, a successful `AUTH_HANDOFF_PROJECT=fiveacross scripts/set-auth-handoff-invoker.sh --prove-update` on both callables, and only then a reviewed flip to `false`. Once false, the named target wrapper repeats that forced pair under the exact deploy service-account identity before constructing any hosting-only or full build/deploy invocation; a read-only describe, already-correct no-op, ambient user, or other-project service account is not accepted as readiness proof. Recorded in [auth-handoff](auth-handoff.md).
- **Enabling `AUTH_HANDOFF_APP_CHECK`.** The client already initialises App Check when `VITE_RECAPTCHA_SITE_KEY` is set, so attestation rides along automatically; turning the server param on is a deploy-time decision that also needs the key present in the untracked `functions/.env.<projectId>` files.
- **The Firestore TTL policy on `authHandoffs.expiresAt`.** Server-side, and already recorded in [auth-handoff](auth-handoff.md).
