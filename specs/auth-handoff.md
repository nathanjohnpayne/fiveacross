---
spec_id: auth-handoff
status: accepted
---

# The centralised-auth handoff—mint, exchange, and the `authHandoffs` rules (`auth-handoff`)

Implements [ADR 0010](../docs/adr/0010-centralised-auth-origin-with-handoff.md) (#548, epic #530). Google validates OAuth redirect URIs **exactly**, so an Event addressed at `<slug>.fiveacross.app` can never be its own callback. Sign-in therefore happens once, at the central auth origin, and the player is carried back to the Event origin they started on by an opaque, single-use, short-lived, origin-bound handoff code exchanged over HTTPS for a Firebase custom token.

This ticket owns the **server half**: the two Cloud Functions, the `authHandoffs` collection and its rules, and the wire contract below. The client half—generating the transaction, redirecting, reading the code back, and calling `signInWithCustomToken`—is #549, and this document is what it implements against.

> **No ID token, refresh token, or Firebase custom token may ever appear in a URL.** That is ADR 0010's hard line, and the entire design below exists to honour it while still moving an authenticated identity across an origin boundary. The one thing that does cross in a URL is the handoff code, which is safe there only because of the four properties in [Why a code is safe in a URL](#why-a-code-is-safe-in-a-url).

## Glossary

**Handoff code**—the opaque 256-bit value that crosses from the central auth origin to the Event origin. It is a bearer credential with a two-minute life, redeemable once, at one origin, by one transaction. *Avoid:* token, auth code, ticket.

**Transaction verifier**—the random value the Event origin generates before sign-in starts and never discloses. Its SHA-256 (the **transaction id**) travels; the verifier does not. Exactly PKCE's verifier/challenge pair, and it is why possession of a code is not possession of a session. *Avoid:* nonce, state.

**Target origin**—the origin the handoff returns the player to: the serving host sign-in began on. Per ADR 0010 as amended 2026-08-05 there is **no canonicalization step**—a registered host serves in place and the handoff returns there, not to some canonical alias of it.

## Why a code is safe in a URL

Four properties, and removing any one turns a URL-borne credential into account takeover:

1. **Single use, enforced transactionally.** This is why the code is a Firestore document rather than a signed stateless blob: a signature proves authenticity, but nothing stateless can prove *first* use. The read and the consuming write happen in one Firestore transaction, so a concurrent second exchange is aborted, re-runs, and finds the code already spent.
2. **Short TTL, enforced server-side.** `HANDOFF_TTL_MS` is 120 seconds—the code has to survive one redirect and one page load, not a session. The deadline lives in the document and is compared against the server clock; nothing the caller sends influences it.
3. **Origin bound.** The document names the exact origin it may be redeemed at, and that origin was checked against the hostname registry *before* the code existed.
4. **Transaction bound.** The code alone cannot be redeemed. An attacker who reads it out of browser history, over a shoulder, or from a `Referer` leak still cannot produce the verifier, which never leaves the origin that generated it.

## Wire contract

Two callables (`firebase-functions/v2/https` `onCall`), both in `us-central1`, both pinned to the Admin-SDK service account.

### `mintAuthHandoff`

Called **at the central auth origin**, by a caller who has just completed Google sign-in there.

```ts
// Request
{
  targetOrigin: string;   // exactly `window.location.origin` of the Event origin
  transactionId: string;  // base64url(SHA-256(verifier)) — 43 chars
  returnPath?: string;    // deep link, default "/"
}

// Response
{
  handoffUrl: string;     // the exact URL to redirect to; nothing else to assemble
  targetOrigin: string;   // the server-validated origin, echoed
  expiresAt: number;      // ms epoch
}
```

**A callable, not an HTTP endpoint, and that is the security property.** The UID comes from `request.auth`, which the runtime derives from a verified Firebase ID token. There is no `uid` field in the payload and there must never be one: a client-supplied UID would let any signed-in caller mint a code bound to somebody else's identity, which is precisely the takeover this design exists to prevent.

**The response carries a URL, not a code.** The caller supplies an origin and a path and gets back the exact URL to redirect to. It never gets to assemble a redirect target of its own, which is what keeps the return leg from being an open redirect—the one place caller input could otherwise steer a navigation.

Minting is otherwise unconstrained: there is no check that the caller is at the central origin, because there is nothing to protect against. A code binds to the caller's *own* UID, so the only thing an attacker can mint is a way to sign in as themselves.

Every rejection is `invalid-argument` with one message, except a missing session, which is `unauthenticated`.

### `exchangeAuthHandoff`

Called **at the Event origin**, by a caller with no session—obtaining one is the point.

```ts
// Request
{
  code: string;                 // read from the returned URL's fragment
  transactionVerifier: string;  // the private half, from the Event origin's own storage
  origin: string;               // the caller's own `window.location.origin`
}

// Response
{ customToken: string }         // pass straight to signInWithCustomToken
```

**Unauthenticated by necessity.** Authorization is the code plus the verifier, checked against a document consumed in the same transaction. CORS stays open because the set of legitimate callers is every registered Event hostname, which is dynamic—and CORS was never the boundary anyway, since a non-browser client ignores it. The boundary is the code, the verifier, and the origin recorded at mint time.

**Every rejection returns the same `permission-denied` and the same message.** A caller that could tell "expired" from "already used" from "no such code" would learn whether a guessed code was ever real. The precise reason is logged server-side and is what the tests assert against.

### The return URL

```
https://<target-origin><returnPath>#fa_handoff=<code>
```

**A fragment, not a query parameter**, and the difference is security rather than taste. A fragment is never transmitted to any server: it is absent from the Event origin's access logs, from any CDN or proxy in front of it, and from the `Referer` header of every request the loaded page subsequently makes. A `?code=` would be written into all three. The client still clears it from the address bar after reading it, but the fragment means a leak requires access to the browser rather than to a log.

### What #549 must do

- Generate a 32-byte random **verifier**, base64url-encoded, per sign-in attempt. Publish only `base64url(SHA-256(verifier))` as `transactionId`.
- **Persist the verifier at the Event origin** so it is retrievable when the player returns. `sessionStorage` survives navigating away and back within a tab; if the return can land in a different tab or a fresh PWA context, `localStorage` is the fallback. Either way, delete it the moment the exchange completes or fails.
- Redirect to `handoffUrl` verbatim. Do not rebuild it, do not append to it.
- On return: read the code from the fragment, clear the fragment with `history.replaceState`, exchange, then `signInWithCustomToken`.
- **Do not re-implement origin validation client-side.** It is server-side and authoritative; a second copy would only drift.

## Data model

`authHandoffs/{codeHash}` where `{codeHash}` is the **SHA-256 hex of the code**, not the code.

| Field | Type | Meaning |
|---|---|---|
| `uid` | string | The authenticated UID the code redeems to |
| `targetOrigin` | string | The only origin this code may be redeemed at |
| `transactionId` | string | `base64url(SHA-256(verifier))`, compared in constant time |
| `eventId` | string \| null | The Event the target origin resolves to, for audit |
| `issuedAt` | Timestamp | Mint time |
| `expiresAt` | Timestamp | Server-side deadline; also the Firestore TTL field |
| `consumedAt` | Timestamp \| null | Written by the consuming transaction; `null` at mint |

**Keyed by a hash, deliberately, and this is a considered deviation from ADR 0010's literal `authHandoffs/{code}`.** The ADR's substance—one opaque document per code, consumed transactionally—is preserved exactly; what changes is that the value at rest is no longer redeemable. A stored raw code is a live bearer credential to anyone who obtains the database; a stored hash is not. Rules already deny every client, so this is defence in depth against a future rules widening, a backup, or an export, and it costs one hash per call.

**`consumedAt: null` is written explicitly rather than left absent.** The consume check reads it, and "the field is missing" versus "the field is null" being different shapes is how a redemption check quietly stops checking.

## Rules contract

```
match /authHandoffs/{codeHash} {
  allow read, write: if false;
}
```

**Denied in both directions, and each direction closes a different takeover.** A readable document is the live authorization to become its `uid`—single use and a short TTL do not help if a client can enumerate unconsumed documents and redeem one first. A writable document is worse still: a client that could create one would mint itself a code bound to another player's UID with no Google round trip at all, and a client that could update one could clear `consumedAt` to replay a spent code or push `expiresAt` forward to keep a stolen one alive indefinitely. **Single use and expiry are only real while the document backing them is unwritable.**

Note the deny covers `get` as well as `list`, unlike `hostnames/{host}` ([hostnames-lookup](hostnames-lookup.md)) where a caller can only `get` an address it already knows. Here the document id *is* the secret being guarded.

The Admin SDK bypasses rules, so the two functions are the collection's only writers—and the consume is a transaction in code rather than a rules condition, because rules cannot express "read this, then write it, atomically."

## The allowlist is the hostname registry

A return origin is accepted if and only if `hostnames/{host}` holds a document with `status == 'active'` ([hostnames-lookup](hostnames-lookup.md), [ADR 0009](../docs/adr/0009-event-resolved-from-hostname.md)). That collection is Admin-SDK-write-only, so no client can widen it, and it has to exist for the address to serve an Event at all.

**There is deliberately no second list.** A static allowlist of Event hosts would be self-defeating—the handoff exists precisely because Event hostnames cannot be registered one by one—so there is no source here to drift. `FIRST_PARTY_AUTH_HOSTS` (`src/auth-domain.ts`) is **not** consulted: it answers a different question ("is the OAuth helper same-origin here?"), and every host in it that serves an Event carries a hostname document anyway.

This one check is simultaneously the whole of "unrecognised slugs rejected" and the whole of the open-redirect defence: an unregistered slug has no document, and an attacker's domain can never acquire one.

Beyond the registry lookup, an origin must be plain HTTPS on the default port with no path, query, fragment, port, or credentials. The check is a single comparison against `URL.origin`, which is a normalisation—requiring it to equal the input verbatim rejects every decoration at once, with no list to keep current. Loopback origins are accepted only when the process is running against emulators, so the arm is unreachable in production.

`returnPath` is the one caller-controlled component of the redirect URL and so the one that has to be airtight: it must begin with a single `/`, carry no control characters and no `#`, stay under 512 characters, and resolve back to the target origin. `//evil.test` and `/\evil.test` are rejected explicitly *and* caught again by the resolve check—a browser reads both as a different origin, which is the payload a naive "must start with /" check waves straight through.

## Ordering: consume, then check, then mint

Consumption **commits before the custom token exists**. A failure after it burns the code and costs the player one re-sign-in. That is the deliberate trade: minting the token first and consuming afterwards would open a window in which the same code is redeemable twice, and a redundant sign-in is cheaper than a replay. For the same reason the account check (deleted or disabled) runs after consumption and fails closed—a lookup that errors is never read as "the account is fine."

A rejection that happens *before* the transaction commits—wrong origin, wrong verifier, expired—leaves the code unconsumed, so a wrong-origin probe cannot be used to deny a player their own sign-in.

## Acceptance criteria

- **Given** a signed-in caller and a registered active target origin, **when** it mints, **then** it receives a `handoffUrl` whose fragment carries the code and whose query carries nothing. (Test: mint-happy, fragment-only.)
- **Given** a minted code, **when** it is exchanged once with the matching verifier at the matching origin, **then** a custom token is returned and `consumedAt` is set. (Test: exchange-happy.)
- **Given** an already-exchanged code, **when** it is exchanged again, **then** it is rejected. (Test: replay.)
- **Given** two or more exchanges of one code issued concurrently, **then** exactly one succeeds and the rest are rejected as replays. (Test: concurrent-exchange, against the real emulator.)
- **Given** a code past `expiresAt`, **when** it is exchanged, **then** it is rejected and left unconsumed. (Test: expiry.)
- **Given** a code minted for one origin, **when** it is exchanged from another—or with an `Origin` header disagreeing with the claimed origin—**then** it is rejected and left redeemable by its rightful origin. (Test: origin-mismatch, header-mismatch.)
- **Given** a code without its transaction verifier, **when** it is exchanged, **then** it is rejected. (Test: transaction-mismatch.)
- **Given** a target origin with no active hostname document, **when** a mint is attempted, **then** it is rejected and no code is written. (Test: unknown-slug, inactive-host.)
- **Given** a `returnPath` that resolves off the target origin, **when** a mint is attempted, **then** it is rejected. (Test: open-redirect.)
- **Given** any client—unauthenticated, signed-in, or an Event admin—**when** it reads, lists, creates, updates, or deletes an `authHandoffs` document, **then** it is denied. (Test: rules-deny-all.)
- **Given** any rejection, **when** the caller inspects the error, **then** it cannot distinguish which check failed. (Enforced at the `index.ts` seam; the reason is logged, never returned.)

## Test coverage

`tests/functions/auth-handoff.test.ts` (`npm run test:functions`, no emulator)—the decision layer. Enumerates every mint and exchange branch against an in-memory Firestore whose `runTransaction` models real optimistic concurrency, plus a table of malformed origins and open-redirect `returnPath` payloads. The suite opens with a **guard on its own harness**: a test proving the fake actually re-runs a callback whose read was invalidated, because a concurrency test against a fake that always commits would pass no matter what the code did.

`tests/rules/auth-handoff.test.ts` (`npm run test:rules`, Firestore emulator)—two halves under its own `projectId` so `clearFirestore()` cannot race the other rules suites. The rules half exercises every deny arm for an unauthenticated caller, the code's own player, another player, and an Event admin, and asserts the deny stays scoped by checking the pre-auth `hostnames` read still succeeds. The consumption half drives the **same** `exchangeHandoff` through a thin web-SDK adapter onto the real emulator, because single-use is a claim about transaction semantics and a fake that implements those semantics can only prove itself. Its fixture is built by the production `buildHandoffRecord`, so it cannot drift from what mint writes.

## Deployment: both callables need the Cloud Run invoker check disabled

These projects' org policy (Domain Restricted Sharing) **rejects** the `allUsers` Cloud Run invoker binding that `firebase deploy` adds to make a function publicly reachable. Firebase reports the rejection as a *partial* deploy failure, and the backing service is left 403ing. The org-policy-compatible repair is to disable the invoker IAM check on the service, which `scripts/set-auth-handoff-invoker.sh` does for both handoff services; `scripts/deploy.sh` runs it automatically after any deploy that could have released Functions.

**Both services need it, for different reasons, and neither is an oversight.** `exchangeAuthHandoff` is unauthenticated by design—its caller has no session yet, so there is no identity to present at the IAM layer. `mintAuthHandoff` *does* require a signed-in caller, but that is a Firebase ID token verified by the callable runtime, which is not a Google IAM identity: the invoker check would reject the request before the function ever ran. This is the same shape as `submitBugReport`, also an authenticated callable.

**One wrapper covers both**, unlike the per-endpoint sibling scripts, because the two are halves of one sign-in flow: they are always released together, and either one left 403ing breaks authentication on every Event origin. There is no deploy in which reconciling one without the other is correct, so `deploy.sh` carries a single selection flag for the pair rather than two.

The handoff lives in the `fiveacross` project—`gaycruisebingo` is a single registered origin that signs in same-origin and never mints a handoff—but a `gaycruisebingo` deploy still publishes the functions, so `deploy.sh` pins the reconciliation project from the selected deploy target rather than trusting the wrapper's default.

## Not in scope

- **Client code (#549).** No `src/**` change ships with this contract.
- **Provisioning the central origin (#547).** `auth.fiveacross.app` needs a human in the Firebase and Google OAuth consoles; no code can do it.
- **The Firestore TTL policy.** `expiresAt` is written as a Timestamp ready for one, but enabling the policy on `authHandoffs.expiresAt` is a console/gcloud action. Until it is enabled, abandoned sign-ins leave documents behind—one small document per attempt, harmless to correctness and unbounded only in storage.
