---
spec_id: w2-tally
status: accepted
---

# w2-tally—Per-Prompt Tally: every Mark publishes an attributed public record + tap-to-see-who

The Tally is the product's core differentiator over the printed card (ADR 0002, embarkation-critical): a Board's layout and progress stay private, but the *fact* that a Player marked a given Prompt is public. Every Mark—proofed or not—self-publishes an ATTRIBUTED entry to that Prompt's Tally, and the Square gains a count plus a tap-to-see-who list built from it. There is no anonymity (ADR 0001, a single 18+ friend group). This ticket extends the Wave-1 Mark write path (`setMark`) to publish the Tally in the SAME offline-queueable batch, adds the read hook, and surfaces the count + who-list on the Board.

## Data model (merged-main rules, #18)

The Tally is a subcollection, not a field on the Board: `events/{EVENT_ID}/tally/{itemId}/markers/{markerUid}`, where the marker doc id IS the marker's uid. `firestore.rules` keys the self-write on `isOwner(markerUid) && request.resource.data.uid == request.auth.uid`, so a Player can add/remove ONLY their own entry and a forged attribution is denied—the attribution is forgery-deniable by design. The marker shape is `{ uid, displayName, markedAt }` with a non-empty `displayName` within a 100-char cap. Reads are public (`signedIn()`).

The aggregate parent `tally/{itemId}` doc (`{ itemId, count, markers }`) is public-read but NOT client-writable (`allow write: if isAdmin(eventId)`); it is admin/Cloud-Function-maintained in Phase 1. So in Phase 0 the Square's badge count is DERIVED from the marker subcollection's size, never read from a client-forged aggregate.

## The change

- `src/data/api.ts`—`setMark`'s existing `writeBatch` (board `cells` + player stats) also writes/deletes the Tally marker at `tally/{itemId}/markers/{uid}`. Marking adds `{ uid, displayName, markedAt }`; unmarking deletes exactly that Player's entry, mirroring the cell toggle so the Tally never drifts from the Board. The write rides INSIDE the existing per-board serialization chain and the SINGLE batch (never a second unserialized path, never a `runTransaction`—the whole Mark path is offline-queueable, ADR 0006). The Tally lives in its own subcollection, never in the `cells` array a bare Mark rewrites. The free centre Square (no `itemId`) never tallies. `resolveDisplayName` is extracted from `joinAndDeal` so the join-side denormalization and the marker attribution resolve the public name the SAME validated way (saved `users/{uid}` name within the 100-char cap, else the auth value); `markerDisplayName` bounds the final name to the rules' non-empty ≤100 contract so a marker write can never poison the atomic batch.
- `src/data/paths.ts` + `src/data/converters.ts`—a converter-attached `tallyMarkersCol(itemId)` for reads; the converter pins `uid` to the doc id (the forgery-deniable attribution).
- `src/hooks/useData.ts`—`useTally(itemId)` subscribes to the marker subcollection and returns the derived `count` plus the who-list sorted by `markedAt`.
- `src/components/Board.tsx`—a count badge on each marked, non-free Square (the `.tally-badge`, a translucent black scrim over the marked-cell gradient; its white numerals hold WCAG AA on every Theme—see [specs/a11y-badge-contrast.md](a11y-badge-contrast.md)); tapping it opens a who-list sheet naming every Player who marked the Prompt. The Player's attributed name is resolved ONCE—from the saved player-row identity + auth via `resolveDisplayName` (the same validated resolver `joinAndDeal` uses, unified post-#78 with the saved-player source `ProofSheet` uses)—and fed to BOTH `setMark` (the bare-Mark marker) AND `ProofSheet` (the proofed-Mark attribution), so a Mark and a Proof publish the SAME identity the leaderboard shows and Board never holds two divergent name sources. **Loading window:** the resolved name is passed to `setMark` ONLY when the saved row is KNOWN—the same tri-state `knownFirstBingoAt` uses (loading, or a cache-only absent row without server confirmation, is UNKNOWN). While unknown Board passes `undefined`, so `markerDisplayName` falls back to the CACHED player row's saved name, then `'Anonymous'`—deliberately never stamping the possibly-stale auth name over a returning Player's customized identity. A loaded-null row is a KNOWN no-row, so its auth fallback is legitimate.
- `src/data/proofs.ts`—a Mark made in `proof_required` / `admin_confirmed` mode is captured through `ProofSheet` → `attachProof` (never `setMark`), so `attachProof` publishes the SAME attributed marker INSIDE its existing `runTransaction` (alongside the proof + board + player + optional claim), and `deleteProof` removes it when it genuinely unmarks the backing cell. `ProofSheet` threads the cell's `itemId` into `attachProof`. Every Mark—bare or proofed—therefore publishes; ADR 0002 holds for BOTH mark paths (this closes #31 AC 3, which the `setMark`-only half left open for proofed events).
- `src/data/admin.ts`—`rejectClaim`'s resolve transaction deletes the marker for every cell its transform flips marked→unmarked, diffing old→new cells under the SAME conditionality as the flip itself (`confirmClaim` flips only `status`, never marked-ness, so it deletes nothing). See "The marker symmetry invariant" below.

