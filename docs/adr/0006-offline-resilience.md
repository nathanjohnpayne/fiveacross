---
status: accepted
---

# Offline resilience for ship wifi: cache the shell and the data; marks queue, proof media doesn't

Flaky, expensive ship wifi is the product's **#1 environmental risk**, so the offline story is first-class, not just "use the paper card." It has two layers: the PWA **shell** is precached by Workbox (already wired), and Firestore runs with a **persistent local cache** (`initializeFirestore` with `persistentLocalCache` + multi-tab manager, replacing `getFirestore`) so the last-seen Board renders offline and marks made in a dead zone **queue durably in IndexedDB and sync on reconnect**. Proof media (Cloud Storage uploads) is the one thing that still needs signal—an offline honor-mark queues, and its photo/audio attaches when connectivity returns. The printed cards are the fallback for **total** failure only, not for every blip.

## Shared-content privacy after #1411

The owner amended the offline Feed/Tally guarantee alongside the memory-only block-read contract. A session that has confirmed its reciprocal block set online keeps rendering cached Feed/Tally content when it goes offline, using that in-memory set. An offline cold start or reload has no confirmed in-memory block set: shared Feed/Tally content is withheld until a fresh online confirmation, with explicit “Reconnect to see the Feed” and one Board-level Tally notice rather than an empty list. Online reciprocal-filter bootstrap uses only the named memory client and may confirm during attended legacy recovery; raw own-block and ordinary private views remain quarantined. Account or Event changes cannot inherit another scope's block set. A same-UID Auth refresh while offline keeps that confirmed set visible offline; reconnect after the refresh requires a new server answer under the current credentials. A persistent in-memory Auth retirement stamp keeps this distinction even when UI renders skip intermediate publications. Board rendering, queued Marks and durable block writes (including their queued direction/pair payloads) remain unchanged.

## Consequences

- [Private-cache isolation](../../specs/private-cache-isolation.md) (#1411) narrows the persistent store to gameplay. Private profiles and Admin reads use a separate memory-only client; queued Marks remain durable. The offline 18+ render gate retains only the owner's approved UID-scoped boolean, never a cached whole profile or deal/server-read authority. Server revocation blocks the current session and retries failed persistence; the owner accepts that, if both deletion and false overwrite fail, a fresh process after storage recovers may render an existing cached Board before a successful retry. Historical private cache bytes remain quarantined until attended recovery verifies every account's queued Marks before supported clearing.

- Without this, the "the live listener reconciles when back online" behavior ([Board.tsx](../../src/components/Board.tsx)) is false across a reload—offline writes live only in memory and are lost on app restart.
- Offline reads are **stale**—a Player won't see others' new marks until reconnecting. Acceptable for a party game.
- The **first-ever join** needs connectivity (dealing reads the pool); once dealt and cached, play works offline.
- The multi-tab manager **amplifies** Firestore's `b815` poison latch (#722). `WebStorageSharedClientState` registers a `storage` listener whose handler calls `enqueueRetryable` synchronously, and `AsyncQueue.enqueue` opens with the `verifyNotFailed` check — so once anything has thrown inside the queue (which latches `failure` permanently; the SDK never clears it), every `storage` event from any same-origin document re-throws `INTERNAL ASSERTION FAILED (ID: b815)` into DOM event dispatch, outside React where no ErrorBoundary can see it. This decision stands — the mitigation is [`src/firestoreRecovery.ts`](../../src/firestoreRecovery.ts), a one-per-tab automatic reload, not a downgrade to the single-tab manager.
