---
status: accepted
---

# Offline resilience for ship wifi: cache the shell and the data; marks queue, proof media doesn't

Flaky, expensive ship wifi is the product's **#1 environmental risk**, so the offline story is first-class, not just "use the paper card." It has two layers: the PWA **shell** is precached by Workbox (already wired), and Firestore runs with a **persistent local cache** (`initializeFirestore` with `persistentLocalCache` + multi-tab manager, replacing `getFirestore`) so the last-seen Board, Feed, and Tally render offline and marks made in a dead zone **queue durably in IndexedDB and sync on reconnect**. Proof media (Cloud Storage uploads) is the one thing that still needs signal—an offline honor-mark queues, and its photo/audio attaches when connectivity returns. The printed cards are the fallback for **total** failure only, not for every blip.

## Consequences

- Without this, the "the live listener reconciles when back online" behavior ([Board.tsx](../../src/components/Board.tsx)) is false across a reload—offline writes live only in memory and are lost on app restart.
- Offline reads are **stale**—a Player won't see others' new marks until reconnecting. Acceptable for a party game.
- The **first-ever join** needs connectivity (dealing reads the pool); once dealt and cached, play works offline.