## Constraints inherited from PR #75 (encoded here)

- **Bare honor Mark (`setMark`):** the marker write is part of the SAME `writeBatch` as board + player and rides the SAME per-board serialization chain—no second write path, no transaction, so it is offline-queueable. Verified by the write-shape unit test and the offline durability layer. (The proofed-Mark marker instead rides `attachProof`'s transaction and is online-only—see "Proofed Marks publish too" below.)
- Tally state is its OWN subcollection; a bare Mark's full-`cells` merge never touches it, so the cross-writer `cells` clobber documented in `specs/w1-board-mark-win.md` cannot drop a marker.
- Attribution reuses `joinAndDeal`'s validated `resolveDisplayName`; the marker always carries a rules-valid non-empty ≤100 `displayName`.

## Proofed Marks publish too—pending and online nuances (ADR 0002, #31 AC 3)

`setMark` is only the HONOR path. In `proof_required` and `admin_confirmed`, `Board` routes a Mark through `ProofSheet` → `attachProof`, NOT `setMark`; if only `setMark` tallied, a proofed Mark would silently never publish—a direct ADR 0002 / AC-3 violation. `attachProof` therefore publishes the marker in the SAME `runTransaction` it already uses for the proof + board + player (+ optional claim), under the SAME condition the cell becomes marked.

- **Both claim modes publish immediately.** `attachProof` sets the backing cell `marked: true` in BOTH modes—`proof_required` → `status: 'confirmed'`, `admin_confirmed` → `status: 'pending'`. The marker publishes in both, exactly as `setMark` writes it on `nextMarked` regardless of pending/confirmed status. A pending Mark is still a Mark (the Player asserts they got the Prompt); Tally membership tracks the mark act, not confirmed stats—the `pending` exclusion is a STATS concern (`squaresMarked`/`bingoCount`), not a Tally one. There is no `attachProof` mode that leaves the cell unmarked-until-resolve, so there is no deferred-publish case.
- **A re-proof preserves the original `markedAt`.** Attaching a Proof to an ALREADY-marked square (the marked cell's proof button) refreshes the marker's attribution (`uid`/`displayName`) but preserves its original `markedAt`: the who-list is chronological by FIRST mark, and re-stamping `now` would reorder it by proof-attach time. `attachProof` reads the existing marker INSIDE the transaction—alongside its other reads, because a Firestore transaction requires ALL reads before its FIRST write—and stamps `now` only when no marker exists yet (a fresh proofed mark, or a legacy pre-Tally mark).
- **The marker symmetry invariant—the admin resolve included (implemented).** Wherever code flips a cell marked→unmarked it MUST delete that cell's marker, and wherever it flips →marked it MUST ensure one. Every unmark path keeps it: `setMark`'s bare unmark (`batch.delete`), `deleteProof` (below), and `rejectClaim` (`src/data/admin.ts`), which deletes `tally/{itemId}/markers/{uid}` inside its resolve transaction for exactly the cells its transform unmarks—without it, a rejected `admin_confirmed` claim would reverse the board + stats but leave the Player in the Prompt's public count/who-list. `confirmClaim` never unmarks, so it deletes nothing. #37/#41 still own the admin-console confirm/reject flow and UX; the write-path symmetry ships here.
- **Unmarking removes it.** `deleteProof` deletes the marker in the same transaction when—and ONLY when—it flips the backing cell back to unmarked (the cell is still backed by this proof). The drained bare-Mark clobber that leaves the cell to another Mark does NOT unmark and does NOT touch the marker (accepted residual, ADR 0001; see `specs/w2-proof-capture.md`); the same no-flip rule keeps `rejectClaim` from deleting a marker the live bare Mark now owns.
- **Online-only, unlike the bare Mark.** `attachProof` rides a `runTransaction`, which needs a server round-trip and REJECTS offline—it never queues (`specs/w2-proof-capture.md` § offline). The marker inherits that: proofed-mode Tally entries are ONLINE-ONLY, matching the proof flow itself. The offline-durable, queue-on-reconnect Tally write is the bare honor Mark's `setMark` batch (`tests/offline/w2-tally.test.ts`). The proofed path is deliberately NOT converted to a `writeBatch`—that is #32's transaction, kept for its live-board read-modify-write.

## Claim → test

Every claim maps to a real assertion—the bare-Mark claims in a `w2-tally.test.*` file, and the proofed-Mark claims (which ride `attachProof`'s transaction) in `src/data/w2-proof-capture.test.ts`, the harness that drives that transaction (basename-aligned to `specs/w2-proof-capture.md`); no vacuous coverage.

### Rules—a Player self-publishes their OWN attributed marker; forgery denied; reads public

Runner: `npm run test:rules` (Firestore emulator). Test: `tests/rules/w2-tally.test.ts`.

- A signed-in Player may create their own attributed marker at `tally/{itemId}/markers/{uid}` (`{ uid, displayName, markedAt }`); unmarking deletes it.
- A write to ANOTHER Player's marker slot, or a forged `uid` in one's own slot, is denied.
- An empty `displayName`, an over-100-char `displayName`, and a non-numeric `markedAt` are each denied (the rules' shape contract).
- An admin may delete another Player's marker—the allowance `rejectClaim`'s resolve transaction depends on—while a non-admin peer may not.
- Marker reads are public (no anonymity, ADR 0002); the aggregate `tally/{itemId}` doc is admin-writable only, never client-forged.

### Unit—`setMark` publishes/removes the marker; the admin resolve keeps the symmetry

Runner: `npm test` (Vitest, jsdom). Test: `src/data/w2-tally.test.ts`.

- Marking a non-free Square adds a marker write at `tally/{itemId}/markers/{uid}` carrying `{ uid, displayName, markedAt }` in the SAME batch as the board + player writes; unmarking issues a `batch.delete` at that exact path instead.
- The marker attribution prefers the caller-supplied `displayName` (Board resolves it from the saved player row + auth, passed only when the row is KNOWN—see the Board wiring section), falls back to the cached player row's denormalized name, then `'Anonymous'`, and is bounded to ≤100 chars—so the write always satisfies the marker rule.
- The free centre Square (no `itemId`) never writes a marker.
- No `runTransaction` and no `addDoc` (ADR 0006 offline-queueable; ADR 0002 a bare Mark posts nothing to the Feed).
- `rejectClaim` deletes the rejected cell's marker in the SAME resolve transaction when its transform flips the cell marked→unmarked; a reject that flips NO cell (the proof's projection was drained away) deletes nothing—the marker belongs to the live bare Mark; `confirmClaim` never unmarks, so it never deletes.

### Unit—the proofed Mark publishes/removes the marker inside `attachProof`'s transaction

Runner: `npm test` (Vitest, jsdom). Test: `src/data/w2-proof-capture.test.ts` (the real `attachProof`/`deleteProof` transaction harness—the marker rides that transaction, so its assertions live alongside the proof write it joins).

- `proof_required` `attachProof` writes the attributed marker at `tally/{itemId}/markers/{uid}` (`{ uid, displayName, markedAt }`) in the SAME `runTransaction` as the proof + board + player (one `runTransaction`, no second write path).
- `admin_confirmed` `attachProof` also writes the marker—the pending cell is marked immediately, so it tallies like `setMark` does on a pending Mark.
- Attaching to an ALREADY-marked square preserves the existing marker's `markedAt` and refreshes its attribution; a fresh mark (no marker) stamps `now`. The marker read joins the transaction's other reads—every `tx.get` precedes the first `tx.set`, pinned by spy invocation order (reads-before-writes is the Firestore transaction contract).
- The attributed name is bounded to the marker rule's ≤100-char cap.
- The free centre (null `itemId`) writes no marker.
- `deleteProof` deletes the marker at that same path when it genuinely unmarks the backing cell, and leaves it untouched on the clobbered-cell residual.

### RTL—`useTally` returns the count + who-list for a Prompt

Runner: `npm test` (Vitest, jsdom). Test: `src/hooks/w2-tally.test.tsx`.

- `useTally(itemId)` subscribes to the Prompt's marker subcollection and returns `count` = the number of markers and a who-list of every marker, sorted by `markedAt` (chronological).
- A `null`/`undefined` `itemId` (e.g. the free centre) opens no subscription and returns an empty Tally.

### RTL—Board passes the marker attribution only when the saved row is KNOWN

Runner: `npm test` (Vitest, jsdom). Test: `src/components/w2-tally.test.tsx`.

- While the player row is LOADING—or a cache-only absent row lacks server confirmation—Board passes `undefined` to `setMark`, deferring the marker attribution to the cached row's saved name (then `'Anonymous'`), never the possibly-stale auth name.
- A loaded row passes the saved name; a CACHED row is real knowledge even without server confirmation; a server-confirmed missing row legitimately falls back to the auth name.

## Acceptance criteria

- Given a Player marks a Square, when the write commits, then an attributed entry (`uid` + `displayName`) appears in that Prompt's Tally and the Square shows an incremented count—`src/data/w2-tally.test.ts` (marker write) + `src/hooks/w2-tally.test.tsx` (count) + `tests/rules/w2-tally.test.ts` (rules-allowed shape).
- Given a Prompt's Tally has entries, when a Player taps the count, then the who-list names every Player who marked it—no anonymity (ADR 0002)—`src/hooks/w2-tally.test.tsx` (who-list) + the `Board.tsx` `TallySheet`.
- Every Mark, proofed or not, publishes to the Tally; a bare Mark still posts nothing to the Feed—`src/data/w2-tally.test.ts` (bare Mark: marker in the one batch, no `addDoc`) + `src/data/w2-proof-capture.test.ts` (proofed Mark: marker in `attachProof`'s transaction, both claim modes).
- Unmarking removes the Player's own Tally entry—`src/data/w2-tally.test.ts` (bare-Mark unmark `batch.delete` + admin `rejectClaim` delete-on-unmark) + `src/data/w2-proof-capture.test.ts` (proofed-Mark `deleteProof` marker delete) + `tests/rules/w2-tally.test.ts` (own-delete allowed; admins may also moderate a marker away).
- The Board's layout/progress stays private; only per-Prompt Tally membership is public—the Tally is its own subcollection with public marker reads, while `boards/{uid}` stays owner-only (`firestore.rules`).
