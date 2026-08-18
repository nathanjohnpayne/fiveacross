---
spec_id: d15-proof-chips-ranks
status: accepted
---

# Leaderboard proof chips (`d15-proof-chips-ranks`)

Implements `plans/daily-cards-spec.md` § "Asking for proof—Doubts", the optional enhancement noted there: each Leaderboard row carries chips (📷 🖼️ 🎙️ ✍️) for every kind of proof that Player has used during the Event, tap-through to the Feed. Purely additive and presentational—it never changes what the ranking measures.

Superseded by #604 (2026-08-17): the original #218 shipped chips for the Player's single most-recent Proof only, which read as a career summary but wasn't one—a Player who mixed live photos, library photos, and written proof showed just one chip. Decision (Nathan, `plans/backlog-dispatch-plan.md` § 5.3): chips become the UNION of proof kinds that Player has actually used, not the latest proof's kind.

## Contract

- `src/hooks/useData.ts`—`useProofKindsByUid()`, a read over the existing `status == 'active'` Proofs stream (the same one `useProofFeed` reads), reduced to a `Record<uid, ProofKindFlags>`—one boolean per chip kind (`photo`/`library`/`audio`/`text`), OR-ed across every Proof that uid contributed to the (capped, filtered) stream. Applies the same two PUBLIC-facing filters `useProofsForItemText` does—the ADR 0004 community auto-hide (`isReportHidden`) and the Admin ban (`isBanned`, #108)—because every OTHER viewer's Leaderboard row renders this, not just the Proof owner's own view.
- `src/components/Leaderboard.tsx`—`proofChips(flags)` maps `ProofKindFlags` to its chip set in a fixed order: 📷 (`photo`), 🖼️ (`library`), 🎙️ (`audio`), ✍️ (`text`)—independent of which order the Player actually used them in. Each row looks up `kindsByUid[p.uid]` and renders the chip set as a tap target navigating to `/feed` (`useNavigate`) when non-empty; renders nothing when the Player has no active Proof at all. Applied strictly AFTER `sortPlayers`/`matchesFilter` have already produced the row—chips are read-only decoration on an already-ranked row, mirroring how the ban filter and First-to-BINGO pin are applied post-sort in this file.

## Resolved decisions

- **One Player, one chip PER KIND used—not a history of Proofs.** `useProofKindsByUid` reduces to a fixed 4-flag record per uid (booleans, not counts or a Proof array), so a Player who submitted ten photo Proofs still shows exactly one 📷 chip.
- **Derived client-side from the existing Feed-window read**, not a new/second query or a server-side aggregate: `useProofKindsByUid` still composes `useProofFeed(max)`, the SAME capped, filtered, newest-first stream the public Feed already subscribes to (Codex P2, PR #243)—so the union this ticket adds costs nothing beyond folding more of that already-fetched list into the reduction.
- **Tap-through target is `/feed`**, not a specific proof deep-link—unchanged by #604. There was never a single "the" proof to deep-link to even under the old latest-only reading (the button always called bare `navigate('/feed')`), so removing the "one Proof" model changes nothing about the tap target.
- **Never influences ranking.** `useProofKindsByUid`/`proofChips` are consumed only inside the row's render, downstream of `sortPlayers` and the `matchesFilter` view-filter; no sort/filter/comparator anywhere reads proof kind or recency.

## Acceptance criteria

- **Given** a Player who has used live photo, library photo, and written proof, **when** the Leaderboard renders, **then** their row shows exactly 📷 🖼️ ✍️—one chip per kind, in that stable order. (Test: multi-kind union.)
- **Given** a Player who has only ever used one proof kind, **when** the Leaderboard renders, **then** their row shows exactly one chip. (Test: single-kind unchanged.)
- **Given** a Player with no active Proof, **when** the Leaderboard renders, **then** their row shows no chip and the row layout is unaffected. (Test: no-proof row.)
- **Given** a Player taps their chip strip, **when** the tap resolves, **then** the app navigates to the Feed. (Test: tap-through navigation.)
- **Given** any chip state, **when** the Leaderboard is filtered or sorted, **then** rank order is unchanged—chips never influence ranking. (Test: multi-Proof union, proven at the hook layer.)

## Test coverage

- `src/hooks/d15-proof-chips-ranks.test.ts` (Vitest unit)—`useProofKindsByUid` unions every kind a Player used across multiple Proofs/Days (not just the latest); a single-kind Player reduces to exactly that flag; applies the report-hide threshold and Admin ban filters.
- `src/components/d15-proof-chips-ranks.test.tsx` (RTL/jsdom)—a Player with photo+library+written Proofs shows exactly those three chips in 📷 🖼️ ✍️ order; a single-kind Player shows exactly one chip; a no-proof Player shows no chip; tapping the chip strip navigates to the Feed and never reorders the roster.
