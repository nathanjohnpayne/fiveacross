---
spec_id: d15-proof-chips-ranks
status: accepted
---

# Leaderboard proof chips (`d15-proof-chips-ranks`)

Implements `plans/daily-cards-spec.md` § "Asking for proof—Doubts", the optional enhancement noted there: each Leaderboard row carries that Player's latest-proof media chips (📷 🎙️ ✍️ 🖼️), tap-through to the proof in the Feed. Purely additive and presentational—it never changes what the ranking measures.

## Contract

- `src/hooks/useData.ts`—`useLatestProofByUid()`, a new read over the existing `status == 'active'` Proofs stream (the same one `useProofFeed` reads), reduced to a `Record<uid, ProofDoc>` keeping the max-`createdAt` Proof per uid. Applies the same two PUBLIC-facing filters `useProofsForItemText` does—the ADR 0004 community auto-hide (`isReportHidden`) and the Admin ban (`isBanned`, #108)—because every OTHER viewer's Leaderboard row renders this, not just the Proof owner's own view.
- `src/components/Leaderboard.tsx`—`proofChips(proof)` maps a `ProofDoc` to its chip set: 📷 for `type === 'photo'`, 🎙️ for `type === 'audio'`, ✍️ for `type === 'text'`, plus 🖼️ layered on when `type === 'photo' && source === 'library'` (the #211 Feed badge). Each row looks up `latestByUid[p.uid]` and renders the chip set as a tap target navigating to `/feed` (`useNavigate`) when non-empty; renders nothing when the Player has no Proof. Applied strictly AFTER `sortPlayers`/`matchesFilter` have already produced the row—chips are read-only decoration on an already-ranked row, mirroring how the ban filter and First-to-BINGO pin are applied post-sort in this file.

## Resolved decisions

- **One Player, one chip set.** Only the single latest Proof per Player renders—never a history of every Proof they've posted. `useLatestProofByUid` enforces this at the read layer (one `ProofDoc` per uid, not an array).
- **Tap-through target is `/feed`**, not a specific proof deep-link. The Feed already orders newest-first, and the target Proof is by definition the most recent one, so no `ProofFeed.tsx` scroll-to/deep-link machinery is added for this ticket—consistent with the issue's "otherwise navigate to `/feed` and rely on existing ordering" fallback.
- **Never influences ranking.** `useLatestProofByUid`/`proofChips` are consumed only inside the row's render, downstream of `sortPlayers` and the `matchesFilter` view-filter; no sort/filter/comparator anywhere reads proof recency.

## Acceptance criteria

- **Given** a Player with a library-photo Proof, **when** the Leaderboard renders, **then** their row shows 📷🖼️ chips. (Test: library-photo chip set.)
- **Given** a Player with no Proof, **when** the Leaderboard renders, **then** their row shows no chip and the row layout is unaffected. (Test: no-proof row.)
- **Given** a Player taps a chip, **when** the tap resolves, **then** the app navigates toward that Proof in the Feed. (Test: tap-through navigation.)
- **Given** any chip state, **when** the Leaderboard is filtered or sorted, **then** rank order is unchanged—chips never influence ranking. (Test: multi-proof latest-only selection, proven at the hook layer.)

## Test coverage

- `src/hooks/d15-proof-chips-ranks.test.ts` (Vitest unit)—`useLatestProofByUid` returns exactly the most recent Proof per uid when a Player has multiple Proofs across different Days; applies the report-hide threshold and Admin ban filters.
- `src/components/d15-proof-chips-ranks.test.tsx` (RTL/jsdom)—a row with a library-sourced photo Proof shows both 📷 and 🖼️; a row with no Proof shows no chip; tapping a chip navigates toward the Feed.
