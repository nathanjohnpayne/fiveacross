# w0-offline-persistence—durable Firestore offline cache (ADR 0006)

Deliver the data half of ADR 0006: replace `getFirestore(app)` in `src/firebase.ts` with `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })` so the last-seen Board/Feed/Tally render offline and Marks made in a ship-wifi dead zone queue durably (in IndexedDB, in the browser) and sync on reconnect—instead of the default in-memory cache, which loses queued writes on reload. The Workbox shell precache is already wired; this adds the durable data cache the offline-durable Marks of `w1-board-mark-win` build on.

## The change

`src/firebase.ts` swaps the cache constructor and keeps the same `export const db` symbol, so no call site changes (the `src/data/paths.ts` refs and every consumer compile unchanged). The multi-tab manager coordinates the shared cache when a Player has the PWA open in several tabs.

### Poisoned Firestore recovery

Firestore's asynchronous queue can permanently latch after its own internal `b815` assertion. `src/firebase.ts` installs `installFirestorePoisonRecovery` next to the multi-tab cache it watches: only the Firestore assertion with that exact latch id can trigger recovery; the tab takes at most one reload recorded durably in `sessionStorage`; and an offline tab waits for a later `online` transition instead of navigating into an error page. A document with a controlling service worker can reload through its precached shell. An uncontrolled document must first prove the origin answers the hardened `build-floor.json` probe; failure leaves the current page visible and waits for the next connectivity transition. Teardown removes every listener, including a deferred retry. This recovery neither clears IndexedDB nor changes the multi-tab manager, so cached data and pending Writes survive the reload.

## Claim → test

Every claim below maps to an assertion in the named test (no vacuous coverage), mirroring the layering `w0-test-harness` established.

### Source config—`src/firebase.ts` requests a persistent local cache

Runner: `npm test` (Vitest, jsdom project). Test: `src/firebase.test.ts`.

- `db` is a real Firestore instance (`db.type === 'firestore'`), so the unchanged export means no call site is edited—asserted alongside the cache kind. The `npm run build` + `npm run typecheck` gates confirm the existing consumers still compile against the same `db`.
- `db`'s configured local cache is persistent (internal `_settings.localCache.kind === 'persistent'`), not the default in-memory cache (`getFirestore` leaves `localCache` undefined; `'memory'` would be a regression to a queue that cannot survive a reload). This is the durable primitive: in a browser the persistent cache lives in IndexedDB across reloads.
- `b815` is the one poison-latch assertion that invokes the watchdog; unrelated errors do not. The watchdog reloads only after a durable one-shot record, defers while offline or when an uncontrolled page cannot reach the origin, and uninstall cancels the deferred listener—asserted in `src/firestoreRecovery.test.ts`.

### Offline behavior—queue while offline, survive a reload that happens BEFORE any sync, then sync

Runner: `firebase emulators:exec --only auth,firestore "vitest run --config vitest.offline.config.ts"` (jsdom + `fake-indexeddb` + the SDK's own `USE_MOCK_PERSISTENCE` test hatch—see `tests/offline/setup.ts`—scoped to `tests/offline/**`). Test: `tests/offline/w0-offline-persistence.test.ts`.

- A Mark written while offline (`disableNetwork`) lands in the persistent cache and surfaces to a listener as a pending, from-cache write—`metadata.hasPendingWrites === true`, `metadata.fromCache === true`—with the marked Square set. (The `setDoc` promise is intentionally not awaited: offline it would only resolve after a server ack that never comes in this client's lifetime.)
- The reload happens while STILL OFFLINE, before any sync: the client is terminated with the write still pending, so the Mark exists nowhere except the persisted local queue. An independent observer client (own app name, default memory cache) then proves via `getDocFromServer` that the server does NOT have the board yet.
- A "reloaded" client—the SAME app name (Firestore keys its IndexedDB store by app name), signed in as the SAME player—recovers the queued Mark from persistence and drains it: `waitForPendingWrites` completes, `getDocFromServer` returns the board fresh (`fromCache === false`, `hasPendingWrites === false`) with the Square marked, and the independent observer reads it server-side too.
- Fail-loud property (mutation-verified during development): swapping the test client's `persistentLocalCache()` for the default memory cache makes the suite fail—the queued write dies with the terminated client and the server never receives it. This is the failure mode the pre-rewrite version of this test could not detect.

## Scope and environment (honest bounds)

- IndexedDB semantics come from `fake-indexeddb` (a process-global store that survives client `terminate()`/re-init exactly like a browser profile survives a tab reload), unlocked via the SDK's own `USE_MOCK_PERSISTENCE=YES` hatch—the same mechanism Firestore's first-party persistence tests use. Real-browser IndexedDB remains the e2e layer's concern (`x-e2e-happy-path`).
- The test clients use `persistentLocalCache()` with the DEFAULT single-tab manager, one deliberate divergence from production: `persistentMultipleTabManager` needs the browser's cross-tab WebStorage machinery, which the SDK's node build hard-disables (`getWindow()` is `null`). The durable-queue property under test is tab-manager-orthogonal; the production multi-tab config is pinned by `src/firebase.test.ts`, and cross-tab coordination itself is a browser/e2e concern.
- Out of scope (per ADR 0006): the first-ever join needs connectivity (dealing reads the prompt pool), and proof media (Cloud Storage) still needs signal—an offline Mark queues and its media attaches on reconnect, which is `w2-proof-capture`. This ticket ships only the cache primitive.
- These app tests are not CI-run; they are recorded in the commit `Verified:` trailer.

## Acceptance criteria

- Given `persistentLocalCache`, when a Player Marks a Square offline and reloads while still offline (before any sync), then the Mark survives the reload in the persisted queue and syncs to Firestore once a reloaded client comes back up (ADR 0006; PRD offline-mark-survives-reload)—`tests/offline/w0-offline-persistence.test.ts`.
- Given the swap keeps `export const db`, when the app builds, then no call site changes are required—`db.type === 'firestore'` in `src/firebase.test.ts`, plus green `npm run build` and `npm run typecheck`.
- Given the durable cache config, then `db`'s configured cache kind is `persistent`, not memory or the default—`src/firebase.test.ts`.
- Given the Firestore queue reaches its permanent `b815` latch, then the tab preserves its persistent cache and makes one safe recovery attempt; it neither loops nor navigates an uncontrolled page without a reachable origin—`src/firestoreRecovery.test.ts`.
