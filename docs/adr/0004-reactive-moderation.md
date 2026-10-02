---
status: accepted
---

# Reactive moderation: client-side auto-hide in Phase 0, server-enforced in Phase 1

Moderation is **reactive, never a posting gate** (per product non-goals). A Report increments a counter; when it crosses the Event's `reportHideThreshold`, the content is hidden. In **Phase 0** (no Cloud Functions) that hide is **client-side and presentational**—every client filters over-reported content out of its reads, and admins can additionally hard-hide (`status: 'hidden'`) or restore. It is bypassable, and that is an accepted Phase 0 limitation: the goal is a **community emergency-hide that works without an awake admin**, not tamper-proof removal. **Phase 1** makes it server-authoritative (a Function flips `status`) and adds Cloud Vision auto-flagging for **extreme/illegal content only**.

## Consequences

- `reportHideThreshold` is now load-bearing (it was dead config). `blackoutEnabled` is removed as dead config.
- Don't rely on the Phase 0 auto-hide to keep a determined viewer from harmful content—that's Phase 1's job. It errs toward over-hiding, which is the safe direction.
- **Owner amendment (#1355, 2026-10-02; implementation #1405):** Reports count distinct Players per target incarnation. Banned Players cannot report. A report atomically writes an owner-bound incarnation receipt, a server-clock rate fence enforcing the existing 3-second cadence, and the target counter; direct counter increments fail. This moderation admission boundary leaves honor-system Marks unchanged. Admin Restore suppresses further automatic report hiding for that incarnation, while new distinct reports remain visible in the Admin queue. No historical count/receipt backfill is implied; receipts are not cleared when an Admin uses the existing Clear reports action.
- Guard the deal against the active non-free pool dropping below 24 as hides accumulate ([dealBoard](../../src/game/logic.ts) throws below 24).
