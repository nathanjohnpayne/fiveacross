---
spec_id: w4-honor-pledge
status: accepted
---

# w4-honor-pledge—every claim opens the Proof sheet; honor mode adds a one-tap Cross My Heart pledge

Issue #181. Claiming a Square is the app's highest-frequency action, and the proof affordance used to be hidden behind the small ＋ on an already-marked Square. This ticket routes EVERY claim through the ProofSheet—all three Claim Modes—and gives honor mode a one-tap pledge option inside it, so proof capture is discoverable at the moment it matters while the honor claim stays near-zero cost.

## Behavior

- **Every claim opens the sheet.** Tapping an unmarked, non-free Square opens `ProofSheet` in ALL three Claim Modes—including `honor`, which previously marked instantly with no sheet (`Board.tsx` `toggle`). Unmark stays instant in every mode (no sheet on unmark), and the free centre never opens the sheet.
- **The pledge: 🎖️ Cross My Heart.** The sheet renders a full-width pledge button directly under the title—full-width so the label always fits on ONE line at the smallest supported width (320px), rather than a fourth cramped segment.
  - **Honor mode, claim opens:** enabled. Pressing it marks the Square immediately (ONE tap—the same bare `setMark` path an honor tap used to take: square `confirmed`, credited, win transitions broadcast identically) and closes the sheet. Total claim cost is two taps: square → pledge.
  - **`proof_required` / `admin_confirmed`, claim opens:** visible but DISABLED (greyed, with a hover/long-press title naming why), so Players learn the option exists; those modes keep requiring a real Photo/Sound/Callout proof.
  - **Proof-add opens (the ＋ on an already-marked Square):** the pledge row is HIDDEN in every mode—the Square is already claimed, so a pledge has nothing to do. Structurally: `Board` passes the `onPledge` callback only on claim opens; `ProofSheet` renders the row only when the callback is present.
- **The pledge is a bare Mark, NOT a Proof.** It calls `setMark`—no Proof doc, no Feed entry, no Doubt satisfaction, no `firestore.rules` change. Proof stays flavour, never enforcement (ADR 0001), and the honor claim keeps its offline durability (ADR 0006: marks queue in the persistent cache; `attachProof` is online-only). A Player in honor mode can still choose a REAL proof type instead—`attachProof` already handles `claimMode: 'honor'` (cell `confirmed`, proof `active`).
- **Tightened sheet, Photo-first.** Photo opens pre-selected (#309, per the wireframe's claim-sheet frame and the #310 row-16 parity note; pre-#309 the sheet opened with no type selected): the sheet opens as title, pledge (when offered), the Photo/Sound/Callout segment row with Photo selected, the photo capture body (Take photo / Library), then actions—one less tap on the mainline capture path. The Sound/Callout bodies still render only once chosen, and `Mark it` stays disabled until the selected type has a valid capture, so the pre-selection never loosens the submit gate. The sheet keeps its bottom-sheet placement: thumb-reachable on mobile and it never covers the tapped Square.

## Hardened properties (Codex P2s, PR #184)

1. **One in-flight claim per sheet.** The pledge button also disables while `busy`—a submit of a REAL proof is saving. Without this, a pledge tap during a slow `attachProof` upload/transaction would fire the bare `setMark` path in parallel and the two full-cell writes could race (e.g. the bare mark overwriting the cell projection without the new `proofId`).
2. **Source-live pledge (the `tallySourceLive` class applied to the proof surface).** Board closes a DANGLING ProofSheet the moment its source dies—render-time `proofSourceLive` adjust—and the pledge callback re-checks the same predicate at write time before calling `doMark` (the same belt-and-braces split as toggle + doMark). Live means: the CURRENT account's attributable board still holds the SAME Prompt (`itemId`) at that cell in the SAME marked state the sheet opened against. This covers the account switch that lands the NEW uid's board under an open sheet (where `cellsAttributable` alone passes and the captured index would mark the wrong card), a claim Square another tab claimed meanwhile (nothing left to pledge), and a proof-add source whose Mark fell. The sheet's own successful attach races its board echo benignly: both paths null the same state, so the double-close is idempotent.

## Non-goals / preserved invariants

- **Corrected by #721** (this line originally read "No new analytics event: a pledge claim is a `mark_square` (mode `honor`), a proofed claim an `attach_proof`—already distinguishable," which was wrong: `attach_proof` is not an alternative to `mark_square`, it is a SUBSET — every proofed claim that marks a previously-unmarked Square fires BOTH, and treating them as either/or is what let `mark_square` miss almost every real Mark in production, see specs/w2-ga4-events.md § Reconciliation). The pledge fires `mark_square` with `source: 'pledge'`; a proofed claim fires `attach_proof` for the capture itself AND `mark_square` with `source: 'proof'` for the transition to marked (`ProofSheet.tsx`, gated on `!cell.marked` — the ＋ affordance on an already-marked Square fires only `attach_proof`, correctly, since nothing transitioned).
- The Moment broadcast pipeline is untouched: the pledge rides `doMark`'s existing verdict path, a proofed claim rides `onAttached` (PR #110).
- `admin_confirmed` semantics are untouched: a claim still needs a real proof and starts `pending`.

## Acceptance criteria → tests

The checker matches this spec's basename to any `*w4-honor-pledge*.test.*`.

- **`src/components/w4-honor-pledge.test.tsx`**
  - Honor: tapping an unmarked Square opens the sheet (no instant mark); pressing 🎖️ Cross My Heart calls `setMark` with `nextMarked: true` and closes the sheet; no `attachProof` is called and no proof doc is written.
  - Honor: Cancel closes the sheet with the Square unmarked (no `setMark`, no `attachProof`); unmarking a marked Square stays instant with no sheet.
  - Honor: the pledge label renders on one line (`white-space: nowrap` on a full-width row) and the sheet opens Photo-first (#309)—the Photo segment pre-selected with the photo capture body already open, the Sound/Callout bodies only once chosen, and `Mark it` disabled until a valid capture.
  - `proof_required` / `admin_confirmed`: the claim-open sheet renders the pledge DISABLED; pressing it does nothing (no `setMark`).
  - Proof-add open (＋ on a marked Square): the pledge row is absent in every mode.
  - Honor: a real proof type still works from a claim open—selecting Callout and submitting calls `attachProof` (a pledge is optional, not forced).
  - Race hardening (properties 1–2 above): the pledge disables while a real-proof submit is in flight (no parallel bare mark); an account switch under an open claim sheet closes it (never marks the wrong card); a claim Square marked from another tab closes its dangling sheet.
- **`tests/e2e/x-e2e-happy-path.spec.ts`** (local-only)—the happy-path line completes via square-tap → pledge-tap per Square; the offline Mark case pledges while offline and the Mark still queues durably and survives the reload (ADR 0006).

Amended sibling specs: `specs/w3-claim-modes.md` (honor is no longer "a tap marks INSTANTLY"—the pledge is the instant path inside the sheet) and `specs/w2-proof-capture.md` (the "honor marks directly with NO sheet" pin moved here, inverted).
