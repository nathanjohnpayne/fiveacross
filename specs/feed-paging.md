---
spec_id: feed-paging
status: accepted
---

# Feed paging: the stream keeps going (`feed-paging`)

The Feed reveals its entries a page at a time and grows as the reader scrolls, instead of rendering a fixed window and ending. Guarded by `src/hooks/feed-paging.test.tsx` (the `useFeed` window + `hasMore`) and `src/components/feed-paging.test.tsx` (the `ProofFeed` sentinel, the fallback control, and the CSS pin).

## The bug this replaces (#441)

`useFeed(max = 60)` sliced its merged stream to 60 and `ProofFeed` rendered exactly that, with nothing below the last card. Everything older was unreachable from the UI — no control, no scroll trigger — so on a ten-Day Event most of the Event's history went invisible within the first couple of days.

## The window is presentational, not a fetch boundary

All four underlying streams (`useProofFeed`, `useMoments`, `useTallyCards`, `useNotices`) subscribe to their whole collections and slice client-side, so the older entries were *already in memory*: the client was paying to hold them and refusing to show them. Growing the window therefore costs render work and never another Firestore read, and there is no network round trip to wait on — a new page is on screen in the same commit. That is why this is paging, not fetching: no "loading more" spinner, no cursor, no `startAfter`.

## `useFeed(max)` — window and `hasMore`

`max` is a WINDOW, not a ceiling. `entries` is the plain `mergeFeed(..., max)` it always was; `hasMore` runs that same merge one entry wider (`max + 1`) and asks whether it yielded more.

Asking `mergeFeed` twice, rather than counting the raw streams, is the point. A hand-rolled count drifts from what the merge actually emits: each sub-hook slices to its own `max` before `mergeFeed` sees it, `mergeFeed` drops zero-count Tally Cards, and the pinned-Notice masthead (specs/admin-messages.md) occupies window slots by a *different* rule than the newest-first stream — it sorts above everything and carries its own limit. Deferring to the merge itself needs none of that reasoning to stay true as the merge rules evolve, and it costs one extra sort of a list already bounded by `max`.

`tallyCards` stays the UNCAPPED stream (Codex P2 on #286): the proof-card pills derive from every card, not just the ones inside the window.

## `ProofFeed` — the page and the trigger

`FEED_PAGE_SIZE` is 60: the first paint AND the amount each subsequent page adds. Sixty keeps page one byte-identical to the pre-paging Feed, so this change only ever adds a floor below it. `ProofFeed` holds a `pageCount` and asks for `useFeed(pageCount * FEED_PAGE_SIZE)`; `loadMore` increments it.

When `hasMore`, the Feed renders a `.feed-more` footer below the last card carrying a "Load older posts" button. An `IntersectionObserver` watches that footer with a `400px` bottom margin — far enough below the fold that the next page is on screen by the time the reader arrives, close enough that one scroll does not run through several pages at once.

The observer attaches through a **callback ref**, not `useRef` + an effect. An effect keyed on `hasMore` would miss the common case: `hasMore` is already true on the very first render, while the loading early-return means the sentinel node does not exist yet, so the effect would run once against a null ref and never re-run. React invokes a *stable* callback ref only on mount/unmount of the node (both `loadMore` and the ref callback are `useCallback`-pinned), so the observer is created once per sentinel and disconnected with it — the ref returns its `disconnect` as React 19's ref cleanup, which is what replaces the legacy `ref(null)` teardown and leaves no observer handle to park in a ref of our own. Re-creating the observer on every render would re-fire `isIntersecting` immediately and run away through the whole stream.

The button is not decoration. It is the path that still works with no `IntersectionObserver` (jsdom, and any browser old enough to matter), and it is the keyboard/AT affordance — "scroll further" is not an operable control without a pointer. It stays visible while `hasMore`.

## Derived pills grow monotonically

`doubtsClearedByProof` and the "tally N" pill derive from `feedProofs`, the proofs inside the current window. A larger window can only ever hand them MORE proofs, so the once-only Doubt ownership check gets strictly more accurate as the reader pages down; it never regresses. (`tallyCards` was already uncapped, so the tally count never depended on the window at all.)

## Deliberate non-features

No virtualization (the DOM cost of a few hundred cards is not what hurts here), no `startAfter` cursors or paged Firestore reads (the streams are already whole-collection subscriptions), no "back to top" control, and no window reset when new posts arrive at the head — the window is newest-first, so growth is stable under head insertions.

## Test coverage

`src/hooks/feed-paging.test.tsx`: `useFeed` returns at most `max` entries in merged newest-first order; `hasMore` is true exactly when an entry sits past the window (including the exactly-full window that would otherwise strand the tail) and false when the stream fits; growing `max` reveals the next entries without disturbing the ones already shown; Proofs and Moments page as one merged stream; `hasMore` stays exact when a pinned Notice spends part of the window; `tallyCards` stays uncapped.

`src/components/feed-paging.test.tsx`: the Feed renders one page and the "Load older posts" control while `hasMore`; clicking it asks `useFeed` for the next page and the older entries render; the control disappears once the stream is exhausted; with an `IntersectionObserver` present the sentinel is observed and an intersection loads the next page without a click; and the `.feed-more` CSS pin exists.
