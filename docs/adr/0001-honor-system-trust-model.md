---
status: accepted
---

# Honor-system trust model: marks are client-authoritative, the Feed is the source of truth

Gay Cruise Bingo is a party game for one friend group on one cruise, with **no motivated cheater** in the threat model. We deliberately let each Player write their own Board and stats directly, with no server authority over marks, and treat the live Feed the group watches as the real "verification." The Leaderboard and the First to BINGO pin are for-fun tallies, not tamper-proof records.

## Consequences

- Self-writable `boards/{uid}` and `players/{uid}` in the Firestore rules are **intentional**, not a hole to close. A reviewer who "fixes" them by locking stat writes has misread the design.
- The three Claim Modes are a **friction/vibe hierarchy, not a trust hierarchy.** `verified` is renamed **Admin-confirmed** (a dispute/ceremony tool) so the word "verified" stops implying an integrity guarantee we don't make. (Code still persists the value `verified`; reconcile if/when we align code to the ubiquitous language.)
- Any Phase 1 server-side stat recompute is for **consistency/repair, not integrity**—it reads the same Player-written Board, so it cannot make marks trustworthy. Do not build it, or justify it, as an anti-cheat measure.
