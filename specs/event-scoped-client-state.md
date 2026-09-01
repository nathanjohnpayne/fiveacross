---
spec_id: event-scoped-client-state
status: accepted
---

# Event-scoped client state (`event-scoped-client-state`)

Implements [#807](https://github.com/nathanjohnpayne/fiveacross/issues/807), the client-state lane of the multi-Event isolation work. Firestore data was already stored below `events/{eventId}/…`; this contract closes the less-visible ways one mounted client could keep Event A's subscription result, queued work, retry, timer, intent, or persisted acknowledgement after the active `EVENT_ID` changed to Event B.

This is defensive isolation, not a new Event-selection product. `bootstrapEventResolution` still resolves one Event before React mounts, and this ticket adds no room browser, join code, player switcher, or cross-Event admin console.

## Visual and product boundary

The player-facing Tally Card and Feed behavior remains the behavior drawn in the Daily Cards wireframes for [Gay Cruise Bingo](../plans/daily-cards-wireframes.html#fx-feed-gcb), [Vacay Bingo](../plans/daily-cards-wireframes.html#fx-feed-vacay), and [Five Across](../plans/daily-cards-wireframes.html#fx-feed-fa). Event scoping changes ownership and lifecycle, never the rendered Feed contract.

The Event-context switcher and platform admin hub drawn in [`#fx-admin-hub-fa`](../plans/daily-cards-wireframes.html#fx-admin-hub-fa) and [`#fx-admin-hub-tri`](../plans/daily-cards-wireframes.html#fx-admin-hub-tri) are the declined #883 alternatives retained in the wireframe for the record. They are explicitly not implementation guidance for #807.

## The invariant

> State born under Event A may finish work for Event A, but it must never appear in, clear, certify, retry against, persist under, or emit on behalf of Event B.

The inverse is equally important: returning from B to A must not let a retired A listener callback resurrect the state from A's earlier subscription lifetime. Event identity therefore belongs to both the data path and the client lifecycle; putting it in only one of them is insufficient.

## Stable Event identity

`eventScopeKey(eventId, ...parts)` (`src/data/eventScope.ts`) is the shared identity for Event-owned React lifecycles and module registries. It JSON-encodes the segment array rather than joining with a delimiter, so caller-owned values cannot create ambiguous keys.

Event-owned public async entry points read the live `EVENT_ID` once, before their first await, and carry that captured value explicitly through every ref, cache lookup, retry, continuation, upload, and related helper. Lazy path helpers may continue to default to `EVENT_ID` for synchronous callers; a continuation must not re-read the live binding after it has begun.

## Subscription lifecycle

Every Firestore subscription that exposes React data below `events/{eventId}` has all four safeguards:

1. Its document or query ref is built from the captured Event id.
2. Its React/effect key includes the same Event id.
3. Its returned state is tagged with that key and synchronously presents a neutral loading value when the active key changes, before effect cleanup runs.
4. Cleanup retires the callback synchronously, so an already-queued success or error from the old listener cannot refill data, clear the new loading latch, or certify cache freshness.

That applies to the shared `useDocSub` / `useColSub` hooks, the Day-meta and Day-board listener fans, and `useTallyCards`; the Day-board fan also keys the board-freshness registry to the captured Event. Side-effect-only observers (`RetractWinMoments` and the durable direct-Mark analytics listener) expose no React data to neutralize, but they capture the Event in their effect/subscription lifetime and synchronously retire callbacks during cleanup. `users/{uid}` remains the deliberate exception: profile identity is global across Events, so its subscription key is uid-scoped rather than Event-scoped.

`useTallyCards` still uses the project-wide `collectionGroup('markers')` query and filters marker paths to the captured Event inside its callback. #807 isolates that listener's lifecycle and displayed-bump state; it does not make the delivery query tenant-safe. [#1072](https://github.com/nathanjohnpayne/fiveacross/issues/1072) owns the marker field, migration, legacy-writer compatibility, Event predicate, collection-group index, and rules rollout required before #804 can narrow the recursive marker rule.

## In-memory and persisted state inventory

| State | Required scope | Contract |
|---|---|---|
| Mark serialization chains | Firestore app/database + Event + uid | An Event-B Mark never waits behind or joins Event A's write chain. |
| Board seed freshness | Event + Day + uid | A committed A snapshot cannot certify a B cached seed. |
| Pending Moments, action generations, self-write witnesses, confirm state | Firestore app + Event + uid | Held wins and claim transitions park for their originating Event/account only. |
| Retraction intents and retry timers | Firestore app + Event + uid + token | A failed A retraction re-reads and writes only A, even while B is active. |
| Held Day-honor pins | Event + uid + Day | A delayed pin retains the Event that observed the win. |
| Echo marker repairs | Event + uid + Prompt | The durable repair candidate and cached tombstone cannot authorize repair in another Event. |
| Feed-to-Board and Card/Feed-to-Suggest intents | Event | An intent is visible only while its captured Event is active. |
| ItemPool tracked state, approval grace, compose state, and throttles | Event + uid | A switch clears the visible working state without letting an old timer or continuation mutate the new scope. |
| Notice dismissal | Event + Notice id | Identical document ids in two Events do not share a dismissal. |
| Most-Loved analytics acknowledgement | Event | The same mounted component may emit once for each Event, never once for the whole session. |
| Direct-Mark analytics cursor, outbox, delivered ids, and local request ids | Event + uid where applicable | Old transitions neither advance B's cursor nor trigger B's local-only side effects. |
| Deal/bootstrap attempts, retry generations, and visible deal errors | Event + uid | Switching Events retires A's recovery work immediately; no late A result may authorize, fail, or retry B. |
| Route-local UI, sheets, drafts, overlays, and transient acknowledgements | Event | The App boundary remounts Event-owned surfaces while providers above it preserve global identity and preferences. |
| Private-mode Notice and Coach dismissal fallbacks | Event + Notice/Coach identity | An unavailable `localStorage` cannot collapse an Event-scoped acknowledgement into a process-global one. |
| Share-card renders, native-share continuations, and approval-confirm actions | Event | A delayed A raster/confirmation may neither open a share surface, redirect an approval, nor emit analytics under B. |

Firestore's persistent IndexedDB cache remains one database-wide cache. Its document keys already contain the full Event path; `cardCache` additionally carries the Event in both its key and envelope. A new per-Event Firestore persistence instance or eviction scheme is not required.

The following state remains global by design: `users/{uid}` identity and avatar, Theme, text size, analytics/consent notice acknowledgement, install and update-prompt dismissal, and authentication/recovery state. The hostname-resolution cache remains hostname-keyed because two hosts may resolve to one Event while retaining different routing identity.

## Async operations and uploads

A user action that starts in A remains an A operation after any await. `setMark`/Echo reconciliation, proof attach/delete, Moment birth-witness reads, retraction probes and retries, Day-honor pins, Prompt submission/report continuations, and analytics delivery all build or receive explicit A refs. They may complete for A; they may not redirect to B because the exported `EVENT_ID` changed.

Proof media stays at `proofs/{eventId}/{uid}/{proofId}.{ext}` and captures the Event before image decoding or upload awaits. Avatars remain global at `avatars/{uid}.jpg`, matching the global identity decision.

Profile identity writes remain global, but their per-Event Player mirror captures the originating Event before the global write awaits. Heart mutations likewise capture their Event ref before their transaction and suppress late analytics if that Event is no longer active.

## Analytics

Analytics already registers `event_id` and `event_slug` after startup Event resolution (`specs/posthog-analytics.md`); #807 does not add a missing dimension. It closes the client-state side: durable transition storage is Event-partitioned, retired listeners do not dispatch, and an old action cannot use a new Event's local request acknowledgement.

Because this ticket ships no in-session switcher, it does not define a product flow that re-runs every bootstrap installer or re-registers the analytics dimensions. Any future switcher must solve that larger bootstrap contract before it is enabled.

## Explicit exclusions and dependencies

- Marker schema/query/index/rules migration is [#1072](https://github.com/nathanjohnpayne/fiveacross/issues/1072), not #807.
- Firestore/Storage membership enforcement is #804/#806.
- Proving Firestore cross-operation rule-access caching, and splitting or capping Mark/Echo batches if that proof is negative, is [#1079](https://github.com/nathanjohnpayne/fiveacross/issues/1079), a separate blocking prerequisite of #804. #807 neither assumes caching nor changes batch atomicity.
- Event-selection UI and the declined cross-Event admin surface are not shipped.

## Acceptance and tests

- Event scope keys change with Event identity and preserve segment boundaries: `src/data/eventScope.test.ts`.
- Event A listener results disappear synchronously on B, retired successes/errors cannot alter B, a B→A return cannot resurrect the retired A lifetime, and board freshness cannot cross Events: `src/hooks/event-scope-lifecycle.test.tsx` and `src/hooks/useData.test.ts`.
- Pending Moments, generations, confirm state, observer callbacks, retraction retries, and broadcasts retain their captured Event: `src/data/moments-event-scope.test.ts` plus the existing Moments and component suites.
- Feed-to-Board and Suggest-panel intents do not surface across Events: `src/hooks/useOpenSquare.test.tsx` and `src/components/SuggestPanelBridge.test.tsx`.
- The keyed App boundary clears Event-owned route state while ancestor-owned global state survives, and Auth bootstrap/deal generations cannot cross Events: `src/App.test.tsx` and `src/auth/AuthContext.test.tsx`.
- Mark/Echo chains, marker repair persistence, Day honors, proof flows, analytics outboxes, ItemPool state, profile mirrors, heart analytics, share actions, deferred approval actions, private-mode Coach/Notice dismissal, and Most-Loved acknowledgement have direct Event-A/Event-B regressions in their owning unit/component suites.

The repository's normal `npm test`, typecheck, offline, rules, and build gates remain authoritative. #807 changes no Firestore or Storage rule and no index; #1072/#804 carry the emulator coverage for their own delivery and authorization changes.
