---
spec_id: private-cache-isolation
status: accepted
---

# Private reads and attended device recovery

The owner approved memory-only private and Admin reads in [#1411](https://github.com/nathanjohnpayne/fiveacross/issues/1411#issuecomment-5975988796), then approved [attended legacy recovery and a minimal offline render witness](https://github.com/nathanjohnpayne/fiveacross/issues/1411#issuecomment-5976278917). Trusted-device consent for private persistence is not offered.

## Client boundary

Private profiles, own pending submissions/Claims and Admin queues use an independent named Firebase app. Its Auth and Firestore cache are memory-only. The primary authenticated user is copied using the public Auth API; a second named app does not inherit sign-in automatically. Each primary Auth incarnation gets a fresh private app. Changing Auth on an existing Firestore instance alone does not erase its cached documents.

An Auth change retires private UI state. Offline transitions retire private profiles and Admin clients; the owner-approved same-session block-set exception below remains in memory. Private listeners are keyed by account and incarnation, accept current server snapshots, and clear on denial. Admin entry requires a current server Event snapshot naming the same authenticated Admin. Every action captures one private lease and Event before yielding; reads, transaction retries, staged writes and successful completion must still belong to that lease. A retired action cannot obtain the next account's client. App Check forwards the primary app's existing attestation without creating another CAPTCHA. Its SDK token cache is distinct from the memory-only Auth/Firestore data cache: forwarded application-attestation tokens may be persisted by the SDK, contain no account profile or Admin documents, and do not authorize a user action without Auth and server Rules. Forwarding uses the signed token expiration as refresh scheduling metadata, never a synthetic extension or proof of signature validity.

The primary persistent multi-tab Firestore remains the gameplay store. Cached Boards and queued Marks are preserved. Its durability is not authority to deal, approve, restore or access Admin data. Own-profile bootstrap may use memory-only reads during recovery so the active account can recover its gameplay queue; private profile and Admin views stay closed until recovery finishes.

## Legacy transition

A missing per-project recovery marker holds private views closed. No cache is cleared automatically. The dedicated recovery document loads through the credential-safe entry seam instead of the application graph, so it does not start gameplay, React data effects, analytics or application writers.

The operator must recover and verify queued Marks online for **every historical account**, then close other app tabs/windows. These are attended confirmations, not assertions proved by `waitForPendingWrites`: the real SDK regression proves that the active account's empty queue can coexist with another account's recoverable Mark. Temporary retention of the quarantined historical cache is accepted during this recovery.

Only after both confirmations does recovery establish server access for the captured signed-in account, drain that account, terminate the legacy instance and clear persistence through supported SDK APIs. Each stage is bounded and account/online state remains checked. Failed, timed-out or stale recovery never records completion. A retry reloads the dedicated document. Successful clearing records and reads back the marker before returning to the application. This is logical SDK cache removal, without a forensic secure-erasure guarantee.

## Offline attestation

The server's timestamped `users/{uid}.attestedAdultAt` remains the honor-system self-statement. The whole private profile is no longer read from the persistent gameplay cache. The owner-approved disk exception is a per-project, per-UID boolean containing no profile fields or timestamp. It may lift provisional rendering only when that UID already has a cached Board. It never grants deal authority, and a definitive server absence revokes it. Unreadable or unwritable storage grants no provisional rendering. Same-session optimistic attestation remains unchanged.

## Reciprocal block reads and shared content

Block reads use the named memory client. Only a server-confirmed set may qualify a newly opened session to render shared content. When that same account/Event goes offline mid-use, it retains its confirmed set in memory and continues showing cached Feed/Tally content through the existing block filter. Offline cold starts/reloads withhold shared content until an online confirmation and show explicit reconnect messages; they never present an unknown set as an empty Feed or Tally. Account/Event changes retire the retained set. Private block listeners never populate the persistent read cache. Durable blind block batches, including their own direction/pair write payloads, remain in the gameplay queue; server-only unblock/repair reads use the captured memory client.

## Validation

`tests/offline/private-cache-auth.test.ts` uses public Firebase SDK APIs and the Auth/Firestore emulators to prove independent Auth wiring, account cache separation, late-action refusal, offline retirement, durable Marks across reload and the other-account queue constraint. `src/hooks/useData-private.test.ts` covers actual private listener routing, cache-only refusal, account/incarnation changes, denial, recovery and badge retirement. `src/auth/privateCacheRecoveryPage.test.ts` and `src/entry-private-cache.test.ts` exercise the actual DOM workflow, failure/reset controls and credential-safe graph ordering. `src/auth/privateCacheRecovery.test.ts` covers stage ordering, failure, timeout and stale-account refusal; `src/auth/offlineAttestationWitness.test.ts` covers the minimal witness. Admin/profile caller tests prove captured-client behavior rather than only testing a helper in isolation.

Source tests and a merged PR do not establish installed-client or deployed behavior. Hosting rollout and attended recovery on affected devices remain separate acceptance steps; no production data/configuration mutation follows from this source policy.
