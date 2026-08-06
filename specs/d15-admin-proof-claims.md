---
spec_id: d15-admin-proof-claims
status: accepted
---

# d15-admin-proof-claims—Admin "Proof & Claims" panel: claim mode, photo source, EXIF strip, visionGate, report threshold, pending claims

Implements `plans/daily-cards-spec.md` § "Admin console" (the "Proof & Claims" panel). `reportHideThreshold` and `visionGate` already exist in the backend with no admin UI; `photoProofSource`/`stripPhotoExif` are the settings `d15-claim-sheet-photo` (#211) makes load-bearing. Pure admin-surface work—one panel, six rows, no new backend behavior. Depends on #200 (`d15-schema-contract`, the `EventDoc.settings.*` fields this panel edits) and #211.

## What already shipped (consumed, not rebuilt)

- `EventDoc.settings.{reportHideThreshold, photoProofSource?, stripPhotoExif?, visionGate?}` (`src/types.ts`, #200) and `isReportHidden` (`src/data/moderation.ts`, unchanged—this ticket only adds the missing edit affordance for the number it reads); `functions/src/visionGate.ts`'s deployed `moderateProof` function gates on its own deploy-time `ENABLE_VISION_MODERATION` env flag, never on `EventDoc.settings.visionGate`, so this toggle is captioned presentational-only rather than implying a runtime effect the backend doesn't yet have.
- `src/components/Admin.tsx`'s existing Claim-mode control (`setClaimMode`) and Pending-claims confirm/reject section (`usePendingClaims`) stay functionally as-is; relocated/recaptioned and linked-to, not rebuilt.

## The change

- `src/data/admin.ts`—`setPhotoProofSource`, `setStripPhotoExif`, `setVisionGate`, `setReportHideThreshold`: single-field dot-path `updateDoc` writes mirroring `setClaimMode`/`setEventTheme`'s shape, so each merges into `settings` without touching a sibling key.
- `src/components/Admin.tsx`—a new `ProofClaimsPanel`, replacing the former standalone "Claim mode" section, with six rows: **Claim mode** (existing segmented control, recaptioned "a friction knob, not a trust level" per ADR 0001, verbatim); **Photo proof source** (new segmented control, *Camera or library* default vs *Camera only*); **Strip location data** (new toggle, default on); **AI image screen** (new toggle over `visionGate`, captioned presentational-only); **Auto-hide after reports** (new `ReportThresholdStepper`, −/+ floored at 1—`isReportHidden` treats a non-positive threshold as "no filtering", Codex P2 PR #107 finding 2, so an unfloored stepper could silently disable auto-hide instead of hiding on zero reports); **Pending claims** (count badge + `href="#admin-pending-claims"` jump link to the untouched existing section, which only gains that one `id` attribute). *Re-housed by `admin-console-ia`*: the five settings rows live in Game settings › Claims & proof (`src/components/admin/GameSettings.tsx`) with captions and write paths verbatim; the Pending-claims count/jump-link row is superseded by the hub's Review-queue badge (the claims queue itself is the Review queue's Claims group).

## Acceptance criteria

- The panel shows the current Claim mode, Photo proof source, Strip-location-data state, AI-image-screen state, report-hide threshold, and pending-claims count on load; all six rows are independently writable and no caption claims trust/verification language for Claim mode.
- Changing Photo proof source to Camera only calls `setPhotoProofSource('camera_only')`; stepping Auto-hide-after-reports calls `setReportHideThreshold` with the new number and never produces a value below 1.

## Test coverage

- `src/components/Admin.test.tsx` (extend, RTL-jsdom)—the settings rows render reflecting current `EventDoc.settings`/`claimMode`; each control writes via its `data/admin.ts` function on change; the stepper's decrement is disabled at 1. (The Pending-claims jump-link pin retired with the row—see `admin-console-ia`.)
